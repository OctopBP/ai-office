/**
 * Адаптер Claude Code: единственное место сервера, которое зовёт
 * `@anthropic-ai/claude-agent-sdk` в рантайме.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query as claudeQuery, createSdkMcpServer as claudeServer } from '@anthropic-ai/claude-agent-sdk';
import { commandScrubFile, engineEnv, projectEnv } from '../childenv';
import { limitBlock } from '../limits';
import { MODEL_ALIASES, MODEL_IDS } from '../../shared/models';
import { engineDir, installedBin, installFromNpm, runnable } from './install';
import { deleteKey, providerKey, saveKey, verifyKey } from './keys';
import { startCliLogin } from './login';
import { LoginError, type EngineAdapter, type EngineCapabilities, type ModelInfo, type ModelTier, type ProviderStatus } from './types';

export { tool, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';

export type LocalTool = NonNullable<Parameters<typeof claudeServer>[0]['tools']>[number];
/** Инструменты офиса по серверу: Codex отдаёт их как dynamic-tools, а не через MCP. */
export const localTools = new WeakMap<object, LocalTool[]>();
export function createSdkMcpServer(options: Parameters<typeof claudeServer>[0]) {
  const server = claudeServer(options);
  localTools.set(server, options.tools ?? []);
  return server;
}

const exe = (): string => (process.platform === 'win32' ? 'claude.exe' : 'claude');

/** Версия SDK: движок из npm ставится ровно такой же версии (пакет платформы SDK). */
export function sdkVersion(): string {
  const files: string[] = [];
  try {
    files.push(resolve(dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))), 'package.json'));
  } catch { /* собранный сервер приложения: SDK лежит в ресурсах */ }
  if (process.env.OFFICE_ROOT) {
    files.push(resolve(process.env.OFFICE_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'));
  }
  for (const file of files) {
    try { return String(JSON.parse(readFileSync(file, 'utf8')).version ?? ''); } catch { /* следующий */ }
  }
  return '';
}

/** Пакет npm с нативным бинарём под эту машину. */
const platformPackage = (): string => `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;

/** Движок из PATH — так его находит человек, поставивший Claude Code раньше. */
function fromPath(): string {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [exe()], { encoding: 'utf8', timeout: 5000 });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Где движок лежит прямо сейчас. Порядок неслучаен: сначала то, что человек
 * задал руками, потом своё скачанное (его версия заведомо сходится с SDK), и
 * только потом чужие установки. Из исходников чужие установки не нужны:
 * пусто — SDK находит свой бинарь рядом с собой сам.
 */
function findClaude(): string {
  if (process.env.OFFICE_CLAUDE_BIN) return process.env.OFFICE_CLAUDE_BIN;
  const version = sdkVersion();
  const own = version ? installedBin('claude-code', exe(), version)?.path : undefined;
  if (own) return own;
  // Раскладка прежнего «Движка агентов» приложения: `<папка>/<версия>/claude`.
  const legacy = version ? join(engineDir(), version, exe()) : '';
  if (runnable(legacy)) return legacy;
  if (process.env.OFFICE_APP !== '1') return '';
  const home = homedir();
  const candidates = [
    // Куда кладёт официальный установщик Anthropic.
    join(home, '.local', 'bin', exe()),
    process.env.OFFICE_ROOT
      ? join(process.env.OFFICE_ROOT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, exe())
      : '',
    fromPath(),
  ];
  return candidates.find((path) => runnable(path)) ?? '';
}

let foundBin: string | null = null;

/**
 * Чем считает claude-code. Пусто — SDK ищет свой нативный бинарь сам, рядом с
 * собой: так устроен офис, поставленный из исходников. У приложения такого
 * пакета нет — движок ставится с экрана «Провайдеры» (см.
 * docs/design/providers/spec.md, этап 4).
 */
export const claudeBin = (): string => (foundBin ??= findClaude());

/** Забыть найденный путь: после установки или по «Проверить снова». */
export function forgetClaudeBin(): void {
  foundBin = null;
}

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

/**
 * Бинарь для штатного входа. Из исходников `claudeBin()` пуст — SDK находит
 * движок сам, а входу нужен путь явно: тот же пакет платформы рядом с SDK.
 */
function loginBin(): string {
  const bin = claudeBin();
  if (bin) return bin;
  try {
    const sdk = dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
    const bundled = resolve(sdk, '..', `claude-agent-sdk-${process.platform}-${process.arch}`, exe());
    if (runnable(bundled)) return bundled;
  } catch { /* SDK не найден — движка нет */ }
  return '';
}

let loginCache: { at: number; value: Promise<boolean> } | undefined;

/**
 * Вошёл ли человек в сам Claude Code по подписке. Только признаки входа —
 * токен в окружении, файл учётных данных, запись в Keychain, — сам секрет не
 * читается. Если Keychain не ответил внятно, считаем, что вход есть: так
 * было до экрана «Провайдеры», и ложное «нужен вход» остановило бы офис.
 */
function claudeLoggedIn(): Promise<boolean> {
  if (loginCache && Date.now() - loginCache.at < 30_000) return loginCache.value;
  const value = (async () => {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
    const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    if (existsSync(join(config, '.credentials.json'))) return true;
    if (process.platform !== 'darwin' || process.env.OFFICE_KEYCHAIN === 'memory') return false;
    return new Promise<boolean>((done) => {
      execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { timeout: 5000 }, (err) => {
        // 44 — записи нет. Остальные отказы — «не знаем», а не «нет».
        done(!err || (err as { code?: unknown }).code !== 44);
      });
    });
  })();
  loginCache = { at: Date.now(), value };
  return value;
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
    // В приложении такого пакета нет — пока движок не поставили, его нет.
    if (process.env.OFFICE_APP === '1') return null;
    return { path: '', version: bundledVersion() };
  },

  async status(_provider, opts): Promise<ProviderStatus> {
    if (opts?.force) { forgetClaudeBin(); loginCache = undefined; }
    // Как и проверка окружения: в приложении движок обязан быть найден явно.
    if (process.env.OFFICE_APP === '1' && !claudeBin()) {
      return { state: 'not-installed', engine: 'claude-code', sizeMb: claudeCodeEngine.sizeMb };
    }
    const block = limitBlock(Date.now(), 'claude-code');
    if (block) return { state: 'limited', kind: 'plan', resetsAt: block.resetsAt ?? undefined };
    // Ключ сильнее подписки: с ним расход идёт в платный API.
    if (providerKey('claude-code')) return { state: 'ready', auth: 'api-key' };
    if (await claudeLoggedIn()) return { state: 'ready', auth: 'subscription' };
    return { state: 'needs-login', auth: ['api-key', 'subscription'] };
  },

  // Столько весит архив пакета платформы — его и качаем.
  sizeMb: 95,

  async install(onProgress, signal) {
    const version = sdkVersion();
    if (!version) throw new Error('не прочитать версию Agent SDK — установка повреждена');
    const done = await installFromNpm({ engine: 'claude-code', pkg: platformPackage(), version, bin: exe() }, onProgress, signal);
    forgetClaudeBin();
    return done;
  },

  async login(req) {
    if (req.kind === 'subscription') {
      // Вход в собственный Claude Code человека (решение Q-47): штатный
      // `claude auth login`, токен остаётся в хранилище движка. Ключи
      // окружению команды не достаются — иначе вход ушёл бы не в подписку.
      const bin = loginBin();
      if (!bin) throw new LoginError('unsupported', 'Claude Code is not installed');
      return { done: false, flow: startCliLogin({
        provider: 'claude-code', bin, args: ['auth', 'login', '--claudeai'], env: projectEnv(),
        acceptsCode: true, after: () => { loginCache = undefined; },
      }) };
    }
    if (req.kind !== 'api-key' || !req.apiKey) throw new LoginError('unsupported', `login kind ${req.kind} is not supported`);
    await verifyKey('https://api.anthropic.com/v1/models', {
      'x-api-key': req.apiKey, 'anthropic-version': '2023-06-01',
    });
    try { await saveKey('claude-code', req.apiKey); } catch (err) { throw new LoginError('keychain', (err as Error).message); }
    return { done: true, status: await claudeCodeEngine.status('claude-code') };
  },

  async logout() {
    await deleteKey('claude-code');
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
