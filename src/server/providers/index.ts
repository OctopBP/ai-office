import { query as claudeQuery, createSdkMcpServer as claudeServer } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { providerOf, sessionForProvider, type ProviderId } from '../../shared/providers';
import type { LimitSource } from '../limits';
import type { McpStatusSource } from '../mcp';
import { codexQuery } from './codex';

// The office event vocabulary remains compatible with existing journals and UI.
// Provider-specific SDK types are confined to this boundary during migration.
export { tool, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
export type { SDKMessage, SDKPartialAssistantMessage, SDKResultSuccess, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
export type SessionOptions = Options & { provider?: ProviderId };
export type SessionRequest = { prompt: string | AsyncIterable<SDKUserMessage>; options: SessionOptions };
export type AgentSession = AsyncIterable<SDKMessage> & LimitSource & McpStatusSource;

export type LocalTool = NonNullable<Parameters<typeof claudeServer>[0]['tools']>[number];
export const localTools = new WeakMap<object, LocalTool[]>();
export function createSdkMcpServer(options: Parameters<typeof claudeServer>[0]) {
  const server = claudeServer(options);
  localTools.set(server, options.tools ?? []);
  return server;
}

type Adapter = (request: SessionRequest) => AgentSession;
const adapters: Record<ProviderId, Adapter> = {
  'claude-code': ({ prompt, options }) => {
    const { provider: _, ...sdk } = options;
    return claudeQuery({ prompt, options: sdk });
  },
  codex: codexQuery,
};

export function query(request: SessionRequest): AgentSession {
  const provider = providerOf(request.options);
  const adapter = adapters[provider];
  if (!adapter) throw new Error(`Unsupported provider: ${provider}`);
  return adapter({ ...request, options: {
    ...request.options, resume: sessionForProvider(request.options.resume, provider),
  } });
}
