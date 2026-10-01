/** Движок — программа, которая ведёт цикл агента. Провайдер обслуживается ровно одним движком. */
export type EngineId = 'claude-code' | 'codex' | 'opencode';

interface ProviderSpec {
  label: string;
  engine: EngineId;
  /**
   * Модель по умолчанию. `default` у OpenAI-совместимых — «первая модель,
   * которую отдаёт сервер провайдера»: у Ollama и своего адреса набор моделей
   * знает только сам сервер.
   */
  defaultModel: string;
  cloud: boolean;
  /**
   * Адрес API в формате OpenAI (у провайдеров универсального движка). Пустой —
   * адрес задаёт пользователь. `editableUrl` — адрес можно сменить на карточке.
   */
  baseUrl?: string;
  editableUrl?: boolean;
  /** Ключ API необязателен (локальные серверы): карточка пускает без него. */
  keyOptional?: boolean;
  /** Где владелец берёт ключ — ссылка на карточке рядом с полем ключа. */
  keyUrl?: string;
  /**
   * Свой пакет AI SDK для сессии OpenCode вместо `@ai-sdk/openai-compatible`
   * и его адрес. Нужен, когда совместимый слой провайдера теряет то, без чего
   * агент не работает: у Gemini это подписи рассуждений между вызовами
   * инструментов и чистка схем инструментов, которые OpenCode делает только
   * для родного пакета. Проверка ключа и список моделей идут по `baseUrl`.
   */
  sdk?: { npm: string; baseUrl: string };
}

/**
 * Persisted provider ids. Execution location (local/cloud) is a separate setting.
 *
 * Провайдеры движка `opencode` — пресеты API в формате OpenAI (spec провайдеров
 * §3.5): xAI, DeepSeek, OpenRouter, Google (Gemini), Alibaba (Qwen), Ollama на
 * этой машине и свой адрес. Gemini и Qwen — только по ключу API: вход аккаунтом
 * Google условия Google запрещают (docs/legal/T-210/antigravity.md).
 */
export const PROVIDERS = {
  'claude-code': { label: 'Claude Code', engine: 'claude-code', defaultModel: 'claude-sonnet-5-5', cloud: true },
  codex: { label: 'Codex', engine: 'codex', defaultModel: 'default', cloud: false },
  xai: {
    label: 'xAI (Grok)', engine: 'opencode', defaultModel: 'grok-4.7', cloud: false,
    baseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai/',
  },
  deepseek: {
    label: 'DeepSeek', engine: 'opencode', defaultModel: 'deepseek-flash', cloud: false,
    baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  openrouter: {
    label: 'OpenRouter', engine: 'opencode', defaultModel: 'openrouter/auto', cloud: false,
    baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys',
  },
  // Ключ из Google AI Studio. Список моделей — через OpenAI-совместимый слой
  // Gemini API, сессия — через родной пакет (см. `sdk`).
  google: {
    label: 'Google (Gemini)', engine: 'opencode', defaultModel: 'gemini-2.5-pro', cloud: false,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    sdk: { npm: '@ai-sdk/google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  // Alibaba Cloud Model Studio (DashScope), международный регион: ключ
  // китайского региона здесь не подойдёт, и наоборот.
  alibaba: {
    label: 'Alibaba (Qwen)', engine: 'opencode', defaultModel: 'qwen-plus', cloud: false,
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
  },
  ollama: {
    label: 'Ollama', engine: 'opencode', defaultModel: 'default', cloud: false,
    baseUrl: 'http://127.0.0.1:11434/v1', editableUrl: true, keyOptional: true,
  },
  custom: {
    label: 'OpenAI-compatible API', engine: 'opencode', defaultModel: 'default', cloud: false,
    baseUrl: '', editableUrl: true, keyOptional: true,
  },
} as const satisfies Record<string, ProviderSpec>;

export type ProviderId = keyof typeof PROVIDERS;
export const providerSpec = (id: ProviderId): ProviderSpec => PROVIDERS[id];
export const engineOf = (id: ProviderId): EngineId => PROVIDERS[id].engine;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && Object.hasOwn(PROVIDERS, value);
/** Missing provider in legacy saves always means Claude, never model-name inference. */
export const providerOf = (role?: { provider?: ProviderId }): ProviderId => role?.provider ?? 'claude-code';

/**
 * Провайдер и модель — пара, а не два независимых поля: модель одного
 * провайдера другому ничего не говорит (spec провайдеров §5.6).
 */
export interface ModelChoice {
  provider: ProviderId;
  model: string;
}

/** Выбор офиса, пока владелец своего не сделал, — то, на чём офис работал всегда. */
export const DEFAULT_MODEL_CHOICE: ModelChoice = {
  provider: 'claude-code',
  model: PROVIDERS['claude-code'].defaultModel,
};

export const sameChoice = (a: ModelChoice, b: ModelChoice): boolean =>
  a.provider === b.provider && a.model === b.model;

/**
 * Id сессии для движка провайдера. Чужие движки помечают свои id префиксом
 * (`codex:`, `opencode:`); id без префикса — сессия Claude. Сессию одного
 * движка другим не продолжить, поэтому чужой id отбрасывается. Между
 * провайдерами одного OpenCode сессия переносится: историю хранит движок.
 */
export function sessionForProvider(id: string | undefined, provider: ProviderId): string | undefined {
  if (!id) return undefined;
  const engine = engineOf(provider);
  const prefix = /^(codex|opencode):/.exec(id)?.[1];
  if (engine === 'claude-code') return prefix ? undefined : id;
  return prefix === engine ? id.slice(engine.length + 1) : undefined;
}

/**
 * Что владелец рассказал о своём API (docs/design/T-189/ui.md §6.2) сверх
 * адреса и ключа: как его называть, какую модель брать по умолчанию и что
 * офис о ней не узнает сам — окно контекста и цену. Каталога цен у своего
 * сервера нет, поэтому без цены доллары не считаются.
 */
export interface CustomApi {
  name?: string;
  model?: string;
  contextWindow?: number;
  /** USD за миллион токенов. */
  price?: { input: number; output: number };
}

export const CUSTOM_NAME_MAX = 40;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Привести присланное или прочитанное с диска к `CustomApi`: лишнее и кривое отбрасывается. */
export function cleanCustomApi(raw: unknown): CustomApi {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, CUSTOM_NAME_MAX) : '';
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  const price = r.price as Record<string, unknown> | undefined;
  return {
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(positive(r.contextWindow) ? { contextWindow: Math.round(r.contextWindow) } : {}),
    ...(price && nonNegative(price.input) && nonNegative(price.output)
      ? { price: { input: price.input, output: price.output } } : {}),
  };
}

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
