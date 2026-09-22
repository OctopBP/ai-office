/**
 * Процессы по задаче: что происходит после того, как исполнитель её сдал.
 *
 * Порядок описан не здесь, а файлами в `workflows/` (docs/design/workflows/
 * spec.md §7): какой из них — решает тип задачи. Ведёт по нему раннер
 * (runs.ts); здесь — действия узлов, шаг и согласование как сессии живых
 * агентов, и то, как прогон показывается пулл-реквестом. Первый и главный
 * процесс — конвейер ревью кода, `feature.json`:
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
import {
  AUTHOR, REPORT_ARTIFACT, loopMax, nodeOf,
  type Run, type TaskType, type Workflow, type WorkflowNode,
} from '../shared/workflow';
import { t } from './i18n';
import {
  taskRepo, criteriaProgress, worktreesRoot, type OfficeState, type Task,
} from './state';
import { dispatch } from './plan';
import {
  abortMerge, commitAll, deleteRemoteBranch, diffBranch, ensureWorktree, fastForward,
  fetchRemote, isDirty, isRepo, mergeBaseInto, mergeInProgress, pushBranch, type Signature,
  removeWorktree, revision,
} from './git';
import { integrationDir, runProjectCheck, runTypecheck, taskBase } from './merge';
import { formatOverlaps, type DuplicateEdit } from './overlap';
import { mergeChecks, preMergeGate, toGateView, type PreMergeReport } from './premerge';
import { mergedKind, recordOutcome } from './outcomes';
import { githubToken } from './cloud';
import { commentOnPr, createPullRequest, githubFor, mergePullRequest } from './github';
import { builtinWorkflow, workflowFor } from './workflows';
import {
  drive, newRun, resumeRun, type Executor, type Halt, type Resolve, type RunHooks, type StepResult,
} from './runs';

/** Процесс кода — конвейер ревью; остальные типы зовутся по своему имени. */
const WORKFLOW_ID = 'feature';

/**
 * Какой процесс ведёт задачу (spec §7.2): по типу, через настройку офиса.
 * Задача без типа, но с веткой — код: так работали все задачи до типов.
 * null — процесса нет: сдал и всё.
 */
export function workflowForTask(state: OfficeState, task: Task): Workflow | null {
  const type: TaskType | null = task.type ?? (task.branch ? 'code' : null);
  if (!type) return null;
  const id = state.settings.workflows?.[type] ?? (type === 'code' ? WORKFLOW_ID : type);
  return workflowFor(state, id);
}

/**
 * Сколько раз ревьюер может вернуть работу автору, прежде чем позовём
 * менеджера. Число живёт в файле процесса — своём у проекта или встроенном;
 * здесь оно нужно промпту ревьюера.
 */
export const maxRounds = (state: OfficeState): number =>
  loopMax(workflowFor(state, WORKFLOW_ID) ?? builtinWorkflow(WORKFLOW_ID), 'office:review', 'changes') ?? 2;

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

/** Шаг процесса глазами агентов: кого искать, где работать, чем кончить. */
export interface StepRequest {
  node: string;
  needs: readonly string[];
  /** Кого просили (`same`): его берём, если свободен. */
  prefer: string | null;
  /** Кого нельзя (`notSameAs`). */
  exclude: string[];
  cwd: string;
  prompt: string;
  /** Исходы, из которых шаг выбирает. */
  outcomes: string[];
}

export interface StepOutcome {
  ok: boolean;
  outcome: string | null;
  summary: string;
  /** Кто делал. */
  actor?: string;
  error?: string;
  needsDecision?: boolean;
}

/**
 * Живые агенты офиса глазами конвейера. Настоящую реализацию ставит agents.ts
 * при загрузке; тесты подменяют её своей.
 */
export interface PipelineAgents {
  review(state: OfficeState, task: Task, pr: PullRequestView): Promise<ReviewOutcome>;
  rework(state: OfficeState, task: Task, instruction: string): Promise<ReworkOutcome>;
  /** Шаг процесса сессией сотрудника по способностям. Нет — шаги встают. */
  step?(state: OfficeState, task: Task, req: StepRequest): Promise<StepOutcome>;
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

/** Идёт ли прогон по задаче прямо сейчас. */
export const isPipelineRunning = (state: OfficeState, taskId: string): boolean =>
  running.has(`${state.officeId}:${taskId}`);

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
  // Базу берём не с задачи напрямую: записанная ветка могла исчезнуть, пока
  // задача ждала ревью, и тогда первый же `git merge` упал бы с «not something
  // we can merge», а задача встала бы навсегда (T-18).
  const base = (await taskBase(state, task)) as string;

  const workflow = workflowForTask(state, task);
  if (!workflow) {
    state.addLog(null, 'system', state.say('pipe.notStarted', {
      task: taskId, problem: state.say('pipe.noWorkflow', { type: task.type ?? '' }),
    }));
    return;
  }

  const pr = state.startPr({
    taskId, title: task.title, branch, base, repoDir: repo,
  });
  state.updateTask(taskId, { status: 'review' });
  state.addChat(OFFICE_SENDER, state.say('pipe.started', { task: taskId, base }));

  // Повторный заход (перезапуск) не заводит второй прогон, а продолжает тот
  // же с узла, где он встал. Круги ревью при этом не обнуляются — они
  // считаются по задаче, а не по сессии. Прогон другого процесса (тип
  // задачи поменяли) — заводим заново.
  let run = state.runOf(taskId);
  if (!run || run.workflowId !== workflow.id || run.status === 'done') {
    if (run) state.runs.delete(run.id);
    run = newRun(workflow, { taskId });
  }
  resumeRun(run);
  // Отчёт исполнителя с запиской — артефакт, который есть у прогона с самого
  // начала: его читают ревьюер, юрист, владелец.
  run.artifacts[REPORT_ARTIFACT] = { kind: 'report', text: reportText(state, task) };
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
    // Цена узла — рост расхода задачи: сессии автора и ревьюера пишутся на неё.
    cost: () => state.tasks.get(taskId)?.usage.costUsd ?? 0,
  };
  await drive(state, workflow, run, resolveExecutor, hooks);
}

/** Отчёт исполнителя с запиской при передаче (spec §4) — одним текстом. */
function reportText(state: OfficeState, task: Task): string {
  return [
    task.result ?? '',
    task.handoff?.assumed ? state.say('agent.pmMsg.assumed', { text: task.handoff.assumed }) : '',
    task.handoff?.left ? state.say('agent.pmMsg.left', { text: task.handoff.left }) : '',
  ].filter(Boolean).join('\n');
}

/**
 * Прибрать за автором: незакоммиченная правка до ревью не доедет, а
 * недоведённое слияние сломает следующий шаг. Полагаться на то, что агент
 * закоммитит сам, нельзя — офис и обычную работу коммитит за него.
 */
async function settle(
  state: OfficeState, worktree: string, task: Task, message: string, authorId?: string | null,
): Promise<void> {
  if (await mergeInProgress(worktree) || await isDirty(worktree)) {
    const author = state.gitPerson(authorId ?? authorOf(state, task));
    await commitAll(worktree, `${task.id}: ${message}`, { author });
  }
}

/** Чья это работа: исполнитель задачи по свежему состоянию — доработку мог взять другой. */
function authorOf(state: OfficeState, task: Task): string | null {
  return state.tasks.get(task.id)?.assigneeId ?? task.assigneeId;
}

/**
 * Подпись слияния в базу: автор — исполнитель, чью работу вливают, коммитер —
 * ревьюер, который её одобрил. Ревью в процессе не было — вливает менеджер,
 * а без менеджера сам офис.
 */
function mergeSignature(state: OfficeState, task: Task): Signature {
  const pr = state.prOf(task.id);
  const approved = [...(pr?.reviews ?? [])].reverse().find((r) => r.verdict === 'approve');
  const mergerId = approved?.reviewerId ?? pr?.reviewerId ?? state.managerId();
  return { author: state.gitPerson(authorOf(state, task)), committer: state.gitPerson(mergerId) };
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
 * Что считать базой. С GitHub — удалённая ветка: там же лежит и результат
 * чужих слияний. Без удалёнки база локальная — и это единственная правда офиса.
 */
async function baseRef(repo: string, base: string): Promise<string> {
  const gh = await githubFor(repo);
  if (!gh) return base;
  await fetchRemote(repo, githubToken());
  return (await revision(repo, `origin/${base}`)) ? `origin/${base}` : base;
}

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

    const ref = await baseRef(repo, base);
    const result = await mergeBaseInto(
      worktree, ref, state.lang(), { author: state.gitPerson(authorOf(state, task)) });
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

/**
 * Автор разбирает конфликт с базой в своей копии. Узел самодостаточен: если
 * слияние к его приходу не начато (прошлую попытку бросили и прогон
 * возобновили с этого узла), он начинает его сам — автору нужны именно
 * конфликтные метки в файлах, а не пересказ.
 */
const fixConflict: Executor<Ctx> = {
  async run(ctx) {
    const { state, task, base, repo } = ctx;
    const worktree = await workingCopy(ctx);
    if (!worktree) return failed(state.say('pipe.noWorktree', { branch: ctx.branch }));
    let files = (ctx.run.artifacts.conflict?.text ?? '').split(', ').filter(Boolean);
    if (!(await mergeInProgress(worktree))) {
      const again = await mergeBaseInto(
        worktree, await baseRef(repo, base), state.lang(), { author: state.gitPerson(authorOf(state, task)) });
      if (again.kind === 'nothing' || again.kind === 'merged') return { outcome: 'done' };
      if (again.kind === 'failed') return failed(again.message);
      files = again.conflicts;
    }
    const fix = await agents.rework(state, task, conflictPrompt(state, task, base, files));
    if (!fix.ok) {
      await abortMerge(worktree);
      return failed(
        state.say('pipe.conflictUnresolved', { base, problem: fix.message }), fix.needsDecision);
    }
    // Автор мог оставить слияние незакоммиченным — доводим сами, как и обычную работу.
    await settle(state, worktree, task, state.say('pipe.note.merge', { base }));
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
    if (worktree) await settle(state, worktree, task, state.say('pipe.note.fixChecks'));
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
    if (worktree) await settle(state, worktree, task, state.say('pipe.note.rework'));
    if (!fix.ok) {
      return failed(state.say('pipe.reworkFailed', { problem: fix.message }), fix.needsDecision);
    }
    return { outcome: 'done' };
  },
};

/**
 * Причина остановки словами: какая команда упала, на каких файлах и с каким
 * текстом. Ровно то, что печатает гейт в консоли, — иначе задача падала бы с
 * невнятным «база уезжает быстрее, чем задача успевает слиться», а искать
 * настоящую поломку пришлось бы человеку по логам.
 */
function gateReason(state: OfficeState, base: string, report: PreMergeReport): string {
  const failed = report.failed;
  return state.say('pipe.mergeGateRed', {
    base,
    command: failed?.command ?? '',
    files: failed?.files.length
      ? state.say('pipe.mergeGateFiles', { files: failed.files.join(', ') })
      : '',
    output: failed?.output ?? report.message,
  });
}

/**
 * Красная проверка на слитом дереве — конец пути, а не заминка. Повтор её не
 * лечит: ветка зелена сама по себе, и второй заход даст ровно тот же результат.
 * Поэтому конвейер встаёт и зовёт менеджера тем же путём, что и любая другая
 * остановка, которую офис не умеет разобрать сам (needsDecision).
 */
function stopOnRedGate(ctx: Ctx, report: PreMergeReport): StepResult {
  const { state, task, base } = ctx;
  const why = gateReason(state, base, report);
  state.addChat(OFFICE_SENDER, state.say('pipe.mergeOutcome', { task: task.id, message: why }));
  return fail(why, true);
}

/**
 * Ветка разошлась с базой — пробное слияние даёт конфликт, или база уехала,
 * пока гейт гонял проверки. Это чинит автор на следующем круге
 * (resync → fix-conflict), а не человек руками.
 */
function retryAfterGate(ctx: Ctx, report: PreMergeReport): StepResult {
  const { state, task } = ctx;
  state.addChat(OFFICE_SENDER,
    state.say('pipe.mergeOutcome', { task: task.id, message: report.message }));
  // Записку несём дальше: если кругов не хватит, в причине остановки будет
  // видно, на чём именно не сошлись, а не одно «база уезжает быстрее».
  return { outcome: 'moved', note: report.message };
}

/**
 * Конфликт без единого конфликтного файла — не конфликт, а поломка обстановки:
 * так выглядит отказ самого git («not something we can merge», «no such ref»).
 * Второй круг тут не поможет — ветку пересобирать не от чего, — и до этой
 * развилки задача дважды ходила по кругу и вставала с «база уезжает быстрее,
 * чем задача успевает слиться», пока причиной был чужой каталог слияний.
 */
function afterConflict(ctx: Ctx, report: PreMergeReport): StepResult {
  return report.conflicts.length ? retryAfterGate(ctx, report) : stopOnBrokenGate(ctx, report);
}

/**
 * Гейт красный не на проверках и не на расхождении веток — значит, сломана
 * обстановка: не поднялась рабочая копия офиса, грязна копия человека, git
 * отказал. Повтор этого не лечит: до T-56/T-58 конвейер уходил на второй круг
 * и объявлял итогом «база уезжает быстрее, чем задача успевает слиться», пока
 * настоящей причиной был занятый каталог копии офиса. Встаём сразу, зовём
 * человека и говорим, что именно увидел гейт — вместе с его обходами.
 */
function stopOnBrokenGate(ctx: Ctx, report: PreMergeReport): StepResult {
  const { state, task, base } = ctx;
  const why = state.say('pipe.mergeGateBroken', {
    base,
    message: [report.message, ...report.warnings].filter(Boolean).join(' '),
  });
  state.addChat(OFFICE_SENDER, state.say('pipe.mergeOutcome', { task: task.id, message: why }));
  return fail(why, true);
}

/**
 * Слияние и уборка. Идёт по одному на репозиторий.
 *
 * Слиянием заведует пред-merge гейт (premerge.ts): он собирает слияние в копии
 * офиса, гоняет проверки на РЕЗУЛЬТАТЕ слияния и двигает базу только на зелёном.
 * До T-145 конвейер проверял слитое дерево одним typecheck — и четыре поломки
 * прожили в main незамеченными, потому что ломались не сборкой, а тестами.
 *
 * Исход 'moved' — база уехала прямо под нами или ветка с ней разошлась: это не
 * беда, а повод пересобрать ветку и зайти снова; сколько раз — решает процесс.
 * Всё остальное красное — остановка с причиной, а не повтор: гейт, который не
 * смог даже собрать пробное слияние, на втором круге скажет ровно то же (T-56).
 */
const merge: Executor<Ctx> = {
  run(ctx) {
    const { state, task, repo, branch, base } = ctx;
    return withLock(mergeLocks, repo, async (): Promise<StepResult> => {
      state.patchPr(task.id, { note: state.say('pipe.merging', { base }) });
      const checks = mergeChecks(repo, state.settings.mergeChecks);

      // Дублирующие правки считает сам гейт — на пробном слиянии, до того как
      // база сдвинется (после неё «кто что правил после точки ветвления» уже
      // не восстановить). Здесь мы только забираем список: слияние он не
      // останавливает, но в отчёт задачи и менеджеру уходит (overlap.ts, T-138).
      let overlaps: DuplicateEdit[] = [];

      const gh = await githubFor(repo);
      const fresh = state.prOf(task.id);
      if (gh && fresh?.number) {
        // На GitHub сливает GitHub, но проверить слитое дерево до этого — наше
        // дело: собираем слияние у себя и гоняем тот же набор, только без
        // сдвига базы (merge: false). Красное — в origin ничего не уезжает.
        const gate = await preMergeGate({
          repoDir: repo, branch, base, integrationDir: integrationDir(state, repo),
          lang: state.lang(), checks, allowDirty: true, merge: false,
          sign: mergeSignature(state, task),
        });
        // Виден в карточке задачи независимо от исхода — гейт мог остановить
        // конвейер следующей строкой, а его вывод должен остаться на виду.
        state.patchPr(task.id, { gate: toGateView(gate) });
        if (gate.stage === 'checks') return stopOnRedGate(ctx, gate);
        if (gate.stage === 'conflict') return afterConflict(ctx, gate);
        // Гейт мог встать и не на проверках — например, не поднялась копия для
        // слияния. Молча идти дальше нельзя: проверенного дерева нет, а ветка
        // уехала бы в origin и влилась бы непроверенной.
        if (!gate.ok) return stopOnBrokenGate(ctx, gate);
        overlaps = gate.overlaps;

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
        // Незакоммиченные правки человека слиянию не мешают: гейт собирает его
        // в копии офиса, а копию человека двигает advanceBase, не трогая правок.
        const gate = await preMergeGate({
          repoDir: repo, branch, base, integrationDir: integrationDir(state, repo),
          lang: state.lang(), checks, allowDirty: true, sign: mergeSignature(state, task),
        });
        // Строка технического лога — как и соседняя `merge …`, не переводится:
        // её читают в логе сервера, а не в интерфейсе.
        state.addLog(null, gate.ok ? 'system' : 'error',
          `premerge ${branch} → ${base}: ${gate.stage},`
          + ` checks ${gate.checks.length}, gate ${gate.gateMs} ms,`
          + ` copy ${gate.integrationDir}`);
        state.patchPr(task.id, { gate: toGateView(gate) });

        if (gate.stage === 'checks') return stopOnRedGate(ctx, gate);
        if (gate.stage === 'conflict') return afterConflict(ctx, gate);
        // Гейт был зелёным, а само слияние не прошло — чаще всего базу правда
        // сдвинули, пока мы проверяли: вот ровно тот случай, ради которого
        // заведён второй круг и фраза «база уезжает быстрее».
        if (gate.stage === 'merge') return retryAfterGate(ctx, gate);
        if (!gate.ok) return stopOnBrokenGate(ctx, gate);
        overlaps = gate.overlaps;
        if (gate.stage === 'nothing') {
          state.addLog(null, 'system', state.say('pipe.noCommits', { task: task.id, base }));
        }
        // Отставшую копию человека гейт возвращает предупреждением: слияние она
        // не останавливает, но сказать о ней вслух нужно.
        for (const warning of gate.warnings) {
          state.addChat(OFFICE_SENDER,
            state.say('pipe.mergedChat', { task: task.id, message: warning }));
        }
      }

      const duplicate = formatOverlaps(overlaps, base, branch, state.lang());

      await cleanup(state, state.tasks.get(task.id) ?? task, repo, branch);

      // Ревизию базы запоминаем до того, как её сдвинет следующее слияние: по
      // ней надзор потом заметит, что работу откатили.
      const mergeCommit = await revision(repo, base);
      // Предупреждение о дубле правки кладём в отчёт задачи: карточку читают
      // и через неделю, а лента к тому времени уедет далеко.
      const before = state.tasks.get(task.id)?.result ?? null;
      state.updateTask(task.id, {
        status: 'done', merged: true, worktreePath: null, finishedAt: Date.now(), mergeCommit,
        ...(duplicate ? { result: [before, `⚠️ ${duplicate}`].filter(Boolean).join('\n\n') } : {}),
      });
      recordOutcome(state, task.id, mergedKind(state, task));
      state.patchPr(task.id, {
        stage: 'merged',
        note: fresh?.number
          ? state.say('pipe.mergedViaPr', { number: fresh.number })
          : state.say('pipe.mergedPlain', { base }),
      });
      state.addChat(OFFICE_SENDER, state.say('pipe.mergedFinal', { task: task.id, base }));
      if (duplicate) {
        state.addLog(null, 'system', `${task.id}: ${duplicate}`);
        state.addChat(OFFICE_SENDER, `⚠️ ${duplicate}`);
      }
      // Менеджеру предупреждение уходит вместе с известием о слиянии, а не
      // отдельным сообщением: лишний заход сессии стоит денег и внимания.
      agents.notifyPm(state,
        state.say('pipe.pmMerged', { task: task.id, title: task.title, base })
        + (duplicate ? `\n⚠️ ${duplicate}` : ''));
      // Влитая ветка — единственное событие, после которого зависимая задача
      // становится готовой, а фича — закрытой. Ждать прохода надзора здесь нельзя:
      // минута простоя на каждом звене складывается в час на большом плане.
      dispatch(state);
      return { outcome: 'pass' };
    });
  },
  exhausted(ctx, last) {
    // К общей фразе про уезжающую базу добавляем то, что сказал гейт в
    // последний раз: без этого причина остановки не объясняет ничего.
    return {
      note: ctx.state.say('pipe.baseMovesFast', { base: ctx.base })
        + (last.note ? ` ${ctx.state.say('pipe.lastGate', { message: last.note })}` : ''),
    };
  },
};

/** Артефакты узла на вход — текстом для промпта. */
function artifactsText(ctx: Ctx): string {
  const { state, node, run } = ctx;
  const lines = (node.in ?? [])
    .map((name) => [name, run.artifacts[name]] as const)
    .filter(([, a]) => a)
    .map(([name, a]) => state.say('prompt.step.artifact', { name, kind: a!.kind, text: a!.text }));
  return lines.length ? `${state.say('prompt.step.artifacts')}\n${lines.join('\n')}` : '';
}

/**
 * Шаг процесса (spec §8.2): сессия сотрудника по способностям узла. В промпт
 * идут артефакты из `in` с записками, критерии `done` и место в процессе —
 * и никогда чужой транскрипт.
 */
const step: Executor<Ctx> = {
  async run(ctx) {
    const { state, task, node, run, workflow } = ctx;
    if (!agents.step) return failed(state.say('wf.stepFailed', { node: node.id, problem: state.say('pipe.noAgents.worker') }));

    const actorOf = (ref: string | undefined): string | null =>
      !ref ? null : ref === AUTHOR ? task.assigneeId : run.actors[ref] ?? null;
    const prefer = actorOf(node.same);
    if (node.same && !prefer) {
      return failed(state.say('wf.sameGone', { node: node.same, who: '?' }), true);
    }
    const needs = node.needs ?? [];
    if (!prefer && node.noRole && needs.length && !state.capableRoles(needs).length) {
      const note = state.say('wf.stepNoRole', {
        node: node.id, needs: needs.join(', '), outcome: node.noRole,
      });
      state.addChat(OFFICE_SENDER, state.say('wf.stepNoRoleChat', { task: task.id, problem: note }));
      state.addLog(null, 'system', `${task.id}: ${note}`);
      return {
        outcome: node.noRole, note,
        artifact: { kind: 'report', text: note, ref: node.noRole },
      };
    }

    const worktree = await workingCopy(ctx);
    if (!worktree) return failed(state.say('pipe.noWorktree', { branch: ctx.branch }));
    const excluded = actorOf(node.notSameAs);
    const outcomes = Object.keys(node.next).filter((o) => o !== 'failed');
    const prompt = [
      state.say('prompt.step.header', { node: node.id, workflow: workflow.id, task: task.id, title: task.title }),
      '',
      state.say('prompt.step.task'),
      task.description,
      '',
      artifactsText(ctx),
      node.done?.length
        ? `\n${state.say('prompt.step.done')}\n${node.done.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
        : '',
      '',
      state.say('prompt.step.finish', { outcomes: outcomes.join(', ') }),
    ].filter(Boolean).join('\n');

    const out = await agents.step(state, task, {
      node: node.id, needs, prefer, exclude: excluded ? [excluded] : [],
      cwd: worktree, prompt, outcomes,
    });
    if (out.actor) {
      // Владельцу в чат — подпись исполнителя: код экземпляра ему ни о чём.
      const who = state.instances.get(out.actor)?.label ?? out.actor;
      state.addChat(OFFICE_SENDER, state.say('wf.stepStart', { task: task.id, node: node.id, who }));
    }
    await settle(state, worktree, task, node.id, out.actor);
    if (!out.ok || !out.outcome) {
      return {
        outcome: 'failed', actor: out.actor, needsDecision: out.needsDecision,
        note: state.say('wf.stepFailed', { node: node.id, problem: out.error ?? state.say('review.noStepVerdict') }),
      };
    }
    state.addChat(OFFICE_SENDER, state.say('wf.stepDone', { task: task.id, node: node.id, outcome: out.outcome }));
    return {
      outcome: out.outcome, note: out.summary, actor: out.actor,
      artifact: { kind: 'report', text: out.summary, ref: out.outcome },
    };
  },
  exhausted(ctx, last, count) {
    return {
      note: ctx.state.say('wf.stepExhausted', { node: ctx.node.id, n: count, text: last.note ?? '' }),
      needsDecision: true,
    };
  },
};

const YES_RE = /^\s*(да|ага|угу|yes|yep|ok|окей|поехали|approve|approved|go|\+|✅|👍)/i;

/**
 * Согласование (spec §3, `gate`): вопрос владельцу и ожидание. Прогон стоит
 * и ничего не тратит; ответ приходит из чата («Q-1: да») или из панели.
 * Снятый вопрос — отказ: офис не вправе счесть молчание согласием.
 */
const gate: Executor<Ctx> = {
  async run(ctx) {
    const { state, task, node, run } = ctx;
    const what = node.done?.[0] ?? node.id;
    let question = run.waitingOn ? state.questions.get(run.waitingOn) ?? null : null;
    if (!question) {
      question = state.addQuestion({
        from: OFFICE_SENDER, taskId: task.id, kind: 'gate',
        text: state.say('wf.gateAsk', { task: task.id, title: task.title, what }),
        assumption: state.say('wf.gateAssumption'),
      });
      state.addChat(OFFICE_SENDER, state.say('wf.gateChat', { task: task.id, what, id: question.id }));
      state.addLog(null, 'system', state.say('questions.askedLog', { id: question.id, text: what }));
    }
    run.waitingOn = question.id;
    run.status = 'waiting';
    state.saveRun(run);
    state.patchPr(task.id, { note: state.say('wf.gateWaiting', { id: question.id }) });

    const closed = await state.whenQuestionClosed(question.id);
    if (!closed) return { outcome: 'no', note: state.say('wf.gateGone', { id: question.id }) };
    if (!closed.answeredAt) {
      state.addChat(OFFICE_SENDER, state.say('wf.gateDismissed', { id: question.id }));
      return { outcome: 'no', note: state.say('wf.gateDismissed', { id: question.id }), artifact: { kind: 'decision', text: '', ref: 'no' } };
    }
    const answer = closed.answer ?? '';
    const yes = YES_RE.test(answer);
    state.addChat(OFFICE_SENDER, yes
      ? state.say('wf.gateYes', { task: task.id, id: question.id })
      : state.say('wf.gateNo', { task: task.id, id: question.id, answer }));
    return { outcome: yes ? 'yes' : 'no', note: answer, artifact: { kind: 'decision', text: answer, ref: yes ? 'yes' : 'no' } };
  },
  exhausted(ctx, last, count): Halt {
    return {
      note: ctx.state.say('wf.gateExhausted', { n: count, text: last.note ?? '' }),
      needsDecision: true,
    };
  },
};

/** Действия узлов из каталога офиса — по именам `run` в файлах процессов. */
const OFFICE: Record<string, Executor<Ctx>> = {
  'office:sync-base': syncBase,
  'office:fix-conflict': fixConflict,
  'office:checks': checks,
  'office:fix-checks': fixChecks,
  'office:open-pr': openPr,
  'office:review': review,
  'office:rework': rework,
  'office:merge': merge,
};

/**
 * Своя проверка проекта (spec §8.2): `run: "project:<имя>"`, команда — из
 * настроек офиса. Идёт в рабочей копии задачи; не настроена — стоп с
 * объяснением, а не тихий «пройдено».
 */
const projectCheck = (name: string): Executor<Ctx> => ({
  async run(ctx) {
    const { state, task } = ctx;
    const command = state.settings.checks?.[name];
    if (!command) return fail(state.say('pipe.checkUnknown', { name }));
    const worktree = await workingCopy(ctx);
    if (!worktree) return fail(state.say('pipe.noWorktree', { branch: ctx.branch }));
    state.patchPr(task.id, { note: state.say('pipe.checkRunning', { name }) });
    const result = await runProjectCheck(worktree, command, state.lang());
    if (result.ok) {
      state.addLog(null, 'system', state.say('pipe.checkPassed', { task: task.id, name }));
      return { outcome: 'pass', artifact: { kind: 'checks', text: result.output } };
    }
    return {
      outcome: 'fail', note: state.say('pipe.checkFailed', { name, message: result.message }),
      artifact: { kind: 'checks', text: result.message },
    };
  },
  exhausted(ctx, last) {
    return { note: ctx.state.say('pipe.checksFailedStuck', { message: last.note ?? '' }) };
  },
});

/** Чем делается узел: действие из файла, а без него — по виду узла. */
const resolveExecutor: Resolve<Ctx> = (node) => {
  if (node.run?.startsWith('project:')) return projectCheck(node.run.slice('project:'.length));
  if (node.run) return OFFICE[node.run];
  if (node.kind === 'step') return step;
  if (node.kind === 'gate') return gate;
  return undefined;
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
    state.patchPr(taskId, { note: state.say('pipe.retrying'), needsDecision: false });
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
    task.handoff?.assumed ? `\n${state.say('pipe.prBody.assumed')}\n${task.handoff.assumed}` : '',
    task.handoff?.left ? `\n${state.say('pipe.prBody.left')}\n${task.handoff.left}` : '',
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
