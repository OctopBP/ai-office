/**
 * Единое правило подсчёта задач «в работе» и «к слиянию». Им пользуются
 * сервер (сводка списка офисов, `server/activity.ts`) и веб (счётчик
 * активного офиса в рейле) — иначе один и тот же офис в списке показывал бы
 * разные числа в зависимости от того, выбран он или нет.
 */
import type { TaskStatus } from './types';

/** Что подсчёту нужно от задачи: структурный тип, чтобы подошли и Task, и TaskView. */
export interface WorkTaskLike {
  status: TaskStatus;
  branch?: string | null;
  merged?: boolean;
}

/** Пока задача в этих статусах, она числится за исполнителем. */
export const IN_WORK_STATUSES: readonly TaskStatus[] = ['assigned', 'in_progress', 'review'];

/** Задача взята и ещё не закрыта. */
export const isInWork = (t: WorkTaskLike): boolean => IN_WORK_STATUSES.includes(t.status);

/**
 * Сделана, но ветка не слита. Ветка без слияния — единственный признак
 * незабранной работы: задачи без своей ветки сливать нечего.
 */
export const isDoneUnmerged = (t: WorkTaskLike): boolean =>
  !isInWork(t) && t.status === 'done' && !!t.branch && !t.merged;

/** Число задач в работе. */
export const countInWork = (tasks: Iterable<WorkTaskLike>): number => {
  let n = 0;
  for (const t of tasks) if (isInWork(t)) n += 1;
  return n;
};

/** Число сделанных, но не слитых задач. */
export const countDoneUnmerged = (tasks: Iterable<WorkTaskLike>): number => {
  let n = 0;
  for (const t of tasks) if (isDoneUnmerged(t)) n += 1;
  return n;
};
