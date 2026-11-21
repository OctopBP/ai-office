import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

const root = mkdtempSync(resolve(tmpdir(), 'office-kimi-'));
const owner = resolve(root, 'owner');
const runtime = resolve(root, 'runtime');
const stateFile = resolve(root, 'account.json');
mkdirSync(resolve(owner, 'credentials'), { recursive: true });
process.env.KIMI_CODE_HOME = owner;
process.env.OFFICE_KIMI_CODE_HOME = runtime;
process.env.MOCK_KIMI_STATE = stateFile;

const account = (authenticated: boolean, primary = 0.3, secondary = 0.4) => writeFileSync(stateFile, JSON.stringify({
  authenticated, primary, secondary,
  resetAt: '2033-01-01T00:00:00.000Z', secondaryResetAt: '2033-02-01T00:00:00.000Z',
}));
account(true);

const mock = resolve(root, 'kimi-mock.cjs');
writeFileSync(mock, `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const readline = require('node:readline');
const file = process.env.MOCK_KIMI_STATE;
const home = process.env.OFFICE_KIMI_CODE_HOME;
const state = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = value => fs.writeFileSync(file, JSON.stringify(value));
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('kimi-code 2.6.3'); process.exit(0); }
if (args[0] === 'login') {
  fs.writeFileSync(file + '.login', JSON.stringify({args, home:process.env.KIMI_CODE_HOME}));
  console.error('Opening browser for Kimi device login: https://kimi.example/device?code=abc');
  setTimeout(() => { save({...state(), authenticated:true}); process.exit(0); }, 120);
} else if (args[0] === 'web') {
  if (args.includes('--json') || !args.includes('--no-open')) { console.error('invalid web args', args); process.exit(2); }
  const server = http.createServer((req,res) => {
    if (req.headers.authorization !== 'Bearer test-kap') { res.writeHead(401).end(); return; }
    const current = state();
    const body = value => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({code:0,data:value})); };
    if (req.url.startsWith('/api/v1/models')) return body({items:[
      {provider:'managed:kimi-code',model:'kimi-for-coding',display_name:'Kimi for Coding'},
      {provider:'managed:kimi-code',model:'kimi-k2-thinking',display_name:'Kimi K2 Thinking'},
      {provider:'other',model:'not-kimi',display_name:'Other'}
    ]});
    if (req.url.startsWith('/api/v1/oauth/usage')) {
      if (!current.authenticated) return body({kind:'error',status:401,message:'Authorization required'});
      return body({kind:'ok',quota:{usages:{
        limit5h:{usedRatio:current.primary,resetAt:current.resetAt},
        monthTotal:{usedRatio:current.secondary,resetAt:current.secondaryResetAt},
        monthCode:{usedRatio:0.99}
      },extraUsage:{balanceCents:99999}}});
    }
    if (req.url.startsWith('/api/v1/oauth/userinfo')) {
      if (!current.authenticated) return body({kind:'error',status:401,message:'Authorization required'});
      return body({kind:'ok',userInfo:{nickname:'Boris',userLevelName:'Pro'}});
    }
    res.writeHead(404).end();
  });
  server.listen(0,'127.0.0.1',() => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    console.log('  Local:    ' + origin + '/#token=test-kap');
  });
  process.on('SIGTERM',() => { server.close(); process.exit(0); });
} else if (args[0] === 'acp') {
  const send = message => process.stdout.write(JSON.stringify(message)+'\\n');
  const reply = (id,result) => send({id,result});
  const update = (sessionId,value) => send({method:'session/update',params:{sessionId,update:value}});
  let sessionId = 'kimi-session', bridge, promptId = null, model = 'default';
  const persist = (name,value) => fs.writeFileSync(home+'/'+name+'.json',JSON.stringify(value));
  const complete = (text='hello') => {
    if (promptId === null) return;
    update(sessionId,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'thinking'}});
    update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:text.slice(0,2)}});
    update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:text.slice(2)}});
    update(sessionId,{sessionUpdate:'usage_update',used:1234,size:200000,tokenUsage:{input_other:80,input_cache_read:20,input_cache_creation:5,output:50}});
    reply(promptId,{stopReason:'end_turn'}); promptId = null;
  };
  const mcp = async (method,params,id) => {
    const headers = {authorization:bridge.headers[0].value,'content-type':'application/json',accept:'application/json, text/event-stream'};
    const response = await fetch(bridge.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(id === undefined ? {} : {id}),method,...(params ? {params} : {})})});
    if (!response.ok) throw new Error('MCP HTTP '+response.status);
    const text = await response.text(); return text ? JSON.parse(text) : {};
  };
  const tool = async (twice = false) => {
    await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'kimi-mock',version:'1'}},500);
    await mcp('notifications/initialized');
    const listed = await mcp('tools/list',{},501);
    const name = listed.result.tools.find(tool => tool.name === 'office__say')?.name || listed.result.tools[0].name;
    const called = await mcp('tools/call',{name,arguments:{text:'hello'}},502);
    persist('mcp-result',called.result);
    if (twice) await mcp('tools/call',{name,arguments:{text:'hello again'}},503);
    complete(called.result.isError ? 'tool denied' : 'tool allowed');
  };
  readline.createInterface({input:process.stdin}).on('line',line => {
    const message = JSON.parse(line); const id = message.id; const method = message.method;
    if (method === 'initialize') return reply(id,{protocolVersion:1,capabilities:{}});
    if (method === 'session/new') {
      sessionId = 'kimi-session'; bridge = message.params.mcpServers[0];
      persist('session-new',message.params); return reply(id,{sessionId});
    }
    if (method === 'session/resume') {
      sessionId = message.params.sessionId; bridge = message.params.mcpServers[0];
      persist('session-resume',message.params); return reply(id,{});
    }
    if (method === 'session/set_config_option') {
      model = message.params.value; persist('model',model); return reply(id,{});
    }
    if (method === 'session/prompt') {
      promptId = id; const text = message.params.prompt[0].text;
      persist('last-prompt',{text,model});
      if (text.includes('hang')) return;
      if (text.includes('crash')) process.exit(17);
      if (text.includes('native-permission')) { send({id:900,method:'session/request_permission',params:{sessionId}}); return; }
      if (text.includes('tool')) return void tool(text.includes('tool-twice')).catch(error => { persist('mock-error',String(error)); complete('tool failed'); });
      if (text.startsWith('/compact')) { update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Compacted'}}); }
      return complete(text.startsWith('/compact') ? 'compacted' : 'hello');
    }
    if (id === 900) { persist('permission',message.result); return complete('native denied'); }
    if (method === 'session/cancel') {
      if (promptId !== null) { reply(promptId,{stopReason:'cancelled'}); promptId = null; }
      return;
    }
    if (method === 'logout') { save({...state(),authenticated:false}); return reply(id,{}); }
    if (id !== undefined) reply(id,{});
  });
} else { console.error('unknown args',args); process.exit(2); }
`, { mode: 0o755 });
process.env.OFFICE_KIMI_CODE_PATH = mock;

const { engineFor, startSession, tool, createSdkMcpServer, LoginError } = await import('../src/server/engines');
const { sessionForProvider } = await import('../src/shared/providers');
const { MessageQueue } = await import('../src/server/queue');
const { forgetLimits, limitsView, pollLimits } = await import('../src/server/limits');
const { officeConfig, runtimeEnv, usageReport } = await import('../src/server/providers/kimi-code');

const engine = engineFor('kimi-code');
assert.equal(engine.id, 'kimi-code');
assert.equal(engine.capabilities().apiKeyLogin, false);
assert.equal(engine.capabilities().subscriptionLogin, true);
assert.equal(engine.capabilities().planLimits, true);
assert.equal(sessionForProvider('kimi-code:kimi-session', 'kimi-code'), 'kimi-session');
assert.equal(sessionForProvider('codex:kimi-session', 'kimi-code'), undefined);

// Конфиг владельца сохраняется, а любая прежняя [tools] заменяется одним whitelist.
const ownerConfig = 'default_model = "kimi-for-coding"\n\n[tools]\nwhitelist = ["*"]\n\n[providers.managed]\ntype = "kimi"\n';
writeFileSync(resolve(owner, 'config.toml'), ownerConfig);
const isolated = runtimeEnv();
assert.equal(isolated.KIMI_CODE_HOME, runtime);
assert.equal(isolated.ELECTRON_RUN_AS_NODE, '1');
assert.equal(readFileSync(resolve(owner, 'config.toml'), 'utf8'), ownerConfig);
const generated = readFileSync(resolve(runtime, 'config.toml'), 'utf8');
assert.equal((generated.match(/\[tools\]/g) ?? []).length, 1);
assert(generated.includes('whitelist = ["mcp__office__*"]'));
assert(!generated.includes('whitelist = ["*"]'));
assert(generated.includes('[providers.managed]'));
assert.equal(officeConfig('[tools]\nwhitelist = ["Bash"]'), '[tools]\nwhitelist = ["mcp__office__*"]\n');

// Статусы: нет движка → нужен OAuth → готов → исчерпан лимит.
const savedPath = process.env.OFFICE_KIMI_CODE_PATH;
process.env.OFFICE_KIMI_CODE_PATH = resolve(root, 'missing-kimi');
assert.equal((await engine.status('kimi-code', { force: true })).state, 'not-installed');
process.env.OFFICE_KIMI_CODE_PATH = savedPath;
account(false);
assert.equal((await engine.status('kimi-code', { force: true })).state, 'needs-login');
account(true);
assert.deepEqual(await engine.status('kimi-code', { force: true }), { state: 'ready', auth: 'subscription', account: 'Boris', plan: 'Pro' });
assert.deepEqual(await engine.models('kimi-code'), [
  { id: 'kimi-for-coding', label: 'Kimi for Coding' }, { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking' },
]);
account(true, 1, 0.4);
assert.deepEqual(await engine.status('kimi-code', { force: true }),
  { state: 'limited', kind: 'plan', resetsAt: Date.parse('2033-01-01T00:00:00.000Z') });
account(true);
forgetLimits();
await engine.status('kimi-code', { force: true });

let called = 0;
const mcpServer = () => createSdkMcpServer({ name: 'office', tools: [tool('say', 'Speak', { text: z.string() }, async () => {
  called++; return { content: [{ type: 'text', text: 'ok' }] };
})] });
const options = () => ({ provider: 'kimi-code' as const, model: 'kimi-k2-thinking', cwd: root,
  systemPrompt: 'ROLE BRIEF', tools: [], mcpServers: { office: mcpServer() } });
const collect = async (session: ReturnType<typeof startSession>) => {
  const events = []; for await (const event of session) events.push(event); return events;
};

const successful = await collect(startSession({ prompt: 'tool', options: {
  ...options(), canUseTool: async (_, input) => ({ behavior: 'allow', updatedInput: input }),
} }));
assert.equal(called, 1);
assert(successful.some((event) => event.type === 'system' && event.session_id === 'kimi-code:kimi-session'));
assert(successful.some((event) => event.type === 'assistant' && JSON.stringify(event).includes('thinking')));
assert(successful.some((event) => event.type === 'result' && 'result' in event && event.result === 'tool allowed'));
const successResult = successful.find((event) => event.type === 'result')!;
assert.equal(successResult.type === 'result' && successResult.usage.input_tokens, 80);
assert.equal(successResult.type === 'result' && successResult.usage.cache_read_input_tokens, 20);
assert.equal(successResult.type === 'result' && 'cost_unavailable' in successResult && successResult.cost_unavailable, true);
assert.equal(readFileSync(resolve(runtime, 'model.json'), 'utf8'), '"kimi-k2-thinking"');
assert(readFileSync(resolve(runtime, 'last-prompt.json'), 'utf8').includes('ROLE BRIEF'));
const created = JSON.parse(readFileSync(resolve(runtime, 'session-new.json'), 'utf8'));
assert.equal(created.mcpServers[0].type, 'http');
assert.equal(created.mcpServers[0].headers[0].name, 'Authorization');

const denied = await collect(startSession({ prompt: 'tool', options: {
  ...options(), canUseTool: async () => ({ behavior: 'deny', message: 'No' }),
} }));
assert.equal(called, 1);
assert(denied.some((event) => event.type === 'result' && 'result' in event && event.result === 'tool denied'));
assert.equal(JSON.parse(readFileSync(resolve(runtime, 'mcp-result.json'), 'utf8')).isError, true);

const resumed = await collect(startSession({ prompt: 'hello', options: { ...options(), resume: 'kimi-code:kimi-session' } }));
assert(resumed.some((event) => event.type === 'result' && event.subtype === 'success'));
assert.equal(JSON.parse(readFileSync(resolve(runtime, 'session-resume.json'), 'utf8')).sessionId, 'kimi-session');

const native = await collect(startSession({ prompt: 'native-permission', options: options() }));
assert(native.some((event) => event.type === 'result' && 'result' in event && event.result === 'native denied'));
assert.deepEqual(JSON.parse(readFileSync(resolve(runtime, 'permission.json'), 'utf8')), { outcome: { outcome: 'cancelled' } });

const queue = new MessageQueue(); queue.push('one'); queue.push('/compact'); queue.push('two');
const live = startSession({ prompt: queue, options: options() });
await pollLimits(live);
queue.close();
const queued = await collect(live);
assert.equal(queued.filter((event) => event.type === 'result').length, 3);
assert(queued.some((event) => event.type === 'system' && event.subtype === 'compact_boundary'));
const windows = limitsView('kimi-code').windows;
assert.equal(windows.find((window) => window.kind === 'kimi_primary')?.utilization, 30);
assert.equal(windows.find((window) => window.kind === 'kimi_secondary')?.utilization, 40);
assert.equal(windows.length, 2, 'monthCode и extraUsage не выдаются за окна лимита');
assert.equal(usageReport({ kind: 'ok', quota: { usages: {} } }).rate_limits_available, true);

const abort = new AbortController();
const hung = collect(startSession({ prompt: 'hang', options: { ...options(), abortController: abort } }));
setTimeout(() => abort.abort(), 120);
await assert.rejects(hung, /stopped/);
await assert.rejects(collect(startSession({ prompt: 'crash', options: options() })), /exited/);
await assert.rejects(collect(startSession({ prompt: 'hello', options: { ...options(), maxBudgetUsd: 1 } })), /USD cost/);
const limitedTurns = await collect(startSession({ prompt: 'tool-twice', options: {
  ...options(), maxTurns: 1,
  canUseTool: async (_, input) => ({ behavior: 'allow', updatedInput: input }),
} }));
assert(limitedTurns.some((event) => event.type === 'result' && event.subtype === 'error_max_turns'));
await assert.rejects(engine.login({ provider: 'kimi-code', kind: 'api-key', apiKey: 'not-supported' }),
  (error: unknown) => error instanceof LoginError && error.code === 'unsupported');

// Штатный device login и ACP logout работают с owner home; офис токен не читает.
const { onLoginFlow } = await import('../src/server/engines/login');
account(false);
const waiting = new Promise<import('../src/shared/types').ProviderLoginFlow>((done) => {
  const off = onLoginFlow((provider, flow) => {
    if (provider === 'kimi-code' && flow.phase === 'waiting') { off(); done(flow); }
  });
});
const started = await engine.login({ provider: 'kimi-code', kind: 'subscription' });
assert.equal(started.done, false);
const page = await waiting;
assert.equal(page.interaction?.url, 'https://kimi.example/device?code=abc');
await new Promise<void>((done) => {
  const off = onLoginFlow((provider, flow) => {
    if (provider === 'kimi-code' && flow.phase === 'succeeded') { off(); done(); }
  });
});
assert.equal(JSON.parse(readFileSync(`${stateFile}.login`, 'utf8')).home, owner);
assert.equal(state().authenticated, true);
function state(): any { return JSON.parse(readFileSync(stateFile, 'utf8')); }
await engine.logout('kimi-code');
assert.equal(state().authenticated, false);
account(true);

// Пакеты с внешними runtime-зависимостями после распаковки действительно запускаются.
const dependency = resolve(root, 'local-dependency');
const npmApp = resolve(root, 'npm-app');
mkdirSync(dependency, { recursive: true });
mkdirSync(npmApp, { recursive: true });
writeFileSync(resolve(dependency, 'package.json'), JSON.stringify({ name: 'office-test-dependency', version: '1.0.0', main: 'index.js' }));
writeFileSync(resolve(dependency, 'index.js'), 'module.exports = "installed";');
const npmManifest = JSON.stringify({
  name: 'office-test-install', version: '1.0.0', private: true,
  dependencies: { 'office-test-dependency': 'file:../local-dependency' },
  devDependencies: { 'office-test-missing': 'file:../must-not-be-resolved' },
});
writeFileSync(resolve(npmApp, 'package.json'), npmManifest);
const { installNpmDependencies } = await import('../src/server/engines/install');
await installNpmDependencies(npmApp, new AbortController().signal);
assert.equal(readFileSync(resolve(npmApp, 'node_modules/office-test-dependency/index.js'), 'utf8'), 'module.exports = "installed";');
assert.equal(readFileSync(resolve(npmApp, 'package.json'), 'utf8'), npmManifest);

rmSync(root, { recursive: true, force: true });
console.log('Kimi Code tests passed: OAuth, models, quotas, ACP, MCP permissions, resume, queue, cancellation, config isolation and npm dependencies.');
