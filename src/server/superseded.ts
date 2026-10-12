/**
 * Пометка «заменена» у записей журнала (`Fact.supersededBy`).
 *
 * Противоречие в журнале разрешается новой записью — ответом владельца
 * («В: Журнал разошёлся… — О: …») или выводом разбора «верна более новая
 * запись». Старая сторона при этом остаётся в журнале как история, но в
 * промпты будущих сессий больше не едет: иначе модель читала бы рядом и
 * правило, и его отмену. Пометка — id записи, которая её заменила.
 *
 * Здесь только чистая логика без состояния офиса: какие записи заменяет ответ
 * на вопрос-противоречие и разовая миграция уже данных ответов. Применяет
 * результат вызывающий (questions.ts, state.ts).
 */
import type { FactView } from '../shared/types';

/** Номер записи из id (`J-12` → 12); не наш id — null. */
function seqOf(id: string): number | null {
  const found = /^J-(\d+)$/.exec(id);
  return found ? Number(found[1]) : null;
}

/** Id записей журнала в тексте — по порядку и без повторов. */
export function factIdsIn(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(/\bJ-\d+\b/g)) if (!seen.includes(m[0])) seen.push(m[0]);
  return seen;
}

/** Ответ «верны обе» — замены нет. */
// \b в JS понимает только латиницу, поэтому границы слова — через \p{L}.
const BOTH = /(^|[^\p{L}])(обе|оба|both)(?![\p{L}])/iu;
/** Ответ «верна более новая» — заменена старшая по номеру сторона. */
const NEWER = /(более нов|нов(ая|ее|ей) запис|newer)/i;

/**
 * Какие записи заменяет ответ владельца на вопрос-противоречие. Стороны
 * вопроса — id записей журнала в его тексте. Решаем, только когда ответ
 * однозначен:
 * - назван ровно один id из сторон («J-38: начало записи…» — кнопка варианта) — заменены
 *   остальные стороны;
 * - «верна более новая запись» при двух и более сторонах — заменены все, кроме
 *   самой новой.
 * «Верны обе», свободный текст без id, «разберись сам» — пусто: забыть
 * правильную запись по догадке хуже, чем оставить лишнюю.
 */
export function supersededByAnswer(question: string, answer: string): string[] {
  const sides = factIdsIn(question).filter((id) => seqOf(id) !== null);
  if (sides.length < 1 || BOTH.test(answer)) return [];
  const named = factIdsIn(answer).filter((id) => sides.includes(id));
  if (named.length === 1) return sides.filter((id) => id !== named[0]);
  if (named.length === 0 && sides.length >= 2 && NEWER.test(answer)) {
    const newest = sides.reduce((a, b) => (seqOf(b)! > seqOf(a)! ? b : a));
    return sides.filter((id) => id !== newest);
  }
  return [];
}

/** Запись едет в промпт: не противоречие и никем не заменена. */
export function isPromptable(fact: Pick<FactView, 'kind' | 'supersededBy'>): boolean {
  return fact.kind !== 'contradiction' && !fact.supersededBy;
}

/**
 * Разовая миграция T-331: ответы на противоречия, данные до появления пометки.
 * Номера записей свои у каждого офиса, поэтому пара применяется, только если
 * обе записи на месте и старая начинается с того текста, о котором был ответ:
 * в чужом офисе J-1 — другая запись, и трогать её нельзя.
 */
export const KNOWN_SUPERSEDED: ReadonlyArray<{ id: string; by: string; starts: string }> = [
  { id: 'J-1', by: 'J-17', starts: 'Офис в облачном режиме блокирует все задачи' },
  { id: 'J-3', by: 'J-17', starts: 'ANTHROPIC_API_KEY на dev-сервере не установлен' },
  { id: 'J-8', by: 'J-36', starts: 'OfficeIcon в контракте поддерживает' },
  { id: 'J-22', by: 'J-85', starts: 'Четвёртый подряд провал «Autocompact is thrashing»' },
  { id: 'J-29', by: 'J-87', starts: 'Статус офиса (признак паузы) добавлен в контракт' },
  { id: 'J-213', by: 'J-217', starts: 'QA-роль в маркете' },
];

/**
 * Проставить известные замены. Идемпотентна: уже помеченную запись не
 * трогает. Возвращает id помеченных сейчас.
 */
export function migrateSuperseded(
  facts: Map<string, { text: string; supersededBy?: string }>,
): string[] {
  const done: string[] = [];
  for (const { id, by, starts } of KNOWN_SUPERSEDED) {
    const old = facts.get(id);
    if (!old || old.supersededBy || !facts.has(by) || !old.text.startsWith(starts)) continue;
    old.supersededBy = by;
    done.push(id);
  }
  return done;
}
