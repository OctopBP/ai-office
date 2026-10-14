/**
 * Ритуал свежести журнала (freshness.ts через rituals.ts → forget) на заглушке
 * агента проверки. Стареющие факт и урок офис проверяет сам: «устарела» с
 * основанием — архив с пометкой «заменена» и строкой в ленте, «актуальна» —
 * новая дата подтверждения, «не знаю» — отложена. Все решения, которые пора
 * подтвердить, — один вопрос владельцу за прогон; «Все в силе» их
 * подтверждает. Разобранная запись повторно не поднимается, пока её не
 * переписали.
 *
 * Запуск: node --import tsx/esm scripts/test-freshness-ritual.ts
 */
import assert from 'node:assert/strict';
import { getOffice, unloadOfficeState } from '../src/server/state';
import { runRitual, setRitualAgents, type RitualOutput } from '../src/server/rituals';
import { answerQuestion, openQuestions } from '../src/server/questions';
import { STALE_AFTER_MS, factsFor } from '../src/server/journal';
import { isAllInForce } from '../src/server/freshness';
import { isFreshnessChecked, parseFreshnessVerdicts } from '../src/server/staleness';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const empty = (): RitualOutput => ({ facts: [], contradictions: [], questions: [], costUsd: 0 });

async function main(): Promise<void> {
  console.log('разбор ответа');
  await check('вердикты из JSON с текстом вокруг', () => {
    const v = parseFreshnessVerdicts('Вот: ```json\n{"verdicts":[{"factId":"J-1","verdict":"stale","reason":"нет","basis":{"kind":"code","ref":"src/a.ts"}},{"factId":"x","verdict":"actual"}]}\n```');
    assert.equal(v.length, 1);
    assert.deepEqual(v[0].basis, { kind: 'code', ref: 'src/a.ts' });
  });
  await check('голый массив и мусор', () => {
    assert.equal(parseFreshnessVerdicts('[{"factId":"J-2","verdict":"actual","reason":"ок"}]').length, 1);
    assert.equal(parseFreshnessVerdicts('не знаю').length, 0);
    assert.equal(parseFreshnessVerdicts('{"verdicts": 5}').length, 0);
  });
  await check('«Все в силе» и «Пересмотреть» различаются', () => {
    assert.ok(isAllInForce('Все в силе'));
    assert.ok(isAllInForce('да'));
    assert.ok(isAllInForce('All in force'));
    assert.ok(!isAllInForce('Пересмотреть'));
    assert.ok(!isAllInForce('не в силе'));
    assert.ok(!isAllInForce('да, но J-3 пересмотреть'));
  });

  const office = getOffice('o-freshness-ritual');
  office.seed();
  office.opened = true;
  office.settings.ritualsEnabled = true;
  office.settings.model = { provider: 'claude-code', model: 'claude-sonnet-5-5' };

  const old = Date.now() - STALE_AFTER_MS - 60_000;
  const staleFact = office.addFact({ kind: 'fact', text: 'Порт сервера задаётся в src/server/old-port.ts', scope: 'project' });
  const actualFact = office.addFact({ kind: 'fact', text: 'Журнал лежит в `journal.ts`', scope: 'project' });
  const unknownLesson = office.addFact({ kind: 'lesson', text: 'Большие файлы читать срезами', scope: 'project' });
  const bareStale = office.addFact({ kind: 'fact', text: 'Кнопка экспорта в шапке', scope: 'project' });
  const dec1 = office.addFact({ kind: 'decision', text: 'Хранилище — JSON-файл', scope: 'project' });
  const dec2 = office.addFact({ kind: 'decision', text: 'Приоритет задачи по умолчанию normal', scope: 'project' });
  const fresh = office.addFact({ kind: 'decision', text: 'Свежее решение', scope: 'project' });
  for (const f of [staleFact, actualFact, unknownLesson, bareStale, dec1, dec2]) office.updateFact(f.id, { confirmedAt: old });

  let reply = '';
  let calls = 0;
  const prompts: string[] = [];
  setRitualAgents({
    async consolidate() { return empty(); },
    async contradictions() { return empty(); },
    async reflect() { return { ...empty(), features: [], rules: [], summary: '' }; },
    async checkFreshness(_state, prompt) {
      calls += 1;
      prompts.push(prompt);
      return { text: reply, costUsd: 0.03 };
    },
  });
  reply = JSON.stringify({ verdicts: [
    { factId: staleFact.id, verdict: 'stale', reason: 'файла больше нет', basis: { kind: 'code', ref: 'src/server/index.ts:PORT' } },
    { factId: actualFact.id, verdict: 'actual', reason: 'файл на месте', basis: { kind: 'code', ref: 'src/server/journal.ts' } },
    { factId: unknownLesson.id, verdict: 'unknown', reason: 'это про привычку' },
    { factId: bareStale.id, verdict: 'stale', reason: 'кажется, убрали' },
  ] });

  const stalesBefore = openQuestions(office).filter((q) => q.kind === 'stale').length;
  const logBefore = office.log.length;
  const run = await runRitual(office, 'forget');
  const staleQs = () => openQuestions(office).filter((q) => q.kind === 'stale');

  console.log('первый прогон');
  await check('агент получил на проверку факты и урок, но не решения', () => {
    assert.equal(calls, 1);
    for (const f of [staleFact, actualFact, unknownLesson, bareStale]) assert.ok(prompts[0].includes(`[${f.id}]`));
    for (const f of [dec1, dec2, fresh]) assert.ok(!prompts[0].includes(`[${f.id}]`));
    assert.ok(prompts[0].includes('src/server/old-port.ts'), 'подсказка-файл в задании');
  });
  await check('владелец получил ровно один вопрос со всеми решениями и вариантами', () => {
    const qs = staleQs();
    assert.equal(qs.length - stalesBefore, 1);
    const q = qs[qs.length - 1];
    assert.ok(q.text.includes(dec1.id) && q.text.includes(dec2.id));
    assert.ok(!q.text.includes(fresh.id));
    assert.deepEqual(q.options, ['Все в силе', 'Пересмотреть']);
  });
  await check('устаревший факт — в архиве с пометкой «заменена» и строкой в ленте с основанием', () => {
    const f = office.facts.get(staleFact.id)!;
    assert.equal(f.status, 'archived');
    assert.equal(f.supersededBy, 'src/server/index.ts:PORT');
    assert.ok(!factsFor(office, null).some((x) => x.id === staleFact.id));
    const line = office.log.slice(logBefore).find((l) => l.text.includes(`${staleFact.id} устарела`));
    assert.ok(line, 'нет строки в ленте');
    assert.ok(line!.text.includes('файла больше нет') && line!.text.includes('код src/server/index.ts:PORT'));
  });
  await check('«устарела» без основания не архивирует — отложена', () => {
    assert.equal(office.facts.get(bareStale.id)?.status, 'live');
    assert.ok(!isFreshnessChecked(office.life, office.facts.get(bareStale.id)!));
  });
  await check('актуальный факт получил новую дату подтверждения', () => {
    assert.ok(office.facts.get(actualFact.id)!.confirmedAt > old + 1000);
  });
  await check('«не знаю» откладывается: запись жива и не отмечена разобранной', () => {
    assert.equal(office.facts.get(unknownLesson.id)?.status, 'live');
    assert.equal(office.facts.get(unknownLesson.id)?.confirmedAt, old);
  });
  await check('прогон посчитан с ценой проверки', () => {
    assert.equal(run?.ritual, 'forget');
    assert.equal(run?.costUsd, 0.03);
    assert.equal(run?.produced.asked, 1);
    assert.equal(run?.produced.actual, 1);
    assert.equal(run?.produced.archived, 1);
    assert.equal(run?.produced.deferred, 2);
  });

  console.log('второй прогон');
  // Разобранный актуальный факт состарим снова — без правки текста он не поднимается.
  office.updateFact(actualFact.id, { confirmedAt: old });
  reply = JSON.stringify({ verdicts: [{ factId: unknownLesson.id, verdict: 'actual', reason: 'правило в брифе', basis: { kind: 'code', ref: 'OFFICE.md' } }] });
  office.life.lastRun = {};
  const questionsBefore = office.questions.size;
  await runRitual(office, 'forget');
  await check('решения второй раз не спрашиваются, новых вопросов нет', () => {
    assert.equal(office.questions.size, questionsBefore);
  });
  await check('разобранная запись не поднимается повторно, отложенные — поднимаются', () => {
    assert.ok(!prompts[1].includes(`[${actualFact.id}]`));
    assert.ok(!prompts[1].includes(`[${staleFact.id}]`));
    assert.ok(prompts[1].includes(`[${unknownLesson.id}]`) && prompts[1].includes(`[${bareStale.id}]`));
    assert.ok(office.facts.get(unknownLesson.id)!.confirmedAt > old);
  });
  await check('переписанная запись поднимается снова', async () => {
    office.updateFact(actualFact.id, { text: 'Журнал лежит в `journal.ts` и `superseded.ts`', confirmedAt: old });
    office.life.lastRun = {};
    reply = '';
    await runRitual(office, 'forget');
    assert.ok(prompts[2].includes(`[${actualFact.id}]`));
  });

  console.log('ответ владельца');
  await check('«Все в силе» подтверждает каждое решение и не плодит записей', () => {
    const q = staleQs()[staleQs().length - 1];
    const factsBefore = office.facts.size;
    assert.ok(answerQuestion(office, q.id, 'Все в силе'));
    assert.equal(office.facts.size, factsBefore);
    for (const d of [dec1, dec2]) {
      const f = office.facts.get(d.id)!;
      assert.ok(f.confirmedAt > old);
      assert.equal(f.askedAt, null);
      assert.ok(isFreshnessChecked(office.life, f));
    }
  });
  await check('подтверждённые решения не поднимаются, даже когда снова состарятся', async () => {
    for (const d of [dec1, dec2]) office.updateFact(d.id, { confirmedAt: old });
    office.life.lastRun = {};
    const before = office.questions.size;
    await runRitual(office, 'forget');
    assert.equal(office.questions.size, before);
  });

  unloadOfficeState('o-freshness-ritual');
  console.log(`\nритуал свежести: ${passed} проверок прошло`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
