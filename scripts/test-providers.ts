import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

const root = mkdtempSync(resolve(tmpdir(), 'office-providers-'));
process.env.OFFICE_STATE_FILE = resolve(root, 'state.json');
process.env.OFFICE_CODEX_HOME = resolve(root, 'codex');
process.env.CODEX_HOME = resolve(root, 'no-owner-auth');
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
  if(m.method==='account/rateLimits/read') return reply(m,{rateLimits:{planType:'plus',primary:{usedPercent:0.5,resetsAt:2000000000},secondary:{usedPercent:90,resetsAt:2000000000}}});
});
`, { mode: 0o755 });
process.env.OFFICE_CODEX_PATH = fake;
const { query, tool, createSdkMcpServer } = await import('../src/server/providers');
const { providerOf, sessionForProvider } = await import('../src/shared/providers');
const { MessageQueue } = await import('../src/server/queue');
const { createLimitTracker, pollLimits, limitsView } = await import('../src/server/limits');
const { readablePath, writablePath } = await import('../src/server/providers/codex-tools');
const { scaffoldPackage } = await import('../src/server/export');
const { readPackage } = await import('../src/server/packages');
const { roleFromPackage } = await import('../src/server/roles');

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
console.log('Provider tests passed: routing, events, tools, denials, resume, queue, compaction, cancellation, failures, cost, quotas, sandbox paths, packages.');
