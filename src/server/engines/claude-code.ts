/**
 * Адаптер Claude Code: единственное место сервера, которое зовёт
 * `@anthropic-ai/claude-agent-sdk` в рантайме.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query as claudeQuery, createSdkMcpServer as claudeServer } from '@anthropic-ai/claude-agent-sdk';
import { commandScrubFile, engineEnv } from '../childenv';
import { limitBlock } from '../limits';
import { MODEL_ALIASES, MODEL_IDS } from '../../shared/models';
import type { EngineAdapter, EngineCapabilities, ModelInfo, ModelTier, ProviderStatus } from './types';

export { tool, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';

export type LocalTool = NonNullable<Parameters<typeof claudeServer>[0]['tools']>[number];
/** Инструменты офиса по серверу: Codex отдаёт их как dynamic-tools, а не через MCP. */
export const localTools = new WeakMap<object, LocalTool[]>();
export function createSdkMcpServer(options: Parameters<typeof claudeServer>[0]) {
  const server = claudeServer(options);
  localTools.set(server, options.tools ?? []);
  return server;
}

/**
 * Чем считает claude-code. Пусто — SDK ищет свой нативный бинарь сам, рядом с
 * собой: так устроен офис, поставленный из исходников. У приложения такого
 * пакета нет — движок ставится отдельно, и путь к нему приходит переменной
 * (см. docs/design/desktop-app/spec.md §3).
 */
export const claudeBin = (): string => process.env.OFFICE_CLAUDE_BIN ?? '';

/** Версия Claude Code, с которой собран установленный SDK. */
function bundledVersion(): string {
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const pkg = JSON.parse(readFileSync(resolve(dirname(entry), 'package.json'), 'utf8'));
    return String(pkg.claudeCodeVersion ?? pkg.version ?? '');
  } catch {
    return '';
  }
}

function binVersion(bin: string): Promise<string> {
  return new Promise((done) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (err, stdout) => {
      done(err ? '' : (String(stdout).match(/\d+\.\d+\.\d+/)?.[0] ?? String(stdout).trim()));
    });
  });
}

/** Нейтральные уровни для алиасов Claude: opus → top, sonnet → balanced, haiku → fast. */
const TIER_OF: Partial<Record<string, ModelTier>> = {
  [MODEL_ALIASES.opus]: 'top',
  [MODEL_ALIASES.sonnet]: 'balanced',
  [MODEL_ALIASES.haiku]: 'fast',
};

const LABEL_OF: Record<string, string> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5': 'Haiku 4.5',
};

export const claudeCodeEngine: EngineAdapter = {
  id: 'claude-code',
  providers: ['claude-code'],

  capabilities(platform: NodeJS.Platform = process.platform): EngineCapabilities {
    return {
      subscriptionLogin: true,
      apiKeyLogin: true,
      resume: true,
      streamingInput: true,
      partialText: true,
      officeTools: 'in-process',
      nativeHands: true,
      sandbox: platform === 'darwin' || platform === 'linux',
      compaction: 'auto-window',
      costUsd: 'reported',
      planLimits: true,
      balance: false,
      skills: 'plugin',
      webSearch: true,
      cloud: true,
    };
  },

  async locate() {
    const bin = claudeBin();
    if (bin) {
      const version = await binVersion(bin);
      return version ? { path: bin, version } : null;
    }
    // Из исходников движок приезжает пакетом рядом с SDK, и SDK находит его сам.
    // В приложении такого пакета нет — без переменной движка нет.
    if (process.env.OFFICE_APP === '1') return null;
    return { path: '', version: bundledVersion() };
  },

  async status(): Promise<ProviderStatus> {
    // Как и проверка окружения: в приложении движок обязан быть указан явно.
    if (process.env.OFFICE_APP === '1' && !claudeBin()) return { state: 'not-installed', engine: 'claude-code' };
    const block = limitBlock(Date.now(), 'claude-code');
    if (block) return { state: 'limited', kind: 'plan', resetsAt: block.resetsAt ?? undefined };
    // Вход Claude Code по подписке без платного хода не проверить: без ключа
    // офис, как и раньше, работает на авторизации самого Claude Code.
    const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    return { state: 'ready', auth: hasKey ? 'api-key' : 'subscription' };
  },

  async models(): Promise<ModelInfo[]> {
    return MODEL_IDS.map(id => ({ id, label: LABEL_OF[id] ?? id, tier: TIER_OF[id] }));
  },

  start({ prompt, options }) {
    const { provider: _, ...sdk } = options;
    const bin = claudeBin();
    // Сессия работает в рабочей копии проекта, и всё, что она запустит, — тесты,
    // сборка, свой сервер — должно видеть проект, а не приложение офиса.
    // Ключ провайдера движку нужен, его Bash-командам — нет: снимает их файл
    // окружения, который движок подключает перед каждой командой.
    const env = engineEnv(sdk.env);
    env.CLAUDE_ENV_FILE = commandScrubFile(env.CLAUDE_ENV_FILE);
    const clean = { ...sdk, env };
    return claudeQuery({ prompt, options: bin ? { ...clean, pathToClaudeCodeExecutable: bin } : clean });
  },
};
