/**
 * Адреса OpenAI-совместимых провайдеров, которые задаёт пользователь: свой
 * сервер и Ollama не на стандартном порту.
 *
 * Адрес — не секрет, но и не настройка офиса: провайдеры общие для всех
 * офисов процесса, как и ключи в связке. Поэтому он лежит отдельным файлом
 * рядом с состоянием, а не в `state.json` офиса.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PROVIDERS, type ProviderId } from '../../shared/providers';
import { DEFAULT_STATE_FILE } from '../store';

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
