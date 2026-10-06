/**
 * Секретные переменные окружения офиса: ключи деплоя, токены сторов, `.p8`
 * App Store Connect — то, что нужно процессу сборки, но не агентам.
 *
 * Значение живёт ТОЛЬКО в системной связке ключей — тем же механизмом, что и
 * ключи провайдеров (engines/keys.ts): Keychain на macOS, Credential Manager
 * на Windows, Secret Service на Linux. Учётка записи привязана к id офиса,
 * поэтому одноимённые переменные двух офисов не пересекаются.
 *
 * В состояние офиса (а значит, в state.json), в журнал, в логи, в события
 * шины и в ответы клиенту попадают только метаданные: имя и даты. Значения
 * отдаёт одна функция — `secretsEnv`, и только для окружения сборки.
 *
 * Нет связки — понятная ошибка `SecretError('keychain')`. Тихого отката в
 * файл нет и не будет: секрет на диске открытым текстом хуже отказа.
 */
import type { SecretMeta } from '../shared/types';
import { APP_BOUND_VARS, PROVIDER_SECRET_VARS } from './childenv';
import { KEY_VAR, keychain, type Keychain } from './engines/keys';
import { getOffice } from './state';

/** Имя переменной: заглавные латинские, цифры и подчёркивание, до 64 знаков. */
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Предел значения в байтах UTF-8: `.p8`-ключ с запасом, многострочный. */
export const SECRET_VALUE_MAX = 32 * 1024;

/** Значения короче не маскируются: «***» вместо каждого «on» испортил бы весь вывод. */
const MASK_MIN = 4;
const MASK = '***';

/**
 * Имена, которые подменили бы поведение процесса сборки или самого офиса:
 * где искать программы, чей это дом, что подгрузить в node. Ключи движков
 * офис ставит сам — переменная офиса не должна их перекрывать.
 */
const RESERVED_NAMES = new Set<string>([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'TMPDIR', 'IFS', 'ENV', 'BASH_ENV',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  ...PROVIDER_SECRET_VARS,
  ...Object.values(KEY_VAR),
  ...APP_BOUND_VARS,
]);

/** Префиксы того же рода: загрузчик динамических библиотек, движки, сам офис. */
const RESERVED_PREFIXES = ['LD_', 'DYLD_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OFFICE_', 'ELECTRON_'];

export type SecretErrorCode = 'bad-office' | 'bad-name' | 'reserved' | 'bad-value' | 'keychain';

/** Отказ модуля. Текст можно показывать владельцу: значения в нём нет никогда. */
export class SecretError extends Error {
  constructor(readonly code: SecretErrorCode, message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

/** Проверить имя переменной. Бросает `SecretError` с объяснением. */
export function checkSecretName(name: unknown): string {
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) {
    throw new SecretError('bad-name',
      'Имя переменной — заглавные латинские буквы, цифры и «_», не с цифры, до 64 знаков (например, DEPLOY_TOKEN).');
  }
  if (RESERVED_NAMES.has(name)) {
    throw new SecretError('reserved', `Имя ${name} зарезервировано: его выставляет система или сам офис.`);
  }
  const prefix = RESERVED_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) {
    throw new SecretError('reserved', `Имена на ${prefix}* зарезервированы: они меняют поведение процессов офиса.`);
  }
  return name;
}

/** Проверить значение: непустое, до 32 КБ, без нулевых байтов (их не держит окружение процесса). */
export function checkSecretValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SecretError('bad-value', 'Значение переменной пустое.');
  }
  if (Buffer.byteLength(value, 'utf8') > SECRET_VALUE_MAX) {
    throw new SecretError('bad-value', `Значение длиннее ${SECRET_VALUE_MAX / 1024} КБ.`);
  }
  if (value.includes('\0')) {
    throw new SecretError('bad-value', 'Значение содержит нулевой байт — в окружение процесса его не передать.');
  }
  return value;
}

function checkOffice(officeId: unknown): string {
  // id офиса уходит в имя учётки, а на macOS — в строку команды `security -i`.
  if (typeof officeId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(officeId)) {
    throw new SecretError('bad-office', 'Неизвестный офис.');
  }
  return officeId;
}

// ---------- хранилище ----------

let store: Keychain = keychain;
let availability: Promise<boolean> | null = null;

/**
 * Подменить связку ключей — только для проверок (`memoryKeychain()` из keys.ts).
 * `null` возвращает системную.
 */
export function useSecretStore(next: Keychain | null): void {
  store = next ?? keychain;
  availability = null;
}

async function ready(): Promise<Keychain> {
  availability ??= store.available().catch(() => false);
  if (!(await availability)) {
    // Ответ «нет» не кешируем навсегда: secret service могли поднять позже.
    availability = null;
    throw new SecretError('keychain',
      'Системная связка ключей недоступна (Keychain, Credential Manager или Secret Service). Секретные переменные хранятся только в ней.');
  }
  return store;
}

/** Ошибку связки заворачиваем в свою: её текст от системы, значения в нём нет. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SecretError) throw err;
    throw new SecretError('keychain', `Связка ключей отказала: ${(err as Error).message}`);
  }
}

/**
 * Значение режется на куски: строка `security -i` на macOS не длиннее ~4 КБ,
 * а запись Credential Manager на Windows — не больше 2,5 КБ. Значение хранится
 * в base64, чтобы резать по знакам, а не посреди многобайтовой буквы. Нулевой
 * кусок начинается с числа кусков: `3:<base64>`.
 */
const CHUNK = 1700;

const account = (officeId: string, name: string, part: number): string =>
  `office:${officeId}:env:${name}:${part}`;

async function readValue(kc: Keychain, officeId: string, name: string): Promise<string | null> {
  const head = await kc.get(account(officeId, name, 0));
  if (!head) return null;
  const colon = head.indexOf(':');
  const count = Number(head.slice(0, colon));
  if (colon < 1 || !Number.isInteger(count) || count < 1) {
    throw new SecretError('keychain', `Запись переменной ${name} в связке ключей повреждена.`);
  }
  const parts = [head.slice(colon + 1)];
  for (let i = 1; i < count; i++) {
    const part = await kc.get(account(officeId, name, i));
    if (part === null) throw new SecretError('keychain', `Запись переменной ${name} в связке ключей неполная.`);
    parts.push(part);
  }
  return Buffer.from(parts.join(''), 'base64').toString('utf8');
}

/** Сколько кусков лежит сейчас — чтобы при замене и удалении не оставить хвост. */
async function storedCount(kc: Keychain, officeId: string, name: string): Promise<number> {
  const head = await kc.get(account(officeId, name, 0));
  if (!head) return 0;
  const count = Number(head.slice(0, head.indexOf(':')));
  return Number.isInteger(count) && count > 0 ? count : 1;
}

async function writeValue(kc: Keychain, officeId: string, name: string, value: string): Promise<void> {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const parts: string[] = [];
  for (let i = 0; i < encoded.length; i += CHUNK) parts.push(encoded.slice(i, i + CHUNK));
  const before = await storedCount(kc, officeId, name);
  // Хвост пишем раньше головы: голова с новым числом кусков появляется, когда
  // все куски уже на месте, и чтение посередине не соберёт смесь.
  for (let i = parts.length - 1; i >= 1; i--) await kc.set(account(officeId, name, i), parts[i]);
  await kc.set(account(officeId, name, 0), `${parts.length}:${parts[0]}`);
  for (let i = parts.length; i < before; i++) await kc.delete(account(officeId, name, i));
}

async function removeValue(kc: Keychain, officeId: string, name: string): Promise<void> {
  const count = await storedCount(kc, officeId, name);
  for (let i = 0; i < count; i++) await kc.delete(account(officeId, name, i));
}

/** Операции одного офиса по очереди: две записи одной переменной не перемешают куски. */
const queues = new Map<string, Promise<unknown>>();

function serial<T>(officeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(officeId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(officeId, next);
  void next.catch(() => undefined).then(() => {
    if (queues.get(officeId) === next) queues.delete(officeId);
  });
  return next;
}

// ---------- API ----------

/** Переменные офиса без значений — то, что можно показать клиенту. */
export function listSecrets(officeId: string): SecretMeta[] {
  return getOffice(checkOffice(officeId)).secretMetas();
}

/** Завести переменную или заменить её значение. Отдаёт метаданные — без значения. */
export async function setSecret(officeId: string, name: string, value: string): Promise<SecretMeta> {
  const office = checkOffice(officeId);
  const key = checkSecretName(name);
  const secret = checkSecretValue(value);
  return serial(office, async () => {
    const kc = await ready();
    await guarded(() => writeValue(kc, office, key, secret));
    return getOffice(office).noteSecret(key);
  });
}

/** Удалить переменную из связки и из состояния офиса. Удаление несуществующей — не ошибка. */
export async function deleteSecret(officeId: string, name: string): Promise<void> {
  const office = checkOffice(officeId);
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) throw new SecretError('bad-name', 'Нет такой переменной.');
  return serial(office, async () => {
    const kc = await ready();
    await guarded(() => removeValue(kc, office, name));
    getOffice(office).forgetSecret(name);
  });
}

/**
 * Значения переменных офиса — для окружения ПРОЦЕССА СБОРКИ, и только для него.
 *
 * ЕДИНСТВЕННАЯ функция, отдающая значения. Её НЕЛЬЗЯ звать для окружения
 * сессий агентов (агент увидел бы секрет в `env` и мог унести его в отчёт,
 * коммит или чужой сервер) и для ответов клиенту, событий шины, журнала,
 * логов. Вывод процесса, получившего это окружение, перед показом прогоняйте
 * через `maskSecrets`.
 *
 * Переменная, которой в связке не оказалось (стёрли руками), пропускается с
 * предупреждением в лог — в нём только имя.
 */
export async function secretsEnv(officeId: string): Promise<Record<string, string>> {
  const office = checkOffice(officeId);
  return serial(office, async () => {
    const metas = getOffice(office).secretMetas();
    const env: Record<string, string> = {};
    if (!metas.length) return env;
    const kc = await ready();
    for (const { name } of metas) {
      // Имя из файла состояния могло стать зарезервированным в новой версии офиса.
      try { checkSecretName(name); } catch { continue; }
      const value = await guarded(() => readValue(kc, office, name));
      if (value === null) {
        console.warn(`[secrets] ${office}: переменной ${name} нет в связке ключей — пропускаю`);
        continue;
      }
      env[name] = value;
    }
    return env;
  });
}

/**
 * Заменить в тексте значения на «***». Значения короче четырёх знаков не
 * трогаем. У многострочного значения (`.p8`) маскируется и каждая его строка
 * отдельно: вывод мог показать ключ частично или с другими переводами строк.
 */
export function maskValues(text: string, values: Iterable<string>): string {
  const needles = new Set<string>();
  for (const value of values) {
    if (value.length >= MASK_MIN) needles.add(value);
    if (/[\r\n]/.test(value)) {
      for (const line of value.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= MASK_MIN) needles.add(trimmed);
      }
    }
  }
  // Длинные первыми: иначе кусок длинного значения, совпавший с коротким,
  // оставил бы хвост длинного открытым.
  let out = text;
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) out = out.split(needle).join(MASK);
  return out;
}

/** Вычистить значения переменных офиса из текста — для вывода сборки. */
export async function maskSecrets(officeId: string, text: string): Promise<string> {
  const env = await secretsEnv(officeId);
  return maskValues(text, Object.values(env));
}
