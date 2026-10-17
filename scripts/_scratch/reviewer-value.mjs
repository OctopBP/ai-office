// Одноразовый разбор для T-644: сколько стоит ревьюер и что он ловит.
// Только чтение снимка состояния офиса: node scripts/_scratch/reviewer-value.mjs <копия o-2.json> <папка вывода>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [src, out] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(src, 'utf8'));
fs.mkdirSync(out, { recursive: true });

const NOW = d.savedAt;
const DAY = 864e5;
const since30 = NOW - 30 * DAY;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const tasks = new Map(d.tasks.map((t) => [t.id, t]));
const prs = new Map(d.prs.map((p) => [p.taskId, p]));

// Тип задачи — по файлам, которые она сдала (delivery.files или files).
function kindOf(t) {
  const files = (t?.delivery?.files ?? t?.files ?? []).map((f) => (typeof f === 'string' ? f : f.path ?? ''));
  if (!files.length) return 'без файлов';
  const code = files.filter((f) => /^(src|scripts|electron|tools|workflows|packages|registry)\//.test(f) || /\.(ts|tsx|mjs|js|json|css)$/.test(f) && !f.startsWith('docs/'));
  const web = code.filter((f) => f.startsWith('src/web/'));
  if (!code.length) return 'документы и макеты';
  if (web.length && web.length === code.length) return 'веб';
  if (web.length) return 'сервер + веб';
  return 'сервер и скрипты';
}

// 1. Шаги review в процессах feature — цена каждого ревью за всю историю.
const reviews = [];
for (const r of d.runs.filter((r) => r.workflowId === 'feature')) {
  const tid = r.subject?.taskId;
  r.steps.filter((s) => s.node === 'review').forEach((s, i) => {
    reviews.push({ taskId: tid, round: i + 1, at: s.startedAt, outcome: s.outcome, cost: s.costUsd ?? 0, ms: s.ms });
  });
}

// Траты из spend: роль reviewer, отдельно ревью и собственные задачи ревьюера.
const spendRev = d.spend.filter((s) => s.roleId === 'reviewer');
const spendAll = d.spend;
const ownTask = (s) => s.taskId && tasks.get(s.taskId)?.roleId === 'reviewer';
const inst = d.instances.find((i) => i.roleId === 'reviewer');

const cost = {
  officeLifetime: d.usage.costUsd,
  reviewerLifetime: inst.usage.costUsd,
  reviewerTokensLifetime: inst.usage,
  reviewStepsAll: sum(reviews.map((r) => r.cost)),
  reviewStepsCount: reviews.length,
  reviewSteps30: sum(reviews.filter((r) => r.at >= since30).map((r) => r.cost)),
  reviewSteps30Count: reviews.filter((r) => r.at >= since30).length,
  spendFrom: day(spendAll[0].at),
  spendOffice: sum(spendAll.map((s) => s.usage.costUsd)),
  spendOffice30: sum(spendAll.filter((s) => s.at >= since30).map((s) => s.usage.costUsd)),
  spendReviewer: sum(spendRev.map((s) => s.usage.costUsd)),
  spendReviewer30: sum(spendRev.filter((s) => s.at >= since30).map((s) => s.usage.costUsd)),
  spendReviewerOwnTasks: sum(spendRev.filter(ownTask).map((s) => s.usage.costUsd)),
  spendReviewerNoTask: sum(spendRev.filter((s) => !s.taskId).map((s) => s.usage.costUsd)),
  spendByRole: Object.fromEntries(Object.entries(spendAll.reduce((m, s) => ((m[s.roleId] = (m[s.roleId] ?? 0) + s.usage.costUsd), m), {})).sort((a, b) => b[1] - a[1])),
  spendReviewerTokens: spendRev.reduce((m, s) => { for (const k of ['tokensIn', 'tokensOut', 'cacheRead', 'cacheWrite']) m[k] = (m[k] ?? 0) + (s.usage[k] ?? 0); return m; }, {}),
  reviewerModels: spendRev.reduce((m, s) => ((m[s.model] = (m[s.model] ?? 0) + s.usage.costUsd), m), {}),
  instancesLifetime: Object.fromEntries(d.instances.map((i) => [i.roleId, i.usage.costUsd])),
};
const costs = reviews.filter((r) => r.cost > 0).map((r) => r.cost);
cost.perReview = { mean: sum(costs) / costs.length, median: median(costs), p90: [...costs].sort((a, b) => a - b)[Math.floor(costs.length * 0.9)], n: costs.length };
// Цена ревью на задачу (все круги).
const perTask = {};
for (const r of reviews) perTask[r.taskId] = (perTask[r.taskId] ?? 0) + r.cost;
cost.perTask = { mean: sum(Object.values(perTask)) / Object.keys(perTask).length, median: median(Object.values(perTask)), n: Object.keys(perTask).length };
cost.top = [...reviews].sort((a, b) => b.cost - a.cost).slice(0, 10).map((r) => ({ ...r, title: tasks.get(r.taskId)?.title, kind: kindOf(tasks.get(r.taskId)), day: day(r.at), min: Math.round(r.ms / 6e4) }));
// По неделям.
cost.byWeek = reviews.reduce((m, r) => { const w = day(r.at - ((new Date(r.at).getUTCDay() + 6) % 7) * DAY); m[w] ??= { n: 0, cost: 0 }; m[w].n++; m[w].cost += r.cost; return m; }, {});

// 2. Возвраты и одобрения с замечаниями — полные тексты в файл для ручного разбора.
const returns = [];
const approvals = [];
for (const p of d.prs) {
  (p.reviews ?? []).forEach((rv, i) => {
    const t = tasks.get(p.taskId);
    const row = { taskId: p.taskId, title: t?.title, role: t?.roleId, kind: kindOf(t), round: i + 1, of: p.reviews.length, verdict: rv.verdict, day: day(rv.at), outcome: t?.outcome?.kind, merged: p.stage, text: rv.text };
    if (rv.verdict === 'changes') returns.push(row);
    else approvals.push(row);
  });
}
fs.writeFileSync(path.join(out, 'returns.md'), returns.map((r) => `## ${r.taskId} круг ${r.round}/${r.of} [${r.kind}, ${r.role}, ${r.day}, исход ${r.outcome}]\n${r.title}\n\n${r.text}\n`).join('\n---\n'));
// Одобрения, где ревьюер явно оставил замечания.
const remarkRe = /замечани|мелоч|не блокир|некритич|стоит |можно было бы|рекоменд|на будущее|nit|минор/i;
const withRemarks = approvals.filter((a) => remarkRe.test(a.text));
fs.writeFileSync(path.join(out, 'approvals-remarks.md'), withRemarks.map((r) => `## ${r.taskId} [${r.kind}, ${r.day}]\n${r.title}\n\n${r.text}\n`).join('\n---\n'));

// Задачи, вернувшиеся из доработки: какие задачи вообще получали changes.
const returnedTasks = [...new Set(returns.map((r) => r.taskId))];

// 3. Пропуски: задачи-починки, ссылающиеся на ранее одобренную задачу.
const fixRe = /почин|исправ|сверить|двойн|откат|регресс|сломал|вернуть|не работает|баг|чинит/i;
const misses = [];
for (const t of d.tasks) {
  const text = `${t.title}\n${t.description ?? ''}`;
  if (!fixRe.test(t.title)) continue;
  const refs = [...new Set([...text.matchAll(/T-(\d+)/g)].map((m) => `T-${m[1]}`))].filter((id) => id !== t.id && prs.get(id)?.reviews?.some((r) => r.verdict === 'approve') && tasks.get(id)?.createdAt < t.createdAt);
  if (refs.length) misses.push({ fix: t.id, title: t.title, day: day(t.createdAt), status: t.status, refs, desc: (t.description ?? '').slice(0, 1500) });
}
fs.writeFileSync(path.join(out, 'misses.md'), misses.map((m) => `## ${m.fix} (${m.day}, ${m.status}) → ${m.refs.join(', ')}\n${m.title}\n\n${m.desc}\n`).join('\n---\n'));

// Откаты по git (revert-коммиты) и по исходам.
let reverts = '';
try { reverts = execFileSync('git', ['log', '--all', '--format=%h %ad %s', '--date=short', '-i', '--grep=revert', '--grep=откат'], { encoding: 'utf8' }); } catch {}

// 4. Гейт до ревью: падения checks и пересечение замечаний с тем, что ловят проверки.
const gateRe = /typecheck|tsc|тест[ауы]? (пада|красн|не прох)|test:\w+.*(пада|fail|красн)|не компилир|ошибк[аи] тип/i;
const gateOverlap = returns.filter((r) => gateRe.test(r.text)).map((r) => r.taskId + ' круг ' + r.round);
const checksFails = {};
for (const r of d.runs.filter((r) => r.workflowId === 'feature')) for (const s of r.steps) if (/check/.test(s.node)) { checksFails[s.node + ':' + s.outcome] = (checksFails[s.node + ':' + s.outcome] ?? 0) + 1; }
const nodesOrder = d.runs.filter((r) => r.workflowId === 'feature').slice(-1)[0].steps.map((s) => s.node);

// 5. Разрез по типам: задач на ревью, возвратов, цена ревью, починок.
const reviewedTasks = [...new Set(reviews.map((r) => r.taskId))];
const byKind = {};
for (const id of reviewedTasks) {
  const k = kindOf(tasks.get(id));
  byKind[k] ??= { tasks: 0, cost: 0, returned: 0, missed: 0 };
  byKind[k].tasks++;
  byKind[k].cost += perTask[id] ?? 0;
  if (returnedTasks.includes(id)) byKind[k].returned++;
  if (misses.some((m) => m.refs.includes(id))) byKind[k].missed++;
}
const byRole = {};
for (const id of reviewedTasks) {
  const k = tasks.get(id)?.roleId ?? '?';
  byRole[k] ??= { tasks: 0, cost: 0, returned: 0 };
  byRole[k].tasks++; byRole[k].cost += perTask[id] ?? 0;
  if (returnedTasks.includes(id)) byRole[k].returned++;
}
const outcomes = d.tasks.reduce((m, t) => { const k = t.outcome?.kind ?? 'нет'; m[k] = (m[k] ?? 0) + 1; return m; }, {});

const result = {
  savedAt: new Date(NOW).toISOString(), cost, returnsCount: returns.length, returnedTasks,
  returns: returns.map(({ text, ...r }) => r), approvalsCount: approvals.length, withRemarks: withRemarks.map((a) => a.taskId),
  reviewOutcomes: reviews.reduce((m, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {}),
  failedReviews: reviews.filter((r) => r.outcome === 'failed'),
  misses: misses.map(({ desc, ...m }) => m), reverts, gateOverlap, checksFails, nodesOrder, byKind, byRole, outcomes,
  prsDropped: d.prs.filter((p) => p.stage === 'dropped').length,
  gateChecks: d.prs.find((p) => p.gate?.checks)?.gate.checks.map((c) => c.command),
};
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
