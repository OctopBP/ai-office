/**
 * Чтение файлов менеджером (T-694). У сессии менеджера есть Read, Glob и
 * Grep — чтобы ответить владельцу на вопрос о коде или точнее поставить
 * задачу. Писать он по-прежнему не может: пишущих инструментов в сессии нет.
 *
 * Здесь — границы этого чтения, одной чистой функцией `checkPmRead`, без
 * состояния офиса: её зовут и хук PreToolUse сессии Claude (встроенная
 * проверка SDK пропускает чтение внутри cwd, не спрашивая `canUseTool`), и
 * обработчик разрешений офиса (через него идут движки Codex и OpenCode, и
 * через него же уходит вопрос владельцу).
 *
 *  - секреты (.env*, ключи, ~/.ssh, ~/.aws, файлы токенов) — отказ с причиной
 *    в любом режиме и в любом месте, даже внутри офиса;
 *  - большой файл целиком — отказ с подсказкой читать диапазоном строк:
 *    контекст менеджера держит весь разговор с владельцем, его не тратят на
 *    файл в тысячу строк;
 *  - внутри корня офиса, зон и рабочих копий задач — без вопроса;
 *  - вне их — вопрос владельцу через обычную модалку разрешения;
 *  - выдача Grep по папке — без строк и имён файлов-секретов
 *    (`filterPmGrepOutput`, хук PostToolUse).
 */
import { realpathSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import type { Subproject } from '../shared/types';
import { zonePath, zoneRepo } from './subprojects';

/** Инструменты, которые получает сессия менеджера. Только чтение. */
export const PM_READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/** Сколько строк менеджер читает за один Read. */
export const PM_READ_MAX_LINES = 400;

/**
 * Файл больше этого читается только с `limit`: минифицированный бандл в
 * одну строку не поймать подсчётом строк.
 */
export const PM_READ_MAX_BYTES = 64 * 1024;

/** Сколько строк выдачи Grep отдаётся менеджеру, если он не задал сам. */
export const PM_GREP_HEAD_LIMIT = 200;

export const isPmReadTool = (name: string): boolean =>
  (PM_READ_TOOLS as readonly string[]).includes(name);

/** Где менеджер читает без вопроса. */
export interface PmReadScope {
  /** Абсолютные корни: офис, зоны, рабочие копии задач. */
  roots: string[];
  /** Папка, от которой считаются относительные пути (cwd сессии). */
  cwd: string;
  /** Домашняя папка — для ~/.ssh и ~/.aws. По умолчанию — системная. */
  home?: string;
}

/** Чем закончилась проверка. `path` — то, что увидит владелец и менеджер. */
export type PmReadCheck =
  | { kind: 'inside'; path: string; grepHeadLimit?: number }
  | { kind: 'outside'; path: string }
  | { kind: 'secret'; path: string; why: PmSecretWhy }
  | { kind: 'tooBig'; path: string; lines: number; bytes: number }
  | { kind: 'limitTooBig'; path: string; limit: number };

/** Почему путь считается секретом — ключ причины для отказа. */
export type PmSecretWhy = 'env' | 'key' | 'dir' | 'token';

/**
 * Папки с ключами и учётками. Ищутся по сегменту пути, а не только от
 * домашней папки: копия `.ssh` в проекте — такие же ключи.
 */
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.azure', '.password-store']);

/** То же, но вложенные пути от домашней папки. */
const SECRET_HOME_DIRS = ['.config/gcloud', '.docker', '.config/gh'];

const ENV_FILE = /^\.env(\..*)?$|\.env$/i;
const KEY_FILE = /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|\.(pem|key|p12|pfx|jks|keystore|ppk|gpg|asc|crt|cer)$/i;
/** Файлы учёток по точному имени. */
const CREDENTIAL_FILE = /^(\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd|credentials|credentials\.json|service-account.*\.json)$/i;
/** «token», «secret», «password» отдельным словом в имени. */
const TOKEN_WORD = /(^|[._-])(tokens?|secrets?|passwords?|apikeys?|api[_-]keys?)([._-]|$)/i;
/**
 * Расширения исходников и документации: `secrets.ts` или `tokens.css` — это
 * код про секреты, а не сами секреты, и менеджеру его читать можно.
 */
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.swift', '.cs', '.c', '.h', '.cpp', '.css', '.scss', '.html', '.md', '.mdx', '.vue', '.svelte',
]);

/** Реальный путь, если файл есть: симлинк на ~/.ssh внутри офиса — всё ещё ~/.ssh. */
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

const under = (path: string, root: string): boolean => {
  const r = resolve(root);
  return path === r || path.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
};

/** То, что нужно от офиса, чтобы собрать корни чтения. OfficeState подходит как есть. */
export interface PmReadOffice {
  projectDir: string;
  subprojects(): readonly Subproject[];
  tasks: ReadonlyMap<string, { worktreePath: string | null; repoDir?: string | null }>;
}

/**
 * Корни, где менеджер читает без вопроса: корень офиса, зоны и их
 * репозитории (то же, что видит list_subprojects), рабочие копии задач.
 */
export function pmReadScope(office: PmReadOffice): PmReadScope {
  const dir = office.projectDir;
  const roots = new Set<string>();
  if (dir) {
    roots.add(resolve(dir));
    for (const sub of office.subprojects()) {
      roots.add(zonePath(sub, dir));
      roots.add(zoneRepo(sub, dir));
    }
  }
  for (const task of office.tasks.values()) {
    if (task.worktreePath) roots.add(resolve(task.worktreePath));
    if (task.repoDir) roots.add(resolve(task.repoDir));
  }
  return { roots: [...roots], cwd: dir || homedir() };
}

/** Секрет ли путь (файл или папка). null — нет. */
export function secretWhy(path: string, home = homedir()): PmSecretWhy | null {
  const abs = resolve(path);
  const parts = abs.split(sep);
  if (parts.some((p) => SECRET_DIRS.has(p))) return 'dir';
  if (SECRET_HOME_DIRS.some((d) => under(abs, resolve(home, d)))) return 'dir';
  const name = basename(abs);
  if (ENV_FILE.test(name)) return 'env';
  if (KEY_FILE.test(name)) return 'key';
  if (CREDENTIAL_FILE.test(name)) return 'token';
  if (TOKEN_WORD.test(name) && !CODE_EXT.has(extname(name).toLowerCase())) return 'token';
  return null;
}

/**
 * Неподвижная часть шаблона Glob/Grep: «/Users/x/proj/**\/*.py» → «/Users/x/proj».
 * По ней видно, куда шаблон смотрит, если в нём абсолютный путь.
 */
function globBase(pattern: string): string {
  const parts = pattern.split('/');
  const fixed: string[] = [];
  for (const p of parts) {
    if (/[*?[\]{}]/.test(p)) break;
    fixed.push(p);
  }
  return fixed.join('/') || '/';
}

/** Строк в файле. Зовётся только для файлов разумного размера. */
function countLines(path: string): number {
  try {
    const text = readFileSync(path, 'utf8');
    if (!text) return 0;
    let n = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return text.endsWith('\n') ? n - 1 : n;
  } catch {
    return 0;
  }
}

/**
 * Проверить вызов Read/Glob/Grep менеджера. Не трогает ни состояние офиса,
 * ни владельца: только говорит, что с вызовом делать.
 */
export function checkPmRead(
  toolName: string,
  input: Record<string, unknown>,
  scope: PmReadScope,
): PmReadCheck {
  const home = scope.home ?? homedir();
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const abs = (p: string): string => {
    const expanded = p === '~' ? home : p.startsWith('~/') ? resolve(home, p.slice(2)) : p;
    return isAbsolute(expanded) ? resolve(expanded) : resolve(scope.cwd, expanded);
  };

  // Куда смотрит вызов. У Read — файл, у Glob и Grep — папка (по умолчанию
  // cwd) или абсолютный шаблон.
  let target: string;
  if (toolName === 'Read') {
    target = abs(str(input.file_path) || '.');
  } else {
    const pattern = str(toolName === 'Glob' ? input.pattern : input.glob);
    const dir = str(input.path);
    target = dir ? abs(dir) : pattern && isAbsolute(pattern) ? abs(globBase(pattern)) : resolve(scope.cwd);
    // Шаблон, который целится в секреты по имени: `**/.env*`, `*.pem`.
    // Список имён Glob безвреден, а вот Grep по ним — уже содержимое.
    if (toolName === 'Grep' && pattern) {
      const name = basename(pattern.replace(/[*?]/g, '').replace(/[{}[\]]/g, ''));
      const why = secretWhy(resolve(target, name), home);
      if (why && why !== 'dir') return { kind: 'secret', path: pattern, why };
    }
  }

  const realTarget = real(target);
  const why = secretWhy(target, home) ?? secretWhy(realTarget, home);
  if (why) return { kind: 'secret', path: target, why };

  const roots = scope.roots.filter(Boolean).flatMap((r) => [resolve(r), real(resolve(r))]);
  const inside = roots.some((r) => under(target, r)) && roots.some((r) => under(realTarget, r));
  if (!inside) return { kind: 'outside', path: target };

  if (toolName === 'Read') {
    const limit = typeof input.limit === 'number' ? input.limit : null;
    if (limit !== null && limit > PM_READ_MAX_LINES) {
      return { kind: 'limitTooBig', path: target, limit };
    }
    if (limit === null) {
      let bytes = 0;
      try {
        const st = statSync(realTarget);
        if (st.isFile()) bytes = st.size;
      } catch { /* файла нет — пусть Read сам скажет */ }
      if (bytes > 0) {
        // Строки считаем, только если файл не огромный: менеджеру хватит
        // и размера, чтобы понять, что читать надо кусками.
        const lines = bytes <= 16 * 1024 * 1024 ? countLines(realTarget) : 0;
        if (lines > PM_READ_MAX_LINES || bytes > PM_READ_MAX_BYTES) {
          return { kind: 'tooBig', path: target, lines, bytes };
        }
      }
    }
  }

  // Grep в режиме содержимого без предела — потолок, чтобы поиск по всему
  // репозиторию не вылился в контекст менеджера целиком.
  if (toolName === 'Grep' && input.output_mode === 'content' && typeof input.head_limit !== 'number') {
    return { kind: 'inside', path: target, grepHeadLimit: PM_GREP_HEAD_LIMIT };
  }
  return { kind: 'inside', path: target };
}

// ------------------------------------------------- выдача Grep (T-696)

/**
 * Секрет ли файл из выдачи Grep — по имени и по реальному пути (симлинк в
 * офисе на ключ — всё ещё ключ).
 */
function secretFile(path: string, home: string): boolean {
  return secretWhy(path, home) !== null || secretWhy(real(path), home) !== null;
}

/** Есть ли такой файл на диске. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Файл, к которому относится строка выдачи ripgrep: «путь:12:текст»,
 * «путь-12-текст» (контекст), «путь:3» (count), «путь:текст» (без -n).
 * Имя файла само может содержать «:» и «-», поэтому берём самый короткий
 * префикс до такого знака, который есть на диске как файл. null — строка без
 * пути (разделитель «--», продолжение multiline).
 */
function lineFile(line: string, bases: string[]): string | null {
  const head = line.slice(0, 1024);
  for (let i = 1; i < head.length; i++) {
    const c = head[i];
    if (c !== ':' && c !== '-') continue;
    const prefix = head.slice(0, i);
    for (const base of bases) {
      const p = isAbsolute(prefix) ? prefix : resolve(base, prefix);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** Что осталось от выдачи Grep после фильтра. */
export interface PmGrepFiltered {
  /** Выдача без строк и имён файлов-секретов, той же формы, что пришла. */
  output: unknown;
  /** Какие файлы-секреты вырезаны — для ленты и подсказки менеджеру. */
  dropped: string[];
}

/**
 * Вырезать из выдачи Grep менеджера всё, что пришло из файлов-секретов.
 *
 * Grep по папке ищет и в скрытых файлах, а незаигноренный `.env` — обычное
 * дело. Исключить его через параметры надёжно нельзя: у Grep одно поле
 * `glob`, и как оно делится на несколько `--glob`, решает сам инструмент —
 * отрицания склеились бы с шаблоном менеджера непредсказуемо. Поэтому фильтр
 * стоит на выходе (хук PostToolUse): что бы ни нашёл ripgrep, строки и имена
 * файлов-секретов до модели не доходят.
 *
 * Понимает выдачу Claude (`GrepOutput`: `filenames`, `content`) и голую
 * строку. null — вырезать нечего, выдачу не трогать.
 */
export function filterPmGrepOutput(
  output: unknown,
  input: Record<string, unknown>,
  scope: PmReadScope,
): PmGrepFiltered | null {
  const home = scope.home ?? homedir();
  const searchPath = typeof input.path === 'string' && input.path.trim()
    ? resolve(scope.cwd, input.path.trim())
    : scope.cwd;
  // Относительные пути выдачи считаются от cwd сессии, но на всякий случай
  // пробуем и от папки поиска.
  const bases = [...new Set([scope.cwd, searchPath])];
  const dropped = new Set<string>();

  const filterText = (text: string): string => {
    const lines = text.split('\n');
    const kept = lines.filter((line) => {
      const file = lineFile(line, bases);
      if (file && secretFile(file, home)) {
        dropped.add(file);
        return false;
      }
      return true;
    });
    return kept.length === lines.length ? text : kept.join('\n');
  };

  if (typeof output === 'string') {
    const text = filterText(output);
    return dropped.size ? { output: text, dropped: [...dropped] } : null;
  }
  if (!output || typeof output !== 'object') return null;

  const out = { ...(output as Record<string, unknown>) };
  if (Array.isArray(out.filenames)) {
    const names = out.filenames as unknown[];
    const kept = names.filter((n) => {
      if (typeof n !== 'string') return true;
      const p = isAbsolute(n) ? n : resolve(scope.cwd, n);
      if (secretFile(p, home)) {
        dropped.add(p);
        return false;
      }
      return true;
    });
    if (kept.length !== names.length) {
      out.filenames = kept;
      if (typeof out.numFiles === 'number') out.numFiles = kept.length;
    }
  }
  if (typeof out.content === 'string') {
    const before = out.content as string;
    const after = filterText(before);
    if (after !== before) {
      out.content = after;
      if (typeof out.numLines === 'number') out.numLines = after ? after.split('\n').length : 0;
    }
  }
  return dropped.size ? { output: out, dropped: [...dropped] } : null;
}
