/**
 * Проверка цели выпуска до первого выпуска (T-554).
 *
 * Реальный случай: цель завели в офисе, корень которого не git-репозиторий,
 * и узнали об этом уже после `start_release`.
 *
 * Проверяется: сама функция `checkReleaseTarget` — не-git папка,
 * несуществующие репозиторий и `workDir`, ненайденный скрипт сборки, Gemfile
 * и package.json, push без origin, исправная цель и команды, о которых судить
 * нельзя; `propose_release_target` отклоняет цель с блокирующей проблемой и
 * вопрос владельцу не заводит, а предупреждения отдаёт и менеджеру, и в
 * карточку; ручной старт с блокирующей проблемой выпуск не заводит;
 * `release_status` показывает итог проверки по каждой цели.
 *
 * Запуск: npm run test:release-check
 */
import './_isolate';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, type OfficeState } from '../src/server/state';
import { checkReleaseTarget, hasBlocking, type TargetProblem } from '../src/server/release-check';
import { proposeReleaseTarget, releaseStatusText, startCheckedRelease } from '../src/server/releases';
import { parseReleaseConfig, type ReleaseTarget } from '../src/shared/release';

process.env.OFFICE_LANG = 'ru';

let failed = 0;
const check = (what: string, ok: boolean, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${what}${ok || !detail ? '' : `\n     ${detail}`}`);
};

const gitIn = (dir: string) => (...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Репозиторий с приложением в apps/mobile: скрипт сборки, Gemfile и package.json на месте. */
function makeRepo(dir: string): ReturnType<typeof gitIn> {
  mkdirSync(resolve(dir, 'apps/mobile/scripts'), { recursive: true });
  mkdirSync(resolve(dir, 'apps/bare'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = gitIn(dir);
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, 'apps/mobile/scripts/release-ios.sh'), 'echo ok\n');
  writeFileSync(resolve(dir, 'apps/mobile/build.cjs'), "console.log('ok');\n");
  writeFileSync(resolve(dir, 'apps/mobile/Gemfile'), "source 'https://rubygems.org'\n");
  writeFileSync(resolve(dir, 'apps/mobile/package.json'), '{"version":"1.0.0"}\n');
  writeFileSync(resolve(dir, 'apps/bare/README.md'), 'пусто\n');
  git('add', '-A');
  git('commit', '-qm', 'Начало');
  return git;
}

const base = (over: Partial<ReleaseTarget> = {}): ReleaseTarget => ({
  id: 'mobile', title: 'Мобильное', kind: 'command', run: 'mobile',
  policy: { when: ['manual'], approve: 'never' },
  version: { scheme: 'build', level: 'patch' },
  ...over,
});

const codes = (list: TargetProblem[]): string => list.map((p) => `${p.code}${p.blocking ? '!' : ''}`).join(',') || '—';

function makeOffice(id: string, root: string, projectDir: string, targets: ReleaseTarget[], checks: Record<string, string>): OfficeState {
  const office = getOffice(id);
  office.setStateFile(resolve(root, `${id}.json`));
  office.seed();
  office.projectDir = projectDir;
  office.opened = true;
  office.settings.checks = checks;
  office.settings.release = parseReleaseConfig({ targets }, checks);
  return office;
}

async function main(): Promise<void> {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'office-release-check-')));
  const plain = resolve(root, 'plain');
  const repo = resolve(root, 'repo');
  const empty = resolve(root, 'empty');
  mkdirSync(plain, { recursive: true });
  makeRepo(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', empty]);

  const run = (target: ReleaseTarget, command: string | null = null, extra: { officeDir?: string; pending?: boolean; sharedRepo?: string } = {}) =>
    checkReleaseTarget({ target, officeDir: extra.officeDir ?? repo, command, pending: extra.pending, sharedRepo: extra.sharedRepo });
  const expect = (what: string, got: TargetProblem[], want: string) => check(what, codes(got) === want, `ждали ${want}, получили ${codes(got)}`);

  console.log('\nФункция проверки: репозиторий');
  expect('корень офиса — не git: блокирующая, цели нужен repoDir', run(base(), 'node build.cjs', { officeDir: plain }), 'noTargetRepo!');
  expect('repoDir — папка без git: блокирующая', run(base({ repoDir: plain }), 'node build.cjs'), 'notGit!');
  expect('repoDir, которого нет на диске: блокирующая', run(base({ repoDir: resolve(root, 'nowhere') }), 'node build.cjs'), 'noRepoDir!');
  expect('репозиторий без единого коммита: блокирующая', run(base({ repoDir: empty }), 'node build.cjs'), 'noCommits!');
  expect('корень офиса не git, но у ролей общий репозиторий — берётся он',
    run(base({ workDir: 'apps/mobile' }), 'node build.cjs', { officeDir: plain, sharedRepo: repo }), '—');

  console.log('\nФункция проверки: рабочая папка');
  expect('workDir, которого нет: блокирующая', run(base({ repoDir: repo, workDir: 'apps/ghost' }), 'node build.cjs'), 'noWorkDir!');
  expect('workDir нет, но цель ждёт задачу — предупреждение',
    run(base({ repoDir: repo, workDir: 'apps/ghost' }), 'node build.cjs', { pending: true }), 'noWorkDir');
  expect('workDir за пределами репозитория: блокирующая', run(base({ repoDir: repo, workDir: '../plain' }), 'node build.cjs'), 'workDirOutside!');
  expect('цель-тег без команд: отсутствующий workDir выпуск не держит',
    run(base({ kind: 'tag', run: undefined, repoDir: repo, workDir: 'apps/ghost', version: { scheme: 'semver', level: 'patch' } })), 'noWorkDir');

  console.log('\nФункция проверки: команды');
  const mobile = base({ repoDir: repo, workDir: 'apps/mobile' });
  expect('исправная цель: проблем нет', run(mobile, 'bash scripts/release-ios.sh'), '—');
  expect('скрипта сборки нет: предупреждение', run(mobile, 'bash scripts/release-android.sh'), 'noScript');
  expect('скрипт ищется от workDir, а не от корня', run(base({ repoDir: repo }), 'bash scripts/release-ios.sh'), 'noScript');
  expect('переменная перед командой программу не меняет', run(mobile, 'CI=1 bash scripts/release-ios.sh --fast'), '—');
  expect('путь к исполняемому файлу: нет файла', run(mobile, './scripts/ship.sh'), 'noScript');
  expect('node дописывает расширение сам', run(mobile, 'node build'), '—');
  expect('bundle с Gemfile в рабочей папке', run(mobile, 'bundle exec fastlane ios beta'), '—');
  expect('bundle без Gemfile: предупреждение', run(base({ repoDir: repo, workDir: 'apps/bare' }), 'bundle exec fastlane ios beta'), 'noGemfile');
  expect('cd в папку и дальше из неё', run(base({ repoDir: repo }), 'cd apps/mobile && bundle exec fastlane beta'), '—');
  expect('cd в папку, которой нет', run(base({ repoDir: repo }), 'cd ios && bundle exec fastlane beta'), 'noCdDir');
  expect('bump с npm и package.json на месте', run({ ...mobile, bump: 'npm version {version} --no-git-tag-version' }, 'node build.cjs'), '—');
  expect('bump с npm без package.json: предупреждение',
    run(base({ repoDir: repo, workDir: 'apps/bare', bump: 'npm version {version} --no-git-tag-version' }), 'bash ../mobile/scripts/release-ios.sh'), 'noPackageJson');
  expect('npm --prefix уводит в другую папку — не судим',
    run(base({ repoDir: repo, workDir: 'apps/bare', bump: 'npm --prefix ../mobile version {version}' }), 'bash ../mobile/scripts/release-ios.sh'), '—');
  expect('версия из package.json, а его нет',
    run(base({ repoDir: repo, workDir: 'apps/bare', version: { scheme: 'semver', level: 'patch', source: 'package.json' } }), 'bash ../mobile/scripts/release-ios.sh'), 'noPackageJson');
  expect('команды, о которых судить нельзя, проходят молча',
    run(mobile, 'fastlane ios beta').concat(run(mobile, 'bash "$SCRIPT"'), run(mobile, 'bash -c "echo hi"'), run(mobile, 'make release'), run(mobile, 'npx eas build')), '—');
  // Файл только в коммите (рабочая копия на другой ветке, sparse checkout) — тоже найден.
  const bareClone = resolve(root, 'clone');
  execFileSync('git', ['clone', '-q', '--no-checkout', repo, bareClone]);
  expect('файл есть в последнем коммите, но не на диске — найден',
    run(base({ repoDir: bareClone, workDir: 'apps/mobile' }), 'bash scripts/release-ios.sh'), '—');

  console.log('\nФункция проверки: push и tag');
  const pushTarget = base({ kind: 'push', run: undefined, branch: 'deploy', repoDir: repo, version: { scheme: 'none', level: 'patch' } });
  expect('push без origin: предупреждение', run(pushTarget), 'noOrigin');
  expect('push с origin', run({ ...pushTarget, repoDir: bareClone }), '—');
  expect('тег без origin остаётся локальным — не проблема',
    run(base({ kind: 'tag', run: undefined, repoDir: repo, version: { scheme: 'semver', level: 'patch' } })), '—');
  check('hasBlocking различает отказ и предупреждение',
    hasBlocking(run(base({ repoDir: plain }))) && !hasBlocking(run(pushTarget)));

  console.log('\npropose_release_target');
  const office = makeOffice('check-a', root, plain, [], {});
  const questions = () => office.questions.size;
  const before = questions();
  const refused = proposeReleaseTarget(office, { target: base(), check: { name: 'mobile', command: 'bash scripts/release-ios.sh' } });
  check('цель в офисе с корнем не-git отклонена', !refused.ok, refused.message);
  check('менеджеру перечислены проблемы', refused.message.includes('не git-репозиторий') && refused.message.includes('repoDir'), refused.message);
  check('вопрос владельцу не заведён', questions() === before && office.releaseSetups.size === 0);
  const noDir = proposeReleaseTarget(office, {
    target: base({ repoDir: repo, workDir: 'apps/ghost' }), check: { name: 'mobile', command: 'bash scripts/release-ios.sh' },
  });
  check('цель с несуществующим workDir отклонена, вопроса нет',
    !noDir.ok && noDir.message.includes('apps/ghost') && questions() === before, noDir.message);

  const warned = proposeReleaseTarget(office, {
    target: base({ repoDir: repo, workDir: 'apps/mobile' }), check: { name: 'mobile', command: 'bash scripts/release-android.sh' },
  });
  const asked = [...office.questions.values()].pop();
  check('цель с предупреждением предложена', warned.ok && questions() === before + 1, warned.message);
  check('предупреждение ушло менеджеру', warned.message.includes('scripts/release-android.sh'), warned.message);
  check('предупреждение есть в карточке владельца', Boolean(asked?.text.includes('scripts/release-android.sh')), asked?.text ?? '');

  const clean = proposeReleaseTarget(office, {
    target: base({ repoDir: repo, workDir: 'apps/mobile' }), check: { name: 'mobile', command: 'bash scripts/release-ios.sh' },
  });
  const cleanCard = [...office.questions.values()].pop();
  check('исправная цель предложена без замечаний',
    clean.ok && !clean.message.includes('замечания') && !cleanCard?.text.includes('замечания'), `${clean.message}\n${cleanCard?.text}`);

  console.log('\nstart_release и release_status');
  const good = base({ id: 'good', title: 'Хорошая', run: 'good', repoDir: repo, workDir: 'apps/mobile' });
  const broken = base({ id: 'broken', title: 'Сломанная', run: 'good' });
  const shaky = base({ id: 'shaky', title: 'Шаткая', run: 'shaky', repoDir: repo, workDir: 'apps/mobile' });
  const live = makeOffice('check-b', root, plain, [good, broken, shaky], {
    good: 'bash scripts/release-ios.sh', shaky: 'bash scripts/release-android.sh',
  });
  const started = startCheckedRelease(live, 'broken', 'manual');
  check('выпуск цели с блокирующей проблемой не стартует', !started.ok && !started.release && live.releases.size === 0, started.message);
  check('в ответе — перечень проблем', started.message.includes('не git-репозиторий') && started.message.includes('propose_release_target'), started.message);
  const unknown = startCheckedRelease(live, 'nope', 'manual');
  check('неизвестная цель — прежний отказ', !unknown.ok && unknown.message.includes('nope'), unknown.message);

  const status = releaseStatusText(live);
  const section = (id: string, next: string | null) =>
    status.slice(status.indexOf(`${id} «`), next ? status.indexOf(`${next} «`) : undefined);
  check('release_status: у исправной цели «Проверка: в порядке»', section('good', 'broken').includes('Проверка: в порядке'), status);
  check('release_status: у сломанной — блокирующая проблема',
    section('broken', 'shaky').includes('⛔') && section('broken', 'shaky').includes('не git-репозиторий') && !section('broken', 'shaky').includes('в порядке'), status);
  check('release_status: у шаткой — предупреждение про скрипт',
    section('shaky', null).includes('⚠️') && section('shaky', null).includes('scripts/release-android.sh'), status);

  console.log(failed ? `\n❌ не прошло проверок: ${failed}` : '\n✅ всё прошло');
  process.exit(failed ? 1 : 0);
}

void main();
