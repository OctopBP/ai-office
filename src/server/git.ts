import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, statSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Lang } from '../shared/i18n';
import { t } from './i18n';


export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Код выхода: у merge-tree единица означает конфликт, а не поломку. */
  code: number;
}

/**
 * Все вызовы git идут через execFile с массивом аргументов — без оболочки.
 *
 * Обещание собираем колбэком, а не promisify: у execFile нестандартный колбэк
 * с двумя значениями, и его свёртка в объект `{stdout, stderr}` — соглашение
 * ноды, а не часть API. Под bun из promisify приезжает одна строка stdout,
 * и весь git молча начинал отвечать «не репозиторий» — в том числе проверкам
 * слияния и ревью. Колбэк одинаков в любой среде запуска.
 */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((done) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number }) | null;
      done({
        ok: !e,
        stdout: (stdout ?? '').trim(),
        // Пустой stderr при ошибке ничего не объясняет — берём текст ошибки.
        stderr: ((stderr || e?.message) ?? '').trim(),
        code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
      });
    });
  });
}

export async function isRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout === 'true';
}

export async function hasCommits(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', 'HEAD'])).ok;
}

/**
 * Что не так с директорией как с рабочим репозиторием роли. null — всё в
 * порядке. Одна проверка на всех: её показывает старт офиса в отчёте о
 * репозиториях ролей и она же не даёт сохранить роль с негодным путём.
 * Разойдись эти два места — человек заводил бы роль без единого возражения,
 * а узнавал о неверном пути из строчки в консоли или из проваленной задачи.
 *
 * Текст готов к показу человеку: и в консоли, и под полем формы.
 */
export async function repoProblem(dir: string, lang: Lang): Promise<string | null> {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return t(lang, 'git.noDir', { dir });
  }
  if (!stat.isDirectory()) return t(lang, 'git.notDir', { dir });
  if (!(await isRepo(dir))) {
    return t(lang, 'git.notRepo', { dir });
  }
  if (!(await hasCommits(dir))) {
    return t(lang, 'git.noCommits', { dir });
  }
  return null;
}

export async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout : null;
}

/**
 * От какой ветки ответвлять задачи. Обычно это та, что сейчас в рабочей копии,
 * но копия может быть и отцеплена (например, офис увёл её, чтобы сдвинуть базу
 * мимо незакоммиченных правок) — тогда «HEAD» веткой не является, и брать её
 * за базу нельзя: задача ответвилась бы от вчерашнего коммита.
 */
export async function baseBranch(dir: string): Promise<string | null> {
  const current = await currentBranch(dir);
  if (current && current !== 'HEAD') return current;
  for (const name of ['main', 'master']) {
    if (await revision(dir, name)) return name;
  }
  return null;
}

/** Инициализировать репозиторий с первым коммитом — только для директории, которую создали мы сами. */
export async function initRepo(dir: string, lang: Lang): Promise<boolean> {
  if (!(await git(dir, ['init', '-b', 'main'])).ok) return false;
  await git(dir, ['add', '-A']);
  const commit = await git(dir, [
    '-c', 'user.name=AI Office', '-c', 'user.email=office@local',
    'commit', '-m', t(lang, 'git.initCommit'),
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
  const base = await baseBranch(repoDir);
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
  /** 'nothing' — в ветке нет коммитов сверх базовой; 'verify-failed' — проверка после слияния. */
  kind: 'merged' | 'conflict' | 'nothing' | 'verify-failed' | 'failed';
  message: string;
  /** Файлы, на которых встало слияние. Пусто, если конфликта не было. */
  conflicts: string[];
  /** Рабочая копия офиса, в которой собрано слияние: там же гоняются проверки. */
  worktree: string | null;
  /** Что стало с рабочей копией человека после того, как базовая ветка сдвинулась. */
  checkout: CheckoutSync;
}

export interface CheckoutSync {
  /**
   * 'updated'  — копия человека подтянута до новой базы, его правки на месте;
   * 'not-here' — она на другой ветке, обновлять нечего;
   * 'lagging'  — не подтянули: его незакоммиченные правки в тех же файлах.
   */
  state: 'updated' | 'not-here' | 'lagging';
  /** Файлы, из-за которых копию не удалось подтянуть. */
  files: string[];
  message: string;
}

/**
 * Рабочая копия офиса для слияний — отдельная от той, в которой сидит человек.
 *
 * Раньше офис сливал прямо в директорию проекта, и любая незакоммиченная правка
 * человека («git не даёт слить поверх ваших изменений») останавливала весь
 * конвейер. Это неверная зависимость: слияние двух веток — операция над
 * историей, к тому, что человек в этот момент правит у себя, отношения не имеет.
 */
async function integrationWorktree(
  repoDir: string, dir: string, base: string,
): Promise<string | null> {
  if (existsSync(resolve(dir, '.git'))) {
    // Копия наша, чужого в ней не бывает: приводим к базовой ветке жёстко.
    await git(dir, ['reset', '--hard']);
    await git(dir, ['clean', '-fdq']);
    const moved = await git(dir, ['checkout', '--detach', base]);
    if (moved.ok) return dir;
    await rm(dir, { recursive: true, force: true });
  }
  await git(repoDir, ['worktree', 'prune']);
  const added = await git(repoDir, ['worktree', 'add', '--detach', dir, base]);
  if (!added.ok) return null;
  await linkNodeModules(repoDir, dir);
  return dir;
}

/**
 * Сдвинуть базовую ветку на собранное слияние — так, чтобы рабочая копия
 * человека осталась связной, а его незакоммиченные правки не пострадали.
 *
 * Три случая:
 * - копия на другой ветке → просто двигаем ссылку, копии это не касается;
 * - копия на базовой и правки не мешают → `merge --ff-only`: git сам двигает
 *   ветку и обновляет файлы, не трогая посторонние правки человека;
 * - копия на базовой, но правки в тех же файлах → отцепляем её на прежнем
 *   коммите и двигаем ветку мимо. Правки остаются как были, влитое с ними
 *   не смешивается, а история едет дальше. Раньше на этом месте офис просто
 *   вставал и требовал от человека закоммитить.
 */
async function advanceBase(
  repoDir: string, base: string, oldSha: string, newSha: string, overlap: string[], lang: Lang,
): Promise<{ ok: boolean; message: string; checkout: CheckoutSync }> {
  const onBase = (await currentBranch(repoDir)) === base;

  if (onBase) {
    const ff = await git(repoDir, ['merge', '--ff-only', newSha]);
    if (ff.ok) {
      return {
        ok: true, message: '',
        checkout: {
          state: 'updated', files: [],
          message: t(lang, 'git.checkout.updated', { base }),
        },
      };
    }
    const detached = await git(repoDir, ['checkout', '--detach', oldSha]);
    if (!detached.ok) {
      return {
        ok: false,
        message: t(lang, 'git.moveFailed', { base, error: detached.stderr || ff.stderr }),
        checkout: { state: 'lagging', files: overlap, message: '' },
      };
    }
  }

  // Старое значение — защита от гонки: если ветку кто-то двинул, пока шло
  // слияние, update-ref откажет и чужой коммит не потеряется.
  const moved = await git(repoDir, ['update-ref', `refs/heads/${base}`, newSha, oldSha]);
  if (!moved.ok) {
    return {
      ok: false,
      message: t(lang, 'git.baseMoved', { base }),
      checkout: { state: 'not-here', files: [], message: '' },
    };
  }

  return {
    ok: true, message: '',
    checkout: onBase
      ? {
        state: 'lagging', files: overlap,
        message: t(lang, 'git.checkout.lagging', {
          base,
          files: overlap.length
            ? t(lang, 'git.checkout.laggingFiles', { files: overlap.join(', ') })
            : '',
        }),
      }
      : { state: 'not-here', files: [], message: t(lang, 'git.checkout.notHere', { base }) },
  };
}

/**
 * Влить ветку задачи в базовую. Слияние собирается в рабочей копии офиса, а
 * базовая ветка сдвигается атомарно: `update-ref` со старым значением не даст
 * затереть чужой коммит, если ветка уехала, пока мы сливали.
 *
 * verify — проверка собранного слияния ДО того, как базовая ветка сдвинется.
 * Не прошла — базовая ветка остаётся нетронутой: сломанная сборка в неё
 * не попадает вовсе, а не «попадает, зато мы про это скажем».
 */
export async function mergeBranch(
  repoDir: string, branch: string, base: string, integrationDir: string, lang: Lang,
  verify?: (worktree: string) => Promise<{ ok: boolean; message: string }>,
): Promise<MergeOutcome> {
  const nothingToDo = (message: string, kind: MergeOutcome['kind'] = 'nothing'): MergeOutcome => ({
    ok: kind === 'nothing', kind, message, conflicts: [], worktree: null,
    checkout: { state: 'not-here', files: [], message: '' },
  });

  const baseSha = await revision(repoDir, base);
  if (!baseSha) return nothingToDo(t(lang, 'git.noBase', { base }), 'failed');
  if (!(await revision(repoDir, branch))) {
    return nothingToDo(t(lang, 'git.noBranch', { branch }), 'failed');
  }

  const ahead = await git(repoDir, ['rev-list', '--count', `${base}..${branch}`]);
  if (ahead.ok && ahead.stdout === '0') {
    return nothingToDo(t(lang, 'git.nothingToMerge'));
  }

  const worktree = await integrationWorktree(repoDir, integrationDir, base);
  if (!worktree) {
    return nothingToDo(t(lang, 'git.noIntegrationCopy'), 'failed');
  }

  const merge = await git(worktree, [
    '-c', 'user.name=AI Office', '-c', 'user.email=office@local',
    'merge', '--no-ff', '--no-edit', branch,
  ]);
  if (!merge.ok) {
    const conflicted = await git(worktree, ['diff', '--name-only', '--diff-filter=U']);
    const files = splitLines(conflicted.stdout);
    await git(worktree, ['merge', '--abort']);
    return {
      ok: false, kind: 'conflict', worktree,
      message: files.length
        ? t(lang, 'git.mergeConflict', { files: files.join(', ') })
        : t(lang, 'git.mergeFailed', { error: merge.stderr || merge.stdout }),
      conflicts: files,
      checkout: { state: 'not-here', files: [], message: '' },
    };
  }

  if (verify) {
    const checked = await verify(worktree);
    if (!checked.ok) {
      // Базовую ветку не двигаем вовсе: она остаётся ровно такой, какой была.
      await git(worktree, ['reset', '--hard', base]);
      return {
        ok: false, kind: 'verify-failed', worktree, conflicts: [],
        message: checked.message,
        checkout: { state: 'not-here', files: [], message: '' },
      };
    }
  }

  const newSha = await revision(worktree, 'HEAD');
  if (!newSha) return nothingToDo(t(lang, 'git.noMergeCommit'), 'failed');

  // Пересечение «что меняет слияние» и «что человек правит прямо сейчас»
  // считаем ДО сдвига ветки: после него HEAD уже новый и сравнивать не с чем.
  const localMods = splitLines((await git(repoDir, ['diff', '--name-only', 'HEAD'])).stdout);
  const mergedFiles = splitLines((await git(repoDir, ['diff', '--name-only', baseSha, newSha])).stdout);
  const overlap = mergedFiles.filter((f) => localMods.includes(f));

  const moved = await advanceBase(repoDir, base, baseSha, newSha, overlap, lang);
  if (!moved.ok) return nothingToDo(moved.message, 'failed');

  return {
    ok: true, kind: 'merged', worktree, conflicts: [],
    message: t(lang, 'git.merged', { branch, base }),
    checkout: moved.checkout,
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
  repoDir: string, branch: string, base: string, lang: Lang,
): Promise<MergeCheckResult> {
  for (const ref of [base, branch]) {
    if (!(await git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`])).ok) {
      return { state: 'unknown', conflicts: [], message: t(lang, 'git.noRef', { ref }) };
    }
  }

  const ahead = await git(repoDir, ['rev-list', '--count', `${base}..${branch}`]);
  if (ahead.ok && ahead.stdout === '0') {
    return {
      state: 'nothing', conflicts: [], message: t(lang, 'git.nothingBeyond', { branch, base }),
    };
  }

  const tree = await git(repoDir, ['merge-tree', '--write-tree', '--name-only', base, branch]);
  if (tree.ok) {
    return { state: 'clean', conflicts: [], message: t(lang, 'git.mergesClean', { base }) };
  }
  // Единица и хеш дерева первой строкой — это конфликт, а не сбой команды.
  const lines = tree.stdout.split('\n');
  if (tree.code === 1 && /^[0-9a-f]{40,64}$/.test(lines[0]?.trim() ?? '')) {
    const conflicts = collectConflictNames(lines.slice(1));
    return { state: 'conflict', conflicts, message: conflictMessage(base, conflicts, lang) };
  }

  return checkMergeableInWorktree(repoDir, branch, base, tree.stderr || tree.stdout, lang);
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

const conflictMessage = (base: string, conflicts: string[], lang: Lang): string => (conflicts.length
  ? t(lang, 'git.conflictsWithFiles', { base, files: conflicts.join(', ') })
  : t(lang, 'git.conflictsWith', { base }));

/** Запасной путь для старого git: слияние во временном worktree с откатом. */
async function checkMergeableInWorktree(
  repoDir: string, branch: string, base: string, reason: string, lang: Lang,
): Promise<MergeCheckResult> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), 'office-merge-check-'));
  } catch {
    return { state: 'unknown', conflicts: [], message: t(lang, 'git.checkFailed', { error: reason }) };
  }
  const path = resolve(dir, 'wt');
  const added = await git(repoDir, ['worktree', 'add', '--detach', path, base]);
  if (!added.ok) {
    await rm(dir, { recursive: true, force: true });
    return {
      state: 'unknown', conflicts: [], message: t(lang, 'git.checkFailed', { error: added.stderr || reason }),
    };
  }
  try {
    const merge = await git(path, ['merge', '--no-commit', '--no-ff', branch]);
    if (merge.ok) return { state: 'clean', conflicts: [], message: t(lang, 'git.mergesClean', { base }) };
    const conflicted = await git(path, ['diff', '--name-only', '--diff-filter=U']);
    const conflicts = splitLines(conflicted.stdout);
    if (!conflicts.length) {
      return {
        state: 'unknown', conflicts: [],
        message: t(lang, 'git.checkFailed', { error: merge.stderr || merge.stdout }),
      };
    }
    return { state: 'conflict', conflicts, message: conflictMessage(base, conflicts, lang) };
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
  repoDir: string, base: string, branch: string, lang: Lang,
): Promise<Diff | { error: string }> {
  const exists = await git(repoDir, ['rev-parse', '--verify', branch]);
  if (!exists.ok) return { error: t(lang, 'git.branchGone', { branch }) };

  // Три точки: изменения ветки от точки расхождения, без чужих коммитов из base.
  const stat = await git(repoDir, ['diff', '--stat', `${base}...${branch}`]);
  if (!stat.ok) return { error: stat.stderr || t(lang, 'git.diffFailed') };
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

/** Есть ли в рабочей копии незакоммиченные правки. */
export async function isDirty(dir: string): Promise<boolean> {
  const r = await git(dir, ['status', '--porcelain']);
  return r.ok && r.stdout !== '';
}

/** Хеш ветки или ревизии. null — такой ревизии нет. */
export async function revision(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--verify', ref]);
  return r.ok && r.stdout ? r.stdout : null;
}

export interface BaseMerge {
  /** 'nothing' — база не ушла вперёд, сливать нечего. */
  kind: 'merged' | 'nothing' | 'conflict' | 'failed';
  conflicts: string[];
  message: string;
}

/**
 * Влить базовую ветку В ветку задачи, прямо в рабочей копии исполнителя.
 * Обратное направление обычному слиянию: так автор разбирается со своими
 * конфликтами сам и в своей копии, а основная ветка до самого конца остаётся
 * нетронутой.
 *
 * Конфликт НЕ отменяем: рабочая копия остаётся в состоянии незавершённого
 * слияния — именно её и чинит автор, а потом коммитит результат.
 */
export async function mergeBaseInto(
  worktreePath: string, base: string, lang: Lang,
): Promise<BaseMerge> {
  const behind = await git(worktreePath, ['rev-list', '--count', `HEAD..${base}`]);
  if (behind.ok && behind.stdout === '0') {
    return { kind: 'nothing', conflicts: [], message: t(lang, 'git.alreadyIncludes', { base }) };
  }

  const merge = await git(worktreePath, [
    '-c', 'user.name=AI Office', '-c', 'user.email=office@local',
    'merge', '--no-edit', base,
  ]);
  if (merge.ok) {
    return { kind: 'merged', conflicts: [], message: t(lang, 'git.baseMergedIn', { base }) };
  }

  const conflicted = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  const conflicts = splitLines(conflicted.stdout);
  if (!conflicts.length) {
    // Не конфликт, а поломка: откатываем, чтобы не оставить копию в полуслиянии.
    await git(worktreePath, ['merge', '--abort']);
    return {
      kind: 'failed', conflicts: [],
      message: t(lang, 'git.baseMergeFailed', { base, error: merge.stderr || merge.stdout }),
    };
  }
  return {
    kind: 'conflict', conflicts,
    message: t(lang, 'git.conflictFiles', { base, files: conflicts.join(', ') }),
  };
}

/** Идёт ли в рабочей копии незавершённое слияние. */
export async function mergeInProgress(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--verify', 'MERGE_HEAD']);
  return r.ok;
}

/** Бросить незавершённое слияние и вернуть копию как было. */
export async function abortMerge(dir: string): Promise<void> {
  await git(dir, ['merge', '--abort']);
}

/**
 * URL для походов в origin с токеном. Токен подставляется только в аргументы
 * одной команды и никогда не пишется в конфиг репозитория: иначе он утечёт
 * в .git/config вместе с проектом.
 */
function authUrl(url: string, token: string | null): string {
  if (!token) return url;
  const m = /^https:\/\/(?:[^@/]*@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (!m) return url;
  return `https://x-access-token:${token}@${m[1]}/${m[2]}.git`;
}

/** Отправить ветку в origin. force — ветку задачи переписывает только её автор. */
export async function pushBranch(
  repoDir: string, branch: string, token: string | null, lang: Lang,
): Promise<{ ok: boolean; message: string }> {
  const url = await remoteUrl(repoDir);
  if (!url) return { ok: false, message: t(lang, 'git.noOrigin') };
  const r = await git(repoDir, ['push', '--force-with-lease', authUrl(url, token), `${branch}:${branch}`]);
  return {
    ok: r.ok,
    // Токен мог попасть в текст ошибки вместе с URL — вырезаем.
    message: hideToken(r.ok ? r.stdout : (r.stderr || r.stdout), token),
  };
}

/** Убрать ветку задачи из origin — после того как её слили. */
export async function deleteRemoteBranch(
  repoDir: string, branch: string, token: string | null,
): Promise<boolean> {
  const url = await remoteUrl(repoDir);
  if (!url) return false;
  return (await git(repoDir, ['push', authUrl(url, token), '--delete', branch])).ok;
}

/** Подтянуть origin целиком: база могла уехать не только у нас. */
export async function fetchRemote(repoDir: string, token: string | null): Promise<boolean> {
  const url = await remoteUrl(repoDir);
  if (!url) return false;
  return (await git(repoDir, ['fetch', authUrl(url, token), '--prune'])).ok;
}

const hideToken = (s: string, token: string | null): string =>
  (token ? s.split(token).join('***') : s);

/**
 * Вернуть рабочую копию ветки задачи. Обычно она уже есть — её сделал
 * исполнитель; но конвейер переживает перезапуск сервера и уборку каталогов,
 * а чинить ветку без рабочей копии негде.
 */
export async function ensureWorktree(
  repoDir: string, worktreesRoot: string, taskId: string, branch: string,
): Promise<string | null> {
  const path = resolve(worktreesRoot, taskId);
  if (existsSync(resolve(path, '.git'))) return path;

  await rm(path, { recursive: true, force: true });
  await git(repoDir, ['worktree', 'prune']);
  const added = await git(repoDir, ['worktree', 'add', path, branch]);
  if (!added.ok) return null;
  await linkNodeModules(repoDir, path);
  return path;
}

/**
 * Подтянуть базовую ветку к удалённой без слияния. Нужно после того, как
 * пулл-реквест влили на GitHub: локальная копия основной ветки иначе отстаёт,
 * и следующая задача ответвится от вчерашнего кода.
 */
export async function fastForward(repoDir: string, base: string, remoteRef: string): Promise<boolean> {
  const now = await currentBranch(repoDir);
  if (now !== base) return false;
  if (await isDirty(repoDir)) return false;
  return (await git(repoDir, ['merge', '--ff-only', remoteRef])).ok;
}
