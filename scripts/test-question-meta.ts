/**
 * Разметка вопросов владельцу (T-587, T-589 — схема спеки owner-questions-simple
 * §7): короткая суть, подробности, цитаты, основание, ссылки, подтверждение и
 * группа. Ритуал противоречий на заглушке агента разбора раскладывает цитаты
 * в quotes, вывод разбора в basis, записи и коммиты в refs, а вывод
 * превращает в confirm + proposal; подтверждение кнопкой proposal и ответом
 * «Согласен: …» дают один исход. Свежесть решений — цитаты и группа. ask_owner принимает
 * title и details. Старый вопрос без новых полей читается, показывается
 * текстом и отвечается как раньше. Тексты выпуска и согласования не
 * повторяют кнопки словами «Нажмите…».
 *
 * Запуск: npm run test:question-meta
 */
import assert from 'node:assert/strict';
import type { OwnerQuestion } from '../src/shared/types';
import { OFFICE_SENDER } from '../src/shared/types';
import {
  confirmAnswer, confirmedProposal, QUESTION_META_KEYS, questionHeadline, questionTitle, refsInText, tidyQuestionMeta,
} from '../src/shared/questions';
import { runFreshness } from '../src/server/freshness';
import { getOffice, unloadOfficeState } from '../src/server/state';
import { CONTRADICTION_GROUP, runRitual, setRitualAgents, type RitualOutput } from '../src/server/rituals';
import { answerQuestion, askOwner, editQuestion, officeAsks, openQuestions, settleDelegations } from '../src/server/questions';
import { t } from '../src/server/i18n';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const empty = (): RitualOutput => ({ facts: [], contradictions: [], questions: [], costUsd: 0 });
const DELEGATE = 'Пусть офис разберётся';
const OFFICE_ID = 'o-question-meta';

async function main(): Promise<void> {
  console.log('короткая суть');
  await check('без номеров записей и хешей, одна строка, не длиннее 120', () => {
    assert.equal(questionTitle('Верна J-200, а J-201 устарела: коммит 6f08d70 в main'), 'Верна, а устарела: коммит в main');
    assert.equal(questionTitle('  две\nстроки  '), 'две строки');
    const long = questionTitle('слово '.repeat(60));
    assert.ok(long.length <= 120 && long.endsWith('…'), long);
    assert.equal(questionTitle(undefined), '');
  });
  await check('пустая разметка не хранится; proposal — признак подтверждения, confirm без proposal не хранится', () => {
    assert.deepEqual(tidyQuestionMeta({
      title: '  ', details: '', groupKey: ' ', basis: ' ', quotes: [{ ref: 'J-1', text: ' ' }], refs: [{ kind: 'task', id: ' ' }],
    }), {});
    assert.deepEqual(tidyQuestionMeta({ proposal: 'да' }), { confirm: true, proposal: 'да' });
    assert.deepEqual(tidyQuestionMeta({ confirm: true }), {});
    assert.deepEqual(tidyQuestionMeta({ confirm: true, proposal: ' да ' }), { confirm: true, proposal: 'да' });
  });
  await check('цитаты, основание, ссылки и группа нормализуются', () => {
    const got = tidyQuestionMeta({
      quotes: [{ ref: ' J-1 ', text: ' раз ', note: ' ' }, { ref: '', text: 'без ссылки' }],
      basis: ' коммит 6f08d70 ',
      refs: [{ kind: 'journal', id: 'J-1' }, { kind: 'journal', id: 'J-1' }, { kind: 'bogus' as 'file', id: 'x' }, { kind: 'commit', id: '6f08d70' }],
      groupTitle: 'без ключа', groupOptions: ['да'],
    });
    assert.deepEqual(got, {
      quotes: [{ ref: 'J-1', text: 'раз' }], basis: 'коммит 6f08d70',
      refs: [{ kind: 'journal', id: 'J-1' }, { kind: 'commit', id: '6f08d70' }],
    });
    assert.deepEqual(tidyQuestionMeta({ groupKey: 'g', groupTitle: ' тема ', groupOptions: ['Да', 'да', ' ', 'Нет'] }),
      { groupKey: 'g', groupTitle: 'тема', groupOptions: ['Да', 'Нет'] });
  });
  await check('ссылки из текста: записи, задачи, коммиты, файлы', () => {
    assert.deepEqual(refsInText('J-2 против J-3, T-40, коммит 75d09a6 в src/server/rolebase.ts'), [
      { kind: 'journal', id: 'J-2' }, { kind: 'journal', id: 'J-3' }, { kind: 'task', id: 'T-40' },
      { kind: 'commit', id: '75d09a6' }, { kind: 'file', id: 'src/server/rolebase.ts' },
    ]);
  });
  await check('«Согласен: …» узнаётся как подтверждение, «Нет, иначе» и чужое — нет', () => {
    const q = { proposal: 'J-5: оставить новую запись' };
    assert.equal(confirmAnswer(q.proposal), 'Согласен: J-5: оставить новую запись');
    assert.equal(confirmedProposal(q, confirmAnswer(q.proposal)), q.proposal);
    assert.equal(confirmedProposal(q, 'согласен'), q.proposal);
    assert.equal(confirmedProposal(q, q.proposal), q.proposal);
    assert.equal(confirmedProposal(q, 'Согласен: J-5: оставить'), q.proposal);
    assert.equal(confirmedProposal(q, 'Согласен: верна J-4'), null);
    assert.equal(confirmedProposal(q, 'Нет, верна J-4'), null);
    assert.equal(confirmedProposal({}, 'Согласен'), null);
  });

  const office = getOffice(OFFICE_ID);
  office.seed();
  office.opened = true;
  office.settings.ritualsEnabled = true;
  office.settings.model = { provider: 'claude-code', model: 'claude-sonnet-5-5' };

  // Два решения владельца: офис сам их не перерешивает, но вывод разбора предлагает.
  const oldOne = office.addFact({ kind: 'decision', text: 'Менеджер только предлагает зону, заводит её владелец', scope: 'project' });
  const newOne = office.addFact({ kind: 'decision', text: 'set_role_base с path сам заводит repo-зону', scope: 'project' });

  let flagged: RitualOutput['contradictions'] = [];
  let verdictJson = '';
  setRitualAgents({
    async consolidate() { return empty(); },
    async contradictions() { return { ...empty(), contradictions: flagged }; },
    async reflect() { return { ...empty(), features: [], rules: [], summary: '' }; },
    async resolveContradiction() { return { text: verdictJson, costUsd: 0.01 }; },
  });
  const contradictions = (): OwnerQuestion[] => openQuestions(office).filter((q) => q.kind === 'contradiction');

  console.log('вопрос о противоречии с выводом разбора');
  flagged = [{ a: `${oldOne.id} ${oldOne.text}`, b: `${newOne.id} ${newOne.text}`, text: `Кто заводит зону (${oldOne.id}) — коммит 75d09a6` }];
  verdictJson = JSON.stringify({
    kind: 'stale', keepId: newOne.id, forgetId: oldOne.id,
    reason: 'set_role_base заводит зону сам, коммит 75d09a6', evidence: 'src/server/rolebase.ts',
  });
  await runRitual(office, 'contradictions');
  const q = contradictions()[0];
  await check('есть title без номеров записей и хешей', () => {
    assert.ok(q, 'вопроса нет');
    assert.ok(q.title, 'нет title');
    assert.ok(q.title!.length <= 120, q.title);
    assert.ok(!/\bJ-\d+\b/.test(q.title!), q.title);
    assert.ok(!/75d09a6/.test(q.title!), q.title);
    assert.ok(q.title!.includes('Кто заводит зону'), q.title);
  });
  await check('quotes — цитаты обеих сторон с id записей', () => {
    assert.deepEqual(q.quotes?.map((x) => x.ref), [oldOne.id, newOne.id]);
    assert.equal(q.quotes![0].text, oldOne.text);
    assert.equal(q.quotes![0].note, 'решение');
  });
  await check('basis — вывод разбора, без служебной приписки', () => {
    assert.ok(q.basis?.includes('set_role_base заводит зону сам'), String(q.basis));
    assert.ok(q.basis!.includes('rolebase.ts'), String(q.basis));
    assert.ok(!/ваши решения/.test(q.basis!), String(q.basis));
  });
  await check('refs — записи сторон, коммит и файл', () => {
    const ids = q.refs?.map((r) => `${r.kind}:${r.id}`) ?? [];
    for (const want of [`journal:${oldOne.id}`, `journal:${newOne.id}`, 'commit:75d09a6', 'file:src/server/rolebase.ts']) {
      assert.ok(ids.includes(want), `${want} нет в ${ids.join(', ')}`);
    }
  });
  await check('details — полный вопрос с номерами, цитаты в нём не повторяются', () => {
    assert.ok(q.details?.includes(oldOne.id) && q.details.includes('75d09a6'), String(q.details));
    assert.ok(!q.details!.includes(newOne.text), String(q.details));
  });
  await check('confirm и proposal — оставить верную запись; proposal среди кнопок', () => {
    assert.equal(q.confirm, true);
    assert.ok(q.proposal?.startsWith(`${newOne.id}:`), String(q.proposal));
    assert.ok(q.options?.includes(q.proposal!), JSON.stringify(q.options));
  });
  await check('groupKey и groupTitle — противоречия журнала, общий ответ группы, «Пусть офис разберётся» на месте', () => {
    assert.equal(q.groupKey, CONTRADICTION_GROUP);
    assert.equal(q.groupTitle, 'про расхождения в журнале');
    assert.deepEqual(q.groupOptions, ['Верны обе, это разные случаи', DELEGATE]);
    assert.equal(q.options?.at(-1), DELEGATE);
    assert.ok(q.options!.length <= 4);
  });
  await check('полный текст как раньше: разбор ответа по нему работает', () => {
    assert.ok(q.text.startsWith('Журнал разошёлся сам с собой'), q.text);
    assert.ok(q.text.includes(oldOne.id) && q.text.includes(newOne.id));
  });
  await check('подтверждение (ответ текстом proposal) убирает устаревшую запись', () => {
    assert.ok(answerQuestion(office, q.id, q.proposal!));
    assert.ok(office.facts.get(oldOne.id)?.supersededBy, 'старая запись не заменена');
    assert.ok(!office.facts.get(newOne.id)?.supersededBy);
  });

  console.log('«Согласен: …» — тот же исход, что кнопка proposal');
  // Вторая такая же пара: на неё ответим словами веба, а не кнопкой.
  const oldTwo = office.addFact({ kind: 'decision', text: 'Отчёт исполнителя пишется по-английски', scope: 'project' });
  const newTwo = office.addFact({ kind: 'decision', text: 'Отчёт исполнителя пишется на языке общения офиса', scope: 'project' });
  flagged = [{ a: `${oldTwo.id} ${oldTwo.text}`, b: `${newTwo.id} ${newTwo.text}`, text: 'На каком языке отчёт исполнителя' }];
  verdictJson = JSON.stringify({
    kind: 'stale', keepId: newTwo.id, forgetId: oldTwo.id, reason: 'язык общения задан настройкой офиса', evidence: 'src/server/agents.ts',
  });
  await runRitual(office, 'contradictions');
  const q2 = contradictions().find((x) => x.text.includes(oldTwo.id))!;
  await check('ответ «Согласен: {proposal}» принят и применяет proposal', () => {
    assert.ok(q2?.proposal, 'нет proposal');
    assert.ok(answerQuestion(office, q2.id, confirmAnswer(q2.proposal!)));
    assert.ok(office.facts.get(oldTwo.id)?.supersededBy, 'старая запись не заменена');
    assert.ok(!office.facts.get(newTwo.id)?.supersededBy);
    assert.equal(office.questions.get(q2.id)?.answer, q2.proposal);
  });
  await check('исход как у кнопки: в журнале решение, обе устаревшие записи в архиве одинаково', () => {
    const byButton = office.factList().find((f) => f.source.questionId === q.id)!;
    const byAgree = office.factList().find((f) => f.source.questionId === q2.id)!;
    assert.equal(byAgree.kind, byButton.kind);
    assert.equal(byAgree.kind, 'decision');
    assert.ok(byAgree.text.includes('Согласен'), byAgree.text);
    assert.equal(office.facts.get(oldTwo.id)?.status, office.facts.get(oldOne.id)?.status);
  });

  console.log('вопрос о противоречии без вывода');
  const portA = office.addFact({ kind: 'fact', text: 'Порт сервера по умолчанию 3002', scope: 'project' });
  const portB = office.addFact({ kind: 'fact', text: 'Порт сервера по умолчанию 3001', scope: 'project' });
  flagged = [{ a: `${portA.id} ${portA.text}`, b: `${portB.id} ${portB.text}`, text: 'какой порт' }];
  verdictJson = JSON.stringify({ kind: 'unresolved', reason: 'в коде нет порта' });
  await runRitual(office, 'contradictions');
  const plain = contradictions().find((x) => x.text.includes(portA.id))!;
  await check('title, details, groupKey есть, confirm нет', () => {
    assert.ok(plain, 'вопроса нет');
    assert.ok(plain.title && !/\bJ-\d+\b/.test(plain.title), String(plain.title));
    assert.ok(plain.basis?.includes('в коде нет порта'), String(plain.basis));
    assert.deepEqual(plain.quotes?.map((x) => x.ref), [portA.id, portB.id]);
    assert.equal(plain.groupKey, CONTRADICTION_GROUP);
    assert.equal(plain.groupTitle, 'про расхождения в журнале');
    assert.equal(plain.confirm, undefined);
    assert.equal(plain.proposal, undefined);
  });
  await check('«Согласен» без предложения — обычный свободный ответ', () => {
    const other = { ...plain, proposal: undefined };
    assert.equal(confirmedProposal(other, 'Согласен'), null);
  });
  await check('«Пусть офис разберётся» по-прежнему поручение, а не факт', async () => {
    const before = office.factList().filter((f) => f.source.questionId).length;
    assert.ok(answerQuestion(office, plain.id, DELEGATE));
    await settleDelegations();
    assert.equal(office.factList().filter((f) => f.source.questionId).length, before);
  });

  console.log('свежесть решений');
  const aged = office.addFact({ kind: 'decision', text: 'Хранилище — JSON-файл, не БД', scope: 'project' });
  office.updateFact(aged.id, { confirmedAt: Date.now() - 90 * 86_400_000 });
  // Владельца спрашивают только о решении, с которым проверка нашла противоречие.
  await runFreshness(office, Date.now(), async () => ({
    text: JSON.stringify({ verdicts: [{
      factId: aged.id, verdict: 'contradicted', reason: 'в коде появилась БД', basis: { kind: 'code', ref: 'src/server/db.ts:open' },
    }] }),
    costUsd: 0,
  }));
  const fresh = openQuestions(office).find((x) => x.kind === 'stale' && x.text.includes(aged.id));
  await check('цитата решения, основание, ссылки на запись и файл, группа с темой и общим ответом', () => {
    assert.ok(fresh, 'вопроса о свежести нет');
    assert.deepEqual(fresh!.quotes?.map((x) => x.ref), [aged.id]);
    assert.equal(fresh!.quotes![0].text, aged.text);
    assert.ok(fresh!.refs?.some((r) => r.kind === 'journal' && r.id === aged.id), JSON.stringify(fresh!.refs));
    assert.ok(fresh!.refs?.some((r) => r.kind === 'file' && r.id === 'src/server/db.ts'), JSON.stringify(fresh!.refs));
    assert.ok(fresh!.basis?.includes('в коде появилась БД'), String(fresh!.basis));
    assert.ok(fresh!.title && !/\bJ-\d+\b/.test(fresh!.title), String(fresh!.title));
    assert.equal(fresh!.groupKey, 'journal-freshness');
    assert.equal(fresh!.groupTitle, 'про свежесть решений');
    assert.deepEqual(fresh!.groupOptions, ['В силе', 'Пересмотреть']);
  });

  console.log('ask_owner с title и details');
  const asked = askOwner(office, 'pm#1', null, 'Делаем тёмную тему в 0.15 или откладываем?', 'откладываем', ['Делаем', 'Откладываем'], [], null,
    { title: 'Тёмная тема: делаем сейчас? (J-12, 6f08d70)', details: 'Просили в T-40 и T-41.' }).question!;
  await check('title почищен, details сохранены, варианты на месте', () => {
    assert.equal(asked.title, 'Тёмная тема: делаем сейчас?');
    assert.equal(asked.details, 'Просили в T-40 и T-41.');
    assert.deepEqual(asked.options, ['Делаем', 'Откладываем']);
  });
  await check('правка текста без новой сути снимает устаревшую суть', () => {
    assert.ok(editQuestion(office, asked.id, { text: 'Тёмная тема: в 0.15 или в 0.16?' }).ok);
    assert.equal(office.questions.get(asked.id)?.title, undefined);
    assert.equal(questionHeadline(office.questions.get(asked.id)!), 'Тёмная тема: в 0.15 или в 0.16?');
  });

  console.log('старый вопрос без новых полей');
  // Так вопрос лежит в state.json, сохранённом до T-587: ни одного нового поля.
  const legacy: OwnerQuestion = JSON.parse(JSON.stringify({
    id: 'Q-900', from: OFFICE_SENDER, taskId: null, kind: 'assumption',
    text: 'Пагинация: по 20 или по 50?', assumption: 'по 20', options: ['по 20', 'по 50'],
    askedAt: Date.now(), shownAt: null, answer: null, answeredAt: null, dismissedAt: null,
  }));
  office.questions.set(legacy.id, legacy);
  await check('читается: открыт, заголовок — весь текст, разметки нет', () => {
    const got = office.questions.get('Q-900')!;
    assert.ok(openQuestions(office).some((x) => x.id === 'Q-900'));
    assert.equal(questionHeadline(got), got.text);
    for (const key of QUESTION_META_KEYS) assert.equal(got[key], undefined, key);
  });
  await check('отвечается как раньше: ответ в журнал фактом', () => {
    assert.ok(answerQuestion(office, 'Q-900', 'по 50'));
    const fact = office.factList().find((f) => f.source.questionId === 'Q-900');
    assert.ok(fact?.text.includes('Пагинация: по 20 или по 50?') && fact.text.includes('по 50'), String(fact?.text));
  });
  const bare = officeAsks(office, 'assumption', 'Чистим старые ветки?', 'чистим');
  await check('вопрос офиса без разметки заводится без новых полей', () => {
    for (const key of QUESTION_META_KEYS) assert.ok(!(key in bare), key);
  });

  console.log('тексты не повторяют кнопки');
  await check('выпуск, проверка выпуска, цель выпуска и согласование задачи — без «Нажмите…»', () => {
    for (const lang of ['ru', 'en'] as const) {
      for (const key of ['rel.ask', 'rel.visible.ask', 'rel.setup.ask', 'wf.gateAsk'] as const) {
        const text = t(lang, key, {});
        assert.ok(!/Нажмите|нажать|Press|press/.test(text), `${lang} ${key}: ${text}`);
      }
    }
  });

  unloadOfficeState(OFFICE_ID);
  console.log(`\nРазметка вопросов владельцу: ${passed} проверок прошло`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
