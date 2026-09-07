/**
 * Конвейер ревью: что происходит с задачей после того, как исполнитель её сдал.
 *
 * Порядок описан не здесь, а файлом `workflows/feature.json`
 * (docs/design/workflows/spec.md §7.1) — это первый процесс офиса, записанный
 * явно. Ведёт по нему раннер (runs.ts); здесь — действия узлов и то, как
 * прогон показывается пулл-реквестом:
 *
 *   ветка задачи → подтянуть базовую ветку и разрешить конфликты
 *                → прогнать проверки проекта
 *                → открыть пулл-реквест
 *                → ревью живым ревьюером
 *                → перед слиянием подтянуть базу и проверить ещё раз
 *                → слить в базовую ветку, убрать ветку и рабочую копию
 *
 * Всё это идёт само: человек в цепочке не нужен. Он нужен ровно в одном
 * случае — когда конвейер встал (стадия 'stuck'): не разошлись с конфликтом,
 * не прошли проверки, ревьюер два раза подряд вернул работу. Тогда офис
 * говорит об этом менеджеру и перестаёт крутить круги за деньги. Сколько
 * именно раз можно вернуть и починить — пределы `max` в файле процесса.
 *
 * Сессии агентов сюда не импортируются: конвейер знает только, что кто-то
 * умеет «отревьюить» и «переделать» (PipelineAgents). Так этот файл не тянет
 * за собой Agent SDK, а тесты гоняют весь порядок на настоящем репозитории
 * с подставными агентами.
 */
import type { PullRequestView, ReviewVerdict } from '../shared/types';
import { OFFICE_SENDER } from '../shared/types';
import type { Lang } from '../shared/i18n';
import { loopMax, nodeOf, type Run, type Workflow, type WorkflowNode } from '../shared/workflow';
import { t } from './i18n';
import {
  taskRepo, criteriaProgress, worktreesRoot, type OfficeState, type Task,
} from './state';
import { dispatch } from './plan';
import {
  abortMerge, commitAll, deleteRemoteBranch, diffBranch, ensureWorktree, fastForward,
  fetchRemote, isDirty, isRepo, mergeBaseInto, mergeBranch, mergeInProgress, pushBranch,
  removeWorktree, revision,
} from './git';
import { integrationDir, runTypecheck } from './merge';
import { mergedKind, recordOutcome } from './outcomes';
import { githubToken } from './cloud';
import { commentOnPr, createPullRequest, githubFor, mergePullRequest } from './github';
import { builtinWorkflow } from './workflows';
import { drive, newRun, restartRun, type Executor, type RunHooks, type StepResult } from './runs';

/** Процесс, по которому едет сданная задача. */
const WORKFLOW_ID = 'feature';

/**
 * Сколько раз ревьюер может вернуть работу автору, прежде чем позовём
 * менеджера. Число живёт в файле процесса; здесь оно нужно промпту ревьюера.
 */
export const MAX_ROUNDS = loopMax(builtinWorkflow(WORKFLOW_ID), 'office:review', 'changes') ?? 2;

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  text: string;
  reviewerId: string | null;
  /** Ревью не состоялось (некому, сессия упала) — это не «одобрено». */
  error?: string;
  /** Повтором делу не помочь: некого спросить, кончился бюджет. */
  needsDecision?: boolean;
}

export interface ReworkOutcome {
  ok: boolean;
  message: string;
  /** То же самое для доработки: повторять бессмысленно, нужно решение. */
  needsDecision?: boolean;
}

/**
 * Живые агенты офиса глазами конвейера. Настоящую реализацию ставит agents.ts
 * при загрузке; тесты подменяют её своей.
 */
export interface PipelineAgents {
  review(state: OfficeState, task: Task, pr: PullRequestView): Promise<ReviewOutcome>;
  rework(state: OfficeState, task: Task, instruction: string): Promise<ReworkOutcome>;
  notifyPm(state: OfficeState, text: string): void;
}

let agents: PipelineAgents = {
  async review(state) {
    return {
      verdict: 'changes', text: '', reviewerId: null, error: state.say('pipe.noAgents.review'),
    };
  },
  async rework(state) {
    return { ok: false, message: state.say('pipe.noAgents.worker') };
  },
  notifyPm() { /* до подъёма офиса сообщать некому */ },
};

export function setPipelineAgents(next: PipelineAgents): void {
  agents = next;
}

/**
 * Сказать менеджеру офиса — снаружи конвейера. Нужно надзору: он тоже часть
 * офиса, а не отдельный сервис, и говорить с PM должен так же.
 */
export const tellPm = (state: OfficeState, text: string): void => agents.notifyPm(state, text);

/** Конвейеры, идущие прямо сейчас: ключ «офис:задача». */
const running = new Map<string, Promise<void>>();
/** Слияния в один репозиторий идут по одному: ключ — путь репозитория. */
const mergeLocks = new Map<string, Promise<unknown>>();
/** Ревью в офисе идёт по одному: ревьюер в офисе, как правило, один. */
const reviewLocks = new Map<string, Promise<unknown>>();

function withLock<T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => undefined));
  return next;
}

/**
 * Провести задачу через конвейер. Вызывающему ждать не нужно — ход конвейера
 * виден по стадиям пулл-реквеста; обещание возвращается ради тестов и
 * повторного запуска, и никогда не падает: любая беда — это стадия 'stuck'.
 */
export function runPipeline(state: OfficeState, taskId: string): Promise<void> {
  const key = `${state.officeId}:${taskId}`;
  const already = running.get(key);
  if (already) return already;
  const run = pipeline(state, taskId)
    .catch((err) => {
      const task = state.tasks.get(taskId);
      state.addLog(null, 'error',
        state.say('pipe.crashed.log', { task: taskId, error: (err as Error).message }));
      if (task) {
        markStuck(state, task, state.say('pipe.crashed.stuck', { error: (err as Error).message }));
      }
    })
    .finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

/**
 * Дождаться, пока в офисе не останется идущих конвейеров. Нужно тем, кто
 * смотрит на результат со стороны: надзору в тестах и остановке сервера.
 */
export async function whenPipelinesIdle(state: OfficeState): Promise<void> {
  for (let guard = 0; guard < 50; guard += 1) {
    const runs = [...running.entries()]
      .filter(([key]) => key.startsWith(`${state.officeId}:`))
      .map(([, run]) => run);
    if (!runs.length) return;
    await Promise.all(runs);
  }
}

/** Можно ли вообще вести задачу конвейером. Причина отказа — текстом. */
export async function pipelineProblem(state: OfficeState, task: Task): Promise<string | null> {
  if (!state.settings.autoPipeline) return state.say('pipe.off');
  if (!task.branch || !task.baseBranch) return state.say('pipe.noBranch');
  if (task.merged) return state.say('pipe.alreadyMerged');
  if (!(await isRepo(taskRepo(task, state)))) return state.say('pipe.notRepo');
  return null;
}

/** Всё, что нужно действию узла. Собирается заново на каждый узел. */
interface Ctx {
  state: OfficeState;
  task: Task;
  pr: PullRequestView;
  workflow: Workflow;
  node: WorkflowNode;
  run: Run;
  repo: string;
  branch: string;
  base: string;
}

async function pipeline(state: OfficeState, taskId: string): Promise<void> {
  const task = state.tasks.get(taskId);
  if (!task) return;
  const problem = await pipelineProblem(state, task);
  if (problem) {
    // Не тихий отказ: без конвейера задача просто остаётся сделанной, и это
    // ровно тот случай, когда ветку сливает человек из очереди слияния.
    state.addLog(null, 'system', state.say('pipe.notStarted', { task: taskId, problem }));
    return;
  }

  const repo = taskRepo(task, state);
  const branch = task.branch as string;
  const base = task.baseBranch as string;

  const pr = state.startPr({
    taskId, title: task.title, branch, base, repoDir: repo,
  });
  state.updateTask(taskId, { status: 'review' });
  state.addChat(OFFICE_SENDER, state.say('pipe.started', { task: taskId, base }));

  // Повторный заход (перезапуск конвейера) не заводит второй прогон, но
  // возвращает его к началу: ветка снова расходится с базой. Круги ревью
  // при этом не обнуляются — они считаются по задаче, а не по сессии.
  const workflow = builtinWorkflow(WORKFLOW_ID);
  const run = state.runOf(taskId) ?? newRun(workflow, taskId);
  restartRun(run, workflow);
  state.saveRun(run);

  const hooks: RunHooks<Ctx> = {
    context: (node) => ({
      state, task: state.tasks.get(taskId) ?? task, pr, workflow, node, run, repo, branch, base,
    }),
    enter: (ctx, node) => {
      if (node.stage) state.patchPr(ctx.task.id, { stage: node.stage });
    },
    transition: (ctx, from, outcome, to) => {
      if (from.run === 'office:review' && outcome === 'changes') {
        // Возврат автору: круги считаем по пулл-реквесту, а не по сессии, —
        // перезапуск сервера не должен обнулять счётчик и запускать вечный цикл.
        const rounds = ctx.run.loops[`${from.id}>${to}`] ?? 0;
        state.patchPr(ctx.task.id, { rounds, note: state.say('pipe.reviewReturned', { n: rounds }) });
      }
      if (from.run === 'office:merge' && outcome === 'moved') {
        state.addChat(OFFICE_SENDER, state.say('pipe.secondRound', { task: ctx.task.id, base }));
      }
    },
    stuck: (ctx, why) => markStuck(state, ctx.task, why.note, why.needsDecision),
  };
  await drive(state, workflow, run, FEATURE, hooks);
}

/**
 * Прибрать за автором: незакоммиченная правка до ревью не доедет, а
 * недоведённое слияние сломает следующий шаг. Полагаться на то, что агент
 * закоммитит сам, нельзя — офис и обычную работу коммитит за него.
 */
async function settle(worktree: string, task: Task, message: string): Promise<void> {
  if (await mergeInProgress(worktree) || await isDirty(worktree)) {
    await commitAll(worktree, `${task.id}: ${message}`);
  }
}

/** Рабочая копия ветки задачи: обычно уже есть, иначе поднимаем заново. */
async function workingCopy(ctx: Ctx): Promise<string | null> {
  const { state, task, repo, branch } = ctx;
  const path = await ensureWorktree(repo, worktreesRoot(state), task.id, branch);
  if (!path) return null;
  if (path !== task.worktreePath) state.updateTask(task.id, { worktreePath: path });
  return path;
}

const fail = (note: string, needsDecision?: boolean): StepResult =>
  ({ outcome: 'fail', note, needsDecision });
const failed = (note: string, needsDecision?: boolean): StepResult =>
  ({ outcome: 'failed', note, needsDecision });

/**
 * Подтянуть базовую ветку в ветку задачи. Конфликты разбирает автор в своей
 * копии (узел fix-conflict) — до основной ветки они не доходят вовсе.
 */
const syncBase: Executor<Ctx> = {
  async run(ctx) {
    const { state, task, repo, base } = ctx;
    const worktree = await workingCopy(ctx);
    if (!worktree) return fail(state.say('pipe.noWorktree', { branch: ctx.branch }));
    state.patchPr(task.id, { note: state.say('pipe.syncing', { base }) });

    // С GitHub базой считается удалённая ветка: там же лежит и результат чужих
    // слияний. Без удалёнки база локальная — и это единственная правда офиса.
    const gh = await githubFor(repo);
    let ref = base;
    if (gh) {
      await fetchRemote(repo, githubToken());
      if (await revision(repo, `origin/${base}`)) ref = `origin/${base}`;
    }

    const result = await mergeBaseInto(worktree, ref, state.lang());
    if (result.kind === 'nothing' || result.kind === 'merged') {
      if (result.kind === 'merged') {
        state.addLog(null, 'system',
          state.say('pipe.mergedInto', { task: task.id, ref, branch: task.branch ?? '' }));
      }
      // Сошлось после того, как автор разбирал конфликт, — скажем об этом.
      const before = ctx.run.from ? nodeOf(ctx.workflow, ctx.run.from) : null;
      if (before?.run === 'office:fix-conflict') {
        state.addChat(OFFICE_SENDER, state.say('pipe.conflictsDone', { task: task.id, base }));
      }
      return { outcome: 'pass' };
    }
    if (result.kind === 'failed') return fail(result.message);

    // Конфликт: рабочая копия осталась в незавершённом слиянии — её и чинит автор.
    state.patchPr(task.id, {
      note: state.say('pipe.conflictNote', { base, files: result.conflicts.join(', ') }),
    });
    state.addChat(OFFICE_SENDER, state.say('pipe.conflictChat', {
      task: task.id, base, files: result.conflicts.join(', '),
    }));
    return {
      outcome: 'conflict',
      note: result.message,
      artifact: { kind: 'conflict', text: result.conflicts.join(', '), ref: base },
    };
  },
  async exhausted(ctx, last) {
    // Автор разбирал, а конфликт остался: слияние бросаем, копию — в порядок.
    const worktree = ctx.task.worktreePath ?? await workingCopy(ctx);
    if (worktree) await abortMerge(worktree);
    return { note: ctx.state.say('pipe.conflictStill', { base: ctx.base, problem: last.note ?? '' }) };
  },
};

/** Автор разбирает конфликт с базой в своей копии. */
const fixConflict: Executor<Ctx> = {
  async run(ctx) {
    const { state, task, base } = ctx;
    const conflict = ctx.run.artifacts.conflict;
    const files = conflict ? conflict.text.split(', ').filter(Boolean) : [];
    const fix = await agents.rework(state, task, conflictPrompt(state, task, base, files));
    const worktree = state.tasks.get(task.id)?.worktreePath ?? null;
    if (!fix.ok) {
      if (worktree) await abortMerge(worktree);
      return failed(
        state.say('pipe.conflictUnresolved', { base, problem: fix.message }), fix.needsDecision);
    }
    // Автор мог оставить слияние незакоммиченным — доводим сами, как и обычную работу.
    if (worktree) await settle(worktree, task, state.say('pipe.note.merge', { base }));
    return { outcome: 'done' };
  },
};

/**
 * Проверки проекта в ветке задачи — до пулл-реквеста, а не после слияния.
 * Сломанную сборку чинит автор (узел fix-checks), и основная ветка про это
 * не узнаёт.
 */
const checks: Executor<Ctx> = {
  async run(ctx) {
    const { state, task } = ctx;
    const worktree = await workingCopy(ctx);
    if (!worktree) return fail(state.say('pipe.noWorktree', { branch: ctx.branch }));
    state.patchPr(task.id, { note: state.say('pipe.checksRunning') });
    const result = await runTypecheck(worktree, state.lang());
    if (result.ok) {
      if (!result.skipped) {
        state.addLog(null, 'system', state.say('pipe.checksPassed', { task: task.id }));
      }
      return { outcome: 'pass' };
    }
    return {
      outcome: 'fail', note: result.message,
      artifact: { kind: 'checks', text: result.message },
    };
  },
  exhausted(ctx, last) {
    return { note: ctx.state.say('pipe.checksFailedStuck', { message: last.note ?? '' }) };
  },
};

/** Автор чинит упавшие проверки. */
const fixChecks: Executor<Ctx> = {
  async run(ctx) {
    const { state, task } = ctx;
    state.patchPr(task.id, { note: state.say('pipe.checksFailedNote') });
    state.addChat(OFFICE_SENDER, state.say('pipe.checksFailedChat', { task: task.id }));
    const output = ctx.run.artifacts.checks?.text ?? '';
    const fix = await agents.rework(state, task, checksPrompt(state, task, output));
    const worktree = state.tasks.get(task.id)?.worktreePath ?? null;
    if (worktree) await settle(worktree, task, state.say('pipe.note.fixChecks'));
    if (!fix.ok) {
      return failed(state.say('pipe.checksFixFailed', { problem: fix.message }), fix.needsDecision);
    }
    return { outcome: 'done' };
  },
};

/** Открыть пулл-реквест. С GitHub — настоящий, иначе внутренний. */
const openPr: Executor<Ctx> = {
  async run(ctx) {
    const { state, task, repo, branch, base } = ctx;
    state.patchPr(task.id, { note: state.say('pipe.opening') });
    const gh = await githubFor(repo);
    if (!gh) {
      state.patchPr(task.id, { note: state.say('pipe.localPr', { branch, base }) });
      return { outcome: 'pass' };
    }

    const push = await pushBranch(repo, branch, gh.token, state.lang());
    if (!push.ok) return fail(state.say('pipe.pushFailed', { problem: push.message }));
    const created = await createPullRequest(gh, {
      head: branch, base, title: `${task.id}: ${task.title}`, body: prBody(state, task),
    });
    if (!created.ok || !created.data) {
      return fail(state.say('pipe.prFailed', { error: created.error ?? '' }));
    }
    state.patchPr(task.id, {
      number: created.data.number, url: created.data.url,
      note: state.say('pipe.prOpened', { number: created.data.number }),
    });
    state.addChat(OFFICE_SENDER,
      state.say('pipe.prOpenedChat', { task: task.id, url: created.data.url }));
    return { outcome: 'pass' };
  },
};

/** Ревью. Отказ ревьюера — такой же законный исход, как одобрение. */
const review: Executor<Ctx> = {
  run(ctx) {
    const { state, task, pr } = ctx;
    return withLock(reviewLocks, state.officeId, async (): Promise<StepResult> => {
      state.patchPr(task.id, { note: state.say('pipe.waitingReview') });
      const outcome = await agents.review(state, task, pr);
      if (outcome.error) {
        return failed(state.say('pipe.reviewFailed', { error: outcome.error }), outcome.needsDecision);
      }

      state.addReview(task.id, {
        at: Date.now(), verdict: outcome.verdict,
        reviewerId: outcome.reviewerId, text: outcome.text,
      });
      state.addChat(OFFICE_SENDER, state.say('pipe.reviewVerdictChat', {
        task: task.id,
        verdict: state.say(outcome.verdict === 'approve'
          ? 'pipe.verdict.approved'
          : 'pipe.verdict.returned'),
      }));

      // Отзыв уходит и в сам пулл-реквест: на GitHub он должен быть виден
      // и без нашего интерфейса.
      const fresh = state.prOf(task.id);
      const gh = fresh?.number ? await githubFor(fresh.repoDir) : null;
      if (gh && fresh?.number) {
        await commentOnPr(gh, fresh.number, state.say('pipe.prComment', {
          verdict: state.say(outcome.verdict === 'approve'
            ? 'pipe.verdict.canMerge'
            : 'pipe.verdict.needsWork'),
          text: outcome.text,
        }));
      }
      return {
        outcome: outcome.verdict,
        artifact: { kind: 'review', text: outcome.text, ref: outcome.verdict },
      };
    });
  },
  exhausted(ctx, last, count) {
    // Ещё один заход к тому же исполнителю с тем же отзывом ничего не изменит.
    ctx.state.patchPr(ctx.task.id, { rounds: count });
    return {
      note: ctx.state.say('pipe.tooManyRounds', { n: count, text: last.artifact?.text ?? '' }),
      needsDecision: true,
    };
  },
};

/** Доработка по отзыву — тем же автором, в той же ветке. */
const rework: Executor<Ctx> = {
  async run(ctx) {
    const { state, task } = ctx;
    const text = ctx.run.artifacts.review?.text ?? '';
    const fix = await agents.rework(state, task, reworkPrompt(state, task, text));
    const worktree = state.tasks.get(task.id)?.worktreePath ?? null;
    if (worktree) await settle(worktree, task, state.say('pipe.note.rework'));
    if (!fix.ok) {
      return failed(state.say('pipe.reworkFailed', { problem: fix.message }), fix.needsDecision);
    }
    return { outcome: 'done' };
  },
};

/**
 * Слияние и уборка. Идёт по одному на репозиторий.
 *
 * Исход 'moved' — база уехала прямо под нами: это не беда, а повод пересобрать
 * ветку и зайти снова; сколько раз — решает процесс.
 */
const merge: Executor<Ctx> = {
  run(ctx) {
    const { state, task, repo, branch, base } = ctx;
    return withLock(mergeLocks, repo, async (): Promise<StepResult> => {
      state.patchPr(task.id, { note: state.say('pipe.merging', { base }) });

      const gh = await githubFor(repo);
      const fresh = state.prOf(task.id);
      if (gh && fresh?.number) {
        const push = await pushBranch(repo, branch, gh.token, state.lang());
        if (!push.ok) return fail(state.say('pipe.pushBeforeMerge', { problem: push.message }));
        const merged = await mergePullRequest(gh, fresh.number, `${task.id}: ${task.title}`);
        if (!merged.ok) {
          // Чаще всего это «база уехала» — GitHub отказывает в слиянии несвежего
          // пулл-реквеста. Заходим на второй круг, а не зовём человека.
          state.addLog(null, 'error',
            state.say('pipe.githubMergeFailed', { task: task.id, error: merged.error ?? '' }));
          return { outcome: 'moved' };
        }
        await fetchRemote(repo, gh.token);
        const moved = await fastForward(repo, base, `origin/${base}`);
        if (!moved) {
          state.addLog(null, 'system', state.say('pipe.mergedNoPull', { task: task.id, base }));
        }
      } else {
        // Проверку гоняем в рабочей копии офиса на уже собранном слиянии и ДО
        // сдвига базы: не прошла — базовая ветка остаётся рабочей.
        const outcome = await mergeBranch(repo, branch, base, integrationDir(state), state.lang(),
          async (worktree) => {
            const result = await runTypecheck(worktree, state.lang());
            return {
              ok: result.ok,
              message: state.say('pipe.buildFailsWithBase', { base, message: result.message }),
            };
          });

        if (outcome.kind === 'conflict' || outcome.kind === 'verify-failed') {
          // Ветка расходится с базой или ломает сборку вместе с ней — это чинит
          // автор на следующем круге, а не человек руками.
          state.addChat(OFFICE_SENDER,
            state.say('pipe.mergeOutcome', { task: task.id, message: outcome.message }));
          return { outcome: 'moved' };
        }
        if (!outcome.ok && outcome.kind !== 'nothing') return fail(outcome.message);
        if (outcome.kind === 'nothing') {
          state.addLog(null, 'system', state.say('pipe.noCommits', { task: task.id, base }));
        }
        // Правки человека в его рабочей копии слияние больше не останавливают:
        // оно собирается в копии офиса. Отставшую копию просто называем вслух.
        if (outcome.checkout.state === 'lagging') {
          state.addChat(OFFICE_SENDER,
            state.say('pipe.mergedChat', { task: task.id, message: outcome.checkout.message }));
        }
      }

      await cleanup(state, state.tasks.get(task.id) ?? task, repo, branch);

      // Ревизию базы запоминаем до того, как её сдвинет следующее слияние: по
      // ней надзор потом заметит, что работу откатили.
      const mergeCommit = await revision(repo, base);
      state.updateTask(task.id, {
        status: 'done', merged: true, worktreePath: null, finishedAt: Date.now(), mergeCommit,
      });
      recordOutcome(state, task.id, mergedKind(state, task));
      state.patchPr(task.id, {
        stage: 'merged',
        note: fresh?.number
          ? state.say('pipe.mergedViaPr', { number: fresh.number })
          : state.say('pipe.mergedPlain', { base }),
      });
      state.addChat(OFFICE_SENDER, state.say('pipe.mergedFinal', { task: task.id, base }));
      agents.notifyPm(state,
        state.say('pipe.pmMerged', { task: task.id, title: task.title, base }));
      // Влитая ветка — единственное событие, после которого зависимая задача
      // становится готовой, а фича — закрытой. Ждать прохода надзора здесь нельзя:
      // минута простоя на каждом звене складывается в час на большом плане.
      dispatch(state);
      return { outcome: 'pass' };
    });
  },
  exhausted(ctx) {
    return { note: ctx.state.say('pipe.baseMovesFast', { base: ctx.base }) };
  },
};

/** Действия узлов процесса `feature` — по именам из `workflows/feature.json`. */
const FEATURE: Record<string, Executor<Ctx>> = {
  'office:sync-base': syncBase,
  'office:fix-conflict': fixConflict,
  'office:checks': checks,
  'office:fix-checks': fixChecks,
  'office:open-pr': openPr,
  'office:review': review,
  'office:rework': rework,
  'office:merge': merge,
};

/** Уборка после слияния: ни рабочей копии, ни ветки — ни локально, ни в origin. */
async function cleanup(
  state: OfficeState, task: Task, repo: string, branch: string,
): Promise<void> {
  if (task.worktreePath) await removeWorktree(repo, task.worktreePath, branch);
  const gh = await githubFor(repo);
  if (gh) await deleteRemoteBranch(repo, branch, gh.token);
}

/**
 * Конвейер встал. Дальше два разных мира:
 *
 * - обычная беда (конфликт, упавшие проверки, занятые исполнители, сеть) —
 *   офис попробует сам, и звать никого не нужно: этим займётся надзор
 *   (supervisor.ts). Менеджера дёргать на каждую такую остановку значит
 *   приучить его к шуму;
 * - нужно решение (ревьюер завернул третий раз, некому ревьюить, кончился
 *   бюджет) — повторять бессмысленно, и менеджеру говорим сразу.
 */
function markStuck(
  state: OfficeState, task: Task, why: string, needsDecision = false,
): void {
  // Остановки считаем все подряд: исходу задачи важно не «сколько раз надзор
  // перезапускал», а вставала ли она вообще.
  const stuckTimes = (state.prOf(task.id)?.stuckTimes ?? 0) + 1;
  state.patchPr(task.id, { stage: 'stuck', note: why, needsDecision, stuckTimes });
  state.addChat(OFFICE_SENDER, state.say('pipe.stuckChat', { task: task.id, why }));
  state.addLog(null, 'error', state.say('pipe.stuckLog', { task: task.id, why }));
  if (!needsDecision) return;
  agents.notifyPm(state,
    state.say('pipe.pmStuck', { task: task.id, title: task.title, why }));
}

/**
 * Толкнуть конвейер заново — с той стадии, где он встал. Нужен и человеку
 * (кнопка), и менеджеру: после починки чужой задачи вставший PR часто едет
 * дальше без единой правки.
 */
export function retryPipeline(state: OfficeState, taskId: string): Promise<void> {
  if (state.prOf(taskId)) {
    state.patchPr(taskId, {
      stage: 'sync', note: state.say('pipe.retrying'), needsDecision: false,
    });
  }
  return runPipeline(state, taskId);
}

// ---------- тексты, которые видят агенты ----------

function prBody(state: OfficeState, task: Task): string {
  const { done, total } = criteriaProgress(task);
  return [
    state.say('pipe.prBody.title', { task: task.id, title: task.title }),
    '',
    task.description,
    '',
    task.criteria.length
      ? `${state.say('pipe.prBody.criteria', { done, total })}\n` +
        task.criteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')
      : '',
    '',
    task.result ? `${state.say('pipe.prBody.report')}\n${task.result}` : '',
    '',
    state.say('pipe.prBody.footer'),
  ].filter(Boolean).join('\n');
}

function conflictPrompt(
  state: OfficeState, task: Task, base: string, conflicts: string[],
): string {
  return [
    state.say('prompt.conflict.head', { task: task.id, base }),
    state.say('prompt.conflict.files', { files: conflicts.join(', ') }),
    '',
    state.say('prompt.conflict.body'),
  ].join('\n');
}

function checksPrompt(state: OfficeState, task: Task, output: string): string {
  return [
    state.say('prompt.checks.head', { task: task.id }),
    '',
    output,
    '',
    state.say('prompt.checks.body'),
  ].join('\n');
}

function reworkPrompt(state: OfficeState, task: Task, review: string): string {
  return [
    state.say('prompt.rework.head', { task: task.id }),
    '',
    state.say('prompt.rework.review'),
    review,
    '',
    state.say('prompt.rework.body'),
  ].join('\n');
}

/**
 * Дифф пулл-реквеста для ревьюера: то же, что показывает кнопка «Показать diff».
 * Язык нужен потому, что вместо диффа сюда может приехать объяснение, почему
 * его не получилось собрать, — а его читает ревьюер.
 */
export async function prDiff(pr: PullRequestView, lang: Lang): Promise<string> {
  const result = await diffBranch(pr.repoDir, pr.base, pr.branch, lang);
  if ('error' in result) return t(lang, 'pipe.diffFailed', { error: result.error });
  if (!result.stat) return t(lang, 'pipe.diffEmpty');
  return `${result.stat}\n\n${result.patch}${result.truncated ? t(lang, 'pipe.diffClipped') : ''}`;
}

/** Пулл-реквесты, по которым конвейер встал: их разбирают менеджер и человек. */
export const stuckPrs = (state: OfficeState): PullRequestView[] =>
  [...state.prs.values()].filter((p) => p.stage === 'stuck');
