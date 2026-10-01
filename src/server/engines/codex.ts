/**
 * Адаптер Codex: App Server по JSON-RPC (`providers/codex.ts`), инструменты
 * офиса — dynamic-tools (`providers/codex-tools.ts`).
 */
import { execFile } from 'node:child_process';
import { CODEX_BIN, codexBinary, codexQuery, runtimeEnv } from '../providers/codex';
import { codexStatus } from '../providers/diagnostics';
import { codexPrice } from '../providers/pricing';
import { limitBlock } from '../limits';
import { installFromNpm } from './install';
import { deleteKey, providerKey, saveKey, verifyKey } from './keys';
import { LoginError, type EngineAdapter, type EngineCapabilities, type ModelInfo, type ProviderStatus } from './types';

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
    if (!status.available) return { state: 'not-installed', engine: 'codex', sizeMb: codexEngine.sizeMb, detail: status.error };
    if (!status.authenticated) return { state: 'needs-login', auth: ['subscription', 'api-key'], detail: status.error };
    const block = limitBlock(Date.now(), 'codex');
    if (block) return { state: 'limited', kind: 'plan', resetsAt: block.resetsAt ?? undefined };
    return { state: 'ready', auth: providerKey('codex') ? 'api-key' : 'subscription' };
  },

  // Архив пакета платформы — столько и качаем.
  sizeMb: 130,

  async install(onProgress, signal) {
    if (!CODEX_BIN) throw new Error(`Codex не собирается под ${process.platform}-${process.arch}`);
    // Пакет платформы публикуется под dist-тегом с её именем: так берётся
    // последняя стабильная версия именно под эту машину.
    const done = await installFromNpm(
      { engine: 'codex', pkg: '@openai/codex', version: `${process.platform}-${process.arch}`, bin: CODEX_BIN },
      onProgress, signal);
    await codexStatus(true);
    return done;
  },

  async login(req) {
    if (req.kind !== 'api-key' || !req.apiKey) {
      // Вход через аккаунт ChatGPT делает сам Codex (`codex login`): офис его пока не ведёт.
      throw new LoginError('unsupported', 'subscription login is not supported yet');
    }
    await verifyKey('https://api.openai.com/v1/models', { Authorization: `Bearer ${req.apiKey}` });
    try { await saveKey('codex', req.apiKey); } catch (err) { throw new LoginError('keychain', (err as Error).message); }
    return { done: true, status: await codexEngine.status('codex', { force: true }) };
  },

  async logout() {
    await deleteKey('codex');
    await codexStatus(true);
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
