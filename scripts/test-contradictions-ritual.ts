/**
 * Ритуал противоречий с самостоятельным разбором (rituals.ts → handleContradiction)
 * на заглушке агентов: исход stale закрывается без владельца и забывает запись,
 * два решения владельца уходят вопросом с выводом разбора и вариантами,
 * разобранная пара второй раз не поднимается — ни по памяти пар, ни по
 * отвеченному вопросу; открытый повтор закрывается ссылкой на прежний ответ.
 *
 * Запуск: node --import tsx/esm scripts/test-contradictions-ritual.ts
 */
import assert from 'node:assert/strict';
import { getOffice, unloadOfficeState } from '../src/server/state';
import { runRitual, setRitualAgents, type RitualOutput } from '../src/server/rituals';
import { answerQuestion, officeAsks, openQuestions } from '../src/server/questions';
import { isPairResolved } from '../src/server/contradictions';

// Тексты офиса сверяем по-русски — значит, и офис должен быть русским.
process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const empty = (): RitualOutput => ({ facts: [], contradictions: [], questions: [], costUsd: 0 });

async function main(): Promise<void> {
  const office = getOffice('o-contradictions-ritual');
  office.seed();
  office.opened = true;
  office.settings.ritualsEnabled = true;
  office.settings.model = { provider: 'claude-code', model: 'claude-sonnet-5-5' };

  const oldFact = office.addFact({ kind: 'fact', text: 'Иконка офиса поддерживает только эмодзи', scope: 'project' });
  const newFact = office.addFact({ kind: 'fact', text: 'Иконка офиса бывает эмодзи или картинкой', scope: 'project' });
  const ownerA = office.addFact({ kind: 'decision', text: 'Хранилище — JSON-файл', scope: 'project' });
  const ownerB = office.addFact({ kind: 'decision', text: 'Хранилище — SQLite', scope: 'project' });

  // Заглушки: что найдёт ритуал и что ответит агент разбора.
  let flagged: RitualOutput['contradictions'] = [];
  let verdictJson = '';
  let resolveCalls = 0;
  const prompts: string[] = [];
  setRitualAgents({
    async consolidate() { return empty(); },
    async contradictions() { return { ...empty(), contradictions: flagged }; },
    async reflect() { return { ...empty(), features: [], rules: [], summary: '' }; },
    async resolveContradiction(_state, prompt) {
      resolveCalls += 1;
      prompts.push(prompt);
      return { text: verdictJson, costUsd: 0.02 };
    },
  });
  const contradictionQuestions = () => openQuestions(office).filter((q) => q.kind === 'contradiction');

  console.log('исход stale');
  flagged = [{ a: `${oldFact.id} [fact, project] ${oldFact.text}`, b: `${newFact.id} ${newFact.text}`, text: 'иконка: только эмодзи или ещё картинка' }];
  verdictJson = '```json\n' + JSON.stringify({
    kind: 'stale', keepId: newFact.id, forgetId: oldFact.id, reason: 'POST /api/office/icon принимает картинки',
  }) + '\n```';
  const logBefore = office.log.length;
  const run = await runRitual(office, 'contradictions');

  await check('агент разбора получил задание на эту пару', () => {
    assert.equal(resolveCalls, 1);
    assert.ok(prompts[0].includes(oldFact.id) && prompts[0].includes(newFact.id));
  });
  await check('вопрос владельцу не появился', () => {
    assert.equal(contradictionQuestions().length, 0);
    assert.equal(office.factList().filter((f) => f.kind === 'contradiction').length, 0);
  });
  await check('устаревшая запись забыта, верная живая', () => {
    assert.equal(office.facts.get(oldFact.id)?.status, 'archived');
    assert.equal(office.facts.get(newFact.id)?.status, 'live');
  });
  await check('в ленте одна строка: что разошлось, что решили и почему', () => {
    const lines = office.log.slice(logBefore).filter((l) => l.text.includes('разобрано без владельца'));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].text.includes('иконка') && lines[0].text.includes('устарела') && lines[0].text.includes('POST /api/office/icon'));
  });
  await check('пара отмечена разобранной, прогон посчитан с ценой разбора', () => {
    assert.ok(isPairResolved(office.life, oldFact.id, newFact.id));
    assert.equal(run?.produced.resolved, 1);
    assert.equal(run?.produced.contradictions, 0);
    assert.equal(run?.costUsd, 0.02);
  });

  console.log('два решения владельца');
  office.life.lastRun = {};
  flagged = [{ a: `${ownerA.id} ${ownerA.text}`, b: `${ownerB.id} ${ownerB.text}`, text: 'хранилище: JSON или SQLite' }];
  // Агент уверен, что одна запись устарела, — но решения владельца офис не перерешивает.
  verdictJson = JSON.stringify({ kind: 'stale', keepId: ownerA.id, forgetId: ownerB.id, reason: 'в коде только state.json' });
  await runRitual(office, 'contradictions');

  await check('вопрос появился с выводом разбора и вариантами', () => {
    const qs = contradictionQuestions();
    assert.equal(qs.length, 1);
    assert.ok(qs[0].text.includes('ваши решения') && qs[0].text.includes('в коде только state.json'));
    assert.deepEqual(qs[0].options, [`Верна ${ownerA.id}`, `Верна ${ownerB.id}`, 'Верны обе, это разные случаи']);
  });
  await check('решения владельца не забыты', () => {
    assert.equal(office.facts.get(ownerA.id)?.status, 'live');
    assert.equal(office.facts.get(ownerB.id)?.status, 'live');
  });
  await check('спрошенная пара тоже отмечена', () => {
    assert.ok(isPairResolved(office.life, ownerA.id, ownerB.id));
  });

  console.log('повтор и неразборчивый ответ');
  office.life.lastRun = {};
  const callsBefore = resolveCalls;
  const questionsBefore = office.questions.size;
  await runRitual(office, 'contradictions');
  await check('разобранная пара не поднимается повторно', () => {
    assert.equal(resolveCalls, callsBefore);
    assert.equal(office.questions.size, questionsBefore);
  });

  console.log('отвеченная пара без памяти пар');
  // Как в офисах, где вопросы задали до появления resolvedPairs: память пуста,
  // но владелец уже ответил — по вопросу, а не по ключу пары.
  const asked = contradictionQuestions()[0];
  assert.ok(answerQuestion(office, asked.id, `Верна ${ownerA.id}`));
  office.life.resolvedPairs = {};
  office.life.lastRun = {};
  const callsAnswered = resolveCalls;
  const questionsAnswered = office.questions.size;
  const contradictionFacts = office.factList().filter((f) => f.kind === 'contradiction').length;
  await runRitual(office, 'contradictions');
  await check('отвеченная пара не поднимается снова: ни агента, ни вопроса, ни записи', () => {
    assert.equal(resolveCalls, callsAnswered);
    assert.equal(office.questions.size, questionsAnswered);
    assert.equal(office.factList().filter((f) => f.kind === 'contradiction').length, contradictionFacts);
  });

  console.log('открытый повтор закрывается ссылкой на ответ');
  const repeat = officeAsks(office, 'contradiction',
    `Журнал разошёлся сам с собой: «${ownerB.id}: ${ownerB.text}» против «${ownerA.id}: ${ownerA.text}». Что верно?`, 'допущение');
  office.life.lastRun = {};
  flagged = [];
  await runRitual(office, 'contradictions');
  await check('повтор снят, в причине — прежний вопрос и ответ владельца', () => {
    const q = office.questions.get(repeat.id)!;
    assert.ok(q.dismissedAt);
    const why = q.closedWhy ?? '';
    assert.ok(why.includes(asked.id) && why.includes(`Верна ${ownerA.id}`), why);
    assert.equal(office.questions.get(asked.id)?.dismissedAt, null);
  });

  const x = office.addFact({ kind: 'fact', text: 'Порт сервера по умолчанию 3002', scope: 'project' });
  const y = office.addFact({ kind: 'fact', text: 'Порт сервера по умолчанию 3010', scope: 'project' });
  office.life.lastRun = {};
  flagged = [{ a: x.id, b: y.id, text: 'порт сервера' }];
  verdictJson = 'не знаю, честно';
  await runRitual(office, 'contradictions');
  await check('ответ не JSON — unresolved и вопрос владельцу', () => {
    const q = contradictionQuestions().find((item) => item.text.includes('Разобраться не вышло'));
    assert.ok(q, 'нет вопроса с выводом разбора');
    assert.equal(office.facts.get(x.id)?.status, 'live');
  });

  unloadOfficeState('o-contradictions-ritual');
  console.log(`\nритуал противоречий: ${passed} проверок прошло`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
