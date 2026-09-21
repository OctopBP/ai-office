import { PROVIDER_IDS, type ProviderId } from '../shared/providers';
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
import { LANG_LOCALE, type Lang } from '../shared/i18n';
import { DEFAULT_STATE_FILE } from './store';

/**
 * Файл рядом с состоянием офисов, а не внутри него: лимит общий, а состояний
 * столько же, сколько офисов. Путь берётся от файла по умолчанию — тестовый
 * сервер уводит `OFFICE_STATE_FILE` в свою папку и вместе с ним уносит и это.
 */


const SAVE_DEBOUNCE_MS = 2000;

/** То, что SDK кладёт в `rate_limit_event.rate_limit_info`. */
export interface RateLimitInfo {
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

/**
 * Ответ управляющего вызова SDK за полной картиной лимитов — то же, что
 * показывает `/usage`. Описан здесь своим типом, а не импортом из SDK: вызов
 * помечен экспериментальным, и когда он поменяется, чинить придётся ровно эти
 * несколько полей, а не всё, что их читает.
 */
export interface UsageReport {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<string, unknown> | null;
}

/** Живая сессия, у которой можно спросить лимиты. */
export interface LimitSource {
  provider?: ProviderId;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<UsageReport>;
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
  plan?: string | null;
  updatedAt: number | null;
  windows: LimitWindow[];
  /** Отказ по лимиту, если он был последним словом SDK. В старом кеше поля нет. */
  rejection?: Rejection | null;
}

/**
 * Отказ по лимиту: SDK отбил запрос, и до сброса окна пробовать бессмысленно.
 * Запоминается отдельно от шкал, потому что шкалы — про проценты, а здесь
 * важен факт и время: по нему офис решает, когда возвращаться к работе.
 */
export interface Rejection {
  /** Когда отбили. */
  at: number;
  /** Когда окно обнулится. null — SDK не сказал, и узнать можно только пробуя. */
  resetsAt: number | null;
}

/**
 * Ключи в ответе `/usage` — те же слова, что и типы окон в событиях, кроме
 * одного: у пятичасового окна в событии `five_hour`, и здесь `five_hour`.
 * Совпадение проверяется этим списком, а не догадкой по имени: лишний ключ
 * ответа (например `extra_usage`, устроенный совсем иначе) не должен
 * превратиться в шкалу с непонятной подписью.
 */
const REPORT_KINDS: LimitKind[] = [
  'codex_primary', 'codex_secondary',
  'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps',
];

/** Как часто спрашиваем полную картину: чаще раза в минуту она не меняется. */
const POLL_EVERY_MS = 60_000;

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

export function createLimitTracker(provider: ProviderId) {
const FILE = resolve(dirname(DEFAULT_STATE_FILE), provider === 'claude-code' ? 'limits.json' : `limits-${provider}.json`);
const windows = new Map<LimitKind, LimitWindow>();
let status: LimitsView['status'] = null;
let rejection: Rejection | null = null;
let plan: string | null = null;
let updatedAt: number | null = null;
let loaded = false;
let timer: NodeJS.Timeout | null = null;
let polledAt = 0;

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
    plan = data.plan ?? null;
    updatedAt = data.updatedAt ?? null;
    rejection = data.rejection ?? null;
  } catch {
    // Кеш шкалы, а не состояние офиса: битый файл дешевле забыть, чем чинить.
  }
}

function saveSoon(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const data: Stored = {
      version: 2, status, plan, updatedAt, windows: [...windows.values()], rejection,
    };
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
function noteRateLimit(info: RateLimitInfo): boolean {
  if (!loaded) load();
  const now = Date.now();
  let changed = false;

  const next = info.status ?? null;
  if (next !== null && next !== status) { status = next; changed = true; }

  const resetsAt = typeof info.resetsAt === 'number' ? toMs(info.resetsAt) : null;

  // Тип окна SDK присылает не всегда: без него непонятно, какую именно шкалу
  // двигать, и молча приписать проценты пятичасовому окну — соврать.
  if (isKind(info.rateLimitType) && typeof info.utilization === 'number') {
    const kind = info.rateLimitType;
    const utilization = toPercent(info.utilization);
    const was = windows.get(kind);
    if (!was || was.utilization !== utilization || was.resetsAt !== resetsAt) changed = true;
    windows.set(kind, { kind, utilization, resetsAt, updatedAt: now });
  }

  // Отказ запоминаем вместе со временем сброса, а разрешённый запрос его
  // снимает: раз SDK снова пропускает, окно уже обнулилось — даже если срок
  // сброса, который он называл, ещё не наступил.
  if (next === 'rejected') {
    // Время сброса из самого события; его нет — из шкалы того же окна.
    const known = resetsAt ?? (isKind(info.rateLimitType) ? windows.get(info.rateLimitType)?.resetsAt : null) ?? null;
    if (!rejection || rejection.resetsAt !== known) changed = true;
    rejection = { at: rejection?.at ?? now, resetsAt: known };
  } else if (next !== null && rejection) {
    rejection = null;
    changed = true;
  }

  // Само событие — уже факт: лимиты плана к этому аккаунту применимы. Даже
  // если цифры в нём те же, «когда мы это слышали» стало другим.
  updatedAt = now;
  if (changed) saveSoon();
  return changed;
}

/**
 * Записать полную картину — ответ управляющего вызова SDK. Событие
 * `rate_limit_event` рассказывает только про то окно, в которое упираются
 * прямо сейчас: на подписке это почти всегда недельное, и пятичасовое из
 * событий можно не увидеть ни разу. Ответ `/usage` отдаёт сразу все окна,
 * поэтому пятичасовое берётся только отсюда.
 *
 * Проценты здесь задокументированы как 0–100, и долю от единицы к ним не
 * применяем: 0.5 в этом ответе — это полпроцента, а не половина окна.
 */
function noteUsageReport(report: UsageReport): boolean {
  if (!loaded) load();
  const now = Date.now();
  let changed = false;

  const nextPlan = report.subscription_type ?? null;
  if (nextPlan !== null && nextPlan !== plan) { plan = nextPlan; changed = true; }

  // Лимиты плана к этому аккаунту неприменимы — ключ API или облачный
  // провайдер. Ответ пришёл, но рассказывать в нём не о чем.
  const limits = report.rate_limits;
  if (report.rate_limits_available === false || !limits) return changed;

  for (const kind of REPORT_KINDS) {
    const raw = limits[kind] as { utilization?: number | null; resets_at?: string | null } | null;
    if (!raw || typeof raw.utilization !== 'number') continue;
    const utilization = Math.max(0, Math.min(100, raw.utilization));
    // Время сброса здесь строкой ISO 8601, а не числом: разбираем и молча
    // пропускаем то, что не разобралось, — окно без времени сброса лучше
    // окна со сбросом в 1970-м.
    const parsed = raw.resets_at ? Date.parse(raw.resets_at) : NaN;
    const resetsAt = Number.isFinite(parsed) ? parsed : null;
    const was = windows.get(kind);
    if (!was || was.utilization !== utilization || was.resetsAt !== resetsAt) changed = true;
    windows.set(kind, { kind, utilization, resetsAt, updatedAt: now });
  }

  updatedAt = now;
  if (changed) saveSoon();
  return changed;
}

/**
 * Спросить у живой сессии полную картину лимитов. Возвращает true, если
 * что-то изменилось и это стоит показать.
 *
 * Спрашиваем не чаще раза в минуту и только на живой сессии: поднимать
 * сессию ради шкалы означало бы тратить лимит, чтобы на него посмотреть, —
 * поэтому вопрос задаётся попутно, когда сессия и так заведена.
 */
async function pollLimits(session: LimitSource): Promise<boolean> {
  const now = Date.now();
  if (now - polledAt < POLL_EVERY_MS) return false;
  polledAt = now;
  try {
    return noteUsageReport(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET());
  } catch {
    // Вызов помечен экспериментальным и на чужих провайдерах его может не
    // быть вовсе. Молчим: шкала останется на цифрах из событий, а офис за
    // это падать не должен.
    return false;
  }
}

/**
 * Упирается ли офис в лимит прямо сейчас: последний ответ SDK был отказом, а
 * окно ещё не обнулилось. Время сброса SDK называет сам; не назвал — считаем,
 * что упираемся, пока не докажем обратное пробой (см. supervisor.ts).
 *
 * Сброс по часам верим на слово: свежих событий после него ещё нет — они
 * появятся только с первым же запросом, а его-то и надо решиться сделать.
 */
function limitBlock(now = Date.now()): Rejection | null {
  if (!loaded) load();
  if (!rejection) return null;
  if (rejection.resetsAt !== null && rejection.resetsAt <= now) return null;
  return rejection;
}

/** Что показывать в интерфейсе. Порядок окон — от самого короткого. */
function limitsView(): LimitsView {
  if (!loaded) load();
  if (updatedAt === null) return emptyLimits();
  return {
    available: true,
    windows: LIMIT_ORDER.map((k) => windows.get(k)).filter((w): w is LimitWindow => Boolean(w)),
    status,
    plan,
    updatedAt,
  };
}

/** Забыть всё — только для тестов, чтобы прогон не зависел от чужого файла. */
function forgetLimits(): void {
  windows.clear();
  status = null;
  rejection = null;
  plan = null;
  updatedAt = null;
  polledAt = 0;
  loaded = true;
}

return { noteRateLimit, noteUsageReport, pollLimits, limitBlock, limitsView, forgetLimits };
}

/**
 * Время сброса словами на языке офиса. Недельное окно обнуляется через дни,
 * пятичасовое — через часы: дата показывается, только если сброс не сегодня.
 */
export function resetClock(resetsAt: number, lang: Lang, now = Date.now()): string {
  const locale = LANG_LOCALE[lang];
  const sameDay = new Date(resetsAt).toDateString() === new Date(now).toDateString();
  return new Date(resetsAt).toLocaleString(locale, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const trackers = Object.fromEntries(PROVIDER_IDS.map(id => [id, createLimitTracker(id)])) as Record<ProviderId, ReturnType<typeof createLimitTracker>>;
export const noteRateLimit = (info: RateLimitInfo, provider: ProviderId = 'claude-code') => trackers[provider].noteRateLimit(info);
export const noteUsageReport = (info: UsageReport, provider: ProviderId = 'claude-code') => trackers[provider].noteUsageReport(info);
export const pollLimits = (session: LimitSource) => trackers[session.provider ?? 'claude-code'].pollLimits(session);
export const limitBlock = (now = Date.now(), provider: ProviderId = 'claude-code') => trackers[provider].limitBlock(now);
export const forgetLimits = () => { for (const tracker of Object.values(trackers)) tracker.forgetLimits(); };
export function limitsView(provider?: ProviderId): LimitsView {
  if (provider) return trackers[provider].limitsView();
  const views = PROVIDER_IDS.map(id => ({ id, view: trackers[id].limitsView() }));
  const known = views.filter(v => v.view.available);
  if (!known.length) return emptyLimits();
  if (known.length === 1 && known[0].id === 'claude-code') return known[0].view;
  return { available: true, windows: known.flatMap(({id,view}) => view.windows.map(w => ({ ...w, provider: id }))),
    status: known.some(v => v.view.status === 'rejected') ? 'rejected' : null,
    plan: null, updatedAt: Math.max(...known.map(v => v.view.updatedAt ?? 0)) };
}
