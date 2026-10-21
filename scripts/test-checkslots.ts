/**
 * Общий ограничитель параллельных проверок (src/server/checkslots.ts).
 *
 * Проверяем:
 *  1. предел: из OFFICE_CHECK_SLOTS, по ядрам, и больше предела слоты не выдаются;
 *  2. порядок: ожидающие получают слот строго в порядке прихода (FIFO);
 *  3. освобождение: слот отпускается, если держатель упал с исключением,
 *     а повторный release не отдаёт лишний слот.
 *
 * Запуск: npm run test:checkslots
 */
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { createCheckSlots, defaultCheckSlotsLimit } from '../src/server/checkslots';

const tick = () => new Promise<void>((r) => setImmediate(r));

async function testLimit(): Promise<void> {
  const byCores = Math.max(1, Math.floor(cpus().length / 4));
  assert.equal(defaultCheckSlotsLimit({}), byCores, 'по умолчанию — четверть ядер');
  assert.equal(defaultCheckSlotsLimit({ OFFICE_CHECK_SLOTS: '3' }), 3, 'переменная окружения');
  assert.equal(defaultCheckSlotsLimit({ OFFICE_CHECK_SLOTS: '0' }), byCores, '0 игнорируется');
  assert.equal(defaultCheckSlotsLimit({ OFFICE_CHECK_SLOTS: 'abc' }), byCores, 'мусор игнорируется');
  assert.ok(defaultCheckSlotsLimit({}) >= 1, 'хотя бы один слот');

  const slots = createCheckSlots(2);
  assert.equal(slots.limit(), 2);
  const r1 = await slots.acquire('a');
  const r2 = await slots.acquire('b');
  let thirdGot = false;
  const third = slots.acquire('c').then((r) => {
    thirdGot = true;
    return r;
  });
  await tick();
  assert.equal(thirdGot, false, 'третий ждёт, пока заняты оба слота');
  assert.deepEqual(slots.running().map((e) => e.label).sort(), ['a', 'b']);
  assert.deepEqual(slots.waiting().map((e) => e.label), ['c']);

  r1();
  const r3 = await third;
  assert.equal(thirdGot, true, 'после release третий получил слот');
  assert.deepEqual(slots.running().map((e) => e.label).sort(), ['b', 'c']);
  assert.equal(slots.waiting().length, 0);
  r2();
  r3();
  assert.equal(slots.running().length, 0);

  // Пик одновременных держателей не превышает предел.
  const busy = createCheckSlots(3);
  let now = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      busy.withSlot(`job-${i}`, async () => {
        now++;
        peak = Math.max(peak, now);
        await tick();
        now--;
      }),
    ),
  );
  assert.equal(peak, 3, 'одновременно ровно предел');
  console.log('✓ предел');
}

async function testFifo(): Promise<void> {
  const slots = createCheckSlots(1);
  const order: string[] = [];
  const first = await slots.acquire('first');
  const jobs = ['a', 'b', 'c', 'd'].map((label) =>
    slots.withSlot(label, async () => {
      order.push(label);
      await tick();
    }),
  );
  await tick();
  assert.deepEqual(slots.waiting().map((e) => e.label), ['a', 'b', 'c', 'd']);
  first();
  // Новичок, пришедший после освобождения, встаёт в хвост, а не лезет вперёд.
  const late = slots.withSlot('late', () => {
    order.push('late');
  });
  await Promise.all([...jobs, late]);
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'late'], 'строго в порядке прихода');
  console.log('✓ порядок FIFO');
}

async function testReleaseOnError(): Promise<void> {
  const slots = createCheckSlots(1);
  const failed = slots.withSlot('boom', async () => {
    await tick();
    throw new Error('проверка упала');
  });
  const next = slots.withSlot('next', () => 'ok');
  await assert.rejects(failed, /проверка упала/);
  assert.equal(await next, 'ok', 'следующий получил слот после исключения');
  assert.equal(slots.running().length, 0);

  // Синхронное исключение тоже отпускает слот.
  await assert.rejects(
    slots.withSlot('sync', () => {
      throw new Error('сразу');
    }),
    /сразу/,
  );
  assert.equal(slots.running().length, 0);

  // Двойной release не выдаёт лишний слот.
  const r = await slots.acquire('x');
  r();
  r();
  const a = await slots.acquire('a');
  let bGot = false;
  void slots.acquire('b').then((rb) => {
    bGot = true;
    rb();
  });
  await tick();
  assert.equal(bGot, false, 'повторный release не освободил чужой слот');
  a();
  await tick();
  assert.equal(bGot, true);
  console.log('✓ освобождение при ошибке');
}

await testLimit();
await testFifo();
await testReleaseOnError();
console.log('checkslots: все проверки прошли');
