/**
 * HTTP библиотеки документов (src/server/docs-api.ts, T-307): шесть маршрутов
 * с параметром office=, отказы на кривом вводе и доставка правок в сокет.
 *
 * Без живого сервера: запрос — поток с методом, ответ — запись кода и тела.
 * Офис подставляется через env ручки, реестра офисов в проверке нет. Сокет —
 * поддельный клиент в office-api, подписанный на офис так же, как вкладка,
 * а шина офиса связана с рассылкой той же строкой, что и в index.ts.
 *
 * Запуск: npm run test:docs-api
 */
import './_isolate';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { DocMeta, DocVersion, OfficeDoc, ServerEvent } from '../src/shared/types';
import { getOffice, subscribeOffices } from '../src/server/state';
import { broadcast, sendSnapshot } from '../src/server/office-api';
import { handleDocsHttp, type DocsHttpEnv } from '../src/server/docs-api';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'office-docs-api-'));
const A = 'test-docs-a';
const B = 'test-docs-b';
const stateA = getOffice(A);
stateA.setStateFile(join(tmp, 'a.json'));
const stateB = getOffice(B);
stateB.setStateFile(join(tmp, 'b.json'));

let exposed = false;
const env: DocsHttpEnv = {
  exposed: () => exposed,
  ownerSignedIn: () => false,
  office: (wanted) => {
    if (wanted === null) return { id: A };   // «открытый последним»
    return wanted === A || wanted === B ? { id: wanted } : { code: 404, error: 'нет офиса' };
  },
};

// Сокет: шина офиса → рассылка (как в index.ts) → поддельная вкладка офиса A.
subscribeOffices((event, officeId) => broadcast(event, officeId));
const wire: ServerEvent[] = [];
const tab = { readyState: 1, send: (text: string) => { wire.push(JSON.parse(text) as ServerEvent); } };
sendSnapshot(tab as never, stateA);
const docWire = () => wire.filter((e) => e.t.startsWith('doc.')) as Extract<ServerEvent, { t: 'doc.created' }>[];

async function http(method: string, path: string, body?: unknown): Promise<{ code: number; json: Record<string, unknown> }> {
  const [url = '/', query = ''] = path.split('?');
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Object.assign(Readable.from(raw), { method, headers: {} });
  return new Promise((done) => {
    let code = 0;
    const res = {
      writeHead(c: number) { code = c; return res; },
      end(text: string) { done({ code, json: JSON.parse(text) as Record<string, unknown> }); },
    };
    assert.ok(handleDocsHttp(req as never, res as never, url, query, env), `${path} не распознан`);
  });
}

try {
  console.log('адреса');

  await check('чужие адреса ручка не берёт', async () => {
    const res = { writeHead() { return res; }, end() {} };
    for (const url of ['/api/journal', '/api/docsx', '/api/docs/D-1/history/x', '/api/docs/D-1/other']) {
      assert.equal(handleDocsHttp({ method: 'GET' } as never, res as never, url, '', env), false, url);
    }
  });

  await check('неподходящий метод — 405 со списком разрешённых', async () => {
    assert.equal((await http('DELETE', `/api/docs?office=${A}`)).code, 405);
    assert.equal((await http('POST', `/api/docs/D-1/history?office=${A}`)).code, 405);
    assert.equal((await http('GET', `/api/docs/D-1/archive?office=${A}`)).code, 405);
  });

  await check('неизвестный офис — отказ офиса', async () => {
    const r = await http('GET', '/api/docs?office=nope');
    assert.equal(r.code, 404);
  });

  console.log('создание и чтение');

  await check('POST /api/docs заводит документ от владельца, событие уходит в сокет', async () => {
    wire.length = 0;
    const r = await http('POST', `/api/docs?office=${A}`, { title: 'Видение', summary: 'зачем', body: '# Видение\nофис', kind: 'foundation' });
    assert.equal(r.code, 201, JSON.stringify(r.json));
    const doc = r.json.doc as OfficeDoc;
    assert.equal(doc.id, 'D-1');
    assert.equal(doc.createdBy, 'owner');
    assert.equal(doc.kind, 'foundation');
    assert.equal(doc.body, '# Видение\nофис');
    assert.deepEqual(docWire().map((e) => [e.t, e.doc.id]), [['doc.created', 'D-1']]);
    assert.ok(!('body' in docWire()[0].doc), 'в событии — строка оглавления, без текста');
  });

  await check('office= разводит офисы: документ B не виден в A, и событие B не уходит вкладке A', async () => {
    wire.length = 0;
    const r = await http('POST', `/api/docs?office=${B}`, { title: 'Чужой' });
    assert.equal(r.code, 201);
    assert.equal((r.json.doc as OfficeDoc).id, 'D-1', 'у каждого офиса своя нумерация');
    assert.equal((r.json.doc as OfficeDoc).kind, 'working');
    assert.equal(docWire().length, 0);
    const listA = (await http('GET', `/api/docs?office=${A}`)).json.docs as DocMeta[];
    const listB = (await http('GET', `/api/docs?office=${B}`)).json.docs as DocMeta[];
    assert.deepEqual(listA.map((d) => d.title), ['Видение']);
    assert.deepEqual(listB.map((d) => d.title), ['Чужой']);
    // Без office= — открытый последним, то есть A.
    assert.deepEqual(((await http('GET', '/api/docs')).json.docs as DocMeta[]).map((d) => d.title), ['Видение']);
  });

  await check('GET /api/docs: фильтр по типу и поиск', async () => {
    await http('POST', `/api/docs?office=${A}`, { title: 'Спека окна', body: 'кнопка архива', taskId: 'T-9' });
    const working = (await http('GET', `/api/docs?office=${A}&kind=working`)).json.docs as DocMeta[];
    assert.deepEqual(working.map((d) => d.id), ['D-2']);
    assert.equal(working[0].taskId, 'T-9');
    const found = (await http('GET', `/api/docs?office=${A}&query=${encodeURIComponent('архива')}`)).json.docs as DocMeta[];
    assert.deepEqual(found.map((d) => d.id), ['D-2']);
    assert.equal((await http('GET', `/api/docs?office=${A}&kind=bogus`)).code, 400);
  });

  await check('GET /api/docs/:id — документ, 404 на чужом id', async () => {
    const r = await http('GET', `/api/docs/D-1?office=${A}`);
    assert.equal(r.code, 200);
    assert.equal((r.json.doc as OfficeDoc).body, '# Видение\nофис');
    assert.equal((await http('GET', `/api/docs/D-77?office=${A}`)).code, 404);
    assert.equal((await http('GET', `/api/docs/D-2?office=${B}`)).code, 404, 'D-2 есть только в A');
  });

  console.log('правка и история');

  await check('PUT /api/docs/:id правит поля, версия растёт, событие уходит в сокет', async () => {
    wire.length = 0;
    const r = await http('PUT', `/api/docs/D-1?office=${A}`, { title: 'Видение офиса', body: 'v2', kind: 'documentation' });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    const doc = r.json.doc as OfficeDoc;
    assert.equal(doc.version, 2);
    assert.equal(doc.title, 'Видение офиса');
    assert.equal(doc.kind, 'documentation');
    assert.equal(doc.updatedBy, 'owner');
    assert.deepEqual(docWire().map((e) => [e.t, e.doc.id, e.doc.version]), [['doc.updated', 'D-1', 2]]);
  });

  await check('PUT: кривой ввод — 400, документа нет — 404', async () => {
    assert.equal((await http('PUT', `/api/docs/D-1?office=${A}`, { title: '  ' })).code, 400);
    assert.equal((await http('PUT', `/api/docs/D-1?office=${A}`, { kind: 'bogus' })).code, 400);
    assert.equal((await http('PUT', `/api/docs/D-1?office=${A}`, { body: 5 })).code, 400);
    assert.equal((await http('PUT', `/api/docs/D-1?office=${A}`, 'не json')).code, 400);
    assert.equal((await http('PUT', `/api/docs/D-1?office=${A}`, [1])).code, 400);
    assert.equal((await http('PUT', `/api/docs/D-77?office=${A}`, { body: 'x' })).code, 404);
    assert.equal((await http('POST', `/api/docs?office=${A}`, { body: 'без названия' })).code, 400);
  });

  await check('GET /api/docs/:id?version= и /history', async () => {
    const v1 = (await http('GET', `/api/docs/D-1?office=${A}&version=1`)).json.doc as OfficeDoc;
    assert.equal(v1.body, '# Видение\nофис');
    assert.equal(v1.title, 'Видение');
    assert.equal(v1.version, 1);
    assert.equal((await http('GET', `/api/docs/D-1?office=${A}&version=9`)).code, 404);
    assert.equal((await http('GET', `/api/docs/D-1?office=${A}&version=abc`)).code, 400);
    const h = await http('GET', `/api/docs/D-1/history?office=${A}`);
    assert.equal(h.code, 200);
    assert.deepEqual((h.json.versions as DocVersion[]).map((v) => [v.version, v.author]), [[1, 'owner'], [2, 'owner']]);
    assert.equal((await http('GET', `/api/docs/D-77/history?office=${A}`)).code, 404);
  });

  console.log('архив');

  await check('POST /api/docs/:id/archive убирает в архив и возвращает обратно', async () => {
    wire.length = 0;
    const r = await http('POST', `/api/docs/D-2/archive?office=${A}`);
    assert.equal(r.code, 200, JSON.stringify(r.json));
    assert.equal((r.json.doc as OfficeDoc).archived, true);
    assert.deepEqual(docWire().map((e) => e.t), ['doc.archived']);
    const live = (await http('GET', `/api/docs?office=${A}`)).json.docs as DocMeta[];
    assert.ok(!live.some((d) => d.id === 'D-2'), 'архивный не в оглавлении');
    const all = (await http('GET', `/api/docs?office=${A}&archived=1`)).json.docs as DocMeta[];
    assert.ok(all.some((d) => d.id === 'D-2'), 'с archived=1 — виден');

    const back = await http('POST', `/api/docs/D-2/archive?office=${A}`, { archived: false });
    assert.equal((back.json.doc as OfficeDoc).archived, false);
    assert.deepEqual(docWire().map((e) => e.t), ['doc.archived', 'doc.updated']);
    assert.equal((await http('POST', `/api/docs/D-2/archive?office=${A}`, { archived: 'yes' })).code, 400);
    assert.equal((await http('POST', `/api/docs/D-77/archive?office=${A}`)).code, 404);
  });

  console.log('доступ');

  await check('офис открыт наружу: читать можно, менять — нет', async () => {
    exposed = true;
    try {
      assert.equal((await http('GET', `/api/docs?office=${A}`)).code, 200);
      assert.equal((await http('POST', `/api/docs?office=${A}`, { title: 'x' })).code, 403);
      assert.equal((await http('PUT', `/api/docs/D-1?office=${A}`, { body: 'x' })).code, 403);
      assert.equal((await http('POST', `/api/docs/D-1/archive?office=${A}`)).code, 403);
    } finally {
      exposed = false;
    }
  });

  console.log(`\nвсе проверки прошли: ${passed}`);
} finally {
  stateA.retire();
  stateB.retire();
  rmSync(tmp, { recursive: true, force: true });
}
