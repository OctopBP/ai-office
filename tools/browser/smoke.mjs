#!/usr/bin/env node
// Дымовой прогон MCP-сервера браузера: пишет шумную страницу во временную папку, запускает
// server.mjs как MCP-клиент по stdio, отдаёт страницу через serve (без порта) и по очереди
// дёргает все инструменты. Каждый шаг — строка ОК/ОШИБКА.
// Запуск: node tools/browser/smoke.mjs              (кадры — во временной папке, путь в конце вывода)
//         node tools/browser/smoke.mjs --dir <папка> [--shot <файл.png>]
//           — только serve + open + screenshot папки рабочей копии (проверка, что страница открывается)
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTERNAL = 'https://example.com/';
const argOf = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const ONLY_DIR = argOf('--dir');

// Страница нарочно шумит: ошибка в консоли, исключение, 404, чужой fetch и сокет.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>QA smoke</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css"></head><body>
<canvas id="c" width="300" height="300"></canvas>
<a id="away" href="go.html">редирект наружу</a>
<script src="app.js"></script></body></html>`;
const STYLE = 'body{margin:0;background:#1d6fd8;color:#fff;font:16px sans-serif}canvas{display:block;background:#ffd23f}';
const APP = `window.__QA_STATE__ = { ready: true, bg: getComputedStyle(document.body).backgroundColor, touch: { start: 0, move: 0, end: 0 } };
const c = document.getElementById('c'), g = c.getContext('2d');
g.fillStyle = '#d00'; g.fillRect(100, 100, 100, 100);
for (const k of ['start', 'move', 'end']) c.addEventListener('touch' + k, () => window.__QA_STATE__.touch[k]++);
console.error('qa: намеренная ошибка');
setTimeout(() => { throw new Error('qa: намеренное исключение'); });
fetch('missing.json').catch(() => {});
fetch('${EXTERNAL}').catch(() => {});
try { new WebSocket('wss://example.com/socket'); } catch {}`;
// Статика не умеет 302, поэтому редирект — клиентский: страница сама уходит на чужой адрес.
const GO = `<!doctype html><title>go</title><script>location.replace('${EXTERNAL}')</script>`;

const workdir = ONLY_DIR ? process.cwd() : await mkdtemp(path.join(os.tmpdir(), 'qa-smoke-'));
if (!ONLY_DIR) {
  await mkdir(path.join(workdir, 'site'), { recursive: true });
  for (const [name, body] of [['index.html', PAGE], ['style.css', STYLE], ['app.js', APP], ['go.html', GO]]) {
    await writeFile(path.join(workdir, 'site', name), body);
  }
}

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

// Шаг: fn возвращает пояснение (ОК) или бросает (ОШИБКА). page — шагу нужна раздача страницы.
let BASE = null;
let serveError = null;
async function step(title, fn, page = true) {
  try {
    if (page && !BASE) throw new Error(`нет раздачи страницы: ${serveError}`);
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
const found = (list, pred, what) => { const hit = list.find(pred); assert(hit, `${what}: ${short(list)}`); return hit; };

async function finish() {
  console.log(`\nлог сервера: ${serverLog.match(/(режим запуска|обычный headless|заблокирован|раздача).*/g)?.join(' | ') || 'нет строк'}`);
  if (!ONLY_DIR) console.log(`кадры: ${workdir}/shots`);
  console.log(`итог: ${failures ? `ошибок ${failures}` : 'всё ОК'}`);
  await client.close();
  process.exit(failures ? 1 : 0);
}

await step('serve папки без порта', async () => {
  const r = await call('serve', { dir: ONLY_DIR || 'site' });
  if (r.error) { serveError = r.error; throw new Error(r.error); }
  BASE = r.data.url;
  return BASE;
}, false);

if (ONLY_DIR) {
  const shot = argOf('--shot') || path.join('docs', 'qa', 'shots', 'serve.png');
  await step('open раздачи', async () => {
    const d = await must('open', { url: BASE });
    await sleep(800);
    return `${d.status} «${d.title}», режим ${d.device?.mode}`;
  });
  await step('screenshot', async () => (await must('screenshot', { path: shot })).path);
  await step('ошибки страницы', async () => short({
    errors: await must('get_errors'), failed: await must('get_failed_requests'), console: await must('get_console', { level: 'error' }),
  }));
  await finish();
}

await step('open раздачи', async () => {
  const d = await must('open', { url: BASE });
  await sleep(800); // дать fetch, сокету и исключению отработать после load
  assert(d.status === 200, `статус ${d.status}`);
  return `${d.status} «${d.title}», режим ${d.device?.mode}`;
});
await step('MIME по расширению', async () => {
  // Браузер применяет таблицу стилей только с типом text/css: фон страницы — проверка MIME.
  const d = (await must('get_state')).app;
  assert(d?.ready === true, 'app.js не исполнился');
  assert(d.bg === 'rgb(29, 111, 216)', `style.css не применился, фон ${d.bg}`);
  return `app.js исполнился, фон из style.css ${d.bg}`;
});
await step('set_device phone-portrait', async () => short(await must('set_device', { preset: 'phone-portrait' })), false);
await step('set_device → альбом', async () => {
  const d = await must('set_device', { orientation: 'landscape' });
  assert(d.width > d.height, `не повернулся: ${d.width}×${d.height}`);
  return `${d.width}×${d.height}`;
}, false);
await step('get_console', async () => found(await must('get_console', { level: 'error' }), (e) => e.text.includes('намеренная ошибка'), 'нет ошибки').text);
await step('get_errors', async () => found(await must('get_errors'), (e) => e.message.includes('намеренное исключение'), 'нет исключения').message);
let failed = [];
await step('get_failed_requests: честный 404 раздачи', async () => {
  failed = await must('get_failed_requests');
  return short(found(failed, (e) => e.kind === 'http' && e.status === 404 && e.url.endsWith('missing.json'), 'нет 404'));
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
await step('screenshot', async () => path.join(workdir, (await must('screenshot', { path: 'shots/page.png' })).path));
await step('storyboard 3 кадра со свайпом', async () => short((await must('storyboard', {
  count: 3, intervalMs: 200, dir: 'shots/board', swipe: { points: [{ x: 260, y: 100 }, { x: 40, y: 200 }], durationMs: 400 },
})).frames));
await step('set_offline роняет раздачу', async () => {
  await must('set_offline', { on: true });
  try {
    const env = (await must('get_state')).env;
    assert(env?.online === false, `navigator.onLine не false: ${short(env)}`);
    // Новый open должен упасть: раздача в офлайне не отвечает.
    const r = await call('open', { url: `${BASE}index.html` });
    assert(r.error, `open в офлайне прошёл: ${short(r.data)}`);
    const hit = found(await must('get_failed_requests'), (e) => e.kind === 'failed' && /INTERNET_DISCONNECTED/i.test(e.error), 'нет обрыва');
    return `navigator.onLine=false, open: ${r.error.slice(0, 60)}…, ${hit.error}`;
  } finally {
    await must('set_offline', { on: false });
  }
});
await step('после офлайна раздача снова отвечает', async () => `${(await must('open', { url: BASE })).status}`);
await step('open внешнего адреса отклонён', async () => {
  const r = await call('open', { url: EXTERNAL });
  assert(r.error, `открылся: ${short(r.data)}`);
  return r.error;
}, false);
await step('serve вне рабочей копии отклонён', async () => {
  const r = await call('serve', { dir: '../' });
  assert(r.error, `раздал: ${short(r.data)}`);
  return r.error;
}, false);
await step('редирект на чужой адрес не уводит наружу', async () => {
  const r = await call('open', { url: `${BASE}go.html` });
  await sleep(800);
  const url = (await must('get_state')).env?.url || '';
  assert(!url.includes('example.com'), `страница ушла на ${url}`);
  const hit = found(await must('get_failed_requests'), (e) => e.url.startsWith(EXTERNAL) && e.resource === 'document', 'нет записи о переходе');
  return `${r.error ? 'open с ошибкой' : 'open без ошибки'}, страница на ${url}, ${hit.kind}: ${hit.error}`;
});

await finish();
