import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';

const run = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Все вызовы git идут через execFile с массивом аргументов — без оболочки. */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? e.message ?? '').trim() };
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
  return r.ok ? { path, branch, base } : null;
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
}

export async function mergeBranch(
  repoDir: string, branch: string, base: string,
): Promise<MergeOutcome> {
  const now = await currentBranch(repoDir);
  if (now !== base) {
    return {
      ok: false, kind: 'wrong-branch',
      message: `Основной репозиторий сейчас на ветке «${now}», а задача ответвлялась от «${base}». Переключитесь на «${base}» и повторите.`,
    };
  }

  const ahead = await git(repoDir, ['rev-list', '--count', `${base}..${branch}`]);
  if (ahead.ok && ahead.stdout === '0') {
    return { ok: true, kind: 'nothing', message: 'Изменений нет — сливать нечего.' };
  }

  const merge = await git(repoDir, ['merge', '--no-ff', '--no-edit', branch]);
  if (merge.ok) {
    return { ok: true, kind: 'merged', message: `Ветка ${branch} влита в ${base}.` };
  }

  const conflicted = await git(repoDir, ['diff', '--name-only', '--diff-filter=U']);
  await git(repoDir, ['merge', '--abort']);
  return {
    ok: false, kind: 'conflict',
    message: conflicted.stdout
      ? `Конфликт при слиянии, слияние отменено. Файлы: ${conflicted.stdout.split('\n').join(', ')}`
      : `Слияние не удалось: ${merge.stderr || merge.stdout}`,
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
