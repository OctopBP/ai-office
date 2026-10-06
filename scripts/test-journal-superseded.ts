/**
 * Пометка «заменена» у записей журнала (src/server/superseded.ts, T-331):
 * разбор ответа на противоречие, фильтр промпта, разовая миграция.
 *
 * Запуск: npm run test:journal
 */
import assert from 'node:assert/strict';
import { getOffice } from '../src/server/state';
import { confirmFact, factsFor, journalBrief, supersedeFacts } from '../src/server/journal';
import { answerQuestion, officeAsks } from '../src/server/questions';
import { setPipelineAgents } from '../src/server/review';
import {
  factIdsIn, isPromptable, KNOWN_SUPERSEDED, migrateSuperseded, supersededByAnswer,
} from '../src/server/superseded';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// Менеджера здесь нет: весть об ответе уходит в никуда.
setPipelineAgents({
  async review() { return { verdict: 'approve', text: '', reviewerId: null }; },
  async rework() { return { ok: true, message: '' }; },
  notifyPm() { /* пусто */ },
});

const Q = 'Журнал разошёлся сам с собой: «J-22: «веб отдавать backend-2»» против «J-38: «нагрузку распределять равномерно»». Что верно?';

console.log('supersededByAnswer');

check('id в тексте — по порядку и без повторов', () => {
  assert.deepEqual(factIdsIn('J-3, J-1 и снова J-3; T-5 не наш'), ['J-3', 'J-1']);
});

check('кнопка «Верна J-38» заменяет другую сторону', () => {
  assert.deepEqual(supersededByAnswer(Q, 'Верна J-38'), ['J-22']);
  assert.deepEqual(supersededByAnswer(Q, 'Верна J-22'), ['J-38']);
});

check('«верна более новая запись» заменяет старшую сторону', () => {
  assert.deepEqual(supersededByAnswer(Q, 'Верна более новая запись'), ['J-22']);
  assert.deepEqual(supersededByAnswer(Q, 'the newer entry holds'), ['J-22']);
});

check('«верны обе», свободный текст и «разберись сам» ничего не заменяют', () => {
  assert.deepEqual(supersededByAnswer(Q, 'Верны обе, это разные случаи'), []);
  assert.deepEqual(supersededByAnswer(Q, 'Надо распределять нагрузку'), []);
  assert.deepEqual(supersededByAnswer(Q, 'Разберись сам'), []);
  assert.deepEqual(supersededByAnswer('вопрос без записей', 'Верна J-1'), []);
});

check('«обе» внутри другого слова не считается ответом «верны обе»', () => {
  assert.deepEqual(supersededByAnswer(Q, 'Верна J-38, удобен подход'), ['J-22']);
});

console.log('журнал и промпт');

const office = getOffice('o-journal-superseded');
office.seed();
office.opened = true;

check('заменённая запись не едет в промпт, но видна в снапшоте с пометкой', () => {
  const old = office.addFact({ kind: 'lesson', text: 'Веб отдавать backend-2', scope: 'project' });
  const fresh = office.addFact({ kind: 'decision', text: 'Нагрузку распределять равномерно', scope: 'project' });
  assert.deepEqual(supersedeFacts(office, [old.id], fresh.id), [old.id]);
  assert.ok(!factsFor(office, 'backend').some((f) => f.id === old.id));
  assert.ok(!journalBrief(office, 'backend').includes('backend-2'));
  assert.ok(journalBrief(office, 'backend').includes('равномерно'));
  const view = (office.snapshot() as { facts: Array<{ id: string; supersededBy?: string }> })
    .facts.find((f) => f.id === old.id);
  assert.equal(view?.supersededBy, fresh.id);
  // Повторная пометка не перезаписывает первую.
  assert.deepEqual(supersedeFacts(office, [old.id], 'J-999'), []);
  assert.equal(office.facts.get(old.id)?.supersededBy, fresh.id);
});

check('«Ещё верно» снимает пометку — запись снова в промпте', () => {
  const old = office.addFact({ kind: 'fact', text: 'Сборка — webpack', scope: 'project' });
  supersedeFacts(office, [old.id], 'J-1');
  assert.ok(confirmFact(office, old.id));
  assert.equal(office.facts.get(old.id)?.supersededBy, undefined);
  assert.ok(factsFor(office, null).some((f) => f.id === old.id));
});

check('ответ владельца на противоречие помечает проигравшую сторону ответом', () => {
  const a = office.addFact({ kind: 'fact', text: 'Иконка офиса — только эмодзи', scope: 'project' });
  const b = office.addFact({ kind: 'fact', text: 'Иконка офиса — эмодзи или картинка', scope: 'project' });
  const q = officeAsks(office, 'contradiction',
    `Журнал разошёлся сам с собой: «${a.id}: эмодзи» против «${b.id}: картинка». Что верно?`, 'новее');
  assert.ok(answerQuestion(office, q.id, `Верна ${b.id}`));
  const answer = office.factList().find((f) => f.source.questionId === q.id)!;
  assert.equal(office.facts.get(a.id)?.supersededBy, answer.id);
  assert.equal(office.facts.get(b.id)?.supersededBy, undefined);
  assert.ok(!journalBrief(office, null).includes('только эмодзи'));
});

check('ответ на обычный вопрос ничего не помечает', () => {
  const a = office.addFact({ kind: 'fact', text: 'Порт сервера 3001', scope: 'project' });
  const q = officeAsks(office, 'assumption', `Про ${a.id}: порт ещё 3001?`, 'да');
  assert.ok(answerQuestion(office, q.id, `Верна ${a.id}`));
  assert.equal(office.facts.get(a.id)?.supersededBy, undefined);
});

check('противоречие и заменённая запись — не для промпта', () => {
  assert.equal(isPromptable({ kind: 'contradiction' }), false);
  assert.equal(isPromptable({ kind: 'fact', supersededBy: 'J-2' }), false);
  assert.equal(isPromptable({ kind: 'decision' }), true);
});

console.log('миграция T-331');

/** Журнал как в офисе o-2: старые записи начинаются с известного текста. */
function journal(): Map<string, { text: string; supersededBy?: string }> {
  const map = new Map<string, { text: string; supersededBy?: string }>();
  for (const { id, by, starts } of KNOWN_SUPERSEDED) {
    map.set(id, { text: `${starts} — хвост записи` });
    map.set(by, { text: 'ответ' });
  }
  return map;
}

check('помечает J-1, J-3, J-8, J-22, J-29, J-213 нужными ответами', () => {
  const facts = journal();
  assert.deepEqual(migrateSuperseded(facts), ['J-1', 'J-3', 'J-8', 'J-22', 'J-29', 'J-213']);
  assert.equal(facts.get('J-1')?.supersededBy, 'J-17');
  assert.equal(facts.get('J-3')?.supersededBy, 'J-17');
  assert.equal(facts.get('J-8')?.supersededBy, 'J-36');
  assert.equal(facts.get('J-22')?.supersededBy, 'J-85');
  assert.equal(facts.get('J-29')?.supersededBy, 'J-87');
  assert.equal(facts.get('J-213')?.supersededBy, 'J-217');
});

check('повторный прогон ничего не меняет', () => {
  const facts = journal();
  migrateSuperseded(facts);
  assert.deepEqual(migrateSuperseded(facts), []);
});

check('в чужом офисе с другими записями под теми же id ничего не трогает', () => {
  const facts = new Map<string, { text: string; supersededBy?: string }>([
    ['J-1', { text: 'Совсем другая запись' }], ['J-17', { text: 'ответ' }],
  ]);
  assert.deepEqual(migrateSuperseded(facts), []);
  assert.equal(facts.get('J-1')?.supersededBy, undefined);
});

check('без записи-замены не помечает', () => {
  const facts = journal();
  facts.delete('J-217');
  assert.ok(!migrateSuperseded(facts).includes('J-213'));
});

console.log(`\n${passed} проверок прошло`);
process.exit(0);
