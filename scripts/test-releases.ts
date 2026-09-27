/**
 * Выпуски (docs/design/releases/spec.md) на настоящем git, без моделей и без
 * сети: origin — голый репозиторий рядом, CI и заметки — подставные.
 *
 * Проверяется: выпуск тегом с версией, changelog и согласием владельца;
 * «нечего выпускать»; пуш в ветку CI по закрытой фиче с падением CI,
 * починкой задачей от ветки выпуска и повтором; остановка после второго
 * падения; сборка командой с номером сборки и строкой OFFICE_RESULT;
 * политики (режим инициативы, кулдаун, слияния, план); чистые вычисления —
 * версии, разбор настройки, запрет обхода, очистка секретов.
 *
 * Запуск: npm run test:releases
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, type Task } from '../src/server/state';
import {
  dueRelease, releaseTiming, resumeRelease, saveReleasePlan, scrubSecrets, setReleaseAgents,
  setReleaseCi, startRelease, whenReleasesIdle, type CiRun,
} from '../src/server/releases';
import { releaseCommandBlocked } from '../src/server/permissions';
import { builtinWorkflow } from '../src/server/workflows';
import {
  nextVersion, parseBuildResult, parseReleaseConfig, versionInAnswer, versionLabel,
  type ReleaseTarget,
} from '../src/shared/release';

process.env.OFFICE_LANG = 'ru';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  const line = `  ${ok ? '✅' : '❌'} ${what}: ${ok}`;
  results.push(line);
  console.log(line);
};
const say = (text: string) => { results.push(text); console.log(text); };

const sh = (dir: string, ...args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
};

/** Проект с main, package.json 0.1.0, CHANGELOG.md, тегом v0.1.0 и голым origin. */
function fixture(): { dir: string; origin: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'office-releases-'));
  const dir = resolve(root, 'project');
  const origin = resolve(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  sh(dir, 'config', 'user.email', 'office@local');
  sh(dir, 'config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '0.1.0' }, null, 2)}\n`);
  writeFileSync(resolve(dir, 'CHANGELOG.md'), '# Изменения\n\n## 0.1.0\n\n- начало\n');
  writeFileSync(resolve(dir, '.gitignore'), '.office/\nbuild.log\n');
  // Сборка: печатает окружение выпуска и строку результата; падает, пока есть файл boom.
  writeFileSync(resolve(dir, 'build.js'), [
    "const fs = require('fs');",
    "if (fs.existsSync('boom')) { console.error('error: boom password=hunter22'); process.exit(1); }",
    "console.log('версия', process.env.OFFICE_RELEASE_VERSION, 'сборка', process.env.OFFICE_RELEASE_BUILD);",
    "fs.appendFileSync('build.log', `${process.env.OFFICE_RELEASE_VERSION} ${process.env.OFFICE_RELEASE_BUILD} ${fs.readFileSync(process.env.OFFICE_RELEASE_NOTES, 'utf8').length}\\n`);",
    "console.log('OFFICE_RESULT ' + JSON.stringify({ build: Number(process.env.OFFICE_RELEASE_BUILD), url: 'https://example.test/b/' + process.env.OFFICE_RELEASE_BUILD, title: 'TestFlight', text: 'сборка ' + process.env.OFFICE_RELEASE_BUILD + ' загружена' }));",
  ].join('\n'));
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'Начало');
  sh(dir, 'tag', '-a', 'v0.1.0', '-m', '0.1.0');
  sh(dir, 'remote', 'add', 'origin', origin);
  sh(dir, 'push', '-q', 'origin', 'main', '--tags');
  return { dir, origin };
}

const later = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function until(what: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (what()) return true;
    await later(20);
  }
  return what();
}

async function main(): Promise<void> {
  // Выпуск, ждущий ответа, которого тест не даст, — пустой цикл событий, и
  // node молча выходит. Это провал, а не успех.
  process.on('beforeExit', () => {
    console.error('\n❌ проверки зависли: выпуск ждёт того, чего не будет');
    process.exit(1);
  });
  releaseTiming.ciPollMs = 20;
  releaseTiming.ciGraceMs = 200;
  releaseTiming.taskPollMs = 20;

  const { dir, origin } = fixture();
  process.chdir(dir);
  const office = getOffice('o-releases');
  office.setStateFile(resolve(tmpdir(), `office-releases-state-${process.pid}.json`));
  office.seed();
  office.projectDir = dir;
  office.opened = true;
  office.settings.autoPipeline = true;
  office.settings.initiativeMode = 'propose';

  const notesAsked: string[] = [];
  setReleaseAgents({
    async notes(_state, input) {
      notesAsked.push(input.version);
      return { text: `- ${input.tasks.map((t) => t.title).join('\n- ')}`, costUsd: 0.01 };
    },
  });

  /** Задача, слитая в main: коммит в main и отметка, как её ставит конвейер. */
  const mergedTask = (title: string, file: string, epicId: string | null = null): Task => {
    writeFileSync(resolve(dir, file), `${title}\n`);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-qm', title);
    const task = office.createTask({ title, description: '', criteria: ['x'], roleId: 'backend', epicId, status: 'done' });
    office.updateTask(task.id, {
      merged: true, mergeCommit: sh(dir, 'rev-parse', 'HEAD'),
      outcome: { kind: 'clean', at: Date.now() } as unknown as Task['outcome'],
    });
    return task;
  };
  const lastChat = () => office.chat[office.chat.length - 1]?.text ?? '';
  const openGate = () => office.questionList().find((q) => q.kind === 'gate' && !q.answeredAt && !q.dismissedAt);
  const answer = (text: string) => {
    const q = openGate();
    if (q) office.updateQuestion(q.id, { answer: text, answeredAt: Date.now() });
  };

  const desktop: ReleaseTarget = {
    id: 'desktop', title: 'Приложение', kind: 'tag',
    bump: "node -e \"const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));p.version='{version}';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\\n')\"",
    policy: { when: ['manual'], approve: 'always' },
    version: { scheme: 'semver', level: 'plan' },
  };
  const staging: ReleaseTarget = {
    id: 'staging', title: 'Стенд', kind: 'push', branch: 'deploy',
    policy: { when: ['epic.done'], approve: 'never' },
    version: { scheme: 'none', level: 'patch' },
  };
  const testflight: ReleaseTarget = {
    id: 'testflight', title: 'TestFlight', kind: 'command', run: 'testflight', timeoutMin: 2,
    policy: { when: ['manual', { merged: 2 }], approve: 'major', cooldownHours: 1 },
    version: { scheme: 'semver+build', level: 'auto' },
  };

  // 0. Настройка проверяется целиком, до записи.
  {
    say('▶ Настройка целей');
    const bad = office.updateSettings({ release: { targets: [{ ...testflight, run: 'nope' }] } });
    check('команды нет в проверках — отказ с причиной', Boolean(bad && bad.includes('nope')));
    const ok = office.updateSettings({
      checks: { testflight: 'node build.js' },
      release: { targets: [desktop, staging, testflight] },
    });
    check('верная настройка сохранилась', ok === null && office.releaseTargets().length === 3);
    check('процесс release разбирается', builtinWorkflow('release').nodes.length === 12);
  }

  // 1. Тег по просьбе: версия по плану фичи, заметки, согласие, версия в файлах, changelog.
  {
    say('▶ Тег по просьбе владельца');
    const epic = office.createEpic({ title: 'Экспорт', goal: 'выгрузка в CSV', approved: true });
    office.updateEpic(epic.id, { status: 'done', finishedAt: Date.now() });
    mergedTask('Экспорт в CSV', 'export.txt', epic.id);
    mergedTask('Опечатка', 'typo.txt');

    const started = startRelease(office, 'desktop', 'manual', 'собери билд');
    check('выпуск начат', started.ok);
    check('спросили владельца', await until(() => Boolean(openGate())));
    const r0 = office.releases.get(started.release!.id)!;
    check('версия 0.2.0 — фича даёт minor', r0.version === '0.2.0' && r0.level === 'minor' && r0.levelFrom === 'plan');
    check('в вопросе версия и заметки', Boolean(openGate()?.text.includes('0.2.0') && openGate()?.text.includes('Экспорт в CSV')));
    check('выпуск ждёт', r0.status === 'waiting');
    answer('Выпускай');
    await whenReleasesIdle(office);
    const r = office.releases.get(r0.id)!;
    check('выпуск состоялся', r.status === 'done');
    check('тег v0.2.0 есть локально', Boolean(sh(dir, 'rev-parse', '--verify', 'refs/tags/v0.2.0')));
    check('тег v0.2.0 уехал в origin', Boolean(sh(origin, 'rev-parse', '--verify', 'refs/tags/v0.2.0')));
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { version: string };
    check('версия в package.json основной ветки', pkg.version === '0.2.0');
    const log = readFileSync(resolve(dir, 'CHANGELOG.md'), 'utf8');
    check('заметки в CHANGELOG под заголовком', log.startsWith('# Изменения\n\n## 0.2.0') && log.includes('Экспорт в CSV'));
    check('в выпуск вошли обе задачи', r.taskIds.length === 2 && r.epicIds.includes(epic.id));
    check('ветка выпуска убрана', !sh(dir, 'branch', '--list', r.branch));
    check('в чат — итог', lastChat().includes('Выпущено') || office.chat.some((c) => c.text.includes('Выпущено')));
    check('заметки писала модель', notesAsked.includes('0.2.0'));
  }

  // 2. Нового нет — выпускать нечего.
  {
    say('▶ Нечего выпускать');
    const started = startRelease(office, 'desktop', 'manual');
    await whenReleasesIdle(office);
    const r = office.releases.get(started.release!.id)!;
    check('выпуск пропущен без вопроса', r.status === 'skipped' && !openGate());
  }

  // 3. Отказ и версия от владельца.
  {
    say('▶ Отказ и своя версия');
    mergedTask('Мелочь', 'small.txt');
    const a = startRelease(office, 'desktop', 'manual');
    await until(() => Boolean(openGate()));
    answer('Нужны правки');
    await whenReleasesIdle(office);
    check('«нет» — выпуск отложен', office.releases.get(a.release!.id)!.status === 'skipped');
    check('тега не появилось', !sh(dir, 'rev-parse', '--verify', 'refs/tags/v0.2.1'));
    const b = startRelease(office, 'desktop', 'manual');
    await until(() => Boolean(openGate()));
    answer('выпускай как 1.0.0');
    await whenReleasesIdle(office);
    const rb = office.releases.get(b.release!.id)!;
    check('версия из ответа владельца', rb.status === 'done' && rb.version === '1.0.0' && rb.levelFrom === 'owner');
    check('тег v1.0.0', Boolean(sh(origin, 'rev-parse', '--verify', 'refs/tags/v1.0.0')));
  }

  // 4. Пуш по закрытой фиче: CI упал, починка задачей от ветки выпуска, повтор.
  {
    say('▶ Пуш на стенд по закрытой фиче, с починкой');
    check('до закрытия фичи повода нет', dueRelease(office)?.target.id !== 'staging');
    await later(5);
    const epic = office.createEpic({ title: 'Поиск', goal: 'поиск по записям', approved: true });
    mergedTask('Поиск', 'search.txt', epic.id);
    office.updateEpic(epic.id, { status: 'done', finishedAt: Date.now() });
    const due = dueRelease(office);
    check('закрытая фича — повод для стенда', due?.target.id === 'staging' && due.reason === 'epic.done');

    let calls = 0;
    setReleaseCi({
      async runs(_repo, sha) {
        calls += 1;
        const ok = sh(dir, 'log', '--format=%s', sha).includes('Починка');
        return { runs: [{ id: calls, name: 'deploy', status: 'completed', conclusion: ok ? 'success' : 'failure', url: `https://ci.test/${calls}` } as CiRun] };
      },
      async failedLog() { return 'step failed\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456\n'; },
    });
    const started = startRelease(office, 'staging', 'epic.done');
    check('выпуск по поводу начат', started.ok);
    const id = started.release!.id;
    check('заведена задача починки', await until(() => Boolean(office.releases.get(id)?.fixTaskId)));
    const fixId = office.releases.get(id)!.fixTaskId!;
    const fix = office.tasks.get(fixId)!;
    const releaseBranch = office.releases.get(id)!.branch;
    check('починка ответвляется от ветки выпуска', fix.forkFrom === releaseBranch);
    check('в задаче — лог без токена', fix.description.includes('step failed') && !fix.description.includes('ghp_abc'));
    check('без согласия: политика never', !openGate());
    // Исполнитель чинит в ветке выпуска, конвейер вливает — здесь руками.
    sh(dir, 'checkout', '-q', '-b', 'fix-tmp', releaseBranch);
    writeFileSync(resolve(dir, 'fix.txt'), 'починено\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-qm', 'Починка');
    sh(dir, 'branch', '-f', releaseBranch, 'HEAD');
    sh(dir, 'checkout', '-q', 'main');
    sh(dir, 'branch', '-D', 'fix-tmp');
    office.updateTask(fixId, { merged: true, status: 'done' });
    await whenReleasesIdle(office);
    const r = office.releases.get(id)!;
    check('выпуск состоялся со второй попытки', r.status === 'done' && r.attempts === 2);
    check('ветка deploy в origin — на починке', sh(origin, 'log', '--format=%s', '-1', 'deploy') === 'Починка');
    check('починка вернулась в main', existsSync(resolve(dir, 'fix.txt')));
    check('ссылки на CI', r.links.some((l) => l.url.startsWith('https://ci.test/')));
  }

  // 5. Второе падение — стоп, задача, решение.
  {
    say('▶ Сборка падает и после починки');
    setReleaseCi({
      async runs(_repo, _sha) { return { runs: [{ id: 1, name: 'deploy', status: 'completed', conclusion: 'failure', url: 'https://ci.test/x' }] }; },
      async failedLog() { return 'still broken'; },
    });
    await later(5);
    const epic = office.createEpic({ title: 'Теги', goal: 'метки', approved: true });
    mergedTask('Теги', 'tags.txt', epic.id);
    office.updateEpic(epic.id, { status: 'done', finishedAt: Date.now() });
    const started = startRelease(office, 'staging', 'epic.done');
    const id = started.release!.id;
    await until(() => Boolean(office.releases.get(id)?.fixTaskId));
    const firstFix = office.releases.get(id)!.fixTaskId!;
    office.updateTask(firstFix, { merged: true, status: 'done' });
    await whenReleasesIdle(office);
    const r = office.releases.get(id)!;
    check('встал с решением', r.status === 'failed' && r.needsDecision);
    const stopped = [...office.tasks.values()].filter((t) => t.title.includes('Починить сборку') && !t.forkFrom);
    check('на доске задача с логом, от main', stopped.length === 1 && stopped[0].description.includes('still broken'));
    check('ручной выпуск стенда запрещён политикой', startRelease(office, 'staging', 'manual').ok === false);
    setReleaseCi(null);
    office.settings.release = parseReleaseConfig({ targets: [desktop, { ...staging, ci: 'off' }, testflight] }, office.settings.checks);
    const again = resumeRelease(office, id);
    check('решение: пустить снова', again.ok);
    await whenReleasesIdle(office);
    check('после решения — выпущено со свежего снимка', office.releases.get(id)!.status === 'done');
  }

  // 6. Сборка командой: номер растёт, OFFICE_RESULT, повтор с новым номером.
  {
    say('▶ Сборка на машине (TestFlight)');
    mergedTask('Экран входа', 'login.txt');
    const a = startRelease(office, 'testflight', 'manual');
    await whenReleasesIdle(office);
    const ra = office.releases.get(a.release!.id)!;
    check('собрано без вопроса (не major)', ra.status === 'done');
    check('версия и номер', ra.version !== null && ra.build === 1);
    check('ссылка из OFFICE_RESULT', ra.links.some((l) => l.url === 'https://example.test/b/1'));

    writeFileSync(resolve(dir, 'boom'), '1');
    sh(dir, 'add', 'boom');
    sh(dir, 'commit', '-qm', 'Ломаем');
    const t = office.createTask({ title: 'Ломает', description: '', criteria: ['x'], roleId: 'backend', status: 'done' });
    office.updateTask(t.id, { merged: true, mergeCommit: sh(dir, 'rev-parse', 'HEAD'), outcome: { kind: 'clean', at: Date.now() } as unknown as Task['outcome'] });
    const b = startRelease(office, 'testflight', 'manual');
    const id = b.release!.id;
    check('упавшая сборка — задача починки', await until(() => Boolean(office.releases.get(id)?.fixTaskId)));
    const fixTask = office.tasks.get(office.releases.get(id)!.fixTaskId!)!;
    check('пароль из лога скрыт', !fixTask.description.includes('hunter22'));
    const rb0 = office.releases.get(id)!;
    const branch = rb0.branch;
    sh(dir, 'checkout', '-q', '-b', 'fix-tmp', branch);
    sh(dir, 'rm', '-q', 'boom');
    sh(dir, 'commit', '-qm', 'Починка сборки');
    sh(dir, 'branch', '-f', branch, 'HEAD');
    sh(dir, 'checkout', '-q', 'main');
    sh(dir, 'branch', '-D', 'fix-tmp');
    office.updateTask(fixTask.id, { merged: true, status: 'done' });
    await whenReleasesIdle(office);
    const rb = office.releases.get(id)!;
    check('собрано со второй попытки', rb.status === 'done');
    check('номер сборки на повторе вырос', rb.build === 3);
  }

  // 7. Политики: слияния, кулдаун, режим инициативы, план.
  {
    say('▶ Политики и план');
    await later(5);
    mergedTask('Раз', 'one.txt');
    check('одно слияние — рано', dueRelease(office)?.target.id !== 'testflight');
    mergedTask('Два', 'two.txt');
    check('два слияния — повод', dueRelease(office)?.target.id === 'testflight' && dueRelease(office)?.reason === 'merged');
    // Автоматический выпуск был десять минут назад — кулдаун в час держит.
    const auto = { ...office.releasesOf('testflight')[0], id: 'testflight-auto', reason: 'merged' as const, status: 'skipped' as const, startedAt: Date.now() - 10 * 60_000 };
    office.saveRelease(auto);
    await later(5);
    mergedTask('Три', 'three.txt');
    mergedTask('Четыре', 'four.txt');
    check('кулдаун держит', dueRelease(office)?.target.id !== 'testflight');
    office.settings.release = parseReleaseConfig({
      targets: [desktop, { ...staging, ci: 'off' }, { ...testflight, policy: { ...testflight.policy, cooldownHours: 0 } }],
    }, office.settings.checks);
    check('без кулдауна — повод', dueRelease(office)?.target.id === 'testflight');
    office.settings.initiativeMode = 'off';
    check('инициатива выключена — поводов нет', dueRelease(office) === null);
    office.settings.initiativeMode = 'propose';

    const e1 = office.createEpic({ title: 'Профиль', goal: 'x', approved: true });
    const e2 = office.createEpic({ title: 'Настройки', goal: 'y', approved: true });
    const planned = saveReleasePlan(office, { targetId: 'staging', title: '2.0', version: null, level: 'major', epicIds: [e1.id, e2.id] });
    check('план заведён', planned.ok && Boolean(office.openReleasePlan('staging')));
    check('фичи плана получили цель и разряд', office.epics.get(e1.id)?.release?.level === 'major');
    office.settings.release = parseReleaseConfig({ targets: [{ ...staging, ci: 'off' }] }, office.settings.checks);
    await later(5);
    office.updateEpic(e1.id, { status: 'done', finishedAt: Date.now() });
    check('закрыта одна фича плана — ждём вторую', dueRelease(office) === null);
    office.updateEpic(e2.id, { status: 'done', finishedAt: Date.now() });
    check('закрыты обе — повод', dueRelease(office)?.reason === 'epic.done');
    mergedTask('Профиль', 'profile.txt', e1.id);
    mergedTask('Настройки', 'settings.txt', e2.id);
    startRelease(office, 'staging', 'epic.done');
    await whenReleasesIdle(office);
    check('план закрыт выпуском', office.releasePlans.get(office.releasePlans.keys().next().value as string)?.status === 'closed');
    const bad = saveReleasePlan(office, { targetId: 'staging', title: 'x', version: 'два', level: null, epicIds: [] });
    check('версия плана проверяется', !bad.ok);
  }

  // 8. Чистые вычисления и защита.
  {
    say('▶ Версии, настройка, запрет обхода, секреты');
    check('semver: minor', nextVersion('semver', { version: '1.4.2', build: null }, 'minor', 0).version === '1.5.0');
    check('semver+build: номер растёт', versionLabel(nextVersion('semver+build', { version: '1.4.2', build: 57 }, 'patch', 0)) === '1.4.3 (58)');
    const day = Date.UTC(2026, 8, 27, 12);
    const c1 = nextVersion('calver', { version: null, build: null }, 'patch', day).version;
    check('calver: дата', c1 === '2026.09.27');
    check('calver: второй за день', nextVersion('calver', { version: c1, build: null }, 'patch', day).version === '2026.09.27.2');
    check('версия в ответе', versionInAnswer('да, но пусть будет 2.0.0') === '2.0.0' && versionInAnswer('да') === null);
    check('OFFICE_RESULT — последняя строка', parseBuildResult('лог\nOFFICE_RESULT {"build":58,"url":"https://x.test/58"}')?.build === 58);
    check('мусор в OFFICE_RESULT не роняет', parseBuildResult('OFFICE_RESULT {oops') === null);
    let err = '';
    try { parseReleaseConfig({ targets: [{ ...staging, branch: undefined }] }); } catch (e) { err = (e as Error).message; }
    check('пуш без ветки — ошибка', err.includes('ветка'));
    err = '';
    try { parseReleaseConfig({ targets: [staging, staging] }); } catch (e) { err = (e as Error).message; }
    check('две цели с одним id — ошибка', err.includes('дважды'));
    const settings = { release: { targets: [staging, testflight] }, checks: { testflight: 'bundle exec fastlane beta' } };
    check('пуш тегов запрещён', releaseCommandBlocked('git push origin --tags', settings) !== null);
    check('пуш в ветку CI запрещён', releaseCommandBlocked('git push origin HEAD:deploy', settings) !== null);
    check('пуш своей ветки можно', releaseCommandBlocked('git push origin task/T-5', settings) === null);
    check('команда сборки запрещена', releaseCommandBlocked('cd ios && bundle exec fastlane beta', settings) !== null);
    check('без целей — ничего не запрещено', releaseCommandBlocked('git push --tags', {}) === null);
    const scrubbed = scrubSecrets('TOKEN=abc123456 password: "hunter22" ghp_abcdefghijklmnopqrstuvwxyz0123 ok');
    check('секреты скрыты', !scrubbed.includes('abc123456') && !scrubbed.includes('hunter22') && !scrubbed.includes('ghp_') && scrubbed.includes('ok'));
  }

  // 9. Перезапуск: шедший выпуск поднимается вставшим, ждавший согласия — ждёт.
  {
    say('▶ Перезапуск');
    const saved = office.toPersisted();
    const building = { ...saved.releases![0], id: 'x-1', status: 'building' as const };
    const waiting = { ...saved.releases![0], id: 'x-2', status: 'waiting' as const };
    writeFileSync(resolve(tmpdir(), `office-releases-state-${process.pid}.json`), JSON.stringify({ ...saved, releases: [building, waiting] }));
    const again = getOffice('o-releases-restore');
    again.setStateFile(resolve(tmpdir(), `office-releases-state-${process.pid}.json`));
    again.projectDir = dir;
    again.restore();
    check('сборка после перезапуска — встала', again.releases.get('x-1')?.status === 'failed');
    check('согласие после перезапуска — ждёт', again.releases.get('x-2')?.status === 'waiting');
  }

  const failed = results.filter((l) => l.includes('❌')).length;
  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ все проверки выпусков прошли');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
