/**
 * Вердикт свежести записи журнала (src/server/staleness.ts) без модели:
 * маршрут проверки, подсказки из текста и свод вердиктов агента.
 *
 * Запуск: npm run test:staleness
 */
import assert from 'node:assert/strict';
import {
  isVerifiableBasis, normalizeVerdict, parseFreshnessVerdicts, planStalenessCheck, stalenessHints, summarizeVerdicts,
  verdictForKind, type AgingFact,
} from '../src/server/staleness';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const NOW = Date.UTC(2026, 9, 14);
const DAY = 24 * 60 * 60 * 1000;
const aging = (kind: AgingFact['kind'], text: string, extra: Partial<AgingFact> = {}): AgingFact => ({
  id: 'J-10', kind, scope: 'project', text, confirmedAt: NOW - 40 * DAY, ...extra,
});

console.log('План проверки');

check('старое решение — на самопроверку с подсказками, не владельцу', () => {
  const plan = planStalenessCheck(aging('decision', 'Репозиторий один, см. src/server/git.ts и T-12'), NOW);
  assert.equal(plan.route, 'self');
  assert.equal(plan.ageDays, 40);
  assert.deepEqual(plan.hints, { files: ['src/server/git.ts'], symbols: [], tasks: ['T-12'], facts: [] });
});

check('факт и урок уходят на самопроверку', () => {
  assert.equal(planStalenessCheck(aging('fact', 'сборка — vite'), NOW).route, 'self');
  assert.equal(planStalenessCheck(aging('lesson', 'читать Office3D.tsx'), NOW).route, 'self');
});

check('запись-противоречие уходит владельцу', () => {
  assert.equal(planStalenessCheck(aging('contradiction', 'J-1 против J-2'), NOW).route, 'owner');
});

check('подсказки: файлы, символы, задачи, записи', () => {
  const plan = planStalenessCheck(aging('fact',
    'Гейт deps.ts сравнивает package-lock.json; маршрут в src/server/journal.ts, функция `limitBlock` '
    + 'и decideContradiction(), набор OFFICE_MERGE_CHECKS, поле Release.stop(). Из T-561, см. J-3 и J-10, снова T-561.',
    { taskId: 'T-565' }), NOW);
  assert.equal(plan.route, 'self');
  assert.deepEqual(plan.hints.files, ['deps.ts', 'package-lock.json', 'src/server/journal.ts']);
  assert.deepEqual(plan.hints.symbols, ['limitBlock', 'decideContradiction', 'Release.stop', 'OFFICE_MERGE_CHECKS']);
  assert.deepEqual(plan.hints.tasks, ['T-565', 'T-561']);
  // Сама запись J-10 в подсказки не попадает.
  assert.deepEqual(plan.hints.facts, ['J-3']);
});

check('текст без зацепок даёт пустые подсказки', () => {
  assert.deepEqual(stalenessHints({ text: 'Владелец любит короткие отчёты' }),
    { files: [], symbols: [], tasks: [], facts: [] });
});

check('свежая запись — ноль дней, будущая дата не уходит в минус', () => {
  assert.equal(planStalenessCheck(aging('fact', 'x', { confirmedAt: NOW + DAY }), NOW).ageDays, 0);
});

console.log('Основание');

check('проверяемые основания', () => {
  assert.ok(isVerifiableBasis({ kind: 'code', ref: 'src/server/journal.ts:forgetFact' }));
  assert.ok(isVerifiableBasis({ kind: 'git', ref: '81bb0af' }));
  assert.ok(isVerifiableBasis({ kind: 'task', ref: 'T-561' }));
  assert.ok(isVerifiableBasis({ kind: 'newer', ref: 'J-20' }, 'J-10'));
});

check('непроверяемые основания', () => {
  assert.ok(!isVerifiableBasis(undefined));
  assert.ok(!isVerifiableBasis({ kind: 'code', ref: '   ' }));
  assert.ok(!isVerifiableBasis({ kind: 'task', ref: 'та задача про выпуски' }));
  assert.ok(!isVerifiableBasis({ kind: 'newer', ref: 'J-10' }, 'J-10'));
  assert.ok(!isVerifiableBasis({ kind: 'feeling', ref: 'кажется' } as never));
});

console.log('Свод вердиктов');

check('три вердикта: устарела с основанием, актуальна, не знаю', () => {
  const s = summarizeVerdicts([
    { factId: 'J-1', verdict: 'stale', reason: 'маршрут переехал', basis: { kind: 'code', ref: 'src/server/index.ts' } },
    { factId: 'J-2', verdict: 'actual', reason: 'функция на месте', basis: { kind: 'code', ref: 'limits.ts:limitBlock' } },
    { factId: 'J-3', verdict: 'unknown', reason: 'не нашёл, где проверить' },
  ]);
  assert.deepEqual(s.outcomes.map(o => [o.factId, o.verdict]), [['J-1', 'stale'], ['J-2', 'actual'], ['J-3', 'unknown']]);
  assert.deepEqual(s.counts, { stale: 1, actual: 1, implementation: 0, contradicted: 0, unknown: 1 });
  assert.deepEqual(s.downgraded, []);
});

check('вердикты решений: описание реализации и противоречие с основанием', () => {
  const s = summarizeVerdicts([
    { factId: 'J-4', verdict: 'implementation', reason: 'это про сортировку в коде' },
    { factId: 'J-5', verdict: 'contradicted', reason: 'в коде иначе', basis: { kind: 'code', ref: 'src/server/offices.ts' } },
  ]);
  assert.deepEqual(s.outcomes.map(o => [o.factId, o.verdict]), [['J-4', 'implementation'], ['J-5', 'contradicted']]);
  assert.deepEqual(s.downgraded, []);
});

check('противоречие без основания понижается до «не знаю» — владельца не спрашиваем', () => {
  const o = normalizeVerdict({ factId: 'J-5', verdict: 'contradicted', reason: 'кажется, иначе' });
  assert.equal(o.verdict, 'unknown');
  assert.equal(o.downgraded, true);
  assert.equal(normalizeVerdict({ factId: 'J-5', verdict: 'contradicted', reason: 'сам себе', basis: { kind: 'newer', ref: 'J-5' } }).verdict, 'unknown');
});

check('разные определённые вердикты по решению — «не знаю» с пометкой спора', () => {
  const s = summarizeVerdicts([
    { factId: 'J-6', verdict: 'actual', reason: 'соблюдается' },
    { factId: 'J-6', verdict: 'contradicted', reason: 'расходится', basis: { kind: 'task', ref: 'T-9' } },
  ]);
  assert.equal(s.outcomes[0].verdict, 'unknown');
  assert.equal(s.outcomes[0].conflict, true);
});

check('вердикт по виду записи: у факта и урока «реализация» — верно, «противоречие» — устарела', () => {
  const impl = { factId: 'J-7', verdict: 'implementation' as const, reason: 'r' };
  const contra = { factId: 'J-7', verdict: 'contradicted' as const, reason: 'r', basis: { kind: 'git' as const, ref: 'abc' } };
  assert.equal(verdictForKind(impl, 'decision').verdict, 'implementation');
  assert.equal(verdictForKind(contra, 'decision').verdict, 'contradicted');
  assert.equal(verdictForKind(impl, 'fact').verdict, 'actual');
  assert.equal(verdictForKind(contra, 'lesson').verdict, 'stale');
});

check('разбор ответа понимает новые вердикты', () => {
  const v = parseFreshnessVerdicts('{"verdicts":[{"factId":"J-1","verdict":"implementation","reason":"код"},'
    + '{"factId":"J-2","verdict":"contradicted","reason":"иначе","basis":{"kind":"newer","ref":"J-9"}},'
    + '{"factId":"J-3","verdict":"maybe"}]}');
  assert.deepEqual(v.map(x => x.verdict), ['implementation', 'contradicted']);
});

check('устарела без основания понижается до «не знаю»', () => {
  const o = normalizeVerdict({ factId: 'J-1', verdict: 'stale', reason: 'похоже, старое' });
  assert.equal(o.verdict, 'unknown');
  assert.equal(o.downgraded, true);
  const s = summarizeVerdicts([
    { factId: 'J-1', verdict: 'stale', reason: 'похоже, старое' },
    { factId: 'J-2', verdict: 'stale', reason: 'по задаче', basis: { kind: 'task', ref: 'какая-то' } },
    { factId: 'J-3', verdict: 'stale', reason: 'есть новее', basis: { kind: 'newer', ref: 'J-3' } },
  ]);
  assert.deepEqual(s.counts, { stale: 0, actual: 0, implementation: 0, contradicted: 0, unknown: 3 });
  assert.deepEqual(s.downgraded, ['J-1', 'J-2', 'J-3']);
});

check('актуальна не требует основания', () => {
  assert.equal(normalizeVerdict({ factId: 'J-1', verdict: 'actual', reason: 'верно' }).verdict, 'actual');
});

check('устарела и актуальна по одной записи — «не знаю» с пометкой спора', () => {
  const s = summarizeVerdicts([
    { factId: 'J-1', verdict: 'stale', reason: 'удалено', basis: { kind: 'git', ref: 'abc123' } },
    { factId: 'J-1', verdict: 'actual', reason: 'на месте' },
  ]);
  assert.equal(s.outcomes.length, 1);
  assert.equal(s.outcomes[0].verdict, 'unknown');
  assert.equal(s.outcomes[0].conflict, true);
});

check('определённый вердикт побеждает «не знаю» по той же записи', () => {
  const s = summarizeVerdicts([
    { factId: 'J-1', verdict: 'unknown', reason: 'не нашёл' },
    { factId: 'J-1', verdict: 'stale', reason: 'заменена', basis: { kind: 'newer', ref: 'J-40' } },
    { factId: 'J-2', verdict: 'stale', reason: 'на глаз' },
    { factId: 'J-2', verdict: 'actual', reason: 'проверил' },
  ]);
  assert.deepEqual(s.outcomes.map(o => [o.factId, o.verdict]), [['J-1', 'stale'], ['J-2', 'actual']]);
  assert.deepEqual(s.downgraded, ['J-2']);
});

check('пустой список — пустой итог', () => {
  assert.deepEqual(summarizeVerdicts([]), {
    outcomes: [], counts: { stale: 0, actual: 0, implementation: 0, contradicted: 0, unknown: 0 }, downgraded: [],
  });
});

console.log(`\n${passed} проверок прошли`);
