/**
 * У цели выпуска свой репозиторий и рабочая папка (T-553).
 *
 * Реальный случай: корень офиса — папка Polka без git, репозиторий лежит в
 * Polka/bg-polka, сборку запускают из bg-polka/apps/mobile. Выпуск падал с
 * «не git-репозиторий», и поправить это менеджеру было нечем.
 *
 * Проверяется: цель с `repoDir` на вложенный репозиторий проходит снимок и
 * доходит до конца, `bump` и команда сборки запускаются из `workDir`;
 * репозиторий записан в выпуск, и `resume_release` берёт его оттуда, даже если
 * цель с тех пор указали на другой; без `repoDir` в офисе с корнем не-git
 * берётся общий репозиторий ролей, а нет его — выпуск встаёт с причиной
 * «у цели не задан репозиторий»; предложение цели сохраняет и снимает поля,
 * а карточка владельцу и `release_status` их показывают.
 *
 * Запуск: npm run test:release-repo
 */
import './_isolate';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, type OfficeState } from '../src/server/state';
import {
  proposeReleaseTarget, proposedDirs, releaseStatusText, releaseText, releaseTiming, resumeRelease, setReleaseAgents,
  settleReleaseSetups, startRelease, whenReleasesIdle,
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

const later = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(what: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (what()) return true;
    await later();
  }
  return what();
}

const gitIn = (dir: string) => (...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Репозиторий с приложением в apps/mobile. Сборка печатает, откуда её
 * запустили, и падает, пока нет файла-разрешения `gate`; `bump` пишет версию
 * в файл рядом с собой.
 */
function makeRepo(dir: string, gate: string): ReturnType<typeof gitIn> {
  mkdirSync(resolve(dir, 'apps/mobile'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = gitIn(dir);
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, '.gitignore'), '.office/\n');
  writeFileSync(resolve(dir, 'apps/mobile/build.cjs'), [
    "const fs = require('node:fs');",
    "console.log('cwd=' + process.cwd());",
    "console.log('version=' + fs.readFileSync('version.txt', 'utf8').trim());",
    `if (!fs.existsSync(${JSON.stringify(gate)})) { console.error('error: сборка не прошла'); process.exit(1); }`,
    "console.log('OFFICE_RESULT ' + JSON.stringify({ text: 'собрано из ' + process.cwd() }));",
  ].join('\n'));
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

async function main(): Promise<void> {
  process.on('beforeExit', () => {
    console.error('\n❌ проверки зависли: выпуск ждёт того, чего не будет');
    process.exit(1);
  });
  releaseTiming.taskPollMs = 20;
  useSecretStore(memoryKeychain());
  setPipelineAgents({
    async review() { return { verdict: 'changes', text: '', reviewerId: null, error: 'нет' }; },
    async rework() { return { ok: false, message: 'нет' }; },
    notifyPm() { /* сообщения менеджеру здесь не проверяются */ },
  });
  setReleaseAgents({ async notes() { return { text: '- заметки', costUsd: 0 }; } });

  // macOS отдаёт tmpdir через ссылку /var → /private/var, а cwd сборки уже разыменован.
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'office-release-repo-')));
  const polka = resolve(root, 'Polka');
  const repo = resolve(polka, 'bg-polka');
  const other = resolve(root, 'other');
  const gate = resolve(root, 'gate');
  mkdirSync(polka, { recursive: true });
  const git = makeRepo(repo, gate);
  const gitOther = makeRepo(other, gate);

  const target: ReleaseTarget = {
    id: 'mobile', title: 'Мобильное', kind: 'command', run: 'mobile', timeoutMin: 2,
    bump: 'node bump.cjs {build}', repoDir: repo, workDir: 'apps/mobile',
    policy: { when: ['manual'], approve: 'never' },
    version: { scheme: 'build', level: 'patch' },
  };

  // 1. Корень офиса не git, у цели repoDir на вложенный репозиторий.
  {
    console.log('▶ Корень офиса не git, цель с repoDir и workDir');
    const office = makeOffice('o-release-repo', root, polka, [target]);
    const started = startRelease(office, 'mobile', 'manual');
    const id = started.release?.id ?? '';
    check('снимок пройден: сборка упала, заведена починка', await until(() => Boolean(office.releases.get(id)?.fixTaskId)),
      `${started.message} / ${office.releases.get(id)?.stage}`);
    const first = office.releases.get(id)!;
    check('репозиторий записан в выпуск при старте', first.repoDir === repo, String(first.repoDir));
    check('ветка выпуска — во вложенном репозитории', Boolean(first.branch) && git('branch', '--list', first.branch).includes(first.branch));
    check('снимок — вершина main вложенного репозитория', first.sha.length === 40 && git('merge-base', '--is-ancestor', git('rev-parse', 'main'), first.branch) === '');
    const log = first.failLog ?? '';
    check('сборка запущена из workDir рабочей копии', /cwd=.*_release[\\/]mobile[\\/]apps[\\/]mobile$/m.test(log), log);
    check('bump отработал в workDir: сборка видит новую версию', /version=1$/m.test(log), log);

    // Цель переводят на другой репозиторий; вставший выпуск остаётся в своём.
    office.updateTask(first.fixTaskId!, { status: 'failed' });
    await whenReleasesIdle(office);
    check('выпуск встал и ждёт решения', office.releases.get(id)?.status === 'failed' && office.releases.get(id)?.needsDecision === true);
    office.settings.release = parseReleaseConfig({ targets: [{ ...target, repoDir: other }] }, office.settings.checks);
    writeFileSync(gate, 'ok');
    check('resume_release принят', resumeRelease(office, id).ok);
    await whenReleasesIdle(office);
    const done = office.releases.get(id)!;
    check('выпуск состоялся', done.status === 'done', done.stage);
    check('resume_release взял репозиторий с выпуска, а не из цели', done.repoDir === repo
      && gitOther('log', '--format=%s').split('\n').length === 1 && gitOther('branch', '--list', 'office/rel/*') === '');
    check('версия поднята в workDir и влита в main репозитория выпуска', Number(git('show', 'main:apps/mobile/version.txt')) >= 1,
      git('log', '--format=%s', '-5'));
    const one = releaseText(office, id).message;
    check('get_release: репозиторий и рабочая папка', one.includes(`Репозиторий выпуска ${repo}`) && one.includes('apps/mobile'), one);
    const status = releaseStatusText(office);
    check('release_status: репозиторий и рабочая папка цели', status.includes(`Репозиторий: ${other}`) && status.includes('Рабочая папка команд: apps/mobile'), status);
  }

  // 2. Нет такой рабочей папки в снимке.
  {
    console.log('▶ workDir, которого нет в репозитории');
    const office = makeOffice('o-release-repo-nodir', root, polka, [{ ...target, workDir: 'apps/web' }]);
    const id = startRelease(office, 'mobile', 'manual').release?.id ?? '';
    await whenReleasesIdle(office);
    const r = office.releases.get(id)!;
    check('выпуск встал на подъёме версии с понятной причиной', r.status === 'failed' && r.stop?.node === 'bump'
      && r.stop.reason.includes('apps/web') && r.stop.needsDecision, JSON.stringify(r.stop));
  }

  // 3. repoDir не задан, корень не git.
  {
    console.log('▶ Корень офиса не git, repoDir не задан');
    const { repoDir: _drop, ...bare } = target;
    const office = makeOffice('o-release-repo-none', root, polka, [bare]);
    const id = startRelease(office, 'mobile', 'manual').release?.id ?? '';
    await whenReleasesIdle(office);
    const r = office.releases.get(id)!;
    check('роли не закреплены — выпуск встал: у цели не задан репозиторий', r.status === 'failed' && r.stop?.node === 'snapshot'
      && r.stop.reason.includes('не задан репозиторий') && r.stop.needsDecision && !r.repoDir, JSON.stringify(r.stop));

    // Все рабочие роли закреплены за одной repo-зоной — выпускаем из неё.
    const pinned = makeOffice('o-release-repo-roles', root, polka, [bare]);
    const zone = pinned.saveSubproject(undefined, { name: 'bg-polka', root: repo, kind: 'repo', summary: '', color: '', sharedPaths: [] });
    const zoneId = 'id' in zone ? zone.id : '';
    check('repo-зона заведена', Boolean(zoneId), JSON.stringify(zone));
    for (const role of pinned.roles()) if (!role.isManager) role.subprojects = [zoneId];
    writeFileSync(resolve(repo, 'apps/mobile/note.txt'), 'ещё работа\n');
    git('add', '-A');
    git('commit', '-qm', 'Ещё работа');
    const second = startRelease(pinned, 'mobile', 'manual').release?.id ?? '';
    await whenReleasesIdle(pinned);
    const got = pinned.releases.get(second)!;
    check('все роли закреплены за одним репозиторием — взят он', got.repoDir === repo && got.status === 'done', `${got.repoDir} ${got.status} ${got.stage}`);
  }

  // 4. Предложение цели: поля сохраняются при замене и снимаются пустой строкой.
  {
    console.log('▶ propose_release_target: repoDir и workDir');
    const office = makeOffice('o-release-repo-setup', root, polka, [target]);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    check('не переданы — остаются прежние', same(proposedDirs(office, 'mobile', {}), { repoDir: repo, workDir: 'apps/mobile' }));
    check('пустая строка — снять', same(proposedDirs(office, 'mobile', { repoDir: '', workDir: '' }), {}));
    check('переданы — заменяют, «./» и хвостовой слеш убираются',
      same(proposedDirs(office, 'mobile', { repoDir: ` ${other} `, workDir: './apps/web/' }), { repoDir: other, workDir: 'apps/web' }));
    check('у новой цели полей нет', same(proposedDirs(office, 'web', {}), {}));

    const bad = proposeReleaseTarget(office, { target: { ...target, repoDir: 'bg-polka' } });
    check('относительный repoDir — отказ', !bad.ok && bad.message.includes('repoDir'), bad.message);
    const up = proposeReleaseTarget(office, { target: { ...target, workDir: '../mobile' } });
    check('workDir с «..» — отказ', !up.ok && up.message.includes('workDir'), up.message);

    const asked = proposeReleaseTarget(office, { target: { ...target, repoDir: other, workDir: 'apps/mobile' } });
    const q = [...office.questions.values()].pop()!;
    check('карточка владельцу показывает репозиторий и рабочую папку', asked.ok && q.text.includes(`Репозиторий: ${other}`)
      && q.text.includes('Рабочая папка команд: apps/mobile'), q.text);
    check('до «Применить» цель прежняя', office.releaseTarget('mobile')?.repoDir === repo);
    office.updateQuestion(q.id, { answeredAt: Date.now(), answer: 'Применить' });
    settleReleaseSetups(office);
    check('после «Применить» цель хранит новые поля', office.releaseTarget('mobile')?.repoDir === other
      && office.releaseTarget('mobile')?.workDir === 'apps/mobile', JSON.stringify(office.releaseTarget('mobile')));
    check('состояние переживает сохранение', JSON.stringify(office.toPersisted()).includes(JSON.stringify(other).slice(1, -1)));
  }

  check('служебный файл-разрешение на месте', existsSync(gate));
  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ у цели выпуска свой репозиторий и рабочая папка');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
