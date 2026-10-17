// Добор для T-644: цена ревью по неделям и типам, цена задач-починок.
// node scripts/_scratch/reviewer-value-2.mjs <копия o-2.json>
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const DAY = 864e5;
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const sum = (a) => a.reduce((s, x) => s + x, 0);
const tasks = new Map(d.tasks.map((t) => [t.id, t]));
function kindOf(t) {
  let files = (t?.delivery?.files ?? t?.files ?? []).map((f) => (typeof f === 'string' ? f : f.path ?? ''));
  // Отчёт без списка файлов — берём их из коммита слияния задачи.
  const commit = t?.mergeCommit ?? t?.delivery?.commit;
  if (!files.length && commit) { try { files = execFileSync('git', ['show', '--name-only', '--format=', commit], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch {} }
  if (!files.length) return 'без файлов';
  const code = files.filter((f) => !f.startsWith('docs/') && !f.startsWith('design/') && (/^(src|scripts|electron|desktop|tools|workflows|packages|registry)\//.test(f) || /\.(ts|tsx|mjs|js|css)$/.test(f) || f === 'package.json'));
  const web = code.filter((f) => f.startsWith('src/web/'));
  if (!code.length) return 'документы и макеты';
  if (web.length === code.length) return 'веб';
  if (web.length) return 'сервер + веб';
  return 'сервер и скрипты';
}
const rv = [];
for (const r of d.runs.filter((r) => r.workflowId === 'feature')) r.steps.filter((s) => s.node === 'review').forEach((s) => rv.push({ id: r.subject.taskId, at: s.startedAt, cost: s.costUsd ?? 0, ms: s.ms, out: s.outcome }));
const wk = {};
for (const r of rv) { const w = new Date(r.at - ((new Date(r.at).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10); (wk[w] ??= []).push(r.cost); }
console.log('неделя: n, сумма, среднее, медиана');
for (const [w, a] of Object.entries(wk).sort()) console.log(w, a.length, sum(a).toFixed(2), (sum(a) / a.length).toFixed(3), med(a).toFixed(3));
const byK = {};
for (const r of rv) { const k = kindOf(tasks.get(r.id)); (byK[k] ??= { c: [], ids: new Set(), ms: [] }); byK[k].c.push(r.cost); byK[k].ids.add(r.id); byK[k].ms.push(r.ms); }
console.log('\nтип: задач, ревью, сумма, среднее, медиана, медиана минут');
for (const [k, v] of Object.entries(byK)) console.log(k, v.ids.size, v.c.length, sum(v.c).toFixed(2), (sum(v.c) / v.c.length).toFixed(3), med(v.c).toFixed(3), (med(v.ms) / 6e4).toFixed(1));
const ret = ['T-19', 'T-74', 'T-89', 'T-95', 'T-129', 'T-146', 'T-149', 'T-377', 'T-548', 'T-582', 'T-593'];
console.log('\nвозвраты по типу (новая классификация):', ret.map((id) => id + ':' + kindOf(tasks.get(id))).join(' '));
for (const id of ['T-145', 'T-164', 'T-194', 'T-223', 'T-226', 'T-225', 'T-381']) console.log(id, kindOf(tasks.get(id)), tasks.get(id).usage?.costUsd?.toFixed(2), tasks.get(id).title);
const done = d.tasks.filter((t) => t.outcome && ['clean', 'reworked'].includes(t.outcome.kind)).map((t) => t.usage?.costUsd ?? 0);
console.log('\nзадача (clean+reworked): n', done.length, 'медиана', med(done).toFixed(2), 'среднее', (sum(done) / done.length).toFixed(2));
// Цена кругов доработки, которые вызвал ревьюер: rework-шаги процесса.
const rw = [];
for (const r of d.runs.filter((r) => r.workflowId === 'feature')) r.steps.filter((s) => s.node === 'rework').forEach((s) => rw.push({ id: r.subject.taskId, cost: s.costUsd ?? 0 }));
console.log('rework шагов', rw.length, 'сумма', sum(rw.map((r) => r.cost)).toFixed(2), JSON.stringify(rw.map((r) => r.id + ':' + r.cost.toFixed(2))));
// Цена ревью задач, не трогающих код.
console.log('fix-checks', d.runs.filter((r) => r.workflowId === 'feature').flatMap((r) => r.steps.filter((s) => /fix-checks/.test(s.node)).map((s) => r.subject.taskId + ':' + s.outcome)).join(' '));
console.log('checks fail', d.runs.filter((r) => r.workflowId === 'feature').flatMap((r) => r.steps.filter((s) => /^(re)?checks?$/.test(s.node) && s.outcome === 'fail').map(() => r.subject.taskId)).join(' '));
// Сверки «дубль правки» — цена и кто делал.
const sv = d.tasks.filter((t) => /^(Сверить|Проверить двойную|Свести двойные)/.test(t.title));
console.log('сверки:', sv.length, 'сумма', sum(sv.map((t) => t.usage?.costUsd ?? 0)).toFixed(2), 'у ревьюера', sv.filter((t) => t.roleId === 'reviewer').length);
