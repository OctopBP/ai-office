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
  return engineFor(provider).start({ ...request, options: {
    ...request.options, resume: sessionForProvider(request.options.resume, provider),
  } });
}
