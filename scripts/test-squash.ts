/**
 * Squash-слияние задач (T-140) — на настоящем репозитории и без единого токена.
 *
 * Что проверяем:
 *  1. сообщение коммита задачи: «T-N: заголовок» и пара строк из отчёта;
 *  2. гейт кладёт в main ровно то дерево, которое проверял, а если база
 *     уехала посреди проверок — не кладёт ничего;
 *  3. откат находится и для нового squash-коммита, и для старого
 *     merge-коммита; откат отката работу возвращает;
 *  4. коммит задачи находится в истории по префиксу «T-N:» и по старому
 *     «Merge branch 'task/T-N'».
 *
 * Запуск: npm run test:squash
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, unloadOfficeState, type Task } from '../src/server/state';
import { detectReverts, recordOutcome } from '../src/server/outcomes';
import { findRevert, taskCommitMessage, taskCommitRe } from '../src/server/git';
import { defaultIntegrationDir, preMergeGate } from '../src/server/premerge';
import { findMergeCommit } from '../src/server/taskfiles';

process.env.OFFICE_LANG = 'ru';

const results: string[] = [];
const check = (what: string, ok: boolean) => results.push(`${ok ? '✅' : '❌'} ${what}: ${ok}`);

const sh = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'office-squash-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'office@local');
  sh(dir, 'config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'Начало');
  return dir;
}

/** Ветка задачи из двух коммитов — работа и доработка. */
function branch(dir: string, name: string, file: string): void {
  sh(dir, 'checkout', '-q', '-b', name, 'main');
  writeFileSync(resolve(dir, file), 'работа\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'работа');
  writeFileSync(resolve(dir, file), 'работа\nдоработка\n');
  sh(dir, 'commit', '-qam', 'доработка');
  sh(dir, 'checkout', '-q', 'main');
}

function messages(): void {
  console.log('сообщение коммита');
  check('без отчёта — одна строка', taskCommitMessage('T-7', 'Заголовок', null) === 'T-7: Заголовок');
  check('пробелы в заголовке схлопнуты',
    taskCommitMessage('T-7', '  Два\n  слова ', '') === 'T-7: Два слова');
  const withBody = taskCommitMessage('T-7', 'Заголовок', 'Сделал squash.\n\nСписок файлов: a, b, c');
  check('тело — первый абзац отчёта', withBody === 'T-7: Заголовок\n\nСделал squash.');
  check('предупреждение вместо отчёта в тело не идёт',
    taskCommitMessage('T-7', 'Заголовок', '⚠️ Проверь дубль правки') === 'T-7: Заголовок');
  const long = taskCommitMessage('T-7', 'Заголовок', 'слово '.repeat(200));
  const body = long.split('\n\n')[1] ?? '';
  check('длинный отчёт обрезан', body.length < 320 && body.endsWith('…'));
  check('тело разбито на строки до 72 знаков', body.split('\n').every((l) => l.length <= 72));

  const re = taskCommitRe('T-5');
  check('узнаётся squash-коммит', re.test('T-5: Заголовок'));
  check('узнаётся squash с GitHub', re.test('T-5: Заголовок (#12)'));
  check('узнаётся старый merge-коммит', re.test("Merge branch 'task/T-5' into HEAD"));
  check('узнаётся старый пулл-реквест', re.test('Merge pull request #3 from owner/task/T-5'));
  check('чужой номер не узнаётся', !re.test('T-50: другое') && !re.test("Merge branch 'task/T-50'"));
  check('упоминание в середине не считается', !re.test('Починка после T-5: мелочь'));
}

async function gateTree(): Promise<void> {
  console.log('гейт и дерево');
  const dir = fixture();
  branch(dir, 'task/T-1', 'one.txt');
  const before = sh(dir, 'rev-parse', 'main');
  const seen = resolve(dir, '..', `${dir.split('/').pop()}-tree`);
  // Проверка записывает дерево, на котором её гоняли.
  const gate = await preMergeGate({
    repoDir: dir, branch: 'task/T-1', base: 'main',
    checks: [`git rev-parse HEAD^{tree} > "${seen}"`],
    message: taskCommitMessage('T-1', 'Первая', 'Сделано.'),
  });
  check('гейт зелёный и влил', gate.ok && gate.merged);
  check('в main один новый коммит', sh(dir, 'rev-list', '--count', `${before}..main`) === '1');
  check('без второго родителя', sh(dir, 'log', '-1', '--format=%P', 'main') === before);
  check('заголовок и тело', sh(dir, 'log', '-1', '--format=%B', 'main') === 'T-1: Первая\n\nСделано.');
  check('в main ровно проверенное дерево',
    readFileSync(seen, 'utf8').trim() === sh(dir, 'rev-parse', 'main^{tree}'));
  check('дерево main равно дереву ветки', sh(dir, 'rev-parse', 'main^{tree}') === sh(dir, 'rev-parse', 'task/T-1^{tree}'));

  // База уезжает, пока идут проверки: слитое дерево уже не то, что проверяли.
  branch(dir, 'task/T-2', 'two.txt');
  const moveBase = [
    'git -C "$0" worktree add -q --detach "$0-side" main',
    'echo чужое > "$0-side/other.txt"',
    'git -C "$0-side" add -A',
    'git -C "$0-side" -c user.name=x -c user.email=x@x commit -qm чужое',
    'git -C "$0" update-ref refs/heads/main "$(git -C "$0-side" rev-parse HEAD)"',
    'git -C "$0" worktree remove --force "$0-side"',
  ].join(' && ');
  const moved = await preMergeGate({
    repoDir: dir, branch: 'task/T-2', base: 'main', allowDirty: true,
    checks: [`sh -c '${moveBase}' "${dir}"`],
    message: taskCommitMessage('T-2', 'Вторая', null),
  });
  check('уехавшая база — слияния нет', !moved.merged && moved.stage === 'merge');
  check('причина названа', moved.message.includes('ушла вперёд'));
  check('в main только чужой коммит', sh(dir, 'log', '-1', '--format=%s', 'main') === 'чужое');

  rmSync(seen, { force: true });
  rmSync(defaultIntegrationDir(dir), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

async function reverts(): Promise<void> {
  console.log('откаты');
  const dir = fixture();
  const office = getOffice('o-squash');
  office.seed();

  const create = (title: string): Task =>
    office.createTask({ title, description: '', criteria: ['x'], roleId: 'backend' });
  const merged = (task: Task, mergeCommit: string): Task => {
    office.updateTask(task.id, {
      status: 'done', merged: true, branch: `task/${task.id}`, baseBranch: 'main',
      repoDir: dir, mergeCommit, finishedAt: Date.now(),
    });
    recordOutcome(office, task.id, 'clean');
    return office.tasks.get(task.id) as Task;
  };

  // Старая задача: влита merge-коммитом, как до T-140.
  const old = create('Старая');
  branch(dir, `task/${old.id}`, 'old.txt');
  sh(dir, 'merge', '-q', '--no-ff', '-m', `Merge branch 'task/${old.id}' into HEAD`, `task/${old.id}`);
  const oldTask = merged(old, sh(dir, 'rev-parse', 'main'));

  // Новая задача: squash-коммит.
  const fresh = create('Новая');
  branch(dir, `task/${fresh.id}`, 'new.txt');
  sh(dir, 'merge', '-q', '--squash', `task/${fresh.id}`);
  sh(dir, 'commit', '-qm', `${fresh.id}: Новая`);
  const freshTask = merged(fresh, sh(dir, 'rev-parse', 'main'));

  check('пока никто не откатывал — откатов нет', (await detectReverts(office)).length === 0);
  const found = await findMergeCommit(dir, freshTask);
  check('squash без «(#N)» находится в истории по префиксу',
    found?.commit === freshTask.mergeCommit);

  // Откат squash-коммита: он остаётся предком main, но работа выброшена.
  sh(dir, 'revert', '--no-edit', freshTask.mergeCommit as string);
  const r1 = await detectReverts(office);
  check('откат squash-коммита найден', r1.length === 1 && r1[0]?.id === freshTask.id);

  // Откат старого merge-коммита.
  sh(dir, 'revert', '--no-edit', '-m', '1', oldTask.mergeCommit as string);
  const r2 = await detectReverts(office);
  check('откат старого merge-коммита найден', r2.length === 1 && r2[0]?.id === oldTask.id);
  check('оба исхода — «откачена»', office.tasks.get(oldTask.id)?.outcome?.kind === 'reverted'
    && office.tasks.get(freshTask.id)?.outcome?.kind === 'reverted');

  // Откат отката возвращает работу, а откат в стиле GitHub узнаётся по заголовку.
  const third = create('Третья');
  branch(dir, `task/${third.id}`, 'third.txt');
  sh(dir, 'merge', '-q', '--squash', `task/${third.id}`);
  sh(dir, 'commit', '-qm', `${third.id}: Третья`);
  const thirdCommit = sh(dir, 'rev-parse', 'main');
  sh(dir, 'revert', '--no-edit', thirdCommit);
  const undo = sh(dir, 'rev-parse', 'main');
  check('откат найден по хешу', await findRevert(dir, thirdCommit, 'main', third.id) === undo);
  sh(dir, 'revert', '--no-edit', undo);
  check('откат отката — работа вернулась', await findRevert(dir, thirdCommit, 'main', third.id) === null);
  writeFileSync(resolve(dir, 'third.txt'), '');
  sh(dir, 'commit', '-qam', `Revert "${third.id}: Третья (#4)" (#5)`);
  check('откат с GitHub узнан по заголовку',
    await findRevert(dir, thirdCommit, 'main', third.id) === sh(dir, 'rev-parse', 'main'));

  unloadOfficeState('o-squash');
  rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  messages();
  await gateTree();
  await reverts();
  for (const r of results) console.log(`  ${r}`);
  const failed = results.filter((r) => r.startsWith('❌'));
  console.log(failed.length ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}` : `Все проверки прошли: ${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
