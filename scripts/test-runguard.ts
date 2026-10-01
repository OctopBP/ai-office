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
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

process.env.OFFICE_LANG = 'ru';

const {
  BUDGET_DEFAULT_TOKENS, BUDGET_HISTORY, BUDGET_MIN_HISTORY, RunGuard, runKind, runThreshold,
} = await import('../src/server/runguard');
const { openOfficeState } = await import('../src/server/state');
const { driveWorker } = await import('../src/server/agents');
const { recordOutcome } = await import('../src/server/outcomes');
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
    && byTokens.run.failed.includes('порог по умолчанию') && !byTokens.run.thrashed}`,
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

// Исход задачи — stopped_budget с цифрами; дошедшая потом до конца задача его перекрывает.
const outcome = recordOutcome(office, task.id, 'stopped_budget', Date.now(), byTokens.run.budget!);
results.push(`исход stopped_budget хранит цифры: ${outcome?.kind === 'stopped_budget'
  && outcome.budget?.limitTokens === BUDGET_DEFAULT_TOKENS}`);
const later = recordOutcome(office, task.id, 'stuck');
results.push(`исход после решения человека перекрывает остановку: ${later?.kind === 'stuck'
  && office.tasks.get(task.id)?.outcome?.budget === undefined}`);

const failed = results.filter((r) => !r.endsWith('true'));
for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
console.log(failed.length
  ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
  : `Все проверки прошли: ${results.length}`);
process.exit(failed.length ? 1 : 0);
