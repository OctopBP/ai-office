import type { TaskView } from '../shared/types';
import { t, locale } from './i18n';
import { hasTime } from './dates';

/**
 * Разделители по дням в колонке задач на доске. Логика отдельно от отрисовки:
 * колонка лишь рисует то, что вернул `splitTasksByDay`.
 *
 * Время берётся по местному часовому поясу пользователя — `Date` без UTC.
 */

/** Сколько дней назад ещё пишем «N дней назад»; с этого — уже дата. */
const RELATIVE_DAYS = 7;

const DAY_MS = 86_400_000;

const startOfDay = (at: number): number => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * Разница в календарных днях. Через `Math.round`, а не деление нацело: день
 * перехода на летнее время длится 23 или 25 часов.
 */
const daysBetween = (at: number, now: number): number => Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);

/**
 * По какому времени задача ложится в день. У остановившейся задачи — когда
 * закончили; у остальных — последнее, что с ней было: взяли в работу или
 * завели. Отдельного «изменена» у задачи нет, а менять контракт ради подписи
 * незачем.
 */
export function taskDayTime(task: Pick<TaskView, 'status' | 'createdAt' | 'startedAt' | 'finishedAt'>): number {
  const stopped = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';
  if (stopped && hasTime(task.finishedAt)) return task.finishedAt;
  if (hasTime(task.startedAt)) return task.startedAt;
  return task.createdAt;
}

/** «Сегодня» / «Вчера» / «3 дня назад» / «2 сентября» / «2 сентября 2025». */
export function formatTaskDay(at: number, now: number = Date.now()): string {
  const days = daysBetween(at, now);
  // Будущее бывает только от разъехавшихся часов — считаем его сегодняшним.
  if (days <= 0) return t('board.day.today');
  if (days === 1) return t('board.day.yesterday');
  if (days < RELATIVE_DAYS) return t('board.day.daysAgo', { n: days });
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale(), sameYear
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' }).format(at);
}

/** Задачи одного дня подряд и подпись над ними. */
export type TaskDayGroup<T> = { key: string; label: string; tasks: T[] };

/**
 * Режет список на отрезки одного дня, не меняя порядка: новый отрезок
 * начинается там, где день соседних задач сменился. Если порядок колонки
 * не по времени, один и тот же день может встретиться дважды — так честнее,
 * чем переставлять задачи ради подписей. Ключ поэтому с номером отрезка.
 */
export function splitTasksByDay<T extends Pick<TaskView, 'status' | 'createdAt' | 'startedAt' | 'finishedAt'>>(
  list: T[],
  now: number = Date.now(),
): TaskDayGroup<T>[] {
  const out: TaskDayGroup<T>[] = [];
  let lastDay: number | null = null;
  for (const task of list) {
    const at = taskDayTime(task);
    const day = startOfDay(at);
    if (day !== lastDay || out.length === 0) {
      out.push({ key: `${day}-${out.length}`, label: formatTaskDay(at, now), tasks: [] });
      lastDay = day;
    }
    out[out.length - 1].tasks.push(task);
  }
  return out;
}
