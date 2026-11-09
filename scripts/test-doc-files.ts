import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ХранилищеОригиналов } from '../src/server/doc-files.js';

test('Оригинал и метаданные сохраняются после повторного открытия хранилища', () => {
  const корень = mkdtempSync(join(realpathSync(process.cwd()), '.test-doc-files-'));
  try {
    const байты = Buffer.from(Array.from({ length: 1024 }, (_, индекс) => индекс % 256));
    const запись = new ХранилищеОригиналов(корень).сохранить({
      docId: 'D-874', имя: '../../произвольные.bin', mime: 'application/octet-stream', байты,
    });
    assert.match(запись.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(запись, {
      id: запись.id, docId: 'D-874', имя: 'произвольные.bin',
      mime: 'application/octet-stream', размер: байты.length,
    });
    assert.deepEqual(readdirSync(корень), [запись.id]);
    assert.deepEqual(readdirSync(join(корень, запись.id)).sort(), ['meta.json', 'original']);
    const открытое = new ХранилищеОригиналов(корень);
    assert.deepEqual(открытое.метаданные(запись.id), запись);
    assert.deepEqual(открытое.прочитать(запись.id), байты);
  } finally {
    rmSync(корень, { recursive: true, force: true });
  }
});

test('Усечённое имя не мешает прочитать бинарный оригинал после повторного открытия', () => {
  const корень = mkdtempSync(join(realpathSync(process.cwd()), '.test-doc-files-'));
  try {
    const байты = Buffer.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0x0a, 0x0d, 0x01]);
    const запись = new ХранилищеОригиналов(корень).сохранить({
      docId: 'D-882', имя: 'a'.repeat(199) + '.a', mime: 'application/octet-stream', байты,
    });
    assert.equal(запись.имя, 'a'.repeat(199));
    const открытое = new ХранилищеОригиналов(корень);
    assert.deepEqual(открытое.метаданные(запись.id), запись);
    assert.deepEqual(открытое.прочитать(запись.id), байты);
  } finally {
    rmSync(корень, { recursive: true, force: true });
  }
});
