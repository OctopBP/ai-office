/**
 * Сессия на универсальном движке OpenCode (spec провайдеров §3.5): любой API
 * в формате OpenAI — xAI, DeepSeek, OpenRouter, Ollama, свой адрес.
 *
 * Цикл агента ведёт сам OpenCode (`opencode serve`), офис его не пишет. На
 * сессию — свой процесс сервера со своим конфигом: провайдер, модель, промпт и
 * мост к инструментам офиса у каждой сессии свои, а конфиг OpenCode читает при
 * старте. История сессий общая — она лежит в данных движка (`opencode-runtime`),
 * поэтому продолжение по id работает и в новом процессе.
 *
 * Свои руки OpenCode выключены: Read/Write/Edit/Bash и инструменты офиса
 * приходят через мост MCP (`mcp-bridge.ts`), и каждый вызов проходит шлюз
 * разрешений офиса (`canUseTool`). Запросы разрешений самого движка
 * отклоняются — обойти шлюз через них нельзя.
 *
 * Стоимость считает офис по токенам и ценам каталога (`model-prices.ts`):
 * цены нет — в итоге хода `cost_unavailable`, и на доске видны токены.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { EngineSession, SDKMessage, SessionOptions, SessionRequest } from '../engines/types';
import type { ProviderId } from '../../shared/providers';
import { DEFAULT_STATE_FILE } from '../store';
import { engineEnv, projectEnv } from '../childenv';
import { installedBin, runnable } from '../engines/install';
import { KEY_VAR, providerKey } from '../engines/keys';
import { baseUrlOf } from '../engines/endpoints';
import { officeCatalog, type CommandExec, type OfficeTool } from './codex-tools';
import { startBridge, type Bridge } from './mcp-bridge';
import { catalogModel, modelPrice } from './model-prices';
import { tokenCost, type TokenPrice } from './pricing';

/** Версия, на которой проверен протокол сервера. Ставится с экрана «Провайдеры» ровно она. */
export const OPENCODE_VERSION = '1.18.34';

const PLATFORM: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const ARCH: Record<string, string> = { arm64: 'arm64', x64: 'x64' };

/** Пакет npm с бинарём под эту машину; пусто — OpenCode под неё не собирается. */
export const OPENCODE_PKG = PLATFORM[process.platform] && ARCH[process.arch]
  ? `opencode-${PLATFORM[process.platform]}-${ARCH[process.arch]}` : '';
export const OPENCODE_BIN = process.platform === 'win32' ? 'bin/opencode.exe' : 'bin/opencode';

/**
 * Где взять движок: явный путь, поставленный офисом, поставленный самим
 * владельцем (официальный установщик кладёт его в `~/.opencode/bin`), PATH.
 */
export function opencodeBinary(): string {
  if (process.env.OFFICE_OPENCODE_PATH) return process.env.OFFICE_OPENCODE_PATH;
  const own = installedBin('opencode', OPENCODE_BIN);
  if (own) return own.path;
  const official = resolve(homedir(), '.opencode', OPENCODE_BIN);
  if (runnable(official)) return official;
  return 'opencode';
}

/** OpenCode провайдера офиса в конфиге движка. Один на сессию — имя постоянное. */
const OC_PROVIDER = 'office';
/** Имя моста MCP в конфиге: OpenCode зовёт инструменты `<сервер>_<инструмент>`. */
const OC_MCP = 'office';
/** Свой агент движка: промпт роли вместо промпта OpenCode. */
const OC_AGENT = 'office';

/**
 * Окружение движка. Данные, конфиг и кеш — в своей папке рядом с состоянием
 * офиса: личные настройки и провайдеры владельца в OpenCode сессию агента не
 * меняют, а история сессий переживает перезапуск.
 */
export function opencodeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = resolve(process.env.OFFICE_OPENCODE_HOME ?? resolve(dirname(DEFAULT_STATE_FILE), 'opencode-runtime'));
  const dirs = { XDG_DATA_HOME: 'data', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' };
  const env: NodeJS.ProcessEnv = {};
  for (const [name, sub] of Object.entries(dirs)) {
    const dir = resolve(home, sub);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    env[name] = dir;
  }
  return engineEnv({
    ...env,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    // Конфиг сессии — целиком наш: ни opencode.json проекта, ни CLAUDE.md и
    // скилы Claude Code не должны тихо дописывать агенту инструкции и права.
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_PURE: '1',
    ...extra,
  });
}

// ─── Руки: команды в песочнице ОС ─────────────────────────────────────────

/**
 * Профиль Seatbelt для команд агента: писать можно в рабочую папку (кроме
 * `.git`) и во временную, сеть наружу закрыта. Читать — всё: так же, как у
 * песочницы Codex в режиме workspaceWrite.
 */
const SEATBELT = `(version 1)
(allow default)
(deny network-outbound (remote ip))
(deny file-write*)
(allow file-write* (subpath (param "CWD")) (subpath (param "TMP")) (subpath "/private/tmp") (subpath "/dev"))
(deny file-write* (subpath (string-append (param "CWD") "/.git")))`;

let seatbelt: boolean | null = null;

/**
 * Есть ли песочница для команд на этой машине. Проверяется запуском, а не по
 * платформе: внутри чужой песочницы `sandbox-exec` не работает (вложить её
 * нельзя), и тогда честнее сказать «песочницы нет».
 */
export function sandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin' || process.platform !== 'darwin') return false;
  if (seatbelt === null) {
    const probe = spawnSync('/usr/bin/sandbox-exec',
      ['-D', `CWD=${realTmp()}`, '-D', `TMP=${realTmp()}`, '-p', SEATBELT, '/usr/bin/true'], { timeout: 5000 });
    seatbelt = probe.status === 0;
  }
  return seatbelt;
}

function realTmp(): string {
  try { return realpathSync(tmpdir()); } catch { return tmpdir(); }
}

const OUTPUT_CAP = 100_000;

/**
 * Исполнитель команд рук офиса. Окружение — проекта, без ключей провайдеров;
 * на macOS — под Seatbelt, если он доступен.
 */
export const localExec: CommandExec = (command, cwd, timeoutMs) => new Promise((done) => {
  let file = command[0]!;
  let args = command.slice(1);
  if (sandboxAvailable()) {
    let root = cwd;
    try { root = realpathSync(cwd); } catch { /* несуществующая папка — команда упадёт сама */ }
    args = ['-D', `CWD=${root}`, '-D', `TMP=${realTmp()}`, '-p', SEATBELT, file, ...args];
    file = '/usr/bin/sandbox-exec';
  }
  const child = spawn(file, args, { cwd, env: projectEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const take = (current: string, chunk: Buffer) =>
    current.length >= OUTPUT_CAP ? current : (current + chunk.toString('utf8')).slice(0, OUTPUT_CAP);
  child.stdout.on('data', (c: Buffer) => { stdout = take(stdout, c); });
  child.stderr.on('data', (c: Buffer) => { stderr = take(stderr, c); });
  const timer = setTimeout(() => { stderr += `\nTimed out after ${timeoutMs} ms`; child.kill('SIGKILL'); }, timeoutMs);
  child.on('error', (err) => { clearTimeout(timer); done({ stdout, stderr: `${stderr}${err.message}`, exitCode: 127 }); });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    done({ stdout, stderr, exitCode: code ?? (signal ? 128 : 1) });
  });
});

// ─── Модели провайдера ────────────────────────────────────────────────────

/** Заголовки к API провайдера: ключ — если он есть (у локальных его может не быть). */
export function providerHeaders(provider: ProviderId, key = providerKey(provider)?.key): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Список моделей с сервера провайдера (`GET /models` в формате OpenAI). */
export async function fetchModels(provider: ProviderId, timeoutMs = 10_000): Promise<string[]> {
  const base = baseUrlOf(provider);
  if (!base) throw new Error('provider address is not set');
  const res = await fetch(`${base}/models`, { headers: providerHeaders(provider), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/models`);
  const body = await res.json() as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** `default` — первая модель, которую отдаёт сервер: у Ollama и своего адреса другой не угадать. */
export async function resolveModel(provider: ProviderId, model: string | undefined): Promise<string> {
  if (model && model !== 'default') return model;
  const [first] = await fetchModels(provider);
  if (!first) throw new Error(`${provider}: the server lists no models`);
  return first;
}

// ─── Конфиг движка ────────────────────────────────────────────────────────

/**
 * Встроенные инструменты OpenCode. Все выключены: руки — через мост офиса,
 * иначе запись в файлы и команды шли бы мимо шлюза разрешений.
 */
const NATIVE_TOOLS = ['bash', 'edit', 'write', 'read', 'glob', 'grep', 'list', 'patch', 'apply_patch', 'multiedit',
  'webfetch', 'websearch', 'codesearch', 'todowrite', 'todoread', 'task', 'lsp', 'skill', 'question'];

export interface ConfigInput {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  /** Переменная окружения с ключом; нет — провайдер без ключа (локальный). */
  keyVar?: string;
  contextWindow?: number;
  system: string;
  bridge: { url: string; authorization: string };
}

/** Конфиг сессии для `OPENCODE_CONFIG_CONTENT`. Ключ в нём — только ссылкой на переменную окружения. */
export function buildConfig(c: ConfigInput): Record<string, unknown> {
  const deny = Object.fromEntries(['bash', 'edit', 'read', 'glob', 'grep', 'list', 'task', 'lsp', 'skill',
    'external_directory', 'webfetch', 'websearch', 'todowrite', 'question'].map((k) => [k, 'deny']));
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    enabled_providers: [OC_PROVIDER],
    provider: {
      [OC_PROVIDER]: {
        npm: '@ai-sdk/openai-compatible',
        name: c.provider,
        options: {
          baseURL: c.baseUrl,
          ...(c.keyVar ? { apiKey: `{env:${c.keyVar}}` } : {}),
          // Локальная модель думает долго, а ход с инструментом офиса может
          // ждать ответа владельца — таймауты движка тут не помощник.
          timeout: false,
        },
        models: {
          [c.model]: {
            name: c.model,
            tool_call: true,
            ...(c.contextWindow
              ? { limit: { context: c.contextWindow, output: Math.min(32_000, Math.floor(c.contextWindow / 4)) } }
              : {}),
          },
        },
      },
    },
    model: `${OC_PROVIDER}/${c.model}`,
    small_model: `${OC_PROVIDER}/${c.model}`,
    default_agent: OC_AGENT,
    agent: {
      [OC_AGENT]: {
        mode: 'primary',
        prompt: c.system,
        tools: Object.fromEntries(NATIVE_TOOLS.map((t) => [t, false])),
        permission: { ...deny, doom_loop: 'allow' },
      },
    },
    tools: Object.fromEntries(NATIVE_TOOLS.map((t) => [t, false])),
    permission: { ...deny, doom_loop: 'allow' },
    mcp: {
      [OC_MCP]: {
        type: 'remote', url: c.bridge.url, oauth: false,
        headers: { Authorization: c.bridge.authorization },
      },
    },
    // Вызов инструмента офиса ждёт подтверждения владельца — это минуты, не секунды.
    experimental: { mcp_timeout: 24 * 60 * 60 * 1000 },
  };
}

export function systemText(options: SessionOptions): string {
  const p = options.systemPrompt;
  return (typeof p === 'string' ? p
    : Array.isArray(p) ? p.join('\n\n')
    : p?.type === 'custom' ? [p.prompt].flat().join('\n\n')
    : p?.append ?? '')
    .replaceAll('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', '');
}

// ─── Процесс и HTTP сервера ───────────────────────────────────────────────

interface Server {
  url: string;
  child: ChildProcess;
  request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T>;
  events(signal: AbortSignal): Promise<AsyncIterable<OcEvent>>;
  close(): void;
}

export interface OcEvent { type: string; properties: Record<string, any> }

/** Поднять `opencode serve` на свободном порту и дождаться адреса в выводе. */
async function startServer(cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Server> {
  const password = randomBytes(24).toString('base64url');
  const auth = `Basic ${Buffer.from(`office:${password}`).toString('base64')}`;
  const child = spawn(opencodeBinary(), ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd, env: { ...env, OPENCODE_SERVER_USERNAME: 'office', OPENCODE_SERVER_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  const keep = (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-2000); };
  child.stderr!.on('data', keep);
  const url = await new Promise<string>((done, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error(`OpenCode did not start in 30 s: ${tail.trim()}`)), 30_000);
    const stop = (err: Error) => { clearTimeout(timer); fail(err); };
    child.stdout!.on('data', (chunk: Buffer) => {
      keep(chunk);
      out += chunk.toString('utf8');
      const found = /opencode server listening on (http:\/\/\S+)/.exec(out);
      if (found) { clearTimeout(timer); done(found[1]!.replace(/\/+$/, '')); }
    });
    child.once('error', (err) => stop(new Error(`OpenCode failed to start: ${err.message}`)));
    child.once('exit', (code) => stop(new Error(`OpenCode exited with code ${code}: ${tail.trim()}`)));
    signal.addEventListener('abort', () => stop(new Error('OpenCode session stopped')), { once: true });
  }).catch((err: Error) => { child.kill('SIGKILL'); throw err; });

  const dir = `directory=${encodeURIComponent(cwd)}`;
  const withDir = (path: string) => `${url}${path}${path.includes('?') ? '&' : '?'}${dir}`;
  return {
    url,
    child,
    async request<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
      const res = await fetch(withDir(path), {
        method,
        headers: { Authorization: auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`OpenCode ${method} ${path}: HTTP ${res.status} ${text.slice(0, 500)}`), { status: res.status });
      return (text ? JSON.parse(text) : undefined) as T;
    },
    async events(stop: AbortSignal) {
      const res = await fetch(withDir('/event'), { headers: { Authorization: auth, Accept: 'text/event-stream' }, signal: stop });
      if (!res.ok || !res.body) throw new Error(`OpenCode event stream: HTTP ${res.status}`);
      return parseSse(res.body);
    },
    close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    },
  };
}

/** Разбор потока SSE: события — это строки `data:` до пустой строки. */
export async function* parseSse(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncIterable<OcEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) { data.push(line.slice(5).replace(/^ /, '')); continue; }
      if (line !== '' || !data.length) continue;
      const raw = data.join('\n');
      data = [];
      try {
        const event = JSON.parse(raw) as { type?: unknown; properties?: unknown; payload?: OcEvent };
        // `/global/event` заворачивает событие в payload — принимаем обе формы.
        const e = event.payload ?? event;
        if (typeof e.type === 'string') yield { type: e.type, properties: (e.properties ?? {}) as Record<string, any> };
      } catch { /* не JSON — служебная строка, пропускаем */ }
    }
  }
}

// ─── Перевод событий в сообщения офиса ────────────────────────────────────

class Events implements AsyncIterable<SDKMessage> {
  private values: SDKMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private error: Error | null = null;
  push(value: object) { this.values.push(value as SDKMessage); this.wake?.(); }
  end(error?: Error) { this.done = true; this.error = error ?? null; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const item = this.values.shift();
      if (item) { yield item; continue; }
      if (this.done) { if (this.error) throw this.error; return; }
      await new Promise<void>(r => { this.wake = r; }); this.wake = null;
    }
  }
}

export interface Usage {
  input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number;
}
const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

/** Токены шага OpenCode в форме офиса. Рассуждения модели оплачиваются как вывод. */
export function stepUsage(tokens: any): Usage {
  return {
    input_tokens: Number(tokens?.input ?? 0),
    output_tokens: Number(tokens?.output ?? 0) + Number(tokens?.reasoning ?? 0),
    cache_read_input_tokens: Number(tokens?.cache?.read ?? 0),
    cache_creation_input_tokens: Number(tokens?.cache?.write ?? 0),
  };
}

/** Текст ошибки OpenCode: у его ошибок сообщение лежит в `data.message`. */
export function errorText(error: any): string {
  if (!error) return 'OpenCode error';
  const message = error.data?.message ?? error.message;
  return typeof message === 'string' && message ? message : String(error.name ?? 'OpenCode error');
}

export function opencodeQuery({ prompt, options }: SessionRequest): EngineSession {
  const provider = options.provider ?? 'custom';
  const cwd = options.cwd ?? process.cwd();
  const events = new Events();
  const abort = options.abortController ?? new AbortController();
  const streamStop = new AbortController();
  // Присваиваются внутри замыканий — без `as` TS сужает их до null навсегда.
  let server = null as Server | null;
  let bridge = null as Bridge | null;
  let catalog = null as Awaited<ReturnType<typeof officeCatalog>> | null;
  let session = '';
  let model = '';
  let price: TokenPrice | null = null;
  let text = '';
  let calls = 0;
  let totalCost = 0;
  let budgetSpent = 0;
  let usage = emptyUsage();
  let turnActive = false;
  let turnError: string | null = null;
  let finish: (() => void) | null = null;
  let rejectTurn: ((e: Error) => void) | null = null;
  let stopping = false;
  const partText = new Map<string, string>();
  const seenParts = new Set<string>();
  let cancelWait!: (error: Error) => void;
  const cancelled = new Promise<never>((_, reject) => { cancelWait = reject; });
  void cancelled.catch(() => {});

  const emit = (msg: object) => events.push({ uuid: randomUUID(), session_id: `opencode:${session}`, ...msg });
  const assistant = (content: unknown[], callUsage?: Usage) =>
    emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content, ...(callUsage ? { usage: callUsage } : {}) } });
  const result = (error?: string) => emit({
    type: 'result',
    subtype: error ? (turnError === 'maxTurns' ? 'error_max_turns' : turnError === 'budget' ? 'error_max_budget_usd' : 'error_during_execution') : 'success',
    is_error: Boolean(error), result: error ?? text, errors: error ? [error] : [],
    total_cost_usd: totalCost, cost_unavailable: !price, num_turns: calls, usage,
    ...(model ? { modelUsage: { [model]: {
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: usage.cache_creation_input_tokens,
      webSearchRequests: 0, costUSD: totalCost, contextWindow: 0, maxOutputTokens: 0,
    } } } : {}),
  });
  const fail = (error: Error) => { cancelWait(error); rejectTurn?.(error); events.end(error); };
  const interrupt = () => {
    if (server && session) void server.request('POST', `/session/${session}/abort`, {}, 5000).catch(() => {});
  };

  /** Вызов из моста: шлюз разрешений офиса, счёт ходов и след в ленте. */
  const call = async (tool: OfficeTool, raw: Record<string, unknown>) => {
    if (abort.signal.aborted) throw new Error('Session stopped');
    calls++;
    if (options.maxTurns && calls > options.maxTurns) {
      turnError = 'maxTurns'; interrupt();
      throw new Error('Reached maximum number of turns');
    }
    const id = `toolu_${randomUUID()}`;
    let input = raw;
    assistant([{ type: 'tool_use', id, name: tool.name, input }]);
    const permission = await options.canUseTool?.(tool.name, input, {
      signal: abort.signal, requestId: id, toolUseID: id, suggestions: [],
    } as never);
    if (permission?.behavior === 'deny') throw new Error(permission.message);
    if (permission?.behavior === 'allow') input = (permission.updatedInput as Record<string, unknown> | undefined) ?? input;
    if (abort.signal.aborted) throw new Error('Session stopped');
    const output = await tool.run(input);
    return { content: output?.content ?? [], isError: Boolean(output?.isError) };
  };

  const endTurn = () => {
    if (!turnActive) return;
    turnActive = false;
    const error = turnError === 'maxTurns' ? 'Reached maximum number of turns'
      : turnError === 'budget' ? 'Reached the USD budget' : turnError ?? undefined;
    result(error);
    finish?.();
  };

  const onEvent = (e: OcEvent) => {
    const p = e.properties;
    if (p.sessionID && p.sessionID !== session) return;
    switch (e.type) {
      case 'message.part.delta': {
        if (p.field !== 'text') return;
        partText.set(p.partID, (partText.get(p.partID) ?? '') + p.delta);
        // Рассуждения тоже идут дельтами — в пузырь им не место, их отличает тип части.
        if (!seenParts.has(`reasoning:${p.partID}`)) {
          emit({ type: 'stream_event', parent_tool_use_id: null,
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p.delta } } });
        }
        return;
      }
      case 'message.part.updated': {
        const part = p.part ?? {};
        if (part.sessionID && part.sessionID !== session) return;
        if (part.type === 'reasoning') {
          seenParts.add(`reasoning:${part.id}`);
          if (part.time?.end && !seenParts.has(part.id)) {
            seenParts.add(part.id);
            assistant([{ type: 'thinking', thinking: String(part.text ?? partText.get(part.id) ?? '') }]);
          }
        } else if (part.type === 'text' && part.time?.end && !seenParts.has(part.id)) {
          seenParts.add(part.id);
          const body = String(part.text ?? partText.get(part.id) ?? '');
          if (body.trim() && !part.synthetic) {
            text += (text ? '\n' : '') + body;
            assistant([{ type: 'text', text: body }]);
          }
        } else if (part.type === 'step-finish' && !seenParts.has(part.id)) {
          seenParts.add(part.id);
          const step = stepUsage(part.tokens);
          usage = {
            input_tokens: usage.input_tokens + step.input_tokens,
            output_tokens: usage.output_tokens + step.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens + step.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens + step.cache_creation_input_tokens,
          };
          // Размер контекста — по последнему вызову модели, как у Claude.
          assistant([], step);
          if (price) {
            const cost = tokenCost(price, step.input_tokens, step.cache_read_input_tokens, step.output_tokens);
            totalCost += cost;
            budgetSpent += cost;
          }
          if (options.maxBudgetUsd && budgetSpent >= options.maxBudgetUsd && !turnError) {
            turnError = 'budget'; interrupt();
          }
        }
        return;
      }
      case 'message.updated': {
        const info = p.info ?? {};
        if (info.role === 'assistant' && info.error && info.error.name !== 'MessageAbortedError' && !turnError) {
          turnError = errorText(info.error);
        }
        return;
      }
      case 'session.error': {
        if (p.error && p.error.name !== 'MessageAbortedError' && !turnError) turnError = errorText(p.error);
        return;
      }
      case 'session.status': {
        const status = p.status ?? {};
        if (status.type === 'idle') endTurn();
        // Повторы движка по 429 и сбоям сети бесконечны — после третьего
        // останавливаем ход: офис сам разберёт лимит и решит, ждать ли.
        if (status.type === 'retry' && Number(status.attempt) >= 3 && !turnError) {
          turnError = String(status.message ?? 'Provider request failed'); interrupt();
        }
        return;
      }
      case 'session.idle':
        endTurn();
        return;
      case 'session.compacted':
        emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: {
          trigger: 'auto', pre_tokens: usage.input_tokens + usage.cache_read_input_tokens,
        } });
        return;
      case 'permission.asked':
        // Свои инструменты движка выключены; всё, что всё же просит разрешения,
        // идёт мимо шлюза офиса — отказ.
        void server?.request('POST', `/permission/${p.id}/reply`, { reply: 'reject',
          message: 'Use the AI Office tools; native tools are disabled.' }).catch(() => {});
        return;
      case 'question.asked':
        void server?.request('POST', `/question/${p.id}/reject`, {}).catch(() => {});
        return;
    }
  };

  const ready = (async () => {
    const base = baseUrlOf(provider);
    if (!base) throw new Error(`${provider}: provider address is not set`);
    model = await resolveModel(provider, options.model);
    price = await modelPrice(provider, model);
    if (options.maxBudgetUsd && !price) {
      throw new Error(`No price is known for ${model}. Set OFFICE_MODEL_PRICING for this model before using a dollar budget.`);
    }
    catalog = await officeCatalog(options, localExec,
      sandboxAvailable()
        ? 'Run a shell command in the OS sandbox. Writes stay in the workspace; no network.'
        : 'Run a shell command in the workspace.');
    bridge = await startBridge(catalog.tools, call);
    const known = await catalogModel(provider, model);
    const config = buildConfig({
      provider, baseUrl: base, model, system: systemText(options),
      keyVar: providerKey(provider) ? KEY_VAR[provider] : undefined,
      contextWindow: known?.contextWindow,
      bridge: { url: bridge.url, authorization: bridge.authorization },
    });
    if (abort.signal.aborted) throw new Error('OpenCode session stopped');
    server = await startServer(cwd, opencodeEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }), abort.signal);
    server.child.once('exit', (code) => { if (!stopping) fail(new Error(`OpenCode exited with code ${code}`)); });

    const stream = await server.events(streamStop.signal);
    void (async () => {
      try { for await (const e of stream) onEvent(e); }
      catch (err) { if (!stopping) fail(err instanceof Error ? err : new Error(String(err))); }
    })();

    if (options.resume) {
      try {
        session = (await server.request<{ id: string }>('GET', `/session/${encodeURIComponent(options.resume)}`)).id;
      } catch (err) {
        // Сессия не нашлась (стёрли данные движка) — как у Claude: продолжать нечего.
        if ((err as { status?: number }).status !== 404) throw err;
        throw new Error(`OpenCode session ${options.resume} not found`);
      }
    } else {
      session = (await server.request<{ id: string }>('POST', '/session', { title: 'AI Office' })).id;
    }
    emit({ type: 'system', subtype: 'init', cwd, model, apiKeySource: 'opencode',
      tools: catalog.tools.map((t) => t.name), mcp_servers: catalog.statuses });
  })();
  void ready.catch(fail);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    interrupt();
    streamStop.abort();
    setTimeout(() => server?.close(), 500).unref();
    fail(new Error('OpenCode session stopped'));
  };
  abort.signal.addEventListener('abort', stop, { once: true });

  void (async () => {
    try {
      await ready;
      if (abort.signal.aborted) throw new Error('OpenCode session stopped');
      const input = typeof prompt === 'string' ? (async function* () { yield prompt; })()
        : (async function* () { for await (const m of prompt) yield typeof m.message.content === 'string'
          ? m.message.content : m.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'); })();
      const iterator = input[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled]);
        if (next.done) break;
        const message = next.value;
        text = ''; calls = 0; turnError = null; totalCost = 0;
        usage = emptyUsage();
        if (message.startsWith('/compact')) {
          // Сжатие — синхронный вызов; граница приходит событием session.compacted.
          try {
            await server!.request('POST', `/session/${session}/summarize`,
              { providerID: OC_PROVIDER, modelID: model, auto: false }, 30 * 60_000);
            result();
          } catch (err) {
            result((err as Error).message);
          }
          continue;
        }
        const done = new Promise<void>((resolve, reject) => { finish = resolve; rejectTurn = reject; });
        void done.catch(() => {});
        turnActive = true;
        emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
        await server!.request('POST', `/session/${session}/prompt_async`, {
          agent: OC_AGENT,
          model: { providerID: OC_PROVIDER, modelID: model },
          parts: [{ type: 'text', text: message }],
        });
        await done; finish = null; rejectTurn = null;
      }
      events.end();
    } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
    finally {
      abort.signal.removeEventListener('abort', stop);
      stopping = true;
      streamStop.abort();
      server?.close();
      await bridge?.close();
      await catalog?.close();
    }
  })();

  return {
    provider,
    async *[Symbol.asyncIterator]() {
      try { yield* events; } finally { stop(); }
    },
    mcpServerStatus: async () => { await ready; return catalog!.statuses; },
    // Окон подписки у API по ключу нет: только деньги, а их считает офис.
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: false }) as never,
  };
}
