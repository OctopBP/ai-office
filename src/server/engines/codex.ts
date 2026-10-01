/**
 * Адаптер Codex: App Server по JSON-RPC (`providers/codex.ts`), инструменты
 * офиса — dynamic-tools (`providers/codex-tools.ts`).
 */
import { execFile } from 'node:child_process';
import { codexBinary, codexQuery, runtimeEnv } from '../providers/codex';
import { codexStatus } from '../providers/diagnostics';
import { codexPrice } from '../providers/pricing';
import { limitBlock } from '../limits';
import type { EngineAdapter, EngineCapabilities, ModelInfo, ProviderStatus } from './types';

export const codexEngine: EngineAdapter = {
  id: 'codex',
  providers: ['codex'],

  capabilities(platform: NodeJS.Platform = process.platform): EngineCapabilities {
    return {
      subscriptionLogin: true,
      apiKeyLogin: true,
      resume: true,
      streamingInput: true,
      partialText: true,
      officeTools: 'dynamic-tools',
      // Свои руки Codex выключены: команды и файлы идут руками офиса.
      nativeHands: false,
      // На Windows песочница Codex экспериментальная — не считаем её за гарантию.
      sandbox: platform === 'darwin' || platform === 'linux',
      compaction: 'manual',
      costUsd: 'computed',
      planLimits: true,
      balance: false,
      skills: 'tool',
      webSearch: true,
      cloud: false,
    };
  },

  locate() {
    const bin = codexBinary();
    return new Promise((done) => {
      execFile(bin, ['--version'], { timeout: 5000, env: runtimeEnv() }, (err, stdout) => {
        if (err) return done(null);
        done({ path: bin, version: String(stdout).match(/\d+\.\d+\.\d+/)?.[0] ?? String(stdout).trim() });
      });
    });
  },

  async status(_provider, opts): Promise<ProviderStatus> {
    const status = await codexStatus(opts?.force);
    if (!status.available) return { state: 'not-installed', engine: 'codex', detail: status.error };
    if (!status.authenticated) return { state: 'needs-login', auth: ['subscription', 'api-key'], detail: status.error };
    const block = limitBlock(Date.now(), 'codex');
    if (block) return { state: 'limited', kind: 'plan', resetsAt: block.resetsAt ?? undefined };
    return { state: 'ready', auth: runtimeEnv().OPENAI_API_KEY ? 'api-key' : 'subscription' };
  },

  async models(): Promise<ModelInfo[]> {
    const { models } = await codexStatus();
    return models.map(({ id, label }) => {
      // Цены — только из OFFICE_CODEX_PRICING; кривая запись не роняет список.
      let price: ReturnType<typeof codexPrice> = null;
      try { price = codexPrice(id); } catch { /* стоимость просто не считается */ }
      return price ? { id, label, price } : { id, label };
    });
  },

  start: codexQuery,
};
