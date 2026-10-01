#!/usr/bin/env node
// Дымовой прогон MCP-сервера браузера: поднимает локальную страницу, запускает server.mjs
// как MCP-клиент по stdio и по очереди дёргает все инструменты. Каждый шаг — строка ОК/ОШИБКА.
// Запуск: node tools/browser/smoke.mjs  (кадры — во временной папке, путь в конце вывода)
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTERNAL = 'https://example.com/';

// Страница нарочно шумит: ошибка в консоли, исключение, 404, чужой fetch и сокет.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>QA smoke</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#1d6fd8;color:#fff;font:16px sans-serif">
<canvas id="c" width="300" height="300" style="display:block;background:#ffd23f"></canvas>
<a id="away" href="/go">редирект наружу</a>
<script>
  window.__QA_STATE__ = { ready: true, touch: { start: 0, move: 0, end: 0 } };
  const c = document.getElementById('c'), g = c.getContext('2d');
  g.fillStyle = '#d00'; g.fillRect(100, 100, 100, 100);
  for (const k of ['start', 'move', 'end']) c.addEventListener('touch' + k, () => window.__QA_STATE__.touch[k]++);
  console.error('qa: намеренная ошибка');
  setTimeout(() => { throw new Error('qa: намеренное исключение'); });
  fetch('/missing').catch(() => {});
  fetch('${EXTERNAL}').catch(() => {});
  try { new WebSocket('wss://example.com/socket'); } catch {}
</script></body></html>`;

const site = http.createServer((req, res) =>
  req.url === '/' ? res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
  : req.url === '/go' ? res.writeHead(302, { location: EXTERNAL }).end() : res.writeHead(404).end('нет'));
// Без порта (песочница запрещает listen) прогоняем то, что не требует страницы.
const listenError = await new Promise((ok) => site.once('error', ok).listen(0, '127.0.0.1', () => ok(null)));
const BASE = listenError ? null : `http://127.0.0.1:${site.address().port}/`;

const workdir = await mkdtemp(path.join(os.tmpdir(), 'qa-smoke-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, 'server.mjs')],
  env: { ...process.env, OFFICE_WORKDIR: workdir, OFFICE_TASK_ID: 'smoke', QA_ALLOWED_ORIGIN: '' },
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', (d) => (serverLog += d));
const client = new Client({ name: 'qa-smoke', version: '0.1.0' });
await client.connect(transport);
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Вызов инструмента: возвращает { error, data } — data разобран из JSON, если получилось.
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((p) => p.text || '').join('') || '';
  try { return { error: res.isError ? text : null, data: JSON.parse(text) }; } catch { return { error: res.isError ? text : null, data: text }; }
}

// Шаг: fn возвращает пояснение (ОК) или бросает (ОШИБКА). page — шагу нужна локальная страница.
async function step(title, fn, page = true) {
  try {
    if (page && !BASE) throw new Error(`нет локальной страницы: ${listenError.message}`);
    const note = await fn();
    console.log(`ОК      ${title}${note ? ` — ${note}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`ОШИБКА  ${title} — ${String(err?.message || err).split('\n')[0]}`);
  }
}
const must = async (name, args) => { const r = await call(name, args); if (r.error) throw new Error(r.error); return r.data; };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const short = (v) => JSON.stringify(v).slice(0, 160);

await step('локальный HTTP-сервер', async () => { if (listenError) throw listenError; return BASE; }, false);
await step('open локальной страницы', async () => {
  const d = await must('open', { url: BASE });
  await sleep(800); // дать fetch, сокету и исключению отработать после load
  return `${d.status} «${d.title}», режим ${d.device?.mode}`;
});
await step('set_device phone-portrait', async () => short(await must('set_device', { preset: 'phone-portrait' })), false);
await step('set_device → альбом', async () => {
  const d = await must('set_device', { orientation: 'landscape' });
  assert(d.width > d.height, `не повернулся: ${d.width}×${d.height}`);
  return `${d.width}×${d.height}`;
}, false);
const found = (list, pred, what) => { const hit = list.find(pred); assert(hit, `${what}: ${short(list)}`); return hit; };
await step('get_console', async () => found(await must('get_console', { level: 'error' }), (e) => e.text.includes('намеренная ошибка'), 'нет ошибки').text);
await step('get_errors', async () => found(await must('get_errors'), (e) => e.message.includes('намеренное исключение'), 'нет исключения').message);
let failed = [];
await step('get_failed_requests: 404', async () => {
  failed = await must('get_failed_requests');
  return short(found(failed, (e) => e.kind === 'http' && e.status === 404, 'нет 404'));
});
await step('чужой fetch заблокирован', async () => {
  const hit = found(failed, (e) => e.url.startsWith(EXTERNAL) && e.resource !== 'websocket', 'нет записи о fetch');
  assert(/blocked/i.test(`${hit.kind} ${hit.error}`), `не заблокирован: ${short(hit)}`);
  return `${hit.kind}: ${hit.error}`;
});
await step('чужой WebSocket заблокирован (routeWebSocket)', async () => found(failed, (e) => e.resource === 'websocket', 'нет записи о сокете').url);
await step('get_state', async () => {
  const d = await must('get_state');
  assert(d.app?.ready === true, `нет __QA_STATE__: ${short(d)}`);
  return short(d.env);
});
// Жест и затем счётчики touch-событий страницы из __QA_STATE__.touch.
const gesture = async (name, args, ok) => {
  await must(name, args);
  const t = (await must('get_state', { path: 'touch' })).app;
  assert(ok(t), `touch не дошёл: ${short(t)}`);
  return short(t);
};
await step('tap по canvas', () => gesture('tap', { x: 150, y: 150 }, (t) => t.start >= 1 && t.end >= 1));
await step('swipe по canvas', () => gesture('swipe', { points: [{ x: 40, y: 150 }, { x: 260, y: 150 }], durationMs: 200 }, (t) => t.move >= 3));
await step('screenshot', async () => path.join(workdir, (await must('screenshot', { path: 'shots/page.png' })).path), false);
await step('storyboard 3 кадра со свайпом', async () => short((await must('storyboard', {
  count: 3, intervalMs: 200, dir: 'shots/board', swipe: { points: [{ x: 260, y: 100 }, { x: 40, y: 200 }], durationMs: 400 },
})).frames), false);
await step('set_offline on/off', async () => {
  await must('set_offline', { on: true });
  const off = (await must('get_state')).env;
  await must('set_offline', { on: false });
  assert(off?.online === false, `navigator.onLine не false: ${short(off)}`);
  return 'navigator.onLine=false в офлайне';
}, false);
await step('open внешнего адреса отклонён', async () => {
  const r = await call('open', { url: EXTERNAL });
  assert(r.error, `открылся: ${short(r.data)}`);
  return r.error;
}, false);
await step('редирект на чужой адрес не уводит наружу', async () => {
  const r = await call('open', { url: `${BASE}go` });
  const url = (await must('get_state')).env?.url || '';
  assert(!url.includes('example.com'), `страница ушла на ${url}`);
  return r.error || `open без ошибки, страница на ${url}`;
});

// Без страницы хотя бы убеждаемся, что инструменты отвечают на about:blank.
if (!BASE) for (const [name, args] of [['get_console'], ['get_errors'], ['get_failed_requests'], ['get_state'],
  ['tap', { x: 100, y: 100 }], ['swipe', { points: [{ x: 40, y: 100 }, { x: 300, y: 100 }], durationMs: 200 }]]) {
  await step(`${name} на about:blank (содержимое не проверяется)`, async () => short(await must(name, args)), false);
}
console.log(`\nлог сервера: ${serverLog.match(/(режим запуска|обычный headless|заблокирован).*/g)?.join(' | ') || 'нет строк'}`);
console.log(`кадры: ${workdir}/shots\nитог: ${failures ? `ошибок ${failures}` : 'всё ОК'}`);
await client.close();
site.close();
process.exit(failures ? 1 : 0);
