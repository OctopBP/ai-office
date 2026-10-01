/** Persisted provider ids. Execution location (local/cloud) is a separate setting. */
export const PROVIDERS = {
  'claude-code': { label: 'Claude Code', defaultModel: 'claude-sonnet-5-5', cloud: true },
  codex: { label: 'Codex', defaultModel: 'default', cloud: false },
} as const;

export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && Object.hasOwn(PROVIDERS, value);
/** Missing provider in legacy saves always means Claude, never model-name inference. */
export const providerOf = (role?: { provider?: ProviderId }): ProviderId => role?.provider ?? 'claude-code';

export function sessionForProvider(id: string | undefined, provider: ProviderId): string | undefined {
  if (!id) return undefined;
  if (provider === 'codex') return id.startsWith('codex:') ? id.slice(6) : undefined;
  return id.startsWith('codex:') ? undefined : id;
}

/** Движок. Пока провайдер обслуживается ровно своим движком, их id совпадают. */
export type EngineId = ProviderId;

/** Как провайдер пускает: подписка (вход в браузере), ключ API или без входа. */
export type AuthKind = 'subscription' | 'api-key' | 'none';

/**
 * Состояние провайдера для экрана «Провайдеры» и проверок окружения
 * (docs/design/providers/spec.md §5.3). `installing` ставит сервер, пока
 * качает движок: адаптер о своей установке не знает.
 */
export type ProviderStatus =
  | { state: 'not-installed'; engine: EngineId; sizeMb?: number; detail?: string }
  | { state: 'installing'; engine: EngineId; share: number; bytes?: number; totalBytes?: number }
  | { state: 'needs-login'; auth: AuthKind[]; detail?: string }
  | { state: 'unreachable'; detail: string }
  | { state: 'ready'; auth: AuthKind; account?: string; plan?: string }
  | { state: 'limited'; kind: 'plan' | 'rate' | 'balance'; resetsAt?: number; detail?: string }
  | { state: 'error'; detail: string };

/** Подключён ли провайдер: при лимите он тоже подключён, офис просто ждёт сброса. */
export const isConnected = (status: ProviderStatus): boolean =>
  status.state === 'ready' || status.state === 'limited';

/** Что движок умеет. По матрице офис решает, что показать и что разрешить (spec §5.5). */
export interface EngineCapabilities {
  subscriptionLogin: boolean;
  apiKeyLogin: boolean;
  /** Продолжение сессии по id после перезапуска. */
  resume: boolean;
  /** Несколько ходов в одной сессии — без этого провайдер нельзя дать менеджеру. */
  streamingInput: boolean;
  /** Текст по кусочкам: пузыри и чат. */
  partialText: boolean;
  officeTools: 'in-process' | 'mcp-bridge' | 'dynamic-tools';
  /** Свои Read/Edit/Bash движка, пропущенные через шлюз подтверждений офиса. */
  nativeHands: boolean;
  /** Песочница ОС для команд на этой платформе. */
  sandbox: boolean;
  compaction: 'auto-window' | 'auto' | 'manual' | 'none';
  costUsd: 'reported' | 'computed' | 'none';
  /** Окна подписки с процентами и сбросом. */
  planLimits: boolean;
  /** Остаток денег у провайдера. */
  balance: boolean;
  skills: 'plugin' | 'tool' | 'none';
  webSearch: boolean;
  cloud: boolean;
}
