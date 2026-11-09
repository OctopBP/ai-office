/** Адресная проверка HTTP-обработчика без запуска живого офиса и сетевого порта. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handleDocsHttp, type DocsHttpEnv } from '../src/server/docs-api';
import { ПРЕДЕЛ_ОРИГИНАЛА, type МетаданныеОригинала } from '../src/server/doc-files';
import { createDoc } from '../src/server/docs';
import { getOffice } from '../src/server/state';

const папка = mkdtempSync(join(realpathSync(tmpdir()), 'office-doc-files-http-'));
const офисы = ['files-http-a', 'files-http-b'].map(id => getOffice(id));
let наружу = false;
let владелец = false;
const среда: DocsHttpEnv = {
  exposed: () => наружу,
  ownerSignedIn: () => владелец,
  office: id => {
    const офис = офисы.find(офис => офис.officeId === (id ?? офисы[0].officeId));
    return офис ? { id: офис.officeId } : { code: 404, error: 'Офис не найден' };
  },
};
async function запрос(метод: string, путь: string, чанки: Buffer[] = [], заголовки: Record<string, string> = {}) {
  const [url, query = ''] = путь.split('?');
  const req = Object.assign(Readable.from(чанки), { method: метод, headers: заголовки });
  return new Promise<{ код: number; заголовки: Record<string, string>; байты: Buffer; json: () => any }>(готово => {
    let код = 0;
    let ответныеЗаголовки: Record<string, string> = {};
    const res = {
      writeHead(значение: number, поля: Record<string, string>) {
        код = значение; ответныеЗаголовки = поля; return res;
      },
      end(тело: Buffer | string) {
        const байты = Buffer.isBuffer(тело) ? тело : Buffer.from(тело);
        готово({ код, заголовки: ответныеЗаголовки, байты, json: () => JSON.parse(байты.toString()) });
      },
    };
    assert.equal(handleDocsHttp(req as never, res as never, url, query, среда), true);
  });
}
try {
  офисы.forEach((офис, индекс) => {
    офис.setStateFile(join(папка, индекс + '.json'));
    createDoc(офис.officeId, { title: 'Документ', author: 'owner' });
  });
  createDoc(офисы[0].officeId, { title: 'Другой документ', author: 'owner' });
  const адрес = '/api/docs/D-1/files';
  const байты = Buffer.from([0, 255, 128, 13, 10, ...Buffer.from('<svg onload="alert(1)"/>')]);
  const заголовки = { 'x-file-name': encodeURIComponent('../схема.svg'), 'content-type': 'image/svg+xml' };
  const загрузка = await запрос('POST', адрес, [байты.subarray(0, 5), байты.subarray(5)], заголовки);
  assert.equal(загрузка.код, 201);
  const файл = загрузка.json().file as МетаданныеОригинала;
  assert.equal(файл.имя, 'схема.svg');
  assert.equal(файл.mime, 'image/svg+xml');
  assert.equal(файл.размер, байты.length);
  assert.deepEqual((await запрос('GET', адрес)).json(), { files: [файл] });
  const оригинал = адрес + '/' + файл.id;
  const чтение = await запрос('GET', оригинал);
  assert.equal(чтение.код, 200);
  assert.deepEqual(чтение.байты, байты);
  assert.match(чтение.заголовки['Content-Disposition'], /^attachment;/);
  assert.match(чтение.заголовки['Content-Disposition'], /filename\*=UTF-8''/);
  assert.equal(чтение.заголовки['X-Content-Type-Options'], 'nosniff');
  assert.equal(чтение.заголовки['Content-Type'], 'application/octet-stream');
  for (const метод of ['GET', 'DELETE']) {
    assert.equal((await запрос(метод, '/api/docs/D-2/files/' + файл.id)).код, 404);
    assert.equal((await запрос(метод, оригинал + '?office=' + офисы[1].officeId)).код, 404);
  }
  assert.deepEqual((await запрос('GET', адрес + '?office=' + офисы[1].officeId)).json(), { files: [] });
  assert.equal((await запрос('GET', адрес + '?office=нет')).код, 404);
  assert.equal((await запрос('POST', '/api/docs/D-99/files', [байты], заголовки)).код, 404);
  assert.equal((await запрос('GET', адрес + '/%2e%2e%2findex.json')).код, 404);
  assert.equal((await запрос('POST', адрес, [байты])).код, 400);
  assert.equal((await запрос('POST', адрес, [байты], { 'x-file-name': '%' })).код, 400);
  assert.equal((await запрос('PUT', адрес)).код, 405);
  наружу = true;
  assert.equal((await запрос('POST', адрес, [байты], заголовки)).код, 403);
  assert.equal((await запрос('DELETE', оригинал)).код, 403);
  assert.deepEqual((await запрос('GET', оригинал)).байты, байты);
  владелец = true;
  const пустой = await запрос('POST', адрес, [], { 'x-file-name': 'unknown.custom' });
  assert.equal(пустой.код, 201);
  assert.equal((await запрос('DELETE', адрес + '/' + пустой.json().file.id)).код, 200);
  наружу = false;
  // Без Content-Length: лимит проверяется при поступлении каждого чанка.
  const большой = await запрос('POST', адрес, [Buffer.alloc(ПРЕДЕЛ_ОРИГИНАЛА), Buffer.from([1])], заголовки);
  assert.equal(большой.код, 413);
  assert.deepEqual((await запрос('GET', адрес)).json(), { files: [файл] });
  assert.equal((await запрос('DELETE', оригинал)).код, 200);
  assert.equal((await запрос('GET', оригинал)).код, 404);
  assert.deepEqual((await запрос('GET', адрес)).json(), { files: [] });
  console.log('HTTP оригиналов: загрузка, список, точные байты, удаление, изоляция, доступ и потоковый лимит — OK');
} finally {
  офисы.forEach(офис => офис.retire());
  rmSync(папка, { recursive: true, force: true });
}
