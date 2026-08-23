/**
 * Сводка активности офиса для списка офисов.
 *
 * В памяти живут только открытые офисы, а в списке видно все. Про остальные
 * читаем их файл состояния — этого хватает на пару счётчиков и не требует
 * поднимать чужой офис и его агентов. Чтение кэшируется по времени
 * модификации файла: список офисов уходит клиенту на каждое изменение
 * реестра, и лезть за этим на диск каждый раз незачем.
 */
import { readFileSync, statSync } from 'node:fs';
import type { ChatEntry, LogEntry, OfficeActivity, TaskStatus } from '../shared/types';

/**
 * Что сводке нужно от задачи. Структурный тип вместо импорта `Task` из
 * state.ts: state.ts сам зовёт этот модуль, и кольца из импортов не хочется.
 */
interface TaskLike {
  status: TaskStatus;
  branch?: string | null;
  merged?: boolean;
  createdAt?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
}

interface StateLike {
  tasks?: TaskLike[];
  chat?: Pick<ChatEntry, 'at'>[];
  log?: Pick<LogEntry, 'at'>[];
}

/** Пока задача в этих статусах, она числится за исполнителем. */
const IN_WORK: TaskStatus[] = ['assigned', 'in_progress', 'review'];

export const emptyActivity = (): OfficeActivity => ({
  inProgress: 0, doneUnmerged: 0, lastEventAt: null,
  // Живые сессии и запросы доступа есть только у поднятого офиса, а по файлу
  // их не увидеть: они умирают вместе с процессом и на диск не попадают.
  live: false,
  waiting: 0,
});

/** Даже позже нуля: 0 и null здесь одинаково значат «времени нет». */
const later = (a: number | null, b: number | null | undefined): number | null =>
  (b && (!a || b > a) ? b : a);

/** Сводка по уже разобранному состоянию — общая для памяти и для диска. */
export function summarize(state: StateLike): OfficeActivity {
  const result = emptyActivity();
  for (const t of state.tasks ?? []) {
    if (IN_WORK.includes(t.status)) result.inProgress += 1;
    // Ветка без слияния — единственный признак незабранной работы:
    // задачи без своей ветки сливать нечего.
    else if (t.status === 'done' && t.branch && !t.merged) result.doneUnmerged += 1;
    result.lastEventAt = later(result.lastEventAt, t.finishedAt);
    result.lastEventAt = later(result.lastEventAt, t.startedAt);
    result.lastEventAt = later(result.lastEventAt, t.createdAt);
  }
  // Ленты дописываются в хвост, поэтому смотрим только последнюю запись.
  result.lastEventAt = later(result.lastEventAt, state.chat?.[state.chat.length - 1]?.at);
  result.lastEventAt = later(result.lastEventAt, state.log?.[state.log.length - 1]?.at);
  return result;
}

/** Не чаще раза в столько же и файл не статим — список офисов не новостная лента. */
const RECHECK_MS = 3000;

interface Cached {
  /** Когда последний раз ходили на диск за этим файлом. */
  checkedAt: number;
  mtimeMs: number;
  size: number;
  activity: OfficeActivity;
}

const cache = new Map<string, Cached>();

/**
 * Сводка по файлу состояния офиса. Файла нет или он битый — отдаём нули:
 * из-за одной цифры список офисов падать не должен.
 */
export function activityFromFile(stateFile: string): OfficeActivity {
  const now = Date.now();
  const hit = cache.get(stateFile);
  if (hit && now - hit.checkedAt < RECHECK_MS) return hit.activity;

  let mtimeMs = 0;
  let size = 0;
  try {
    const st = statSync(stateFile);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    // Офис ни разу не открывали — сохранять было нечего.
    const activity = emptyActivity();
    cache.set(stateFile, { checkedAt: now, mtimeMs: 0, size: 0, activity });
    return activity;
  }

  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
    hit.checkedAt = now;
    return hit.activity;
  }

  let activity = emptyActivity();
  try {
    const data = JSON.parse(readFileSync(stateFile, 'utf8')) as StateLike;
    // Файл мог быть дописан наполовину или отредактирован руками.
    activity = summarize({
      tasks: Array.isArray(data?.tasks) ? data.tasks : [],
      chat: Array.isArray(data?.chat) ? data.chat : [],
      log: Array.isArray(data?.log) ? data.log : [],
    });
  } catch (err) {
    console.log(`⚠️  Сводка офиса ${stateFile} не посчиталась: ${(err as Error).message}`);
  }
  cache.set(stateFile, { checkedAt: now, mtimeMs, size, activity });
  return activity;
}
