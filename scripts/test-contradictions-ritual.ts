/**
 * Ритуал противоречий с самостоятельным разбором (rituals.ts → handleContradiction)
 * на заглушке агентов. Три исхода: «верна одна» закрывается без владельца
 * (запись уходит из активного журнала, в ленте — событие), «противоречия нет»
 * закрывается без правок журнала, «решить не могу» и неуверенный вердикт уходят
 * вопросом с вариантами. Два решения владельца — тоже вопрос. Сторона без
 * записи в журнале (новое наблюдение) разбирается так же, как запись;
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
import { factsFor } from '../src/server/journal';

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
    kind: 'stale', keepId: newFact.id, forgetId: oldFact.id, reason: 'загрузка картинок уже сделана',
    evidence: 'src/server/index.ts: POST /api/office/icon принимает картинки',
    rewrite: 'Иконка офиса — эмодзи или картинка (POST /api/office/icon)',
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
  await check('проигравшая ушла из активного журнала, но осталась историей', () => {
    const lost = office.facts.get(oldFact.id);
    assert.equal(lost?.status, 'archived');
    assert.equal(lost?.supersededBy, newFact.id);
    assert.equal(lost?.text, 'Иконка офиса поддерживает только эмодзи');
    assert.ok(!factsFor(office, null).some((f) => f.id === oldFact.id));
  });
  await check('победившая жива, её формулировка уточнена', () => {
    assert.equal(office.facts.get(newFact.id)?.status, 'live');
    assert.equal(office.facts.get(newFact.id)?.text, 'Иконка офиса — эмодзи или картинка (POST /api/office/icon)');
  });
  await check('в ленте одно событие: обе записи, какая оставлена, почему и чем проверено', () => {
    const lines = office.log.slice(logBefore).filter((l) => l.text.includes('разобрано без владельца'));
    assert.equal(lines.length, 1);
    const text = lines[0].text;
    for (const part of [`${oldFact.id}: Иконка офиса поддерживает только эмодзи`, `${newFact.id}: Иконка офиса бывает эмодзи или картинкой`,
      `Оставлена ${newFact.id}`, `${oldFact.id} убрана из активного журнала`, 'загрузка картинок уже сделана',
      'Проверено: src/server/index.ts', 'Формулировка']) {
      assert.ok(text.includes(part), `в событии нет «${part}»: ${text}`);
    }
  });
  await check('пара отмечена разобранной, прогон посчитан с ценой разбора', () => {
    assert.ok(isPairResolved(office.life, oldFact.id, newFact.id));
    assert.equal(run?.produced.resolved, 1);
    assert.equal(run?.produced.contradictions, 0);
    assert.equal(run?.costUsd, 0.02);
  });

  console.log('исход compatible');
  const scopeA = office.addFact({ kind: 'fact', text: 'Тесты гоняются через npm run test:pm', scope: 'project' });
  const scopeB = office.addFact({ kind: 'lesson', text: 'В копии исполнителя test:pm не запускать', scope: 'project' });
  office.life.lastRun = {};
  flagged = [{ a: `${scopeA.id} ${scopeA.text}`, b: `${scopeB.id} ${scopeB.text}`, text: 'test:pm: запускать или нет' }];
  verdictJson = JSON.stringify({ kind: 'compatible', reason: 'первая про конвейер офиса, вторая про песочницу исполнителя', sure: true });
  const logCompatible = office.log.length;
  const runCompatible = await runRitual(office, 'contradictions');
  await check('вопроса нет, обе записи живы и не тронуты', () => {
    assert.equal(contradictionQuestions().length, 0);
    for (const f of [scopeA, scopeB]) {
      assert.equal(office.facts.get(f.id)?.status, 'live');
      assert.equal(office.facts.get(f.id)?.supersededBy, undefined);
    }
    assert.equal(runCompatible?.produced.resolved, 1);
  });
  await check('в ленте событие «противоречия нет» с обоснованием', () => {
    const lines = office.log.slice(logCompatible).filter((l) => l.text.includes('разобрано без владельца'));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].text.includes('Противоречия нет') && lines[0].text.includes('песочницу исполнителя'), lines[0].text);
  });
  office.life.lastRun = {};
  const callsCompatible = resolveCalls;
  await runRitual(office, 'contradictions');
  await check('пара «противоречия нет» на следующем прогоне не поднимается', () => {
    assert.equal(resolveCalls, callsCompatible);
    assert.equal(contradictionQuestions().length, 0);
  });

  console.log('два решения владельца');
  office.life.lastRun = {};
  flagged = [{ a: `${ownerA.id} ${ownerA.text}`, b: `${ownerB.id} ${ownerB.text}`, text: 'хранилище: JSON или SQLite' }];
  // Агент уверен, что одна запись устарела, — но решения владельца офис не перерешивает.
  verdictJson = JSON.stringify({ kind: 'stale', keepId: ownerA.id, forgetId: ownerB.id, reason: 'в коде только state.json', evidence: 'src/server/state.ts' });
  await runRitual(office, 'contradictions');

  await check('вопрос появился с выводом разбора и вариантами', () => {
    const qs = contradictionQuestions();
    assert.equal(qs.length, 1);
    assert.ok(qs[0].text.includes('ваши решения') && qs[0].text.includes('в коде только state.json'));
    assert.deepEqual(qs[0].options, [`${ownerA.id}: Хранилище — JSON-файл`, `${ownerB.id}: Хранилище — SQLite`, 'Верны обе, это разные случаи', 'Пусть офис разберётся']);
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
  assert.ok(answerQuestion(office, asked.id, asked.options![0]));
  await check('ответ кнопкой убирает проигравшую сторону из промптов', () => {
    assert.ok(office.facts.get(ownerB.id)?.supersededBy);
    assert.equal(office.facts.get(ownerA.id)?.supersededBy, undefined);
  });
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
    assert.ok(why.includes(asked.id) && why.includes(`${ownerA.id}: Хранилище`), why);
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

  console.log('агент не уверен');
  const u1 = office.addFact({ kind: 'fact', text: 'Лимит одновременных фич равен двум', scope: 'project' });
  const u2 = office.addFact({ kind: 'fact', text: 'Лимит одновременных фич равен трём, см. J-1', scope: 'project' });
  office.life.lastRun = {};
  flagged = [{ a: `${u1.id} ${u1.text}`, b: `${u2.id} ${u2.text}`, text: 'лимит фич' }];
  verdictJson = JSON.stringify({ kind: 'stale', keepId: u2.id, forgetId: u1.id, reason: 'похоже, меняли', evidence: 'git log', sure: false });
  await runRitual(office, 'contradictions');
  await check('неуверенный вердикт — вопрос с двумя записями кнопками, журнал не тронут', () => {
    const q = contradictionQuestions().find((item) => item.text.includes('в выводе не уверен'));
    assert.ok(q, 'нет вопроса о неуверенном вердикте');
    assert.ok(q.text.includes('похоже, меняли'));
    assert.deepEqual(q.options, [`${u1.id}: Лимит одновременных фич равен двум`, `${u2.id}: Лимит одновременных фич равен трё…`, 'Верны обе, это разные случаи', 'Пусть офис разберётся']);
    assert.ok(q.options!.every((o) => o.length <= 40));
    assert.equal(office.facts.get(u1.id)?.status, 'live');
  });
  const bare1 = office.addFact({ kind: 'fact', text: 'Сборка веба идёт через Vite пятой версии', scope: 'project' });
  const bare2 = office.addFact({ kind: 'fact', text: 'Сборка веба идёт через Vite шестой версии', scope: 'project' });
  office.life.lastRun = {};
  flagged = [{ a: bare1.id, b: bare2.id, text: 'версия Vite' }];
  verdictJson = JSON.stringify({ kind: 'stale', keepId: bare2.id, forgetId: bare1.id, reason: 'кажется, обновляли' });
  await runRitual(office, 'contradictions');
  await check('вердикт без проверяемого основания запись не забывает', () => {
    assert.equal(office.facts.get(bare1.id)?.status, 'live');
    assert.ok(contradictionQuestions().some((item) => item.text.includes('кажется, обновляли')));
  });

  console.log('новое наблюдение против записи журнала');
  const stalePort = office.addFact({ kind: 'fact', text: 'Реестр маркета читается из registry/index.json', scope: 'role:backend' });
  const observation = 'Реестр маркета читается из registry/registry.json';
  office.life.lastRun = {};
  flagged = [{ a: `${stalePort.id} ${stalePort.text}`, b: observation, text: 'файл реестра маркета' }];
  verdictJson = JSON.stringify({ kind: 'stale', keepId: 'NEW', forgetId: stalePort.id, reason: 'файл переименован', evidence: 'src/server/market.ts' });
  const questionsObs = office.questions.size;
  const callsObs = resolveCalls;
  await runRitual(office, 'contradictions');
  await check('наблюдение разобрано агентом без вопроса и стало записью вместо устаревшей', () => {
    assert.equal(resolveCalls, callsObs + 1);
    assert.ok(prompts.at(-1)!.includes('Запись NEW — новое наблюдение'));
    assert.equal(office.questions.size, questionsObs);
    const fresh = office.factList().find((f) => f.text === observation);
    assert.ok(fresh && fresh.status === 'live' && fresh.scope === 'role:backend');
    assert.equal(office.facts.get(stalePort.id)?.status, 'archived');
    assert.equal(office.facts.get(stalePort.id)?.supersededBy, fresh.id);
  });
  const keptFact = office.addFact({ kind: 'fact', text: 'Движок агентов запускается только через startSession', scope: 'project' });
  const wrongObservation = 'Движок агентов запускается напрямую через query из SDK';
  office.life.lastRun = {};
  flagged = [{ a: `${keptFact.id} ${keptFact.text}`, b: wrongObservation, text: 'запуск движка' }];
  verdictJson = JSON.stringify({ kind: 'stale', keepId: keptFact.id, forgetId: 'NEW', reason: 'прямых вызовов нет', evidence: 'rg "query(" src/server' });
  const factsWrong = office.facts.size;
  await runRitual(office, 'contradictions');
  await check('неверное наблюдение в журнал не попадает, запись остаётся', () => {
    assert.equal(office.facts.size, factsWrong);
    assert.equal(office.facts.get(keptFact.id)?.status, 'live');
    assert.equal(office.questions.size, questionsObs);
  });
  office.life.lastRun = {};
  const callsRepeatObs = resolveCalls;
  await runRitual(office, 'contradictions');
  await check('пара с наблюдением повторно не разбирается', () => {
    assert.equal(resolveCalls, callsRepeatObs);
    assert.equal(office.questions.size, questionsObs);
  });

  unloadOfficeState('o-contradictions-ritual');
  console.log(`\nритуал противоречий: ${passed} проверок прошло`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
