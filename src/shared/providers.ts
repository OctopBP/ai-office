/** Persisted provider ids. Execution location (local/cloud) is a separate setting. */
export const PROVIDERS = {
  'claude-code': { label: 'Claude Code', defaultModel: 'claude-sonnet-5', cloud: true },
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
