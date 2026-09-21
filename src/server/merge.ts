import { resolve } from 'node:path';
import type { MergeCheck, MergeRun, MergeStep, TypecheckResult } from '../shared/types';
import { OFFICE_SENDER } from '../shared/types';
import type { Lang } from '../shared/i18n';
import { t } from './i18n';
import { taskRepo, worktreesRoot, type OfficeState, type Task } from './state';
import { dispatch } from './plan';
import { checkMergeable, liveBase, mergeBranch, OFFICE_PERSON, removeWorktree } from './git';
import { runTypecheck } from './checks';
import { duplicateEdits, formatOverlaps } from './overlap';

// Прогон проверок живёт в отдельном модуле (им пользуется и пред-merge гейт),
// но импорты `from './merge'` в конвейере ревью и ритуалах остаются рабочими.
export { runProjectCheck, runTypecheck } from './checks';

/**
 * Ручная очередь слияния — аварийный путь. В обычном порядке ветку задачи
 * ведёт конвейер ревью (review.ts): подтягивает базу, открывает пулл-реквест,
 * зовёт ревьюера и вливает сам. Сюда приходят, когда конвейер встал или его
 * выключили: здесь ничего не сливается само, всё по команде человека.
 */

/**
 * Задачи, которые есть смысл сливать: работа закончена, ветка своя,
 * в основную ещё не влита. «review» — исполнитель сдал, менеджер ещё смотрит;
 * такие ветки пользователь тоже сливает, дожидаться закрытия не обязательно.
 */
export function mergeableTasks(state: OfficeState): Task[] {
  return [...state.tasks.values()].filter((t) => {
    if (t.merged || !t.branch || !t.baseBranch) return false;
    if (t.status !== 'done' && t.status !== 'review') return false;
    // Задачу, которую прямо сейчас ведёт конвейер, человеку показывать как
    // «готова к слиянию» нельзя: он сольёт ветку из-под идущего ревью.
    // Вставший конвейер — наоборот, ровно тот случай, когда сливают руками.
    const pr = state.prOf(t.id);
    return !pr || pr.stage === 'stuck';
  });
}

/**
 * База задачи, в которую можно сливать прямо сейчас. Записанное на задаче имя
 * ветки могло протухнуть, пока задача шла (подробности — у `liveBase` в
 * git.ts). Починку записываем на задачу, а не держим в одном вызове: иначе
 * следующий узел конвейера, очередь слияния и поиск откатов снова упрутся
 * в мёртвую ссылку — каждый по-своему.
 */
export async function taskBase(state: OfficeState, task: Task): Promise<string | null> {
  const recorded = task.baseBranch;
  if (!recorded) return null;
  const live = await liveBase(taskRepo(task, state), recorded);
  if (live === recorded) return recorded;
  state.updateTask(task.id, { baseBranch: live });
  state.addLog(null, 'system',
    state.say('pipe.baseGone', { task: task.id, gone: recorded, base: live }));
  return live;
}

/**
 * Офисы, в которых проверка идёт прямо сейчас. Раньше флаг был один на процесс:
 * с несколькими живыми офисами проверка в одном молча отменяла бы проверку
 * в другом.
 */
const checking = new Set<string>();

/**
 * Пересчитать статусы мержабельности всех завершённых задач.
 * Проверка сухая: основная ветка не меняется. Считаем по очереди, а не
 * параллельно, — запасной путь проверки создаёт worktree, а два worktree
 * одного репозитория одновременно только мешают друг другу.
 */
export async function refreshMergeChecks(state: OfficeState): Promise<MergeCheck[]> {
  if (checking.has(state.officeId)) return [...state.mergeChecks.values()];
  checking.add(state.officeId);
  state.setMergeChecking(true);
  const checks: MergeCheck[] = [];
  try {
    for (const task of mergeableTasks(state)) {
      const branch = task.branch;
      const base = await taskBase(state, task);
      if (!branch || !base) continue;
      const result = await checkMergeable(taskRepo(task, state), branch, base, state.lang());
      checks.push({
        taskId: task.id,
        state: result.state,
        conflicts: result.conflicts,
        message: result.message,
        checkedAt: Date.now(),
      });
    }
    state.setMergeChecks(checks);
    return checks;
  } catch (err) {
    state.setMergeChecking(false);
    state.addLog(null, 'error',
      state.say('merge.checkFailed', { error: (err as Error).message }));
    return [...state.mergeChecks.values()];
  } finally {
    checking.delete(state.officeId);
  }
}

/**
 * Офисы, где очередь слияния идёт прямо сейчас. Как и с проверками: офисов
 * несколько, а флаг на процесс не пустил бы второй офис слить свою работу.
 */
const queueRunning = new Set<string>();

/**
 * Рабочая копия офиса для слияний — своя на офис, рядом с копиями задач.
 * Имя не может совпасть с задачей: у задач имена вида T-3.
 */
export const integrationDir = (state: OfficeState): string =>
  resolve(worktreesRoot(state), '_base');

const pendingStep = (task: Task, lang: Lang): MergeStep => ({
  taskId: task.id,
  title: task.title,
  status: 'pending',
  message: t(lang, 'merge.queuePending'),
  conflicts: [],
  typecheck: null,
});

/**
 * Слить выбранные задачи по порядку списка. Останавливаемся на первой беде —
 * конфликте, отказе git или упавшей проверке сборки — и говорим, где встали.
 * Уже слитое не откатываем: откат чужой работы был бы хуже остановки.
 */
export async function mergeQueue(taskIds: string[], state: OfficeState): Promise<MergeRun | null> {
  if (queueRunning.has(state.officeId)) {
    state.addChat(OFFICE_SENDER, state.say('merge.queueRunning'));
    return state.mergeRun;
  }

  const tasks = taskIds
    .map((id) => state.tasks.get(id))
    .filter((t): t is Task => Boolean(t));
  if (!tasks.length) {
    state.addChat(OFFICE_SENDER, state.say('merge.nothingToMerge'));
    return null;
  }

  queueRunning.add(state.officeId);
  const runState: MergeRun = {
    id: `merge-${Date.now()}`,
    running: true,
    steps: tasks.map((task) => pendingStep(task, state.lang())),
    summary: state.say('merge.queueStarted'),
    startedAt: Date.now(),
    finishedAt: null,
  };
  state.setMergeRun(runState);

  let merged = 0;
  let stoppedAt: MergeStep | null = null;

  try {
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      const step = runState.steps[i];
      const branch = task.branch;
      const base = await taskBase(state, task);

      if (task.merged) {
        finishStep(state, runState, step, 'skipped', state.say('merge.stepMerged', {
          task: task.id, base: task.baseBranch ?? state.say('merge.stepDefaultBase'),
        }));
        continue;
      }
      if (!branch || !base) {
        finishStep(state, runState, step, 'skipped',
          state.say('merge.stepNoBranch', { task: task.id }));
        continue;
      }

      // Репозиторий берём с задачи: у ролей они разные, а настройка роли
      // могла смениться уже после того, как задачу сделали.
      const repo = taskRepo(task, state);
      // Проверку гоняем в рабочей копии офиса, где слияние уже собрано, и ДО
      // того, как сдвинется базовая ветка: не прошла — в базовую ничего не уедет.
      // Результат проверки достаём из замыкания через объект: присваивание
      // внутри колбэка компилятор не видит, и простая переменная сузилась бы в never.
      // Дублирующие правки считаем до слияния: после него база уже содержит
      // ветку. Слияние они не останавливают — только пополняют отчёт задачи
      // и ленту (overlap.ts, урок T-138).
      const duplicate = formatOverlaps(
        await duplicateEdits(repo, base, branch), base, branch, state.lang());

      const checks: { result: TypecheckResult | null } = { result: null };
      const outcome = await mergeBranch(repo, branch, base, integrationDir(state), state.lang(),
        async (worktree) => {
          const result = await runTypecheck(worktree, state.lang());
          checks.result = result;
          return {
            ok: result.ok,
            message: state.say('merge.verifyFailed', { base, message: result.message }),
          };
        },
        // Ручная очередь: работа исполнителя, а влил её по команде человека сам офис.
        { author: state.gitPerson(task.assigneeId), committer: OFFICE_PERSON });
      if (checks.result) step.typecheck = checks.result;
      state.addChat(OFFICE_SENDER,
        state.say('merge.stepOutcome', { task: task.id, message: outcome.message }));
      state.addLog(null, outcome.ok ? 'system' : 'error',
        `merge ${branch}: ${outcome.kind}, copy ${outcome.worktree ?? integrationDir(state)}`);
      // Обходы по дороге (занятый каталог интеграции, снятые хвосты worktree)
      // слияние не отменяют, но в ленте им место: иначе следа не остаётся вовсе.
      for (const warning of outcome.warnings) {
        state.addLog(null, 'system', warning);
        state.addChat(OFFICE_SENDER, `⚠️ ${warning}`);
      }
      // Рабочая копия человека могла отстать: его незакоммиченные правки — не
      // повод останавливать очередь, но сказать об этом нужно.
      if (outcome.checkout.state === 'lagging') {
        state.addChat(OFFICE_SENDER, outcome.checkout.message);
      }

      if (outcome.kind === 'conflict') {
        finishStep(state, runState, step, 'conflict',
          state.say('merge.conflict', {
            base,
            files: outcome.conflicts.length
              ? state.say('merge.conflictFiles', { files: outcome.conflicts.join(', ') })
              : outcome.message,
          }),
          outcome.conflicts);
        stoppedAt = step;
        break;
      }
      if (outcome.kind === 'verify-failed') {
        finishStep(state, runState, step, 'typecheck-failed', outcome.message, [], checks.result);
        stoppedAt = step;
        break;
      }
      if (!outcome.ok) {
        finishStep(state, runState, step, 'failed', outcome.message);
        stoppedAt = step;
        break;
      }

      // Слияние прошло (или сливать было нечего) — worktree задаче больше не нужен.
      if (task.worktreePath) await removeWorktree(repo, task.worktreePath, branch);
      if (duplicate && outcome.kind === 'merged') {
        state.addChat(OFFICE_SENDER, `⚠️ ${duplicate}`);
        state.addLog(null, 'system', `${task.id}: ${duplicate}`);
      }
      state.updateTask(task.id, {
        merged: true,
        worktreePath: null,
        // Предупреждение живёт в отчёте задачи: лента уедет, а карточку читают
        // и через неделю.
        ...(duplicate && outcome.kind === 'merged'
          ? { result: [task.result, `⚠️ ${duplicate}`].filter(Boolean).join('\n\n') }
          : {}),
      });
      // Ветка в основной — значит, зависимые задачи плана могли созреть,
      // а фича закрыться. Слияние руками должно двигать план так же, как
      // это делает конвейер: иначе план стоял бы ровно у тех, кто сливает сам.
      dispatch(state);

      if (outcome.kind === 'nothing') {
        finishStep(state, runState, step, 'nothing',
          state.say('merge.stepNothing', { branch, base }));
        continue;
      }

      merged += 1;
      const checked = checks.result;
      finishStep(state, runState, step, 'merged',
        state.say('merge.stepDone', {
          base,
          checks: !checked || checked.skipped
            ? (checked?.message ?? '')
            : state.say('merge.checksPassed'),
        }),
        [], checked);

      // Порядок слияний меняет картину: после каждого успешного пересчитываем,
      // что теперь с чем конфликтует.
      await refreshMergeChecks(state);
    }

    runState.summary = summarize(state, runState, merged, stoppedAt);
  } catch (err) {
    runState.summary = state.say('merge.queueCrashed', { error: (err as Error).message });
    state.addLog(null, 'error', runState.summary);
  } finally {
    queueRunning.delete(state.officeId);
    runState.running = false;
    runState.finishedAt = Date.now();
    state.setMergeRun(runState);
    state.addChat(OFFICE_SENDER, runState.summary);
    // Финальный пересчёт: после остановки статусы остальных задач тоже другие.
    await refreshMergeChecks(state);
  }

  return runState;
}

function finishStep(
  state: OfficeState, runState: MergeRun, step: MergeStep,
  status: MergeStep['status'], message: string,
  conflicts: string[] = [], typecheck: TypecheckResult | null = null,
): void {
  step.status = status;
  step.message = message;
  step.conflicts = conflicts;
  if (typecheck) step.typecheck = typecheck;
  state.setMergeRun(runState);
}

/** Итог очереди одной фразой — её пользователь и читает первой. */
function summarize(
  state: OfficeState, runState: MergeRun, merged: number, stoppedAt: MergeStep | null,
): string {
  const skipped = runState.steps.filter((s) => s.status === 'pending').length;
  const head = merged
    ? state.say('merge.summaryMerged', { n: merged })
    : state.say('merge.summaryNone');
  if (!stoppedAt) return state.say('merge.summaryAll', { head });

  const where = state.say('merge.summaryStopped', {
    task: stoppedAt.taskId, title: stoppedAt.title,
  });
  const why = stoppedAt.status === 'conflict'
    ? (stoppedAt.conflicts.length
      ? state.say('merge.summaryWhyConflictFiles', { files: stoppedAt.conflicts.join(', ') })
      : state.say('merge.summaryWhyConflict'))
    : `: ${stoppedAt.message}`;
  const rest = skipped
    ? state.say('merge.summaryRest', {
      tasks: runState.steps.filter((s) => s.status === 'pending').map((s) => s.taskId).join(', '),
    })
    : '';
  return state.say('merge.summaryTail', { head, where, why, rest });
}
