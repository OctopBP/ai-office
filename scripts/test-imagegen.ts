// Проверка генератора картинок: `tools/imagegen`. npm run test:imagegen
//
// Сети здесь нет и быть не должно — каждый настоящий запрос стоит денег.
// Поэтому `fetch` подменяется, и проверяется ровно то, что ломается молча:
// форма запроса к чужому API, разбор его ответа, периметр записи и то, что
// сервер вообще отвечает по протоколу MCP.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

let failed = 0;
const check = (what: string, ok: boolean, got: string): void => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(46)} → ${got}`);
};

// Рабочая копия «сотрудника»: сервер считает от неё относительные пути.
const work = mkdtempSync(resolve(tmpdir(), 'imagegen-'));
process.env.OFFICE_WORKDIR = work;

const { PROVIDERS, providerBy, hasKey } = await import('../tools/imagegen/providers/index.mjs');
const { nanobanana } = await import('../tools/imagegen/providers/nanobanana.mjs');
const { safePath, saveImages } = await import('../tools/imagegen/save.mjs');

// ------------------------------------------------------------- реестр

check('провайдер по умолчанию — nanobanana', providerBy().id === 'nanobanana', providerBy().id);
check('провайдер по имени', providerBy('gemini').id === 'gemini', providerBy('gemini').id);
let unknown = '';
try { providerBy('нет-такого'); } catch (e) { unknown = String((e as Error).message); }
check('неизвестный провайдер — внятный отказ', unknown.includes('nanobanana, gemini'), unknown || '(без отказа)');
check('каждый провайдер объявляет ключ и стороны',
  PROVIDERS.every((p) => p.keyEnv && p.aspects.length && p.maxCount >= 1),
  PROVIDERS.map((p) => `${p.id}:${p.maxCount}`).join(' '));

delete process.env.NANOBANANA_API_KEY;
check('без переменной ключа нет', !hasKey(nanobanana), 'пусто');
process.env.NANOBANANA_API_KEY = 'test-key';
check('с переменной ключ есть', hasKey(nanobanana), 'есть');

// ------------------------------------------------- запрос к чужому API

/** Подменённый fetch: запоминает вызовы и отдаёт заготовленные ответы. */
const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
let answer: unknown = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({
    url: String(url),
    body: init?.body ? JSON.parse(String(init.body)) : {},
    auth: String((init?.headers as Record<string, string>)?.Authorization ?? ''),
  });
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(answer),
  } as Response;
}) as typeof fetch;

answer = { code: 200, msg: 'success', data: { taskId: 'task-1' } };
const started = await nanobanana.start({ prompt: 'кот в скафандре', aspect: '16:9', count: 2 });
check('задача заведена', started.taskId === 'task-1', started.taskId);
check('ключ уходит заголовком', calls[0].auth === 'Bearer test-key', calls[0].auth);
// Значения `type` записаны с опечаткой в самом API — исправив её, получим 400.
check('тип запроса — как в документации', calls[0].body.type === 'TEXTTOIAMGE', String(calls[0].body.type));
check('соотношение сторон уходит полем image_size', calls[0].body.image_size === '16:9', String(calls[0].body.image_size));
check('число вариантов доезжает', calls[0].body.numImages === 2, String(calls[0].body.numImages));
// Поле обязательное, а слушать колбэк офису негде: адрес обязан вести в никуда.
check('колбэк в зарезервированной зоне', String(calls[0].body.callBackUrl).includes('.invalid'),
  String(calls[0].body.callBackUrl));

await nanobanana.start({ prompt: 'поправь', refUrls: ['https://x/a.png'] });
check('исходники переводят запрос в режим правки', calls[1].body.type === 'IMAGETOIAMGE', String(calls[1].body.type));

// ------------------------------------------------------ разбор ответа

answer = { code: 200, data: { successFlag: 0 } };
check('0 — ещё рисуется', (await nanobanana.poll('t')).state === 'working', 'working');

answer = { code: 200, data: { successFlag: 1, response: { resultImageUrl: 'https://x/1.png' } } };
const done = await nanobanana.poll('t');
check('1 — готово, со ссылкой', done.state === 'done' && done.images?.[0].url === 'https://x/1.png',
  String(done.images?.[0].url));

// Успех без ссылок — не успех: сохранять нечего, и молчать об этом нельзя.
answer = { code: 200, data: { successFlag: 1, response: {} } };
check('готово без ссылок — отказ', (await nanobanana.poll('t')).state === 'failed', 'failed');

answer = { code: 200, data: { successFlag: 3, errorMessage: 'модель отказалась' } };
const bad = await nanobanana.poll('t');
check('3 — отказ с причиной', bad.state === 'failed' && bad.error === 'модель отказалась', String(bad.error));

// Сервис отвечает 200 с кодом ошибки внутри тела не реже, чем честным статусом.
answer = { code: 402, msg: 'not enough credits' };
let paid = '';
try { await nanobanana.poll('t'); } catch (e) { paid = String((e as Error).message); }
check('код ошибки в теле замечен', paid.includes('402'), paid || '(не замечен)');

globalThis.fetch = realFetch;

// --------------------------------------------------------- периметр записи

check('относительный путь — от рабочей копии',
  safePath('img/hero.png', '.png') === resolve(work, 'img/hero.png'), safePath('img/hero.png', '.png'));
check('расширение дописывается', safePath('img/hero', '.png').endsWith('hero.png'), safePath('img/hero', '.png'));
let outside = '';
try { safePath('../beyond.png', '.png'); } catch (e) { outside = String((e as Error).message); }
check('наружу писать нельзя', outside.includes('только внутри рабочей копии'), outside || '(пустил)');
try { safePath('/etc/hosts', '.png'); } catch (e) { outside = String((e as Error).message); }
check('абсолютный путь наружу тоже нельзя', outside.includes('только внутри рабочей копии'), outside || '(пустил)');

const saved = await saveImages(
  [{ data: Buffer.from('a'), mime: 'image/png' }, { data: Buffer.from('b'), mime: 'image/png' }],
  'pics/hero.png',
);
check('пути отдаются от корня рабочей копии', saved.join(' ') === 'pics/hero.png pics/hero-2.png', saved.join(' '));
check('второй вариант — с номером', readFileSync(resolve(work, 'pics/hero-2.png'), 'utf8') === 'b', 'b');

// ------------------------------------------------------- сервер по MCP

/** Поговорить с сервером его же протоколом: по строке JSON-RPC на запрос. */
async function talk(requests: unknown[]): Promise<Record<string, unknown>[]> {
  const child = spawn('node', [resolve(ROOT, 'tools/imagegen/server.mjs')], {
    env: { ...process.env, OFFICE_WORKDIR: work, NANOBANANA_API_KEY: '', GEMINI_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += String(b); });
  child.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // Закрываем ввод: сервер живёт, пока жив канал, и без этого проверка
  // досиживала бы до таймаута вместо того, чтобы кончиться сама.
  child.stdin.end();
  await new Promise<void>((done) => { child.on('exit', () => done()); setTimeout(() => { child.kill(); done(); }, 5000); });
  return out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const answers = await talk([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_image_providers', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'кот', path: 'a.png' } } },
]);

const byId = (id: number): any => answers.find((a) => a.id === id);
const tools: string[] = (byId(2)?.result?.tools ?? []).map((t: { name: string }) => t.name);
check('сервер отвечает по протоколу', byId(1)?.result?.serverInfo?.name === 'imagegen',
  String(byId(1)?.result?.serverInfo?.name));
check('инструменты на месте', tools.join(' ') === 'generate_image get_image_task get_image_providers', tools.join(' '));
// Разбор рисков офиса считает `get_*` безопасными по префиксу: спрашивать про
// «сколько осталось кредитов» человека незачем.
check('читающие инструменты названы get_*', tools.filter((t) => t.startsWith('get_')).length === 2,
  tools.filter((t) => t.startsWith('get_')).join(' '));
check('рабочая копия видна серверу',
  String(byId(3)?.result?.content?.[0]?.text ?? '').includes(work), work);
// Без ключа роль должна получить внятный отказ, а не молчание и не падение.
const noKey = String(byId(4)?.result?.content?.[0]?.text ?? '');
check('без ключа — отказ с именем переменной',
  byId(4)?.result?.isError === true && noKey.includes('NANOBANANA_API_KEY'), noKey.slice(0, 60));

rmSync(work, { recursive: true, force: true });
console.log(failed ? `\nпровалено кейсов: ${failed}` : '\nвсе кейсы прошли');
process.exit(failed ? 1 : 0);
