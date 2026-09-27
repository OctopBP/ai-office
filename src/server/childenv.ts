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

import { existsSync, readFileSync } from 'node:fs';

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

/**
 * Чистое окружение для дочернего процесса проекта: окружение сервера без
 * переменных приложения, PATH с системными каталогами, сверху — своё.
 */
export function projectEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = stripAppVars({ ...process.env });
  // На Windows ключ зовётся `Path`, а копия окружения уже не регистронезависима:
  // второй ключ `PATH` рядом с ним дочерний процесс прочёл бы как попало.
  if (process.platform !== 'win32') env.PATH = PATH;
  return { ...env, ...extra };
}
