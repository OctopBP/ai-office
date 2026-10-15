/**
 * «Пусть офис разберётся» в вопросах о противоречиях (T-579) на заглушке
 * агента разбора. У вопроса о противоречии есть такая кнопка; нажатая кнопка
 * или ответ словами («реши сам», «разберись сам») запускает разбор: верная
 * запись подтверждается, проигравшая уходит в архив с пометкой «заменена» и
 * основанием в ленте. Не вышло — обе записи остаются, в ленте причина, вопрос
 * заново не задаётся. Сам ответ-поручение фактом в журнал не ложится.
 *
 * Запуск: node --import tsx/esm scripts/test-contradictions-delegate.ts
 */
import assert from 'node:assert/strict';
import { getOffice, unloadOfficeState } from '../src/server/state';
import { runRitual, setRitualAgents, type RitualOutput } from '../src/server/rituals';
import {
  answerQuestion, ensureDelegateOptions, officeAsks, openQuestions, settleDelegations,
} from '../src/server/questions';
import { isDelegateAnswer, isPairResolved, withDelegateOption } from '../src/server/contradictions';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const empty = (): RitualOutput => ({ facts: [], contradictions: [], questions: [], costUsd: 0 });
const DELEGATE = 'Пусть офис разберётся';

async function main(): Promise<void> {
  console.log('ответ-поручение');
  await check('кнопка и слова «реши сам» узнаются без регистра и пунктуации', () => {
    for (const text of [DELEGATE, 'пусть офис разберется', 'Реши сам', 'реши сам!', 'Разберись сам.', '  РАЗБЕРИСЬ   САМ ', 'Разберитесь сами', 'Let the office sort it out']) {
      assert.ok(isDelegateAnswer(text), text);
    }
  });
  await check('ответ по существу поручением не считается', () => {
    for (const text of ['J-3: верна', 'реши сам, но J-3 верна', 'Верны обе, это разные случаи', 'не знаю', '']) {
      assert.ok(!isDelegateAnswer(text), text);
    }
  });
  await check('кнопка встаёт четвёртой и не дублируется', () => {
    assert.deepEqual(withDelegateOption(['A', 'B', 'C'], DELEGATE), ['A', 'B', 'C', DELEGATE]);
    assert.deepEqual(withDelegateOption(['A', 'B', 'C', 'D'], DELEGATE), ['A', 'B', 'C', DELEGATE]);
    assert.deepEqual(withDelegateOption(undefined, DELEGATE), [DELEGATE]);
    assert.deepEqual(withDelegateOption(['A', DELEGATE], DELEGATE), ['A', DELEGATE]);
  });

  const office = getOffice('o-contradictions-delegate');
  office.seed();
  office.opened = true;
  office.settings.ritualsEnabled = true;
  office.settings.model = { provider: 'claude-code', model: 'claude-sonnet-5-5' };

  // Два решения владельца: ритуал сам их не перерешивает — нужен вопрос.
  const ownerA = office.addFact({ kind: 'decision', text: 'Менеджер только предлагает зону, заводит её владелец', scope: 'project' });
  const ownerB = office.addFact({ kind: 'decision', text: 'set_role_base с path сам заводит repo-зону', scope: 'project' });
  const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  office.updateFact(ownerB.id, { confirmedAt: longAgo });

  let flagged: RitualOutput['contradictions'] = [];
  let verdictJson = '';
  const prompts: string[] = [];
  setRitualAgents({
    async consolidate() { return empty(); },
    async contradictions() { return { ...empty(), contradictions: flagged }; },
    async reflect() { return { ...empty(), features: [], rules: [], summary: '' }; },
    async resolveContradiction(_state, prompt) {
      prompts.push(prompt);
      return { text: verdictJson, costUsd: 0.01 };
    },
  });
  const contradictionQuestions = () => openQuestions(office).filter((q) => q.kind === 'contradiction');
  const answerFacts = () => office.factList().filter((f) => f.source.questionId);

  console.log('вопрос с кнопкой');
  flagged = [{ a: `${ownerA.id} ${ownerA.text}`, b: `${ownerB.id} ${ownerB.text}`, text: 'кто заводит зону' }];
  verdictJson = JSON.stringify({ kind: 'stale', keepId: ownerB.id, forgetId: ownerA.id, reason: 'зону заводит set_role_base', evidence: 'src/server/rolebase.ts' });
  await runRitual(office, 'contradictions');
  const asked = contradictionQuestions()[0];
  await check('у вопроса о противоречии есть кнопка «Пусть офис разберётся», вариантов не больше 4', () => {
    assert.ok(asked, 'вопроса нет');
    assert.equal(asked.options?.at(-1), DELEGATE);
    assert.ok(asked.options!.length <= 4);
  });

  console.log('выбор кнопки');
  const promptsBefore = prompts.length;
  const logBefore = office.log.length;
  const factsBefore = answerFacts().length;
  assert.ok(answerQuestion(office, asked.id, DELEGATE));
  await settleDelegations();
  await check('кнопка запустила разбор агентом с поручением владельца в задании', () => {
    assert.equal(prompts.length, promptsBefore + 1);
    const prompt = prompts.at(-1)!;
    assert.ok(prompt.includes(ownerA.id) && prompt.includes(ownerB.id));
    assert.ok(prompt.includes('Владелец поручил решить это офису'));
  });
  await check('проигравшая запись в архиве с пометкой «заменена», верная освежена', () => {
    assert.equal(office.facts.get(ownerA.id)?.status, 'archived');
    assert.equal(office.facts.get(ownerA.id)?.supersededBy, ownerB.id);
    assert.equal(office.facts.get(ownerB.id)?.status, 'live');
    assert.ok(office.facts.get(ownerB.id)!.confirmedAt > longAgo);
  });
  await check('в ленте итог с основанием', () => {
    const lines = office.log.slice(logBefore).filter((l) => l.text.includes('офис разобрался в противоречии'));
    assert.equal(lines.length, 1);
    for (const part of [asked.id, `Оставлена ${ownerB.id}`, `${ownerA.id} убрана`, 'зону заводит set_role_base', 'Проверено: src/server/rolebase.ts']) {
      assert.ok(lines[0].text.includes(part), `в событии нет «${part}»: ${lines[0].text}`);
    }
  });
  await check('поручение не легло в журнал фактом, вопрос закрыт', () => {
    assert.equal(answerFacts().length, factsBefore);
    assert.ok(!office.factList().some((f) => f.text.includes('О: Пусть офис разберётся')));
    assert.ok(office.questions.get(asked.id)?.answeredAt);
  });

  console.log('ответ словами: «реши сам»');
  const port1 = office.addFact({ kind: 'fact', text: 'Порт сервера по умолчанию 3002', scope: 'project' });
  const port2 = office.addFact({ kind: 'fact', text: 'Порт сервера по умолчанию 3010', scope: 'project' });
  const portQ = officeAsks(office, 'contradiction',
    `Журнал разошёлся сам с собой: «${port1.id}: ${port1.text}» против «${port2.id}: ${port2.text}». Что верно?`, 'допущение');
  await check('кнопка есть и у вопроса без своих вариантов', () => {
    assert.deepEqual(portQ.options, [DELEGATE]);
  });
  verdictJson = JSON.stringify({ kind: 'stale', keepId: port1.id, forgetId: port2.id, reason: '3010 не встречается в коде', evidence: 'src/server/index.ts: PORT ?? 3002' });
  const promptsText = prompts.length;
  assert.ok(answerQuestion(office, portQ.id, 'Реши сам!'));
  await settleDelegations();
  await check('текстовый ответ ведёт туда же: разбор и архив проигравшей', () => {
    assert.equal(prompts.length, promptsText + 1);
    assert.equal(office.facts.get(port2.id)?.status, 'archived');
    assert.equal(office.facts.get(port2.id)?.supersededBy, port1.id);
    assert.ok(!office.factList().some((f) => f.text.includes('О: Реши сам')));
  });

  console.log('разобраться не вышло');
  const lim1 = office.addFact({ kind: 'fact', text: 'Лимит одновременных фич равен двум', scope: 'project' });
  const lim2 = office.addFact({ kind: 'fact', text: 'Лимит одновременных фич равен трём', scope: 'project' });
  const limQ = officeAsks(office, 'contradiction',
    `Журнал разошёлся сам с собой: «${lim1.id}: ${lim1.text}» против «${lim2.id}: ${lim2.text}». Что верно?`, 'допущение',
    null, [`${lim1.id}: двум`, `${lim2.id}: трём`]);
  verdictJson = JSON.stringify({ kind: 'unresolved', reason: 'лимит нигде в коде не задан' });
  const logFail = office.log.length;
  const questionsFail = office.questions.size;
  const factsFail = office.facts.size;
  assert.ok(answerQuestion(office, limQ.id, 'разберись сам'));
  await settleDelegations();
  await check('обе записи остаются живыми и не заменены', () => {
    for (const f of [lim1, lim2]) {
      assert.equal(office.facts.get(f.id)?.status, 'live');
      assert.equal(office.facts.get(f.id)?.supersededBy, undefined);
    }
  });
  await check('в ленте — что не вышло и почему', () => {
    const lines = office.log.slice(logFail).filter((l) => l.text.includes('не смог разобраться'));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].text.includes(limQ.id) && lines[0].text.includes('лимит нигде в коде не задан'), lines[0].text);
  });
  await check('ни нового вопроса, ни факта «разберись сам»; пара отмечена разобранной', () => {
    assert.equal(office.questions.size, questionsFail);
    assert.equal(office.facts.size, factsFail);
    assert.ok(isPairResolved(office.life, lim1.id, lim2.id));
  });
  office.life.lastRun = {};
  flagged = [{ a: `${lim1.id} ${lim1.text}`, b: `${lim2.id} ${lim2.text}`, text: 'лимит фич' }];
  const promptsRitual = prompts.length;
  await runRitual(office, 'contradictions');
  await check('ритуал эту пару заново не поднимает', () => {
    assert.equal(prompts.length, promptsRitual);
    assert.equal(office.questions.size, questionsFail);
  });

  console.log('обычный ответ и старые вопросы');
  const s1 = office.addFact({ kind: 'fact', text: 'Сборка веба через Vite пятой версии', scope: 'project' });
  const s2 = office.addFact({ kind: 'fact', text: 'Сборка веба через Vite шестой версии', scope: 'project' });
  const plainQ = officeAsks(office, 'contradiction',
    `Журнал разошёлся сам с собой: «${s1.id}: ${s1.text}» против «${s2.id}: ${s2.text}». Что верно?`, 'допущение');
  const promptsPlain = prompts.length;
  assert.ok(answerQuestion(office, plainQ.id, `${s2.id}: шестой`));
  await settleDelegations();
  await check('ответ по существу пишется в журнал как раньше, без разбора', () => {
    assert.equal(prompts.length, promptsPlain);
    assert.ok(office.factList().some((f) => f.source.questionId === plainQ.id));
    assert.equal(office.facts.get(s1.id)?.supersededBy !== undefined, true);
  });
  const legacy = officeAsks(office, 'contradiction', 'Журнал разошёлся сам с собой: «старое» против «новое». Что верно?', 'допущение');
  office.updateQuestion(legacy.id, { options: ['А', 'Б'] });
  await check('старым открытым вопросам кнопка добавляется один раз', () => {
    assert.deepEqual(ensureDelegateOptions(office), [legacy.id]);
    assert.deepEqual(office.questions.get(legacy.id)?.options, ['А', 'Б', DELEGATE]);
    assert.deepEqual(ensureDelegateOptions(office), []);
  });
  const noSidesLog = office.log.length;
  assert.ok(answerQuestion(office, legacy.id, DELEGATE));
  await settleDelegations();
  await check('вопрос без записей журнала: в ленте причина, ничего не тронуто', () => {
    const lines = office.log.slice(noSidesLog).filter((l) => l.text.includes('не смог разобраться'));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].text.includes('двух записей журнала'), lines[0].text);
  });

  unloadOfficeState('o-contradictions-delegate');
  console.log(`\n«Пусть офис разберётся»: ${passed} проверок прошло`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
