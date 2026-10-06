/**
 * История противоречий (src/server/contradiction-history.ts): по каким записям
 * владельца уже спрашивали, и что ритуал не поднимает снова. Тексты — из
 * живого журнала офиса, на которых ритуал задавал повторы Q-88–Q-91: пауза,
 * иконка офиса, веб-задачи backend-2, браузер QA.
 *
 * Запуск: node --import tsx/esm scripts/test-contradictions-history.ts
 */
import assert from 'node:assert/strict';
import {
  findPriorContradiction, mentionsFact, repeatedQuestions, ruledFacts, sameTopic,
} from '../src/server/contradiction-history';
import type { FactView, OwnerQuestion } from '../src/shared/types';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

type F = Pick<FactView, 'id' | 'kind' | 'text' | 'source'>;
type Q = Pick<OwnerQuestion, 'id' | 'kind' | 'text' | 'askedAt' | 'answer' | 'answeredAt' | 'dismissedAt' | 'mergedInto'>;

const fact = (id: string, text: string, kind: F['kind'] = 'fact', source: F['source'] = {}): F => ({ id, kind, text, source });
let at = 0;
const question = (id: string, text: string, answer: string | null): Q => ({
  id, kind: 'contradiction', text, askedAt: ++at, answer, answeredAt: answer ? at : null, dismissedAt: null,
});
const ask = (a: string, b: string): string => `Журнал разошёлся сам с собой: «${a}» против «${b}». Что верно?`;

const facts: F[] = [
  fact('J-8', "OfficeIcon в контракте поддерживает { kind: 'emoji' | 'image', value: string }, но UI реализует только палитру эмодзи; загрузка картинок из файлов отложена на позже"),
  fact('J-36', 'Иконка офиса: контракт OfficeIcon = { kind: emoji | image, value: string }, и обе половины уже сделаны — сервер (POST /api/office/icon до 1 МБ)'),
  fact('J-22', 'Узкие правки веба отдавать backend-2, а роль frontend не грузить задачами, где надо смотреть оболочку', 'lesson'),
  fact('J-23', 'Роль frontend провалилась по «Autocompact is thrashing» пять раз подряд — веб-правки в src/web отдавать backend-2', 'lesson'),
  fact('J-38', 'Владелец: backend, backend-2 и backend-3 для него одно и то же — нагрузку распределять равномерно между ними, а не закреплять веб за backend-2.', 'decision'),
  fact('J-29', 'Статус офиса (признак паузы) добавлен в контракт: OfficeActivity.paused (только в памяти, на диск не пишется); событие paused рассылается broadcastOffices'),
  fact('J-43', 'Пауза офиса теперь сохраняется в OfficeEntry.paused (offices.json, пишется сразу, без дебаунса); офис поднимается на паузе и задач не берёт'),
  fact('J-87', 'Пауза офиса: верна более новая запись. Признак хранится в OfficeEntry.paused (offices.json, пишется сразу) и переживает перезапуск'),
  fact('J-213', 'QA-роль в маркете (packages/@office/qa): пакет с брифом; браузер работает через MCP-сервер tools/browser с инструментами navigate, screenshot, tap, swipe, storyboard'),
  fact('J-214', 'Браузер QA не запускается в песочнице исполнителя при попытке проверить сайт; два провала подряд (T-279, T-281) блокируют шаг QA в процессах.'),
  fact('J-250', 'где хранится пауза офиса: только в памяти или в offices.json на диск', 'contradiction'),
  fact('J-300', 'Порт сервера по умолчанию 3002'),
  fact('J-301', 'Порт сервера по умолчанию 3010'),
];
const byId = (id: string): F => facts.find((f) => f.id === id)!;

const questions: Q[] = [
  question('Q-5', ask(`J-8: «${byId('J-8').text.slice(0, 150)}…`, 'T-6/T-43: загрузка иконки-картинки уже реализована'), "'emoji' | 'image' верно"),
  question('Q-18', ask(`J-29: «${byId('J-29').text.slice(0, 100)}»`, `J-43: «${byId('J-43').text.slice(0, 100)}»`), 'Разберись сам'),
  question('Q-19', ask('J-22: «узкие правки веба отдавать backend-2»', 'J-38: «нагрузку распределять равномерно»'), 'Надо распределять нагрузку'),
  question('Q-73', ask(
    'J-210: «браузер работает через MCP-сервер tools/browser с инструментами navigate, screenshot, tap, swipe»',
    'Реальность: браузер не запускается при попытке проверить сайт в T-279 и T-281',
  ), 'Разберись сам'),
];
// След ответа на Q-18 в журнале: запись «В: … — О: …».
facts.push(fact('J-86', `В: ${questions[1].text} — О: Разберись сам`, 'fact', { questionId: 'Q-18' }));

const quote = (f: F): string => `${f.id} [${f.kind}, project] ${f.text}`;
const prior = (a: string, b: string, text = ''): ReturnType<typeof findPriorContradiction> =>
  findPriorContradiction({ a: quote(byId(a)), b: quote(byId(b)), text }, [byId(a), byId(b)], questions, facts);

console.log('упоминания');
check('id целым словом: J-8 не находится в J-80', () => {
  assert.ok(mentionsFact('спор о J-8 и J-9', byId('J-8')));
  assert.ok(!mentionsFact('спор о J-80', byId('J-8')));
});
check('стороны прежних вопросов и след ответа — разобраны', () => {
  const ruled = ruledFacts(questions, facts);
  for (const id of ['J-8', 'J-29', 'J-43', 'J-22', 'J-38', 'J-213', 'J-214', 'J-86']) assert.ok(ruled.has(id), id);
  assert.ok(!ruled.has('J-300'));
});

console.log('отвеченная пара не поднимается снова');
check('та же пара, что в отвеченном вопросе', () => {
  assert.deepEqual(prior('J-29', 'J-43'), { questionId: 'Q-18' });
});
check('пауза: прежняя запись против более новой той же темы', () => {
  assert.deepEqual(prior('J-29', 'J-87'), { questionId: 'Q-18' });
});
check('иконки, веб-задачи, браузер QA', () => {
  assert.deepEqual(prior('J-8', 'J-36'), { questionId: 'Q-5' });
  assert.deepEqual(prior('J-23', 'J-38'), { questionId: 'Q-19' });
  assert.deepEqual(prior('J-213', 'J-214'), { questionId: 'Q-73' });
});
check('сторона — запись «В: … — О: …» с ответом', () => {
  assert.deepEqual(prior('J-86', 'J-87'), { questionId: 'Q-18' });
});
check('стороны не нашлись — совпали цитаты прежнего вопроса', () => {
  const c = { a: 'J-22: «узкие правки веба отдавать backend-2»', b: 'нагрузку распределять равномерно', text: '' };
  assert.equal(findPriorContradiction(c, [null, null], questions, facts)?.questionId, 'Q-19');
});
check('стороны не нашлись — тема совпала с записью contradiction', () => {
  const c = { a: 'что-то новое о паузе', b: 'другое новое о паузе', text: 'где хранится пауза офиса: в памяти или в offices.json' };
  assert.deepEqual(findPriorContradiction(c, [null, null], questions, facts), { factId: 'J-250' });
});
check('новое противоречие проходит', () => {
  assert.equal(prior('J-300', 'J-301', 'порт сервера: 3002 или 3010'), null);
  assert.ok(!sameTopic('порт сервера', 'хранилище: JSON или SQLite'));
});

console.log('повторы среди открытых вопросов');
check('открытый повтор ссылается на отвеченный вопрос той же записи', () => {
  const repeat = question('Q-88', ask(`J-29: «${byId('J-29').text.slice(0, 100)}»`, 'J-87: «Пауза офиса: верна более новая запись»'), null);
  const fresh = question('Q-95', ask('J-300: «Порт сервера по умолчанию 3002»', 'J-301: «Порт сервера по умолчанию 3010»'), null);
  const found = repeatedQuestions([...questions, repeat, fresh], facts);
  assert.deepEqual(found.map((r) => [r.repeat.id, r.prior.id]), [['Q-88', 'Q-18']]);
});

console.log(`\nистория противоречий: ${passed} проверок прошло`);
