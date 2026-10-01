/**
 * Разбор расхода: агрегаты по запускам агентов за сутки или неделю и сигналы
 * перерасхода (контракт — `src/shared/spendReport.ts`).
 *
 * Считается на месте из `agentRuns` при каждом запросе, ничего не копит:
 * запусков не больше RUNS_MAX, и проход по ним дешевле, чем держать
 * накопители согласованными с подрезкой истории.
 */
import { dayKey } from '../shared/types';
import type { Lang } from '../shared/i18n';
import type {
  SpendAnomaly, SpendReport, SpendReportPeriod, SpendSignal, SpendSignalTarget, SpendSlice, SpendTopTask,
} from '../shared/spendReport';
import { t } from './i18n';
import { runInputTokens, runKind, runThreshold } from './runguard';
import { dayStart, type AgentRunEntry } from './spend';
import type { OfficeState } from './state';

/**
 * Пороги сигналов перерасхода — все в одном месте. Правило сигнала —
 * сравнение с порогом и ничего больше: человек, увидевший сигнал, должен
 * суметь пересчитать его в уме.
 */
export const SPEND_SIGNALS = {
  /**
   * Доля чтения из кэша во всём вводе. У живой сессии Claude она обычно выше
   * 0.8: префикс пишется в кэш один раз и дальше читается. Ниже — кэш
   * сбрасывается, и каждый ход оплачивается по полной цене ввода.
   */
  lowCacheWarn: 0.5,
  lowCacheAlert: 0.2,
  /**
   * Меньше этого ввода за период долю кэша не судим: у пары коротких
   * запусков она низкая просто потому, что кэшу не на чем окупиться.
   */
  lowCacheMinInput: 200_000,
  /** Сжатий контекста по задаче за период. */
  compactionsWarn: 1,
  compactionsAlert: 3,
  /** Повторов на широком окне по задаче: любой повтор — уже сгоревший заход. */
  wideRetriesAlert: 1,
  /**
   * Средний стартовый префикс роли, токенов. Окно исполнителя выбирается по
   * префиксу, и при 57К уже не хватало 120К (см. driveWorker), — отсюда порог.
   */
  bigPrefixWarn: 50_000,
  bigPrefixAlert: 90_000,
  /** Сколько ролей с большим префиксом показываем: самые тяжёлые. */
  bigPrefixTop: 3,
  /** Длина списка главных потребителей. */
  topTasks: 10,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ключ группы для запусков без задачи и без процесса. */
export const NO_KEY = '-';

/** Границы периода: сутки — с полуночи, неделя — семь суток с полуночи. */
export function reportRange(period: SpendReportPeriod, to: number): { from: number; to: number } {
  const days = period === 'day' ? 1 : 7;
  return { from: dayStart(to) - (days - 1) * DAY_MS, to };
}

/** Период из параметра запроса: всё, что не 'day', — неделя. */
export function asPeriod(raw: unknown): SpendReportPeriod {
  return String(raw ?? '').trim() === 'day' ? 'day' : 'week';
}

interface SliceAcc extends SpendSlice {
  prefixSum: number;
  prefixN: number;
}

function emptySlice(key: string, label: string): SliceAcc {
  return {
    key, label, runs: 0, costUsd: 0, costUnavailable: false,
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
    cacheReadShare: null, compactions: 0, wideRetries: 0, avgPrefixTokens: null, budgetStops: 0,
    prefixSum: 0, prefixN: 0,
  };
}

function add(acc: SliceAcc, r: AgentRunEntry): void {
  acc.runs += 1;
  acc.costUsd += r.costUsd;
  if (r.costUnavailable) acc.costUnavailable = true;
  acc.input_tokens += r.input_tokens;
  acc.cache_creation_input_tokens += r.cache_creation_input_tokens;
  acc.cache_read_input_tokens += r.cache_read_input_tokens;
  acc.output_tokens += r.output_tokens;
  acc.compactions += r.compactions;
  acc.wideRetries += r.wideRetries;
  if (r.stoppedBudget) acc.budgetStops += 1;
  if (r.prefixTokens !== null) {
    acc.prefixSum += r.prefixTokens;
    acc.prefixN += 1;
  }
}

/** Весь ввод запуска: и свежий, и записанный в кэш, и прочитанный из него. */
export const inputOf = (s: Pick<SpendSlice, 'input_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'>): number =>
  s.input_tokens + s.cache_creation_input_tokens + s.cache_read_input_tokens;

function finish(acc: SliceAcc): SpendSlice {
  const { prefixSum, prefixN, ...slice } = acc;
  const input = inputOf(slice);
  return {
    ...slice,
    cacheReadShare: input > 0 ? slice.cache_read_input_tokens / input : null,
    avgPrefixTokens: prefixN ? Math.round(prefixSum / prefixN) : null,
  };
}

/** Свести запуски по ключу; порядок — по убыванию стоимости, потом по ключу. */
function group(
  runs: AgentRunEntry[], keyOf: (r: AgentRunEntry) => string, labelOf: (key: string) => string,
): SpendSlice[] {
  const map = new Map<string, SliceAcc>();
  for (const r of runs) {
    const key = keyOf(r);
    let acc = map.get(key);
    if (!acc) map.set(key, acc = emptySlice(key, labelOf(key)));
    add(acc, r);
  }
  return [...map.values()].map(finish)
    .sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;
const kTokens = (n: number): string => `${Math.round(n / 1000)}K`;

export interface SpendReportOptions {
  period: SpendReportPeriod;
  /** Конец периода, мс. */
  to: number;
  lang: Lang;
  officeId: string;
  /** Подписи: название задачи и роли. Не нашлось — подписью будет id. */
  taskTitle?: (id: string) => string | undefined;
  roleTitle?: (id: string) => string | undefined;
}

/** Сигналы перерасхода по уже собранным срезам. Правила — только сравнение с SPEND_SIGNALS. */
export function spendSignals(
  report: Pick<SpendReport, 'total' | 'byTask' | 'byRole'>, lang: Lang, officeId: string,
): SpendSignal[] {
  const S = SPEND_SIGNALS;
  const signals: SpendSignal[] = [];

  // Кэш: по офису целиком и по каждой роли — у роли бывает свой провайдер,
  // и сломанный кэш одной роли в общей доле утонул бы.
  const cacheTargets: Array<[SpendSlice, SpendSignalTarget]> = [
    [report.total, { kind: 'office', id: officeId, label: report.total.label }],
    ...report.byRole.map((s): [SpendSlice, SpendSignalTarget] => [s, { kind: 'role', id: s.key, label: s.label }]),
  ];
  for (const [slice, target] of cacheTargets) {
    const share = slice.cacheReadShare;
    if (share === null || inputOf(slice) < S.lowCacheMinInput || share >= S.lowCacheWarn) continue;
    signals.push({
      kind: 'lowCache',
      severity: share < S.lowCacheAlert ? 'alert' : 'warn',
      target, value: share, threshold: S.lowCacheWarn, costUsd: slice.costUsd,
      text: t(lang, 'spend.signal.lowCache', { share: pct(share), threshold: pct(S.lowCacheWarn) }),
    });
  }

  for (const slice of report.byTask) {
    if (slice.key === NO_KEY) continue;
    const target: SpendSignalTarget = { kind: 'task', id: slice.key, label: slice.label };
    if (slice.compactions >= S.compactionsWarn) {
      signals.push({
        kind: 'compactions',
        severity: slice.compactions >= S.compactionsAlert ? 'alert' : 'warn',
        target, value: slice.compactions, threshold: S.compactionsWarn, costUsd: slice.costUsd,
        text: t(lang, 'spend.signal.compactions', { count: slice.compactions, threshold: S.compactionsWarn }),
      });
    }
    if (slice.wideRetries >= S.wideRetriesAlert) {
      signals.push({
        kind: 'wideRetries', severity: 'alert',
        target, value: slice.wideRetries, threshold: S.wideRetriesAlert, costUsd: slice.costUsd,
        text: t(lang, 'spend.signal.wideRetries', { count: slice.wideRetries }),
      });
    }
  }

  const heavy = report.byRole
    .filter((s) => s.avgPrefixTokens !== null && s.avgPrefixTokens >= S.bigPrefixWarn)
    .sort((a, b) => b.avgPrefixTokens! - a.avgPrefixTokens!)
    .slice(0, S.bigPrefixTop);
  for (const slice of heavy) {
    const tokens = slice.avgPrefixTokens!;
    signals.push({
      kind: 'bigPrefix',
      severity: tokens >= S.bigPrefixAlert ? 'alert' : 'warn',
      target: { kind: 'role', id: slice.key, label: slice.label },
      value: tokens, threshold: S.bigPrefixWarn, costUsd: slice.costUsd,
      text: t(lang, 'spend.signal.bigPrefix', { tokens: kTokens(tokens), threshold: kTokens(S.bigPrefixWarn) }),
    });
  }

  const rank = (s: SpendSignal) => (s.severity === 'alert' ? 0 : 1);
  return signals.sort((a, b) => rank(a) - rank(b) || b.costUsd - a.costUsd);
}

/**
 * Аномалии задачи из главных потребителей. Порог расхода — тот же, что у
 * предохранителя (`runThreshold`), но посчитанный по нынешней истории, а не
 * по той, что была в момент запуска: разбор отвечает «что выбивается сейчас»,
 * и пересчитывать историю на каждый запуск ради этого незачем.
 *
 * `history` — все запуски офиса, не только за период: порог роли строится
 * по последним запускам, где бы они ни лежали.
 */
export function taskAnomalies(
  slice: SpendSlice, taskRuns: readonly AgentRunEntry[], history: readonly AgentRunEntry[], lang: Lang,
): SpendAnomaly[] {
  const S = SPEND_SIGNALS;
  const anomalies: SpendAnomaly[] = [];

  const limits = new Map<string, number>();
  let worst: { ratio: number; spent: number; limit: number } | null = null;
  let stops = 0;
  for (const r of taskRuns) {
    if (r.stoppedBudget) stops += 1;
    const kind = runKind(r.nodeId);
    const key = `${r.roleId} ${kind}`;
    let limit = limits.get(key);
    if (limit === undefined) limits.set(key, limit = runThreshold(history, r.roleId, kind).tokens);
    const spent = runInputTokens(r);
    const ratio = spent / limit;
    if (!worst || ratio > worst.ratio) worst = { ratio, spent, limit };
  }
  const over = worst !== null && worst.ratio > 1;
  if (over || stops > 0) {
    const parts: string[] = [];
    if (over) {
      parts.push(t(lang, 'spend.anomaly.overBudget', {
        spent: kTokens(worst!.spent), limit: kTokens(worst!.limit), ratio: worst!.ratio.toFixed(1),
      }));
    }
    if (stops > 0) parts.push(t(lang, 'spend.anomaly.stopped', { count: stops }));
    anomalies.push({
      kind: 'overBudget',
      // Остановленный запуск дошёл до порога, даже если его usage потерян.
      value: Math.max(worst?.ratio ?? 0, stops > 0 ? 1 : 0),
      threshold: 1,
      text: parts.join(' '),
    });
  }

  // Минимум ввода — как у сигнала: у короткой задачи кэшу не на чем окупиться.
  const share = slice.cacheReadShare;
  if (share !== null && inputOf(slice) >= S.lowCacheMinInput && share < S.lowCacheWarn) {
    anomalies.push({
      kind: 'lowCache', value: share, threshold: S.lowCacheWarn,
      text: t(lang, 'spend.anomaly.lowCache', { share: pct(share), threshold: pct(S.lowCacheWarn) }),
    });
  }
  return anomalies;
}

/** Разбор расхода по запускам за период. Чистая функция: весь ввод — в аргументах. */
export function buildSpendReport(runs: AgentRunEntry[], opts: SpendReportOptions): SpendReport {
  const { from, to } = reportRange(opts.period, opts.to);
  const inPeriod = runs.filter((r) => r.at >= from && r.at <= to);
  const lang = opts.lang;

  const totalAcc = emptySlice(opts.officeId, t(lang, 'spend.report.office'));
  for (const r of inPeriod) add(totalAcc, r);
  const total = finish(totalAcc);

  const byTask = group(inPeriod, (r) => r.taskId ?? NO_KEY,
    (key) => (key === NO_KEY ? t(lang, 'spend.report.noTask') : opts.taskTitle?.(key) ?? key));
  const byRole = group(inPeriod, (r) => r.roleId, (key) => opts.roleTitle?.(key) ?? key);
  const byNode = group(inPeriod,
    (r) => (r.workflowId ? `${r.workflowId}/${r.nodeId ?? NO_KEY}` : NO_KEY),
    (key) => (key === NO_KEY ? t(lang, 'spend.report.noFlow') : key));
  const byWorkflow = group(inPeriod, (r) => r.workflowId ?? NO_KEY,
    (key) => (key === NO_KEY ? t(lang, 'spend.report.noFlow') : key));
  const byModel = group(inPeriod, (r) => r.model ?? NO_KEY, (key) => key);
  const byDay = group(inPeriod, (r) => dayKey(r.at), (key) => key)
    .sort((a, b) => a.key.localeCompare(b.key));
  const topTasks = byTask.filter((s) => s.key !== NO_KEY).slice(0, SPEND_SIGNALS.topTasks)
    .map((slice): SpendTopTask => {
      const anomalies = taskAnomalies(slice, inPeriod.filter((r) => r.taskId === slice.key), runs, lang);
      return { ...slice, anomaly: anomalies.length > 0, anomalies };
    });

  return {
    period: opts.period, from, to,
    total, byTask, byRole, byNode, byWorkflow, byModel, byDay, topTasks,
    signals: spendSignals({ total, byTask, byRole }, lang, opts.officeId),
  };
}

/** Разбор расхода офиса: `?period=day|week&to=<мс>`, мусор в параметрах — неделя по сей момент. */
export function officeSpendReport(
  state: OfficeState, query: { period?: unknown; to?: unknown } = {}, now = Date.now(),
): SpendReport {
  const asked = query.to === null || query.to === undefined || query.to === '' ? NaN : Number(query.to);
  return buildSpendReport(state.agentRunList(), {
    period: asPeriod(query.period),
    to: Number.isFinite(asked) ? asked : now,
    lang: state.lang(),
    officeId: state.officeId,
    taskTitle: (id) => state.tasks.get(id)?.title,
    roleTitle: (id) => state.role(id)?.title,
  });
}
