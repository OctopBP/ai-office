/**
 * Разбор противоречий в журнале офиса: прежде чем спрашивать владельца, офис
 * пробует разобраться сам — по коду, git и доске (решение из журнала: владельца
 * спрашивают, только когда разобраться не вышло или когда сталкиваются два его
 * собственных решения).
 *
 * Здесь только чистая логика без ввода-вывода: задание агенту разбора, разбор
 * его ответа, решение «закрыть самим или спросить» и память разобранных пар.
 * Сессию агента запускает и журнал правит ритуал.
 */
import type { FactView } from '../shared/types';
import type { Lang } from '../shared/i18n';
import { t } from './i18n';

/** Что агент разбора выяснил о паре записей. */
export type ContradictionVerdict =
  /** Одна запись устарела: её забыть, другую оставить. */
  | { kind: 'stale'; keepId: string; forgetId: string; reason: string }
  /** Противоречия нет: записи про разные контексты и верны обе. */
  | { kind: 'compatible'; reason: string }
  /** Разобраться не вышло. lean — к чему склоняется агент, options — варианты для владельца. */
  | { kind: 'unresolved'; reason: string; lean?: string; options?: string[] };

/** Действие по итогам разбора. */
export type ContradictionDecision =
  | { action: 'close'; verdict: Exclude<ContradictionVerdict, { kind: 'unresolved' }> }
  | {
      action: 'ask';
      /** Почему спрашиваем: столкнулись два решения владельца или разбор не дал ответа. */
      why: 'owner-decisions' | 'unresolved';
      /** Вывод разбора — прикладывается к вопросу владельцу. */
      verdict: ContradictionVerdict;
    };

/** Запись — решение владельца: решение как вид записи или его ответ на вопрос. */
export function isOwnerDecision(fact: Pick<FactView, 'kind' | 'source'>): boolean {
  return fact.kind === 'decision' || Boolean(fact.source?.questionId);
}

/**
 * Закрыть самим или спросить владельца. Два решения владельца офис не
 * перерешивает никогда, какой бы ни был вердикт. Вердикт «устарела» с id не из
 * этой пары считается неразобранным: забыть чужую запись по ошибке хуже, чем
 * лишний вопрос.
 */
export function decideContradiction(
  a: Pick<FactView, 'id' | 'kind' | 'source'>,
  b: Pick<FactView, 'id' | 'kind' | 'source'>,
  verdict: ContradictionVerdict,
  lang: Lang,
): ContradictionDecision {
  if (isOwnerDecision(a) && isOwnerDecision(b)) return { action: 'ask', why: 'owner-decisions', verdict };
  if (verdict.kind === 'unresolved') return { action: 'ask', why: 'unresolved', verdict };
  if (verdict.kind === 'stale') {
    const ids = [a.id, b.id];
    const fits = verdict.keepId !== verdict.forgetId && ids.includes(verdict.keepId) && ids.includes(verdict.forgetId);
    if (!fits) {
      return {
        action: 'ask', why: 'unresolved',
        verdict: { kind: 'unresolved', reason: t(lang, 'contradictions.reason.foreignIds', { reason: verdict.reason }) },
      };
    }
  }
  return { action: 'close', verdict };
}

/** Одна запись в задании: id, вид, когда заведена и откуда. */
function describeFact(fact: FactView, lang: Lang): string {
  const when = new Date(fact.createdAt).toISOString().slice(0, 10);
  const from = [
    fact.source.taskId && t(lang, 'prompt.resolveContradiction.fromTask', { id: fact.source.taskId }),
    fact.source.questionId && t(lang, 'prompt.resolveContradiction.fromAnswer', { id: fact.source.questionId }),
    fact.source.ritual && t(lang, 'prompt.resolveContradiction.fromRitual', { name: fact.source.ritual }),
  ].filter(Boolean).join(', ');
  return t(lang, 'prompt.resolveContradiction.fact', {
    id: fact.id, kind: fact.kind, when, text: fact.text,
    from: from ? t(lang, 'prompt.resolveContradiction.from', { list: from }) : '',
  });
}

/** Задание агенту разбора на одну пару записей. */
export function buildResolvePrompt(a: FactView, b: FactView, lang: Lang): string {
  return t(lang, 'prompt.resolveContradiction.task', {
    a: describeFact(a, lang), b: describeFact(b, lang), aId: a.id, bId: b.id,
  });
}

/**
 * Ответ агента — в вердикт. Берёт первый JSON-объект из текста (агент мог
 * обернуть его в ```), всё непонятное — unresolved, а не исключение.
 */
export function parseVerdict(text: string, lang: Lang): ContradictionVerdict {
  const fail = (why: string): ContradictionVerdict => ({ kind: 'unresolved', reason: why });
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return fail(t(lang, 'contradictions.reason.noJson'));
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return fail(t(lang, 'contradictions.reason.badJson'));
  }
  if (!raw || typeof raw !== 'object') return fail(t(lang, 'contradictions.reason.notObject'));
  const v = raw as Record<string, unknown>;
  const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
  const reason = str(v.reason);
  if (v.kind === 'stale' && str(v.keepId) && str(v.forgetId)) {
    return { kind: 'stale', keepId: str(v.keepId), forgetId: str(v.forgetId), reason };
  }
  if (v.kind === 'compatible') return { kind: 'compatible', reason };
  if (v.kind === 'unresolved') {
    const out: ContradictionVerdict = { kind: 'unresolved', reason };
    if (str(v.lean)) out.lean = str(v.lean);
    if (Array.isArray(v.options)) {
      const options = v.options.map(str).filter(Boolean).slice(0, 4);
      if (options.length) out.options = options;
    }
    return out;
  }
  return fail(t(lang, 'contradictions.reason.unknownKind', { what: reason || String(v.kind) }));
}

/* ── Память разобранных пар ─────────────────────────────────────────────── */

/** Сколько пар помнить: старые вытесняются, журнал всё равно забывает записи. */
export const RESOLVED_PAIRS_KEPT = 500;

/** Где лежит память: LifeState.resolvedPairs, ключ — пара, значение — когда разобрана. */
export interface ResolvedPairsHolder {
  resolvedPairs: Record<string, number>;
}

/** Ключ пары записей, не зависящий от порядка. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Пара уже разобрана — второй раз агента на неё не тратим. */
export function isPairResolved(holder: ResolvedPairsHolder, a: string, b: string): boolean {
  return pairKey(a, b) in (holder.resolvedPairs ?? {});
}

/**
 * Отметить пару разобранной. Правит holder на месте; записать на диск —
 * забота вызывающего (state.touchLife()).
 */
export function markPairResolved(holder: ResolvedPairsHolder, a: string, b: string, now = Date.now()): void {
  const pairs = holder.resolvedPairs ?? (holder.resolvedPairs = {});
  pairs[pairKey(a, b)] = now;
  const keys = Object.keys(pairs);
  if (keys.length <= RESOLVED_PAIRS_KEPT) return;
  keys.sort((x, y) => pairs[x] - pairs[y]);
  for (const key of keys.slice(0, keys.length - RESOLVED_PAIRS_KEPT)) delete pairs[key];
}
