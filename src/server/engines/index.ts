/**
 * Реестр движков. Сервер запускает сессии и спрашивает о провайдерах только
 * отсюда — по провайдеру роли выбирается адаптер.
 */
import { providerOf, sessionForProvider, type ProviderId } from '../../shared/providers';
import { claudeCodeEngine } from './claude-code';
import { codexEngine } from './codex';
import { opencodeEngine } from './opencode';
import type { EngineAdapter, EngineSession, SessionRequest } from './types';

export * from './types';
export { tool, createSdkMcpServer, localTools, claudeBin, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type LocalTool } from './claude-code';

export const ENGINES: readonly EngineAdapter[] = [claudeCodeEngine, codexEngine, opencodeEngine];

/** Адаптер, который обслуживает провайдера. */
export function engineFor(provider: ProviderId): EngineAdapter {
  const engine = ENGINES.find(e => e.providers.includes(provider));
  if (!engine) throw new Error(`Unsupported provider: ${provider}`);
  return engine;
}

/**
 * Запустить сессию на движке провайдера из `options.provider`. Id сессии
 * чужого движка отбрасывается: продолжить Claude-сессию в Codex нельзя.
 */
export function startSession(request: SessionRequest): EngineSession {
  const provider = providerOf(request.options);
  try {
    return engineFor(provider).start({ ...request, options: {
      ...request.options, resume: sessionForProvider(request.options.resume, provider),
    } });
  } catch (err) {
    return failedSession(err);
  }
}

/**
 * Сессия, которая не смогла начаться. Движок отказывает синхронно — например,
 * SDK не находит свой бинарь, — а вызов стоит в обработчике события сервера,
 * и исключение роняло весь процесс (Windows без движка, T-237). Здесь отказ
 * откладывается до первого чтения: каждый, кто запускает сессию, уже читает её
 * в try и сам решает, куда сказать об ошибке — в чат, в задачу, в журнал.
 */
function failedSession(err: unknown): EngineSession {
  const fail = () => Promise.reject(err);
  return {
    [Symbol.asyncIterator]: () => ({ next: fail }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: fail,
    mcpServerStatus: fail,
  };
}
