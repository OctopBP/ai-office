/**
 * Признак занятости офиса перед перезапуском в новую версию (busy.ts):
 * пустой офис и простаивающий менеджер — не заняты, любая идущая работа —
 * занят. Чистые функции, ни сервера, ни состояния.
 *
 * Запуск: npm run test:busy
 */
import assert from 'node:assert/strict';
import { busyAnswer, countWorking, isWorking, workReasons, type WorkSnapshot } from '../src/server/busy';

const idle: WorkSnapshot = { tasks: [], workers: 0, pmTurns: 0, meeting: false, pipelines: 0, mergeQueue: false, releases: 0 };
const results: string[] = [];
function check(name: string, fn: () => void): void {
  fn();
  results.push(`ok — ${name}`);
}

check('ничего не идёт — не занят', () => assert.equal(isWorking(idle), false));
check('каждый вид работы по отдельности — занят', () => {
  const cases: Partial<WorkSnapshot>[] = [
    { tasks: ['T-1'] }, { workers: 1 }, { pmTurns: 1 }, { meeting: true }, { pipelines: 1 }, { mergeQueue: true }, { releases: 1 },
  ];
  for (const c of cases) assert.equal(isWorking({ ...idle, ...c }), true, JSON.stringify(c));
});
check('сводка: занятых офисов нет — busy ложно', () => {
  assert.deepEqual(busyAnswer([{ officeId: 'o-1', work: idle }, { officeId: 'o-2', work: idle }]), { busy: false, offices: [], reasons: [] });
  assert.deepEqual(busyAnswer([]), { busy: false, offices: [], reasons: [] });
});
check('сводка: занят один офис из двух', () => {
  assert.deepEqual(
    busyAnswer([{ officeId: 'o-1', work: idle }, { officeId: 'o-2', work: { ...idle, workers: 2 } }]),
    { busy: true, offices: ['o-2'], reasons: ['o-2: сессии исполнителей: 2'] });
});
check('прогон, ждущий владельца, — не работа', () => {
  assert.equal(countWorking([{ status: 'waiting' }]), 0);
  assert.equal(countWorking([{ status: 'waiting' }, { status: 'running' }]), 1);
});
check('встал (stuck) — не работа', () => {
  assert.equal(countWorking([{ status: 'stuck' }]), 0);
});
check('причины называют, что посчитано работой', () => {
  assert.deepEqual(workReasons(idle), []);
  assert.deepEqual(workReasons({ ...idle, tasks: ['T-5', 'T-7'], releases: 1 }),
    ['задачи в работе: T-5, T-7', 'выпуски: 1']);
});
check('прогона ещё нет — конвейер стартует, это работа', () => {
  assert.equal(countWorking([null]), 1);
  assert.equal(countWorking([]), 0);
});

console.log(results.join('\n'));
console.log(`\nвсе проверки пройдены: ${results.length}`);
