/**
 * HTTP вокруг секретных переменных офиса (secrets.ts):
 *   GET    /api/secrets?office=<id>          — список: имя и даты, без значений;
 *   PUT    /api/secrets?office=<id>          — завести или заменить, тело `{ name, value }`;
 *   DELETE /api/secrets/<имя>?office=<id>    — удалить.
 *
 * Отдельным файлом от index.ts, как и аватарка офиса: это ручка, которая
 * принимает из сети тайну, и всё, что её бережёт, должно лежать рядом —
 * потолок тела, проверка доступа, что уходит в ответ и в рассылку.
 *
 * Значение переменной отсюда наружу не уходит НИКУДА: ни в ответ (PUT отдаёт
 * метаданные), ни в лог (тело запроса не логируется, ошибки модуля значения не
 * содержат), ни в WebSocket (рассылается только событие `secrets` со списком
 * метаданных).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SecretMeta, ServerEvent } from '../shared/types';
import { c } from './i18n';
import { broadcast } from './office-api';
import { readBody } from './officeicon';
import { currentOffice, officeById } from './offices';
import { deleteSecret, listSecrets, SecretError, setSecret, type SecretErrorCode } from './secrets';
import { isOpened } from './state';
import { isExposed } from './terminal';

/** Потолок тела PUT: значение до 32 КБ в JSON с экранированием и запасом. */
export const SECRETS_BODY_MAX = 64 * 1024;

/** Ошибка модуля → код ответа. Всё, что про ввод, — 400 с текстом модуля. */
const STATUS: Record<SecretErrorCode, number> = {
  'bad-office': 400,
  'bad-name': 400,
  reserved: 400,
  'bad-value': 400,
  keychain: 503,
};

/**
 * Откуда ручка берёт офис, режим и рассылку. Подменяется только в проверке
 * (scripts/test-secrets.ts): там нет реестра офисов и живого сервера.
 */
export interface SecretsHttpEnv {
  /** Офис открыт наружу — тогда нужен вошедший владелец. */
  exposed: () => boolean;
  /** Вошёл ли владелец на этом запросе. */
  ownerSignedIn: (req: IncomingMessage) => boolean;
  /** Офис по параметру `office` (без него — открытый последним) или отказ. */
  office: (wanted: string | null) => { id: string } | { code: number; error: string };
  /** Разослать событие подписчикам офиса. */
  broadcast: (event: ServerEvent, officeId: string) => void;
}

const defaultEnv: SecretsHttpEnv = {
  exposed: () => isExposed(),
  // Входа владельца пока нет (docs/design/remote-office): открытый наружу
  // офис переменные не отдаёт никому — как и терминал (terminal-api.ts).
  ownerSignedIn: () => false,
  office: (wanted) => {
    const office = wanted ? officeById(wanted) : currentOffice();
    if (!office) return { code: 404, error: c('offices.notFound', { id: wanted ?? '' }) };
    // Состояние неоткрытого офиса не загружено: отметка о переменной в пустом
    // состоянии затёрла бы его файл. Поднимать офис ради запроса не станем.
    if (!isOpened(office.id)) return { code: 503, error: c('boot.secretsClosed', { office: office.name }) };
    return { id: office.id };
  },
  broadcast,
};

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    // Даже список имён не должен оседать в кешах по дороге.
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/** Отказ модуля — его текстом; чужая ошибка — без подробностей: что в ней, мы не знаем. */
function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof SecretError) {
    json(res, STATUS[err.code], { error: err.message, code: err.code });
    return;
  }
  // В лог — только тип: текст чужой ошибки мог бы унести кусок ввода.
  console.warn(`[secrets] сбой ручки: ${err instanceof Error ? err.name : typeof err}`);
  json(res, 500, { error: 'Не удалось изменить переменную офиса.' });
}

/** После изменения всем, кто смотрит офис, — свежий список без значений. */
function announce(env: SecretsHttpEnv, officeId: string): SecretMeta[] {
  const secrets = listSecrets(officeId);
  env.broadcast({ t: 'secrets', secrets }, officeId);
  return secrets;
}

async function serve(
  req: IncomingMessage, res: ServerResponse, name: string | null, query: string, env: SecretsHttpEnv,
): Promise<void> {
  const method = req.method ?? 'GET';
  const allowed = name === null ? ['GET', 'PUT'] : ['DELETE'];
  if (!allowed.includes(method)) {
    json(res, 405, { error: c('boot.secretsMethod') }, { Allow: allowed.join(', ') });
    return;
  }
  // Доступ — раньше всего остального, в том числе раньше чтения тела: чужому
  // незачем даже узнавать, есть ли такой офис.
  if (env.exposed() && !env.ownerSignedIn(req)) {
    json(res, 403, { error: c('boot.secretsForbidden') });
    return;
  }
  const office = env.office(new URLSearchParams(query).get('office'));
  if ('error' in office) {
    json(res, office.code, { error: office.error });
    return;
  }

  try {
    if (method === 'GET') {
      json(res, 200, { secrets: listSecrets(office.id) });
      return;
    }
    if (method === 'DELETE') {
      await deleteSecret(office.id, name ?? '');
      json(res, 200, { secrets: announce(env, office.id) });
      return;
    }

    const body = await readBody(req, SECRETS_BODY_MAX);
    if ('over' in body) {
      json(res, 413, { error: c('boot.secretsTooBig', { max: SECRETS_BODY_MAX / 1024 }) }, { Connection: 'close' });
      return;
    }
    if ('cut' in body) {
      json(res, 400, { error: c('boot.secretsCutOff') });
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(body.bytes.toString('utf8'));
    } catch {
      input = null;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      json(res, 400, { error: c('boot.secretsBadBody') });
      return;
    }
    const { name: newName, value } = input as { name?: unknown; value?: unknown };
    // Типы проверяет модуль: на не-строку он отвечает тем же понятным отказом.
    const meta = await setSecret(office.id, newName as string, value as string);
    announce(env, office.id);
    json(res, 200, { secret: meta });
  } catch (err) {
    fail(res, err);
  }
}

/**
 * Разобрать запрос, если он про переменные офиса. `false` — адрес не наш,
 * пусть разбирается дальше вызывающий.
 */
export function handleSecretsHttp(
  req: IncomingMessage, res: ServerResponse, url: string, query: string,
  env: SecretsHttpEnv = defaultEnv,
): boolean {
  if (url === '/api/secrets') {
    void serve(req, res, null, query, env);
    return true;
  }
  if (url.startsWith('/api/secrets/')) {
    let name: string;
    try {
      name = decodeURIComponent(url.slice('/api/secrets/'.length));
    } catch {
      name = '';   // битая %-последовательность — модуль ответит «нет такой переменной»
    }
    void serve(req, res, name, query, env);
    return true;
  }
  return false;
}
