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
 * Установка и вход (`install`, `login`) — для экрана «Провайдеры»: сервер зовёт
 * их из `providers-api.ts`.
 */
import type {
  Options, SDKMessage, SDKUserMessage, McpServerConfig, SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk';
import type { AuthKind, EngineCapabilities, EngineId, ProviderId, ProviderStatus } from '../../shared/providers';
import type { ProviderLoginFlow } from '../../shared/types';
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

export type { EngineId, AuthKind, ProviderStatus, EngineCapabilities } from '../../shared/providers';

/** Нейтральный уровень модели: пакет называет уровень, офис разрешает его в модель провайдера. */
import type { ModelTier } from '../../shared/models';
export type { ModelTier } from '../../shared/models';

export interface ModelInfo {
  id: string;
  label: string;
  tier?: ModelTier;
  contextWindow?: number;
  /** USD за миллион токенов; нет — стоимость движок либо сообщает сам, либо не считается. */
  price?: { input: number; cachedInput?: number; cacheWrite?: number; output: number };
}

export interface InstallProgress { share: number; bytes?: number; totalBytes?: number }

export interface LoginRequest {
  provider: ProviderId;
  kind: AuthKind;
  /** Для api-key: ключ сразу уходит в связку ключей, в состояние офиса не пишется. */
  apiKey?: string;
  /** Адрес API для провайдеров со своим адресом (Ollama, свой сервер). */
  baseUrl?: string;
}
/**
 * Ключ — сразу итог; подписка — запущенный сценарий штатного входа движка
 * (`engines/login.ts`): дальше его фазы приходят через `onLoginFlow`.
 */
export type LoginStart = { done: true; status: ProviderStatus } | { done: false; flow: ProviderLoginFlow };

/**
 * Отказ во входе с причиной для формы: ключ не принят, сети нет, связка
 * ключей недоступна, такой способ входа движок пока не умеет или адрес API
 * не годится.
 */
export class LoginError extends Error {
  constructor(readonly code: 'rejected' | 'network' | 'keychain' | 'unsupported' | 'address', message: string) {
    super(message);
  }
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

  /**
   * Скачать движок в папку движков офиса (`engines/install.ts`). Прогресс —
   * доля и байты; отмена — через `signal`, недокачанное удаляется.
   */
  install(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<{ path: string }>;
  /** Сколько примерно качать, МБ — для «Нужен движок (~310 МБ)». */
  readonly sizeMb?: number;

  /**
   * Вход. Ключ проверяется запросом метаданных и уходит в связку ключей
   * (`engines/keys.ts`); подписка — штатный вход движка (`engines/login.ts`).
   */
  login(req: LoginRequest): Promise<LoginStart>;
  /** Выйти: удалить ключ из связки. Вход самого движка по подписке не трогается. */
  logout(provider: ProviderId): Promise<void>;

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
