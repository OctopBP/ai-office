/**
 * Адреса OpenAI-совместимых провайдеров, которые задаёт пользователь: свой
 * сервер и Ollama не на стандартном порту.
 *
 * Адрес — не секрет, но и не настройка офиса: провайдеры общие для всех
 * офисов процесса, как и ключи в связке. Поэтому он лежит отдельным файлом
 * рядом с состоянием, а не в `state.json` офиса.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PROVIDERS, cleanCustomApi, type CustomApi, type ProviderId } from '../../shared/providers';
import { DEFAULT_STATE_FILE } from '../store';
import { LoginError } from './types';

const file = (): string => resolve(dirname(DEFAULT_STATE_FILE), 'provider-endpoints.json');

let cache: Partial<Record<ProviderId, string>> | null = null;

function load(): Partial<Record<ProviderId, string>> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;
    cache = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string'));
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * Адрес в форме, которую ждёт клиент OpenAI: `http(s)://…` без хвостового
 * слеша. Ollama и LM Studio отвечают по `/v1` — его дописываем, если человек
 * ввёл голый адрес сервера, как его печатают в их же инструкциях.
 */
export function normalizeBaseUrl(raw: string, provider?: ProviderId): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  let path = url.pathname.replace(/\/+$/, '');
  if (provider === 'ollama' && !path) path = '/v1';
  // Адрес часто копируют из примера запроса вместе с хвостом — клиенту он не нужен.
  path = path.replace(/\/chat\/completions$/, '');
  return `${url.origin}${path}`;
}

/** Адрес провайдера: заданный пользователем или адрес пресета. Пусто — адреса нет. */
export function baseUrlOf(provider: ProviderId): string {
  const spec = PROVIDERS[provider] as { baseUrl?: string; editableUrl?: boolean };
  const own = spec.editableUrl ? load()[provider] : undefined;
  return own ?? spec.baseUrl ?? '';
}

export function saveBaseUrl(provider: ProviderId, url: string): void {
  const next = { ...load(), [provider]: url };
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
}

export function forgetBaseUrl(provider: ProviderId): void {
  const next = { ...load() };
  if (!(provider in next)) return;
  delete next[provider];
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
}

// ─── Свой API: название, модель, контекст, цена ──────────────────────────

const customFile = (): string => resolve(dirname(DEFAULT_STATE_FILE), 'provider-custom.json');

let customCache: CustomApi | null = null;

/** Что владелец сохранил о своём API; ничего — пустой объект. */
export function customApi(): CustomApi {
  if (customCache) return customCache;
  try {
    customCache = cleanCustomApi(JSON.parse(readFileSync(customFile(), 'utf8')));
  } catch {
    customCache = {};
  }
  return customCache;
}

export function saveCustomApi(meta: CustomApi): void {
  const next = cleanCustomApi(meta);
  mkdirSync(dirname(customFile()), { recursive: true });
  writeFileSync(customFile(), `${JSON.stringify(next, null, 2)}\n`);
  customCache = next;
}

export function forgetCustomApi(): void {
  rmSync(customFile(), { force: true });
  customCache = {};
}

/**
 * Проба адреса в формате OpenAI: `GET {адрес}/models` — метаданные, платный
 * ход модели не выполняется. Ошибка — `LoginError` с кодом для формы.
 * Ответ без списка моделей — не ошибка: так бывает у шлюзов, модель тогда
 * вписывают руками (`null`).
 */
export async function probeModels(url: string, headers: Record<string, string>): Promise<string[] | null> {
  let res: Response;
  try {
    res = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new LoginError('network', (err as Error).message);
  }
  if (res.status === 401 || res.status === 403) throw new LoginError('rejected', `HTTP ${res.status}`);
  if (res.status === 404) throw new LoginError('not-found', `HTTP 404 from ${url}/models`);
  if (!res.ok) throw new LoginError('network', `HTTP ${res.status}`);
  try {
    const body = await res.json() as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    return body.data
      .map((m: { id?: unknown }) => m?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return null;
  }
}
