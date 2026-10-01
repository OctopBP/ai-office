/**
 * Исход задачи: чем она кончилась (docs/design/living-office/spec.md §3).
 *
 * Зачем хранить, а не считать. Пока задача идёт, всё нужное лежит рядом:
 * круги ревью в пулл-реквесте, остановки в его же счётчике, отметки автора в
 * критериях. Но после слияния конвейер убирает ветку и рабочую копию — и
 * правильно делает, — а через месяц никто не ответит, переделывалась ли
 * задача. Исход — это то, что должно пережить уборку: по нему считается
 * табель роли (shared/report.ts) и по нему рефлексирует менеджер.
 *
 * Пишется один раз при закрытии. Единственное исключение — откат: слитую
 * работу человек выбросил руками уже после закрытия, и это перекрывает
 * прежний исход, потому что важнее его. Перезапуск задачи (retryTask)
 * исход стирает: начинается новая попытка, и судить её по прошлой нельзя.
 */
import type { BudgetStop, OutcomeKind, TaskOutcome } from '../shared/types';
import { criteriaProgress, taskRepo, type OfficeState, type Task } from './state';
import { findRevert, isAncestor, isRepo } from './git';
import { confirmFactsFor } from './journal';

/** Сколько дней после слияния надзор ещё проверяет, не откатили ли работу. */
const REVERT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Кому сообщать о записанном исходе. Слушатель, а не импорт: исходу всё
 * равно, кто им пользуется (телеметрия маркета, проверки), а маркет тянет за
 * собой реестр и сеть, которым в этом модуле делать нечего.
 */
type OutcomeListener = (state: OfficeState, task: Task, outcome: TaskOutcome) => void;
const listeners = new Set<OutcomeListener>();

export function onOutcome(fn: OutcomeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Исходы слитой работы — те, которые откат вправе перекрыть. */
const MERGED_KINDS: OutcomeKind[] = ['clean', 'reworked', 'stuck'];

/**
 * Снять задачу: делать её больше не надо. Одно место на весь офис — снимают
 * и по одной (drop_task, кнопка в карточке), и пачкой вместе с фичей, а
 * закрываться они обязаны одинаково: статус «снята» держит её подальше от
 * раздачи, исход «снята» попадает в табель роли.
 *
 * Прервать работающего исполнителя этим нельзя: сессию гасит тот, кто снимает
 * (tasks.ts), а сюда задача приходит уже без сессии.
 */
export function cancelTask(state: OfficeState, task: Task, at = Date.now()): void {
  state.updateTask(task.id, {
    status: 'cancelled',
    finishedAt: task.finishedAt ?? at,
    // Ожидания снятой задачи больше никого не касаются: она не поедет ни
    // после починки окружения, ни когда освободится слот.
    envWait: null,
    attention: null,
    assigneeId: null,
  });
  state.waitingForSlot.delete(task.id);
  recordOutcome(state, task.id, 'cancelled', at);
}

/**
 * Записать исход задачи. Повторный вызов на закрытой задаче ничего не меняет:
 * исход — факт о закрытии, а не текущее состояние. Возвращает записанный
 * исход либо null, если задача уже закрыта или её нет.
 */
export function recordOutcome(
  state: OfficeState, taskId: string, kind: OutcomeKind, at = Date.now(), budget?: BudgetStop,
): TaskOutcome | null {
  const task = state.tasks.get(taskId);
  if (!task) return null;
  // Остановка предохранителем расхода закрывает задачу до решения человека,
  // но не навсегда: решили продолжить, и задача дошла до конца — верен уже
  // новый исход, а не «остановлена».
  if (task.outcome && task.outcome.kind !== 'stopped_budget'
    && !(kind === 'reverted' && MERGED_KINDS.includes(task.outcome.kind))) return null;

  const pr = state.prOf(task.id);
  const role = task.roleId ? state.role(task.roleId) : undefined;
  const epic = task.epicId ? state.epics.get(task.epicId) : undefined;
  const { done, total } = criteriaProgress(task);
  const outcome: TaskOutcome = {
    kind,
    reworks: pr?.rounds ?? 0,
    stuck: pr?.stuckTimes ?? 0,
    criteria: { total, claimed: done },
    costUsd: task.usage.costUsd,
    durationMs: task.startedAt ? Math.max(0, (task.finishedAt ?? at) - task.startedAt) : 0,
    roleId: task.roleId ?? '',
    package: role?.package?.name ?? null,
    model: role ? state.runtimeOf(role).model : '',
    origin: epic?.origin ?? 'owner',
    at,
    ...(budget ? { budget } : {}),
  };
  state.updateTask(task.id, { outcome });
  state.addLog(null, 'system', state.say('life.outcome.log', {
    task: task.id, kind: state.say(`life.outcome.${kind}`),
  }));
  // Чистое закрытие подтверждает журнал, который задача видела: записи не
  // помешали — значит, они верны (§5.4).
  if (kind === 'clean') confirmFactsFor(state, task, at);
  for (const fn of listeners) fn(state, task, outcome);
  return outcome;
}

/**
 * Исход слитой работы — по тому, что успело случиться в конвейере. Возврат
 * ревьюера весомее остановки: остановка бывает и по проходящей причине
 * (кто-то был занят), а возврат — это всегда про качество работы.
 */
export function mergedKind(state: OfficeState, task: Task): OutcomeKind {
  const pr = state.prOf(task.id);
  if ((pr?.rounds ?? 0) > 0) return 'reworked';
  if ((pr?.stuckTimes ?? 0) > 0) return 'stuck';
  return 'clean';
}

/**
 * Задача сдана и дальше никуда не поедет: без ветки, без конвейера или в
 * режиме проверки. Тогда её закрытие и есть исход — чистый, потому что
 * возвращать её было некому.
 */
export function closeIfDone(state: OfficeState, taskId: string): void {
  const task = state.tasks.get(taskId);
  if (!task || task.status !== 'done' || task.outcome) return;
  if (task.merged) { recordOutcome(state, task.id, mergedKind(state, task)); return; }
  if (!task.branch || !state.settings.autoPipeline) recordOutcome(state, task.id, 'clean');
}

/**
 * Найти откаты: слитые недавно задачи, коммит которых пропал из истории
 * базовой ветки (сброс) или отменён коммитом отката поверх (`git revert`).
 * Это единственный исход, который офис не видит сам в момент события, —
 * человек откатывает руками и офису не докладывает.
 *
 * `mergeCommit` бывает двух поколений: squash-коммит «T-N: …» (с T-140) и
 * merge-коммит старых задач. Обе проверки годятся для обоих: предок есть
 * предок, а `findRevert` узнаёт откат и того, и другого.
 * Возвращает откаченные задачи: кому нужно, тот спросит владельца, что было
 * не так.
 */
export async function detectReverts(state: OfficeState, now = Date.now()): Promise<Task[]> {
  const found: Task[] = [];
  for (const task of state.tasks.values()) {
    if (!task.merged || !task.mergeCommit || !task.baseBranch || !task.outcome) continue;
    if (!MERGED_KINDS.includes(task.outcome.kind)) continue;
    if (now - task.outcome.at > REVERT_WINDOW_MS) continue;
    const repo = taskRepo(task, state);
    if (!(await isRepo(repo))) continue;
    const kept = await isAncestor(repo, task.mergeCommit, task.baseBranch);
    // null — проверить не удалось (ревизию переписали, репозитория нет): это
    // не откат, а незнание, и объявлять работу выброшенной по нему нельзя.
    if (kept === null) continue;
    if (kept && !(await findRevert(repo, task.mergeCommit, task.baseBranch, task.id))) continue;
    recordOutcome(state, task.id, 'reverted', now);
    state.addLog(null, 'system', state.say('life.reverted.log', { task: task.id, base: task.baseBranch }));
    state.addOfficeNote(state.say('life.reverted.chat', {
      task: task.id, title: task.title, base: task.baseBranch,
    }), { taskId: task.id });
    found.push(task);
  }
  return found;
}
