/**
 * Офис убирает за собой сам: ветки и worktree задач без ручного запуска
 * `npm run cleanup:branches`. Правила — в cleanup.ts, здесь только два места,
 * где офис их применяет:
 *
 *   releaseWorktree — при снятии задачи: чистый worktree снимаем сразу, ветку
 *                     оставляем на `Settings.cleanupDays` дней — вдруг вернут;
 *   tidyOffice      — в ритуале здоровья, не чаще раза в сутки: findStale +
 *                     prune с умолчаниями (сирот не трогаем), итог — одним
 *                     событием в ленту офиса.
 *
 * `cleanupDays = 0` выключает и то и другое.
 */
import { existsSync } from 'node:fs';
import { DEFAULT_DAYS, findStale, isDirty, prune, type Candidate } from './cleanup';
import { git, isRepo, repoTop } from './git';
import { taskRepo, worktreesRoot, type OfficeState } from './state';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Сколько имён показывать в строке ленты: дальше — «и ещё N». */
const LIST_MAX = 5;

/** Срок жизни веток снятых задач и прошлых попыток, дни. 0 — уборка выключена. */
export function cleanupDays(state: OfficeState): number {
  const days = state.settings.cleanupDays;
  return typeof days === 'number' && Number.isInteger(days) && days >= 0 ? days : DEFAULT_DAYS;
}

/**
 * Снять worktree снятой задачи. Незакоммиченные правки — повод оставить копию
 * и сказать об этом: стирать чужую работу уборка не вправе. Ветку не трогаем
 * никогда — её удалит tidyOffice, когда выйдет срок.
 */
export async function releaseWorktree(
  state: OfficeState, taskId: string,
): Promise<'removed' | 'dirty' | 'skipped'> {
  const days = cleanupDays(state);
  const task = state.tasks.get(taskId);
  if (!days || !task || task.status !== 'cancelled' || !task.worktreePath) return 'skipped';
  const path = task.worktreePath;
  const repo = taskRepo(task, state);
  if (!await isRepo(repo)) return 'skipped';

  if (existsSync(path)) {
    if (await isDirty(path)) {
      state.addLog(null, 'error', state.say('tidy.cancelDirty', { task: task.id, path }));
      return 'dirty';
    }
    // Без --force: если между проверкой и удалением в копии что-то
    // появилось, git сам откажется.
    await git(repo, ['worktree', 'remove', path]);
  }
  await git(repo, ['worktree', 'prune']);
  if (existsSync(path)) return 'skipped';

  state.updateTask(task.id, { worktreePath: null });
  state.addLog(null, 'system', state.say('tidy.cancelLog', {
    task: task.id, branch: task.branch ?? '—', days,
  }));
  return 'removed';
}

/** Пора ли уборке: включена и с прошлого раза прошли сутки. */
export function tidyDue(state: OfficeState, now = Date.now()): boolean {
  return cleanupDays(state) > 0 && now - (state.life.cleanupAt ?? 0) >= DAY_MS;
}

export interface TidySummary {
  branches: number;
  worktrees: number;
  /** Причина пропуска → сколько раз. Живые задачи сюда не входят. */
  skipped: Map<string, number>;
  /** Грязные worktree и сироты: остались на месте, человеку стоит взглянуть. */
  warnings: string[];
}

/**
 * Уборка по всему офису: в каждом репозитории, где жили его задачи. Не пора —
 * null и ни одного вызова git. Момент прогона запоминается до работы: упавшая
 * уборка не должна повторяться на каждом тике.
 */
export async function tidyOffice(state: OfficeState, now = Date.now()): Promise<TidySummary | null> {
  if (!tidyDue(state, now)) return null;
  state.life.cleanupAt = now;
  const days = cleanupDays(state);

  const tasks = [...state.tasks.values()];
  const repos = new Set<string>();
  for (const dir of [state.projectDir, ...tasks.filter((t) => t.branch || t.worktreePath).map((t) => taskRepo(t, state))]) {
    if (!dir || !await isRepo(dir)) continue;
    repos.add((await repoTop(dir)) ?? dir);
  }

  const summary: TidySummary = { branches: 0, worktrees: 0, skipped: new Map(), warnings: [] };
  const warned = new Set<string>();
  const warn = (text: string): void => {
    if (warned.has(text)) return;
    warned.add(text);
    summary.warnings.push(text);
  };
  const office = {
    tasks: tasks.map((t) => ({
      id: t.id, status: t.status, merged: t.merged, branch: t.branch,
      baseBranch: t.baseBranch, worktreePath: t.worktreePath,
      finishedAt: t.finishedAt, startedAt: t.startedAt,
    })),
    worktreesRoot: worktreesRoot(state),
  };
  for (const repoDir of repos) {
    const scan = await findStale({ ...office, repoDir }, { days, now, orphans: false });
    const report = await prune(scan.repoDir, scan.candidates);
    for (const c of report.removed) {
      if (c.kind === 'branch') summary.branches += 1;
      else summary.worktrees += 1;
    }
    for (const { candidate: c, why } of report.skipped) {
      // Ветки живых задач — не мусор, а работа: о них в итоге уборки ни слова.
      if (c.reason === 'active' || c.reason === 'open') continue;
      if (c.reason === 'orphan') {
        warn(state.say('tidy.orphan', { what: label(c) }));
      } else if (why === 'незакоммиченные изменения') {
        warn(state.say('tidy.dirty', { what: label(c) }));
      } else {
        summary.skipped.set(why, (summary.skipped.get(why) ?? 0) + 1);
      }
    }
  }

  const touched = summary.branches + summary.worktrees + summary.skipped.size + summary.warnings.length;
  if (touched > 0) {
    const skipped = [...summary.skipped].map(([why, n]) => `${why} — ${n}`);
    state.addLog(null, summary.warnings.length ? 'error' : 'system', state.say('tidy.log', {
      branches: summary.branches,
      worktrees: summary.worktrees,
      skipped: skipped.length ? state.say('tidy.skipped', { list: skipped.join('; ') }) : '',
      warnings: summary.warnings.length ? state.say('tidy.warnings', { list: short(summary.warnings) }) : '',
    }));
  }
  return summary;
}

function label(c: Candidate): string {
  return c.kind === 'worktree' ? `worktree ${c.path}` : c.branch ?? '—';
}

function short(list: string[]): string {
  const head = list.slice(0, LIST_MAX).join('; ');
  return list.length > LIST_MAX ? `${head}; …+${list.length - LIST_MAX}` : head;
}
