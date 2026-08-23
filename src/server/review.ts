/**
 * Конвейер ревью: что происходит с задачей после того, как исполнитель её сдал.
 *
 * Порядок один и тот же и для локального репозитория, и для GitHub:
 *
 *   ветка задачи → подтянуть базовую ветку и разрешить конфликты
 *                → прогнать проверки проекта
 *                → открыть пулл-реквест
 *                → ревью живым ревьюером
 *                → слить в базовую ветку
 *                → убрать ветку и рабочую копию
 *
 * Всё это идёт само: человек в цепочке не нужен. Он нужен ровно в одном
 * случае — когда конвейер встал (стадия 'stuck'): не разошлись с конфликтом,
 * не прошли проверки, ревьюер два раза подряд вернул работу. Тогда офис
 * говорит об этом менеджеру и перестаёт крутить круги за деньги.
 *
 * Сессии агентов сюда не импортируются: конвейер знает только, что кто-то
 * умеет «отревьюить» и «переделать» (PipelineAgents). Так этот файл не тянет
 * за собой Agent SDK, а тесты гоняют весь порядок на настоящем репозитории
 * с подставными агентами.
 */
import type { PullRequestView, ReviewVerdict } from '../shared/types';
import {
  office, taskRepo, criteriaProgress, worktreesRoot, type OfficeState, type Task,
} from './state';
import {
  abortMerge, commitAll, deleteRemoteBranch, diffBranch, ensureWorktree, fastForward,
  fetchRemote, isDirty, isRepo, mergeBaseInto, mergeBranch, mergeInProgress, pushBranch,
  removeWorktree, revision,
} from './git';
import { integrationDir, runTypecheck } from './merge';
import { githubToken } from './cloud';
import { commentOnPr, createPullRequest, githubFor, mergePullRequest } from './github';

/** Сколько раз ревьюер может вернуть работу автору, прежде чем позовём менеджера. */
export const MAX_ROUNDS = 2;
/** Сколько раз даём автору починить упавшие проверки на одном круге. */
const MAX_FIX_ATTEMPTS = 1;

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
  async review() {
    return { verdict: 'changes', text: '', reviewerId: null, error: 'Ревьюер недоступен: офис не поднял агентов.' };
  },
  async rework() {
    return { ok: false, message: 'Исполнители недоступны: офис не поднял агентов.' };
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

/** Остановка конвейера с понятной причиной — не ошибка выполнения, а исход. */
class Stuck extends Error {}

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
      if (err instanceof Stuck) return;
      const task = state.tasks.get(taskId);
      state.addLog(null, 'error', `Конвейер ${taskId} упал: ${(err as Error).message}`);
      if (task) markStuck(state, task, `Конвейер сломался: ${(err as Error).message}`);
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
  if (!state.settings.autoPipeline) return 'Конвейер ревью выключен в настройках офиса.';
  if (!task.branch || !task.baseBranch) return 'У задачи нет своей ветки — ревьюить и сливать нечего.';
  if (task.merged) return 'Задача уже влита.';
  if (!(await isRepo(taskRepo(task, state)))) return 'Работа шла не в git-репозитории.';
  return null;
}

async function pipeline(state: OfficeState, taskId: string): Promise<void> {
  const task = state.tasks.get(taskId);
  if (!task) return;
  const problem = await pipelineProblem(state, task);
  if (problem) {
    // Не тихий отказ: без конвейера задача просто остаётся сделанной, и это
    // ровно тот случай, когда ветку сливает человек из очереди слияния.
    state.addLog(null, 'system', `${taskId}: конвейер не пошёл — ${problem}`);
    return;
  }

  const repo = taskRepo(task, state);
  const branch = task.branch as string;
  const base = task.baseBranch as string;

  const pr = state.startPr({
    taskId, title: task.title, branch, base, repoDir: repo,
  });
  state.updateTask(taskId, { status: 'review' });
  state.addChat('офис', `${taskId}: работа сдана, веду её через ревью в ${base}.`);

  for (;;) {
    // Пауза офиса останавливает и конвейер: сливать в основную ветку, пока
    // пользователь нажал «стоп всему», — ровно то, чего он не просил.
    await state.whenResumed();
    const worktree = await workingCopy(state, task, repo, branch);
    await syncBase(state, task, pr, repo, worktree, base);
    await runChecks(state, task, pr, worktree);
    await openPr(state, task, pr, repo, branch, base);

    const outcome = await withLock(reviewLocks, state.officeId,
      () => reviewStep(state, task, pr));

    if (outcome.verdict === 'approve') {
      await state.whenResumed();
      // Пока пулл-реквест ждал ревью, база могла уехать: пересобираем ветку
      // поверх свежей базы и перепроверяем — и только потом занимаем замок.
      // Долгие шаги (автор разбирает конфликт) не держат очередь слияний.
      for (let attempt = 0; ; attempt += 1) {
        await syncBase(state, task, pr, repo, worktree, base);
        await runChecks(state, task, pr, worktree);
        const done = await withLock(mergeLocks, repo,
          () => mergeStep(state, task, pr, repo, branch, base));
        if (done) return;
        if (attempt >= 1) {
          markStuck(state, task,
            `База ${base} уезжает быстрее, чем задача успевает слиться. ` +
            'Две попытки подряд не сошлись — нужна ручная разборка.');
          throw new Stuck();
        }
        state.addChat('офис', `${task.id}: ${base} уехала, пока сливали, — захожу на второй круг.`);
      }
    }

    // Возврат автору: круги считаем по пулл-реквесту, а не по сессии, —
    // перезапуск сервера не должен обнулять счётчик и запускать вечный цикл.
    const rounds = pr.rounds + 1;
    state.patchPr(taskId, { rounds, stage: 'rework', note: `Ревьюер вернул работу (круг ${rounds}).` });
    if (rounds > MAX_ROUNDS) {
      // Четвёртый заход к тому же исполнителю с тем же отзывом ничего не изменит.
      markStuck(state, task,
        `Ревьюер вернул работу ${rounds} раза подряд. Последний отзыв:\n${outcome.text}`, true);
      throw new Stuck();
    }

    const fix = await agents.rework(state, task, reworkPrompt(task, outcome.text));
    if (task.worktreePath) await settle(task.worktreePath, task, 'доработка по ревью');
    if (!fix.ok) {
      markStuck(state, task, `Доработка по отзыву не пошла: ${fix.message}`, fix.needsDecision);
      throw new Stuck();
    }
  }
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
async function workingCopy(
  state: OfficeState, task: Task, repo: string, branch: string,
): Promise<string> {
  const path = await ensureWorktree(repo, worktreesRoot(state), task.id, branch);
  if (!path) {
    markStuck(state, task, `Не удалось получить рабочую копию ветки ${branch}.`);
    throw new Stuck();
  }
  if (path !== task.worktreePath) state.updateTask(task.id, { worktreePath: path });
  return path;
}

/**
 * Шаг 1: подтянуть базовую ветку в ветку задачи. Конфликты разбирает автор
 * в своей копии — до основной ветки они не доходят вовсе.
 */
async function syncBase(
  state: OfficeState, task: Task, pr: PullRequestView,
  repo: string, worktree: string, base: string,
): Promise<void> {
  state.patchPr(task.id, { stage: 'sync', note: `Подтягиваю ${base} в ветку задачи.` });

  // С GitHub базой считается удалённая ветка: там же лежит и результат чужих
  // слияний. Без удалёнки база локальная — и это единственная правда офиса.
  const gh = await githubFor(repo);
  let ref = base;
  if (gh) {
    await fetchRemote(repo, githubToken());
    if (await revision(repo, `origin/${base}`)) ref = `origin/${base}`;
  }

  const first = await mergeBaseInto(worktree, ref);
  if (first.kind === 'nothing' || first.kind === 'merged') {
    if (first.kind === 'merged') {
      state.addLog(null, 'system', `${task.id}: ${ref} влита в ${task.branch}`);
    }
    return;
  }
  if (first.kind === 'failed') {
    markStuck(state, task, first.message);
    throw new Stuck();
  }

  // Конфликт: рабочая копия осталась в незавершённом слиянии — её и чинит автор.
  state.patchPr(task.id, {
    stage: 'sync',
    note: `Конфликт с ${base}: ${first.conflicts.join(', ')}. Автор разбирает.`,
  });
  state.addChat('офис',
    `${task.id}: ветка разошлась с ${base} — ${first.conflicts.join(', ')}. Отдал автору на разрешение.`);

  const fix = await agents.rework(state, task, conflictPrompt(task, base, first.conflicts));
  if (!fix.ok) {
    await abortMerge(worktree);
    markStuck(state, task, `Конфликт с ${base} не разрешён: ${fix.message}`, fix.needsDecision);
    throw new Stuck();
  }
  // Автор мог оставить слияние незакоммиченным — доводим сами, как и обычную работу.
  await settle(worktree, task, `слияние с ${base}`);

  const again = await mergeBaseInto(worktree, ref);
  if (again.kind !== 'nothing') {
    await abortMerge(worktree);
    markStuck(state, task, `Конфликт с ${base} остался после доработки: ${again.message}`);
    throw new Stuck();
  }
  state.addChat('офис', `${task.id}: конфликты с ${base} разобраны, иду дальше.`);
}

/**
 * Шаг 2: проверки проекта в ветке задачи — до пулл-реквеста, а не после
 * слияния. Сломанную сборку чинит автор, и основная ветка про это не узнаёт.
 */
async function runChecks(
  state: OfficeState, task: Task, pr: PullRequestView, worktree: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    state.patchPr(task.id, { stage: 'checks', note: 'Прогоняю проверки проекта.' });
    const result = await runTypecheck(worktree);
    if (result.ok) {
      if (!result.skipped) state.addLog(null, 'system', `${task.id}: проверки прошли`);
      return;
    }
    if (attempt >= MAX_FIX_ATTEMPTS) {
      markStuck(state, task, `Проверки в ветке задачи не проходят:\n${result.message}`);
      throw new Stuck();
    }
    state.patchPr(task.id, { stage: 'rework', note: 'Проверки упали, автор чинит.' });
    state.addChat('офис', `${task.id}: проверки в ветке не прошли — вернул автору.`);
    const fix = await agents.rework(state, task, checksPrompt(task, result.message));
    await settle(worktree, task, 'починка проверок');
    if (!fix.ok) {
      markStuck(state, task, `Проверки не прошли, и починить не вышло: ${fix.message}`, fix.needsDecision);
      throw new Stuck();
    }
  }
}

/** Шаг 3: открыть пулл-реквест. С GitHub — настоящий, иначе внутренний. */
async function openPr(
  state: OfficeState, task: Task, pr: PullRequestView,
  repo: string, branch: string, base: string,
): Promise<void> {
  state.patchPr(task.id, { stage: 'opening', note: 'Открываю пулл-реквест.' });
  const gh = await githubFor(repo);
  if (!gh) {
    state.patchPr(task.id, { note: `Пулл-реквест офиса: ${branch} → ${base}.` });
    return;
  }

  const push = await pushBranch(repo, branch, gh.token);
  if (!push.ok) {
    markStuck(state, task, `Не удалось отправить ветку в origin: ${push.message}`);
    throw new Stuck();
  }
  const created = await createPullRequest(gh, {
    head: branch, base, title: `${task.id}: ${task.title}`, body: prBody(task),
  });
  if (!created.ok || !created.data) {
    markStuck(state, task, `Не удалось открыть пулл-реквест: ${created.error}`);
    throw new Stuck();
  }
  state.patchPr(task.id, {
    number: created.data.number, url: created.data.url,
    note: `Пулл-реквест #${created.data.number} открыт.`,
  });
  state.addChat('офис', `${task.id}: открыт пулл-реквест ${created.data.url}`);
}

/** Шаг 4: ревью. Отказ ревьюера — такой же законный исход, как одобрение. */
async function reviewStep(
  state: OfficeState, task: Task, pr: PullRequestView,
): Promise<ReviewOutcome> {
  state.patchPr(task.id, { stage: 'review', note: 'Жду ревью.' });
  const outcome = await agents.review(state, task, pr);
  if (outcome.error) {
    markStuck(state, task, `Ревью не состоялось: ${outcome.error}`, outcome.needsDecision);
    throw new Stuck();
  }

  state.addReview(task.id, {
    at: Date.now(), verdict: outcome.verdict,
    reviewerId: outcome.reviewerId, text: outcome.text,
  });
  state.addChat('офис',
    `${task.id}: ревьюер ${outcome.verdict === 'approve' ? 'одобрил' : 'вернул на доработку'}.`);

  // Отзыв уходит и в сам пулл-реквест: на GitHub он должен быть виден
  // и без нашего интерфейса.
  const fresh = state.prOf(task.id);
  const gh = fresh?.number ? await githubFor(fresh.repoDir) : null;
  if (gh && fresh?.number) {
    await commentOnPr(gh, fresh.number,
      `**Ревью офиса — ${outcome.verdict === 'approve' ? 'можно вливать' : 'нужна доработка'}**\n\n${outcome.text}`);
  }
  return outcome;
}

/**
 * Шаг 5: слияние и уборка. Идёт по одному на репозиторий.
 *
 * Возвращает false, если база уехала прямо под нами: это не беда, а повод
 * пересобрать ветку и зайти снова — решает вызывающий.
 */
async function mergeStep(
  state: OfficeState, task: Task, pr: PullRequestView,
  repo: string, branch: string, base: string,
): Promise<boolean> {
  state.patchPr(task.id, { stage: 'merging', note: `Вливаю в ${base}.` });

  const gh = await githubFor(repo);
  const fresh = state.prOf(task.id);
  if (gh && fresh?.number) {
    const push = await pushBranch(repo, branch, gh.token);
    if (!push.ok) {
      markStuck(state, task, `Не удалось обновить ветку в origin перед слиянием: ${push.message}`);
      throw new Stuck();
    }
    const merged = await mergePullRequest(gh, fresh.number, `${task.id}: ${task.title}`);
    if (!merged.ok) {
      // Чаще всего это «база уехала» — GitHub отказывает в слиянии несвежего
      // пулл-реквеста. Заходим на второй круг, а не зовём человека.
      state.addLog(null, 'error', `${task.id}: GitHub не влил пулл-реквест — ${merged.error}`);
      return false;
    }
    await fetchRemote(repo, gh.token);
    const moved = await fastForward(repo, base, `origin/${base}`);
    if (!moved) {
      state.addLog(null, 'system',
        `${task.id}: влито на GitHub, но локальная ${base} не подтянулась — ` +
        'в рабочей копии офиса другая ветка или незакоммиченные правки.');
    }
  } else {
    // Проверку гоняем в рабочей копии офиса на уже собранном слиянии и ДО
    // сдвига базы: не прошла — базовая ветка остаётся рабочей.
    const outcome = await mergeBranch(repo, branch, base, integrationDir(state),
      async (worktree) => {
        const result = await runTypecheck(worktree);
        return {
          ok: result.ok,
          message: `Вместе с ${base} проверка сборки падает: ${result.message}`,
        };
      });

    if (outcome.kind === 'conflict' || outcome.kind === 'verify-failed') {
      // Ветка расходится с базой или ломает сборку вместе с ней — это чинит
      // автор на следующем круге, а не человек руками.
      state.addChat('офис', `${task.id}: ${outcome.message}`);
      return false;
    }
    if (!outcome.ok && outcome.kind !== 'nothing') {
      markStuck(state, task, outcome.message);
      throw new Stuck();
    }
    if (outcome.kind === 'nothing') {
      state.addLog(null, 'system', `${task.id}: в ветке нет коммитов сверх ${base}`);
    }
    // Правки человека в его рабочей копии слияние больше не останавливают:
    // оно собирается в копии офиса. Отставшую копию просто называем вслух.
    if (outcome.checkout.state === 'lagging') {
      state.addChat('офис', `${task.id}: влито. ${outcome.checkout.message}`);
    }
  }

  await cleanup(state, task, repo, branch);

  state.updateTask(task.id, {
    status: 'done', merged: true, worktreePath: null, finishedAt: Date.now(),
  });
  state.patchPr(task.id, {
    stage: 'merged',
    note: fresh?.number ? `Влито через пулл-реквест #${fresh.number}.` : `Влито в ${base}.`,
  });
  state.addChat('офис', `${task.id}: влито в ${base}, ветка и рабочая копия убраны.`);
  agents.notifyPm(state,
    `[СИСТЕМА] ${task.id} «${task.title}» прошла ревью и влита в ${base}. ` +
    'Ветка и рабочая копия убраны, сливать вручную ничего не нужно.');
  return true;
}

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
  state.patchPr(task.id, { stage: 'stuck', note: why, needsDecision });
  state.addChat('офис', `${task.id}: конвейер встал. ${why}`);
  state.addLog(null, 'error', `${task.id}: конвейер встал — ${why}`);
  if (!needsDecision) return;
  agents.notifyPm(state,
    `[СИСТЕМА] Конвейер по задаче ${task.id} «${task.title}» встал, и сам он дальше не поедет.\n${why}\n` +
    'Работа цела: она в своей ветке, рабочая копия на месте. Реши, что делать: ' +
    'поставить задачу на исправление, переформулировать эту, отдать другой роли — ' +
    'и сделай это сам, не спрашивая пользователя. Если нужен человек (нанять ' +
    'сотрудника, поднять бюджет) — скажи ему одной фразой, что именно от него нужно.');
}

/**
 * Толкнуть конвейер заново — с той стадии, где он встал. Нужен и человеку
 * (кнопка), и менеджеру: после починки чужой задачи вставший PR часто едет
 * дальше без единой правки.
 */
export function retryPipeline(state: OfficeState, taskId: string): Promise<void> {
  if (state.prOf(taskId)) {
    state.patchPr(taskId, { stage: 'sync', note: 'Пробую снова.', needsDecision: false });
  }
  return runPipeline(state, taskId);
}

// ---------- тексты, которые видят агенты ----------

function prBody(task: Task): string {
  const { done, total } = criteriaProgress(task);
  return [
    `**Задача ${task.id}: ${task.title}**`,
    '',
    task.description,
    '',
    task.criteria.length
      ? `Критерии готовности (отмечено ${done} из ${total}):\n` +
        task.criteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')
      : '',
    '',
    task.result ? `Отчёт исполнителя:\n${task.result}` : '',
    '',
    '_Пулл-реквест открыт офисом AI Office автоматически._',
  ].filter(Boolean).join('\n');
}

function conflictPrompt(task: Task, base: string, conflicts: string[]): string {
  return [
    `Твоя ветка задачи ${task.id} разошлась с основной веткой ${base}.`,
    `В рабочей копии идёт незавершённое слияние, конфликты в файлах: ${conflicts.join(', ')}.`,
    '',
    'Разбери конфликты: открой каждый файл, убери маркеры <<<<<<< ======= >>>>>>>',
    'и оставь код, который работает и с твоими изменениями, и с чужими. Чужие правки',
    'не выбрасывай: они уже в основной ветке и кому-то нужны.',
    'Проверь, что проект собирается (например npm run typecheck).',
    'Коммитить не обязательно — офис закоммитит сам. Ничего не пушь и не сливай в основную ветку.',
    'Когда конфликтов не осталось — вызови finish_task с коротким описанием, что ты выбрал и почему.',
  ].join('\n');
}

function checksPrompt(task: Task, output: string): string {
  return [
    `Проверки проекта в твоей ветке по задаче ${task.id} не проходят. Вывод:`,
    '',
    output,
    '',
    'Почини причину, а не симптом: правь код, а не проверку, если проверка права.',
    'Прогони проверку сама и убедись, что она проходит.',
    'Когда всё зелено — вызови finish_task.',
  ].join('\n');
}

function reworkPrompt(task: Task, review: string): string {
  return [
    `Ревьюер посмотрел твою работу по задаче ${task.id} и вернул её на доработку.`,
    '',
    'Отзыв:',
    review,
    '',
    'Работай в той же ветке и той же рабочей копии — новую не заводи.',
    'Разбери каждый пункт отзыва: либо исправь, либо объясни в отчёте, почему пункт неверен.',
    'Ничего не сливай в основную ветку и не пушь — этим займётся офис.',
    'Когда доработка закончена — вызови finish_task.',
  ].join('\n');
}

/** Дифф пулл-реквеста для ревьюера: то же, что показывает кнопка «Показать diff». */
export async function prDiff(pr: PullRequestView): Promise<string> {
  const result = await diffBranch(pr.repoDir, pr.base, pr.branch);
  if ('error' in result) return `Дифф получить не удалось: ${result.error}`;
  if (!result.stat) return 'Изменений в ветке нет.';
  return `${result.stat}\n\n${result.patch}${result.truncated ? '\n… дифф обрезан' : ''}`;
}

/** Пулл-реквесты, по которым конвейер встал: их разбирают менеджер и человек. */
export const stuckPrs = (state: OfficeState = office): PullRequestView[] =>
  [...state.prs.values()].filter((p) => p.stage === 'stuck');
