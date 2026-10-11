/**
 * Перезапуск выпуска заново после правки цели (T-558).
 *
 * Реальный случай: выпуск testflight-1 встал из-за неверной папки цели. Цель
 * поправили, но вставший выпуск держится за настройки, с которыми начинался.
 *
 * Проверяется: выпуск встал на не-git папке; цели задали `repoDir` через
 * предложение, и после «Применить» менеджер получил системное сообщение о
 * вставшем выпуске; `resume_release` с `fresh` проходит снимок и доводит
 * выпуск до конца, перезапуск виден в ленте офиса. Выпуск, записавший на себя
 * один репозиторий, после правки цели и `fresh` уходит в другой с той же
 * версией, а следы прошлой попытки убраны; цель с блокирующей проблемой и
 * идущий выпуск заново не пускаются; без `fresh` поведение прежнее.
 *
 * Запуск: npm run test:release-fresh
 */
import './_isolate';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, type OfficeState } from '../src/server/state';
import {
  proposeReleaseTarget, releaseTiming, restartRelease, resumeRelease, setReleaseAgents, settleReleaseSetups, startRelease,
  whenReleasesIdle,
} from '../src/server/releases';
import { setPipelineAgents } from '../src/server/review';
import { memoryKeychain } from '../src/server/engines/keys';
import { useSecretStore } from '../src/server/secrets';
import { parseReleaseConfig, type ReleaseTarget } from '../src/shared/release';

process.env.OFFICE_LANG = 'ru';

let failed = 0;
const check = (what: string, ok: boolean, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${what}${ok || !detail ? '' : `\n     ${detail}`}`);
};

const gitIn = (dir: string) => (...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Репозиторий с приложением в apps/mobile: сборка проходит, `bump` пишет версию в файл. */
function makeRepo(dir: string): ReturnType<typeof gitIn> {
  mkdirSync(resolve(dir, 'apps/mobile'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = gitIn(dir);
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, '.gitignore'), '.office/\n');
  writeFileSync(resolve(dir, 'apps/mobile/build.cjs'), "console.log('OFFICE_RESULT ' + JSON.stringify({ text: 'собрано' }));\n");
  writeFileSync(resolve(dir, 'apps/mobile/bump.cjs'), "require('node:fs').writeFileSync('version.txt', process.argv[2] + '\\n');\n");
  writeFileSync(resolve(dir, 'apps/mobile/version.txt'), '0\n');
  git('add', '-A');
  git('commit', '-qm', 'Начало');
  return git;
}

function makeOffice(id: string, root: string, projectDir: string, targets: ReleaseTarget[]): OfficeState {
  const office = getOffice(id);
  office.setStateFile(resolve(root, `${id}.json`));
  office.seed();
  office.projectDir = projectDir;
  office.opened = true;
  office.settings.autoPipeline = true;
  office.settings.checks = { mobile: 'node build.cjs' };
  office.settings.release = parseReleaseConfig({ targets }, office.settings.checks);
  return office;
}

const feed = (office: OfficeState): string => JSON.stringify(office.toPersisted());

async function main(): Promise<void> {
  process.on('beforeExit', () => {
    console.error('\n❌ проверки зависли: выпуск ждёт того, чего не будет');
    process.exit(1);
  });
  releaseTiming.taskPollMs = 20;
  useSecretStore(memoryKeychain());
  const toPm: string[] = [];
  setPipelineAgents({
    async review() { return { verdict: 'changes', text: '', reviewerId: null, error: 'нет' }; },
    async rework() { return { ok: false, message: 'нет' }; },
    notifyPm(_state, text) { toPm.push(text); },
  });
  setReleaseAgents({ async notes() { return { text: '- заметки', costUsd: 0 }; } });

  // macOS отдаёт tmpdir через ссылку /var → /private/var.
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'office-release-fresh-')));
  const polka = resolve(root, 'Polka');
  const repo = resolve(polka, 'bg-polka');
  const other = resolve(root, 'other');
  mkdirSync(polka, { recursive: true });
  const git = makeRepo(repo);
  const gitOther = makeRepo(other);

  const bare: ReleaseTarget = {
    id: 'mobile', title: 'Мобильное', kind: 'command', run: 'mobile', timeoutMin: 2,
    bump: 'node bump.cjs {build}', workDir: 'apps/mobile',
    policy: { when: ['manual'], approve: 'never' },
    version: { scheme: 'build', level: 'patch' },
  };

  // 1. Выпуск встал на не-git папке; цели задали repoDir; fresh проходит снимок.
  {
    console.log('▶ Выпуск встал на не-git папке, цели задали repoDir');
    const office = makeOffice('o-release-fresh', root, polka, [bare]);
    const id = startRelease(office, 'mobile', 'manual').release?.id ?? '';
    await whenReleasesIdle(office);
    const stuck = office.releases.get(id)!;
    check('выпуск встал на снимке: у цели не задан репозиторий', stuck.status === 'failed' && stuck.stop?.node === 'snapshot'
      && Boolean(stuck.stop?.needsDecision), JSON.stringify(stuck.stop));

    const blocked = await restartRelease(office, id);
    check('цель не поправлена — fresh отклонён проверкой цели', !blocked.ok && office.releases.get(id)?.status === 'failed', blocked.message);

    toPm.length = 0;
    const asked = proposeReleaseTarget(office, { target: { ...bare, repoDir: repo } });
    const q = [...office.questions.values()].pop()!;
    check('цель предложена владельцу', asked.ok, asked.message);
    check('до «Применить» менеджеру про вставший выпуск не пишут', !toPm.some((t) => t.includes('fresh')));
    office.updateQuestion(q.id, { answeredAt: Date.now(), answer: 'Применить' });
    settleReleaseSetups(office);
    const told = toPm.find((t) => t.includes('изменена')) ?? '';
    check('после «Применить» менеджер узнал о вставшем выпуске цели', told.includes(id) && told.includes('Мобильное')
      && told.includes('resume_release') && told.includes('fresh') && told.includes('cancel_release'), toPm.join('\n---\n'));
    settleReleaseSetups(office);
    check('повторный проход надзора второй раз не пишет', toPm.filter((t) => t.includes('изменена')).length === 1);

    const out = await restartRelease(office, id);
    check('resume_release fresh принят', out.ok && out.message.includes('заново'), out.message);
    await whenReleasesIdle(office);
    const done = office.releases.get(id)!;
    check('снимок пройден, выпуск состоялся', done.status === 'done' && done.sha.length === 40, `${done.status} ${done.stage}`);
    check('репозиторий взят из поправленной цели', done.repoDir === repo, String(done.repoDir));
    check('версия поднята и влита в main репозитория цели', git('show', 'main:apps/mobile/version.txt') === '1', git('log', '--format=%s', '-5'));
    check('перезапуск виден в ленте офиса', feed(office).includes(`Выпуск ${id} («Мобильное»`) && feed(office).includes('начат заново'));
    check('законченный выпуск заново не пустить', !(await restartRelease(office, id)).ok);
  }

  // 2. Выпуск записал на себя один репозиторий; после правки цели fresh уходит в другой.
  {
    console.log('▶ Вставший выпуск держит прежний репозиторий');
    const broken: ReleaseTarget = { ...bare, repoDir: repo, bump: 'node nope.cjs {build}' };
    const office = makeOffice('o-release-fresh-repo', root, polka, [broken]);
    writeFileSync(resolve(repo, 'apps/mobile/note.txt'), 'ещё работа\n');
    git('add', '-A');
    git('commit', '-qm', 'Ещё работа');
    const id = startRelease(office, 'mobile', 'manual').release?.id ?? '';
    await whenReleasesIdle(office);
    // Копия: запись выпуска дальше правится на месте.
    const stuck = structuredClone(office.releases.get(id)!);
    check('выпуск встал на подъёме версии, репозиторий и версия записаны', stuck.status === 'failed' && stuck.stop?.node === 'bump'
      && stuck.repoDir === repo && stuck.build !== null, JSON.stringify({ stop: stuck.stop, repo: stuck.repoDir, build: stuck.build }));
    check('ветка выпуска осталась в прежнем репозитории', git('branch', '--list', stuck.branch).includes(stuck.branch));

    office.settings.release = parseReleaseConfig({ targets: [{ ...bare, repoDir: other }] }, office.settings.checks);
    const out = await restartRelease(office, id);
    check('resume_release fresh принят', out.ok, out.message);
    check('идущий выпуск заново не начать', !(await restartRelease(office, id)).ok || office.releases.get(id)?.status === 'done');
    await whenReleasesIdle(office);
    const done = office.releases.get(id)!;
    check('выпуск состоялся в репозитории из цели', done.status === 'done' && done.repoDir === other, `${done.status} ${done.repoDir} ${done.stage}`);
    check('версия та же', done.build === stuck.build && done.version === stuck.version, `${stuck.build} → ${done.build}`);
    check('снимок свежий: из нового репозитория', done.sha !== stuck.sha && gitOther('cat-file', '-t', done.sha) === 'commit');
    check('ветка прошлой попытки из прежнего репозитория убрана', git('branch', '--list', 'office/rel/*') === '', git('branch', '--list'));
    check('версия записана в новом репозитории', gitOther('show', 'main:apps/mobile/version.txt') === String(done.build));
  }

  // 3. Без fresh — как раньше: репозиторий берётся с выпуска.
  {
    console.log('▶ resume_release без fresh');
    const broken: ReleaseTarget = { ...bare, repoDir: repo, bump: 'node nope.cjs {build}' };
    const office = makeOffice('o-release-fresh-plain', root, polka, [broken]);
    writeFileSync(resolve(repo, 'apps/mobile/note.txt'), 'и ещё\n');
    git('add', '-A');
    git('commit', '-qm', 'И ещё работа');
    const id = startRelease(office, 'mobile', 'manual').release?.id ?? '';
    await whenReleasesIdle(office);
    office.settings.release = parseReleaseConfig({ targets: [{ ...bare, repoDir: other }] }, office.settings.checks);
    check('resume_release принят', resumeRelease(office, id).ok);
    await whenReleasesIdle(office);
    const done = office.releases.get(id)!;
    check('репозиторий остался с выпуска', done.repoDir === repo && done.status === 'done', `${done.status} ${done.repoDir} ${done.stage}`);
    check('в ленте нет записи о перезапуске заново', !feed(office).includes('начат заново'));
  }

  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ вставший выпуск перезапускается по текущим настройкам цели');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
