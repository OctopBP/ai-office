/**
 * Подача вопросов владельцу (T-590, спека owner-questions-simple §2–§5):
 * запасной заголовок и вырезание приписок у старых вопросов, две группы,
 * сворачивание однотипных, общие варианты, очередь с пропуском и полоса прогресса.
 *
 * Запуск: npm run test:question-queue
 */
import assert from 'node:assert/strict';
import type { OwnerQuestion } from '../src/shared/types';
import {
  buildCards, buildQueue, cardTitle, commonAssumption, commonOptions, proposalLine, queueSegments,
  splitGroups, stripBoilerplate, titleFallback,
} from '../src/shared/questions';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

let seq = 0;
const q = (over: Partial<OwnerQuestion> = {}): OwnerQuestion => ({
  id: `Q-${++seq}`, from: 'office', taskId: null, kind: 'assumption', text: 'Текст?', assumption: '',
  askedAt: seq * 1000, shownAt: null, answer: null, answeredAt: null, dismissedAt: null, ...over,
});

check('запасной заголовок: первое предложение без приписок, номеров и хешей', () => {
  const text = 'Выпуск 0.14.0-beta.1 готов, выпускать? Нажмите «Выпускай», напишите другую версию — или «Не сейчас».';
  assert.equal(titleFallback({ text }), 'Выпуск 0.14.0-beta.1 готов, выпускать?');
  assert.equal(titleFallback({ text: 'J-8: поддерживает ли UI картинки (abc1234def)? Подробнее ниже.' }),
    'поддерживает ли UI картинки?');
  assert.equal(cardTitle({ title: ' Коротко ', text: 'Длинно. Очень.' }), 'Коротко');
  assert.ok(titleFallback({ text: 'слово '.repeat(60) }).length <= 120);
});

check('служебные приписки вырезаются, а если вырезать нечего кроме них — текст цел', () => {
  assert.equal(stripBoilerplate('Журнал разошёлся. Обе записи — ваши решения, офис их сам не перерешивает.'), 'Журнал разошёлся.');
  assert.equal(stripBoilerplate('Нажмите «Да».'), 'Нажмите «Да».');
});

check('предложение офиса длиннее 120 знаков режется до первого предложения', () => {
  assert.equal(proposalLine('Убрать запись в архив.'), 'Убрать запись в архив.');
  const long = `Убрать запись в архив. ${'потому что '.repeat(20)}`;
  assert.equal(proposalLine(long), 'Убрать запись в архив.');
});

check('две группы: решения и подтверждения, старые сверху', () => {
  const a = q({ askedAt: 30 });
  const b = q({ askedAt: 10, proposal: 'Архив' });
  const c = q({ askedAt: 20 });
  const { decide, confirm } = splitGroups([a, b, c]);
  assert.deepEqual(decide.map((x) => x.id), [c.id, a.id]);
  assert.deepEqual(confirm.map((x) => x.id), [b.id]);
});

check('одинаковый groupKey — одна карточка на месте первого; одиночный ключ не группируется', () => {
  const g1 = q({ groupKey: 'k', askedAt: 1 });
  const solo = q({ askedAt: 2 });
  const g2 = q({ groupKey: 'k', askedAt: 3 });
  const lone = q({ groupKey: 'z', askedAt: 4 });
  const cards = buildCards([g2, lone, solo, g1], 'decide');
  assert.deepEqual(cards.map((c) => c.id), ['group:decide:k', solo.id, lone.id]);
  assert.equal(cards[0]!.questions.length, 2);
  assert.equal(cards[0]!.grouped, true);
  assert.equal(cards[2]!.grouped, false);
});

check('общие варианты: совпали по тексту без регистра, groupOptions главнее, разные — пусто', () => {
  const same = [q({ options: ['Да', 'Нет'] }), q({ options: ['да', 'нет'] })];
  assert.deepEqual(commonOptions(same), ['Да', 'Нет']);
  const diff = [q({ options: ['Да', 'Нет'] }), q({ options: ['Да', 'Позже'] })];
  assert.deepEqual(commonOptions(diff), []);
  const declared = [q({ options: ['Да', 'Нет'], groupOptions: ['Реши сам'] }), q({ options: ['Другое'] })];
  assert.deepEqual(commonOptions(declared), ['Реши сам']);
  assert.deepEqual(commonOptions([q(), q()]), []);
});

check('допущение группы показывается, только если у всех одно', () => {
  assert.equal(commonAssumption([q({ assumption: 'х' }), q({ assumption: 'х' })]), 'х');
  assert.equal(commonAssumption([q({ assumption: 'х' }), q({ assumption: 'у' })]), '');
});

check('очередь: решения, затем подтверждения; пропущенный уходит в конец своей группы', () => {
  const d1 = q({ askedAt: 1 });
  const d2 = q({ askedAt: 2 });
  const c1 = q({ askedAt: 0, proposal: 'П' });
  assert.deepEqual(buildQueue([c1, d2, d1]).map((c) => c.id), [d1.id, d2.id, c1.id]);
  assert.deepEqual(buildQueue([c1, d2, d1], [d1.id]).map((c) => c.id), [d2.id, d1.id, c1.id]);
  // новый вопрос встаёт в конец своей группы, текущая карточка не прыгает
  const fresh = q({ askedAt: 99 });
  assert.deepEqual(buildQueue([c1, d2, d1, fresh]).map((c) => c.id), [d1.id, d2.id, fresh.id, c1.id]);
});

check('полоса прогресса: сделанные, текущий, остальные по группам', () => {
  const queue = buildQueue([q({ askedAt: 1 }), q({ askedAt: 2 }), q({ askedAt: 3, proposal: 'П' })]);
  assert.deepEqual(queueSegments(1, queue), ['done', 'now', 'decide', 'confirm']);
  assert.deepEqual(queueSegments(0, []), []);
});

console.log(`\n${passed} проверок прошли`);
