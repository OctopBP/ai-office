/**
 * Вложения чата с менеджером (T-699): владелец прикладывает файлы к реплике,
 * сервер хранит их в служебной папке офиса и передаёт менеджеру.
 *
 *   POST   /api/chat/attachment?office=<id>&chat=<чат>&name=<имя>  — загрузить (тело — сам файл);
 *   GET    /api/chat/attachment?office=<id>&chat=<чат>&id=<id>     — отдать (превью на вебе);
 *   DELETE /api/chat/attachment?office=<id>&chat=<чат>&id=<id>     — убрать ещё не отправленное.
 *
 * Тело POST — файл целиком, тип — из `Content-Type` запроса: как у аватарки
 * офиса (officeicon.ts), multipart не разбираем. Имя — параметром `name` или
 * заголовком `X-File-Name` (в URI-кодировке). `chat` можно не давать: реплика
 * с главного экрана уходит в чат, которого ещё нет, — тогда файл ложится в
 * папку `inbox`.
 *
 * Раскладка: `<папка состояния>.attachments/<чат>/<id>/<имя>` и рядом
 * `<чат>/<id>.json` с метаданными. Своя папка у каждого файла — чтобы на
 * диске лежало настоящее имя: фильтр секретов менеджера (pm-read.ts) судит
 * по имени файла, и `.env` владельца остаётся для него `.env`, а не
 * «a1b2-.env», мимо фильтра.
 *
 * Потолки: файл до ATTACHMENT_MAX_BYTES, к одному сообщению — до
 * ATTACHMENTS_PER_MESSAGE файлов. Второе проверяется дважды: при загрузке
 * (неотправленных в чате не больше потолка) и при отправке реплики.
 *
 * Отдача — по тем же правилам, что у /api/file: чтение без отдельного входа,
 * но только по id из этой папки, без пути в запросе, с проверкой настоящего
 * пути после символических ссылок.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_MESSAGE, type ChatAttachment } from '../shared/types';
import { c } from './i18n';
import { currentOffice, officeById } from './offices';
import { secretWhy } from './pm-read';
import type { UserContent } from './queue';
import { readBody } from './officeicon';
import { getOffice, isOpened, type OfficeState } from './state';

/** Папка для файлов реплики, у которой чата ещё нет (реплика с главного экрана). */
export const INBOX_CHAT = 'inbox';

/**
 * Сколько живёт неотправленное вложение в счёте потолка «файлов на сообщение».
 * Владелец мог приложить файл и закрыть окно — такой не должен навсегда
 * съесть место в следующей реплике.
 */
const UNSENT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Картинка уходит менеджеру блоком контента, только если она не больше этого:
 * у API потолок 5 МБ на картинку в base64, а base64 на треть длиннее файла.
 * Крупнее — путём в тексте, как прочие файлы.
 */
export const IMAGE_INLINE_MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

/** Длина имени файла на диске (в символах), с расширением. */
const NAME_MAX = 120;

/** Метаданные вложения на диске (`<чат>/<id>.json`). */
export interface StoredAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  chat: string;
  at: number;
  /** Ушло с репликой владельца — убрать его уже нельзя, в счёт потолка не идёт. */
  sent?: boolean;
}

// ------------------------------------------------------------ имена и пути

/**
 * Имя файла из запроса — к безопасному виду: только последний сегмент пути
 * (оба вида слешей), без управляющих символов и запрещённых в Windows знаков,
 * без точек и пробелов в конце; имя из одних точек («..») — «file». Длинное
 * обрезается с сохранением расширения.
 */
export function cleanAttachmentName(raw: string | null | undefined): string {
  const last = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  let name = last.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  name = name.replace(/[. ]+$/, '');
  if (!name || /^\.+$/.test(name)) return 'file';
  const chars = [...name];
  if (chars.length <= NAME_MAX) return name;
  const ext = extname(name);
  const extChars = ext.length <= 16 ? [...ext] : [];
  return chars.slice(0, NAME_MAX - extChars.length).join('') + extChars.join('');
}

/** Чат из запроса: нет — `inbox`, допустимые символы — иначе null (отказ). */
export function cleanChatFolder(raw: string | null | undefined): string | null {
  const chat = (raw ?? '').trim();
  if (!chat) return INBOX_CHAT;
  return /^[A-Za-z0-9_-]{1,64}$/.test(chat) ? chat : null;
}

const ID_RE = /^[a-f0-9]{16}$/;

export const isAttachmentId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

/** Адрес отдачи вложения — его и показывает веб. */
export function attachmentUrl(officeId: string, chat: string, id: string): string {
  const q = new URLSearchParams({ office: officeId, chat, id });
  return `/api/chat/attachment?${q.toString()}`;
}

export function attachmentView(state: OfficeState, a: StoredAttachment): ChatAttachment {
  return { id: a.id, name: a.name, size: a.size, mime: a.mime, url: attachmentUrl(state.officeId, a.chat, a.id) };
}

/** Абсолютный путь файла вложения. */
export function attachmentPath(state: OfficeState, a: Pick<StoredAttachment, 'chat' | 'id' | 'name'>): string {
  return join(resolve(state.attachmentsDir()), a.chat, a.id, a.name);
}

const metaPath = (state: OfficeState, chat: string, id: string): string =>
  join(resolve(state.attachmentsDir()), chat, `${id}.json`);

/** Лежит ли настоящий путь внутри настоящей папки вложений. */
function insideRoot(state: OfficeState, path: string): boolean {
  try {
    const top = realpathSync(resolve(state.attachmentsDir()));
    const rel = relative(top, realpathSync(path));
    return Boolean(rel) && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ тип файла

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
  '.html': 'text/html', '.zip': 'application/zip',
};

/** Тип из заголовка запроса, если он похож на тип; иначе — по расширению. */
export function attachmentMime(header: string | null | undefined, name: string): string {
  const raw = String(header ?? '').split(';')[0]!.trim().toLowerCase();
  if (/^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(raw) && raw !== 'application/octet-stream') return raw;
  return EXT_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Настоящий тип картинки по первым байтам — из тех, что понимает модель.
 * Тип из заголовка не годится: «.png», который на деле не png, сломал бы
 * ход менеджера отказом API.
 */
export function sniffImage(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// ------------------------------------------------------------ хранение

function readMeta(state: OfficeState, chat: string, id: string): StoredAttachment | null {
  try {
    const raw = JSON.parse(readFileSync(metaPath(state, chat, id), 'utf8')) as StoredAttachment;
    if (raw.id !== id || raw.chat !== chat || typeof raw.name !== 'string') return null;
    if (cleanAttachmentName(raw.name) !== raw.name) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Все вложения чата (по метаданным). */
function chatAttachments(state: OfficeState, chat: string): StoredAttachment[] {
  let names: string[];
  try {
    names = readdirSync(join(resolve(state.attachmentsDir()), chat));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && isAttachmentId(n.slice(0, -5)))
    .map((n) => readMeta(state, chat, n.slice(0, -5)))
    .filter((a): a is StoredAttachment => a !== null);
}

/** Сколько в чате неотправленных вложений — они займут место в следующей реплике. */
export function unsentCount(state: OfficeState, chat: string, now = Date.now()): number {
  return chatAttachments(state, chat).filter((a) => !a.sent && now - a.at < UNSENT_TTL_MS).length;
}

export type SaveResult =
  | { ok: true; attachment: StoredAttachment }
  | { ok: false; code: number; error: string };

/** Сохранить файл вложения. Проверки потолков — здесь, а не в HTTP-ручке. */
export function saveAttachment(
  state: OfficeState,
  input: { chat: string; name: string; mime: string; bytes: Buffer },
): SaveResult {
  const { chat, bytes } = input;
  const name = cleanAttachmentName(input.name);
  if (!bytes.length) return { ok: false, code: 400, error: state.say('attach.empty', { name }) };
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    return { ok: false, code: 413, error: tooBig(name, (k, v) => state.say(k, v)) };
  }
  if (unsentCount(state, chat) >= ATTACHMENTS_PER_MESSAGE) {
    return { ok: false, code: 400, error: state.say('attach.tooMany', { max: ATTACHMENTS_PER_MESSAGE }) };
  }
  const attachment: StoredAttachment = {
    id: randomBytes(8).toString('hex'), name, size: bytes.length,
    mime: attachmentMime(input.mime, name), chat, at: Date.now(),
  };
  try {
    const file = attachmentPath(state, attachment);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, bytes);
    writeFileSync(metaPath(state, chat, attachment.id), JSON.stringify(attachment));
  } catch (err) {
    return { ok: false, code: 500, error: state.say('attach.io', { error: (err as Error).message }) };
  }
  return { ok: true, attachment };
}

function tooBig(name: string, say: (k: 'attach.tooBig', v: Record<string, string | number>) => string): string {
  const mb = (n: number): number => Math.round((n / 1024 / 1024) * 10) / 10;
  return say('attach.tooBig', { name, max: mb(ATTACHMENT_MAX_BYTES) });
}

/**
 * Вложение и его файл по чату и id. null — нет такого или путь, после всех
 * ссылок, ушёл из папки вложений.
 */
export function attachmentFile(state: OfficeState, chat: string, id: string): { meta: StoredAttachment; file: string } | null {
  if (!isAttachmentId(id) || cleanChatFolder(chat) !== chat) return null;
  const meta = readMeta(state, chat, id);
  if (!meta) return null;
  const file = attachmentPath(state, meta);
  if (!existsSync(file) || !insideRoot(state, file)) return null;
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { meta, file };
}

/** Найти вложение по id в любом чате офиса: реплика с главного экрана грузит в `inbox`. */
export function findAttachment(state: OfficeState, id: string): { meta: StoredAttachment; file: string } | null {
  if (!isAttachmentId(id)) return null;
  let chats: string[];
  try {
    chats = readdirSync(resolve(state.attachmentsDir()));
  } catch {
    return null;
  }
  for (const chat of chats) {
    if (cleanChatFolder(chat) !== chat || !existsSync(metaPath(state, chat, id))) continue;
    const found = attachmentFile(state, chat, id);
    if (found) return found;
  }
  return null;
}

/**
 * Забрать вложения для реплики владельца: найти по id (повторы — один раз),
 * пометить отправленными. Ненайденные — в `lost`, их владельцу назовут.
 */
export function takeAttachments(
  state: OfficeState, ids: readonly unknown[],
): { taken: { meta: StoredAttachment; file: string }[]; lost: string[] } {
  const taken: { meta: StoredAttachment; file: string }[] = [];
  const lost: string[] = [];
  for (const id of [...new Set(ids.map((x) => String(x)))]) {
    const found = findAttachment(state, id);
    if (!found) {
      lost.push(id);
      continue;
    }
    if (!found.meta.sent) {
      found.meta.sent = true;
      try {
        writeFileSync(metaPath(state, found.meta.chat, found.meta.id), JSON.stringify(found.meta));
      } catch { /* пометка не легла — вложение просто дольше займёт место в счёте */ }
    }
    taken.push(found);
  }
  return { taken, lost };
}

/** Убрать неотправленное вложение (владелец передумал). */
export function removeAttachment(state: OfficeState, chat: string, id: string): { ok: true } | { ok: false; code: number; error: string } {
  const found = attachmentFile(state, chat, id);
  if (!found) return { ok: false, code: 404, error: state.say('attach.notFound', { id, chat }) };
  if (found.meta.sent) return { ok: false, code: 409, error: state.say('attach.sent') };
  rmSync(join(found.file, '..'), { recursive: true, force: true });
  rmSync(metaPath(state, chat, id), { force: true });
  return { ok: true };
}

// ------------------------------------------------------------ сообщение менеджеру

function sizeText(state: OfficeState, bytes: number): string {
  if (bytes < 1024) return state.say('attach.size.b', { n: bytes });
  if (bytes < 1024 * 1024) return state.say('attach.size.kb', { n: Math.round(bytes / 1024) });
  return state.say('attach.size.mb', { n: Math.round((bytes / 1024 / 1024) * 10) / 10 });
}

/**
 * Содержимое пользовательского сообщения менеджеру с вложениями. Картинки
 * (png, jpeg, gif, webp по первым байтам, до IMAGE_INLINE_MAX_BYTES) — блоками
 * image в base64; остальное — строкой с абсолютным путём, именем и размером,
 * чтобы менеджер открыл файл своим Read. Похожее на секрет по имени — без
 * пути: менеджер секреты не читает, и вложение этого не меняет. Без вложений —
 * просто текст, как было.
 */
export function pmContent(
  state: OfficeState,
  text: string,
  taken: readonly { meta: StoredAttachment; file: string }[],
  read: (file: string) => Buffer = (file) => readFileSync(file),
): UserContent {
  if (!taken.length) return text;
  const lines: string[] = [];
  const images: { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }[] = [];
  for (const { meta, file } of taken) {
    const size = sizeText(state, meta.size);
    if (secretWhy(file)) {
      lines.push(state.say('attach.pm.secret', { name: meta.name, size }));
      continue;
    }
    let image: ReturnType<typeof sniffImage> = null;
    let bytes: Buffer | null = null;
    if (meta.size <= IMAGE_INLINE_MAX_BYTES) {
      try {
        bytes = read(file);
        image = sniffImage(bytes);
      } catch { /* не читается — пусть менеджер попробует сам по пути */ }
    }
    if (image && bytes) {
      images.push({ type: 'image', source: { type: 'base64', media_type: image, data: bytes.toString('base64') } });
      lines.push(state.say('attach.pm.image', { name: meta.name, size, path: file }));
    } else {
      lines.push(state.say('attach.pm.file', { name: meta.name, size, mime: meta.mime, path: file }));
    }
  }
  const body = [text.trim(), `${state.say('attach.pm.header')}\n${lines.join('\n')}`].filter(Boolean).join('\n\n');
  if (!images.length) return body;
  return [{ type: 'text', text: body }, ...images] as UserContent;
}

// ------------------------------------------------------------ HTTP

/** Откуда ручка берёт офис. Подменяется в проверке (scripts/test-attachments.ts). */
export interface AttachmentsHttpEnv {
  office: (wanted: string | null) => OfficeState | { code: number; error: string };
}

const defaultEnv: AttachmentsHttpEnv = {
  office: (wanted) => {
    const office = wanted ? officeById(wanted) : currentOffice();
    if (!office) return { code: 404, error: c('offices.notFound', { id: wanted ?? '' }) };
    // Папка вложений берётся из файла состояния: офис ради запроса не поднимаем.
    if (!isOpened(office.id)) return { code: 503, error: c('attach.closed', { office: office.name }) };
    return getOffice(office.id);
  },
};

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function headerName(req: IncomingMessage): string | null {
  const raw = req.headers?.['x-file-name'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function serve(req: IncomingMessage, res: ServerResponse, query: string, env: AttachmentsHttpEnv): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
    json(res, 405, { error: c('attach.method') }, { Allow: 'GET, POST, DELETE' });
    return;
  }
  const params = new URLSearchParams(query);
  const state = env.office(params.get('office'));
  if ('error' in state) {
    json(res, state.code, { error: state.error });
    return;
  }
  const chat = cleanChatFolder(params.get('chat'));
  if (!chat) {
    json(res, 400, { error: state.say('attach.badChat', { chat: params.get('chat') ?? '' }) });
    return;
  }

  if (method === 'POST') {
    const name = cleanAttachmentName(params.get('name') ?? headerName(req));
    // Длина известна заранее — отказываем, не читая тела.
    const declared = Number(req.headers?.['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) {
      json(res, 413, { error: tooBig(name, (k, v) => state.say(k, v)) }, { Connection: 'close' });
      return;
    }
    const body = await readBody(req, ATTACHMENT_MAX_BYTES);
    if ('over' in body) {
      json(res, 413, { error: tooBig(name, (k, v) => state.say(k, v)) }, { Connection: 'close' });
      return;
    }
    if ('cut' in body) {
      json(res, 400, { error: `${state.say('attach.cut')} ${body.cut}` });
      return;
    }
    const saved = saveAttachment(state, {
      chat, name, mime: String(req.headers?.['content-type'] ?? ''), bytes: body.bytes,
    });
    if (!saved.ok) {
      json(res, saved.code, { error: saved.error });
      return;
    }
    json(res, 200, attachmentView(state, saved.attachment));
    return;
  }

  const id = params.get('id') ?? '';
  if (!isAttachmentId(id)) {
    json(res, 400, { error: state.say('attach.badId', { id }) });
    return;
  }
  if (method === 'DELETE') {
    const removed = removeAttachment(state, chat, id);
    if (!removed.ok) json(res, removed.code, { error: removed.error });
    else json(res, 200, { ok: true });
    return;
  }

  const found = attachmentFile(state, chat, id);
  if (!found) {
    json(res, 404, { error: state.say('attach.notFound', { id, chat }) });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(found.file);
  } catch {
    json(res, 404, { error: state.say('attach.notFound', { id, chat }) });
    return;
  }
  // Картинку — как есть для превью; остальное — скачиванием: файл пришёл
  // извне, и html или svg на нашем источнике открываться не должны.
  const image = sniffImage(bytes);
  res.writeHead(200, {
    'Content-Type': image ?? found.meta.mime,
    'Content-Length': String(bytes.length),
    'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.meta.name)}`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(bytes);
}

/** Разобрать запрос, если он про вложения чата. `false` — адрес не наш. */
export function handleChatAttachment(
  req: IncomingMessage, res: ServerResponse, url: string, query: string, env: AttachmentsHttpEnv = defaultEnv,
): boolean {
  if (url !== '/api/chat/attachment') return false;
  serve(req, res, query, env).catch((err: unknown) => {
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
  return true;
}
