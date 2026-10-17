#!/usr/bin/env node
// Прогон ввода и темы MCP-сервера браузера: пишет страницу с формой во временную папку,
// запускает server.mjs как MCP-клиент по stdio, отдаёт её через serve и проверяет type,
// press_key и set_color_scheme. Каждый шаг — строка ОК/ОШИБКА, как в smoke.mjs.
// Запуск: node tools/browser/input.mjs   (npm run test:browser-input)
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Форма повторяет то, как React держит контролируемый инпут: значение живёт в state,
// меняется только из обработчика input, а после каждого события поле перерисовывается
// из state. Ввод, который не дал события input, при перерисовке пропал бы.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>QA input</title>
<style>
  body{margin:0;background:#fff;color:#000;font:16px sans-serif}
  @media (prefers-color-scheme: dark){body{background:#111;color:#eee}}
</style></head><body>
<form id="f">
  <input id="name" name="name" value="старое">
  <textarea id="bio" name="bio">старый текст</textarea>
  <input id="next" name="next">
  <button>Отправить</button>
</form>
<script>
const state = { name: 'старое', bio: 'старый текст', inputs: 0, changes: 0, submitted: null, escape: 0, keys: '' };
window.__QA_STATE__ = state;
const render = () => { for (const id of ['name', 'bio']) { const el = document.getElementById(id); if (el.value !== state[id]) el.value = state[id]; } };
for (const id of ['name', 'bio']) {
  const el = document.getElementById(id);
  el.addEventListener('input', (e) => { state[id] = e.target.value; state.inputs++; queueMicrotask(render); });
  el.addEventListener('change', () => state.changes++);
}
document.getElementById('next').addEventListener('keydown', (e) => { state.keys += e.key.length === 1 ? e.key : ''; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') state.escape++; });
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); state.submitted = { ...state }; });
// Тема читается геттерами: get_state код не исполняет, а значение берёт в момент чтения.
Object.defineProperty(state, 'scheme', { enumerable: true, get: () => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' });
Object.defineProperty(state, 'bg', { enumerable: true, get: () => getComputedStyle(document.body).backgroundColor });
</script></body></html>`;

const workdir = await mkdtemp(path.join(os.tmpdir(), 'qa-input-'));
await mkdir(path.join(workdir, 'site'), { recursive: true });
await writeFile(path.join(workdir, 'site', 'index.html'), PAGE);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, 'server.mjs')],
  env: { ...process.env, OFFICE_WORKDIR: workdir, OFFICE_TASK_ID: 'input', QA_ALLOWED_ORIGIN: '' },
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', (d) => (serverLog += d));
const client = new Client({ name: 'qa-input', version: '0.1.0' });
await client.connect(transport);
let failures = 0;

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((p) => p.text || '').join('') || '';
  try { return { error: res.isError ? text : null, data: JSON.parse(text) }; } catch { return { error: res.isError ? text : null, data: text }; }
}
async function step(title, fn) {
  try {
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
const app = async (p) => (await must('get_state', p ? { path: p } : {})).app;

let BASE = null;
await step('serve и open формы', async () => {
  BASE = (await must('serve', { dir: 'site' })).url;
  const d = await must('open', { url: BASE });
  assert(d.status === 200, `статус ${d.status}`);
  assert(d.device?.colorScheme === 'light', `схема по умолчанию не light: ${short(d.device)}`);
  return `${d.status} «${d.title}»`;
});
await step('type в input заменяет значение, state видит его', async () => {
  const r = await must('type', { selector: '#name', text: 'Иван Петров' });
  assert(r.value === 'Иван Петров', `в поле «${r.value}»`);
  await new Promise((res) => setTimeout(res, 50)); // дать перерисовке из state отработать
  const s = await app();
  assert(s.name === 'Иван Петров', `state.name = «${s.name}»: событие input не дошло`);
  assert(s.inputs >= 1, 'не было события input');
  return `state.name=«${s.name}», input×${s.inputs}`;
});
await step('type в textarea, многострочный текст', async () => {
  const text = 'строка 1\nстрока 2';
  const r = await must('type', { selector: 'textarea[name=bio]', text });
  assert(r.value === text, `в поле ${short(r.value)}`);
  assert((await app('bio')) === text, 'state.bio не обновился');
  return short(r.value);
});
await step('type с пустой строкой очищает поле', async () => {
  await must('type', { selector: '#name', text: '' });
  assert((await app('name')) === '', 'state.name не пуст');
  await must('type', { selector: '#name', text: 'Иван' });
  return 'очищено и заполнено снова';
});
await step('type slowly печатает по клавишам и заменяет содержимое', async () => {
  await must('type', { selector: '#next', text: 'мусор' });
  const r = await must('type', { selector: '#next', text: 'abc', slowly: true });
  assert(r.value === 'abc', `в поле «${r.value}»`);
  assert((await app('keys')).endsWith('abc'), `keydown не пришли: ${short(await app('keys'))}`);
  return `value=${r.value}, keys=${await app('keys')}`;
});
await step('type с press Enter отправляет форму', async () => {
  await must('type', { selector: '#name', text: 'Отправлено', press: 'Enter' });
  const sub = await app('submitted');
  assert(sub?.name === 'Отправлено', `форма не отправилась или ушло старое значение: ${short(sub)}`);
  return `submitted.name=${sub.name}, bio=${short(sub.bio)}`;
});
await step('press_key Tab переводит фокус', async () => {
  const r = await must('press_key', { key: 'Tab', selector: '#name' });
  assert(r.focus?.id === 'bio', `фокус на ${short(r.focus)}`);
  return short(r.focus);
});
await step('press_key Escape без селектора', async () => {
  const r = await must('press_key', { key: 'Escape', count: 2 });
  assert((await app('escape')) === 2, `Escape×${await app('escape')}`);
  return `count=${r.count}`;
});
await step('селектор без совпадений — ошибка, а не тишина', async () => {
  const r = await call('type', { selector: '#nope', text: 'x' });
  assert(r.error, `прошло: ${short(r.data)}`);
  return r.error;
});
await step('селектор с несколькими совпадениями — ошибка', async () => {
  const r = await call('type', { selector: 'input', text: 'x' });
  assert(r.error, `прошло: ${short(r.data)}`);
  return r.error;
});

await step('схема по умолчанию светлая', async () => {
  assert((await app('scheme')) === 'light', `matchMedia: ${await app('scheme')}`);
  assert((await app('bg')) === 'rgb(255, 255, 255)', `фон ${await app('bg')}`);
  return await app('bg');
});
await step('set_color_scheme dark без перезагрузки', async () => {
  const r = await must('set_color_scheme', { scheme: 'dark' });
  assert(r.colorScheme === 'dark', short(r));
  assert((await app('scheme')) === 'dark', `matchMedia: ${await app('scheme')}`);
  assert((await app('bg')) === 'rgb(17, 17, 17)', `фон ${await app('bg')}`);
  assert((await app('name')) === 'Отправлено', 'страница перезагрузилась: state сброшен');
  return await app('bg');
});
await step('тёмная схема переживает новый open', async () => {
  const d = await must('open', { url: BASE });
  assert(d.device?.colorScheme === 'dark', short(d.device));
  assert((await app('scheme')) === 'dark', `matchMedia: ${await app('scheme')}`);
  return 'dark';
});
await step('set_color_scheme light возвращает светлую', async () => {
  await must('set_color_scheme', { scheme: 'light' });
  assert((await app('bg')) === 'rgb(255, 255, 255)', `фон ${await app('bg')}`);
  return await app('bg');
});

await client.close();
console.log(`\nлог сервера: ${serverLog.match(/(режим запуска|обычный headless).*/g)?.join(' | ') || 'нет строк'}`);
console.log(`итог: ${failures ? `ошибок ${failures}` : 'всё ОК'}`);
process.exit(failures ? 1 : 0);
