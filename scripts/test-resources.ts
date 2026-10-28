/**
 * Замер памяти и нагрузки офиса (src/server/resources.ts).
 *
 * Проверяем:
 *  1. срез: loadavg, ядра, память, RSS/heap, сессии по офисам и проверки из
 *     общего ограничителя;
 *  2. буфер: размер не растёт дальше окна 24 ч, старые срезы выпадают,
 *     порядок по времени сохраняется после переворота кольца;
 *  3. ответ маршрута: последний срез и ряд, сессии запрошенного офиса;
 *  4. на диск ничего не пишется — модуль не тянет node:fs.
 *
 * Запуск: npm run test:resources
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { createRequire } from 'node:module';
import {
  RESOURCES_INTERVAL_MS, RESOURCES_WINDOW_MS, ResourceRing, resourceRing, resourcesAnswer,
  startResources, stopResources, takeSample, type ResourceSample,
} from '../src/server/resources';
import { checkSlots } from '../src/server/checkslots';

const offices = () => [
  { id: 'o-1', sessions: { workers: 2, pm: 1 } },
  { id: 'o-2', sessions: { workers: 0, pm: 1 } },
];

function sample(at: number): ResourceSample {
  return takeSample({ offices, now: () => at, checks: () => ({ running: 1, waiting: 3, limit: 2 }) });
}

async function testSample(): Promise<void> {
  const s = sample(1000);
  assert.equal(s.at, 1000);
  assert.equal(s.load.length, 3);
  assert.ok(s.load.every((x) => Number.isFinite(x) && x >= 0), 'loadavg — числа');
  assert.equal(s.cpus, cpus().length);
  assert.ok(s.freeMem > 0 && s.totalMem >= s.freeMem, 'свободная память не больше всей');
  assert.ok(s.rss > 0 && s.heapUsed > 0 && s.heapTotal >= s.heapUsed, 'RSS и heap процесса');
  assert.equal(s.sessions, 4, 'сессии всех офисов суммой');
  assert.deepEqual(s.offices['o-1'], { workers: 2, pm: 1 });
  assert.deepEqual(s.checks, { running: 1, waiting: 3, limit: 2 });

  // Без подстановки проверки берутся из общего ограничителя.
  const release = await checkSlots().acquire('npm run typecheck @ /tmp/T-1');
  const live = takeSample({ offices });
  assert.equal(live.checks.running, 1, 'держатель слота виден');
  assert.equal(live.checks.limit, checkSlots().limit());
  release();
  assert.equal(takeSample({ offices }).checks.running, 0, 'слот отпущен');
}

function testRing(): void {
  const ring = new ResourceRing();
  const cap = Math.ceil(RESOURCES_WINDOW_MS / RESOURCES_INTERVAL_MS) + 1;
  assert.equal(ring.capacity, cap);
  assert.equal(ring.latest(), null);
  assert.deepEqual(ring.series(), []);

  // Двое суток срезов — в буфере остаются только последние 24 ч.
  const total = cap * 2 + 17;
  for (let i = 0; i < total; i++) ring.push(sample(i * RESOURCES_INTERVAL_MS));
  assert.equal(ring.size, cap, 'буфер не растёт');
  const series = ring.series();
  const last = (total - 1) * RESOURCES_INTERVAL_MS;
  assert.equal(ring.latest()!.at, last);
  assert.equal(series[series.length - 1]!.at, last, 'последний срез в конце ряда');
  assert.ok(series[0]!.at >= last - RESOURCES_WINDOW_MS, 'старше 24 ч не отдаётся');
  for (let i = 1; i < series.length; i++) assert.ok(series[i]!.at > series[i - 1]!.at, 'ряд по времени');

  // Пропуск в замерах (сон машины): точки старше окна отсекаются и без переполнения.
  const gap = new ResourceRing();
  gap.push(sample(0));
  gap.push(sample(RESOURCES_WINDOW_MS + 60_000));
  assert.deepEqual(gap.series().map((s) => s.at), [RESOURCES_WINDOW_MS + 60_000]);
}

function testAnswer(): void {
  const ring = new ResourceRing();
  ring.push(sample(1));
  ring.push(sample(2));
  const a = resourcesAnswer(ring, 'o-1');
  assert.equal(a.office, 'o-1');
  assert.equal(a.intervalMs, RESOURCES_INTERVAL_MS);
  assert.equal(a.windowMs, RESOURCES_WINDOW_MS);
  assert.equal(a.series.length, 2);
  assert.equal(a.latest!.at, 2);
  assert.deepEqual(a.latest!.office, { workers: 2, pm: 1 });
  assert.equal(a.latest!.sessions, 4);
  assert.ok(!('offices' in a.latest!), 'чужие офисы поштучно не отдаются');
  assert.deepEqual(resourcesAnswer(ring, 'o-404').latest!.office, { workers: 0, pm: 0 });
  assert.equal(resourcesAnswer(new ResourceRing(), 'o-1').latest, null);
  JSON.parse(JSON.stringify(a));
}

function testTimer(): void {
  startResources({ offices }, 10);
  startResources({ offices }, 10); // повтор не заводит второй таймер
  assert.equal(resourceRing().size, 1, 'первый срез сразу');
  stopResources();
}

function testNoDisk(): void {
  const require = createRequire(import.meta.url);
  const src = readFileSync(require.resolve('../src/server/resources.ts'), 'utf8');
  assert.ok(!/from ['"]node:fs|from ['"]fs['"]|\.\/store['"]/.test(src), 'resources.ts не пишет на диск');
}

await testSample();
testRing();
testAnswer();
testTimer();
testNoDisk();
console.log('test-resources: ok');
