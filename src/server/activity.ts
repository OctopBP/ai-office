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
import type { ChatEntry, LogEntry, OfficeActivity, OwnerQuestion, TaskStatus, Usage } from '../shared/types';
import { dayKey, emptyUsage } from '../shared/types';
import { isOpenQuestion } from '../shared/questions';
import { countDoneUnmerged, countInWork } from '../shared/work';
import { c } from './i18n';

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
  /** Расход офиса за всё время и по дням — то же, что лежит в сохранении. */
  usage?: Usage;
  daily?: Record<string, Usage>;
  /** Вопросы владельцу — ради счётчика открытых в списке офисов. */
  questions?: Pick<OwnerQuestion, 'answeredAt' | 'dismissedAt' | 'mergedInto'>[];
}

export const emptyActivity = (): OfficeActivity => ({
  inProgress: 0, doneUnmerged: 0, lastEventAt: null, usage: emptyUsage(), today: emptyUsage(),
  // Живые сессии и запросы доступа есть только у поднятого офиса, а по файлу
  // их не увидеть: они умирают вместе с процессом и на диск не попадают.
  live: false,
  waiting: 0,
  // Пауза в файле состояния не лежит — она хранится в реестре офисов
  // (`OfficeEntry.paused`), и проставляет её тот, у кого реестр под рукой
  // (state.ts → officeViews). Здесь честнее «не на паузе», чем догадка.
  paused: false,
});

/** Даже позже нуля: 0 и null здесь одинаково значат «времени нет». */
const later = (a: number | null, b: number | null | undefined): number | null =>
  (b && (!a || b > a) ? b : a);

/** Сводка по уже разобранному состоянию — общая для памяти и для диска. */
export function summarize(state: StateLike): OfficeActivity {
  const result = emptyActivity();
  // Правило подсчёта общее с вебом (shared/work.ts): у активного офиса клиент
  // считает по тому же правилу, и число не зависит от выбора офиса.
  result.inProgress = countInWork(state.tasks ?? []);
  result.doneUnmerged = countDoneUnmerged(state.tasks ?? []);
  for (const t of state.tasks ?? []) {
    result.lastEventAt = later(result.lastEventAt, t.finishedAt);
    result.lastEventAt = later(result.lastEventAt, t.startedAt);
    result.lastEventAt = later(result.lastEventAt, t.createdAt);
  }
  // Ленты дописываются в хвост, поэтому смотрим только последнюю запись.
  result.lastEventAt = later(result.lastEventAt, state.chat?.[state.chat.length - 1]?.at);
  result.lastEventAt = later(result.lastEventAt, state.log?.[state.log.length - 1]?.at);
  // Расход берём из журнала офиса, а не пересчитываем по задачам: сумма по
  // задачам не знает ни разговоров с менеджером, ни совещаний, ни ревью —
  // а платили за них тоже.
  result.usage = { ...emptyUsage(), ...(state.usage ?? {}) };
  result.today = { ...emptyUsage(), ...(state.daily?.[dayKey()] ?? {}) };
  return result;
}

/** Не чаще раза в столько же и файл не статим — список офисов не новостная лента. */
const RECHECK_MS = 3000;

interface Cached {
  /** Когда последний раз ходили на диск за этим файлом. */
  checkedAt: number;
  mtimeMs: number;
  size: number;
  /**
   * На какой день считали. Файл офиса, в котором со вчера ничего не делали,
   * не менялся — и без этой отметки его вчерашний расход так и висел бы
   * в списке как сегодняшний.
   */
  day: string;
  activity: OfficeActivity;
  /** Открытые вопросы владельцу — читаются тем же проходом по файлу. */
  openQuestions: number;
}

const cache = new Map<string, Cached>();

/**
 * Сколько вопросов владельцу ещё ждут ответа. Правило «открыт» общее с вебом
 * и снапшотом (`isOpenQuestion`): отвеченный, снятый и влитый в другой вопрос
 * не считается — иначе метка в списке офисов расходилась бы со значком внутри.
 */
export function countOpenQuestions(questions: StateLike['questions']): number {
  let n = 0;
  for (const q of questions ?? []) if (q && isOpenQuestion(q as OwnerQuestion)) n += 1;
  return n;
}

/**
 * Сводка по файлу состояния офиса. Файла нет или он битый — отдаём нули:
 * из-за одной цифры список офисов падать не должен.
 */
export function activityFromFile(stateFile: string): OfficeActivity {
  return readFileSummary(stateFile).activity;
}

/**
 * Открытые вопросы владельцу неподнятого офиса — по его файлу состояния, без
 * подъёма офиса и агентов. Кеш общий со сводкой активности: файл читается
 * один раз на оба числа.
 */
export function openQuestionsFromFile(stateFile: string): number {
  return readFileSummary(stateFile).openQuestions;
}

function readFileSummary(stateFile: string): Cached {
  const now = Date.now();
  const day = dayKey(now);
  const hit = cache.get(stateFile);
  if (hit && hit.day === day && now - hit.checkedAt < RECHECK_MS) return hit;

  let mtimeMs = 0;
  let size = 0;
  try {
    const st = statSync(stateFile);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    // Офис ни разу не открывали — сохранять было нечего.
    const entry: Cached = { checkedAt: now, mtimeMs: 0, size: 0, day, activity: emptyActivity(), openQuestions: 0 };
    cache.set(stateFile, entry);
    return entry;
  }

  if (hit && hit.day === day && hit.mtimeMs === mtimeMs && hit.size === size) {
    hit.checkedAt = now;
    return hit;
  }

  let activity = emptyActivity();
  let openQuestions = 0;
  try {
    const data = JSON.parse(readFileSync(stateFile, 'utf8')) as StateLike;
    // Файл мог быть дописан наполовину или отредактирован руками.
    activity = summarize({
      tasks: Array.isArray(data?.tasks) ? data.tasks : [],
      chat: Array.isArray(data?.chat) ? data.chat : [],
      log: Array.isArray(data?.log) ? data.log : [],
      usage: data?.usage,
      daily: data?.daily,
    });
    openQuestions = countOpenQuestions(Array.isArray(data?.questions) ? data.questions : []);
  } catch (err) {
    console.log(c('activity.summaryFailed', { file: stateFile, error: (err as Error).message }));
  }
  const entry: Cached = { checkedAt: now, mtimeMs, size, day, activity, openQuestions };
  cache.set(stateFile, entry);
  return entry;
}
