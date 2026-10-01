/**
 * Разбор расхода: агрегаты по запускам агентов и сигналы перерасхода.
 *
 * Детализация трат (`SpendPage`) отвечает «сколько и когда», разбор — «кто
 * съел и почему»: какие задачи и роли дороже всех, работает ли кэш, где
 * контекст сжимался и запуск повторяли. Считается сервером из записей о
 * запусках (`agentRuns`), отдаётся маршрутом `GET /api/spend/report`.
 *
 * Отдельный файл, а не `types.ts`: контракт новый и ни на что в общем файле
 * не опирается, а правка общего файла задевала бы соседние ветки.
 */

/** Период разбора: сутки или неделя, считая от его конца. */
export type SpendReportPeriod = 'day' | 'week';

/** Сумма запусков одной группы. */
export interface SpendSlice {
  /** Ключ группы: id задачи, роли, модели, «процесс/узел» или сутки. */
  key: string;
  /** Подпись для человека: название задачи или роли. Нет — сам ключ. */
  label: string;
  runs: number;
  costUsd: number;
  /** Хотя бы у одного запуска провайдер не назвал цену: ноль — не «бесплатно». */
  costUnavailable: boolean;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  /**
   * Доля чтения из кэша во всём вводе (ввод + запись в кэш + чтение из кэша).
   * null — ввода не было вовсе.
   */
  cacheReadShare: number | null;
  compactions: number;
  wideRetries: number;
  /** Средний стартовый префикс по замеренным запускам; null — замеров нет. */
  avgPrefixTokens: number | null;
}

/** Чем плох расход, который заметил сигнал. */
export type SpendSignalKind =
  /** Кэш почти не читается: каждый ход платим за префикс заново. */
  | 'lowCache'
  /** В задаче срабатывало сжатие контекста. */
  | 'compactions'
  /** Задачу повторяли на широком окне после зацикленного сжатия. */
  | 'wideRetries'
  /** У роли большой средний стартовый префикс. */
  | 'bigPrefix';

/** На что указывает сигнал: по ссылке веб открывает задачу или роль. */
export interface SpendSignalTarget {
  kind: 'office' | 'task' | 'role';
  /** id задачи или роли; у офиса — id офиса. */
  id: string;
  label: string;
}

export interface SpendSignal {
  kind: SpendSignalKind;
  /** warn — стоит посмотреть, alert — точно течёт. */
  severity: 'warn' | 'alert';
  target: SpendSignalTarget;
  /** Замеренное значение и порог, с которым его сравнили. */
  value: number;
  threshold: number;
  /** Сколько денег за период стоит то, на что указывает сигнал. */
  costUsd: number;
  /** Пояснение на языке офиса: что не так и что с этим делать. */
  text: string;
}

export interface SpendReport {
  period: SpendReportPeriod;
  /** Границы периода, мс, включительно. */
  from: number;
  to: number;
  total: SpendSlice;
  byTask: SpendSlice[];
  byRole: SpendSlice[];
  /** Ключ — `процесс/узел`; запуски вне процесса — под ключом `-`. */
  byNode: SpendSlice[];
  byModel: SpendSlice[];
  /** По суткам периода, от старых к свежим. */
  byDay: SpendSlice[];
  /** Главные потребители: задачи по убыванию стоимости, не больше десяти. */
  topTasks: SpendSlice[];
  /** Сигналы перерасхода, самые тревожные и дорогие — первыми. */
  signals: SpendSignal[];
}
