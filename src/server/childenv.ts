/**
 * Окружение для дочерних процессов проекта: сессий исполнителей, проверок
 * гейта, git.
 *
 * Сервер приложения запускается с переменными, которые привязывают его к
 * установленной программе: корень ресурсов внутри `.app`, файл состояния в
 * данных приложения, порт живого офиса (см. desktop/server.js). Процесс
 * проекта наследовал их целиком — и тесты рабочей копии читали раскладки из
 * `/Applications/AI Office.app`, а писали состояние в настоящий офис
 * владельца: EPERM на state.json, ENOENT на временные раскладки, красный гейт
 * на чистой main (T-109). Дочернему процессу эти переменные не принадлежат:
 * он работает от своей рабочей копии, а не от приложения, которое его позвало.
 *
 * Модуль нарочно ни от чего в сервере не зависит: его первым же импортом
 * подключают проверки (`scripts/_isolate.ts`), до того как `root.ts` и
 * `store.ts` прочтут окружение.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Переменные, привязывающие процесс к установленному приложению.
 *
 * Оставлены инструменты — `OFFICE_CLAUDE_BIN`, `OFFICE_GIT_BIN`: это пути к
 * программам на машине, они одинаково верны и для приложения, и для рабочей
 * копии, а без них проекту в приложении нечем было бы звать движок и git.
 * Язык (`OFFICE_LANG`) тоже не путь и остаётся.
 */
export const APP_BOUND_VARS: readonly string[] = [
  'OFFICE_APP',            // «я приложение»: другие проверки окружения и пути
  'OFFICE_ROOT',           // корень ресурсов внутри .app — root.ts
  'OFFICE_DIST_DIR',       // собранный веб приложения
  'OFFICE_STATE_FILE',     // состояние настоящего офиса владельца
  'OFFICE_PROJECT_DIR',    // папка проекта по умолчанию у приложения
  'OFFICE_EMPLOYEES_DIR',  // свои сотрудники владельца
  'OFFICE_PORT',           // порт живого офиса: test-pm и соседи пошли бы в него
  'OFFICE_HOST',
  'OFFICE_NODE_BIN',       // исполняемый файл Electron вместо node
  'ELECTRON_RUN_AS_NODE',  // без него Electron из проекта не открыл бы окно
];

/**
 * Ключи провайдеров моделей, которым не место в командах агента.
 *
 * Сервер держит их в своём окружении, чтобы движок мог авторизоваться, а всё,
 * что запускается от имени агента, — Bash, проверки гейта, git — раньше
 * наследовало окружение целиком. Агент видел ключ в `env`, тест с дампом
 * окружения выводил его в лог, а оттуда он мог уехать в отчёт или коммит
 * (docs/design/providers/spec.md §5.8). Командам ключ не нужен ни для чего:
 * авторизуется движок, а не то, что он запускает. Поэтому список вычищается
 * из окружения команд всегда, даже если вызывающий передал ключ явно.
 */
export const PROVIDER_SECRET_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DASHSCOPE_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
];

/**
 * PATH с системными каталогами macOS в хвосте.
 *
 * git сам зовёт внешние программы — прежде всего `git-lfs` из фильтра в
 * ~/.gitconfig (`filter.lfs.required = true`), а проверки зовут npm и node.
 * Приложение, запущенное из Finder, получает голый PATH
 * `/usr/bin:/bin:/usr/sbin:/sbin`, а git-lfs лежит в /usr/local/bin или
 * /opt/homebrew/bin. Тогда `worktree add` успевает создать ветку и падает на
 * выгрузке первого LFS-файла (T-106). Каталоги только дописываем в конец:
 * порядок, выбранный человеком, важнее наших догадок.
 */
export function systemPath(current = process.env.PATH ?? ''): string {
  if (process.platform === 'win32') return current;
  const dirs = current.split(':').filter(Boolean);
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
  try {
    extra.push(...readFileSync('/etc/paths', 'utf8').split('\n').map((s) => s.trim()));
  } catch { /* не macOS — хватит известных каталогов */ }
  for (const dir of extra) {
    if (dir && !dirs.includes(dir) && existsSync(dir)) dirs.push(dir);
  }
  return dirs.join(':');
}

const PATH = systemPath();

/** Убрать из окружения привязку к приложению. Правит переданный объект. */
export function stripAppVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of APP_BOUND_VARS) delete env[name];
  return env;
}

/** Убрать из окружения ключи провайдеров. Правит переданный объект. */
export function stripProviderSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of PROVIDER_SECRET_VARS) delete env[name];
  return env;
}

/**
 * Окружение самого движка агента: как у проекта, но с ключами провайдеров —
 * без них движок не авторизуется. Команды, которые движок запускает, его
 * получать не должны: у Claude Code для этого `commandScrubFile`, у Codex
 * команды идут через инструменты офиса с `projectEnv`.
 */
export function engineEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = stripAppVars({ ...process.env });
  // На Windows ключ зовётся `Path`, а копия окружения уже не регистронезависима:
  // второй ключ `PATH` рядом с ним дочерний процесс прочёл бы как попало.
  if (process.platform !== 'win32') env.PATH = PATH;
  return { ...env, ...engineSecrets, ...extra };
}

/**
 * Ключи из системной связки (engines/keys.ts). Они живут здесь, а не в
 * `process.env` сервера: окружение сервера наследует всё, что он запускает, а
 * это окружение получает только движок. Ключ, введённый на экране
 * «Провайдеры», сильнее переменной окружения — его задали позже и явно.
 */
let engineSecrets: Record<string, string> = {};

export function setEngineSecrets(secrets: Record<string, string>): void {
  for (const name of Object.keys(secrets)) {
    if (!PROVIDER_SECRET_VARS.includes(name)) throw new Error(`not a provider secret: ${name}`);
  }
  engineSecrets = { ...secrets };
}

/**
 * Чистое окружение для дочернего процесса проекта: окружение сервера без
 * переменных приложения и ключей провайдеров, PATH с системными каталогами,
 * сверху — своё.
 */
export function projectEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return stripProviderSecrets(engineEnv(extra));
}

/** Строка оболочки, которая снимает ключи провайдеров с окружения команды. */
export const UNSET_PROVIDER_SECRETS = `unset ${PROVIDER_SECRET_VARS.join(' ')}`;

const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Файл для `CLAUDE_ENV_FILE` движка Claude Code.
 *
 * Bash-инструмент Claude Code наследует окружение процесса движка, а движку
 * ключ нужен — убрать его из окружения процесса нельзя. Зато содержимое
 * `CLAUDE_ENV_FILE` движок вставляет в начало каждой Bash-команды: `unset`
 * там снимает ключи с команды, а сам движок их сохраняет. Встроенный
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` не подошёл: он чистит только ключи
 * Anthropic и вдобавок принудительно сбрасывает режим разрешений.
 *
 * Если файл окружения уже был задан (сервер запущен из сессии Claude Code),
 * он подключается первым, чтобы не потерять его переменные, — а снятие ключей
 * идёт после и выигрывает. Имя файла — от содержимого: разные цепочки не
 * затирают друг друга, одинаковые пишутся один раз.
 */
export function commandScrubFile(chain?: string): string {
  const lines = chain ? [`[ -f ${shellQuote(chain)} ] && . ${shellQuote(chain)}`] : [];
  lines.push(UNSET_PROVIDER_SECRETS, '');
  const text = lines.join('\n');
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
  const file = resolve(tmpdir(), `office-env-scrub-${hash}.sh`);
  let current: string | null = null;
  try { current = readFileSync(file, 'utf8'); } catch { /* ещё не писали */ }
  if (current !== text) writeFileSync(file, text, { mode: 0o600 });
  return file;
}
