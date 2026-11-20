/**
 * Kimi Code по локальной подписке. Живые сессии идут через ACP (`kimi acp`),
 * а модели и окна подписки — через временный KAP-сервер (`kimi web --json`).
 * Ни диагностика, ни чтение лимитов не запускают платный ход модели.
 *
 * OAuth общий с интерактивным Kimi Code: офис не читает и не хранит токены,
 * а каталог credentials в своей изолированной папке — ссылка на каталог
 * владельца. Остальная конфигурация отдельная. Встроенные Read/Write/Bash и
 * остальные инструменты Kimi запрещены: руки роли приходят только из моста
 * офиса и проходят `canUseTool`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { EngineSession, SDKMessage, SessionOptions, SessionRequest } from '../engines/types';
import { DEFAULT_STATE_FILE } from '../store';
import { engineEnv, projectEnv } from '../childenv';
import { installedBin } from '../engines/install';
import { officeCatalog, type OfficeTool } from './codex-tools';
import { localExec, sandboxAvailable, systemText } from './opencode';
import { startBridge, type Bridge } from './mcp-bridge';
import type { UsageReport } from '../limits';

export const KIMI_CODE_VERSION = '2.6.3';
export const KIMI_CODE_PKG = '@moonshot-ai/kimi-code';
export const KIMI_CODE_BIN = 'dist/main.mjs';
const MANAGED_PROVIDER = 'managed:kimi-code';

export function kimiCodeBinary(): string {
  if (process.env.OFFICE_KIMI_CODE_PATH) return process.env.OFFICE_KIMI_CODE_PATH;
  return installedBin('kimi-code', KIMI_CODE_BIN)?.path ?? 'kimi';
}

/** Пакет ставит ES-модуль без системной обертки: его запускает текущий Node. */
export function kimiCommand(args: string[], bin = kimiCodeBinary()): { file: string; args: string[] } {
  return bin.endsWith('.mjs') ? { file: process.execPath, args: [bin, ...args] } : { file: bin, args };
}

export function ownerKimiHome(): string {
  return resolve(process.env.KIMI_CODE_HOME ?? resolve(homedir(), '.kimi-code'));
}

export function runtimeKimiHome(): string {
  return resolve(process.env.OFFICE_KIMI_CODE_HOME ?? resolve(dirname(DEFAULT_STATE_FILE), 'kimi-code-runtime'));
}

const NODE_RUNTIME = { ELECTRON_RUN_AS_NODE: '1' } as const;

export function ownerEnv(): NodeJS.ProcessEnv {
  // Сервер desktop-приложения сам является Electron: для его Node-режима эта
  // переменная обязательна, а установленный системный Node её просто игнорирует.
  return engineEnv({ ...NODE_RUNTIME, KIMI_CODE_HOME: ownerKimiHome() });
}

/** Заменить ровно секцию [tools], не трогая модели и OAuth владельца. */
export function officeConfig(source: string): string {
  const kept: string[] = [];
  let inTools = false;
  for (const line of source.split('\n')) {
    if (/^\s*\[tools\]\s*$/.test(line)) { inTools = true; continue; }
    if (/^\s*\[/.test(line)) inTools = false;
    if (!inTools) kept.push(line);
  }
  const withoutTools = kept.join('\n').trimEnd();
  return `${withoutTools}${withoutTools ? '\n\n' : ''}[tools]\nwhitelist = ["mcp__office__*"]\n`;
}

/** Общие только учётные данные; история, политика и кеши офиса изолированы. */
export function runtimeEnv(): NodeJS.ProcessEnv {
  const home = runtimeKimiHome();
  const owner = ownerKimiHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const sourceConfig = resolve(owner, 'config.toml');
  const config = existsSync(sourceConfig) ? readFileSync(sourceConfig, 'utf8') : '';
  writeFileSync(resolve(home, 'config.toml'), officeConfig(config), { mode: 0o600 });

  const credentials = resolve(owner, 'credentials');
  const link = resolve(home, 'credentials');
  if (process.platform === 'win32') mkdirSync(credentials, { recursive: true, mode: 0o700 });
  let linkExists = true;
  try { lstatSync(link); } catch { linkExists = false; }
  if (!linkExists) {
    symlinkSync(credentials, link, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink() && !(process.platform === 'win32' && stat.isDirectory())) {
      throw new Error(`Kimi Code runtime credentials is not a shared credentials link: ${link}`);
    }
  }
  return engineEnv({ ...NODE_RUNTIME, KIMI_CODE_HOME: home });
}

interface KimiModel { id: string; label: string }
interface KimiMetadata {
  models: KimiModel[];
  usage: any;
  account?: string;
  plan?: string;
}

interface Kap {
  origin: string;
  token: string;
  child: ChildProcessWithoutNullStreams;
  close(): void;
}

/** Поднять metadata-only KAP с одноразовым токеном на свободном loopback-порту. */
async function startKap(): Promise<Kap> {
  const command = kimiCommand(['web', '--host=127.0.0.1', '--port=0', '--json']);
  const child = spawn(command.file, command.args, {
    cwd: process.cwd(), env: ownerEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
  const ready = await new Promise<{ origin: string; token: string }>((done, fail) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error(`Kimi Code metadata server did not start: ${stderr.trim()}`)), 20_000);
    const stop = (error: Error) => { clearTimeout(timer); fail(error); };
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-16_384);
      const line = output.split(/\r?\n/).find((row) => row.trim().startsWith('{'));
      if (!line) return;
      try {
        const data = JSON.parse(line) as { origin?: string; token?: string };
        if (data.origin && data.token) { clearTimeout(timer); done({ origin: data.origin, token: data.token }); }
      } catch { /* дождаться завершенной JSON-строки */ }
    });
    child.once('error', (err) => stop(err));
    child.once('exit', (code) => stop(new Error(`Kimi Code metadata server exited (${code}): ${stderr.trim()}`)));
  }).catch((error: Error) => { child.kill('SIGKILL'); throw error; });
  return {
    ...ready, child,
    close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000).unref();
    },
  };
}

async function kapGet<T>(kap: Kap, path: string): Promise<T> {
  const response = await fetch(`${kap.origin}${path}`, {
    headers: { Authorization: `Bearer ${kap.token}` }, signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Kimi Code ${path}: HTTP ${response.status} ${text.slice(0, 300)}`), { status: response.status });
  const envelope = JSON.parse(text) as { code?: number; data?: T; msg?: string };
  if (envelope.code !== 0) throw new Error(envelope.msg || `Kimi Code ${path}: code ${envelope.code}`);
  return envelope.data as T;
}

let metadataCache: { at: number; value: Promise<KimiMetadata> } | null = null;

/** Модели и usage аккаунта; никаких prompt/turn API здесь не вызывается. */
export function kimiMetadata(force = false): Promise<KimiMetadata> {
  if (!force && metadataCache && Date.now() - metadataCache.at < 30_000) return metadataCache.value;
  const value = (async (): Promise<KimiMetadata> => {
    const kap = await startKap();
    try {
      const provider = encodeURIComponent(MANAGED_PROVIDER);
      const [modelData, usage, profile] = await Promise.all([
        kapGet<{ items?: any[] }>(kap, '/api/v1/models'),
        kapGet<any>(kap, `/api/v1/oauth/usage?provider=${provider}`),
        kapGet<any>(kap, `/api/v1/oauth/userinfo?provider=${provider}`).catch(() => null),
      ]);
      const models = (modelData.items ?? [])
        .filter((item) => item?.provider === MANAGED_PROVIDER && typeof item.model === 'string')
        .map((item) => ({ id: item.model, label: String(item.display_name || item.model) }));
      const info = profile?.kind === 'ok' ? profile.userInfo ?? {} : {};
      return {
        models, usage,
        account: info.nickname || info.email || info.username || undefined,
        plan: info.userLevelName || undefined,
      };
    } finally { kap.close(); }
  })();
  metadataCache = { at: Date.now(), value };
  return value;
}

export function usageReport(usage: any, plan?: string): UsageReport {
  const windows = usage?.kind === 'ok' ? usage.quota?.usages ?? {} : {};
  const pair = (key: string) => {
    const item = windows[key];
    if (typeof item?.usedRatio !== 'number') return null;
    return { utilization: Math.max(0, Math.min(100, item.usedRatio * 100)), resets_at: item.resetAt ?? null };
  };
  const primary = pair('limit5h');
  const secondary = pair('monthTotal');
  return {
    subscription_type: plan ?? 'Kimi Code',
    rate_limits_available: usage?.kind === 'ok',
    rate_limits: usage?.kind === 'ok' ? {
      ...(primary ? { kimi_primary: primary } : {}),
      ...(secondary ? { kimi_secondary: secondary } : {}),
    } : null,
  };
}

export function exhaustedWindow(usage: any): { resetsAt?: number } | null {
  if (usage?.kind !== 'ok') return null;
  const windows = [usage.quota?.usages?.limit5h, usage.quota?.usages?.monthTotal];
  const exhausted = windows.filter((item) => typeof item?.usedRatio === 'number' && item.usedRatio >= 1);
  if (!exhausted.length) return null;
  const resets = exhausted.map((item) => Date.parse(item.resetAt ?? '')).filter(Number.isFinite);
  return resets.length ? { resetsAt: Math.max(...resets) } : {};
}

// ─── ACP JSON-RPC ──────────────────────────────────────────────────────────

type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string; code?: number } };

class AcpRpc {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private closed = false;
  private stderr = '';
  onMessage: (message: RpcMessage) => void = () => {};
  onError: (error: Error) => void = () => {};

  constructor(cwd: string, env: NodeJS.ProcessEnv) {
    const command = kimiCommand(['acp']);
    this.child = spawn(command.file, command.args, { cwd, env, stdio: 'pipe', windowsHide: true });
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000); });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code, signal) => this.fail(new Error(`Kimi Code ACP exited (${code ?? signal}). ${this.stderr}`)));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line) as RpcMessage;
        if (!message.method && typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message || `Kimi Code RPC ${message.error.code}`));
          else pending.resolve(message.result);
        } else this.onMessage(message);
      } catch (error) { this.fail(new Error(`Invalid Kimi Code ACP protocol: ${String(error)}`)); }
    });
  }

  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Kimi Code ACP is closed'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Kimi Code ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  send(message: object): void { if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  notify(method: string, params?: unknown): void { this.send({ method, ...(params === undefined ? {} : { params }) }); }
  private fail(error: Error): void { if (!this.closed) { this.onError(error); this.close(error); } }
  close(error = new Error('Kimi Code ACP closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.child.stdin.end(); this.child.kill('SIGTERM');
    setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL'); }, 2000).unref();
  }
}

/** Штатный logout ACP удаляет OAuth managed:kimi-code, не токен API офиса. */
export async function kimiLogout(): Promise<void> {
  const rpc = new AcpRpc(process.cwd(), runtimeEnv());
  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ai-office', version: '1.0.0' },
    }, 15_000);
    await rpc.request('logout', {}, 15_000);
  } finally { rpc.close(); }
}

class Events implements AsyncIterable<SDKMessage> {
  private values: SDKMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private error: Error | null = null;
  push(value: object): void { this.values.push(value as SDKMessage); this.wake?.(); }
  end(error?: Error): void { this.done = true; this.error = error ?? null; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const item = this.values.shift();
      if (item) { yield item; continue; }
      if (this.done) { if (this.error) throw this.error; return; }
      await new Promise<void>((resolve) => { this.wake = resolve; }); this.wake = null;
    }
  }
}

const noUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

export function kimiQuery({ prompt, options }: SessionRequest): EngineSession {
  const events = new Events();
  const cwd = options.cwd ?? process.cwd();
  const abort = options.abortController ?? new AbortController();
  let rpc = null as AcpRpc | null;
  let bridge = null as Bridge | null;
  let catalog = null as Awaited<ReturnType<typeof officeCatalog>> | null;
  let session = '';
  let text = '';
  let currentText = '';
  let thinking = '';
  let calls = 0;
  let usage = noUsage();
  let contextWindow = 0;
  let turnError: string | null = null;
  let stopping = false;
  let cancelWait!: (error: Error) => void;
  const cancelled = new Promise<never>((_, reject) => { cancelWait = reject; });
  void cancelled.catch(() => {});
  const model = options.model && options.model !== 'default' ? options.model : 'default';

  const emit = (message: object) => events.push({ uuid: randomUUID(), session_id: `kimi-code:${session}`, ...message });
  const assistant = (content: unknown[]) => emit({ type: 'assistant', parent_tool_use_id: null,
    message: { role: 'assistant', content, ...(usage.input_tokens + usage.output_tokens > 0 ? { usage } : {}) } });
  const result = (error?: string) => emit({
    type: 'result', subtype: error ? (turnError === 'maxTurns' ? 'error_max_turns' : 'error_during_execution') : 'success',
    is_error: Boolean(error), result: error ?? text, errors: error ? [error] : [],
    total_cost_usd: 0, cost_unavailable: true, num_turns: calls, usage,
    ...(model !== 'default' ? { modelUsage: { [model]: {
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: usage.cache_creation_input_tokens,
      webSearchRequests: 0, costUSD: 0, contextWindow, maxOutputTokens: 0,
    } } } : {}),
  });
  const fail = (error: Error) => { cancelWait(error); events.end(error); };
  const interrupt = () => { if (rpc && session) rpc.notify('session/cancel', { sessionId: session }); };

  const call = async (tool: OfficeTool, raw: Record<string, unknown>) => {
    if (abort.signal.aborted) throw new Error('Kimi Code session stopped');
    calls++;
    if (options.maxTurns && calls > options.maxTurns) {
      turnError = 'maxTurns'; interrupt(); throw new Error('Reached maximum number of turns');
    }
    const id = `toolu_${randomUUID()}`;
    let input = raw;
    assistant([{ type: 'tool_use', id, name: tool.name, input }]);
    const permission = await options.canUseTool?.(tool.name, input, {
      signal: abort.signal, requestId: id, toolUseID: id, suggestions: [],
    } as never);
    if (permission?.behavior === 'deny') throw new Error(permission.message);
    if (permission?.behavior === 'allow') input = (permission.updatedInput as Record<string, unknown> | undefined) ?? input;
    if (abort.signal.aborted) throw new Error('Kimi Code session stopped');
    const output = await tool.run(input);
    return { content: output?.content ?? [], isError: Boolean(output?.isError) };
  };

  const noteUsage = (update: any) => {
    if (typeof update.size === 'number') contextWindow = update.size;
    const value = update.tokenUsage ?? update.token_usage ?? update.usage;
    if (!value) return;
    usage = {
      input_tokens: Number(value.input_other ?? value.inputTokens ?? value.input_tokens ?? 0),
      output_tokens: Number(value.output ?? value.outputTokens ?? value.output_tokens ?? 0),
      cache_read_input_tokens: Number(value.input_cache_read ?? value.cacheReadInputTokens ?? value.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens: Number(value.input_cache_creation ?? value.cacheCreationInputTokens ?? value.cache_creation_input_tokens ?? 0),
    };
  };

  const notification = (message: RpcMessage) => {
    if (message.id !== undefined && message.method) {
      // Ни native permissions, ни fs/terminal не дают обойти шлюз офиса.
      if (message.method === 'session/request_permission') rpc?.send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
      else rpc?.send({ id: message.id, error: { code: -32601, message: 'Native tools are disabled; use AI Office tools.' } });
      return;
    }
    if (message.method !== 'session/update' || (message.params?.sessionId && message.params.sessionId !== session)) return;
    const update = message.params?.update ?? {};
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'content_block') {
      const delta = String(update.content?.text ?? '');
      if (!delta) return;
      currentText += delta;
      emit({ type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } });
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      thinking += String(update.content?.text ?? '');
    } else if (update.sessionUpdate === 'usage_update') {
      noteUsage(update);
    } else if (update.sessionUpdate === 'tool_call' && !String(update.title ?? '').includes('office')) {
      assistant([{ type: 'tool_use', id: update.toolCallId, name: update.title || 'Kimi tool', input: update.rawInput ?? {} }]);
    }
  };

  const ready = (async () => {
    if (options.maxBudgetUsd) {
      throw new Error('Kimi Code subscription does not report USD cost; a dollar budget cannot be enforced.');
    }
    catalog = await officeCatalog(options, localExec,
      sandboxAvailable() ? 'Run a shell command in the OS sandbox. Writes stay in the workspace; no network.' : 'Run a shell command in the workspace.');
    bridge = await startBridge(catalog.tools, call);
    if (abort.signal.aborted) throw new Error('Kimi Code session stopped');
    rpc = new AcpRpc(cwd, runtimeEnv());
    rpc.onMessage = notification;
    rpc.onError = (error) => { if (!stopping) fail(error); };
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ai-office', version: '1.0.0' },
    }, 20_000);
    rpc.notify('notifications/initialized');
    const mcpServers = [{ name: 'office', type: 'http', url: bridge.url,
      headers: [{ name: 'Authorization', value: bridge.authorization }] }];
    const created = options.resume
      ? await rpc.request('session/resume', { sessionId: options.resume, cwd, mcpServers }, 30_000)
      : await rpc.request('session/new', { cwd, mcpServers }, 30_000);
    session = options.resume ?? created?.sessionId;
    if (!session) throw new Error('Kimi Code did not return a session id');
    if (model !== 'default') await rpc.request('session/set_config_option', { sessionId: session, configId: 'model', value: model }, 20_000);
    emit({ type: 'system', subtype: 'init', cwd, model, apiKeySource: 'kimi-code',
      tools: catalog.tools.map((tool) => tool.name), mcp_servers: catalog.statuses });
  })();
  void ready.catch(fail);

  const stop = () => {
    if (stopping) return;
    stopping = true; interrupt(); fail(new Error('Kimi Code session stopped')); rpc?.close();
  };
  abort.signal.addEventListener('abort', stop, { once: true });

  void (async () => {
    try {
      await ready;
      if (abort.signal.aborted) throw new Error('Kimi Code session stopped');
      const system = systemText(options).trim();
      let first = !options.resume;
      const input = typeof prompt === 'string' ? (async function* () { yield prompt; })()
        : (async function* () { for await (const message of prompt) yield typeof message.message.content === 'string'
          ? message.message.content : message.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'); })();
      const iterator = input[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled]);
        if (next.done) break;
        let message = next.value;
        if (first && system && !message.startsWith('/compact')) {
          message = `<office_instructions>\n${system}\n</office_instructions>\n\n<user_request>\n${message}\n</user_request>`;
        }
        first = false;
        text = ''; currentText = ''; thinking = ''; calls = 0; usage = noUsage(); turnError = null;
        emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
        const response = await Promise.race([rpc!.request('session/prompt', {
          sessionId: session, prompt: [{ type: 'text', text: message }],
        }, 24 * 60 * 60_000), cancelled]);
        if (thinking.trim()) assistant([{ type: 'thinking', thinking }]);
        if (currentText.trim()) { text = currentText; assistant([{ type: 'text', text: currentText }]); }
        if (message === '/compact' || message.startsWith('/compact ')) {
          emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: {
            trigger: 'manual', pre_tokens: contextWindow ? usage.input_tokens + usage.cache_read_input_tokens : 0,
          } });
        }
        const stopped = response?.stopReason;
        const error = turnError === 'maxTurns' ? 'Reached maximum number of turns'
          : stopped && stopped !== 'end_turn' && stopped !== 'cancelled' ? `Kimi Code turn ${stopped}` : undefined;
        result(error);
      }
      events.end();
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    finally {
      abort.signal.removeEventListener('abort', stop); stopping = true;
      if (rpc && session) rpc.notify('session/close', { sessionId: session });
      rpc?.close(); await bridge?.close(); await catalog?.close();
    }
  })();

  return {
    provider: 'kimi-code',
    async *[Symbol.asyncIterator]() { try { yield* events; } finally { stop(); } },
    mcpServerStatus: async () => { await ready; return catalog!.statuses; },
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
      const metadata = await kimiMetadata(true);
      return usageReport(metadata.usage, metadata.plan);
    },
  };
}

/** Для входа используется owner home, не изолированный runtime офиса. */
export function loginEnv(): NodeJS.ProcessEnv {
  return projectEnv({ ...NODE_RUNTIME, KIMI_CODE_HOME: ownerKimiHome() });
}
