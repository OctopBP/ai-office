/**
 * Перегруз вместо провала (T-707): src/server/resources.ts → overloadOf,
 * src/server/checks.ts → classifyCheckFailure, retryWhenCalm.
 *
 * Проверяем на подставленных срезах:
 *  1. перегруз: loadavg за минуту больше 2× ядер или свободной памяти < 10%;
 *  2. таймаут или сигнал при перегрузе — итог `overload` с цифрами,
 *     обычный провал, отмена снаружи и спокойная машина — нет;
 *  3. повтор после перегруза: ждёт спада, прогоняет проверку ровно один раз,
 *     не дождался за отведённое время — повтора нет;
 *  4. живая проверка, снятая по таймауту при подставленном перегрузе,
 *     несёт `overload`.
 *
 * Запуск: npm run test:overload
 */
import assert from 'node:assert/strict';
import { overloadOf, type Pressure } from '../src/server/resources';
import { classifyCheckFailure, retryWhenCalm, runProjectCheck, setPressureSource } from '../src/server/checks';

const GB = 1024 ** 3;
const slice = (load: number, cpus: number, freeGb: number, totalGb = 16): Pressure =>
  ({ load: [load, load, load], cpus, freeMem: freeGb * GB, totalMem: totalGb * GB });

const calm = slice(3, 8, 8);
const busyCpu = slice(17.5, 8, 8);
const lowMem = slice(1, 8, 1.2);
const edge = slice(16, 8, 1.6); // ровно 2× ядер и ровно 10% — ещё не перегруз

function testOverloadOf(): void {
  assert.equal(overloadOf(calm), null, 'спокойная машина');
  assert.equal(overloadOf(edge), null, 'граница не считается перегрузом');
  const cpu = overloadOf(busyCpu);
  assert.ok(cpu, 'load больше 2× ядер');
  assert.equal(cpu.load, 17.5);
  assert.equal(cpu.cpus, 8);
  assert.equal(cpu.freeShare, 0.5);
  const mem = overloadOf(lowMem);
  assert.ok(mem, 'памяти меньше 10%');
  assert.equal(mem.freeMem, 1.2 * GB);
  assert.equal(mem.totalMem, 16 * GB);
  assert.ok(Math.abs(mem.freeShare - 0.075) < 1e-9);
  console.log('✓ перегруз по нагрузке и по памяти');
}

function testClassify(): void {
  const timeout = { ok: false, timedOut: true };
  const signal = { ok: false, signal: 'SIGKILL' };
  assert.deepEqual(classifyCheckFailure(timeout, busyCpu), overloadOf(busyCpu), 'таймаут при перегрузе');
  assert.ok(classifyCheckFailure(signal, lowMem), 'сигнал при нехватке памяти');
  assert.equal(classifyCheckFailure(timeout, calm), null, 'таймаут на спокойной машине — провал');
  assert.equal(classifyCheckFailure({ ok: false }, busyCpu), null, 'упала сама — провал кода даже при перегрузе');
  assert.equal(classifyCheckFailure({ ok: false, timedOut: true, aborted: true }, busyCpu), null, 'отмена снаружи');
  assert.equal(classifyCheckFailure({ ok: true }, busyCpu), null, 'прошла');
  console.log('✓ классификация итога проверки');
}

async function testRetry(): Promise<void> {
  // Нагрузка спадает на третьем замере: два ожидания, один прогон.
  const slices = [busyCpu, lowMem, calm, calm];
  let i = 0;
  const sleeps: number[] = [];
  let runs = 0;
  const res = await retryWhenCalm(async () => { runs += 1; return 'ok'; }, {
    pressure: () => slices[Math.min(i++, slices.length - 1)]!,
    intervalMs: 1000, maxWaitMs: 10_000,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(res, 'ok');
  assert.equal(runs, 1, 'проверка повторена ровно один раз');
  assert.deepEqual(sleeps, [1000, 1000], 'ждала, пока нагрузка спадёт');

  // Не спала за отведённое время — повтора нет.
  runs = 0;
  sleeps.length = 0;
  const none = await retryWhenCalm(async () => { runs += 1; return 'ok'; }, {
    pressure: () => busyCpu, intervalMs: 1000, maxWaitMs: 3000,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(none, null);
  assert.equal(runs, 0, 'без спада нагрузки проверка не повторяется');
  assert.equal(sleeps.length, 3);

  // Спокойно сразу — прогон без ожидания.
  sleeps.length = 0;
  await retryWhenCalm(async () => { runs += 1; }, {
    pressure: () => calm, sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(runs, 1);
  assert.equal(sleeps.length, 0);
  console.log('✓ повтор один раз после спада нагрузки');
}

async function testLiveTimeout(): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    setPressureSource(() => busyCpu);
    const hung = await runProjectCheck(process.cwd(), 'sleep 5', 'ru', { timeoutMs: 200, slots: false });
    assert.equal(hung.ok, false);
    assert.equal(hung.timedOut, true);
    assert.ok(hung.overload, 'таймаут при перегрузе помечен overload');
    assert.equal(hung.overload.load, 17.5);
    const failed = await runProjectCheck(process.cwd(), 'exit 3', 'ru', { slots: false });
    assert.equal(failed.ok, false);
    assert.equal(failed.overload, undefined, 'обычный провал не перегруз');
    setPressureSource(() => calm);
    const calmHung = await runProjectCheck(process.cwd(), 'sleep 5', 'ru', { timeoutMs: 200, slots: false });
    assert.equal(calmHung.timedOut, true);
    assert.equal(calmHung.overload, undefined, 'таймаут на спокойной машине — провал');
  } finally {
    setPressureSource();
  }
  console.log('✓ живая проверка: таймаут при перегрузе несёт цифры');
}

testOverloadOf();
testClassify();
await testRetry();
await testLiveTimeout();
console.log('test-overload: всё прошло');
