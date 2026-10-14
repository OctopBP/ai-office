/**
 * Вердикт свежести записи журнала: чистый модуль без сессий и состояния.
 *
 * Стареющая запись (давно не подтверждалась) получает план проверки:
 * решение владельца уходит владельцу — офис его сам не отменяет; факт и урок
 * офис проверяет сам, и план подсказывает, где смотреть: файлы и символы из
 * текста, задачи T-N, записи J-N.
 *
 * Вердикты агента проверки сводятся в итог тем же правилом, что в разборе
 * противоречий (contradictions.ts → decideContradiction): «устарела» без
 * проверяемого основания ничего не закрывает и считается «не знаю».
 */
import type { FactKind } from '../shared/types';

const DAY = 24 * 60 * 60 * 1000;

/** Стареющая запись журнала — то, что нужно для плана проверки. */
export interface AgingFact {
  /** Id записи (J-N): чтобы не подсказывать проверять запись по ней самой. */
  id?: string;
  kind: FactKind;
  scope: string;
  text: string;
  /** Задача, из которой запись пришла. */
  taskId?: string;
  /** Когда запись подтверждалась последний раз, мс. */
  confirmedAt: number;
}

/** Кто проверяет: владелец или сам офис. */
export type StalenessRoute = 'owner' | 'self';

/** Где проверять запись. */
export interface StalenessHints {
  /** Пути к файлам из текста: src/server/journal.ts, package.json. */
  files: string[];
  /** Символы кода: имена функций, типов, полей. */
  symbols: string[];
  /** Задачи T-N: из текста и задача-источник. */
  tasks: string[];
  /** Другие записи журнала J-N. */
  facts: string[];
}

export interface StalenessPlan {
  route: StalenessRoute;
  /** Сколько полных дней запись не подтверждалась. */
  ageDays: number;
  /** Подсказки для самопроверки; у плана владельцу — пустые. */
  hints: StalenessHints;
}

/** Расширения, по которым слово в тексте считается путём к файлу. */
const FILE_EXT = 'tsx?|jsx?|mjs|cjs|mts|json|md|css|html|py|sh|ya?ml|toml|lock';
const FILE_RE = new RegExp(`(?:[\\w.@-]+/)*[\\w.@-]+\\.(?:${FILE_EXT})\\b`, 'g');
const TASK_RE = /\bT-\d+\b/g;
const FACT_RE = /\bJ-\d+\b/g;
/** Имя в обратных кавычках: `limitBlock`, `Release.stop`. */
const QUOTED_RE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?`/g;
/** Вызов: decideContradiction(), Release.stop(). */
const CALL_RE = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\)/g;
/** Имя со смешанным регистром: camelCase, PascalCase с горбом, SCREAMING_SNAKE. */
const IDENT_RE = /\b(?:[a-z]+[A-Z][\w$]*|[A-Z][a-z0-9]+[A-Z][\w$]*|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g;

function uniq(items: Iterable<string>): string[] {
  return [...new Set(items)];
}

/** Подсказки для самопроверки: что из текста можно найти в коде и журнале. */
export function stalenessHints(fact: Pick<AgingFact, 'id' | 'text' | 'taskId'>): StalenessHints {
  const text = fact.text;
  const files = uniq(text.match(FILE_RE) ?? []);
  // Имена внутри путей (journal.ts → journal) символами не считаем.
  const inFiles = new Set(files.flatMap(f => f.split(/[/.]/)));
  const symbols = uniq([
    ...[...text.matchAll(QUOTED_RE)].map(m => m[1]),
    ...[...text.matchAll(CALL_RE)].map(m => m[1]),
    ...(text.match(IDENT_RE) ?? []),
  ]).filter(s => !inFiles.has(s) && !files.includes(s));
  const tasks = uniq([...(fact.taskId ? [fact.taskId] : []), ...(text.match(TASK_RE) ?? [])]);
  const facts = uniq(text.match(FACT_RE) ?? []).filter(id => id !== fact.id);
  return { files, symbols, tasks, facts };
}

/**
 * План проверки стареющей записи. Решение — всегда владельцу, без подсказок:
 * отменить решение может только он. Факт и урок — на самопроверку с
 * подсказками. Остальные виды (запись-противоречие) тоже владельцу: у них нет
 * одного утверждения, которое можно проверить по коду.
 */
export function planStalenessCheck(fact: AgingFact, now = Date.now()): StalenessPlan {
  const ageDays = Math.max(0, Math.floor((now - fact.confirmedAt) / DAY));
  if (fact.kind === 'fact' || fact.kind === 'lesson') {
    return { route: 'self', ageDays, hints: stalenessHints(fact) };
  }
  return { route: 'owner', ageDays, hints: { files: [], symbols: [], tasks: [], facts: [] } };
}

/** Вердикт агента проверки по одной записи. */
export type FreshnessVerdictKind = 'stale' | 'actual' | 'unknown';

/**
 * Проверяемое основание вердикта:
 * - code — файл или символ в коде (ref: путь или путь:символ);
 * - git — коммит или история (ref: хеш или ссылка);
 * - task — влитая задача (ref: T-N);
 * - newer — более новая запись журнала (ref: J-N).
 */
export type FreshnessBasisKind = 'code' | 'git' | 'task' | 'newer';

export interface FreshnessBasis {
  kind: FreshnessBasisKind;
  ref: string;
}

export interface FreshnessVerdict {
  /** Id проверенной записи. */
  factId: string;
  verdict: FreshnessVerdictKind;
  reason: string;
  basis?: FreshnessBasis;
}

/** Основание можно проверить: вид известен, ссылка по форме подходит к виду. */
export function isVerifiableBasis(basis: FreshnessBasis | undefined, factId?: string): boolean {
  if (!basis || typeof basis.ref !== 'string') return false;
  const ref = basis.ref.trim();
  if (!ref) return false;
  switch (basis.kind) {
    case 'code': return true;
    case 'git': return true;
    case 'task': return /^T-\d+$/.test(ref);
    // Запись не может устареть «по самой себе».
    case 'newer': return /^J-\d+$/.test(ref) && ref !== factId;
    default: return false;
  }
}

/** Итог по одной записи. */
export interface FreshnessOutcome {
  factId: string;
  verdict: FreshnessVerdictKind;
  reason: string;
  basis?: FreshnessBasis;
  /** «Устарела» понижена до «не знаю»: основания нет или его не проверить. */
  downgraded?: boolean;
  /** По записи пришли «устарела» и «актуальна» сразу — итог «не знаю». */
  conflict?: boolean;
}

export interface FreshnessSummary {
  /** Итог по каждой записи, в порядке первого упоминания. */
  outcomes: FreshnessOutcome[];
  counts: Record<FreshnessVerdictKind, number>;
  /** Записи, где «устарела» понижена до «не знаю». */
  downgraded: string[];
}

/** Один вердикт после правила об основании. */
export function normalizeVerdict(v: FreshnessVerdict): FreshnessOutcome {
  if (v.verdict === 'stale' && !isVerifiableBasis(v.basis, v.factId)) {
    return { factId: v.factId, verdict: 'unknown', reason: v.reason, basis: v.basis, downgraded: true };
  }
  return { factId: v.factId, verdict: v.verdict, reason: v.reason, ...(v.basis ? { basis: v.basis } : {}) };
}

/**
 * Свести вердикты агента в итог. Вердиктов по одной записи может быть
 * несколько (повторный проход, несколько проверок): «устарела» с основанием
 * и «актуальна» вместе дают «не знаю» — забыть запись по спорному выводу
 * хуже, чем оставить её ещё на круг. Иначе побеждает определённый вердикт.
 */
export function summarizeVerdicts(verdicts: FreshnessVerdict[]): FreshnessSummary {
  const byFact = new Map<string, FreshnessOutcome[]>();
  for (const v of verdicts) {
    const list = byFact.get(v.factId) ?? [];
    list.push(normalizeVerdict(v));
    byFact.set(v.factId, list);
  }
  const outcomes: FreshnessOutcome[] = [];
  for (const [factId, list] of byFact) {
    const stale = list.find(o => o.verdict === 'stale');
    const actual = list.find(o => o.verdict === 'actual');
    const downgraded = list.some(o => o.downgraded);
    if (stale && actual) {
      outcomes.push({
        factId, verdict: 'unknown', reason: `${stale.reason} / ${actual.reason}`, conflict: true,
        ...(downgraded ? { downgraded } : {}),
      });
    } else if (stale || actual) {
      outcomes.push((stale ?? actual)!);
    } else {
      outcomes.push(list[0]);
    }
  }
  const counts: Record<FreshnessVerdictKind, number> = { stale: 0, actual: 0, unknown: 0 };
  for (const o of outcomes) counts[o.verdict]++;
  return {
    outcomes,
    counts,
    downgraded: [...byFact].filter(([, list]) => list.some(o => o.downgraded)).map(([id]) => id),
  };
}

const VERDICT_KINDS: ReadonlySet<string> = new Set(['stale', 'actual', 'unknown']);
const BASIS_KINDS: ReadonlySet<string> = new Set(['code', 'git', 'task', 'newer']);

/**
 * Вердикты из ответа агента проверки. Ждём JSON `{"verdicts":[…]}` или голый
 * массив; текст вокруг допустим. Неразборчивый ответ — пустой список: записи
 * без вердикта вызывающий считает «не знаю» и откладывает.
 */
export function parseFreshnessVerdicts(text: string): FreshnessVerdict[] {
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const isArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart);
  const start = isArray ? arrStart : objStart;
  const end = text.lastIndexOf(isArray ? ']' : '}');
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(list)) return [];
  const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
  const out: FreshnessVerdict[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const factId = str(v.factId) || str(v.id);
    const verdict = str(v.verdict);
    if (!/^J-\d+$/.test(factId) || !VERDICT_KINDS.has(verdict)) continue;
    const one: FreshnessVerdict = { factId, verdict: verdict as FreshnessVerdictKind, reason: str(v.reason) };
    const b = v.basis as Record<string, unknown> | undefined;
    if (b && typeof b === 'object' && BASIS_KINDS.has(str(b.kind)) && str(b.ref)) {
      one.basis = { kind: str(b.kind) as FreshnessBasisKind, ref: str(b.ref) };
    }
    out.push(one);
  }
  return out;
}

/* ── Память проверенных записей ─────────────────────────────────────────── */

/** Сколько записей помнить: архивные и стёртые вычищаются, это — предохранитель. */
export const FRESHNESS_KEPT = 1000;

export interface FreshnessMark {
  /** Отпечаток записи на момент разбора: вид и текст. */
  sig: string;
  at: number;
}

/** Где лежит память: LifeState.freshnessChecked, ключ — id записи. */
export interface FreshnessHolder {
  freshnessChecked: Record<string, FreshnessMark>;
}

/**
 * Отпечаток записи: вид и текст. Дата подтверждения в него не входит —
 * «изменили» значит переписали, а не просто подтвердили задачей.
 */
export function freshnessSig(fact: { kind: string; text: string }): string {
  // FNV-1a: короткий и стабильный, криптостойкость здесь не нужна.
  let h = 0x811c9dc5;
  const s = `${fact.kind}\u0000${fact.text.trim()}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Запись уже разобрана и с тех пор не менялась — второй раз её не поднимаем. */
export function isFreshnessChecked(holder: FreshnessHolder, fact: { id: string; kind: string; text: string }): boolean {
  const mark = holder.freshnessChecked?.[fact.id];
  return Boolean(mark) && mark!.sig === freshnessSig(fact);
}

/**
 * Запомнить запись разобранной. Правит holder на месте; записать на диск —
 * забота вызывающего (state.touchLife()).
 */
export function markFreshnessChecked(
  holder: FreshnessHolder, fact: { id: string; kind: string; text: string }, now = Date.now(),
): void {
  const marks = holder.freshnessChecked ?? (holder.freshnessChecked = {});
  marks[fact.id] = { sig: freshnessSig(fact), at: now };
  const keys = Object.keys(marks);
  if (keys.length <= FRESHNESS_KEPT) return;
  keys.sort((x, y) => marks[x].at - marks[y].at);
  for (const key of keys.slice(0, keys.length - FRESHNESS_KEPT)) delete marks[key];
}

/** Забыть отметки записей, которых в живом журнале больше нет. */
export function pruneFreshness(holder: FreshnessHolder, alive: (id: string) => boolean): void {
  const marks = holder.freshnessChecked ?? {};
  for (const id of Object.keys(marks)) if (!alive(id)) delete marks[id];
}
