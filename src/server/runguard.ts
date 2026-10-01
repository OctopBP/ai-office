/**
 * Предохранитель расхода одного запуска агента.
 *
 * Отдельной настройки у порога нет намеренно: «сколько можно» у ревьюера и у
 * исполнителя разное, и угадать число за владельца нельзя. Порог берётся из
 * того, сколько обычно съедает такой же запуск — та же роль, тот же тип
 * работы, — с запасом втрое. Пока истории мало, действует константа.
 *
 * Здесь только расчёт и счётчики, без сессий и состояния офиса: остановку
 * делает цикл исполнителя (`collectWorker` в agents.ts), а этот модуль лишь
 * говорит ему, когда пора.
 */
import type { AgentRunEntry } from './spend';
import type { BudgetStop } from '../shared/types';

/** Порог, пока истории меньше `BUDGET_MIN_HISTORY` запусков. */
export const BUDGET_DEFAULT_TOKENS = 2_000_000;
/** Сколько последних запусков берётся в медиану. */
export const BUDGET_HISTORY = 30;
/** С какого числа запусков истории уже верим больше, чем константе. */
export const BUDGET_MIN_HISTORY = 10;
/** Во сколько раз запуск может превысить обычный, прежде чем его остановят. */
export const BUDGET_FACTOR = 3;
/** С какой доли порога пишется предупреждение. */
export const BUDGET_WARN_SHARE = 0.8;
/** Сколько автосжатий подряд за запуск — уже молотилка, а не работа. */
export const THRASH_COMPACTIONS = 3;

/**
 * Тип работы запуска. Узел процесса говорит, чем запуск занят (работа,
 * ревью, доработка), и расход у них несравним; вне процесса — сама задача.
 */
export function runKind(nodeId: string | null): string {
  return nodeId ?? 'task';
}

/**
 * Входные токены запуска: ввод плюс чтение и запись кеша. Кеш считается
 * наравне с вводом: именно он раздувается у буксующей сессии, и порог без
 * него не заметил бы самого дорогого случая.
 */
export function runInputTokens(r: Pick<AgentRunEntry,
  'input_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'>): number {
  return r.input_tokens + r.cache_read_input_tokens + r.cache_creation_input_tokens;
}

export interface RunThreshold {
  tokens: number;
  source: 'history' | 'default';
  /** Медиана по истории; null — истории мало и порог по умолчанию. */
  median: number | null;
  /** Сколько запусков нашлось в истории (не больше `BUDGET_HISTORY`). */
  samples: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Порог запуска роли `roleId` для работы типа `kind`. В историю идут только
 * запуски по задачам: разговор менеджера или ритуал на той же роли — другая
 * работа. Запуски лежат от старых к свежим, поэтому последние — с конца.
 */
export function runThreshold(runs: readonly AgentRunEntry[], roleId: string, kind: string): RunThreshold {
  const history: number[] = [];
  for (let i = runs.length - 1; i >= 0 && history.length < BUDGET_HISTORY; i--) {
    const r = runs[i];
    if (r.roleId !== roleId || r.taskId === null || runKind(r.nodeId) !== kind) continue;
    history.push(runInputTokens(r));
  }
  if (history.length < BUDGET_MIN_HISTORY) {
    return { tokens: BUDGET_DEFAULT_TOKENS, source: 'default', median: null, samples: history.length };
  }
  const m = median(history);
  // Медиана из пустых запусков дала бы порог ноль и останавливала бы всё
  // подряд: ниже константы по умолчанию порог опускаться не может.
  return {
    tokens: Math.max(Math.round(m * BUDGET_FACTOR), BUDGET_DEFAULT_TOKENS / 10),
    source: 'history', median: Math.round(m), samples: history.length,
  };
}

/** Что делать циклу исполнителя после очередного сообщения. */
export type GuardSignal =
  | { kind: 'warn'; spentTokens: number; limitTokens: number }
  | { kind: 'stop'; stop: BudgetStop };

/**
 * Счётчики одного запуска. Предупреждение и остановка выдаются по одному
 * разу: дальше цикл уже останавливает сессию и повторять ему нечего.
 */
export class RunGuard {
  /** Сумма по законченным вызовам модели. */
  private committed = 0;
  /**
   * Текущий вызов модели. SDK присылает каждый блок ответа отдельным
   * сообщением с одним и тем же id и одной и той же usage — сложить их
   * значило бы посчитать вызов столько раз, сколько в нём блоков.
   */
  private callId: string | null = null;
  private callTokens = 0;
  private compactionsInRow = 0;
  private warned = false;
  private stopped = false;

  constructor(readonly threshold: RunThreshold) {}

  get spent(): number {
    return this.committed + this.callTokens;
  }

  /** Ответ модели с usage: `id` — id сообщения API, `tokens` — вход этого вызова. */
  usage(id: string | null, tokens: number): GuardSignal | null {
    if (id === null || id !== this.callId) {
      this.committed += this.callTokens;
      this.callId = id;
    }
    this.callTokens = tokens;
    const spent = this.spent;
    const limit = this.threshold.tokens;
    if (spent >= limit) return this.stop('tokens');
    if (!this.warned && !this.stopped && spent >= limit * BUDGET_WARN_SHARE) {
      this.warned = true;
      return { kind: 'warn', spentTokens: spent, limitTokens: limit };
    }
    return null;
  }

  /**
   * Сработало сжатие. Ручное (`/compact` перед доработкой) — решение офиса,
   * а не признак буксования, и счёт не трогает.
   */
  compaction(trigger: 'auto' | 'manual'): GuardSignal | null {
    if (trigger !== 'auto') return null;
    this.compactionsInRow += 1;
    return this.compactionsInRow >= THRASH_COMPACTIONS ? this.stop('compactions') : null;
  }

  /**
   * Ход закончился результатом: серия сжатий прервана. Так же — новая сессия
   * повтора на широком окне: окно уже поменяли, и старые сжатия ей не в счёт.
   */
  turnEnded(): void {
    this.compactionsInRow = 0;
  }

  private stop(reason: BudgetStop['reason']): GuardSignal | null {
    if (this.stopped) return null;
    this.stopped = true;
    return {
      kind: 'stop',
      stop: {
        reason,
        spentTokens: this.spent,
        limitTokens: this.threshold.tokens,
        limitSource: this.threshold.source,
        medianTokens: this.threshold.median,
        samples: this.threshold.samples,
        compactions: this.compactionsInRow,
      },
    };
  }
}
