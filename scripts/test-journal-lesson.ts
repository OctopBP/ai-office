/**
 * Поля урока в журнале (T-665): `cue` и `evidence`, пометка «без основания»,
 * чтение старого state.json без полей, хвост урока в промпте и основание в
 * задании ритуала свежести.
 *
 * Запуск: node --import tsx/esm scripts/test-journal-lesson.ts
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS, getOffice, openOfficeState, toFactView, unloadOfficeState } from '../src/server/state';
import { flushAll, save, wipe } from '../src/server/store';
import { journalBrief, STALE_AFTER_MS } from '../src/server/journal';
import { freshnessPrompt } from '../src/server/freshness';
import { EVIDENCE_MAX, lessonFields } from '../src/server/lesson';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('lessonFields');

check('урок с полями: обрезка пробелов, без повторов и пустых', () => {
  assert.deepEqual(lessonFields('lesson', { cue: '  когда правишь гейт ', evidence: ['T-12', ' T-12', '', 'J-40'] }), {
    cue: 'когда правишь гейт', evidence: ['T-12', 'J-40'],
  });
});

check('урок без основания — пометка, а не отказ', () => {
  assert.deepEqual(lessonFields('lesson', {}), { unfounded: true });
  assert.deepEqual(lessonFields('lesson', { evidence: [] }), { unfounded: true });
});

check('основание по умолчанию — задача, из которой урок родился', () => {
  assert.deepEqual(lessonFields('lesson', {}, ['T-7']), { evidence: ['T-7'] });
  assert.deepEqual(lessonFields('lesson', { evidence: ['J-1'] }, ['T-7']), { evidence: ['J-1'] });
});

check('факт и решение без основания не помечаются', () => {
  assert.deepEqual(lessonFields('fact', {}), {});
  assert.deepEqual(lessonFields('decision', {}), {});
});

check('мусор вместо полей не роняет', () => {
  assert.deepEqual(lessonFields('lesson', { cue: 5, evidence: 'T-3' }), { evidence: ['T-3'] });
  assert.deepEqual(lessonFields('lesson', { cue: '   ', evidence: [1, null, 'T-4'] }), { evidence: ['T-4'] });
  const many = Array.from({ length: 30 }, (_, i) => `T-${i}`);
  assert.equal(lessonFields('lesson', { evidence: many }).evidence?.length, EVIDENCE_MAX);
});

console.log('запись и промпт');

const office = getOffice('o-journal-lesson');
office.seed();

const withFields = office.addFact({
  kind: 'lesson', text: 'Тесты гонять через node --import tsx/esm', scope: 'project',
  cue: 'перед запуском тестов в песочнице', evidence: ['T-12', 'J-40', 'abc1234', 'T-13'],
});
const bare = office.addFact({ kind: 'lesson', text: 'Не читать state.ts целиком', scope: 'project' });
const plain = office.addFact({ kind: 'fact', text: 'Журнал лежит в journal.ts', scope: 'project' });

check('урок с полями сохраняет их и уезжает клиенту', () => {
  assert.equal(withFields.cue, 'перед запуском тестов в песочнице');
  assert.deepEqual(withFields.evidence, ['T-12', 'J-40', 'abc1234', 'T-13']);
  assert.equal(withFields.unfounded, undefined);
  const view = toFactView(withFields);
  assert.equal(view.cue, withFields.cue);
  assert.deepEqual(view.evidence, withFields.evidence);
});

check('урок без evidence помечен «без основания»', () => {
  assert.equal(bare.unfounded, true);
  assert.equal(toFactView(bare).unfounded, true);
  assert.equal(plain.unfounded, undefined);
  assert.ok(!('cue' in toFactView(plain)) && !('evidence' in toFactView(plain)));
});

check('блок журнала показывает cue и основание кратко', () => {
  const brief = journalBrief(office, null);
  assert.ok(brief.includes('- [урок] Тесты гонять через node --import tsx/esm (когда: перед запуском тестов в песочнице; основание: T-12, J-40, abc1234 и ещё 1)'), brief);
  assert.ok(brief.includes('- [урок] Не читать state.ts целиком (без основания)'), brief);
  assert.match(brief, /^- \[факт\] Журнал лежит в journal\.ts$/m);
});

check('ритуал свежести получает основание урока', () => {
  const now = Date.now() + STALE_AFTER_MS;
  const prompt = freshnessPrompt(office, [withFields, bare, plain], now);
  assert.ok(prompt.includes('Основание урока: T-12, J-40, abc1234, T-13'), prompt);
  assert.ok(prompt.includes('Когда применять: перед запуском тестов в песочнице'), prompt);
  assert.ok(prompt.includes('Основание урока: нет'), prompt);
  assert.equal(prompt.split('Основание урока').length - 1, 2, 'у факта основания нет');
});

console.log('state.json');

check('старые записи без полей читаются как раньше, новые — с полями', () => {
  const file = resolve(tmpdir(), `office-test-lesson-${process.pid}.json`);
  const dir = resolve(tmpdir(), 'lesson-office');
  const at = Date.now();
  const old = { id: 'J-1', kind: 'lesson', text: 'старый урок', scope: 'project', source: {}, createdAt: at, confirmedAt: at };
  save(file, () => ({
    version: 1, projectDir: dir, taskSeq: 0, tasks: [], chat: [], log: [],
    instances: [], settings: { ...DEFAULT_SETTINGS }, savedAt: at, factSeq: 3,
    facts: [
      old,
      { ...old, id: 'J-2', text: 'новый урок', cue: 'когда', evidence: ['T-1'], status: 'live', askedAt: null },
      { ...old, id: 'J-3', text: 'урок без основания', unfounded: true, evidence: 'мусор-не-массив' },
    ] as never, // файл руками и старый формат — тип записи тут намеренно не совпадает
  }));
  flushAll();
  const loaded = openOfficeState({ id: 'o-lesson-load', projectDir: dir, stateFile: file }).state;
  try {
    const j1 = loaded.facts.get('J-1')!;
    assert.equal(j1.status, 'live');
    assert.equal(j1.askedAt, null);
    assert.equal(j1.cue, undefined);
    assert.equal(j1.evidence, undefined);
    // Задним числом «без основания» не ставим: поле появилось позже записи.
    assert.equal(j1.unfounded, undefined);
    const j2 = loaded.facts.get('J-2')!;
    assert.equal(j2.cue, 'когда');
    assert.deepEqual(j2.evidence, ['T-1']);
    const j3 = loaded.facts.get('J-3')!;
    assert.deepEqual(j3.evidence, ['мусор-не-массив']);
    assert.equal(j3.unfounded, undefined, 'основание нашлось — пометка снята');
    // Старый урок в промпте — как раньше, без хвоста в скобках.
    assert.match(journalBrief(loaded, null), /\] старый урок$/m);
  } finally {
    unloadOfficeState('o-lesson-load');
    wipe(file);
  }
});

unloadOfficeState('o-journal-lesson');
console.log(`\n${passed} проверок прошло`);
