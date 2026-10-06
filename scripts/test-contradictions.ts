/**
 * Разбор противоречий журнала (src/server/contradictions.ts) без модели:
 * три исхода, правило про два решения владельца, разбор ответа агента и
 * память разобранных пар.
 *
 * Запуск: npm run test:contradictions
 */
import assert from 'node:assert/strict';
import {
  buildResolvePrompt, decideContradiction, isPairResolved, markPairResolved, pairKey, parseVerdict,
  RESOLVED_PAIRS_KEPT, type ContradictionVerdict,
} from '../src/server/contradictions';
import type { FactView } from '../src/shared/types';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const fact = (id: string, kind: FactView['kind'], source: FactView['source'] = {}): FactView => ({
  id, kind, text: `запись ${id}`, scope: 'project', source,
  createdAt: Date.UTC(2026, 9, 1), confirmedAt: Date.UTC(2026, 9, 1), status: 'live',
});

const plainA = fact('J-1', 'fact', { taskId: 'T-1' });
const plainB = fact('J-2', 'lesson', { ritual: 'consolidate' as FactView['source']['ritual'] });
const ownerDecision = fact('J-3', 'decision');
const ownerAnswer = fact('J-4', 'fact', { questionId: 'Q-7' });

const stale: ContradictionVerdict = { kind: 'stale', keepId: 'J-2', forgetId: 'J-1', reason: 'в коде иначе' };
const compatible: ContradictionVerdict = { kind: 'compatible', reason: 'разные экраны' };
const unresolved: ContradictionVerdict = { kind: 'unresolved', reason: 'нет следов', lean: 'J-2', options: ['J-1', 'J-2'] };

console.log('decideContradiction');

check('stale закрывается самим офисом', () => {
  assert.deepEqual(decideContradiction(plainA, plainB, stale, 'ru'), { action: 'close', verdict: stale });
});

check('compatible закрывается самим офисом', () => {
  assert.deepEqual(decideContradiction(plainA, plainB, compatible, 'ru'), { action: 'close', verdict: compatible });
});

check('unresolved ведёт к вопросу владельцу с выводом разбора', () => {
  assert.deepEqual(decideContradiction(plainA, plainB, unresolved, 'ru'), { action: 'ask', why: 'unresolved', verdict: unresolved });
});

check('два решения владельца — всегда вопрос, какой бы ни был вердикт', () => {
  const ownStale: ContradictionVerdict = { kind: 'stale', keepId: 'J-3', forgetId: 'J-4', reason: 'новее' };
  for (const v of [ownStale, compatible, unresolved]) {
    for (const [a, b] of [[ownerDecision, ownerAnswer], [ownerAnswer, ownerDecision]]) {
      assert.deepEqual(decideContradiction(a, b, v, 'ru'), { action: 'ask', why: 'owner-decisions', verdict: v });
    }
  }
  // Два ответа владельца на вопросы и два решения — тоже решения владельца.
  assert.equal(decideContradiction(ownerAnswer, fact('J-5', 'lesson', { questionId: 'Q-8' }), compatible, 'ru').action, 'ask');
  assert.equal(decideContradiction(ownerDecision, fact('J-6', 'decision'), compatible, 'ru').action, 'ask');
});

check('одно решение владельца против факта разбирается обычным порядком', () => {
  assert.equal(decideContradiction(ownerDecision, plainA, compatible, 'ru').action, 'close');
});

check('stale с id не из пары — вопрос, а не забывание', () => {
  const wrong: ContradictionVerdict = { kind: 'stale', keepId: 'J-2', forgetId: 'J-99', reason: 'х' };
  const d = decideContradiction(plainA, plainB, wrong, 'ru');
  assert.equal(d.action, 'ask');
  assert.equal(d.action === 'ask' && d.why, 'unresolved');
  const same: ContradictionVerdict = { kind: 'stale', keepId: 'J-1', forgetId: 'J-1', reason: 'х' };
  assert.equal(decideContradiction(plainA, plainB, same, 'ru').action, 'ask');
});

console.log('buildResolvePrompt');

check('задание содержит обе записи, правила проверки и формат', () => {
  const p = buildResolvePrompt(plainA, plainB, 'ru');
  for (const part of ['[J-1]', '[J-2]', 'запись J-1', 'запись J-2', 'git log', 'доск', 'Только чтение',
    'rg/grep', 'целиком не читай', '"kind":"stale"', '"kind":"compatible"', '"kind":"unresolved"', 'задача T-1']) {
    assert.ok(p.includes(part), `в задании нет «${part}»`);
  }
});

check('в офисе с английским языком задание и причины приходят по-английски', () => {
  const p = buildResolvePrompt(plainA, plainB, 'en');
  for (const part of ['[J-1]', '[J-2]', 'Read only', 'task T-1', '"kind":"stale"']) {
    assert.ok(p.includes(part), `в задании нет «${part}»`);
  }
  assert.ok(!/(вид|заведена|Как проверять)/.test(p), 'в английском задании остался русский текст');
  const v = parseVerdict('не знаю', 'en');
  assert.ok(v.kind === 'unresolved' && v.reason === 'the review returned no JSON');
});

console.log('parseVerdict');

check('разбирает три исхода, в том числе в обёртке ```', () => {
  assert.deepEqual(parseVerdict(JSON.stringify(stale), 'ru'), stale);
  assert.deepEqual(parseVerdict('```json\n' + JSON.stringify(compatible) + '\n```', 'ru'), compatible);
  assert.deepEqual(parseVerdict(JSON.stringify(unresolved), 'ru'), unresolved);
});

check('мусор и неизвестный исход — unresolved', () => {
  assert.equal(parseVerdict('не знаю', 'ru').kind, 'unresolved');
  assert.equal(parseVerdict('{сломано}', 'ru').kind, 'unresolved');
  assert.equal(parseVerdict('{"kind":"maybe"}', 'ru').kind, 'unresolved');
  assert.equal(parseVerdict('{"kind":"stale","keepId":"J-1"}', 'ru').kind, 'unresolved');
});

console.log('память разобранных пар');

check('ключ пары не зависит от порядка', () => {
  assert.equal(pairKey('J-1', 'J-2'), pairKey('J-2', 'J-1'));
  assert.notEqual(pairKey('J-1', 'J-2'), pairKey('J-1', 'J-3'));
});

check('отмеченная пара разобрана в любом порядке, чужая — нет', () => {
  const life = { resolvedPairs: {} as Record<string, number> };
  assert.equal(isPairResolved(life, 'J-1', 'J-2'), false);
  markPairResolved(life, 'J-2', 'J-1', 100);
  assert.equal(isPairResolved(life, 'J-1', 'J-2'), true);
  assert.equal(isPairResolved(life, 'J-2', 'J-1'), true);
  assert.equal(isPairResolved(life, 'J-1', 'J-3'), false);
  assert.equal(Object.keys(life.resolvedPairs).length, 1);
});

check('память обрезается по самым старым парам', () => {
  const life = { resolvedPairs: {} as Record<string, number> };
  for (let i = 0; i < RESOLVED_PAIRS_KEPT + 5; i++) markPairResolved(life, `A-${i}`, `B-${i}`, i);
  assert.equal(Object.keys(life.resolvedPairs).length, RESOLVED_PAIRS_KEPT);
  assert.equal(isPairResolved(life, 'A-0', 'B-0'), false);
  assert.equal(isPairResolved(life, `A-${RESOLVED_PAIRS_KEPT + 4}`, `B-${RESOLVED_PAIRS_KEPT + 4}`), true);
});

console.log(`\nпротиворечия: ${passed} проверок прошло`);
