/**
 * Единый контракт движка агентов — docs/design/providers/spec.md §5.
 *
 * Движок — программа, которая ведёт цикл агента (Claude Code, Codex). Всё, что
 * офис о нём знает, проходит через `EngineAdapter`: запуск сессии, статус
 * провайдера, модели и матрица возможностей. Типы SDK за пределы `engines/` и
 * низкоуровневых реализаций в `providers/` не выходят.
 *
 * Этап миграции. Словарь событий сессии пока остаётся прежним — сообщения в
 * форме Claude SDK (`EngineMessage`), их же уже сейчас выдаёт адаптер Codex.
 * Перевод разбора в agents.ts на нейтральный `EngineEvent` из спеки — отдельный
 * шаг: он меняет журналы и разбор расходов, а этот шаг поведение не меняет.
 * Установка и вход (`install`, `login`) появятся вместе с экраном «Провайдеры».
 */
import type {
  Options, SDKMessage, SDKUserMessage, McpServerConfig, SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProviderId } from '../../shared/providers';
import type { LimitSource } from '../limits';
import type { McpStatusSource } from '../mcp';

export type {
  SDKMessage as EngineMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultSuccess,
  PermissionResult,
  SDKUserMessage,
  McpServerConfig,
  SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk';

/** Движок. Пока провайдер обслуживается ровно своим движком, их id совпадают. */
export type EngineId = ProviderId;

/** Как провайдер пускает: подписка (вход в браузере), ключ API или без входа. */
export type AuthKind = 'subscription' | 'api-key' | 'none';

/** Состояние провайдера для экрана «Провайдеры» и проверок окружения. */
export type ProviderStatus =
  | { state: 'not-installed'; engine: EngineId; detail?: string }
  | { state: 'needs-login'; auth: AuthKind[]; detail?: string }
  | { state: 'ready'; auth: AuthKind; account?: string; plan?: string }
  | { state: 'limited'; kind: 'plan' | 'rate' | 'balance'; resetsAt?: number; detail?: string }
  | { state: 'error'; detail: string };

/** Нейтральный уровень модели: пакет называет уровень, офис разрешает его в модель провайдера. */
export type ModelTier = 'top' | 'balanced' | 'fast';

export interface ModelInfo {
  id: string;
  label: string;
  tier?: ModelTier;
  contextWindow?: number;
  /** USD за миллион токенов; нет — стоимость движок либо сообщает сам, либо не считается. */
  price?: { input: number; cachedInput?: number; cacheWrite?: number; output: number };
}

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

/** Параметры сессии. `provider` выбирает адаптер; остальное — общий словарь офиса. */
export type SessionOptions = Options & { provider?: ProviderId };
export type SessionRequest = { prompt: string | AsyncIterable<SDKUserMessage>; options: SessionOptions };
/** Живая сессия: поток сообщений, лимиты без платного хода и состояние MCP-серверов. */
export type EngineSession = AsyncIterable<SDKMessage> & LimitSource & McpStatusSource;

export interface EngineAdapter {
  readonly id: EngineId;
  readonly providers: ProviderId[];
  capabilities(platform?: NodeJS.Platform): EngineCapabilities;

  /** Где лежит движок и какой версии; null — не установлен. */
  locate(): Promise<{ path: string; version: string } | null>;

  /** Состояние провайдера. Только метаданные: платный ход модели не запускается никогда. */
  status(provider: ProviderId, opts?: { force?: boolean }): Promise<ProviderStatus>;

  /** Модели провайдера; цены — если движок их знает. */
  models(provider: ProviderId): Promise<ModelInfo[]>;

  /**
   * Сессия менеджера или исполнителя. `resume` уже отфильтрован реестром:
   * id чужого движка сюда не попадает.
   */
  start(request: SessionRequest): EngineSession;
}
