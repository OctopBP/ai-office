/**
 * Выпуск в бету сквозняком (docs/design/release-channels/spec.md §3.2–3.5,
 * §4.2) на настоящем git, без сети и CI: origin — голый репозиторий рядом,
 * CI выключен у цели, заметки — подставные.
 *
 * Проверяется: бета получает версию X.Y.Z-beta.N и тег v{version}, ветка
 * beta перематывается и вливается вниз в main; следующая бета — -beta.2;
 * стабильный берёт коммит последней беты, перематывает release и сливает
 * его вниз release → beta → main; хотфикс в release, ушедший вперёд, следующая
 * бета сначала вливает вниз; конфликт при этом — выпуск встаёт с причиной.
 *
 * Запуск: npm run test:beta
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, type Task } from '../src/server/state';
import { releaseTiming, setReleaseAgents, startRelease, whenReleasesIdle } from '../src/server/releases';
import type { Release, ReleaseTarget } from '../src/shared/release';

process.env.OFFICE_LANG = 'ru';

let failed = 0;
const check = (what: string, ok: boolean) => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${what}: ${ok}`);
};

const sh = (dir: string, ...args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
};

/** Проект с main, package.json 0.10.0, тегом v0.10.0 и голым origin. */
function fixture(): { dir: string; origin: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'office-beta-'));
  const dir = resolve(root, 'project');
  const origin = resolve(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  sh(dir, 'config', 'user.email', 'office@local');
  sh(dir, 'config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '0.10.0' }, null, 2)}\n`);
  writeFileSync(resolve(dir, '.gitignore'), '.office/\n');
  writeFileSync(resolve(dir, 'app.txt'), 'начало\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'Начало');
  sh(dir, 'tag', '-a', 'v0.10.0', '-m', '0.10.0');
  sh(dir, 'remote', 'add', 'origin', origin);
  sh(dir, 'push', '-q', 'origin', 'main', '--tags');
  return { dir, origin };
}

/** Коммит в ветку, не трогая рабочую копию на main. */
function commitOn(dir: string, branch: string, file: string, text: string, message: string): string {
  const wt = resolve(dir, '..', `wt-${branch}-${Date.now()}`);
  sh(dir, 'worktree', 'add', '-q', '--detach', wt, branch);
  writeFileSync(resolve(wt, file), text);
  sh(wt, 'add', '-A');
  sh(wt, 'commit', '-qm', message);
  const sha = sh(wt, 'rev-parse', 'HEAD');
  sh(dir, 'update-ref', `refs/heads/${branch}`, sha);
  sh(dir, 'worktree', 'remove', '--force', wt);
  return sha;
}

async function main(): Promise<void> {
  process.on('beforeExit', () => {
    console.error('\n❌ проверки зависли: выпуск ждёт того, чего не будет');
    process.exit(1);
  });
  releaseTiming.ciPollMs = 20;
  releaseTiming.ciGraceMs = 200;
  releaseTiming.taskPollMs = 20;

  const { dir, origin } = fixture();
  process.chdir(dir);
  const office = getOffice('o-beta');
  office.setStateFile(resolve(tmpdir(), `office-beta-state-${process.pid}.json`));
  office.seed();
  office.projectDir = dir;
  office.opened = true;
  setReleaseAgents({ async notes() { return { text: '- изменения', costUsd: 0 }; } });

  const mergedTask = (title: string, file: string): Task => {
    writeFileSync(resolve(dir, file), `${title}\n`);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-qm', title);
    const task = office.createTask({ title, description: '', criteria: ['x'], roleId: 'backend', status: 'done' });
    office.updateTask(task.id, {
      merged: true, mergeCommit: sh(dir, 'rev-parse', 'HEAD'),
      outcome: { kind: 'clean', at: Date.now() } as unknown as Task['outcome'],
    });
    return task;
  };
  const release = async (opts: { channel: 'beta' | 'stable'; hotfix?: boolean }): Promise<Release> => {
    const started = startRelease(office, 'desktop', 'manual', '', Date.now(), opts);
    if (!started.ok) throw new Error(started.message);
    await whenReleasesIdle(office);
    return office.releases.get(started.release!.id)!;
  };
  const tip = (repo: string, ref: string) => sh(repo, 'rev-parse', '--verify', '-q', ref);
  const pkgOn = (ref: string) => (JSON.parse(sh(dir, 'show', `${ref}:package.json`) || '{}') as { version?: string }).version;

  const desktop: ReleaseTarget = {
    id: 'desktop', title: 'Приложение', kind: 'tag', ci: 'off',
    bump: "node -e \"const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));p.version='{version}';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\\n')\"",
    policy: { when: ['manual'], approve: 'never' },
    version: { scheme: 'semver', level: 'minor', source: 'tag' },
    channels: { stable: { branch: 'release' }, beta: { branch: 'beta' } },
  };
  const bad = office.updateSettings({ release: { targets: [desktop] } });
  check('цель с каналами сохранилась', bad === null && Boolean(office.releaseTarget('desktop')?.channels?.beta));

  // 1. Первая бета: v0.11.0-beta.1, ветка beta создана и в origin, main получил версию.
  console.log('▶ Первая бета');
  mergedTask('Экспорт', 'export.txt');
  const b1 = await release({ channel: 'beta' });
  check(`бета состоялась (${b1.status}: ${b1.stage})`, b1.status === 'done');
  check(`версия 0.11.0-beta.1 (${b1.version})`, b1.version === '0.11.0-beta.1' && b1.channel === 'beta');
  const t1 = tip(dir, 'refs/tags/v0.11.0-beta.1^{commit}');
  check('тег v0.11.0-beta.1 локально и в origin', Boolean(t1) && Boolean(tip(origin, 'refs/tags/v0.11.0-beta.1')));
  check('ветка beta перемотана на тег беты', tip(dir, 'refs/heads/beta') === t1 && tip(origin, 'refs/heads/beta') === t1);
  check('версия в beta — 0.11.0-beta.1', pkgOn('beta') === '0.11.0-beta.1');
  check('beta влита вниз в main', sh(dir, 'merge-base', '--is-ancestor', 'beta', 'main') === '' && pkgOn('main') === '0.11.0-beta.1');
  check('слияние вниз записано', JSON.stringify(b1.mergedDown) === JSON.stringify(['main']));
  check('временная ветка убрана', !sh(dir, 'branch', '--list', b1.branch));
  check('ветки release ещё нет', !tip(dir, 'refs/heads/release'));

  // 2. Вторая бета: -beta.2, beta перематывается дальше.
  console.log('▶ Вторая бета');
  mergedTask('Поиск', 'search.txt');
  const b2 = await release({ channel: 'beta' });
  check(`бета 2 состоялась (${b2.status}: ${b2.stage})`, b2.status === 'done');
  check(`версия 0.11.0-beta.2 (${b2.version})`, b2.version === '0.11.0-beta.2');
  const t2 = tip(dir, 'refs/tags/v0.11.0-beta.2^{commit}');
  check('тег v0.11.0-beta.2 в origin', Boolean(t2) && Boolean(tip(origin, 'refs/tags/v0.11.0-beta.2')));
  check('beta перемотана с беты 1 на бету 2', tip(dir, 'refs/heads/beta') === t2 && sh(dir, 'merge-base', '--is-ancestor', t1, t2) === '');

  // 3. Стабильный: коммит последней беты, а не вершина main; release перематывается.
  console.log('▶ Стабильный из беты');
  mergedTask('Только в main', 'later.txt');
  const s = await release({ channel: 'stable' });
  check(`стабильный состоялся (${s.status}: ${s.stage})`, s.status === 'done');
  check(`версия 0.11.0 — ядро беты (${s.version})`, s.version === '0.11.0');
  check('снимок — коммит последней беты', s.promote?.sha === t2 && s.promote?.from === 'v0.11.0-beta.2');
  const ts = tip(dir, 'refs/tags/v0.11.0^{commit}');
  check('тег v0.11.0 в origin', Boolean(ts) && Boolean(tip(origin, 'refs/tags/v0.11.0')));
  check('бета — предок стабильного', sh(dir, 'merge-base', '--is-ancestor', t2, ts) === '');
  check('задача из main в стабильный не попала', !sh(dir, 'ls-tree', '--name-only', ts, 'later.txt'));
  check('release создана на теге стабильного, и в origin', tip(dir, 'refs/heads/release') === ts && tip(origin, 'refs/heads/release') === ts);
  check('вниз: release → beta перемоткой', tip(dir, 'refs/heads/beta') === ts && tip(origin, 'refs/heads/beta') === ts);
  check('вниз: дальше в main', sh(dir, 'merge-base', '--is-ancestor', ts, 'main') === '' && Boolean(sh(dir, 'ls-tree', '--name-only', 'main', 'later.txt')));
  check('цепочка записана', JSON.stringify(s.mergedDown) === JSON.stringify(['beta', 'main']));

  // 4. Хотфикс в release ушёл вперёд — следующая бета сначала вливает его вниз.
  console.log('▶ Ушедшая вперёд release вливается вниз');
  const hot = commitOn(dir, 'release', 'hotfix.txt', 'хотфикс\n', 'Хотфикс');
  sh(dir, 'push', '-q', 'origin', 'release');
  mergedTask('Новое после стабильного', 'next.txt');
  const b3 = await release({ channel: 'beta' });
  check(`бета 3 состоялась (${b3.status}: ${b3.stage})`, b3.status === 'done');
  check(`версия 0.12.0-beta.1 (${b3.version})`, b3.version === '0.12.0-beta.1');
  check('хотфикс в beta и в main', sh(dir, 'merge-base', '--is-ancestor', hot, 'beta') === '' && sh(dir, 'merge-base', '--is-ancestor', hot, 'main') === '');
  check('хотфикс вошёл в бету', Boolean(sh(dir, 'ls-tree', '--name-only', 'v0.12.0-beta.1', 'hotfix.txt')));
  check('в журнале — лечение слиянием вниз', office.log.some((l) => l.text.includes('влиты вниз') && l.text.includes('release → beta')));

  // 4½. Выпуск хотфикса из release: патч от стабильного, конфликт в строке
  // версии при слиянии вниз решается сам — бета остаётся своей версии.
  console.log('▶ Хотфикс: конфликт версии решается сам');
  const h = await release({ channel: 'stable', hotfix: true });
  check(`хотфикс состоялся (${h.status}: ${h.stage})`, h.status === 'done');
  check(`версия 0.11.1 (${h.version})`, h.version === '0.11.1' && Boolean(tip(origin, 'refs/tags/v0.11.1')));
  const th = tip(dir, 'refs/tags/v0.11.1^{commit}');
  check('release на теге хотфикса', tip(dir, 'refs/heads/release') === th);
  check('хотфикс влит в beta и main', sh(dir, 'merge-base', '--is-ancestor', th, 'beta') === '' && sh(dir, 'merge-base', '--is-ancestor', th, 'main') === '');
  check(`версия в beta своя (${pkgOn('beta')})`, pkgOn('beta') === '0.12.0-beta.1' && pkgOn('main') === '0.12.0-beta.1');
  check('цепочка хотфикса записана', JSON.stringify(h.mergedDown) === JSON.stringify(['beta', 'main']));

  // 5. Конфликт при слиянии вниз — выпуск встаёт с причиной.
  console.log('▶ Конфликт при слиянии вниз');
  commitOn(dir, 'beta', 'app.txt', 'правка в beta\n', 'Правка в beta');
  sh(dir, 'push', '-q', 'origin', 'beta');
  writeFileSync(resolve(dir, 'app.txt'), 'правка в main\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'Правка в main');
  const stuck = await release({ channel: 'beta' });
  check(`выпуск встал (${stuck.status})`, stuck.status === 'failed' && stuck.needsDecision);
  check(`причина — слияние вниз и файл (${stuck.stage})`, stuck.stage.includes('beta → main') && stuck.stage.includes('app.txt'));
  check('тег новой беты не появился', !tip(dir, 'refs/tags/v0.12.0-beta.2'));
  check('main не тронут слиянием', readFileSync(resolve(dir, 'app.txt'), 'utf8') === 'правка в main\n');

  console.log(failed ? `\n❌ провалено: ${failed}` : '\n✅ всё прошло');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
