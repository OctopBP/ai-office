/**
 * Вложения чата с менеджером (src/server/attachments.ts, T-699): загрузка в
 * папку вложений офиса, потолки 20 МБ и 10 файлов на сообщение, санитизация
 * имени, отказ на путь вне папки, отдача по адресу из ответа, метаданные в
 * истории чата и сборка сообщения менеджеру — картинка блоком image, прочий
 * файл путём в тексте; папка вложений — в корнях чтения менеджера, секрет —
 * по-прежнему отказ.
 *
 * Без живого сервера и без сессии SDK: запрос — поток с методом, ответ —
 * запись кода и тела; сессия менеджера стоит «на сжатии», и реплика остаётся
 * в её `pending` — там и смотрим, что ушло бы в SDK.
 *
 * Запуск: npm run test:attachments
 */
import './_isolate';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_MESSAGE, type ChatAttachment } from '../src/shared/types';
import { getOffice } from '../src/server/state';
import {
  attachmentPath, cleanAttachmentName, findAttachment, handleChatAttachment, pmContent, saveAttachment,
  sniffImage, type AttachmentsHttpEnv,
} from '../src/server/attachments';
import { sendUserMessage } from '../src/server/agents';
import { classifyPmRead } from '../src/server/permissions';
import { pmReadScope } from '../src/server/pm-read';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'office-attach-')));
const OFFICE = 'test-attach';
const state = getOffice(OFFICE);
state.setStateFile(join(tmp, 'o-1.json'));
const root = state.attachmentsDir();

const env: AttachmentsHttpEnv = {
  office: (wanted) => (wanted === null || wanted === OFFICE ? state : { code: 404, error: 'нет офиса' }),
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

interface Reply { code: number; headers: Record<string, string>; body: Buffer }

function http(
  method: string, path: string, opts: { body?: Buffer | Readable; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const [url = '/', query = ''] = path.split('?');
  const stream = opts.body instanceof Readable ? opts.body : Readable.from(opts.body ? [opts.body] : []);
  const req = Object.assign(stream, { method, headers: opts.headers ?? {} });
  return new Promise((done) => {
    let code = 0;
    let headers: Record<string, string> = {};
    const res = {
      headersSent: false,
      writeHead(c: number, h: Record<string, string> = {}) { code = c; headers = h; return res; },
      end(body?: string | Buffer) { done({ code, headers, body: Buffer.from(body ?? '') }); },
    };
    assert.ok(handleChatAttachment(req as never, res as never, url, query, env), `${path} не распознан`);
  });
}

const asJson = (r: Reply): Record<string, unknown> => JSON.parse(r.body.toString('utf8')) as Record<string, unknown>;

async function upload(chat: string, name: string, bytes: Buffer, type = ''): Promise<Reply> {
  const q = new URLSearchParams({ office: OFFICE, chat, name });
  return http('POST', `/api/chat/attachment?${q}`, { body: bytes, headers: type ? { 'content-type': type } : {} });
}

try {
  console.log('загрузка');

  let png!: ChatAttachment;
  await check('POST кладёт файл в папку вложений офиса и отвечает { id, name, size, mime, url }', async () => {
    const r = await upload('C-1', 'shot.png', PNG, 'image/png');
    assert.equal(r.code, 200, r.body.toString());
    png = asJson(r) as unknown as ChatAttachment;
    assert.deepEqual(Object.keys(png).sort(), ['id', 'mime', 'name', 'size', 'url']);
    assert.match(png.id, /^[a-f0-9]{16}$/);
    assert.equal(png.name, 'shot.png');
    assert.equal(png.size, PNG.length);
    assert.equal(png.mime, 'image/png');
    assert.equal(png.url, `/api/chat/attachment?office=${OFFICE}&chat=C-1&id=${png.id}`);
    const file = join(root, 'C-1', png.id, 'shot.png');
    assert.ok(readFileSync(file).equals(PNG), 'байты на диске те же');
    assert.ok(root.startsWith(join(tmp, 'o-1')), `папка рядом с состоянием: ${root}`);
  });

  await check('имя без пути и мусора: ../, абсолютный путь, диск Windows, управляющие символы', async () => {
    assert.equal(cleanAttachmentName('../../etc/passwd'), 'passwd');
    assert.equal(cleanAttachmentName('/abs/dir/report.pdf'), 'report.pdf');
    assert.equal(cleanAttachmentName('C:\\Users\\me\\..\\notes.txt'), 'notes.txt');
    assert.equal(cleanAttachmentName('..'), 'file');
    assert.equal(cleanAttachmentName(''), 'file');
    assert.equal(cleanAttachmentName('a\u0000b<c>.txt'), 'a_b_c_.txt');
    assert.equal(cleanAttachmentName('trail. . '), 'trail');
    const long = cleanAttachmentName(`${'я'.repeat(300)}.md`);
    assert.equal([...long].length, 120);
    assert.ok(long.endsWith('.md'));
    const r = await upload('C-1', '../../../escape.txt', Buffer.from('hi'), 'text/plain');
    assert.equal(r.code, 200);
    const a = asJson(r) as unknown as ChatAttachment;
    assert.equal(a.name, 'escape.txt');
    assert.ok(existsSync(join(root, 'C-1', a.id, 'escape.txt')), 'лёг внутри папки вложений');
    assert.ok(!existsSync(join(tmp, 'escape.txt')) && !existsSync(join(root, 'escape.txt')));
  });

  await check('имя из заголовка X-File-Name, тип по расширению при пустом Content-Type', async () => {
    const r = await http('POST', `/api/chat/attachment?office=${OFFICE}&chat=C-2`, {
      body: Buffer.from('a,b\n'), headers: { 'x-file-name': encodeURIComponent('таблица.csv') },
    });
    assert.equal(r.code, 200, r.body.toString());
    const a = asJson(r) as unknown as ChatAttachment;
    assert.equal(a.name, 'таблица.csv');
    assert.equal(a.mime, 'text/csv');
  });

  await check('без chat — папка inbox (реплика с главного экрана)', async () => {
    const r = await http('POST', `/api/chat/attachment?office=${OFFICE}&name=x.txt`, { body: Buffer.from('x') });
    assert.equal(r.code, 200);
    const a = asJson(r) as unknown as ChatAttachment;
    assert.ok(existsSync(join(root, 'inbox', a.id, 'x.txt')));
  });

  console.log('потолки');

  await check('больше 20 МБ по Content-Length — 413 без чтения тела', async () => {
    const r = await http('POST', `/api/chat/attachment?office=${OFFICE}&chat=C-3&name=big.bin`, {
      body: Buffer.alloc(1), headers: { 'content-length': String(ATTACHMENT_MAX_BYTES + 1) },
    });
    assert.equal(r.code, 413);
    assert.match(String(asJson(r).error), /больше 20 МБ/);
  });

  await check('больше 20 МБ по факту (без длины) — 413, на диске ничего', async () => {
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 10);
    const r = await http('POST', `/api/chat/attachment?office=${OFFICE}&chat=C-3&name=big.bin`, {
      body: Readable.from([big.subarray(0, 1 << 20), big.subarray(1 << 20)]),
    });
    assert.equal(r.code, 413);
    assert.ok(!existsSync(join(root, 'C-3')), 'папки чата нет — файл не сохранён');
  });

  await check('ровно 20 МБ — принимается', async () => {
    const r = await upload('C-3', 'edge.bin', Buffer.alloc(ATTACHMENT_MAX_BYTES, 1));
    assert.equal(r.code, 200, r.body.toString());
  });

  await check('пустой файл — 400', async () => {
    const r = await upload('C-4', 'empty.txt', Buffer.alloc(0));
    assert.equal(r.code, 400);
  });

  const ten: ChatAttachment[] = [];
  await check(`${ATTACHMENTS_PER_MESSAGE} неотправленных в чате — следующий 400`, async () => {
    for (let i = 0; i < ATTACHMENTS_PER_MESSAGE; i++) {
      const r = await upload('C-5', `f${i}.txt`, Buffer.from(String(i)));
      assert.equal(r.code, 200);
      ten.push(asJson(r) as unknown as ChatAttachment);
    }
    const r = await upload('C-5', 'eleven.txt', Buffer.from('11'));
    assert.equal(r.code, 400);
    assert.match(String(asJson(r).error), /не больше 10 файлов/);
  });

  await check('DELETE неотправленного освобождает место', async () => {
    const r = await http('DELETE', `/api/chat/attachment?office=${OFFICE}&chat=C-5&id=${ten[9]!.id}`);
    assert.equal(r.code, 200);
    assert.equal(findAttachment(state, ten[9]!.id), null);
    assert.equal((await upload('C-5', 'again.txt', Buffer.from('a'))).code, 200);
  });

  console.log('отдача');

  await check('GET по url из ответа отдаёт картинку inline', async () => {
    const r = await http('GET', png.url);
    assert.equal(r.code, 200);
    assert.ok(r.body.equals(PNG));
    assert.equal(r.headers['Content-Type'], 'image/png');
    assert.match(r.headers['Content-Disposition'] ?? '', /^inline/);
    assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  });

  await check('не картинка — скачиванием, а не открытием на нашем источнике', async () => {
    const html = asJson(await upload('C-1', 'page.html', Buffer.from('<script>alert(1)</script>'), 'text/html')) as unknown as ChatAttachment;
    const r = await http('GET', html.url);
    assert.equal(r.code, 200);
    assert.match(r.headers['Content-Disposition'] ?? '', /^attachment/);
    assert.match(r.headers['Content-Security-Policy'] ?? '', /sandbox/);
  });

  await check('путь вне папки: кривой id и чат — 400, чужой чат — 404', async () => {
    for (const id of ['../../o-1.json', '..', png.id.slice(1), `${png.id}/../x`]) {
      const r = await http('GET', `/api/chat/attachment?office=${OFFICE}&chat=C-1&id=${encodeURIComponent(id)}`);
      assert.equal(r.code, 400, id);
    }
    for (const chat of ['..', '../..', 'C-1/../..', '/etc']) {
      const r = await http('GET', `/api/chat/attachment?office=${OFFICE}&chat=${encodeURIComponent(chat)}&id=${png.id}`);
      assert.equal(r.code, 400, chat);
    }
    const r = await http('GET', `/api/chat/attachment?office=${OFFICE}&chat=C-2&id=${png.id}`);
    assert.equal(r.code, 404);
  });

  await check('символическая ссылка из папки вложений наружу — 404', async () => {
    const outside = join(tmp, 'secret.txt');
    writeFileSync(outside, 'тайна');
    const id = 'aaaaaaaaaaaaaaaa';
    mkdirSync(join(root, 'C-1', id), { recursive: true });
    symlinkSync(outside, join(root, 'C-1', id, 'link.txt'));
    writeFileSync(join(root, 'C-1', `${id}.json`), JSON.stringify({ id, name: 'link.txt', size: 5, mime: 'text/plain', chat: 'C-1', at: Date.now() }));
    const r = await http('GET', `/api/chat/attachment?office=${OFFICE}&chat=C-1&id=${id}`);
    assert.equal(r.code, 404);
    // Метаданные с именем-путём тоже не ведут наружу.
    const id2 = 'bbbbbbbbbbbbbbbb';
    writeFileSync(join(root, 'C-1', `${id2}.json`), JSON.stringify({ id: id2, name: '../../../secret.txt', size: 5, mime: 'text/plain', chat: 'C-1', at: Date.now() }));
    assert.equal((await http('GET', `/api/chat/attachment?office=${OFFICE}&chat=C-1&id=${id2}`)).code, 404);
  });

  await check('чужой метод — 405', async () => {
    assert.equal((await http('PUT', png.url)).code, 405);
  });

  console.log('сообщение менеджеру');

  await check('картинка — блоком image (base64), текстовый файл — путём, именем и размером в тексте', () => {
    const img = findAttachment(state, png.id)!;
    const csvId = ten[0]!.id;
    const txt = findAttachment(state, csvId)!;
    const content = pmContent(state, 'Посмотри', [img, txt]);
    assert.ok(Array.isArray(content), 'с картинкой — блоки');
    const blocks = content as Array<Record<string, any>>;
    assert.equal(blocks[0]!.type, 'text');
    const text = String(blocks[0]!.text);
    assert.match(text, /^Посмотри\n\n\[Вложения владельца\]/);
    assert.ok(text.includes(attachmentPath(state, txt.meta)), 'абсолютный путь файла');
    assert.ok(text.includes('«f0.txt», 1 Б'), text);
    assert.equal(blocks[1]!.type, 'image');
    assert.deepEqual(blocks[1]!.source, { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') });
  });

  await check('без картинок — одной строкой с путём', () => {
    const txt = findAttachment(state, ten[1]!.id)!;
    const content = pmContent(state, '', [txt]);
    assert.equal(typeof content, 'string');
    assert.ok(String(content).startsWith('[Вложения владельца]\n- /'), String(content));
    assert.ok(String(content).includes(txt.file));
  });

  await check('«png», который не png, — файлом, а не картинкой', () => {
    assert.equal(sniffImage(Buffer.from('not an image')), null);
    assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
    const saved = saveAttachment(state, { chat: 'C-7', name: 'fake.png', mime: 'image/png', bytes: Buffer.from('not an image') });
    assert.ok(saved.ok);
    const content = pmContent(state, 'x', [findAttachment(state, saved.attachment.id)!]);
    assert.equal(typeof content, 'string');
  });

  await check('файл-секрет (.env) — без пути', async () => {
    const r = await upload('C-6', '.env', Buffer.from('TOKEN=1'));
    const a = asJson(r) as unknown as ChatAttachment;
    assert.equal(a.name, '.env', 'имя сохраняется, чтобы фильтр секретов его узнал');
    const found = findAttachment(state, a.id)!;
    const content = String(pmContent(state, '', [found]));
    assert.ok(!content.includes(found.file), content);
    assert.match(content, /похоже на секрет/);
  });

  await check('реплика владельца: метаданные в истории чата, менеджеру — блоки', async () => {
    const chat = state.createPmChat('Вложения');
    const pm = state.pmSession(chat.id);
    pm.rotating = true;   // сессия «ужимается» — реплика ляжет в pending, SDK не нужен
    const doc = asJson(await upload(chat.id, 'spec.md', Buffer.from('# Спека'), 'text/markdown')) as unknown as ChatAttachment;
    const pic = asJson(await upload(chat.id, 'ui.png', PNG, 'image/png')) as unknown as ChatAttachment;
    sendUserMessage(state, 'Вот файлы', chat.id, [doc.id, pic.id, doc.id, 'ffffffffffffffff']);
    const entry = state.chat.filter((e) => e.chatId === chat.id && e.from === 'user').at(-1)!;
    assert.equal(entry.text, 'Вот файлы');
    assert.deepEqual(entry.attachments, [doc, pic]);
    assert.deepEqual(state.toPersisted().chat.find((e) => e.id === entry.id)?.attachments, [doc, pic], 'попадает в state.json');
    const lost = state.chat.filter((e) => e.chatId === chat.id && e.from !== 'user').at(-1)!;
    assert.match(lost.text, /ffffffffffffffff/);
    assert.equal(pm.pending.length, 1);
    const sent = pm.pending[0]!.text as Array<Record<string, any>>;
    assert.equal(sent[0]!.type, 'text');
    assert.ok(String(sent[0]!.text).includes(join(root, chat.id, doc.id, 'spec.md')));
    assert.equal(sent[1]!.type, 'image');
    // Отправленное убрать уже нельзя и в счёт потолка оно не идёт.
    assert.equal((await http('DELETE', `/api/chat/attachment?office=${OFFICE}&chat=${chat.id}&id=${doc.id}`)).code, 409);
  });

  await check('только вложения без текста — тоже реплика', () => {
    const chat = state.createPmChat('Без текста');
    const pm = state.pmSession(chat.id);
    pm.rotating = true;
    const a = findAttachment(state, ten[2]!.id)!;
    sendUserMessage(state, '', chat.id, [a.meta.id]);
    assert.equal(pm.pending.length, 1);
    assert.equal(state.chat.filter((e) => e.chatId === chat.id && e.from === 'user').at(-1)!.attachments?.length, 1);
  });

  await check(`больше ${ATTACHMENTS_PER_MESSAGE} в реплике — не уходит, владельцу объяснение`, () => {
    const chat = state.createPmChat('Много');
    const pm = state.pmSession(chat.id);
    pm.rotating = true;
    sendUserMessage(state, 'много', chat.id, Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(16, '0')));
    assert.equal(pm.pending.length, 0);
    assert.equal(state.chat.filter((e) => e.chatId === chat.id && e.from === 'user').length, 0);
    assert.match(state.chat.filter((e) => e.chatId === chat.id).at(-1)!.text, /не больше 10 файлов/);
  });

  console.log('чтение менеджером');

  await check('папка вложений — в корнях чтения PM без вопроса, секрет в ней — отказ', () => {
    const scope = pmReadScope(state);
    const file = findAttachment(state, ten[3]!.id)!.file;
    assert.equal(classifyPmRead('Read', { file_path: file }, scope, 'ru').risk, 'safe');
    const envId = readdirSync(join(root, 'C-6')).find((n) => /^[a-f0-9]{16}$/.test(n))!;
    const verdict = classifyPmRead('Read', { file_path: join(root, 'C-6', envId, '.env') }, scope, 'ru');
    assert.equal(verdict.deny, true);
    const elsewhere = join(tmp, 'secret.txt');
    assert.equal(classifyPmRead('Read', { file_path: elsewhere }, scope, 'ru').risk, 'danger', 'рядом с папкой — снаружи');
  });

  console.log(`\nвсё в порядке: ${passed} проверок`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

