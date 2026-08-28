/**
 * Лимиты плана подписки — второй потолок офиса помимо денег.
 *
 * Считает их не офис: цифры приезжают событиями `rate_limit_event` из SDK
 * (см. `agents.ts`), то есть появляются только когда кто-то работает. Свои
 * запросы за ними офис не делает — у SDK для этого есть только
 * экспериментальный вызов на живой сессии, а поднимать сессию ради шкалы
 * означало бы тратить лимит, чтобы посмотреть на лимит.
 *
 * Хранилище одно на процесс, а не на офис: лимит принадлежит аккаунту, и в
 * двух открытых офисах он один и тот же. Держать его в состоянии офиса
 * значило бы показывать в каждом свою копию — ту, которой повезло обновиться
 * последней.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LimitKind, LimitsView, LimitWindow } from '../shared/types';
import { emptyLimits, LIMIT_ORDER } from '../shared/types';
import { DEFAULT_STATE_FILE } from './store';

/**
 * Файл рядом с состоянием офисов, а не внутри него: лимит общий, а состояний
 * столько же, сколько офисов. Путь берётся от файла по умолчанию — тестовый
 * сервер уводит `OFFICE_STATE_FILE` в свою папку и вместе с ним уносит и это.
 */
const FILE = resolve(dirname(DEFAULT_STATE_FILE), 'limits.json');

const SAVE_DEBOUNCE_MS = 2000;

/** То, что SDK кладёт в `rate_limit_event.rate_limit_info`. */
export interface RateLimitInfo {
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

interface Stored {
  /**
   * Версия 2 — с долями, переведёнными в проценты. Кеш первой версии писался
   * до того, как выяснилось, в каких единицах SDK шлёт долю окна, и 0.81
   * лежит в нём как 0.81%. Читать такое нельзя, а чинить незачем: файл — кеш,
   * и следующая же сессия наполнит его заново.
   */
  version: 2;
  status: LimitsView['status'];
  updatedAt: number | null;
  windows: LimitWindow[];
}

const isKind = (v: unknown): v is LimitKind =>
  typeof v === 'string' && (LIMIT_ORDER as string[]).includes(v);

/**
 * SDK объявляет `resetsAt` просто числом, а приходить оно может и в секундах,
 * и в миллисекундах. Секунды от миллисекунд отличаем по порядку величины:
 * 1e12 миллисекунд — это 2001 год, а 1e12 секунд — 33 тысячелетие, так что
 * ниже границы это заведомо секунды.
 */
const toMs = (v: number): number => (v < 1e12 ? Math.round(v * 1000) : Math.round(v));

/**
 * Долю окна SDK шлёт числом от нуля до единицы: в живом событии рядом со
 * статусом `allowed_warning` пришло `utilization: 0.81` — это 81%, а порог
 * предупреждения стоит на 0.8. Но соседний, документированный вызов SDK за
 * теми же цифрами отдаёт их уже процентами, 0–100, и чтобы шкала пережила
 * такую замену, оба вида принимаем разом: до единицы включительно — доля,
 * выше — уже проценты.
 */
const toPercent = (v: number): number =>
  Math.max(0, Math.min(100, v <= 1 ? v * 100 : v));

const windows = new Map<LimitKind, LimitWindow>();
let status: LimitsView['status'] = null;
let updatedAt: number | null = null;
let loaded = false;
let timer: NodeJS.Timeout | null = null;

function load(): void {
  loaded = true;
  if (!existsSync(FILE)) return;
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8')) as Stored;
    if (data.version !== 2) return;
    for (const w of data.windows ?? []) {
      if (isKind(w.kind)) windows.set(w.kind, w);
    }
    status = data.status ?? null;
    updatedAt = data.updatedAt ?? null;
  } catch {
    // Кеш шкалы, а не состояние офиса: битый файл дешевле забыть, чем чинить.
  }
}

function saveSoon(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const data: Stored = { version: 2, status, updatedAt, windows: [...windows.values()] };
    try {
      mkdirSync(dirname(FILE), { recursive: true });
      const tmp = `${FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, FILE);
    } catch {
      // Не доехало до диска — переживём: после перезапуска шкала просто
      // подождёт первой сессии, ради этого падать офису незачем.
    }
  }, SAVE_DEBOUNCE_MS);
  // Незавершённая запись не должна держать процесс живым при выключении.
  timer.unref?.();
}

/**
 * Записать то, что SDK рассказал про лимит. Возвращает true, если картинка
 * изменилась, — по этому признаку офис решает, слать ли событие в UI: события
 * приходят на каждый ответ модели, а меняются цифры куда реже.
 */
export function noteRateLimit(info: RateLimitInfo): boolean {
  if (!loaded) load();
  const now = Date.now();
  let changed = false;

  const next = info.status ?? null;
  if (next !== null && next !== status) { status = next; changed = true; }

  // Тип окна SDK присылает не всегда: без него непонятно, какую именно шкалу
  // двигать, и молча приписать проценты пятичасовому окну — соврать.
  if (isKind(info.rateLimitType) && typeof info.utilization === 'number') {
    const kind = info.rateLimitType;
    const utilization = toPercent(info.utilization);
    const resetsAt = typeof info.resetsAt === 'number' ? toMs(info.resetsAt) : null;
    const was = windows.get(kind);
    if (!was || was.utilization !== utilization || was.resetsAt !== resetsAt) changed = true;
    windows.set(kind, { kind, utilization, resetsAt, updatedAt: now });
  }

  // Само событие — уже факт: лимиты плана к этому аккаунту применимы. Даже
  // если цифры в нём те же, «когда мы это слышали» стало другим.
  updatedAt = now;
  if (changed) saveSoon();
  return changed;
}

/** Что показывать в интерфейсе. Порядок окон — от самого короткого. */
export function limitsView(): LimitsView {
  if (!loaded) load();
  if (updatedAt === null) return emptyLimits();
  return {
    available: true,
    windows: LIMIT_ORDER.map((k) => windows.get(k)).filter((w): w is LimitWindow => Boolean(w)),
    status,
    updatedAt,
  };
}

/** Забыть всё — только для тестов, чтобы прогон не зависел от чужого файла. */
export function forgetLimits(): void {
  windows.clear();
  status = null;
  updatedAt = null;
  loaded = true;
}
