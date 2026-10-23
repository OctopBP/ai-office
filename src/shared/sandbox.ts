/**
 * Настройка песочницы роли: дополнительные пути на запись и сетевые хосты
 * (T-684). Правила проверки общие для сервера и веба: форма показывает
 * ошибку ровно по тем же правилам, по которым сервер отказывает.
 *
 * Сами пути разворачивает сервер при старте сессии (`sandboxFor`): `~`
 * значит домашний каталог машины, на которой работает офис, а не браузера.
 */

/** Сколько записей держит одно поле: это точечные исключения, а не список доступа. */
export const SANDBOX_LIST_LIMIT = 32;
const ENTRY_MAX_LENGTH = 300;

/**
 * Путь на запись: абсолютный (`/…`) или от домашнего каталога (`~/…`).
 * Корень и домашний каталог целиком отклоняем — это уже не исключение,
 * а отключённая песочница. Относительные пути не принимаем: непонятно,
 * от чего их считать — от рабочей копии или от директории офиса.
 */
export function cleanWritePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let path = value.trim();
  if (!path || path.length > ENTRY_MAX_LENGTH || path.includes('\0')) return null;
  if (path !== '/' && path !== '~/') path = path.replace(/\/+$/, '');
  if (path === '/' || path === '' || path === '~' || path === '~/') return null;
  if (!path.startsWith('/') && !path.startsWith('~/')) return null;
  // `..` дал бы выйти из названного каталога куда угодно — в том числе в корень.
  if (path.split('/').includes('..')) return null;
  return path;
}

/**
 * Хост: имя вида `api.unity.com` или маска поддоменов `*.unity.com`.
 * Голую звёздочку и маску на домен первого уровня (`*.com`) не принимаем —
 * это открыло бы весь интернет. Регистр не важен, храним в нижнем.
 */
export function cleanAllowedHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  const wildcard = host.startsWith('*.');
  const name = wildcard ? host.slice(2) : host;
  const labels = name.split('.');
  if (labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (wildcard && labels.length < 2) return null;
  return host;
}

function cleanList(value: unknown, clean: (v: unknown) => string | null): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const entry = clean(item);
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out.slice(0, SANDBOX_LIST_LIMIT);
}

/** Годные пути без повторов; мусор и лишнее молча отбрасываются. */
export const cleanWritePaths = (value: unknown): string[] => cleanList(value, cleanWritePath);
/** Годные хосты без повторов; мусор и лишнее молча отбрасываются. */
export const cleanAllowedHosts = (value: unknown): string[] => cleanList(value, cleanAllowedHost);

/**
 * Что в списке не годится — для ошибки формы. Пустые строки не считаются
 * ошибкой: это недописанная строка, её просто не сохраним.
 */
export function badSandboxEntries(value: unknown, clean: (v: unknown) => string | null): string[] {
  if (!Array.isArray(value)) return ['—'];
  return value
    .filter((item) => !(typeof item === 'string' && !item.trim()))
    .filter((item) => clean(item) === null)
    .map((item) => String(item));
}
