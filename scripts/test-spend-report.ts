/**
 * Разбор расхода на фиктивных запусках: срезы сходятся с итогом, период
 * отсекает лишнее, и каждый сигнал перерасхода срабатывает ровно на своём
 * пороге — ни раньше, ни позже.
 *
 * Запуск: npm run test:spendreport
 */
import type { AgentRunEntry } from '../src/server/spend';
import {
  buildSpendReport, reportRange, asPeriod, NO_KEY, SPEND_SIGNALS,
} from '../src/server/spendReport';
import type { SpendReport } from '../src/shared/spendReport';

const results: string[] = [];
const S = SPEND_SIGNALS;
const DAY_MS = 24 * 60 * 60 * 1000;
// Полдень: «сегодня» и «вчера» тогда не зависят от того, когда запущен тест.
const noon = new Date(); noon.setHours(12, 0, 0, 0);
const now = noon.getTime();

let seq = 0;
function run(over: Partial<AgentRunEntry>): AgentRunEntry {
  seq += 1;
  return {
    id: `A-${seq}`, at: now, office: 'o-test', taskId: null, workflowId: null, nodeId: null,
    roleId: 'backend', instanceId: 'backend#1', model: 'claude-opus-5',
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
    prefixTokens: null, compactions: 0, wideRetries: 0, costUsd: 0,
    ...over,
  };
}

const runs: AgentRunEntry[] = [
  // T-1: дорогая, с хорошим кэшем, два сжатия (warn) и повтор на широком окне.
  run({
    taskId: 'T-1', workflowId: 'task-default', nodeId: 'work', costUsd: 4,
    input_tokens: 1000, cache_creation_input_tokens: 9000, cache_read_input_tokens: 90_000,
    output_tokens: 5000, prefixTokens: 40_000, compactions: 2,
  }),
  run({
    taskId: 'T-1', workflowId: 'task-default', nodeId: 'work', costUsd: 3,
    cache_read_input_tokens: 100_000, prefixTokens: 60_000, wideRetries: 1,
  }),
  // T-2: ревью другой ролью, три сжатия — уже alert.
  run({
    taskId: 'T-2', workflowId: 'task-default', nodeId: 'review', roleId: 'reviewer',
    instanceId: 'reviewer#1', model: 'claude-sonnet-5', costUsd: 1,
    input_tokens: 5000, cache_read_input_tokens: 5000, prefixTokens: 100_000, compactions: 3,
  }),
  // Менеджер вне задачи: кэш не работает (alert), объём ввода выше минимума.
  run({
    roleId: 'pm', instanceId: 'pm#1', model: 'claude-sonnet-5', costUsd: 2,
    input_tokens: 250_000, cache_read_input_tokens: 10_000, prefixTokens: 20_000,
    costUnavailable: true,
  }),
  // Дизайнер: кэш плохой, но ввода меньше минимума — не судим.
  run({
    roleId: 'design', instanceId: 'design#1', costUsd: 0.5,
    input_tokens: 10_000, cache_read_input_tokens: 0,
  }),
  // Вчера: в неделю попадает, в сутки — нет.
  run({ taskId: 'T-3', at: now - DAY_MS, costUsd: 10, compactions: 1 }),
  // Восемь суток назад: мимо и недели.
  run({ taskId: 'T-4', at: now - 8 * DAY_MS, costUsd: 100, compactions: 5 }),
  // Из будущего относительно конца периода — тоже мимо.
  run({ taskId: 'T-5', at: now + DAY_MS, costUsd: 100 }),
];
// Ещё одиннадцать мелких задач: проверить, что топ режется на десяти.
for (let i = 0; i < 11; i++) runs.push(run({ taskId: `T-1${i}`, costUsd: 0.01 * (i + 1) }));

const titles: Record<string, string> = { 'T-1': 'Большая задача', 'T-2': 'Ревью' };
const roles: Record<string, string> = { backend: 'Бэкенд', reviewer: 'Ревьюер', pm: 'Менеджер' };
const build = (period: 'day' | 'week'): SpendReport => buildSpendReport(runs, {
  period, to: now, lang: 'ru', officeId: 'o-test',
  taskTitle: (id) => titles[id], roleTitle: (id) => roles[id],
});
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const sum = (xs: { costUsd: number }[]) => xs.reduce((s, x) => s + x.costUsd, 0);

// ---------- период ----------

const day = build('day');
const week = build('week');
const dayCost = 4 + 3 + 1 + 2 + 0.5 + Array.from({ length: 11 }, (_, i) => 0.01 * (i + 1)).reduce((a, b) => a + b, 0);
results.push(
  `сутки начинаются с полуночи: ${day.from === new Date(noon).setHours(0, 0, 0, 0) && day.to === now}`,
  `неделя — семь суток: ${week.from === reportRange('day', now).from - 6 * DAY_MS}`,
  `итог за сутки — только сегодняшние запуски: ${near(day.total.costUsd, dayCost) && day.total.runs === 16}`,
  `итог за неделю — со вчерашним, без старого и будущего: ${near(week.total.costUsd, dayCost + 10)
    && week.total.runs === 17}`,
  `неизвестный период — неделя: ${asPeriod('month') === 'week' && asPeriod(' day ') === 'day'}`,
  `неизвестная цена видна в итоге: ${day.total.costUnavailable === true}`,
);

// ---------- срезы ----------

const bySum = (r: SpendReport) => [r.byTask, r.byRole, r.byNode, r.byModel, r.byDay]
  .every((slices) => near(sum(slices), r.total.costUsd)
    && slices.reduce((n, s) => n + s.runs, 0) === r.total.runs);
const t1 = day.byTask.find((s) => s.key === 'T-1');
const backend = day.byRole.find((s) => s.key === 'backend');
results.push(
  `каждый срез в сумме даёт итог: ${bySum(day) && bySum(week)}`,
  `срез по задаче: сумма, токены, подпись: ${t1?.costUsd === 7 && t1.runs === 2
    && t1.cache_read_input_tokens === 190_000 && t1.label === 'Большая задача'}`,
  `доля кэша — чтение во всём вводе: ${near(t1!.cacheReadShare!, 190_000 / 200_000)}`,
  `средний префикс по замеренным: ${t1?.avgPrefixTokens === 50_000}`,
  `сжатия и повторы суммируются: ${t1?.compactions === 2 && t1.wideRetries === 1}`,
  `запуски вне задачи — отдельной группой: ${day.byTask.some((s) => s.key === NO_KEY && s.label === 'Вне задачи')}`,
  `срез по роли с подписью; без подписи — id: ${backend?.label === 'Бэкенд'
    && day.byRole.find((s) => s.key === 'design')?.label === 'design'}`,
  `срез по процессу и узлу: ${day.byNode.find((s) => s.key === 'task-default/work')?.costUsd === 7
    && day.byNode.find((s) => s.key === 'task-default/review')?.costUsd === 1
    && day.byNode.some((s) => s.key === NO_KEY)}`,
  `срез по модели: ${near(day.byModel.find((s) => s.key === 'claude-sonnet-5')?.costUsd ?? 0, 3)}`,
  `срез по суткам, от старых к свежим: ${week.byDay.length === 2 && week.byDay[0]!.key < week.byDay[1]!.key
    && week.byDay[0]!.costUsd === 10}`,
  `срезы — по убыванию стоимости: ${day.byTask[0]?.key === 'T-1'}`,
);

// ---------- главные потребители ----------

results.push(
  `топ задач не длиннее ${S.topTasks}: ${week.topTasks.length === S.topTasks}`,
  `топ без запусков вне задачи и по убыванию: ${week.topTasks.every((s) => s.key !== NO_KEY)
    && week.topTasks.map((s) => s.key).slice(0, 3).join(',') === 'T-3,T-1,T-2'}`,
);

// ---------- сигналы ----------

const find = (r: SpendReport, kind: string, id: string) =>
  r.signals.filter((s) => s.kind === kind && s.target.id === id);
const pmCache = find(day, 'lowCache', 'pm')[0];
results.push(
  `плохой кэш роли — alert со ссылкой на роль: ${pmCache?.severity === 'alert'
    && pmCache.target.kind === 'role' && pmCache.target.label === 'Менеджер'}`,
  `в пояснении доля и порог: ${pmCache?.text.includes('4%') === true
    && pmCache.text.includes(`${Math.round(S.lowCacheWarn * 100)}%`)}`,
  `малый ввод не судим: ${find(day, 'lowCache', 'design').length === 0}`,
  `хороший кэш не сигналит: ${find(day, 'lowCache', 'backend').length === 0}`,
  `кэш офиса считается по всему вводу: ${(() => {
    const share = day.total.cacheReadShare!;
    const office = find(day, 'lowCache', 'o-test')[0];
    return share < S.lowCacheWarn ? office?.target.kind === 'office' : office === undefined;
  })()}`,
  `два сжатия — warn со ссылкой на задачу: ${find(day, 'compactions', 'T-1')[0]?.severity === 'warn'
    && find(day, 'compactions', 'T-1')[0]?.target.kind === 'task'}`,
  `три сжатия — alert: ${find(day, 'compactions', 'T-2')[0]?.severity === 'alert'}`,
  `повтор на широком окне — alert: ${find(day, 'wideRetries', 'T-1')[0]?.severity === 'alert'}`,
  `вчерашняя задача — только в неделе: ${find(day, 'compactions', 'T-3').length === 0
    && find(week, 'compactions', 'T-3').length === 1}`,
  `запуски вне периода сигналов не дают: ${find(week, 'compactions', 'T-4').length === 0}`,
  `большой префикс роли — alert у ревьюера: ${find(day, 'bigPrefix', 'reviewer')[0]?.severity === 'alert'
    && find(day, 'bigPrefix', 'reviewer')[0]?.text.includes('100K') === true}`,
  `средний префикс бэкенда 50К — ровно на пороге warn: ${find(day, 'bigPrefix', 'backend')[0]?.severity === 'warn'}`,
  `роль с малым префиксом не сигналит: ${find(day, 'bigPrefix', 'pm').length === 0}`,
  `сначала alert, внутри — по стоимости: ${day.signals.every((s, i, all) => i === 0
    || (all[i - 1]!.severity === 'alert' && s.severity === 'warn')
    || (all[i - 1]!.severity === s.severity && all[i - 1]!.costUsd >= s.costUsd))}`,
  `у каждого сигнала есть пояснение и ссылка: ${day.signals.length > 0
    && day.signals.every((s) => s.text.length > 20 && s.target.id.length > 0)}`,
);

// Пустой офис: всё по нулям, сигналов нет, ничего не падает.
const empty = buildSpendReport([], { period: 'week', to: now, lang: 'en', officeId: 'o' });
results.push(`пустые запуски — пустой разбор: ${empty.total.runs === 0 && empty.total.cacheReadShare === null
  && empty.signals.length === 0 && empty.topTasks.length === 0 && empty.total.label === 'Whole office'}`);

const failed = results.filter((r) => !r.endsWith('true'));
for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
console.log(failed.length
  ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
  : `Все проверки прошли: ${results.length}`);
process.exit(failed.length ? 1 : 0);
