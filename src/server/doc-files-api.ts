/** HTTP оригиналов: тело POST — бинарные байты, X-File-Name — encodeURIComponent(имя). */
import { readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ХранилищеОригиналов, ПРЕДЕЛ_ОРИГИНАЛА } from './doc-files';
import { readDoc } from './docs';
import type { DocsHttpEnv } from './docs-api';
import { readBody } from './officeicon';
import { getOffice } from './state';

function ответ(res: ServerResponse, код: number, данные: unknown, заголовки: Record<string, string> = {}): void {
  res.writeHead(код, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...заголовки });
  res.end(JSON.stringify(данные));
}

async function обслужить(
  req: IncomingMessage, res: ServerResponse, docId: string, fileId: string | undefined,
  query: string, env: DocsHttpEnv,
): Promise<void> {
  const метод = req.method ?? 'GET';
  const методы = fileId === undefined ? ['GET', 'POST'] : ['GET', 'DELETE'];
  if (!методы.includes(метод)) return ответ(res, 405, { error: 'Метод не поддерживается' }, { Allow: методы.join(', ') });
  if (метод !== 'GET' && env.exposed() && !env.ownerSignedIn(req)) {
    return ответ(res, 403, { error: 'Изменять документы может только вошедший владелец' });
  }
  const офис = env.office(new URLSearchParams(query).get('office'));
  if ('error' in офис) return ответ(res, офис.code, { error: офис.error });

  try {
    if (!readDoc(офис.id, docId)) return ответ(res, 404, { error: 'Документ не найден' });
    const хранилище = new ХранилищеОригиналов(join(getOffice(офис.id).docsDir(), 'originals'));
    if (fileId === undefined) {
      if (метод === 'GET') {
        let имена: string[];
        try { имена = readdirSync(хранилище.корень); }
        catch (ошибка) {
          if ((ошибка as NodeJS.ErrnoException).code !== 'ENOENT') throw ошибка;
          имена = [];
        }
        const files = имена.sort().map(id => хранилище.метаданные(id))
          .filter(запись => запись !== null && запись.docId === docId);
        return ответ(res, 200, { files });
      }
      const заголовок = req.headers['x-file-name'];
      let имя: string;
      try {
        if (typeof заголовок !== 'string') throw new Error();
        имя = decodeURIComponent(заголовок);
        if (!имя.trim()) throw new Error();
      } catch { return ответ(res, 400, { error: 'Нужен X-File-Name с URL-кодированным именем файла' }); }
      const тело = await readBody(req, ПРЕДЕЛ_ОРИГИНАЛА);
      if ('over' in тело) return ответ(res, 413, { error: 'Файл превышает лимит 20 МиБ' }, { Connection: 'close' });
      if ('cut' in тело) return ответ(res, 400, { error: 'Передача файла прервана' });
      const file = хранилище.сохранить({ docId, имя, mime: req.headers['content-type'], байты: тело.bytes });
      return ответ(res, 201, { file });
    }
    const файл = хранилище.метаданные(fileId);
    if (!файл || файл.docId !== docId) return ответ(res, 404, { error: 'Оригинал не найден' });
    if (метод === 'DELETE') {
      if (!хранилище.удалить(fileId)) return ответ(res, 404, { error: 'Оригинал не найден' });
      return ответ(res, 200, { deleted: true });
    }
    const байты = хранилище.прочитать(fileId);
    if (!байты) return ответ(res, 404, { error: 'Оригинал не найден' });
    // Даже HTML/SVG всегда скачиваются; MIME не даёт браузеру исполнять оригинал.
    const имяСкачивания = encodeURIComponent(файл.имя).replace(/['()*]/g, знак =>
      '%' + знак.charCodeAt(0).toString(16).toUpperCase());
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(байты.length),
      'Content-Disposition': `attachment; filename="original"; filename*=UTF-8''${имяСкачивания}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'no-store',
    });
    res.end(байты);
  } catch (ошибка) {
    console.warn('[docs-files] сбой HTTP:', ошибка instanceof Error ? ошибка.message : String(ошибка));
    ответ(res, 500, { error: 'Не удалось обработать оригинал документа' });
  }
}

export function обработатьОригиналыHttp(
  req: IncomingMessage, res: ServerResponse, url: string, query: string, env: DocsHttpEnv,
): boolean {
  const маршрут = /^\/api\/docs\/([^/]+)\/files(?:\/([^/]+))?$/.exec(url);
  if (!маршрут) return false;
  let docId: string;
  let fileId: string | undefined;
  try {
    docId = decodeURIComponent(маршрут[1]);
    fileId = маршрут[2] === undefined ? undefined : decodeURIComponent(маршрут[2]);
  } catch {
    ответ(res, 400, { error: 'Некорректный адрес оригинала' });
    return true;
  }
  void обслужить(req, res, docId, fileId, query, env);
  return true;
}
