/** Kimi Code: локальная OAuth-подписка, ACP-сессии и KAP-метаданные. */
import { execFile } from 'node:child_process';
import { ENGINE_BUILTIN_TOOLS } from '../../shared/providers';
import { limitBlock, noteRateLimit, noteUsageReport } from '../limits';
import {
  KIMI_CODE_BIN, KIMI_CODE_PKG, KIMI_CODE_VERSION, exhaustedWindow, kimiCodeBinary, kimiCommand,
  kimiLogout, kimiMetadata, kimiQuery, loginEnv, ownerEnv, usageReport,
} from '../providers/kimi-code';
import { sandboxAvailable } from '../providers/opencode';
import { installFromNpm } from './install';
import { deleteKey } from './keys';
import { startCliLogin } from './login';
import { LoginError, type EngineAdapter, type EngineCapabilities, type ModelInfo, type ProviderStatus } from './types';

let located: { at: number; value: { path: string; version: string } | null } | null = null;
let locateError = '';

function locate(force = false): Promise<{ path: string; version: string } | null> {
  if (!force && located && Date.now() - located.at < 30_000) return Promise.resolve(located.value);
  const bin = kimiCodeBinary();
  const command = kimiCommand(['--version'], bin);
  const value = new Promise<{ path: string; version: string } | null>((done) => {
    execFile(command.file, command.args, { timeout: 10_000, env: ownerEnv() }, (error, stdout, stderr) => {
      locateError = error ? (stderr.trim() || error.message).slice(-3000) : '';
      done(error ? null : { path: bin, version: String(stdout).match(/\d+\.\d+\.\d+/)?.[0] ?? String(stdout).trim() });
    });
  });
  located = { at: Date.now(), value: null };
  void value.then((result) => { located = { at: Date.now(), value: result }; });
  return value;
}

export const kimiCodeEngine: EngineAdapter = {
  id: 'kimi-code',
  providers: ['kimi-code'],
  builtinTools: ENGINE_BUILTIN_TOOLS['kimi-code'],

  capabilities(platform: NodeJS.Platform = process.platform): EngineCapabilities {
    return {
      subscriptionLogin: true,
      apiKeyLogin: false,
      resume: true,
      streamingInput: true,
      partialText: true,
      officeTools: 'mcp-bridge',
      nativeHands: false,
      sandbox: sandboxAvailable(platform),
      localBinding: false,
      compaction: 'manual',
      // Подписка сообщает токены/контекст, но не стоимость в USD.
      costUsd: 'none',
      planLimits: true,
      balance: false,
      skills: 'tool',
      webSearch: false,
      cloud: false,
    };
  },

  locate: () => locate(),

  async status(_provider, opts): Promise<ProviderStatus> {
    if (!await locate(opts?.force)) return { state: 'not-installed', engine: 'kimi-code', sizeMb: kimiCodeEngine.sizeMb };
    try {
      const metadata = await kimiMetadata(opts?.force);
      if (metadata.usage?.kind !== 'ok') {
        const detail = metadata.usage?.message || 'Sign in to Kimi Code with your subscription.';
        return { state: 'needs-login', auth: ['subscription'], detail };
      }
      noteUsageReport(usageReport(metadata.usage, metadata.plan), 'kimi-code');
      const exhausted = exhaustedWindow(metadata.usage);
      if (exhausted) {
        noteRateLimit({ status: 'rejected', ...(exhausted.resetsAt ? { resetsAt: exhausted.resetsAt / 1000 } : {}) }, 'kimi-code');
        return { state: 'limited', kind: 'plan', resetsAt: exhausted.resetsAt };
      }
      noteRateLimit({ status: 'allowed' }, 'kimi-code');
      const block = limitBlock(Date.now(), 'kimi-code');
      if (block) return { state: 'limited', kind: 'plan', resetsAt: block.resetsAt ?? undefined };
      return { state: 'ready', auth: 'subscription', ...(metadata.account ? { account: metadata.account } : {}),
        ...(metadata.plan ? { plan: metadata.plan } : {}) };
    } catch (error) {
      return { state: 'error', detail: `Kimi Code is installed but its local metadata server is unavailable: ${(error as Error).message}` };
    }
  },

  sizeMb: 30,

  async install(onProgress, signal) {
    const done = await installFromNpm({
      engine: 'kimi-code', pkg: KIMI_CODE_PKG, version: KIMI_CODE_VERSION, bin: KIMI_CODE_BIN, dependencies: true,
    }, onProgress, signal);
    if (!await locate(true)) {
      throw new Error(`Kimi Code скачан, но проверка --version не прошла: ${locateError || 'неизвестная ошибка запуска'}`);
    }
    return done;
  },

  async login(req) {
    if (req.kind !== 'subscription') throw new LoginError('unsupported', 'Kimi Code provider supports subscription login only');
    const command = kimiCommand(['login']);
    return { done: false, flow: startCliLogin({
      provider: 'kimi-code', bin: command.file, args: command.args, env: loginEnv(), acceptsCode: false,
      after: () => { void kimiMetadata(true).catch(() => {}); },
    }) };
  },

  async logout() {
    await deleteKey('kimi-code');
    await kimiLogout();
    await kimiMetadata(true).catch(() => {});
  },

  async models(): Promise<ModelInfo[]> {
    return (await kimiMetadata()).models;
  },

  start: kimiQuery,
};
