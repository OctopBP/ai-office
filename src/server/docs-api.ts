/**
 * HTTP вокруг библиотеки документов офиса (docs.ts), у всех — `?office=<id>`:
 *   GET  /api/docs?kind=&query=&archived=1  — оглавление;
 *   GET  /api/docs/<id>?version=N           — документ (текущий или версии N);
 *   GET  /api/docs/<id>/history             — все версии;
 *   POST /api/docs                          — завести, автор — владелец;
 *   PUT  /api/docs/<id>                     — править title, summary, body, kind;
 *   POST /api/docs/<id>/archive             — в архив, `{ archived: false }` — обратно.
 *
 * Рассылки здесь нет: docs.ts сам пишет событие `doc.*` в шину офиса, а шина
 * уже ведёт в сокеты (state.subscribeOffices → office-api.broadcast). Так
 * правка владельца по HTTP и правка агента инструментом доходят до открытого
 * окна одним путём.
 *
 * Читать может любой, кто читает журнал; менять в офисе, открытом наружу, —
 * только вошедший владелец, как и переменные (secrets-api.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DocKind } from '../shared/types';
import { createDoc, docHistory, DOC_KINDS, listDocs, readDoc, updateDoc } from './docs';
import { c } from './i18n';
import { readBody } from './officeicon';
import { currentOffice, officeById } from './offices';
import { isOpened } from './state';
import { isExposed } from './terminal';

/** Потолок тела запроса: документ — текст, мегабайта с запасом хватит. */
export const DOCS_BODY_MAX = 2 * 1024 * 1024;

/** Кто правит документ из окна: в истории версий это видно как автор. */
const OWNER = 'owner';

/**
 * Откуда ручка берёт офис и режим. Подменяется только в проверке
 * (scripts/test-docs.ts): там нет реестра офисов и живого сервера.
 */
export interface DocsHttpEnv {
  exposed: () => boolean;
  ownerSignedIn: (req: IncomingMessage) => boolean;
  /** Офис по параметру `office` (без него — открытый последним) или отказ. */
  office: (wanted: string | null) => { id: string } | { code: number; error: string };
}

const defaultEnv: DocsHttpEnv = {
  exposed: () => isExposed(),
  // Входа владельца пока нет (docs/design/remote-office): открытый наружу
  // офис документы не меняет никому.
  ownerSignedIn: () => false,
  office: (wanted) => {
    const office = wanted ? officeById(wanted) : currentOffice();
    if (!office) return { code: 404, error: c('offices.notFound', { id: wanted ?? '' }) };
    // Папка библиотеки берётся из файла состояния, а он известен только
    // открытому офису. Поднимать офис ради запроса не станем — как с журналом.
    if (!isOpened(office.id)) return { code: 503, error: c('boot.docsClosed', { office: office.name }) };
    return { id: office.id };
  },
};

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** Разобранный адрес: какой документ и что с ним. */
type Route =
  | { at: 'list' }
  | { at: 'doc'; id: string }
  | { at: 'history'; id: string }
  | { at: 'archive'; id: string };

function route(url: string): Route | null {
  if (url === '/api/docs' || url === '/api/docs/') return { at: 'list' };
  if (!url.startsWith('/api/docs/')) return null;
  const parts = url.slice('/api/docs/'.length).split('/');
  let id: string;
  try {
    id = decodeURIComponent(parts[0]);
  } catch {
    id = '';   // битая %-последовательность — docs.ts ответит «нет такого»
  }
  if (parts.length === 1) return { at: 'doc', id };
  if (parts.length === 2 && parts[1] === 'history') return { at: 'history', id };
  if (parts.length === 2 && parts[1] === 'archive') return { at: 'archive', id };
  return null;
}

const ALLOWED: Record<Route['at'], string[]> = {
  list: ['GET', 'POST'],
  doc: ['GET', 'PUT'],
  history: ['GET'],
  archive: ['POST'],
};

function isKind(v: unknown): v is DocKind {
  return typeof v === 'string' && (DOC_KINDS as readonly string[]).includes(v);
}

/** Строковое поле тела: нет — undefined, не строка — отказ. */
function str(input: Record<string, unknown>, key: string): string | undefined | Error {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : new Error(c('boot.docsBadField', { field: key }));
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, DOCS_BODY_MAX);
  if ('over' in body) {
    json(res, 413, { error: c('boot.docsTooBig', { max: DOCS_BODY_MAX / 1024 / 1024 }) }, { Connection: 'close' });
    return null;
  }
  if ('cut' in body) {
    json(res, 400, { error: c('boot.docsCutOff') });
    return null;
  }
  const text = body.bytes.toString('utf8').trim();
  if (!text) return {};
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    input = null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    json(res, 400, { error: c('boot.docsBadBody') });
    return null;
  }
  return input as Record<string, unknown>;
}

async function serve(req: IncomingMessage, res: ServerResponse, r: Route, query: string, env: DocsHttpEnv): Promise<void> {
  const method = req.method ?? 'GET';
  const allowed = ALLOWED[r.at];
  if (!allowed.includes(method)) {
    json(res, 405, { error: c('boot.docsMethod') }, { Allow: allowed.join(', ') });
    return;
  }
  if (method !== 'GET' && env.exposed() && !env.ownerSignedIn(req)) {
    json(res, 403, { error: c('boot.docsForbidden') });
    return;
  }
  const params = new URLSearchParams(query);
  const office = env.office(params.get('office'));
  if ('error' in office) {
    json(res, office.code, { error: office.error });
    return;
  }
  const notFound = (id: string) => json(res, 404, { error: c('boot.docsNotFound', { id }) });

  try {
    if (method === 'GET') {
      if (r.at === 'list') {
        const kind = params.get('kind') || undefined;
        if (kind !== undefined && !isKind(kind)) {
          json(res, 400, { error: c('boot.docsBadKind', { kind, list: DOC_KINDS.join(', ') }) });
          return;
        }
        const archived = params.get('archived');
        json(res, 200, {
          docs: listDocs(office.id, {
            kind, query: params.get('query') ?? undefined,
            includeArchived: archived === '1' || archived === 'true',
          }),
        });
        return;
      }
      if (r.at === 'history') {
        if (!readDoc(office.id, r.id)) return notFound(r.id);
        json(res, 200, { versions: docHistory(office.id, r.id) });
        return;
      }
      // r.at === 'doc'
      const raw = params.get('version');
      let version: number | undefined;
      if (raw !== null && raw !== '') {
        version = Number(raw);
        if (!Number.isInteger(version) || version < 1) {
          json(res, 400, { error: c('boot.docsBadVersion', { version: raw }) });
          return;
        }
      }
      const doc = readDoc(office.id, r.id, version);
      if (!doc) return notFound(version === undefined ? r.id : `${r.id} v${version}`);
      json(res, 200, { doc });
      return;
    }

    const input = await readJson(req, res);
    if (!input) return;

    if (r.at === 'archive') {
      const archived = input.archived === undefined ? true : input.archived;
      if (typeof archived !== 'boolean') {
        json(res, 400, { error: c('boot.docsBadField', { field: 'archived' }) });
        return;
      }
      const doc = updateDoc(office.id, r.id, { archived }, OWNER);
      if (!doc) return notFound(r.id);
      json(res, 200, { doc });
      return;
    }

    const fields: Record<string, string | undefined> = {};
    for (const key of r.at === 'list' ? ['title', 'summary', 'body', 'kind', 'taskId'] : ['title', 'summary', 'body', 'kind']) {
      const v = str(input, key);
      if (v instanceof Error) {
        json(res, 400, { error: v.message });
        return;
      }
      fields[key] = v;
    }
    if (fields.kind !== undefined && !isKind(fields.kind)) {
      json(res, 400, { error: c('boot.docsBadKind', { kind: fields.kind, list: DOC_KINDS.join(', ') }) });
      return;
    }
    const kind = fields.kind as DocKind | undefined;

    if (r.at === 'list') {
      const doc = createDoc(office.id, {
        title: fields.title ?? '', summary: fields.summary, body: fields.body, kind, taskId: fields.taskId, author: OWNER,
      });
      json(res, 201, { doc });
      return;
    }
    // r.at === 'doc', PUT
    const doc = updateDoc(office.id, r.id, { title: fields.title, summary: fields.summary, body: fields.body, kind }, OWNER);
    if (!doc) return notFound(r.id);
    json(res, 200, { doc });
  } catch (err) {
    // docs.ts отказывает только на вводе («нужно название», «неизвестный
    // тип») — это 400 с его текстом. Сбой диска тоже придёт сюда, но
    // отличить его по сообщению нельзя, поэтому различаем по коду ошибки ФС.
    if (err instanceof Error && !(err as NodeJS.ErrnoException).code) {
      json(res, 400, { error: err.message });
      return;
    }
    console.warn(`[docs] сбой ручки: ${err instanceof Error ? err.message : String(err)}`);
    json(res, 500, { error: c('boot.docsFailed') });
  }
}

/**
 * Разобрать запрос, если он про документы офиса. `false` — адрес не наш,
 * пусть разбирается дальше вызывающий.
 */
export function handleDocsHttp(
  req: IncomingMessage, res: ServerResponse, url: string, query: string,
  env: DocsHttpEnv = defaultEnv,
): boolean {
  const r = route(url);
  if (!r) return false;
  void serve(req, res, r, query, env);
  return true;
}
