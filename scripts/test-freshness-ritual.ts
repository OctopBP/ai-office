/**
 * Ритуал свежести журнала (freshness.ts через rituals.ts → forget) на заглушке
 * агента проверки. Стареющие факт, урок и решение офис проверяет сам:
 * «устарела» с основанием — архив с пометкой «заменена» и строкой в ленте,
 * «актуальна» — новая дата подтверждения, «не знаю» — отложена. Решение
 * владельцу по возрасту не уходит (T-690): соблюдаемое — подтверждается
 * молча, описание реализации — становится фактом, и только противоречие с
 * основанием — вопрос владельцу про эту одну запись; «В силе» её
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
import { isAllInForce, runFreshness } from '../src/server/freshness';
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
  const keptDec = office.addFact({ kind: 'decision', text: 'Хранилище — JSON-файл', scope: 'project' });
  const implDec = office.addFact({ kind: 'decision', text: 'Офисы в списке сортируются по дате открытия', scope: 'project' });
  const conflictDec = office.addFact({ kind: 'decision', text: 'Приоритет задачи по умолчанию normal', scope: 'project' });
  const bareConflictDec = office.addFact({ kind: 'decision', text: 'Отчёты исполнителя короткие', scope: 'project' });
  const outdatedDec = office.addFact({ kind: 'decision', text: 'Затор слияний разбираем руками', scope: 'project' });
  const fresh = office.addFact({ kind: 'decision', text: 'Свежее решение', scope: 'project' });
  const decisions = [keptDec, implDec, conflictDec, bareConflictDec, outdatedDec];
  for (const f of [staleFact, actualFact, unknownLesson, bareStale, ...decisions]) office.updateFact(f.id, { confirmedAt: old });

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
    { factId: keptDec.id, verdict: 'actual', reason: 'state.json на месте', basis: { kind: 'code', ref: 'src/server/state.ts' } },
    { factId: implDec.id, verdict: 'implementation', reason: 'это описание сортировки в коде' },
    // Основание — другая старая запись: «В силе» владельца её не подтверждает.
    { factId: conflictDec.id, verdict: 'contradicted', reason: 'в коде умолчание high', basis: { kind: 'newer', ref: bareStale.id } },
    { factId: bareConflictDec.id, verdict: 'contradicted', reason: 'кажется, отчёты длинные' },
    { factId: outdatedDec.id, verdict: 'stale', reason: 'затор разобран', basis: { kind: 'task', ref: 'T-56' } },
  ] });

  const stalesBefore = openQuestions(office).filter((q) => q.kind === 'stale').length;
  const logBefore = office.log.length;
  const run = await runRitual(office, 'forget');
  const staleQs = () => openQuestions(office).filter((q) => q.kind === 'stale');

  console.log('первый прогон');
  await check('агент получил на проверку факты, урок и старые решения, но не свежее', () => {
    assert.equal(calls, 1);
    for (const f of [staleFact, actualFact, unknownLesson, bareStale, ...decisions]) assert.ok(prompts[0].includes(`[${f.id}]`));
    assert.ok(!prompts[0].includes(`[${fresh.id}]`));
    assert.ok(prompts[0].includes('src/server/old-port.ts'), 'подсказка-файл в задании');
  });
  await check('старое соблюдаемое решение — новая дата, без вопроса владельцу', () => {
    const f = office.facts.get(keptDec.id)!;
    assert.equal(f.kind, 'decision');
    assert.ok(f.confirmedAt > old + 1000);
    assert.ok(isFreshnessChecked(office.life, f));
    assert.ok(!staleQs().some((q) => q.text.includes(keptDec.id)));
  });
  await check('описание реализации — переведено в факт, без вопроса владельцу', () => {
    const f = office.facts.get(implDec.id)!;
    assert.equal(f.kind, 'fact');
    assert.equal(f.status, 'live');
    assert.ok(f.confirmedAt > old + 1000);
    assert.ok(!staleQs().some((q) => q.text.includes(implDec.id)));
    assert.ok(office.log.slice(logBefore).some((l) => l.text.includes(`${implDec.id} — не решение владельца`)));
  });
  await check('явно устаревшее решение с основанием — в архив без вопроса, основание в ленте', () => {
    const f = office.facts.get(outdatedDec.id)!;
    assert.equal(f.status, 'archived');
    assert.equal(f.supersededBy, 'T-56');
    assert.ok(office.log.slice(logBefore).some((l) => l.text.includes(`${outdatedDec.id} устарела`) && l.text.includes('задача T-56')));
    assert.ok(!staleQs().some((q) => q.text.includes(outdatedDec.id)));
  });
  await check('противоречие — ровно один вопрос про одну запись, с сутью и основанием', () => {
    const qs = staleQs();
    assert.equal(qs.length - stalesBefore, 1);
    const q = qs[qs.length - 1];
    assert.ok(q.text.includes(conflictDec.id));
    assert.ok(q.text.includes('в коде умолчание high') && q.text.includes(`более новая запись ${bareStale.id}`), q.text);
    assert.deepEqual(q.quotes?.map((x) => x.ref), [conflictDec.id]);
    assert.ok(q.basis?.includes('в коде умолчание high'), String(q.basis));
    assert.deepEqual(q.options, ['В силе', 'Пересмотреть']);
    for (const d of [keptDec, implDec, bareConflictDec, outdatedDec, fresh]) assert.ok(!q.text.includes(d.id));
  });
  await check('противоречие без основания не спрашивается — отложено', () => {
    const f = office.facts.get(bareConflictDec.id)!;
    assert.equal(f.confirmedAt, old);
    assert.ok(!isFreshnessChecked(office.life, f));
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
    assert.equal(run?.produced.actual, 2);
    assert.equal(run?.produced.archived, 2);
    assert.equal(run?.produced.converted, 1);
    assert.equal(run?.produced.deferred, 3);
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
    for (const f of [actualFact, staleFact, keptDec, conflictDec, outdatedDec]) assert.ok(!prompts[1].includes(`[${f.id}]`), f.id);
    // Бывшее решение теперь факт с новой датой — ждёт своего срока.
    assert.ok(!prompts[1].includes(`[${implDec.id}]`));
    assert.ok(prompts[1].includes(`[${unknownLesson.id}]`) && prompts[1].includes(`[${bareStale.id}]`));
    assert.ok(prompts[1].includes(`[${bareConflictDec.id}]`));
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
  await check('«В силе» подтверждает решение из вопроса, но не запись-основание, и не плодит записей', () => {
    const q = staleQs()[staleQs().length - 1];
    const factsBefore = office.facts.size;
    assert.ok(answerQuestion(office, q.id, 'В силе'));
    assert.equal(office.facts.size, factsBefore);
    const f = office.facts.get(conflictDec.id)!;
    assert.ok(f.confirmedAt > old);
    assert.equal(f.askedAt, null);
    assert.ok(isFreshnessChecked(office.life, f));
    assert.equal(office.facts.get(bareStale.id)!.confirmedAt, old);
  });
  await check('подтверждённые решения не поднимаются, даже когда снова состарятся', async () => {
    for (const d of [keptDec, conflictDec]) office.updateFact(d.id, { confirmedAt: old });
    office.life.lastRun = {};
    const before = office.questions.size;
    await runRitual(office, 'forget');
    assert.equal(office.questions.size, before);
  });

  console.log('без агента проверки');
  await check('старое решение без агента ждёт, а не уходит владельцу', async () => {
    const lone = office.addFact({ kind: 'decision', text: 'Язык интерфейса — русский', scope: 'project' });
    office.updateFact(lone.id, { confirmedAt: old });
    const before = office.questions.size;
    const result = await runFreshness(office);
    assert.equal(office.questions.size, before);
    assert.equal(result.asked, 0);
    assert.equal(office.facts.get(lone.id)!.confirmedAt, old);
    assert.ok(!isFreshnessChecked(office.life, office.facts.get(lone.id)!));
  });

  unloadOfficeState('o-freshness-ritual');
  console.log(`\nритуал свежести: ${passed} проверок прошло`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
