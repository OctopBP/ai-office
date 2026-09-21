import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import type { AgentSession, SessionRequest, SDKMessage } from './index';
import { CodexRpc, type RpcMessage } from './rpc';
import { codexTools } from './codex-tools';
import { DEFAULT_STATE_FILE } from '../store';
import { codexPrice, tokenCost, type TokenPrice } from './pricing';

export function codexBinary(): string {
  if (process.env.OFFICE_CODEX_PATH) return process.env.OFFICE_CODEX_PATH;
  for (const path of ['/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex']) {
    if (existsSync(path)) return path;
  }
  return 'codex';
}

/** Separate config/skills/plugins from the owner's interactive Codex. Auth alone is shared. */
export function runtimeEnv(): NodeJS.ProcessEnv {
  const home = resolve(process.env.OFFICE_CODEX_HOME ?? resolve(dirname(DEFAULT_STATE_FILE), 'codex-runtime'));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const auth = resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'auth.json');
  const target = resolve(home, 'auth.json');
  if (!existsSync(target) && existsSync(auth) && target !== auth) {
    try { symlinkSync(auth, target); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  return { ...process.env, CODEX_HOME: home };
}

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

export function codexQuery({ prompt, options }: SessionRequest): AgentSession {
  const events = new Events();
  let rpc!: CodexRpc;
  let catalog!: Awaited<ReturnType<typeof codexTools>>;
  const toolNames = new Map<string, string>();
  let thread = '';
  let turn = '';
  let text = '';
  let calls = 0;
  let price: TokenPrice | null = null;
  let totalCost = 0;
  let budgetSpent = 0;
  let lastTotalTokens = -1;
  let turnActive = false;
  let turnError: string | null = null;
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let finish: (() => void) | null = null;
  let rejectTurn: ((e: Error) => void) | null = null;
  let compacting = false;
  let stopping = false;
  let cancelWait!: (error: Error) => void;
  const cancelled = new Promise<never>((_, reject) => { cancelWait = reject; });
  void cancelled.catch(() => {});
  const abort = options.abortController ?? new AbortController();
  const emit = (msg: object) => events.push({ uuid: randomUUID(), session_id: `codex:${thread}`, ...msg });
  const rateReport = (data: any) => {
    const bucket = data.rateLimitsByLimitId?.codex ?? data.rateLimits;
    if (!bucket) return { rate_limits_available: false };
    const windows = [['codex_primary', bucket.primary], ['codex_secondary', bucket.secondary]] as const;
    const exhausted = windows.filter(([, w]) => w && w.usedPercent >= 100);
    const resets = exhausted.map(([, w]) => w.resetsAt).filter((v): v is number => typeof v === 'number');
    emit({ type: 'rate_limit_event', provider: 'codex', rate_limit_info: {
      status: exhausted.length ? 'rejected' : 'allowed',
      ...(resets.length ? { resetsAt: Math.max(...resets) } : {}),
    } });
    return { rate_limits_available: true, subscription_type: bucket.planType,
      rate_limits: Object.fromEntries(windows.filter(([, w]) => w).map(([name, w]) => [name, {
        utilization: w.usedPercent, resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
      }])) };
  };
  const assistant = (content: unknown[]) => {
    const measured = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0;
    emit({ type: 'assistant', parent_tool_use_id: null,
      message: { role: 'assistant', content, ...(measured ? { usage } : {}) } });
  };
  const result = (error?: string) => emit({ type: 'result', subtype: error ? (turnError === 'maxTurns' ? 'error_max_turns' : turnError === 'budget' ? 'error_max_budget_usd' : 'error_during_execution') : 'success',
    is_error: Boolean(error), result: error ?? text, errors: error ? [error] : [],
    total_cost_usd: totalCost, cost_unavailable: !price, num_turns: calls, usage });
  const fail = (error: Error) => { cancelWait(error); rejectTurn?.(error); events.end(error); };

  async function requestTool(msg: RpcMessage) {
    const p = msg.params;
    try {
      if (msg.method !== 'item/tool/call') {
        // Native permissions never grant access outside the office tool gate.
        if (msg.method?.includes('requestApproval')) rpc.send({ id: msg.id, result: { decision: 'decline' } });
        else rpc.send({ id: msg.id, error: { code: -32601, message: `Use the office tools: ${msg.method}` } });
        return;
      }
      const tool = catalog.tools.find(t => t.name === toolNames.get(p.tool));
      if (!tool) throw new Error(`Tool not assigned to this role: ${p.tool}`);
      if (abort.signal.aborted) throw new Error('Session stopped');
      calls++;
      if (options.maxTurns && calls > options.maxTurns) {
        turnError = 'maxTurns'; throw new Error('Reached maximum number of turns');
      }
      let input = p.arguments as Record<string, unknown>;
      assistant([{ type: 'tool_use', id: p.callId, name: tool.name, input }]);
      const permission = await options.canUseTool?.(tool.name, input, {
        signal: abort.signal, requestId: String(msg.id), toolUseID: p.callId, suggestions: [],
      });
      if (permission?.behavior === 'deny') throw new Error(permission.message);
      if (permission?.behavior === 'allow') input = permission.updatedInput ?? input;
      if (abort.signal.aborted) throw new Error('Session stopped');
      const output = await tool.run(input);
      rpc.send({ id: msg.id, result: { success: !output.isError,
        contentItems: (output.content ?? []).map((c: any) => c.type === 'image'
          ? { type: 'inputImage', imageUrl: `data:${c.mimeType};base64,${c.data}` }
          : { type: 'inputText', text: c.text ?? JSON.stringify(c) }) } });
      if (turnError && turn) await rpc.request('turn/interrupt', { threadId: thread, turnId: turn });
    } catch (e) {
      rpc.send({ id: msg.id, result: { success: false, contentItems: [{ type: 'inputText', text: String(e) }] } });
      if (turnError && turn) void rpc.request('turn/interrupt', { threadId: thread, turnId: turn }).catch(fail);
    }
  }

  function notification(msg: RpcMessage) {
    if (msg.id !== undefined && msg.method) { void requestTool(msg); return; }
    const p = msg.params ?? {};
    if (msg.method === 'account/rateLimits/updated') rateReport(p);
    if (p.threadId && thread && p.threadId !== thread) return;
    if (msg.method === 'turn/started') turn = p.turn.id;
    if (msg.method === 'item/agentMessage/delta') {
      emit({ type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p.delta } } });
    }
    if (msg.method === 'item/started' && p.item.type === 'webSearch') {
      assistant([{ type: 'tool_use', id: p.item.id, name: 'WebSearch', input: { query: p.item.query } }]);
    }
    if (msg.method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage.last;
      if (turnActive && p.tokenUsage.total.totalTokens !== lastTotalTokens) {
        usage = { input_tokens: Math.max(0, u.inputTokens - (u.cachedInputTokens ?? 0)),
          output_tokens: u.outputTokens, cache_read_input_tokens: u.cachedInputTokens ?? 0,
          cache_creation_input_tokens: u.cacheWriteInputTokens ?? 0 };
        if (price) {
          const next = tokenCost(price, usage.input_tokens, usage.cache_read_input_tokens, usage.output_tokens);
          budgetSpent += next - totalCost;
          totalCost = next;
        }
        if (options.maxBudgetUsd && budgetSpent >= options.maxBudgetUsd && !turnError) {
          turnError = 'budget';
          void rpc.request('turn/interrupt', { threadId: thread, turnId: turn }).catch(fail);
        }
      }
      lastTotalTokens = p.tokenUsage.total.totalTokens;
    }
    if (msg.method === 'item/completed') {
      if (p.item.type === 'agentMessage') {
        text += (text ? '\n' : '') + p.item.text;
        assistant([{ type: 'text', text: p.item.text }]);
      }
      if (p.item.type === 'reasoning') assistant([{ type: 'thinking', thinking: (p.item.summary ?? []).join('\n') }]);
      if (p.item.type === 'contextCompaction') {
        emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: {
          trigger: 'manual', pre_tokens: usage.input_tokens + usage.cache_read_input_tokens,
          post_tokens: usage.input_tokens + usage.cache_read_input_tokens,
        } });
        if (compacting) { compacting = false; result(); finish?.(); }
      }
    }
    if (msg.method === 'turn/completed') {
      const error = turnError === 'maxTurns' ? 'Reached maximum number of turns' : turnError === 'budget' ? 'Reached the USD budget'
        : turnError ?? (p.turn.status === 'completed' ? undefined
        : p.turn.error?.message ?? `Codex turn ${p.turn.status}`);
      result(error); turnActive = false; turn = ''; finish?.();
    }
    if (msg.method === 'error' && !p.willRetry) turnError = p.error?.message ?? 'Codex error';
  }

  const ready = (async () => {
    rpc = new CodexRpc(codexBinary(), options.cwd ?? process.cwd(), runtimeEnv());
    rpc.onMessage = notification; rpc.onError = fail;
    await rpc.request('initialize', { clientInfo: { name: 'ai-office', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized' });
    catalog = await codexTools(options, rpc);
    const system = (typeof options.systemPrompt === 'string' ? options.systemPrompt
      : Array.isArray(options.systemPrompt) ? options.systemPrompt.join('\n\n') : options.systemPrompt?.append ?? '')
      .replaceAll('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', '');
    const config: Record<string, unknown> = {
      'features.shell_tool': false, 'features.unified_exec': false, 'features.apply_patch_freeform': false,
      'features.multi_agent': false, 'features.apps': false, 'features.skills': false,
      'features.memories': false, 'project_doc_max_bytes': 0,
      web_search: Array.isArray(options.tools) && !options.tools.includes('WebSearch') ? 'disabled' : 'live',
    };
    const dynamicTools = catalog.tools.map(t => {
      const hash = createHash('sha256').update(t.name).digest('hex').slice(0, 12);
      const name = `office_${hash}_${t.name.replace(/[^a-zA-Z0-9_]/g, '_')}`.slice(0, 64);
      toolNames.set(name, t.name);
      return { type: 'function', name, description: `${t.name}: ${t.description}`, inputSchema: t.inputSchema };
    });
    const common = { model: options.model === 'default' ? null : options.model,
      cwd: options.cwd, approvalPolicy: 'never', sandbox: 'read-only', config,
      developerInstructions: system + '\nUse the tools supplied by AI Office for all actions. Each is subject to the office permission policy.' };
    const response = options.resume
      ? await rpc.request('thread/resume', { ...common, threadId: options.resume })
      : await rpc.request('thread/start', { ...common, dynamicTools });
    thread = response.thread.id;
    price = codexPrice(response.model ?? options.model ?? 'default');
    if (options.maxBudgetUsd && !price) throw new Error('Codex does not report USD cost. Configure OFFICE_CODEX_PRICING for this model before using a dollar budget.');
    emit({ type: 'system', subtype: 'init', cwd: options.cwd, model: response.model, apiKeySource: 'codex' });
  })();
  // Attach immediately; startup may fail before the iterator is consumed.
  void ready.catch(fail);
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const error = new Error('Codex session stopped');
    if (turn) void rpc?.request('turn/interrupt', { threadId: thread, turnId: turn }, 2000).finally(() => rpc?.close()).catch(() => {});
    else rpc?.close();
    fail(error);
  };
  abort.signal.addEventListener('abort', stop, { once: true });
  void (async () => {
    try {
      await ready;
      if (abort.signal.aborted) throw new Error('Codex session stopped');
      const input = typeof prompt === 'string' ? (async function* () { yield prompt; })()
        : (async function* () { for await (const m of prompt) yield typeof m.message.content === 'string'
          ? m.message.content : m.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'); })();
      const iterator = input[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled]);
        if (next.done) break;
        const message = next.value;
        text = ''; calls = 0; turnError = null; totalCost = 0; turnActive = true;
        usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        const done = new Promise<void>((resolve, reject) => { finish = resolve; rejectTurn = reject; });
        // Register the completion waiter before sending: a mock or short turn can finish immediately.
        void done.catch(() => {});
        if (message.startsWith('/compact')) {
          compacting = true; await rpc.request('thread/compact/start', { threadId: thread });
        } else {
          emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
          const response = await rpc.request('turn/start', { threadId: thread,
            input: [{ type: 'text', text: message, text_elements: [] }] });
          turn = response.turn.id;
        }
        await done; finish = null; rejectTurn = null;
      }
      events.end();
    } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
    finally { abort.signal.removeEventListener('abort', stop); await catalog?.close(); rpc?.close(); }
  })();
  return {
    provider: 'codex',
    async *[Symbol.asyncIterator]() {
      try { yield* events; } finally { stop(); }
    },
    mcpServerStatus: async () => { await ready; return catalog.statuses; },
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
      await ready;
      return rateReport(await rpc.request('account/rateLimits/read'));
    },
  };
}
