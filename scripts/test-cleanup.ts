/**
 * Уборка веток и worktree (src/server/cleanup.ts) на настоящем временном
 * репозитории и без единого токена.
 *
 * Проверяем:
 *  1. у каждого кандидата есть задача, статус, дата коммита и причина;
 *  2. main, ветки задач в работе, на ревью и blocked, ветки выпусков и
 *     грязные worktree не удаляются никогда — даже с --orphans;
 *  3. снятые, влитые, проваленные и старые прошлые попытки удаляются,
 *     свежая прошлая попытка остаётся;
 *  4. сироты по умолчанию только показываются, с флагом — удаляются;
 *  5. ветка снятой задачи живёт N дней от снятия, прошлая попытка — от
 *     перезапуска;
 *  6. офис сам (tidy.ts): снятая задача сразу теряет чистый worktree, но не
 *     ветку; ритуальная уборка идёт не чаще раза в сутки и пишет итог в ленту
 *     одним событием; cleanupDays = 0 выключает всё.
 *
 * Запуск: npm run test:cleanup
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { findStale, prune, type Candidate, type CleanupTask } from '../src/server/cleanup';
import { releaseWorktree, tidyDue, tidyOffice } from '../src/server/tidy';
import type { OfficeState, Task } from '../src/server/state';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
}

const DAY = 24 * 60 * 60;
const NOW = Date.now();

function sh(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  }).trim();
}

/** Коммит с заданной датой: возраст ветки решает судьбу прошлой попытки. */
function commit(cwd: string, file: string, daysAgo: number): void {
  writeFileSync(resolve(cwd, file), `${file} ${Math.random()}\n`);
  sh(cwd, ['add', '-A']);
  const date = `@${Math.floor(NOW / 1000) - daysAgo * DAY} +0000`;
  sh(cwd, ['commit', '-q', '-m', file], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
}

const tmp = mkdtempSync(resolve(tmpdir(), 'office-cleanup-'));
const repo = resolve(tmp, 'repo');
const root = resolve(tmp, 'worktrees');
mkdirSync(repo);
mkdirSync(root);

try {
  sh(repo, ['init', '-q', '-b', 'main']);
  sh(repo, ['config', 'user.email', 'test@office.local']);
  sh(repo, ['config', 'user.name', 'Тест']);
  commit(repo, 'README.md', 60);

  /** Ветка задачи с коммитом; с worktree — в каталоге копий офиса. */
  const branch = (name: string, daysAgo: number, worktree: string | null): void => {
    if (worktree) {
      sh(repo, ['worktree', 'add', '-q', '-b', name, resolve(root, worktree), 'main']);
      commit(resolve(root, worktree), `${worktree}.txt`, daysAgo);
    } else {
      sh(repo, ['branch', name, 'main']);
      sh(repo, ['checkout', '-q', name]);
      commit(repo, `${name.replace(/\//g, '_')}.txt`, daysAgo);
      sh(repo, ['checkout', '-q', 'main']);
    }
  };

  branch('task/T-1', 3, 'T-1');          // влита, копия осталась
  branch('task/T-2', 3, null);           // снята
  branch('task/T-3', 3, 'T-3');          // в работе
  branch('task/T-4', 3, null);           // на ревью
  branch('task/T-5', 30, 'T-5');         // blocked, старая
  branch('task/T-6', 3, 'T-6');          // провалена, но копия грязная
  writeFileSync(resolve(root, 'T-6', 'черновик.txt'), 'не закоммичено\n');
  branch('task/T-7', 3, null);           // закрыта без слияния
  branch('task/T-8.stopped-1', 30, null); // старая прошлая попытка
  branch('task/T-8.stopped-2', 2, null);  // свежая прошлая попытка
  branch('task/T-9', 3, null);           // сирота: задачи нет в состоянии
  branch('task/T-10.stopped-1', 30, null); // старая попытка задачи на ревью
  branch('office/rel/r-1', 30, 'rel-r-1'); // ветка выпуска в каталоге копий
  sh(repo, ['worktree', 'add', '-q', '--detach', resolve(root, '_base', 'foreign'), 'main']);
  sh(repo, ['worktree', 'add', '-q', '--detach', resolve(root, '_release', 'desktop'), 'main']);

  const tasks: CleanupTask[] = [
    { id: 'T-1', status: 'done', merged: true, branch: 'task/T-1', worktreePath: resolve(root, 'T-1') },
    { id: 'T-2', status: 'cancelled', branch: 'task/T-2', finishedAt: NOW - 20 * DAY * 1000 },
    { id: 'T-3', status: 'in_progress', branch: 'task/T-3', worktreePath: resolve(root, 'T-3') },
    { id: 'T-4', status: 'review', branch: 'task/T-4' },
    { id: 'T-5', status: 'blocked', branch: 'task/T-5', worktreePath: resolve(root, 'T-5') },
    { id: 'T-6', status: 'failed', branch: 'task/T-6', worktreePath: resolve(root, 'T-6') },
    { id: 'T-7', status: 'done', merged: false, branch: 'task/T-7', finishedAt: NOW - 20 * DAY * 1000 },
    { id: 'T-8', status: 'backlog' },
    { id: 'T-10', status: 'review', branch: null },
  ];
  const office = { repoDir: repo, tasks, worktreesRoot: root };
  const branches = (): string[] => sh(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n');
  const find = (list: Candidate[], kind: Candidate['kind'], branchName: string): Candidate | undefined =>
    list.find((c) => c.kind === kind && c.branch === branchName);

  // --- 1. Пробный прогон: только чтение, у каждого кандидата всё заполнено.
  const before = branches();
  const scan = await findStale(office, { now: NOW });
  check('findStale ничего не меняет', branches().join() === before.join());
  check('main и ветка выпуска не попадают в кандидаты-ветки',
    !scan.candidates.some((c) => c.kind === 'branch' && (c.branch === 'main' || c.branch === 'office/rel/r-1')));
  check('у каждого кандидата есть дата коммита и причина',
    scan.candidates.every((c) => c.lastCommitAt !== null && !!c.reason));
  const t1 = find(scan.candidates, 'branch', 'task/T-1');
  check('T-1: задача, статус и причина «влита»',
    t1?.taskId === 'T-1' && t1.status === 'done' && t1.reason === 'merged' && t1.remove, JSON.stringify(t1));
  check('T-2: снята', find(scan.candidates, 'branch', 'task/T-2')?.reason === 'cancelled');
  const fresh = await findStale({ ...office, tasks: tasks.map((t) => (t.id === 'T-2' ? { ...t, finishedAt: NOW } : t)) }, { now: NOW });
  const t2 = find(fresh.candidates, 'branch', 'task/T-2');
  check('ветка только что снятой задачи ждёт срока', t2?.remove === false && t2.hold === 'моложе 14 дн.', JSON.stringify(t2));
  const restarted = await findStale({ ...office, tasks: [...tasks, { id: 'T-8', status: 'failed', startedAt: NOW - DAY * 1000 }] }, { now: NOW });
  check('старая по коммиту, но свежая по перезапуску попытка оставлена',
    find(restarted.candidates, 'branch', 'task/T-8.stopped-1')?.remove === false);
  check('T-7: закрыта без слияния', find(scan.candidates, 'branch', 'task/T-7')?.reason === 'closed');
  const old = find(scan.candidates, 'branch', 'task/T-8.stopped-1');
  check('старая прошлая попытка помечена к удалению',
    old?.reason === 'attempt' && old.remove && old.taskId === 'T-8', JSON.stringify(old));
  check('свежая прошлая попытка оставлена', find(scan.candidates, 'branch', 'task/T-8.stopped-2')?.remove === false);
  const orphan = find(scan.candidates, 'branch', 'task/T-9');
  check('сирота показана, но не помечена', orphan?.reason === 'orphan' && !orphan.remove && orphan.status === null);
  const dirty = find(scan.candidates, 'worktree', 'task/T-6');
  check('грязный worktree оставлен с предупреждением',
    dirty?.remove === false && scan.warnings.some((w) => w.includes('T-6')), JSON.stringify(dirty));
  const base = scan.candidates.find((c) => c.kind === 'worktree' && c.path?.includes('_base'));
  check('посторонний worktree в _base — сирота', base?.reason === 'orphan' && !base.remove);

  // --- 2. Удаление с --orphans: защищённое всё равно на месте.
  const report = await prune(scan.repoDir, (await findStale(office, { now: NOW, orphans: true })).candidates);
  const after = branches();
  const has = (b: string): boolean => after.includes(b);
  check('main на месте', has('main'));
  check('ветки в работе, на ревью и blocked на месте', has('task/T-3') && has('task/T-4') && has('task/T-5'));
  check('попытка задачи на ревью на месте, хоть и старая', has('task/T-10.stopped-1'));
  check('ветка выпуска и её worktree на месте', has('office/rel/r-1') && existsSync(resolve(root, 'rel-r-1')));
  check('отцепленная копия выпуска в _release на месте', existsSync(resolve(root, '_release', 'desktop')));
  check('копии задач в работе и blocked на месте', existsSync(resolve(root, 'T-3')) && existsSync(resolve(root, 'T-5')));
  check('грязный worktree и его ветка на месте',
    existsSync(resolve(root, 'T-6', 'черновик.txt')) && has('task/T-6'));
  check('снятая, влитая, закрытая без слияния удалены', !has('task/T-1') && !has('task/T-2') && !has('task/T-7'));
  check('worktree влитой задачи снят', !existsSync(resolve(root, 'T-1')));
  check('старая прошлая попытка удалена, свежая на месте', !has('task/T-8.stopped-1') && has('task/T-8.stopped-2'));
  check('сирота удалена с флагом', !has('task/T-9') && !existsSync(resolve(root, '_base', 'foreign')));
  check('в отчёте есть удалённые и пропущенные',
    report.removed.length > 0 && report.skipped.some((s) => s.why === 'незакоммиченные изменения'));
  check('отчёт без неудач', report.skipped.every((s) => !s.candidate.remove),
    JSON.stringify(report.skipped.filter((s) => s.candidate.remove)));

  // --- 3. Текущая ветка не удаляется, даже если задача снята.
  sh(repo, ['checkout', '-q', 'task/T-4']);
  const asCurrent = await findStale({ ...office, tasks: [...tasks.filter((t) => t.id !== 'T-4'), { id: 'T-4', status: 'cancelled' }] }, { now: NOW });
  check('текущая ветка оставлена', find(asCurrent.candidates, 'branch', 'task/T-4')?.remove === false);
  sh(repo, ['checkout', '-q', 'main']);

  // --- 4. Офис убирает сам: снятие задачи и ритуал здоровья.
  const office2 = resolve(tmp, 'office2');
  mkdirSync(office2);
  sh(office2, ['init', '-q', '-b', 'main']);
  sh(office2, ['config', 'user.email', 'test@office.local']);
  sh(office2, ['config', 'user.name', 'Тест']);
  commit(office2, 'README.md', 60);
  const wt = (id: string, daysAgo: number): string => {
    const path = resolve(root, id);
    sh(office2, ['worktree', 'add', '-q', '-b', `task/${id}`, path, 'main']);
    commit(path, `${id}.txt`, daysAgo);
    return path;
  };
  const p20 = wt('T-20', 1);                  // снята, копия чистая
  const p21 = wt('T-21', 1);                  // снята, в копии черновик
  writeFileSync(resolve(p21, 'черновик.txt'), 'не закоммичено\n');
  sh(office2, ['branch', 'task/T-22.stopped-1', 'main']); // прошлая попытка

  const { state: st, logs } = fakeOffice(office2, 14, [
    { id: 'T-20', status: 'cancelled', branch: 'task/T-20', worktreePath: p20, finishedAt: NOW },
    { id: 'T-21', status: 'cancelled', branch: 'task/T-21', worktreePath: p21, finishedAt: NOW },
    { id: 'T-22', status: 'failed', branch: null, startedAt: NOW, finishedAt: NOW },
  ]);
  const has2 = (b: string): boolean => sh(office2, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').includes(b);

  check('снятие: чистый worktree снят сразу', await releaseWorktree(st, 'T-20') === 'removed' && !existsSync(p20));
  check('снятие: ветка осталась', has2('task/T-20'));
  check('снятие: worktreePath задачи очищен', st.tasks.get('T-20')?.worktreePath === null);
  check('снятие: грязный worktree оставлен с предупреждением',
    await releaseWorktree(st, 'T-21') === 'dirty' && existsSync(resolve(p21, 'черновик.txt'))
      && logs.some((l) => l.kind === 'error' && l.text.includes('tidy.cancelDirty')));

  logs.length = 0;
  const first = await tidyOffice(st, NOW);
  check('ритуал: первый прогон состоялся', first !== null);
  check('ритуал: ветка снятой задачи до срока на месте', has2('task/T-20'));
  check('ритуал: свежая прошлая попытка на месте', has2('task/T-22.stopped-1'));
  check('ритуал: итог одним событием в ленте', logs.filter((l) => l.text.startsWith('tidy.log')).length === 1, JSON.stringify(logs));
  check('ритуал: грязный worktree — предупреждение, не удалён',
    logs.some((l) => l.kind === 'error' && l.text.includes('tidy.dirty')) && existsSync(p21));

  check('ритуал: через час не пора', !tidyDue(st, NOW + 60 * 60 * 1000) && await tidyOffice(st, NOW + 60 * 60 * 1000) === null);
  const later = NOW + 15 * DAY * 1000;
  check('ритуал: через сутки снова пора', tidyDue(st, NOW + DAY * 1000));
  const second = await tidyOffice(st, later);
  check('ритуал: после срока ветка снятой задачи удалена', second !== null && !has2('task/T-20'));
  check('ритуал: после срока прошлая попытка удалена', !has2('task/T-22.stopped-1'));
  check('ритуал: ветка в грязном worktree на месте', has2('task/T-21') && existsSync(p21));
  check('ритуал: удалённое посчитано', (second?.branches ?? 0) >= 2, JSON.stringify(second));

  // --- 5. cleanupDays = 0: уборка выключена целиком.
  const p23 = wt('T-23', 40);
  const off = fakeOffice(office2, 0, [
    { id: 'T-23', status: 'cancelled', branch: 'task/T-23', worktreePath: p23, finishedAt: NOW - 40 * DAY * 1000 },
  ]);
  check('cleanupDays=0: снятие не трогает worktree', await releaseWorktree(off.state, 'T-23') === 'skipped' && existsSync(p23));
  check('cleanupDays=0: ритуал не идёт', !tidyDue(off.state, later) && await tidyOffice(off.state, later) === null);
  check('cleanupDays=0: ветка на месте', has2('task/T-23'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/**
 * Офис ровно в том объёме, в каком им пользуется tidy.ts: настройки, задачи,
 * лента. Фразы не переводим — проверяем ключи.
 */
function fakeOffice(
  projectDir: string, cleanupDays: number, list: Array<Partial<Task> & Pick<Task, 'id' | 'status'>>,
): { state: OfficeState; logs: Array<{ kind: string; text: string }> } {
  const logs: Array<{ kind: string; text: string }> = [];
  const taskMap = new Map(list.map((t) => [t.id, { branch: null, worktreePath: null, merged: false, ...t } as Task]));
  const state = {
    officeId: 'test-cleanup',
    projectDir,
    settings: { cleanupDays },
    tasks: taskMap,
    life: {},
    addLog: (_who: string | null, kind: string, text: string) => { logs.push({ kind, text }); },
    say: (key: string, vars?: Record<string, unknown>) => `${key} ${JSON.stringify(vars ?? {})}`,
    updateTask: (id: string, patch: Partial<Task>) => { Object.assign(taskMap.get(id)!, patch); },
  } as unknown as OfficeState;
  return { state, logs };
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nУборка веток: все проверки прошли');
