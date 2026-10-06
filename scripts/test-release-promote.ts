/**
 * Перемотка ветки канала выпуска (docs/design/release-channels/spec.md
 * §3.2–3.4): `promoteBranch` и `syncChannelBranch` во временном
 * git-репозитории, с origin — голым репозиторием рядом.
 *
 * Проверяется: первый выпуск канала создаёт ветку; ветка двигается только
 * перемоткой; расхождение — отказ, ветка на месте; origin отверг
 * не-перемотку — локальная ветка тоже на месте, force-push нет; ветку,
 * на которой стоит рабочая копия, перемотка обновляет; сведение с origin
 * перематывает отставшую ветку и узнаёт разошедшуюся.
 *
 * Запуск: npm run test:promote
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promoteBranch, syncChannelBranch } from '../src/server/git';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  const line = `  ${ok ? '✅' : '❌'} ${what}: ${ok}`;
  results.push(line);
  console.log(line);
};

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Тест', GIT_AUTHOR_EMAIL: 'test@local',
  GIT_COMMITTER_NAME: 'Тест', GIT_COMMITTER_EMAIL: 'test@local',
};
const sh = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8' }).trim();
const tip = (dir: string, ref: string): string | null => {
  try { return sh(dir, 'rev-parse', '--verify', '-q', `${ref}^{commit}`); } catch { return null; }
};

/** Коммит в основную ветку рабочей копии. */
function commit(dir: string, file: string, text: string): string {
  writeFileSync(join(dir, file), text);
  sh(dir, 'add', file);
  sh(dir, 'commit', '-q', '-m', `${file}: ${text}`);
  return sh(dir, 'rev-parse', 'HEAD');
}

/** Коммит мимо рабочей копии: потомок parent, ветки он не двигает. */
function sideCommit(dir: string, parent: string, message: string): string {
  const tree = sh(dir, 'rev-parse', `${parent}^{tree}`);
  return sh(dir, 'commit-tree', tree, '-p', parent, '-m', message);
}

const root = mkdtempSync(join(tmpdir(), 'office-promote-'));
try {
  const repo = join(root, 'repo');
  sh(root, 'init', '-q', '-b', 'main', repo);
  const a = commit(repo, 'a.txt', 'один');
  const b = commit(repo, 'b.txt', 'два');

  console.log('Без origin');
  const created = await promoteBranch(repo, 'beta', a, null, 'ru');
  check('первый выпуск канала создаёт ветку', created.ok && created.kind === 'created' && tip(repo, 'beta') === a);
  const moved = await promoteBranch(repo, 'beta', b, null, 'ru');
  check('перемотка вперёд на потомка', moved.ok && moved.kind === 'moved' && tip(repo, 'beta') === b);
  const same = await promoteBranch(repo, 'beta', b, null, 'ru');
  check('повтор на том же коммите — ничего не двигает', same.ok && same.kind === 'same' && tip(repo, 'beta') === b);

  // В ветке канала коммит, которого нет в основной: перемотка невозможна.
  const stray = sideCommit(repo, b, 'руками в beta');
  sh(repo, 'update-ref', 'refs/heads/beta', stray);
  const c = commit(repo, 'c.txt', 'три');
  const diverged = await promoteBranch(repo, 'beta', c, null, 'ru');
  check('расхождение — отказ с причиной', !diverged.ok && diverged.kind === 'diverged' && diverged.message.includes('beta'));
  check('при расхождении ветка не тронута', tip(repo, 'beta') === stray);
  const back = await promoteBranch(repo, 'beta', b, null, 'ru');
  check('назад на предка — тоже отказ, не откат', !back.ok && back.kind === 'diverged' && tip(repo, 'beta') === stray);

  // Ветка, на которой стоит рабочая копия человека: файлы едут вместе с ней.
  sh(repo, 'branch', '-f', 'release', b);
  sh(repo, 'checkout', '-q', 'release');
  const onIt = await promoteBranch(repo, 'release', c, null, 'ru');
  check('ветку рабочей копии перемотка обновляет', onIt.ok && tip(repo, 'release') === c && tip(repo, 'HEAD') === c);
  sh(repo, 'checkout', '-q', 'main');

  console.log('С origin');
  const origin = join(root, 'origin.git');
  sh(root, 'init', '-q', '--bare', origin);
  sh(repo, 'remote', 'add', 'origin', origin);
  sh(repo, 'branch', '-f', 'beta', b);
  sh(repo, 'push', '-q', 'origin', 'main', 'beta');
  const pushed = await promoteBranch(repo, 'beta', c, null, 'ru');
  check('перемотка уходит в origin', pushed.ok && tip(origin, 'beta') === c && tip(repo, 'beta') === c);

  // На GitHub ветку канала двинули мимо офиса: origin отвергает не-перемотку.
  const remoteOnly = sideCommit(repo, c, 'на GitHub руками');
  sh(repo, 'push', '-q', 'origin', `+${remoteOnly}:refs/heads/beta`);
  const d = commit(repo, 'd.txt', 'четыре');
  const rejected = await promoteBranch(repo, 'beta', d, null, 'ru');
  check('origin отверг перемотку — отказ', !rejected.ok && rejected.kind === 'rejected');
  check('после отказа origin локальная ветка на месте', tip(repo, 'beta') === c);
  check('force-push не было — в origin чужой коммит', tip(origin, 'beta') === remoteOnly);

  console.log('Сведение с origin');
  const synced = await syncChannelBranch(repo, 'beta', null, 'ru');
  check('отставшая ветка перематывается к origin', synced === 'ff' && tip(repo, 'beta') === remoteOnly);
  sh(repo, 'push', '-q', 'origin', `+${sideCommit(repo, d, 'ещё раз руками')}:refs/heads/beta`);
  sh(repo, 'update-ref', 'refs/heads/beta', sideCommit(repo, remoteOnly, 'локально'));
  const split = await syncChannelBranch(repo, 'beta', null, 'ru');
  check('разошедшаяся с origin ветка узнаётся', split === 'diverged');
  check('нет ветки в origin — сводить не с чем', (await syncChannelBranch(repo, 'alpha', null, 'ru')) === 'none');
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((l) => l.includes('❌')).length;
console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ все проверки перемотки веток каналов прошли');
process.exit(failed ? 1 : 0);
