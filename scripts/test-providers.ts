import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

const root = mkdtempSync(resolve(tmpdir(), 'office-providers-'));
process.env.OFFICE_STATE_FILE = resolve(root, 'state.json');
process.env.OFFICE_CODEX_HOME = resolve(root, 'codex');
process.env.CODEX_HOME = resolve(root, 'no-owner-auth');
// Связка ключей — в памяти, движки — во временной папке: тест не трогает
// Keychain и установки владельца.
process.env.OFFICE_KEYCHAIN = 'memory';
process.env.OFFICE_ENGINE_DIR = resolve(root, 'engines');
// Вход в Claude Code по подписке — признаком в своей папке настроек.
process.env.CLAUDE_CONFIG_DIR = resolve(root, 'claude');
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
mkdirSync(process.env.CLAUDE_CONFIG_DIR);
writeFileSync(resolve(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
const fake = resolve(root, 'codex-mock.cjs');
writeFileSync(fake, `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
const reply = (m,result) => send({id:m.id,result});
let thread='test-thread', tools=[], active=0, mode='', total=0;
const complete = (status='completed', result='done') => {
  total += 150;
  send({method:'thread/tokenUsage/updated',params:{threadId:thread,tokenUsage:{total:{totalTokens:total},last:{inputTokens:100,cachedInputTokens:20,outputTokens:50}}}});
  send({method:'item/agentMessage/delta',params:{threadId:thread,delta:result}});
  send({method:'item/completed',params:{threadId:thread,item:{type:'agentMessage',text:result}}});
  send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+active,status}}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize') return reply(m,{});
  if(m.method==='thread/start') { tools=m.params.dynamicTools; fs.writeFileSync(process.env.OFFICE_CODEX_HOME+'/tools.json',JSON.stringify(tools)); return reply(m,{thread:{id:thread},model:'test-model'}); }
  if(m.method==='thread/resume') { thread=m.params.threadId; tools=JSON.parse(fs.readFileSync(process.env.OFFICE_CODEX_HOME+'/tools.json')); return reply(m,{thread:{id:thread},model:'test-model'}); }
  if(m.method==='turn/start') {
    active++; mode=m.params.input[0].text; reply(m,{turn:{id:'turn-'+active}});
    send({method:'turn/started',params:{threadId:thread,turn:{id:'turn-'+active}}});
    if(mode==='hang') return;
    if(mode==='crash') return process.exit(17);
    if(mode==='tool') return send({id:900,method:'item/tool/call',params:{threadId:thread,turnId:'turn-'+active,callId:'call',tool:tools[0].name,arguments:{text:'hello'}}});
    return complete();
  }
  if(m.id===900) return complete('completed',m.result.success ? 'tool allowed' : 'tool denied');
  if(m.method==='turn/interrupt') {reply(m,{}); return complete('interrupted');}
  if(m.method==='thread/compact/start') {reply(m,{}); return send({method:'item/completed',params:{threadId:thread,item:{type:'contextCompaction'}}});}
  if(m.method==='account/read') return reply(m,{account:{type:'chatgpt'}});
  if(m.method==='model/list') return reply(m,{data:[{model:'test-model',displayName:'Test model'}],nextCursor:null});
  if(m.method==='account/rateLimits/read') return reply(m,{rateLimits:{planType:'plus',primary:{usedPercent:0.5,resetsAt:2000000000},secondary:{usedPercent:90,resetsAt:2000000000}}});
});
`, { mode: 0o755 });
process.env.OFFICE_CODEX_PATH = fake;
const { startSession: query, tool, createSdkMcpServer, engineFor, LoginError } = await import('../src/server/engines');
const { providerOf, sessionForProvider } = await import('../src/shared/providers');
const { MessageQueue } = await import('../src/server/queue');
const { createLimitTracker, pollLimits, limitsView, noteRateLimit, forgetLimits } = await import('../src/server/limits');
const { readablePath, writablePath } = await import('../src/server/providers/codex-tools');
const { scaffoldPackage } = await import('../src/server/export');
const { readPackage } = await import('../src/server/packages');
const { roleFromPackage, roleRuntime } = await import('../src/server/roles');
type Role = import('../src/server/roles').Role;

assert.equal(providerOf(), 'claude-code');
assert.equal(sessionForProvider('claude-session', 'codex'), undefined);
assert.equal(sessionForProvider('codex:abc', 'claude-code'), undefined);
assert.equal(sessionForProvider('codex:abc', 'codex'), 'abc');
let called = 0;
const server = () => createSdkMcpServer({ name: 'team', tools: [tool('say', 'Speak', { text: z.string() }, async () => {
  called++; return { content: [{ type: 'text', text: 'ok' }] };
})] });
const options = () => ({ provider: 'codex' as const, model: 'default', cwd: root, tools: [], mcpServers: { team: server() } });
const collect = async (session: ReturnType<typeof query>) => { const events=[]; for await (const event of session) events.push(event); return events; };
const successful = await collect(query({ prompt: 'tool', options: { ...options(), canUseTool: async (_, input) => ({ behavior: 'allow', updatedInput: input }) } }));
assert.equal(called, 1);
assert(successful.some(m => m.type === 'system' && m.session_id === 'codex:test-thread'));
const result = successful.find(m => m.type === 'result')!;
assert.equal(result.type === 'result' && result.usage.input_tokens, 80);
assert.equal(result.type === 'result' && result.usage.cache_read_input_tokens, 20);
const denied = await collect(query({ prompt: 'tool', options: { ...options(), canUseTool: async () => ({ behavior: 'deny', message: 'No' }) } }));
assert.equal(called, 1);
assert(denied.some(m => m.type === 'result' && 'result' in m && m.result === 'tool denied'));
const resumed = await collect(query({ prompt: 'tool', options: { ...options(), resume: 'codex:test-thread' } }));
assert(resumed.some(m => m.type === 'result' && m.subtype === 'success'));

const queue = new MessageQueue(); queue.push('one'); queue.push('/compact'); queue.push('two'); queue.close();
const queued = await collect(query({ prompt: queue, options: options() }));
assert.equal(queued.filter(m => m.type === 'result').length, 3);
assert(queued.some(m => m.type === 'system' && m.subtype === 'compact_boundary'));

const abort = new AbortController();
const hung = collect(query({ prompt: 'hang', options: { ...options(), abortController: abort } }));
setTimeout(() => abort.abort(), 100);
await assert.rejects(hung, /stopped/);
await assert.rejects(collect(query({ prompt: 'crash', options: options() })), /exited/);
await assert.rejects(collect(query({ prompt: 'no', options: { ...options(), maxBudgetUsd: 1 } })), /PRICING/);
process.env.OFFICE_CODEX_PRICING = JSON.stringify({ 'test-model': { input: 2, cachedInput: 1, output: 4 } });
const priced = await collect(query({ prompt: 'cost', options: options() }));
assert.equal(priced.find(m => m.type === 'result')?.total_cost_usd, 0.00038);
delete process.env.OFFICE_CODEX_PRICING;

const claude = createLimitTracker('claude-code'), codex = createLimitTracker('codex');
claude.forgetLimits(); codex.forgetLimits();
claude.noteRateLimit({status:'rejected'});
assert(claude.limitBlock()); assert.equal(codex.limitBlock(), null);
const q = new MessageQueue();
const session = query({ prompt: q, options: options() });
await pollLimits(session); q.close(); await collect(session);
assert.equal(limitsView('codex').windows.find(w => w.kind === 'codex_primary')?.utilization, 0.5);

// Адаптеры движков: статус, модели и матрица — без платного хода.
assert.equal(engineFor('claude-code').id, 'claude-code'); assert.equal(engineFor('codex').id, 'codex');
assert.equal(engineFor('codex').capabilities('linux').officeTools, 'dynamic-tools');
assert.equal(engineFor('codex').capabilities('win32').sandbox, false);
assert.equal(engineFor('claude-code').capabilities('darwin').cloud, true);
noteRateLimit({ status: 'rejected', resetsAt: 2000000000 });
assert.deepEqual(await engineFor('claude-code').status('claude-code'), { state: 'limited', kind: 'plan', resetsAt: 2000000000000 });
forgetLimits();
assert.equal((await engineFor('claude-code').status('claude-code')).state, 'ready');
assert((await engineFor('claude-code').models('claude-code')).some(m => m.tier === 'top'));
assert.equal((await engineFor('codex').status('codex', { force: true })).state, 'ready');
assert.deepEqual(await engineFor('codex').models('codex'), [{ id: 'test-model', label: 'Test model' }]);

// Проверка окружения provider:<id> строится только из статуса адаптера (spec §5.3).
{
  const { providerCheck } = await import('../src/server/envcheck');
  // Офис на Claude, менеджер на провайдере офиса (или на `pm`), исполнитель на
  // Codex. Критичность провайдера envcheck считает по менеджеру через
  // activeRoles/runtimeOf — заглушка отвечает так же, как OfficeState.
  const fakeState = (engine: 'local' | 'cloud', pm?: 'claude-code' | 'codex') => {
    const roles = [
      { id: 'pm', title: 'PM', isManager: true, provider: pm },
      { id: 'dev', title: 'Dev', isManager: false, provider: 'codex' },
    ] as unknown as Role[];
    const model = { provider: 'claude-code' as const, model: 'default' };
    return {
      settings: { engine, model },
      activeRoles: () => roles,
      workerRoles: () => roles.filter((r) => !r.isManager),
      runtimeOf: (role: Role) => roleRuntime(role, model),
      say: (key: string) => key,
    } as unknown as Parameters<typeof providerCheck>[0];
  };
  const codexOk = await providerCheck(fakeState('local'), 'codex');
  assert.deepEqual([codexOk.id, codexOk.status, codexOk.critical], ['provider:codex', 'ok', false]);
  assert.equal((await providerCheck(fakeState('local', 'codex'), 'codex')).critical, true);
  assert.equal((await providerCheck(fakeState('local'), 'claude-code')).critical, true);
  assert.equal((await providerCheck(fakeState('local', 'codex'), 'claude-code')).critical, false);
  noteRateLimit({ status: 'rejected', resetsAt: 2000000000 });
  const limited = await providerCheck(fakeState('local'), 'claude-code');
  assert.deepEqual([limited.id, limited.status, limited.detail], ['provider:claude-code', 'ok', 'env.provider.limited']);
  forgetLimits();
  const keyBefore = process.env.ANTHROPIC_API_KEY; const tokenBefore = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  assert.equal((await providerCheck(fakeState('local'), 'claude-code')).detail, 'env.key.subscription');
  const cloud = await providerCheck(fakeState('cloud'), 'claude-code');
  assert.deepEqual([cloud.status, cloud.critical, cloud.fix], ['fail', true, 'cloud.needApiKey']);
  if (keyBefore !== undefined) process.env.ANTHROPIC_API_KEY = keyBefore;
  if (tokenBefore !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = tokenBefore;
  // Приложение без движка: чужие установки в домашней папке и PATH не в счёт.
  const saved = { app: process.env.OFFICE_APP, bin: process.env.OFFICE_CLAUDE_BIN, home: process.env.HOME, path: process.env.PATH };
  process.env.OFFICE_APP = '1'; delete process.env.OFFICE_CLAUDE_BIN;
  process.env.HOME = resolve(root, 'home'); process.env.PATH = resolve(root, 'no-bin');
  const engine = engineFor('claude-code');
  assert.deepEqual(await engine.status('claude-code', { force: true }), { state: 'not-installed', engine: 'claude-code', sizeMb: 95 });
  const noEngine = await providerCheck(fakeState('local'), 'claude-code');
  assert.deepEqual([noEngine.status, noEngine.fix], ['fail', 'env.engine.noneFix']);
  // Своя установка в папке движков находится без перезапуска.
  if (process.platform !== 'win32') {
    const { sdkVersion } = await import('../src/server/engines/claude-code');
    const own = resolve(root, 'engines', 'claude-code', sdkVersion());
    mkdirSync(own, { recursive: true });
    writeFileSync(resolve(own, 'claude'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
    assert.equal((await engine.status('claude-code', { force: true })).state, 'ready');
  }
  if (saved.app === undefined) delete process.env.OFFICE_APP; else process.env.OFFICE_APP = saved.app;
  if (saved.bin !== undefined) process.env.OFFICE_CLAUDE_BIN = saved.bin;
  process.env.HOME = saved.home; process.env.PATH = saved.path;
  await engine.status('claude-code', { force: true });
}

// Вход по ключу: ключ в связке, а не в окружении; без ключа и подписки — нужен вход.
{
  const { saveKey, deleteKey, providerKey } = await import('../src/server/engines/keys');
  const { providersView, loginProvider } = await import('../src/server/providers-api');
  const keyBefore = process.env.ANTHROPIC_API_KEY; const tokenBefore = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  const engine = engineFor('claude-code');
  await saveKey('claude-code', 'sk-ant-test-1234');
  assert.deepEqual(providerKey('claude-code'), { key: 'sk-ant-test-1234', source: 'keychain' });
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  const { engineEnv, projectEnv } = await import('../src/server/childenv');
  assert.equal(engineEnv().ANTHROPIC_API_KEY, 'sk-ant-test-1234');
  assert.equal(projectEnv().ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(await engine.status('claude-code', { force: true }), { state: 'ready', auth: 'api-key' });
  const view = await providersView();
  assert.deepEqual(view.providers.find((p) => p.id === 'claude-code')?.key, { tail: '1234', source: 'keychain' });
  assert.equal(view.noneReady, false);
  await deleteKey('claude-code');
  assert.equal(providerKey('claude-code'), null);
  assert.equal(engineEnv().ANTHROPIC_API_KEY, undefined);
  assert.deepEqual((await loginProvider('claude-code', 'two words')), { ok: false, code: 'rejected', message: 'empty or malformed key' });
  rmSync(resolve(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'));
  assert.deepEqual(await engine.status('claude-code', { force: true }), { state: 'needs-login', auth: ['api-key', 'subscription'] });
  writeFileSync(resolve(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), '{}');
  await engine.status('claude-code', { force: true });
  if (keyBefore !== undefined) process.env.ANTHROPIC_API_KEY = keyBefore;
  if (tokenBefore !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = tokenBefore;
}

// Вход по подписке: штатная команда движка, адрес страницы — в веб, итог — в статус.
if (process.platform !== 'win32') {
  const { onLoginFlow, loginUrl } = await import('../src/server/engines/login');
  const { loginBySubscription } = await import('../src/server/providers-api');
  const { forgetClaudeBin } = await import('../src/server/engines/claude-code');
  const engine = engineFor('claude-code');
  const credentials = resolve(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json');
  rmSync(credentials);
  assert.equal((await engine.status('claude-code', { force: true })).state, 'needs-login');

  // Поддельный `claude auth login`: адрес гиперссылкой терминала, как печатает
  // настоящий, потом ждёт код со страницы и «входит» — пишет учётные данные.
  const fakeLogin = resolve(root, 'claude-login.sh');
  const argsFile = resolve(root, 'claude-login.args');
  writeFileSync(fakeLogin, `#!/bin/bash
echo "$@" > '${argsFile}'
printf 'Opening browser to sign in…\\n'
printf "If the browser didn't open, visit: \\033]8;;https://claude.ai/oauth/authorize?code=true&state=s1\\007https://claude.ai/oauth/authorize?code=true&state=s1\\033]8;;\\007\\n"
printf 'Paste code here if prompted > '
read code
[ "$code" = "abc#s1" ] || { echo "Invalid code" >&2; exit 1; }
echo '{}' > '${credentials}'
echo 'Login successful.'
`, { mode: 0o755 });
  const savedBin = process.env.OFFICE_CLAUDE_BIN;
  process.env.OFFICE_CLAUDE_BIN = fakeLogin;
  forgetClaudeBin();

  const phases: string[] = [];
  const waitPhase = (provider: string, phase: string) => new Promise<import('../src/shared/types').ProviderLoginFlow>((done) => {
    const off = onLoginFlow((p, flow) => { if (p === provider) phases.push(flow.phase); if (p === provider && flow.phase === phase) { off(); done(flow); } });
  });
  const waiting = waitPhase('claude-code', 'waiting');
  const started = await loginBySubscription('claude-code');
  assert(started.ok);
  // Повтор во время входа второй процесс не запускает.
  const again = await loginBySubscription('claude-code');
  assert(again.ok && again.flow.flowId === started.flow.flowId);
  const page = await waiting;
  assert.deepEqual(page.interaction, { kind: 'browser', url: 'https://claude.ai/oauth/authorize?code=true&state=s1', code: true });
  assert.equal(readFileSync(argsFile, 'utf8').trim(), 'auth login --claudeai');
  const { sendLoginCode } = await import('../src/server/engines/login');
  const succeeded = waitPhase('claude-code', 'succeeded');
  assert.equal(sendLoginCode('claude-code', 'abc#s1'), true);
  await succeeded;
  assert.deepEqual(phases, ['starting', 'waiting', 'succeeded']);
  assert.deepEqual(await engine.status('claude-code'), { state: 'ready', auth: 'subscription' });

  // Отмена: команда останавливается, фаза cancelled, статус остаётся «нужен вход».
  rmSync(credentials);
  await engine.status('claude-code', { force: true });
  process.env.OFFICE_CLAUDE_BIN = savedBin ?? '';
  if (savedBin === undefined) delete process.env.OFFICE_CLAUDE_BIN;
  forgetClaudeBin();
  const fakeCodex = resolve(root, 'codex-login.sh');
  writeFileSync(fakeCodex, `#!/bin/bash
echo "Starting local login server on http://localhost:1455."
echo "If your browser did not open, navigate to this URL to authenticate:"
echo
echo "https://auth.openai.com/oauth/authorize?response_type=code&state=x"
sleep 30
`, { mode: 0o755 });
  const savedCodex = process.env.OFFICE_CODEX_PATH;
  process.env.OFFICE_CODEX_PATH = fakeCodex;
  const codexWaiting = waitPhase('codex', 'waiting');
  const codexStarted = await loginBySubscription('codex');
  assert(codexStarted.ok);
  assert.deepEqual((await codexWaiting).interaction,
    { kind: 'browser', url: 'https://auth.openai.com/oauth/authorize?response_type=code&state=x', code: false });
  assert.equal(sendLoginCode('codex', 'abc'), false);
  const cancelled = waitPhase('codex', 'cancelled');
  const { cancelCliLogin } = await import('../src/server/engines/login');
  assert.equal(cancelCliLogin('codex'), true);
  await cancelled;
  process.env.OFFICE_CODEX_PATH = savedCodex;

  // Провал: последние строки вывода — причиной.
  const fakeFail = resolve(root, 'claude-fail.sh');
  writeFileSync(fakeFail, '#!/bin/bash\necho "Login failed: org not allowed" >&2\nexit 1\n', { mode: 0o755 });
  process.env.OFFICE_CLAUDE_BIN = fakeFail; forgetClaudeBin();
  const failed = waitPhase('claude-code', 'failed');
  await loginBySubscription('claude-code');
  assert.equal((await failed).error, 'Login failed: org not allowed');
  if (savedBin === undefined) delete process.env.OFFICE_CLAUDE_BIN; else process.env.OFFICE_CLAUDE_BIN = savedBin;
  forgetClaudeBin();
  assert.equal(loginUrl('see http://localhost:1455 then https://x.example/a?b=c.'), 'https://x.example/a?b=c');

  writeFileSync(credentials, '{}');
  await engine.status('claude-code', { force: true });
}

mkdirSync(resolve(root, 'workspace')); mkdirSync(resolve(root, 'outside'));
symlinkSync(resolve(root, 'outside'), resolve(root, 'workspace/escape'));
await assert.rejects(writablePath(resolve(root,'workspace'), 'escape/file.txt'), /outside/);
await assert.rejects(writablePath(resolve(root,'workspace'), '../file.txt'), /outside/);
writeFileSync(resolve(root, 'outside/secret.txt'), 'secret');
await assert.rejects(readablePath([resolve(root, 'workspace')], resolve(root, 'workspace'), '../outside/secret.txt'), /outside/);
assert((await readablePath([resolve(root, 'workspace'), resolve(root, 'outside')], resolve(root, 'workspace'), '../outside/secret.txt'))
  .endsWith('/outside/secret.txt'));
const pkgDir = resolve(root, 'package');
scaffoldPackage(pkgDir, { name: '@test/codex', title: {en:'Codex worker'}, runtime: {engine:'codex'} });
const pkg = readPackage(pkgDir);
assert(pkg.pkg);
const role = roleFromPackage(pkg.pkg!, 'en', 'codex');
assert.equal(role.provider, 'codex'); assert.equal(role.model, 'default');
// Универсальный движок OpenCode: пресеты, адрес, конфиг сессии, события, цены — без сети и без сервера.
{
  const { normalizeBaseUrl, baseUrlOf } = await import('../src/server/engines/endpoints');
  const { buildConfig, parseSse, stepUsage } = await import('../src/server/providers/opencode');
  const { wireName } = await import('../src/server/providers/mcp-bridge');
  const { modelPrice } = await import('../src/server/providers/model-prices');
  const { sessionForProvider, engineOf, PROVIDERS: ALL } = await import('../src/shared/providers');

  for (const id of ['xai', 'deepseek', 'openrouter', 'ollama', 'custom'] as const) {
    assert.equal(engineOf(id), 'opencode'); assert.equal(engineFor(id).id, 'opencode');
  }
  assert.equal(baseUrlOf('xai'), ALL.xai.baseUrl); assert.equal(baseUrlOf('custom'), '');
  assert.equal(normalizeBaseUrl('http://localhost:11434/', 'ollama'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('https://llm.example.com/api/v1/', 'custom'), 'https://llm.example.com/api/v1');
  assert.equal(normalizeBaseUrl('https://user:pw@llm.example.com/v1', 'custom'), null);
  assert.equal(normalizeBaseUrl('file:///etc/passwd', 'custom'), null);

  // Сессии движков не путаются, а между провайдерами OpenCode переносятся.
  assert.equal(sessionForProvider('opencode:ses_1', 'deepseek'), 'ses_1');
  assert.equal(sessionForProvider('opencode:ses_1', 'claude-code'), undefined);
  assert.equal(sessionForProvider('codex:t1', 'xai'), undefined);
  assert.equal(sessionForProvider('plain-claude', 'ollama'), undefined);

  const config = buildConfig({
    provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', keyVar: 'XAI_API_KEY', contextWindow: 256_000,
    system: 'ROLE PROMPT', bridge: { url: 'http://127.0.0.1:5/mcp', authorization: 'Bearer t' },
  }) as any;
  const text = JSON.stringify(config);
  assert(text.includes('{env:XAI_API_KEY}'), 'ключ — ссылкой на переменную окружения');
  assert.equal(config.model, 'office/grok-4.7');
  assert.equal(config.agent.office.prompt, 'ROLE PROMPT');
  assert.equal(config.tools.bash, false); assert.equal(config.tools.edit, false); assert.equal(config.tools.write, false);
  assert.equal(config.permission.bash, 'deny');
  assert.deepEqual(config.mcp.office, { type: 'remote', url: 'http://127.0.0.1:5/mcp', oauth: false, headers: { Authorization: 'Bearer t' } });
  assert.equal(config.provider.office.models['grok-4.7'].limit.context, 256_000);
  const local = buildConfig({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', system: '',
    bridge: { url: 'u', authorization: 'a' } }) as any;
  assert.equal(local.provider.office.options.apiKey, undefined, 'без ключа — без apiKey');

  // Имена инструментов офиса — в алфавите API OpenAI.
  assert.equal(wireName('mcp__office__finish_task'), 'office__finish_task');
  assert.match(wireName('mcp__ext__some.tool/x'), /^[a-zA-Z0-9_-]{1,64}$/);

  const sse = async function* () {
    const enc = new TextEncoder();
    yield enc.encode('data: {"type":"session.status","properties":{"sessionID":"s","status":{"type":"busy"}}}\n\n: ping\n\n');
    yield enc.encode('data: {"payload":{"type":"session.idle","properties":{"sessionID":"s"}}}\n');
    yield enc.encode('\ndata: not json\n\n');
  };
  const got: string[] = [];
  for await (const e of parseSse(sse())) got.push(e.type);
  assert.deepEqual(got, ['session.status', 'session.idle']);
  assert.deepEqual(stepUsage({ input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 2 } }),
    { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 });

  // Цены: каталог с диска, поверх — цены владельца; у своего сервера цены нет.
  writeFileSync(resolve(root, 'model-prices.json'), JSON.stringify({
    deepseek: { 'deepseek-flash': { id: 'deepseek-flash', name: 'DeepSeek Flash', price: { input: 0.3, output: 1.2, cachedInput: 0.03 } } },
  }));
  assert.deepEqual(await modelPrice('deepseek', 'deepseek-flash'), { input: 0.3, output: 1.2, cachedInput: 0.03 });
  assert.equal(await modelPrice('custom', 'my-model'), null);
  process.env.OFFICE_MODEL_PRICING = JSON.stringify({ 'custom/my-model': { input: 1, output: 2 } });
  assert.deepEqual(await modelPrice('custom', 'my-model'), { input: 1, output: 2, cachedInput: 1 });
  delete process.env.OFFICE_MODEL_PRICING;

  // Статус: движок не найден → установка с карточки; найден → нужен ключ или адрес.
  process.env.OFFICE_OPENCODE_PATH = resolve(root, 'no-opencode');
  const missing = await engineFor('xai').status('xai', { force: true });
  assert.equal(missing.state, 'not-installed');
  const ocMock = resolve(root, 'opencode-mock.sh');
  writeFileSync(ocMock, '#!/bin/sh\necho 1.18.34\n', { mode: 0o755 });
  process.env.OFFICE_OPENCODE_PATH = ocMock;
  assert.equal((await engineFor('xai').status('xai', { force: true })).state, 'needs-login');
  assert.deepEqual(await engineFor('xai').locate(), { path: ocMock, version: '1.18.34' });
  assert.equal((await engineFor('custom').status('custom', { force: true })).state, 'needs-login');
  const caps = engineFor('ollama').capabilities('linux');
  assert.deepEqual([caps.officeTools, caps.nativeHands, caps.costUsd, caps.apiKeyLogin], ['mcp-bridge', false, 'computed', true]);
  // Вход по подписке (T-219) у OpenCode — честный отказ, а не «нужен ключ».
  assert.equal(caps.subscriptionLogin, false);
  await assert.rejects(engineFor('xai').login({ provider: 'xai', kind: 'subscription' }),
    (err: unknown) => err instanceof LoginError && err.code === 'unsupported');
  delete process.env.OFFICE_OPENCODE_PATH;
}

console.log('Provider tests passed: routing, events, tools, denials, resume, queue, compaction, cancellation, failures, cost, quotas, engine adapters, sandbox paths, packages, opencode.');
