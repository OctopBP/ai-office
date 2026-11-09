import './_isolate';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ХранилищеОригиналов } from '../src/server/doc-files';
import {
  открытьОригиналДокумента, type РезультатОткрытияОригинала, type СредаОткрытияОригинала,
} from '../src/server/doc-file-open';

async function пример(
  имя: string,
  проверка: (данные: {
    корень: string; id: string; офис: string;
    открыть: (среда?: СредаОткрытияОригинала, docId?: string, fileId?: string) => Promise<РезультатОткрытияОригинала>;
    вызовы: Array<{ команда: string; аргументы: string[] }>;
  }) => Promise<void>,
  байты = Buffer.from('содержимое документа'),
): Promise<void> {
  const офис = mkdtempSync(join(realpathSync(process.cwd()), '.test-doc-open-'));
  const корень = join(офис, 'originals');
  try {
    const запись = new ХранилищеОригиналов(корень).сохранить({ docId: 'D-955', имя, байты });
    const вызовы: Array<{ команда: string; аргументы: string[] }> = [];
    const открыть = (среда: СредаОткрытияОригинала = {}, docId = 'D-955', fileId = запись.id) =>
      открытьОригиналДокумента({ кореньОригиналов: корень, docId, fileId }, {
        платформа: 'darwin',
        запуск: async (команда, аргументы) => { вызовы.push({ команда, аргументы }); return { ok: true }; },
        ...среда,
      });
    await проверка({ корень, id: запись.id, офис, открыть, вызовы });
  } finally { rmSync(офис, { recursive: true, force: true }); }
}

function отказ(результат: РезультатОткрытияОригинала, status: number, code: string): void {
  assert.equal(результат.ok, false);
  if (!результат.ok) {
    assert.equal(результат.status, status);
    assert.equal(результат.code, code);
    assert.ok(результат.error);
  }
}

test('ОС получает отдельный аргумент с именем и расширением; содержимое совпадает', () =>
  пример('счёт; $(touch не_выполнять).pdf', async ({ открыть, вызовы, корень }) => {
    assert.deepEqual(await открыть(), { ok: true });
    assert.equal(вызовы.length, 1);
    assert.equal(вызовы[0].команда, 'open');
    assert.equal(вызовы[0].аргументы.length, 1);
    const путь = вызовы[0].аргументы[0];
    assert.ok(путь.startsWith(корень + '/.open-'));
    assert.ok(путь.endsWith('/счёт; $(touch не_выполнять).pdf'));
    assert.equal(readFileSync(путь, 'utf8'), 'содержимое документа');
  }));

test('Linux использует xdg-open', () => пример('текст.txt', async ({ открыть, вызовы }) => {
  assert.deepEqual(await открыть({ платформа: 'linux' }), { ok: true });
  assert.equal(вызовы[0].команда, 'xdg-open');
}));

test('Отсутствующий оригинал возвращает 404 без запуска', () =>
  пример('текст.txt', async ({ корень, id, открыть, вызовы }) => {
    unlinkSync(join(корень, id, 'original'));
    отказ(await открыть(), 404, 'not_found');
    assert.equal(вызовы.length, 0);
  }));

test('Чужой документ и произвольный путь вместо ID не разрешаются', () =>
  пример('текст.txt', async ({ открыть, вызовы }) => {
    отказ(await открыть({}, 'D-другой'), 404, 'not_found');
    отказ(await открыть({}, 'D-955', '../../вне'), 404, 'not_found');
    assert.equal(вызовы.length, 0);
  }));

test('Файл другого офиса с тем же docId недоступен в текущем хранилище', () =>
  пример('текст.txt', async ({ офис, открыть, вызовы }) => {
    const чужой = new ХранилищеОригиналов(join(офис, 'другой-офис', 'originals'))
      .сохранить({ docId: 'D-955', имя: 'чужой.txt', байты: Buffer.from('чужой документ') });
    отказ(await открыть({}, 'D-955', чужой.id), 404, 'not_found');
    assert.equal(вызовы.length, 0);
  }));

test('Ссылка на оригинал за корнем текущего офиса запрещена', () =>
  пример('текст.txt', async ({ корень, id, офис, открыть, вызовы }) => {
    const внешний = join(офис, 'вне-библиотеки.txt');
    writeFileSync(внешний, 'чужие данные');
    const оригинал = join(корень, id, 'original');
    unlinkSync(оригинал);
    symlinkSync(внешний, оригинал);
    отказ(await открыть(), 403, 'forbidden_path');
    assert.equal(вызовы.length, 0);
  }));

test('Подмена корня хранилища ссылкой запрещена', () =>
  пример('текст.txt', async ({ корень, офис, id, вызовы }) => {
    const ссылка = join(офис, 'ссылка');
    symlinkSync(корень, ссылка, 'dir');
    отказ(await открытьОригиналДокумента(
      { кореньОригиналов: ссылка, docId: 'D-955', fileId: id },
      { запуск: async () => { assert.fail('Запуск запрещён'); } },
    ), 403, 'forbidden_path');
    assert.equal(вызовы.length, 0);
  }));

for (const имя of ['запуск.exe', 'запуск.sh', 'запуск.cmd', 'запуск.ps1', 'запуск.js',
  'страница.html', 'рисунок.svg', 'макрос.docm', 'без-расширения', 'документ.pdf.exe']) {
  test('Запрещённый формат: ' + имя, () => пример(имя, async ({ открыть, вызовы }) => {
    отказ(await открыть(), 415, 'forbidden_format');
    assert.equal(вызовы.length, 0);
  }));
}

test('Исполняемый файл под именем документа запрещён', () =>
  пример('подмена.pdf', async ({ открыть, вызовы }) => {
    отказ(await открыть(), 415, 'forbidden_format');
    assert.equal(вызовы.length, 0);
  }, Buffer.from('#!/bin/sh\necho опасно')));

test('Отказ приложения и исключение запуска возвращают 502, временные копии убираются', () =>
  пример('текст.txt', async ({ открыть, корень }) => {
    отказ(await открыть({ запуск: async () => ({ ok: false, message: 'отказ ОС' }) }), 502, 'launch_failed');
    отказ(await открыть({ запуск: async () => { throw new Error('сбой запуска'); } }), 502, 'launch_failed');
    assert.ok(readdirSync(корень).every(имя => !имя.startsWith('.open-')));
  }));

test('FigCraft открывается готовым механизмом openCommand', () =>
  пример('макет.figcraft', async ({ открыть, вызовы }) => {
    assert.deepEqual(await открыть({
      figcraft: { env: { FIGCRAFT_APP: '/приложения/FigCraft.app' }, exists: () => true },
    }), { ok: true });
    assert.equal(вызовы[0].команда, 'open');
    assert.deepEqual(вызовы[0].аргументы.slice(0, 2), ['-a', '/приложения/FigCraft.app']);
    assert.ok(вызовы[0].аргументы[2].endsWith('/макет.figcraft'));
  }));

test('Отсутствующий FigCraft возвращает 502 без запуска', () =>
  пример('макет.figcraft', async ({ открыть, вызовы }) => {
    отказ(await открыть({ figcraft: { env: {}, exists: () => false } }), 502, 'launch_failed');
    assert.equal(вызовы.length, 0);
  }));
