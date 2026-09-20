/**
 * HTTP вокруг аватарки офиса: отдать картинку, загрузить новую, снять.
 *
 * Отдельным файлом от index.ts потому, что это единственная ручка офиса,
 * которая принимает из сети байты файла и кладёт их на диск: потолок размера,
 * проверка типа и рассылка нового состояния должны лежать рядом друг с другом,
 * а не растворяться среди прочих маршрутов.
 *
 * Маршрутов два, и права у них разные:
 *   GET    /api/office-icon?office=<id>&v=<версия>  — сама картинка;
 *   POST   /api/office/icon?office=<id>             — загрузить (тело — файл);
 *   DELETE /api/office/icon?office=<id>             — снять и стереть файл.
 *
 * Читать может кто угодно, писать — только два метода на другом адресе:
 * общий адрес на чтение и запись смешивал бы права.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { c } from './i18n';
import { broadcastOffices, broadcastSnapshot } from './office-api';
import { getOffice, isOpened } from './state';
import {
  clearOfficeIcon, currentOffice, ICON_MAX_BYTES, ICON_UPLOAD_TYPES, officeById, officeIconFile,
  saveOfficeIcon,
} from './offices';

/**
 * С каким типом отдаётся файл. Таблица своя, а не общая с раздачей статики:
 * иконкой может быть только картинка, и список здесь — заодно проверка, что
 * наружу уходит именно она.
 */
const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Прочитать тело запроса, не давая ему расти дальше потолка. Копить мегабайты
 * в памяти ради того, чтобы потом отказать по размеру, незачем: как только
 * потолок пройден, принятое выбрасывается, а дальнейшее уходит в никуда.
 * Обрывать приём на середине нельзя — вместе с сокетом умер бы и ответ,
 * который надо отдать.
 */
export function readBody(req: IncomingMessage, limit: number):
  Promise<{ bytes: Buffer } | { over: number } | { cut: string }> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    req.on('data', (chunk: Buffer) => {
      if (stopped) return;
      size += chunk.length;
      if (size > limit) {
        stopped = true;
        chunks.length = 0;
        done({ over: size });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!stopped) done({ bytes: Buffer.concat(chunks) }); });
    req.on('error', (err: Error) => { if (!stopped) done({ cut: err.message }); });
  });
}

/** Смена аватарки видна всем: и в рейле офисов, и на открытой доске. */
function announce(officeId: string): void {
  broadcastOffices();
  // Список офисов лежит и внутри снимка состояния — без этого открытая доска
  // показывала бы прежнюю иконку до следующего события.
  if (isOpened(officeId)) broadcastSnapshot(getOffice(officeId));
}

/**
 * Отдать картинку офиса. Путь ручка не принимает — только id: иначе она стала
 * бы способом прочитать любой файл на машине. Что сохранённый путь не ведёт за
 * пределы офиса, проверяет officeIconFile.
 */
function serveRead(req: IncomingMessage, res: ServerResponse, query: string): void {
  if (req.method !== 'GET') {
    json(res, 405, { error: c('boot.officesGetOnly') }, { Allow: 'GET' });
    return;
  }
  // Без `office` — открытый последним: адрес картинки собирает сервер и офис
  // в нём всегда есть, но руками ручку дёргают и без параметра.
  const id = new URLSearchParams(query).get('office') ?? '';
  const office = id ? officeById(id) : currentOffice();
  const file = office ? officeIconFile(office) : null;
  let body: Buffer | null = null;
  try {
    if (file) body = readFileSync(file);
  } catch {
    body = null;   // файл стёрли между сохранением иконки и запросом
  }
  if (!body || !file) {
    json(res, 404, { error: c('boot.noIcon', { office: id || office?.id || '' }) });
    return;
  }
  res.writeHead(200, {
    'Content-Type': ICON_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    // Кеш браузера не должен показывать вчерашнюю аватарку после смены: пусть
    // спрашивает каждый раз. Адрес всё равно несёт версию файла (`&v=`).
    'Cache-Control': 'no-cache',
    // Тип не угадывать: файл сюда попадает извне, и «а вдруг это html»
    // браузеру думать не надо.
    'X-Content-Type-Options': 'nosniff',
    // SVG — документ, в котором бывают скрипты. В <img> они не выполняются, но
    // адрес картинки можно открыть и вкладкой, а там это был бы чужой скрипт
    // на нашем источнике.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(body);
}

/**
 * Загрузить аватарку или снять её. Тело POST — сам файл целиком, формат берётся
 * из `Content-Type` запроса (`fetch(url, { method: 'POST', body: file })` шлёт
 * ровно это). Multipart здесь не разбирается намеренно: форм в офисе нет, а
 * разбор границ ради одного поля — лишний код в ручке, которая и так принимает
 * байты из сети.
 */
async function serveWrite(req: IncomingMessage, res: ServerResponse, query: string): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'POST' && method !== 'DELETE') {
    json(res, 405, { error: c('boot.iconMethod') }, { Allow: 'POST, DELETE' });
    return;
  }
  // Без `office` — тот, который человек открывал последним: как у журнала,
  // у запроса по HTTP нет подписки и «своего» офиса.
  const wanted = new URLSearchParams(query).get('office');
  const office = wanted ? officeById(wanted) : currentOffice();
  if (!office) {
    json(res, 404, { error: c('offices.notFound', { id: wanted ?? '' }) });
    return;
  }

  if (method === 'DELETE') {
    const problem = clearOfficeIcon(office.id);
    if (problem) {
      json(res, 409, { error: problem });
      return;
    }
    announce(office.id);
    // Иконки больше нет — так и говорим: гадать по пустому телу клиенту не надо.
    json(res, 200, { icon: null });
    return;
  }

  const type = String(req.headers['content-type'] ?? '');
  if (!type.trim()) {
    json(res, 415, { error: c('boot.iconNoType', { list: ICON_UPLOAD_TYPES.join(', ') }) });
    return;
  }
  const body = await readBody(req, ICON_MAX_BYTES);
  if ('over' in body) {
    json(res, 413, {
      error: c('offices.iconTooBig', {
        max: Math.round(ICON_MAX_BYTES / 1024), got: Math.ceil(body.over / 1024),
      }),
    }, { Connection: 'close' });
    return;
  }
  if ('cut' in body) {
    json(res, 400, { error: `${c('boot.iconCutOff')} ${body.cut}` });
    return;
  }

  const saved = saveOfficeIcon(office.id, body.bytes, type);
  if ('error' in saved) {
    const code = { office: 404, type: 415, size: 413, content: 400, io: 500 }[saved.reason];
    json(res, code, { error: saved.error });
    return;
  }
  announce(office.id);
  // Адрес новой картинки возвращаем сразу: клиенту не нужно ждать снимка,
  // чтобы показать, что загрузилось.
  json(res, 200, { icon: saved.icon });
}

/**
 * Разобрать запрос, если он про аватарку офиса. `false` — адрес не наш, пусть
 * разбирается дальше вызывающий.
 */
export function handleOfficeIcon(
  req: IncomingMessage, res: ServerResponse, url: string, query: string,
): boolean {
  if (url === '/api/office-icon') {
    serveRead(req, res, query);
    return true;
  }
  if (url === '/api/office/icon') {
    void serveWrite(req, res, query);
    return true;
  }
  return false;
}
