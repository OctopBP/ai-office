import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

const run = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Код выхода: у merge-tree единица означает конфликт, а не поломку. */
  code: number;
}

/** Все вызовы git идут через execFile с массивом аргументов — без оболочки. */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? '').trim(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export async function isRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout === 'true';
}

export async function hasCommits(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', 'HEAD'])).ok;
}

export async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout : null;
}

/** Инициализировать репозиторий с первым коммитом — только для директории, которую создали мы сами. */
export async function initRepo(dir: string): Promise<boolean> {
  if (!(await git(dir, ['init', '-b', 'main'])).ok) return false;
  await git(dir, ['add', '-A']);
  const commit = await git(dir, [
    '-c', 'user.name=AI Office', '-c', 'user.email=office@local',
    'commit', '-m', 'Начальное состояние рабочей директории',
  ]);
  return commit.ok;
}

/**
 * Отдельный worktree на задачу: исполнители работают в разных директориях
 * на разных ветках и физически не могут затереть друг друга.
 */
export async function createWorktree(
  repoDir: string, worktreesRoot: string, taskId: string,
): Promise<{ path: string; branch: string; base: string } | null> {
  const base = await currentBranch(repoDir);
  if (!base) return null;

  const branch = `task/${taskId}`;
  const path = resolve(worktreesRoot, taskId);

  // Подчищаем хвосты от прошлых прогонов с тем же id.
  await rm(path, { recursive: true, force: true });
  await git(repoDir, ['worktree', 'prune']);
  await git(repoDir, ['branch', '-D', branch]);

  const r = await git(repoDir, ['worktree', 'add', '-b', branch, path, base]);
  if (!r.ok) return null;
  await linkNodeModules(repoDir, path);
  return { path, branch, base };
}

/**
 * Зависимости в worktree — симлинком на основной node_modules. Свежий worktree
 * пуст, и без этого исполнитель не может ни собрать проект, ни прогнать
 * проверки: он видит исходники, но не то, чем они запускаются.
 *
 * Проверяем игнор УЖЕ ПОСЛЕ создания симлинка и в самом worktree: правило
 * вида `node_modules/` со слэшем матчит каталог, но не симлинк на него, —
 * такой симлинк ушёл бы в коммит задачи и уехал в основную ветку при слиянии.
 * Не игнорируется — убираем: остаться без зависимостей лучше, чем насорить
 * в чужом репозитории.
 */
async function linkNodeModules(repoDir: string, worktreePath: string): Promise<void> {
  const src = resolve(repoDir, 'node_modules');
  const dest = resolve(worktreePath, 'node_modules');
  if (!existsSync(src) || existsSync(dest)) return;
  try {
    symlinkSync(src, dest, 'dir');
  } catch {
    return;   // не вышло — исполнитель просто останется без зависимостей
  }
  if (!(await git(worktreePath, ['check-ignore', '-q', 'node_modules'])).ok) {
    await rm(dest, { force: true });
  }
}

/** Коммитим за исполнителя сами: так надёжнее, чем надеяться, что он не забудет. */
export async function commitAll(worktreePath: string, message: string): Promise<'committed' | 'empty' | 'failed'> {
  if (!(await git(worktreePath, ['add', '-A'])).ok) return 'failed';
  const status = await git(worktreePath, ['status', '--porcelain']);
  if (status.ok && status.stdout === '') return 'empty';
  const commit = await git(worktreePath, [
    '-c', 'user.name=AI Office', '-c', 'user.email=office@local',
    'commit', '-m', message,
  ]);
  return commit.ok ? 'committed' : 'failed';
}

export interface MergeOutcome {
  ok: boolean;
  /** 'merged' | 'conflict' | 'nothing' | 'wrong-branch' | 'failed' */
  kind: 'merged' | 'conflict' | 'nothing' | 'wrong-branch' | 'failed';
  message: string;
  /** Файлы, на которых встало слияние. Пусто, если конфликта не было. */
  conflicts: string[];
}

export async function mergeBranch(
  repoDir: string, branch: string, base: string,
): Promise<MergeOutcome> {
  const now = await currentBranch(repoDir);
  if (now !== base) {
    return {
      ok: false, kind: 'wrong-branch',
      message: `Основной репозиторий сейчас на ветке «${now}», а задача ответвлялась от «${base}». Переключитесь на «${base}» и повторите.`,
      conflicts: [],
    };
  }

  const ahead = await git(repoDir, ['rev-list', '--count', `${base}..${branch}`]);
  if (ahead.ok && ahead.stdout === '0') {
    return { ok: true, kind: 'nothing', message: 'Изменений нет — сливать нечего.', conflicts: [] };
  }

  const merge = await git(repoDir, ['merge', '--no-ff', '--no-edit', branch]);
  if (merge.ok) {
    return { ok: true, kind: 'merged', message: `Ветка ${branch} влита в ${base}.`, conflicts: [] };
  }

  const conflicted = await git(repoDir, ['diff', '--name-only', '--diff-filter=U']);
  const files = splitLines(conflicted.stdout);
  await git(repoDir, ['merge', '--abort']);
  return {
    ok: false, kind: 'conflict',
    message: files.length
      ? `Конфликт при слиянии, слияние отменено. Файлы: ${files.join(', ')}`
      : `Слияние не удалось: ${merge.stderr || merge.stdout}`,
    conflicts: files,
  };
}

const splitLines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

export interface MergeCheckResult {
  /** 'clean' — сольётся без конфликтов, 'nothing' — сливать нечего. */
  state: 'clean' | 'conflict' | 'nothing' | 'unknown';
  conflicts: string[];
  /** Готовая фраза для интерфейса. */
  message: string;
}

/**
 * Сухая проверка: сольётся ли ветка задачи в базовую. Ничего не меняет —
 * ни рабочую копию, ни базовую ветку, ни индекс.
 *
 * Основной путь — `git merge-tree --write-tree`: слияние считается целиком
 * в объектной базе, рабочая копия не участвует. На git старше 2.38 этой формы
 * нет — там пробуем то же самое во временном отсоединённом worktree
 * (`merge --no-commit --no-ff` с последующим `merge --abort`), он тоже никак
 * не трогает основную ветку.
 */
export async function checkMergeable(
  repoDir: string, branch: string, base: string,
): Promise<MergeCheckResult> {
  for (const ref of [base, branch]) {
    if (!(await git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`])).ok) {
      return { state: 'unknown', conflicts: [], message: `Ветки ${ref} нет в репозитории — проверить нечего.` };
    }
  }

  const ahead = await git(repoDir, ['rev-list', '--count', `${base}..${branch}`]);
  if (ahead.ok && ahead.stdout === '0') {
    return { state: 'nothing', conflicts: [], message: `Сливать нечего: в ${branch} нет коммитов сверх ${base}.` };
  }

  const tree = await git(repoDir, ['merge-tree', '--write-tree', '--name-only', base, branch]);
  if (tree.ok) {
    return { state: 'clean', conflicts: [], message: `Сливается чисто в ${base}.` };
  }
  // Единица и хеш дерева первой строкой — это конфликт, а не сбой команды.
  const lines = tree.stdout.split('\n');
  if (tree.code === 1 && /^[0-9a-f]{40,64}$/.test(lines[0]?.trim() ?? '')) {
    const conflicts = collectConflictNames(lines.slice(1));
    return { state: 'conflict', conflicts, message: conflictMessage(base, conflicts) };
  }

  return checkMergeableInWorktree(repoDir, branch, base, tree.stderr || tree.stdout);
}

/**
 * У `merge-tree --name-only` после списка файлов идёт пустая строка,
 * а за ней пояснения вида «CONFLICT (content): …» — они не имена файлов.
 */
function collectConflictNames(lines: string[]): string[] {
  const names: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) break;
    names.push(line);
  }
  return names;
}

const conflictMessage = (base: string, conflicts: string[]): string => (conflicts.length
  ? `Конфликтует с ${base} в файлах: ${conflicts.join(', ')}`
  : `Конфликтует с ${base}.`);

/** Запасной путь для старого git: слияние во временном worktree с откатом. */
async function checkMergeableInWorktree(
  repoDir: string, branch: string, base: string, reason: string,
): Promise<MergeCheckResult> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), 'office-merge-check-'));
  } catch {
    return { state: 'unknown', conflicts: [], message: `Проверить слияние не удалось: ${reason}` };
  }
  const path = resolve(dir, 'wt');
  const added = await git(repoDir, ['worktree', 'add', '--detach', path, base]);
  if (!added.ok) {
    await rm(dir, { recursive: true, force: true });
    return { state: 'unknown', conflicts: [], message: `Проверить слияние не удалось: ${added.stderr || reason}` };
  }
  try {
    const merge = await git(path, ['merge', '--no-commit', '--no-ff', branch]);
    if (merge.ok) return { state: 'clean', conflicts: [], message: `Сливается чисто в ${base}.` };
    const conflicted = await git(path, ['diff', '--name-only', '--diff-filter=U']);
    const conflicts = splitLines(conflicted.stdout);
    if (!conflicts.length) {
      return { state: 'unknown', conflicts: [], message: `Проверить слияние не удалось: ${merge.stderr || merge.stdout}` };
    }
    return { state: 'conflict', conflicts, message: conflictMessage(base, conflicts) };
  } finally {
    await git(path, ['merge', '--abort']);
    await git(repoDir, ['worktree', 'remove', path, '--force']);
    await git(repoDir, ['worktree', 'prune']);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Ограничение на размер патча: гигантский дифф незачем гнать в браузер. */
const MAX_PATCH = 200_000;

export interface Diff {
  stat: string;
  patch: string;
  truncated: boolean;
}

/** Что задача изменила относительно базовой ветки. */
export async function diffBranch(
  repoDir: string, base: string, branch: string,
): Promise<Diff | { error: string }> {
  const exists = await git(repoDir, ['rev-parse', '--verify', branch]);
  if (!exists.ok) return { error: `Ветки ${branch} больше нет — возможно, она уже влита и удалена.` };

  // Три точки: изменения ветки от точки расхождения, без чужих коммитов из base.
  const stat = await git(repoDir, ['diff', '--stat', `${base}...${branch}`]);
  if (!stat.ok) return { error: stat.stderr || 'git diff не отработал' };
  if (!stat.stdout) return { stat: '', patch: '', truncated: false };

  const patch = await git(repoDir, ['diff', `${base}...${branch}`]);
  const full = patch.stdout;
  return {
    stat: stat.stdout,
    patch: full.slice(0, MAX_PATCH),
    truncated: full.length > MAX_PATCH,
  };
}

export async function removeWorktree(
  repoDir: string, path: string, branch: string,
  options: { keepBranch?: boolean } = {},
): Promise<void> {
  await git(repoDir, ['worktree', 'remove', path, '--force']);
  await git(repoDir, ['worktree', 'prune']);
  if (!options.keepBranch) await git(repoDir, ['branch', '-D', branch]);
}

/** Есть ли в ветке коммиты сверх базовой. */
export async function hasWork(repoDir: string, branch: string, base: string): Promise<boolean> {
  const r = await git(repoDir, ['rev-list', '--count', `${base}..${branch}`]);
  return r.ok && r.stdout !== '0';
}

/**
 * Сохранить ветку под новым именем вместо удаления.
 * Нужно при перезапуске задачи: обещали, что сделанное не пропадёт.
 */
export async function preserveBranch(repoDir: string, branch: string): Promise<string | null> {
  for (let n = 1; n < 50; n += 1) {
    const target = `${branch}.stopped-${n}`;
    const exists = await git(repoDir, ['rev-parse', '--verify', target]);
    if (exists.ok) continue;
    const renamed = await git(repoDir, ['branch', '-m', branch, target]);
    return renamed.ok ? target : null;
  }
  return null;
}

/** URL origin — по нему облачный режим понимает, какой репозиторий монтировать. */
export async function remoteUrl(dir: string): Promise<string | null> {
  const res = await git(dir, ['remote', 'get-url', 'origin']);
  return res.ok && res.stdout ? res.stdout : null;
}

/**
 * Забрать ветку из origin в локальный репозиторий. Облачный исполнитель
 * пушит результат в GitHub, и без этого «Показать diff» и «Смержить»
 * не с чем работать.
 */
export async function fetchBranch(dir: string, branch: string): Promise<boolean> {
  const res = await git(dir, ['fetch', 'origin', `+${branch}:${branch}`]);
  return res.ok;
}
