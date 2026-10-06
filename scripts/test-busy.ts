/**
 * Признак занятости офиса перед перезапуском в новую версию (busy.ts):
 * пустой офис и простаивающий менеджер — не заняты, любая идущая работа —
 * занят. Чистые функции, ни сервера, ни состояния.
 *
 * Запуск: npm run test:busy
 */
import assert from 'node:assert/strict';
import { busyAnswer, isWorking, type WorkSnapshot } from '../src/server/busy';

const idle: WorkSnapshot = { workers: 0, pmTurns: 0, meeting: false, pipelines: 0, mergeQueue: false, releases: 0 };
const results: string[] = [];
function check(name: string, fn: () => void): void {
  fn();
  results.push(`ok — ${name}`);
}

check('ничего не идёт — не занят', () => assert.equal(isWorking(idle), false));
check('каждый вид работы по отдельности — занят', () => {
  const cases: Partial<WorkSnapshot>[] = [
    { workers: 1 }, { pmTurns: 1 }, { meeting: true }, { pipelines: 1 }, { mergeQueue: true }, { releases: 1 },
  ];
  for (const c of cases) assert.equal(isWorking({ ...idle, ...c }), true, JSON.stringify(c));
});
check('сводка: занятых офисов нет — busy ложно', () => {
  assert.deepEqual(busyAnswer([{ officeId: 'o-1', work: idle }, { officeId: 'o-2', work: idle }]), { busy: false, offices: [] });
  assert.deepEqual(busyAnswer([]), { busy: false, offices: [] });
});
check('сводка: занят один офис из двух', () => {
  assert.deepEqual(
    busyAnswer([{ officeId: 'o-1', work: idle }, { officeId: 'o-2', work: { ...idle, workers: 2 } }]),
    { busy: true, offices: ['o-2'] });
});

console.log(results.join('\n'));
console.log(`\nвсе проверки пройдены: ${results.length}`);
