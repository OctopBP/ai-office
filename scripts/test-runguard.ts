/**
 * Предохранитель расхода запуска без единого токена: порог из истории роли и
 * типа работы, порог по умолчанию при короткой истории, предупреждение на 80%,
 * остановка на 100% и молотилка из трёх автосжатий подряд. Последние два —
 * и на счётчиках, и сквозь цикл исполнителя на поддельной сессии: важно не
 * только «счётчик сказал стоп», но и что сессию правда попросили прерваться.
 *
 * Запуск: npm run test:runguard
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

process.env.OFFICE_LANG = 'ru';

const {
  BUDGET_DEFAULT_TOKENS, BUDGET_HISTORY, BUDGET_MIN_HISTORY, BUDGET_ROLE_MAX_TOKENS,
  RunGuard, runKind, runThreshold, sanitizeSpendFuse,
} = await import('../src/server/runguard');
const { openOfficeState } = await import('../src/server/state');
const { driveWorker } = await import('../src/server/agents');
const { recordOutcome } = await import('../src/server/outcomes');
const { loadPackage } = await import('../src/server/packages');
const { taskAnomalies } = await import('../src/server/spendReport');
type AgentRunEntry = import('../src/server/spend').AgentRunEntry;
type WorkerOpen = import('../src/server/agents').WorkerOpen;

const results: string[] = [];

let seq = 0;
function entry(over: Partial<AgentRunEntry>): AgentRunEntry {
  seq += 1;
  return {
    id: `A-${seq}`, at: Date.now(), office: 'o-test', taskId: 'T-1', workflowId: null, nodeId: null,
    roleId: 'backend', instanceId: 'backend#1', model: 'claude-opus-5',
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
    prefixTokens: null, compactions: 0, wideRetries: 0, costUsd: 0,
    ...over,
  };
}
/** Запуск на `tokens` входных токенов: ввод, чтение и запись кеша поровну с остатком. */
const spent = (tokens: number, over: Partial<AgentRunEntry> = {}) => entry({
  input_tokens: tokens - 2 * Math.floor(tokens / 3),
  cache_read_input_tokens: Math.floor(tokens / 3),
  cache_creation_input_tokens: Math.floor(tokens / 3),
  ...over,
});

// ---------- порог ----------

const empty = runThreshold([], 'backend', 'task');
results.push(`без истории — порог по умолчанию: ${empty.source === 'default'
  && empty.tokens === BUDGET_DEFAULT_TOKENS && empty.median === null && empty.samples === 0}`);

const short = Array.from({ length: BUDGET_MIN_HISTORY - 1 }, () => spent(100_000));
const shortT = runThreshold(short, 'backend', 'task');
results.push(`истории ${BUDGET_MIN_HISTORY - 1} запусков — ещё по умолчанию: ${
  shortT.source === 'default' && shortT.tokens === BUDGET_DEFAULT_TOKENS && shortT.samples === BUDGET_MIN_HISTORY - 1}`);

// Десять запусков от 100K до 1M: медиана — среднее 500K и 600K, порог втрое.
const ten = Array.from({ length: 10 }, (_, i) => spent((i + 1) * 100_000));
const tenT = runThreshold(ten, 'backend', 'task');
results.push(`десять запусков — медиана ×3: ${tenT.source === 'history'
  && tenT.median === 550_000 && tenT.tokens === 1_650_000 && tenT.samples === 10}`);

// Кеш входит в счёт: запуск из одного cache_read не «бесплатный».
const cacheOnly = Array.from({ length: 10 }, () => entry({ cache_read_input_tokens: 400_000 }));
results.push(`чтение кеша считается входом: ${runThreshold(cacheOnly, 'backend', 'task').tokens === 1_200_000}`);

// Берутся только последние 30: старые дорогие запуски порог не раздувают.
const old = Array.from({ length: 20 }, () => spent(5_000_000));
const recent = Array.from({ length: BUDGET_HISTORY }, () => spent(200_000));
const windowT = runThreshold([...old, ...recent], 'backend', 'task');
results.push(`в медиану идут последние ${BUDGET_HISTORY}: ${windowT.samples === BUDGET_HISTORY
  && windowT.median === 200_000 && windowT.tokens === 600_000}`);

// Чужая роль, чужой тип работы и запуски вне задачи в историю не идут.
const mixed = [
  ...Array.from({ length: 10 }, () => spent(300_000)),
  ...Array.from({ length: 10 }, () => spent(9_000_000, { roleId: 'frontend' })),
  ...Array.from({ length: 10 }, () => spent(9_000_000, { nodeId: 'review', workflowId: 'task-default' })),
  ...Array.from({ length: 10 }, () => spent(9_000_000, { taskId: null })),
];
const mine = runThreshold(mixed, 'backend', 'task');
const review = runThreshold(mixed, 'backend', 'review');
results.push(
  `порог по своей роли и типу: ${mine.source === 'history' && mine.samples === 10 && mine.tokens === 900_000}`,
  `узел процесса — свой тип работы: ${runKind('review') === 'review' && runKind(null) === 'task'
    && review.samples === 10 && review.tokens === 27_000_000}`,
  `у другой роли своя история: ${runThreshold(mixed, 'frontend', 'task').tokens === 27_000_000}`,
  `роль без запусков — по умолчанию: ${runThreshold(mixed, 'designer', 'task').source === 'default'}`,
);

// Пустые запуски не дают порог ноль: такой останавливал бы всё подряд.
const zeros = runThreshold(Array.from({ length: 10 }, () => entry({})), 'backend', 'task');
results.push(`медиана нулей не обнуляет порог: ${zeros.source === 'history' && zeros.tokens > 0}`);

// ---------- триггер токенов на счётчиках ----------

const threshold = { tokens: 1_000_000, source: 'default' as const, median: null, samples: 0 };
{
  const g = new RunGuard(threshold);
  const a = g.usage('m1', 300_000);
  // Тот же вызов модели приходит блоками с одной usage — повтор не складывается.
  const a2 = g.usage('m1', 300_000);
  const b = g.usage('m2', 400_000);
  const afterB = g.spent;
  const c = g.usage('m3', 100_000); // 800K — ровно 80%
  const c2 = g.usage('m4', 50_000); // предупреждение не повторяется
  const d = g.usage('m5', 150_000); // 1M — стоп
  const d2 = g.usage('m6', 10_000); // стоп не повторяется
  results.push(
    `до 80% тихо, блоки одного вызова не удваиваются: ${a === null && a2 === null && b === null && afterB === 700_000}`,
    `на 80% — предупреждение: ${c?.kind === 'warn' && c.spentTokens === 800_000 && c.limitTokens === 1_000_000}`,
    `предупреждение одно: ${c2 === null}`,
    `на 100% — остановка с цифрами: ${d?.kind === 'stop' && d.stop.reason === 'tokens'
      && d.stop.spentTokens === 1_000_000 && d.stop.limitTokens === 1_000_000 && d.stop.limitSource === 'default'}`,
    `остановка одна: ${d2 === null}`,
  );
}
{
  // Один вызов сразу за порогом — остановка без предупреждения, не наоборот.
  const g = new RunGuard(threshold);
  const s = g.usage('m1', 1_200_000);
  results.push(`прыжок через порог — сразу стоп: ${s?.kind === 'stop'}`);
}

// ---------- триггер молотилки на счётчиках ----------

{
  const g = new RunGuard(threshold);
  const s1 = g.compaction('auto');
  const sManual = g.compaction('manual');
  const s2 = g.compaction('auto');
  const s3 = g.compaction('auto');
  results.push(
    `ручное сжатие не в счёт, третье автосжатие — стоп: ${s1 === null && sManual === null && s2 === null
      && s3?.kind === 'stop' && s3.stop.reason === 'compactions' && s3.stop.compactions === 3}`,
  );
  const h = new RunGuard(threshold);
  h.compaction('auto'); h.compaction('auto');
  h.turnEnded();
  const after = h.compaction('auto');
  results.push(`законченный ход прерывает серию: ${after === null}`);
}

// ---------- сквозь цикл исполнителя ----------

const office = openOfficeState({
  id: 'o-guard', projectDir: resolve(tmpdir(), 'guard'), stateFile: resolve(tmpdir(), `guard-${process.pid}.json`),
}).state;
const worker = office.instances.get('backend#1')!;
const role = office.role('backend')!;
const task = office.createTask({ title: 'Дорогая задача', description: 'проверка предохранителя', criteria: [], roleId: 'backend' });
worker.currentTaskId = task.id;

type Msg = Record<string, unknown>;
/**
 * Поддельная сессия: отдаёт сообщения по одному и, как настоящий SDK, после
 * interrupt() закрывает ход результатом с ошибкой. Всё, что после прерывания,
 * уже не отдаётся — сессия правда остановилась.
 */
function fakeSession(messages: Msg[]) {
  const state = { interrupted: false, drained: 0 };
  const stream = (async function* () {
    for (const m of messages) {
      if (state.interrupted) break;
      state.drained += 1;
      yield m;
    }
    yield { type: 'result', subtype: state.interrupted ? 'error_during_execution' : 'success',
      is_error: state.interrupted, result: state.interrupted ? 'прервано' : 'готово' };
  })();
  const session = Object.assign(stream, {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('нет'); },
    mcpServerStatus: async () => [],
    interrupt: async () => { state.interrupted = true; },
  });
  return { session, state };
}
const call = (id: string, cacheRead: number): Msg => ({
  type: 'assistant', session_id: 'sess-g',
  message: { id, content: [], usage: { input_tokens: 0, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
});
const autoCompact: Msg = {
  type: 'system', subtype: 'compact_boundary', session_id: 'sess-g',
  compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 30_000 },
};
async function drive(messages: Msg[]) {
  const fake = fakeSession(messages);
  const logFrom = office.log.length;
  const run = await driveWorker(office, worker, role, { resume: undefined, prompt: 'задача', resumed: null },
    (() => fake.session) as unknown as WorkerOpen);
  return { run, fake, logs: office.log.slice(logFrom).map((e) => e.text) };
}

// Истории нет — порог 2M. Вызовы по 400K: на 1.6M предупреждение, на 2M —
// стоп, шестой вызов сессия уже не отдаёт.
const step = BUDGET_DEFAULT_TOKENS / 5;
const byTokens = await drive([
  call('c1', step), call('c2', step), call('c3', step), call('c4', step), call('c5', step), call('c6', step),
]);
const warnLogged = byTokens.logs.find((l) => l.includes('80% порога запуска'));
results.push(
  `цикл: на 80% предупреждение в логе: ${Boolean(warnLogged) && warnLogged!.includes(task.id)
    && warnLogged!.includes('1600 тыс.') && warnLogged!.includes('2000 тыс.')}`,
  `цикл: предупреждение попало в события офиса: ${office.chat.some((m) => m.text.includes('80% порога запуска'))}`,
  `цикл: на 100% сессию попросили прерваться: ${byTokens.fake.state.interrupted && byTokens.fake.state.drained === 5}`,
  `цикл: запуск вернул остановку с причиной и цифрами: ${byTokens.run.budget?.reason === 'tokens'
    && byTokens.run.budget.spentTokens === BUDGET_DEFAULT_TOKENS
    && byTokens.run.failed !== null && byTokens.run.failed.includes('2000 тыс.')
    && byTokens.run.failed.includes('по умолчанию: истории меньше') && !byTokens.run.thrashed}`,
);

// Три автосжатия подряд при копеечном расходе — тоже остановка.
const byThrash = await drive([call('t1', 10_000), autoCompact, call('t2', 10_000), autoCompact, autoCompact, call('t3', 10_000)]);
results.push(
  `цикл: три автосжатия подряд останавливают запуск: ${byThrash.fake.state.interrupted
    && byThrash.run.budget?.reason === 'compactions' && byThrash.run.budget.compactions === 3}`,
  `цикл: причина молотилки понятна: ${byThrash.run.failed?.includes('сжимался 3 раза подряд') === true
    && byThrash.logs.some((l) => l.includes('предохранитель расхода останавливает запуск'))}`,
);

// Спокойный запуск не трогается.
const calm = await drive([call('k1', 10_000), autoCompact, call('k2', 10_000)]);
results.push(`цикл: спокойный запуск идёт как раньше: ${calm.run.budget === null && calm.run.failed === null
  && calm.run.text === 'готово' && !calm.fake.state.interrupted}`);

// Остановка попадает в записи о запусках — по ним разбор расхода считает stopped_budget.
const stoppedRuns = () => office.agentRunList().filter((r) => r.instanceId === worker.id && r.stoppedBudget);
results.push(`запуски: обе остановки записаны, спокойный запуск — нет: ${stoppedRuns().length === 2
  && stoppedRuns().every((r) => r.taskId === task.id)}`);
// Результат пришёл после остановки — пометка ложится на его запись, новой не появляется.
const stopAt = Date.now();
office.addUsage(worker.id, { costUsd: 0.1, tokensIn: 10, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, null, 'sess-x');
const runsBefore = office.agentRunList().length;
office.noteBudgetStop(worker.id, stopAt);
const last = office.agentRunList().at(-1);
results.push(`запуски: пометка на записи пришедшего результата: ${office.agentRunList().length === runsBefore
  && last?.stoppedBudget === true && last.costUsd === 0.1}`);

// Исход задачи — stopped_budget с цифрами; дошедшая потом до конца задача его перекрывает.
const outcome = recordOutcome(office, task.id, 'stopped_budget', Date.now(), byTokens.run.budget!);
results.push(`исход stopped_budget хранит цифры: ${outcome?.kind === 'stopped_budget'
  && outcome.budget?.limitTokens === BUDGET_DEFAULT_TOKENS}`);
const later = recordOutcome(office, task.id, 'stuck');
results.push(`исход после решения человека перекрывает остановку: ${later?.kind === 'stuck'
  && office.tasks.get(task.id)?.outcome?.budget === undefined}`);

// ---------- свой порог роли (T-559) ----------

const QA_FUSE = 5_000_000;
// Свой порог сильнее и константы, и истории; история остаётся справкой.
const ownEmpty = runThreshold([], 'qa', 'task', QA_FUSE);
const ownOverHistory = runThreshold(ten, 'backend', 'task', QA_FUSE);
results.push(
  `свой порог роли сильнее порога по умолчанию: ${ownEmpty.tokens === QA_FUSE && ownEmpty.source === 'role'
    && ownEmpty.median === null}`,
  `свой порог роли сильнее истории: ${ownOverHistory.tokens === QA_FUSE && ownOverHistory.source === 'role'
    && ownOverHistory.median === tenT.median && ownOverHistory.samples === 10}`,
  `порог роли null и непригодный не действуют: ${runThreshold([], 'qa', 'task', null).source === 'default'
    && runThreshold([], 'qa', 'task', 100).tokens === BUDGET_DEFAULT_TOKENS
    && runThreshold([], 'qa', 'task', 2_500_000.5).source === 'default'}`,
  `границы своего порога: ${sanitizeSpendFuse(BUDGET_DEFAULT_TOKENS) === BUDGET_DEFAULT_TOKENS
    && sanitizeSpendFuse(BUDGET_ROLE_MAX_TOKENS) === BUDGET_ROLE_MAX_TOKENS && sanitizeSpendFuse(null) === null
    && sanitizeSpendFuse(BUDGET_DEFAULT_TOKENS - 1) === undefined
    && sanitizeSpendFuse(BUDGET_ROLE_MAX_TOKENS + 1) === undefined
    && sanitizeSpendFuse('5000000') === undefined && sanitizeSpendFuse(3_000_000.5) === undefined
    && sanitizeSpendFuse(NaN) === undefined}`,
);

// Пакет тестировщика несёт 5 млн, остальные роли — без своего порога.
if (!office.roles().some((r) => r.package?.name === '@office/qa')) {
  office.hireFromPackage(loadPackage('@office/qa')!, null);
}
const qaId = office.roles().find((r) => r.package?.name === '@office/qa')?.id ?? '';
const qa = () => office.role(qaId)!;
results.push(
  `пакет qa: порог 5 млн в манифесте и у нанятой роли: ${
    loadPackage('@office/qa')!.manifest.runtime.spendFuseTokens === QA_FUSE && qa().spendFuseTokens === QA_FUSE}`,
  `у остальных ролей своего порога нет: ${office.roles().filter((r) => r.id !== qaId)
    .every((r) => r.spendFuseTokens === undefined || r.spendFuseTokens === null)}`,
  `снимок роли для UI несёт порог: ${office.roleViews().find((r) => r.id === qaId)?.spendFuseTokens === QA_FUSE
    && office.roleViews().find((r) => r.id === 'backend')?.spendFuseTokens === null}`,
);

// PATCH роли: границы проверяются, неверное отклоняется и ничего не меняет.
const bad: unknown[] = [BUDGET_DEFAULT_TOKENS - 1, BUDGET_ROLE_MAX_TOKENS + 1, 3_000_000.5, '5000000', 0, -1];
const refusals = [];
for (const value of bad) {
  refusals.push(await office.editRole('backend', { spendFuseTokens: value as number }));
}
results.push(
  `PATCH: неверные значения отклонены с ошибкой поля: ${refusals.every((e) => e.length === 1
    && e[0].field === 'spendFuseTokens' && e[0].message.includes('2000000') && e[0].message.includes('20000000'))
    && office.role('backend')!.spendFuseTokens === undefined}`,
);
const okPatch = await office.editRole('backend', { spendFuseTokens: 3_000_000 });
results.push(`PATCH: годное значение принято: ${okPatch.length === 0 && office.role('backend')!.spendFuseTokens === 3_000_000
  && office.role('backend')!.package?.overrides.spendFuseTokens === 3_000_000}`);
const backPatch = await office.editRole('backend', { spendFuseTokens: null });
results.push(`PATCH: null возвращает общий порог: ${backPatch.length === 0 && !office.role('backend')!.spendFuseTokens
  && office.role('backend')!.package?.overrides.spendFuseTokens === undefined}`);
await office.editRole(qaId, { spendFuseTokens: 8_000_000 });
results.push(`PATCH: ручной порог qa держится оверрайдом: ${qa().spendFuseTokens === 8_000_000
  && qa().package?.overrides.spendFuseTokens === 8_000_000}`);
await office.editRole(qaId, { spendFuseTokens: QA_FUSE });
results.push(`PATCH: вернули умолчание пакета — оверрайд снят: ${qa().spendFuseTokens === QA_FUSE
  && qa().package?.overrides.spendFuseTokens === undefined}`);

// Сквозь цикл: у qa запуск идёт за 2 млн и останавливается на своих 5 млн,
// а причина называет действующий порог и то, что он задан у роли.
const qaWorker = [...office.instances.values()].find((i) => i.roleId === qaId)!;
const qaTask = office.createTask({ title: 'Браузерная проверка', description: 'порог роли', criteria: [], roleId: qaId });
qaWorker.currentTaskId = qaTask.id;
async function driveAs(inst: typeof worker, as: typeof role, messages: Msg[]) {
  const fake = fakeSession(messages);
  const logFrom = office.log.length;
  const run = await driveWorker(office, inst, as, { resume: undefined, prompt: 'задача', resumed: null },
    (() => fake.session) as unknown as WorkerOpen);
  return { run, fake, logs: office.log.slice(logFrom).map((e) => e.text) };
}
const million = 1_000_000;
const qaCalm = await driveAs(qaWorker, qa(), [call('q1', million), call('q2', million), call('q3', million)]);
results.push(`цикл qa: 3 млн — выше общего порога, запуск идёт: ${qaCalm.run.budget === null
  && !qaCalm.fake.state.interrupted && qaCalm.run.text === 'готово'}`);
const qaStop = await driveAs(qaWorker, qa(),
  [1, 2, 3, 4, 5, 6].map((n) => call(`s${n}`, million)));
results.push(
  `цикл qa: остановка на 5 млн: ${qaStop.fake.state.interrupted && qaStop.fake.state.drained === 5
    && qaStop.run.budget?.limitTokens === QA_FUSE && qaStop.run.budget.limitSource === 'role'}`,
  `цикл qa: сообщение называет действующий порог роли: ${qaStop.run.failed?.includes('5000 тыс.') === true
    && qaStop.run.failed.includes('задан для роли') && qaStop.run.failed.includes(qa().title)
    && qaStop.logs.some((l) => l.includes('предохранитель расхода останавливает запуск') && l.includes('5000 тыс.'))}`,
  `цикл qa: предупреждение на 80% своего порога: ${qaStop.logs.some((l) => l.includes('80% порога запуска')
    && l.includes('4000 тыс.') && l.includes('5000 тыс.'))}`,
);
// Молотилка тоже называет действующий порог.
const qaThrash = await driveAs(qaWorker, qa(), [call('m1', 10_000), autoCompact, autoCompact, autoCompact]);
results.push(`цикл qa: молотилка называет порог роли: ${qaThrash.run.failed?.includes('5000 тыс.') === true
  && qaThrash.run.failed.includes('задан для роли')}`);
// Остальные роли — на прежнем пороге и после всех правок.
worker.currentTaskId = task.id;
const backendAgain = await drive([1, 2, 3, 4, 5, 6].map((n) => call(`b${n}`, step)));
results.push(`цикл: у backend порог прежний: ${backendAgain.run.budget?.limitTokens === BUDGET_DEFAULT_TOKENS
  && backendAgain.run.budget.limitSource === 'default'}`);

// ---------- порог офиса (T-605) ----------

// Порядок источников: роль → офис → история → умолчание.
const OFFICE_FUSE = 4_000_000;
const officeOnly = runThreshold([], 'design', 'task', null, OFFICE_FUSE);
const officeOverHistory = runThreshold(ten, 'backend', 'task', undefined, OFFICE_FUSE);
const roleOverOffice = runThreshold(ten, 'backend', 'task', QA_FUSE, OFFICE_FUSE);
results.push(
  `порядок: порог офиса сильнее умолчания: ${officeOnly.tokens === OFFICE_FUSE && officeOnly.source === 'office'}`,
  `порядок: порог офиса сильнее истории: ${officeOverHistory.tokens === OFFICE_FUSE
    && officeOverHistory.source === 'office' && officeOverHistory.median === tenT.median}`,
  `порядок: порог роли сильнее порога офиса: ${roleOverOffice.tokens === QA_FUSE && roleOverOffice.source === 'role'}`,
  `порядок: офис 0 и null — не задан: ${runThreshold(ten, 'backend', 'task', null, 0).source === 'history'
    && runThreshold([], 'backend', 'task', null, null).source === 'default'
    && runThreshold([], 'backend', 'task', null, 100).tokens === BUDGET_DEFAULT_TOKENS}`,
);
// Настройка офиса: правка существующей командой, мусор не принимается, 0 снимает.
office.updateSettings({ spendFuseTokens: OFFICE_FUSE });
const settingSet = office.settings.spendFuseTokens === OFFICE_FUSE;
office.updateSettings({ spendFuseTokens: 100 });
const garbageKept = office.settings.spendFuseTokens === OFFICE_FUSE;
results.push(`настройки: порог офиса принят, мусор не затирает: ${settingSet && garbageKept}`);
// Сквозь цикл: backend без своего порога останавливается на пороге офиса,
// а qa со своим 5 млн — по-прежнему на своём.
const backendOffice = await drive([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => call(`o${n}`, million / 2)));
results.push(
  `цикл: backend стоп на пороге офиса: ${backendOffice.run.budget?.limitTokens === OFFICE_FUSE
    && backendOffice.run.budget.limitSource === 'office'}`,
  `цикл: сообщение называет порог офиса: ${backendOffice.run.failed?.includes('задан для офиса') === true
    && backendOffice.logs.some((l) => l.includes('% порога запуска') && l.includes('(задан для офиса)'))}`,
);
const qaWithOffice = await driveAs(qaWorker, qa(), [1, 2, 3, 4, 5, 6].map((n) => call(`w${n}`, million)));
results.push(`цикл: у qa порог роли сильнее офиса: ${qaWithOffice.run.budget?.limitTokens === QA_FUSE
  && qaWithOffice.run.budget.limitSource === 'role'}`);
office.updateSettings({ spendFuseTokens: 0 });
results.push(`настройки: 0 снимает порог офиса: ${office.settings.spendFuseTokens === null}`);

// Разбор расхода: запуск qa в пределах своего порога — не аномалия.
const qaRun = [spent(3_000_000, { roleId: qaId, taskId: 'T-qa' })];
const slice = { key: 'T-qa', label: 'T-qa', costUsd: 1 } as Parameters<typeof taskAnomalies>[0];
results.push(`разбор расхода знает порог роли: ${
  taskAnomalies(slice, qaRun, qaRun, 'ru').some((a) => a.kind === 'overBudget')
  && !taskAnomalies(slice, qaRun, qaRun, 'ru', (id) => office.role(id)?.spendFuseTokens).some((a) => a.kind === 'overBudget')}`);

// ---------- миграция нанятого тестировщика ----------

// Сохранение старше T-559: миграция не проведена, порога у ролей нет.
const plain = { title: 'Тестировщик', emoji: '🧪', color: '#0d9488', permissionMode: null, isolate: true, brief: 'свой бриф' };
const saved = {
  version: 1, projectDir: resolve(tmpdir(), 'guard-old'),
  roleMigrations: ['sonnet-5-to-5-5'],
  roles: [
    { id: 'qa', package: { name: '@office/qa', version: '1.0.0', overrides: {}, briefExtra: '' } },
    { id: 'qa-2', ...plain, title: 'Тестировщик без пакета' },
    { id: 'qa-3', ...plain, title: 'Тестировщик с ручным порогом', spendFuseTokens: 9_000_000 },
    { id: 'qa-4', ...plain, title: 'Тестировщик со снятым порогом', spendFuseTokens: null },
    { id: 'qa-5', package: { name: '@office/qa', version: '1.0.0', overrides: { spendFuseTokens: 7_000_000 }, briefExtra: '' } },
    { id: 'writer', ...plain, title: 'Писатель' },
    { id: 'qa-6', ...plain, title: 'Тестировщик с мусором', spendFuseTokens: 12 },
  ],
};
const savedFile = resolve(tmpdir(), `guard-saved-${process.pid}.json`);
writeFileSync(savedFile, JSON.stringify(saved));
const fuses = (o: typeof office) => Object.fromEntries(o.roles().map((r) => [r.id, r.spendFuseTokens]));
const aged = openOfficeState({ id: 'o-guard-old', projectDir: resolve(tmpdir(), 'guard-old'), stateFile: savedFile }).state;
const f1 = fuses(aged);
results.push(
  `миграция: нанятая из пакета qa получает 5 млн: ${f1.qa === QA_FUSE}`,
  `миграция: qa без пакета получает 5 млн: ${f1['qa-2'] === QA_FUSE}`,
  `миграция: ручное значение не затёрто: ${f1['qa-3'] === 9_000_000 && f1['qa-5'] === 7_000_000}`,
  `миграция: снятый владельцем порог не возвращается: ${f1['qa-4'] === null}`,
  `миграция: остальные роли без своего порога: ${!f1.writer && !f1.pm && !f1.backend}`,
  `миграция: мусор в сохранении заменён умолчанием: ${f1['qa-6'] === QA_FUSE}`,
);
// Повторная загрузка того же офиса ничего не меняет; снятое после миграции не возвращается.
await aged.editRole('qa-2', { spendFuseTokens: null });
aged.flush();
const again = openOfficeState({ id: 'o-guard-again', projectDir: resolve(tmpdir(), 'guard-old'), stateFile: savedFile }).state;
const f2 = fuses(again);
results.push(`миграция идемпотентна: ${f2.qa === QA_FUSE && f2['qa-2'] === null && f2['qa-3'] === 9_000_000
  && f2['qa-4'] === null && f2['qa-5'] === 7_000_000 && f2['qa-6'] === QA_FUSE && !f2.writer}`);

const failed = results.filter((r) => !r.endsWith('true'));
for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
console.log(failed.length
  ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
  : `Все проверки прошли: ${results.length}`);
process.exit(failed.length ? 1 : 0);
