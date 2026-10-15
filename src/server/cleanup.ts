/**
 * Уборка веток и рабочих копий (git worktree) задач.
 *
 * Сам офис снимает ветку и worktree задачи только после слияния. Всё прочее
 * копится: ветки снятых задач (drop_task, когда работа уже начата),
 * проваленных и закрытых без слияния; ветки прошлых попыток, которые
 * restart_task сохраняет как `task/T-N.stopped-K` (`preserveBranch` в git.ts);
 * посторонние worktree в каталоге копий офиса — например, в `_base`, заведённые
 * мимо офиса.
 *
 * Два шага, и первый ничего не меняет:
 *   findStale — собрать кандидатов и решить по каждому, можно ли удалять;
 *   prune     — удалить то, что помечено к удалению, и отчитаться.
 *
 * Правила. Удалять можно ветки и worktree задач в статусах done, cancelled,
 * failed (done без слияния — «закрыта без слияния»), а ветки прошлых попыток —
 * если последний коммит старше N дней. Никогда не трогаем: основную и текущую
 * ветку, задачи в работе, на ревью и blocked, ветки выпусков, worktree с
 * незакоммиченными изменениями (они уходят предупреждением) и заблокированные
 * `git worktree lock`. Сироты без задачи по умолчанию только показываются.
 *
 * Состояние офиса модуль не читает сам: задачи приходят аргументом. Так им
 * одинаково пользуются консольная команда (читает файл состояния) и проверки
 * (подсовывают список руками).
 */
import { realpathSync } from 'node:fs';
import { basename, relative, resolve, isAbsolute } from 'node:path';
import type { TaskStatus } from '../shared/types';
import { baseBranch, currentBranch, git, repoTop } from './git';

/** Ровно то из задачи, что нужно уборке. */
export interface CleanupTask {
  id: string;
  status: TaskStatus;
  merged?: boolean;
  branch?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
}

export interface CleanupOffice {
  /** Репозиторий, в котором убираем. Любая папка внутри него. */
  repoDir: string;
  tasks: CleanupTask[];
  /**
   * Каталог копий офиса (`.office/worktrees/<офис>`). Detached worktree и
   * worktree на чужих ветках считаются сиротами офиса, только если лежат в
   * нём: копии, которые человек завёл себе сам в другом месте, не наши.
   */
  worktreesRoot?: string | null;
}

export interface FindOptions {
  /** Возраст в днях, после которого ветку прошлой попытки можно удалять. */
  days?: number;
  /** Удалять и сирот без задачи, а не только показывать. */
  orphans?: boolean;
  /** «Сейчас» в миллисекундах — для проверок. */
  now?: number;
  /** Откуда запущена уборка: её worktree и ветку не трогаем никогда. */
  cwd?: string;
}

export const DEFAULT_DAYS = 14;

/**
 * Почему кандидат попал в список. Первые шесть — по задаче; `active` и
 * `open` — задача ещё живая, такой кандидат только показывается.
 */
export type StaleReason =
  | 'merged'     // влита
  | 'cancelled'  // снята
  | 'failed'     // провалена
  | 'closed'     // закрыта без слияния
  | 'attempt'    // ветка прошлой попытки
  | 'orphan'     // сирота без задачи
  | 'active'     // задача в работе, на ревью или blocked
  | 'open';      // задача ещё не закрыта (planned, backlog, assigned)

export const REASON_LABEL: Record<StaleReason, string> = {
  merged: 'влита',
  cancelled: 'снята',
  failed: 'провалена',
  closed: 'закрыта без слияния',
  attempt: 'прошлая попытка',
  orphan: 'сирота без задачи',
  active: 'задача в работе',
  open: 'задача не закрыта',
};

export interface Candidate {
  kind: 'worktree' | 'branch';
  /** Путь worktree; у ветки — null. */
  path: string | null;
  /** Ветка: у ветки — она сама, у worktree — выгруженная в него (null — отцеплен). */
  branch: string | null;
  taskId: string | null;
  status: TaskStatus | null;
  /** Время последнего коммита, мс. null — не удалось узнать. */
  lastCommitAt: number | null;
  reason: StaleReason;
  /** Помечен к удалению. */
  remove: boolean;
  /** Почему оставлен; null, если удаляется. */
  hold: string | null;
}

export interface Scan {
  repoDir: string;
  candidates: Candidate[];
  /** То, что человеку надо увидеть: грязные worktree и прочее. */
  warnings: string[];
}

export interface PruneReport {
  removed: Candidate[];
  skipped: Array<{ candidate: Candidate; why: string }>;
}

const ACTIVE: ReadonlySet<TaskStatus> = new Set(['in_progress', 'review', 'blocked']);
/**
 * Ветка задачи `task/T-5` и её копии с суффиксом через точку: так
 * `preserveBranch` сохраняет прошлую попытку (`task/T-5.stopped-2`), так же
 * люди откладывают ветку руками (`task/T-5.before-rebase`).
 */
const TASK_BRANCH = /^task\/([^/.]+)(\..+)?$/;
/** Ветки выпусков: каналы (`release`, `beta`, `alpha`) и временные ветки офиса. */
const RELEASE_BRANCH = /^(?:release|beta|alpha|stable)(?:\/|$)|^office\/rel\//;
const DAY = 24 * 60 * 60 * 1000;

/** Путь без симлинков: на macOS временный каталог — и /var, и /private/var. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Разобрать имя ветки задачи: `task/T-5` или прошлая попытка `task/T-5.stopped-2`. */
export function parseTaskBranch(branch: string): { taskId: string; attempt: boolean } | null {
  const m = TASK_BRANCH.exec(branch);
  return m ? { taskId: m[1], attempt: m[2] !== undefined } : null;
}

export const isReleaseBranch = (branch: string): boolean => RELEASE_BRANCH.test(branch);

interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain` целиком, первая запись — основная копия. */
async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const listed = await git(repoDir, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return [];
  const entries: WorktreeEntry[] = [];
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      entries.push({
        path: line.slice('worktree '.length).trim(),
        head: null, branch: null, locked: false, prunable: false,
      });
      continue;
    }
    const last = entries[entries.length - 1];
    if (!last) continue;
    if (line.startsWith('HEAD ')) last.head = line.slice('HEAD '.length).trim();
    else if (line.startsWith('branch ')) {
      last.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'locked' || line.startsWith('locked ')) last.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) last.prunable = true;
  }
  return entries;
}

/** Локальные ветки задач с временем последнего коммита. */
async function listTaskBranches(repoDir: string): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const r = await git(repoDir, [
    'for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads/task/',
  ]);
  if (!r.ok) return out;
  for (const line of r.stdout.split('\n')) {
    const [name, date] = line.split('\t');
    if (!name) continue;
    const sec = Number(date);
    out.set(name, Number.isFinite(sec) && sec > 0 ? sec * 1000 : null);
  }
  return out;
}

async function commitTime(repoDir: string, rev: string): Promise<number | null> {
  const r = await git(repoDir, ['log', '-1', '--format=%ct', rev]);
  const sec = Number(r.stdout);
  return r.ok && Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

/** Есть ли в копии незакоммиченные изменения (включая неотслеживаемые файлы). */
async function isDirty(path: string): Promise<boolean> {
  const r = await git(path, ['status', '--porcelain']);
  // Не смогли спросить — считаем грязной: лучше оставить лишнее, чем стереть чужое.
  return !r.ok || r.stdout.length > 0;
}

/** Решение по задаче: причина и можно ли удалять. */
function verdict(
  task: CleanupTask | undefined,
  attempt: boolean,
  lastCommitAt: number | null,
  opts: Required<Pick<FindOptions, 'days' | 'orphans' | 'now'>>,
): { reason: StaleReason; remove: boolean; hold: string | null } {
  if (task && ACTIVE.has(task.status)) {
    return { reason: 'active', remove: false, hold: `задача в статусе ${task.status}` };
  }
  if (attempt) {
    if (lastCommitAt === null) {
      return { reason: 'attempt', remove: false, hold: 'не удалось узнать дату коммита' };
    }
    const age = opts.now - lastCommitAt;
    return age > opts.days * DAY
      ? { reason: 'attempt', remove: true, hold: null }
      : { reason: 'attempt', remove: false, hold: `моложе ${opts.days} дн.` };
  }
  if (!task) {
    return opts.orphans
      ? { reason: 'orphan', remove: true, hold: null }
      : { reason: 'orphan', remove: false, hold: 'сирота: удаляется только с --orphans' };
  }
  switch (task.status) {
    case 'done':
      return { reason: task.merged ? 'merged' : 'closed', remove: true, hold: null };
    case 'cancelled':
      return { reason: 'cancelled', remove: true, hold: null };
    case 'failed':
      return { reason: 'failed', remove: true, hold: null };
    default:
      return { reason: 'open', remove: false, hold: `задача в статусе ${task.status}` };
  }
}

/**
 * Собрать кандидатов на удаление. Ничего не меняет — только git на чтение.
 *
 * В список попадают все worktree и ветки задач, включая те, что удалять
 * нельзя: у них `remove: false` и `hold` с причиной. Основная копия
 * репозитория, ветки не задач и worktree вне каталога копий офиса в список
 * не попадают вовсе.
 */
export async function findStale(office: CleanupOffice, options: FindOptions = {}): Promise<Scan> {
  const opts = {
    days: options.days ?? DEFAULT_DAYS,
    orphans: options.orphans ?? false,
    now: options.now ?? Date.now(),
  };
  const repoDir = (await repoTop(office.repoDir)) ?? office.repoDir;
  const warnings: string[] = [];
  const candidates: Candidate[] = [];

  const tasks = new Map(office.tasks.map((t) => [t.id, t]));
  const byPath = new Map<string, CleanupTask>();
  for (const t of office.tasks) if (t.worktreePath) byPath.set(real(t.worktreePath), t);

  // Защищённые ветки: основная, текущая (в основной копии и там, откуда
  // запущены), базовые ветки задач.
  const protectedBranches = new Set<string>(['main', 'master']);
  for (const name of [await baseBranch(repoDir), await currentBranch(repoDir)]) {
    if (name && name !== 'HEAD') protectedBranches.add(name);
  }
  const cwd = options.cwd ? real(options.cwd) : null;
  if (cwd) {
    const here = await currentBranch(cwd);
    if (here && here !== 'HEAD') protectedBranches.add(here);
  }
  for (const t of office.tasks) if (t.baseBranch) protectedBranches.add(t.baseBranch);
  const isProtected = (branch: string): string | null => {
    if (protectedBranches.has(branch)) return 'основная или текущая ветка';
    if (isReleaseBranch(branch)) return 'ветка выпуска';
    return null;
  };

  const branches = await listTaskBranches(repoDir);
  const worktrees = await listWorktrees(repoDir);
  const root = office.worktreesRoot ? real(office.worktreesRoot) : null;
  const mainCopy = worktrees[0] ? real(worktrees[0].path) : real(repoDir);
  /** Ветки, выгруженные в worktree, которые остаются на месте. */
  const pinned = new Map<string, string>();

  for (const wt of worktrees) {
    const path = real(wt.path);
    if (path === mainCopy) continue;
    // Копия, из которой запущена уборка, — чья-то текущая работа.
    if (cwd && inside(cwd, path)) {
      if (wt.branch) pinned.set(wt.branch, 'выгружена в текущую копию');
      continue;
    }
    const parsed = wt.branch ? parseTaskBranch(wt.branch) : null;
    const ours = parsed !== null || byPath.has(path) || (root !== null && inside(path, root));
    if (!ours) {
      // Чужой worktree: не трогаем, но и его ветку удалить нельзя.
      if (wt.branch) pinned.set(wt.branch, 'выгружена в чужой worktree');
      continue;
    }

    let task = parsed ? tasks.get(parsed.taskId) : byPath.get(path);
    // Каталог копии офиса называется по задаче: `<корень>/T-12`.
    if (!task && !parsed && root && inside(path, root)) task = tasks.get(basename(path));
    const lastCommitAt = wt.branch
      ? branches.get(wt.branch) ?? await commitTime(repoDir, wt.branch)
      : wt.head ? await commitTime(repoDir, wt.head) : null;
    let decision = verdict(task, parsed?.attempt ?? false, lastCommitAt, opts);

    // Копия выпуска (`<корень>/_release/<цель>`, releases.ts) отцеплена, и по
    // ветке её не узнать — узнаём по месту.
    const releaseCopy = root !== null && inside(path, resolve(root, '_release'));
    const guard = (wt.branch ? isProtected(wt.branch) : null) ?? (releaseCopy ? 'копия выпуска' : null);
    if (guard) decision = { ...decision, remove: false, hold: guard };
    if (decision.remove && wt.locked) {
      decision = { ...decision, remove: false, hold: 'заблокирован (git worktree lock)' };
    }
    // Каталога уже нет — проверять нечего, запись снимет `worktree prune`.
    if (!wt.prunable && await isDirty(wt.path)) {
      warnings.push(`${wt.path}: незакоммиченные изменения — worktree оставлен`);
      decision = { ...decision, remove: false, hold: 'незакоммиченные изменения' };
    }
    if (!decision.remove && wt.branch) pinned.set(wt.branch, `выгружена в оставленный worktree ${wt.path}`);

    candidates.push({
      kind: 'worktree', path: wt.path, branch: wt.branch,
      taskId: task?.id ?? parsed?.taskId ?? null, status: task?.status ?? null,
      lastCommitAt, ...decision,
    });
  }

  for (const [branch, lastCommitAt] of branches) {
    const parsed = parseTaskBranch(branch);
    if (!parsed) continue;
    const task = tasks.get(parsed.taskId);
    let decision = verdict(task, parsed.attempt, lastCommitAt, opts);
    const guard = isProtected(branch) ?? pinned.get(branch) ?? null;
    if (guard) decision = { ...decision, remove: false, hold: guard };
    candidates.push({
      kind: 'branch', path: null, branch,
      taskId: parsed.taskId, status: task?.status ?? null,
      lastCommitAt, ...decision,
    });
  }

  return { repoDir, candidates, warnings };
}

/**
 * Удалить помеченных кандидатов. Порядок: `git worktree remove` (без --force:
 * грязную копию git сам откажется снимать), `git worktree prune`, затем
 * `git branch -D`. Ветку, чей worktree снять не вышло, не трогаем.
 */
export async function prune(repoDir: string, candidates: Candidate[]): Promise<PruneReport> {
  const report: PruneReport = { removed: [], skipped: [] };
  const failedBranches = new Set<string>();

  const trees = candidates.filter((c) => c.kind === 'worktree');
  const errors = new Map<Candidate, string>();
  for (const c of trees) {
    if (!c.remove || !c.path) continue;
    const r = await git(repoDir, ['worktree', 'remove', c.path]);
    if (!r.ok) errors.set(c, r.stderr || 'git worktree remove не удался');
  }
  await git(repoDir, ['worktree', 'prune']);

  // Итог по worktree сверяем со списком после prune: копию, чей каталог уже
  // пропал, `remove` не снимет, а `prune` — снимет.
  const left = new Set((await listWorktrees(repoDir)).map((w) => real(w.path)));
  for (const c of trees) {
    if (!c.remove || !c.path) {
      report.skipped.push({ candidate: c, why: c.hold ?? 'не помечен к удалению' });
      if (c.branch) failedBranches.add(c.branch);
      continue;
    }
    if (left.has(real(c.path))) {
      report.skipped.push({ candidate: c, why: errors.get(c) ?? 'worktree остался на месте' });
      if (c.branch) failedBranches.add(c.branch);
    } else {
      report.removed.push(c);
    }
  }

  for (const c of candidates) {
    if (c.kind !== 'branch' || !c.branch) continue;
    if (!c.remove) {
      report.skipped.push({ candidate: c, why: c.hold ?? 'не помечен к удалению' });
      continue;
    }
    if (failedBranches.has(c.branch)) {
      report.skipped.push({ candidate: c, why: 'её worktree не снят' });
      continue;
    }
    const r = await git(repoDir, ['branch', '-D', c.branch]);
    if (r.ok) report.removed.push(c);
    else report.skipped.push({ candidate: c, why: r.stderr || 'git branch -D не удался' });
  }
  return report;
}

/** Дата для таблицы: `2026-10-01 (14 дн.)`. */
export function formatAge(at: number | null, now = Date.now()): string {
  if (at === null) return '—';
  const days = Math.floor((now - at) / DAY);
  return `${new Date(at).toISOString().slice(0, 10)} (${days} дн.)`;
}
