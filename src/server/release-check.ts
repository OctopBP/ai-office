/**
 * Проверка цели выпуска до первого выпуска (T-554).
 *
 * Ошибки настройки цели раньше всплывали только на первом выпуске: цель
 * завели в офисе, корень которого не git-репозиторий, и узнали об этом уже
 * после `start_release`. Здесь то же самое выясняется заранее — при
 * предложении цели, перед стартом выпуска и в `release_status`.
 *
 * `checkReleaseTarget` — чистая: всё, что она знает о диске и git, приходит
 * через `TargetProbe`. Проверяется только то, что можно проверить надёжно;
 * сомнительное (кавычки, подстановки, незнакомые программы) пропускается —
 * лучше не заметить проблему, чем выдумать её.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ReleaseTarget } from '../shared/release';
import { projectEnv } from './childenv';

/** Что проверка спрашивает у диска и git. В тестах подменяется. */
export interface TargetProbe {
  isDir(path: string): boolean;
  isFile(path: string): boolean;
  /** Папка лежит в рабочей копии git. */
  isRepo(dir: string): boolean;
  /** В репозитории есть хотя бы один коммит. */
  hasCommit(dir: string): boolean;
  /** У репозитория есть удалённый origin. */
  hasOrigin(dir: string): boolean;
  /** Что лежит по пути (относительно `dir`) в коммите HEAD. */
  committed(dir: string, path: string): 'file' | 'dir' | null;
}

export type TargetProblemCode =
  | 'noRepoDir' | 'notGit' | 'noTargetRepo' | 'noCommits' | 'workDirOutside' | 'noWorkDir'
  | 'noOrigin' | 'noScript' | 'noCdDir' | 'noGemfile' | 'noPackageJson';

export interface TargetProblem {
  code: TargetProblemCode;
  /** Блокирующая: выпуск с ней встанет наверняка. Остальные — предупреждения. */
  blocking: boolean;
  /** Подстановки для текста из словаря (`rel.check.<code>`). */
  vars: Record<string, string>;
}

export interface TargetCheckInput {
  target: ReleaseTarget;
  /** Корень офиса. */
  officeDir: string;
  /** Общий репозиторий ролей офиса — запасной, когда корень офиса не git. */
  sharedRepo?: string | null;
  /** Команда сборки цели `kind=command` (из проверок проекта). */
  command?: string | null;
  /**
   * Цель ждёт задачу, которая ещё не слита: рабочей папки может пока не быть —
   * её отсутствие тогда предупреждение, а не отказ.
   */
  pending?: boolean;
}

const gitOut = (dir: string, args: string[]): string | null => {
  try {
    return execFileSync(process.env.OFFICE_GIT_BIN || 'git', args, {
      cwd: dir, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env: projectEnv(),
    }).trim();
  } catch {
    return null;
  }
};

const isDir = (path: string): boolean => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/** Настоящие диск и git. Вызовы синхронные и короткие: `rev-parse`, `cat-file`. */
export const diskProbe: TargetProbe = {
  isDir,
  isFile(path) {
    try { return statSync(path).isFile(); } catch { return false; }
  },
  isRepo: (dir) => isDir(dir) && gitOut(dir, ['rev-parse', '--is-inside-work-tree']) === 'true',
  hasCommit: (dir) => Boolean(gitOut(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])),
  hasOrigin: (dir) => Boolean(gitOut(dir, ['remote', 'get-url', 'origin'])),
  committed(dir, path) {
    if (!existsSync(dir)) return null;
    const type = gitOut(dir, ['cat-file', '-t', `HEAD:./${path.split(sep).join('/')}`]);
    return type === 'tree' ? 'dir' : type === 'blob' ? 'file' : null;
  },
};

/** Путь лежит внутри папки (или это она сама). */
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
};

/** Слово команды, которое читается буквально: без кавычек, подстановок и масок. */
const PLAIN = /^[\w@%+=:,./-]+$/;

/** Программы, первым аргументом которых идёт файл скрипта. */
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node', 'tsx', 'ts-node', 'python', 'python3', 'ruby']);
/** Расширения, которые node и tsx дописывают к имени сами. */
const NODE_EXT = ['.js', '.cjs', '.mjs', '.ts', '.json'];
/** Подкоманды npm, yarn и pnpm, которым нужен package.json. */
const PACKAGE_COMMANDS = new Set(['run', 'run-script', 'version', 'test', 'start', 'ci', 'publish', 'pack']);
/** Ключи, уводящие менеджер пакетов или bundler в другую папку: тогда искать от `workDir` нечестно. */
const ELSEWHERE = /^(--prefix|--cwd|--dir|-C|--gemfile)(=|$)/;

/**
 * Проверка цели выпуска: список проблем, пустой — цель в порядке.
 * Блокирующие — нет репозитория, не git, нет коммитов, нет рабочей папки.
 */
export function checkReleaseTarget(input: TargetCheckInput, probe: TargetProbe = diskProbe): TargetProblem[] {
  const { target } = input;
  const out: TargetProblem[] = [];
  const add = (code: TargetProblemCode, blocking: boolean, vars: Record<string, string> = {}) => {
    if (!out.some((p) => p.code === code && JSON.stringify(p.vars) === JSON.stringify(vars))) out.push({ code, blocking, vars });
  };

  // Репозиторий: названный целью обязан быть git; не названный — корень офиса
  // или, если тот не git, общий репозиторий ролей (как `resolveReleaseRepo`).
  const named = target.repoDir || (target.repo ? resolve(input.officeDir, target.repo) : input.officeDir);
  const explicit = Boolean(target.repoDir || target.repo);
  let repo = named;
  if (!probe.isRepo(named)) {
    if (explicit) {
      add(probe.isDir(named) ? 'notGit' : 'noRepoDir', true, { dir: named });
      return out;
    }
    if (input.sharedRepo && probe.isRepo(input.sharedRepo)) {
      repo = input.sharedRepo;
    } else {
      add(probe.isDir(named) ? 'noTargetRepo' : 'noRepoDir', true, { dir: named, target: target.id });
      return out;
    }
  }
  if (!probe.hasCommit(repo)) {
    add('noCommits', true, { dir: repo });
    return out;
  }

  /** Путь есть в репозитории: на диске или в последнем коммите. */
  const has = (path: string, kind: 'file' | 'dir' | 'any'): boolean => {
    if ((kind !== 'dir' && probe.isFile(path)) || (kind !== 'file' && probe.isDir(path))) return true;
    if (!inside(repo, path) || path === repo) return false;
    const got = probe.committed(repo, relative(repo, path));
    return got !== null && (kind === 'any' || got === kind);
  };

  // Рабочая папка нужна только командам: сборке, `bump` и чтению версии.
  const read = target.version.source === 'command' ? target.version.read ?? null : null;
  const command = target.kind === 'command' ? input.command ?? null : null;
  let cwd = repo;
  if (target.workDir) {
    cwd = resolve(repo, target.workDir);
    const used = Boolean(command || target.kind === 'command' || target.bump);
    if (isAbsolute(target.workDir) || !inside(repo, cwd)) {
      add('workDirOutside', used, { dir: target.workDir, repo });
      return out;
    }
    if (!has(cwd, 'dir')) {
      add('noWorkDir', used && !input.pending, { dir: target.workDir, repo });
      return out;
    }
  }

  // push отправляет ветку в origin; тег без origin остаётся локальным — это не ошибка.
  if (target.kind === 'push' && !probe.hasOrigin(repo)) add('noOrigin', false, { branch: target.branch ?? '', repo });

  /** Ближайший вверх от папки файл с одним из имён — не выше корня репозитория. */
  const upward = (from: string, names: string[]): boolean => {
    for (let dir = from; inside(repo, dir); dir = dirname(dir)) {
      if (names.some((name) => has(resolve(dir, name), 'file'))) return true;
      if (dir === repo) break;
    }
    return false;
  };

  /** Первая программа команды: её скрипт, Gemfile или package.json должны найтись. */
  const checkCommand = (text: string): void => {
    let at = cwd;
    for (const segment of text.split(/&&|;|\n/).map((s) => s.trim())) {
      const words = segment.split(/\s+/).filter(Boolean);
      // Переменные перед командой (`CI=1 bash build.sh`) программу не меняют.
      while (words.length && /^[A-Za-z_]\w*=/.test(words[0]) && PLAIN.test(words[0])) words.shift();
      const [bin, arg] = words;
      if (!bin || !PLAIN.test(bin)) return;
      if (bin === 'cd') {
        // `cd ios && bundle exec …`: дальше смотрим из новой папки.
        if (words.length !== 2 || !PLAIN.test(arg) || isAbsolute(arg)) return;
        at = resolve(at, arg);
        if (!has(at, 'dir')) return add('noCdDir', false, { dir: arg, command: text });
        continue;
      }
      const elsewhere = words.some((w) => ELSEWHERE.test(w)) || /BUNDLE_GEMFILE/.test(segment);
      if (INTERPRETERS.has(bin)) {
        if (!arg || arg.startsWith('-') || !PLAIN.test(arg)) return;
        const file = resolve(at, arg);
        const found = has(file, 'any') || NODE_EXT.some((ext) => has(`${file}${ext}`, 'file'));
        if (!found) add('noScript', false, { file: arg, command: text });
      } else if (bin.includes('/')) {
        if (!has(resolve(at, bin), 'file')) add('noScript', false, { file: bin, command: text });
      } else if (bin === 'bundle') {
        if (!elsewhere && !upward(at, ['Gemfile', 'gems.rb'])) add('noGemfile', false, { command: text });
      } else if (bin === 'npm' || bin === 'yarn' || bin === 'pnpm') {
        if (!elsewhere && PACKAGE_COMMANDS.has(arg ?? '') && !upward(at, ['package.json'])) {
          add('noPackageJson', false, { command: text });
        }
      }
      return;
    }
  };

  if (command) checkCommand(command);
  if (target.bump) checkCommand(target.bump);
  if (read) checkCommand(read);
  // Версия из package.json читается ровно из рабочей папки цели, вверх не ищется.
  if (target.version.source === 'package.json' && !has(resolve(cwd, 'package.json'), 'file')) {
    add('noPackageJson', false, { command: 'version.source: package.json' });
  }
  return out;
}

export const hasBlocking = (problems: TargetProblem[]): boolean => problems.some((p) => p.blocking);
