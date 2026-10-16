/**
 * Единое правило подсчёта «в работе» и «к слиянию» (shared/work.ts) и то, что
 * сводка сервера (activity.ts → summarize) считает ровно по нему: число офиса
 * не зависит от того, выбран он или нет.
 *
 * Запуск: npm run test:work-count
 */
import assert from 'node:assert/strict';
import { countDoneUnmerged, countInWork } from '../src/shared/work';
import { summarize } from '../src/server/activity';
import type { TaskStatus } from '../src/shared/types';

const results: string[] = [];
function check(name: string, fn: () => void): void {
  fn();
  results.push(`ok — ${name}`);
}
const task = (status: TaskStatus, extra: { branch?: string | null; merged?: boolean } = {}) => ({ status, ...extra });

check('в работе: assigned, in_progress и review', () => {
  assert.equal(countInWork([task('assigned'), task('in_progress'), task('review')]), 3);
});
check('в работе не считаются planned, backlog, blocked, done, failed', () => {
  const rest: TaskStatus[] = ['planned', 'backlog', 'blocked', 'done', 'failed'];
  assert.equal(countInWork(rest.map((s) => task(s))), 0);
});
check('одна задача на ревью — «1 в работе» (случай из T-596)', () => {
  assert.equal(countInWork([task('review'), task('done')]), 1);
});
check('к слиянию: done с веткой и без слияния', () => {
  assert.equal(countDoneUnmerged([
    task('done', { branch: 'task/T-1' }), task('done', { branch: 'task/T-2', merged: true }),
    task('done'), task('review', { branch: 'task/T-3' }),
  ]), 1);
});
check('принимает любой Iterable (Map.values)', () => {
  const m = new Map([['T-1', task('in_progress')], ['T-2', task('assigned')]]);
  assert.equal(countInWork(m.values()), 2);
});
check('сводка сервера считает по тому же правилу', () => {
  const tasks = [task('assigned'), task('review'), task('in_progress'), task('done', { branch: 'b' }), task('blocked')];
  const a = summarize({ tasks });
  assert.equal(a.inProgress, countInWork(tasks));
  assert.equal(a.doneUnmerged, countDoneUnmerged(tasks));
});

console.log(results.join('\n'));
