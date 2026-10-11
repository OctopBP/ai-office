/**
 * Менеджер отменяет вставший или идущий выпуск (T-557).
 *
 * Реальный случай: testflight-1 встал из-за неверной папки и остался висеть у
 * цели — отменить его было нечем.
 *
 * Проверяется:
 * - `cancel_release` вставшего выпуска: локальный тег, ветка выпуска и рабочая
 *   копия убраны, версия свободна; запушенный тег остаётся и назван в ответе;
 * - `cancel_release` идущего выпуска: команда сборки снята вместе с потомками,
 *   вопрос владельцу снят, номер сборки сгорает только если сборка запускалась;
 * - отменённый выпуск в `release_status` и `get_release` — отменённый, а не
 *   последний выпуск цели; отмена видна в ленте.
 *
 * Запуск: npm run test:release-cancel
 */
import './_isolate';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, type OfficeState } from '../src/server/state';
import {
  cancelRelease, releaseDir, releaseStatusText, releaseText, releaseTiming, resumeRelease,
  setReleaseAgents, setReleaseCi, startRelease, whenReleasesIdle,
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

type Git = (...args: string[]) => string;

function makeRepo(dir: string, files: Record<string, string>): Git {
  const git: Git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, '.gitignore'), '.office/\n');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(resolve(dir, name, '..'), { recursive: true });
    writeFileSync(resolve(dir, name), text);
  }
  git('add', '-A');
  git('commit', '-qm', 'Начало');
  return git;
}

function makeOffice(id: string, root: string, dir: string, targets: ReleaseTarget[], checks: Record<string, string>): OfficeState {
  const office = getOffice(id);
  office.setStateFile(resolve(root, `${id}.json`));
  office.seed();
  office.projectDir = dir;
  office.opened = true;
  office.settings.autoPipeline = true;
  office.settings.checks = checks;
  office.settings.release = parseReleaseConfig({ targets }, checks);
  return office;
}

const openQuestions = (office: OfficeState) => [...office.questions.values()].filter((q) => !q.answeredAt && !q.dismissedAt);
/** Ответить на единственный открытый вопрос; вернуть его id. */
async function answer(office: OfficeState, text: string): Promise<string> {
  await until(() => openQuestions(office).length > 0);
  const q = openQuestions(office)[0];
  if (q) office.updateQuestion(q.id, { answer: text, answeredAt: Date.now() });
  return q?.id ?? '';
}

/** Сборка упала — выпуск завёл починку; проваливаем её, и выпуск встаёт с решением. */
async function failFix(office: OfficeState, id: string): Promise<void> {
  await until(() => Boolean(office.releases.get(id)?.fixTaskId) || office.releases.get(id)?.status === 'failed');
  const task = office.releases.get(id)?.fixTaskId;
  if (task) office.updateTask(task, { status: 'failed' });
  await whenReleasesIdle(office);
}

const alivePid = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function main(): Promise<void> {
  process.on('beforeExit', () => {
    console.error('\n❌ проверки зависли: выпуск ждёт того, чего не будет');
    process.exit(1);
  });
  releaseTiming.taskPollMs = 20;
  releaseTiming.ciPollMs = 20;
  useSecretStore(memoryKeychain());

  const toPm: string[] = [];
  setPipelineAgents({
    async review() { return { verdict: 'changes', text: '', reviewerId: null, error: 'нет' }; },
    async rework() { return { ok: false, message: 'нет' }; },
    notifyPm(_state, text) { toPm.push(text); },
  });
  setReleaseAgents({ async notes() { return { text: '- заметки', costUsd: 0 }; } });

  // macOS отдаёт tmpdir через ссылку /var → /private/var, а cwd сборки уже разыменован.
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'office-release-cancel-')));

  // 1. Отмена вставшего выпуска: локальный тег убран, версия свободна.
  {
    console.log('▶ cancel_release вставшего выпуска: неопубликованный тег');
    const dir = resolve(root, 'local');
    const git = makeRepo(dir, { 'README.md': 'проект\n' });
    const target: ReleaseTarget = {
      id: 'desktop', title: 'Приложение', kind: 'tag', tag: 'v{version}', ci: 'required',
      policy: { when: ['manual'], approve: 'never' },
      version: { scheme: 'semver', level: 'patch' },
    };
    const office = makeOffice('o-release-cancel-tag', root, dir, [target], {});
    setReleaseCi({ async runs() { return null; }, async failedLog() { return ''; } });

    const id = startRelease(office, 'desktop', 'manual').release?.id ?? '';
    await failFix(office, id);
    const stuck = office.releases.get(id)!;
    const tag = `v${stuck.version}`;
    check('выпуск встал после тега: CI нет', stuck.status === 'failed' && stuck.stop?.node === 'fix', `${stuck.status} / ${JSON.stringify(stuck.stop)}`);
    check('локальный тег создан', git('tag', '--list') === tag && stuck.tag === tag, git('tag', '--list'));

    const logBefore = office.log.length;
    const out = await cancelRelease(office, id, 'цель настроена неверно');
    const r = office.releases.get(id)!;
    check('cancel_release принят', out.ok && out.message.includes('отменён'), out.message);
    check('выпуск отменён, причина записана', r.status === 'cancelled' && r.cancel?.reason === 'цель настроена неверно' && r.finishedAt !== null);
    check('локальный тег убран', git('tag', '--list') === '');
    check('ветка выпуска убрана', git('branch', '--list', 'office/rel/*') === '' && r.branch === '');
    check('снаружи ничего не осталось', r.cancel?.outside.length === 0 && out.message.includes('Снаружи ничего не осталось'), out.message);
    check('отмена видна в ленте и в чате',
      office.log.slice(logBefore).some((e) => e.text.includes(id) && e.text.includes('отменён'))
      && office.chat.some((m) => m.text.includes(id) && m.text.includes('отменён')));

    const status = releaseStatusText(office);
    check('release_status: отменён, а не встал и не последний выпуск',
      status.includes(`отменён ${id}`) && status.includes('цель настроена неверно') && !status.includes(`встал ${id}`)
      && /последний выпуск[^\n]*—/i.test(status), status);
    const one = releaseText(office, id).message;
    check('get_release: отмена и причина', one.includes('Отменён') && one.includes('цель настроена неверно'), one);
    check('отменённый выпуск не возобновить', !resumeRelease(office, id).ok);
    check('повторная отмена — отказ', !(await cancelRelease(office, id, 'ещё раз')).ok);

    const next = startRelease(office, 'desktop', 'manual').release?.id ?? '';
    check('версия не считается выпущенной: новый выпуск берёт её же', await until(() => office.releases.get(next)?.version === stuck.version),
      `${office.releases.get(next)?.version} / ${stuck.version}`);
    await cancelRelease(office, next, 'проверка окончена');
  }

  // 2. Отмена вставшего выпуска: тег уже в origin — остаётся.
  {
    console.log('▶ cancel_release вставшего выпуска: тег запушен');
    const dir = resolve(root, 'pushed');
    const origin = resolve(root, 'pushed-origin.git');
    const git = makeRepo(dir, { 'README.md': 'проект\n' });
    execFileSync('git', ['init', '-q', '--bare', origin]);
    git('remote', 'add', 'origin', origin);
    git('push', '-q', 'origin', 'main');
    const target: ReleaseTarget = {
      id: 'desktop', title: 'Приложение', kind: 'tag', tag: 'v{version}', ci: 'required',
      policy: { when: ['manual'], approve: 'never' },
      version: { scheme: 'semver', level: 'patch' },
    };
    const office = makeOffice('o-release-cancel-pushed', root, dir, [target], {});
    const id = startRelease(office, 'desktop', 'manual').release?.id ?? '';
    await failFix(office, id);
    const stuck = office.releases.get(id)!;
    const tag = `v${stuck.version}`;
    check('тег ушёл в origin', execFileSync('git', ['tag', '--list'], { cwd: origin, encoding: 'utf8' }).trim() === tag
      && Boolean(stuck.pushed?.includes(`refs/tags/${tag}`)), JSON.stringify(stuck.pushed));

    const out = await cancelRelease(office, id, 'не та версия');
    const r = office.releases.get(id)!;
    check('выпуск отменён', out.ok && r.status === 'cancelled', out.message);
    check('запушенный тег не тронут ни в origin, ни локально',
      execFileSync('git', ['tag', '--list'], { cwd: origin, encoding: 'utf8' }).trim() === tag && git('tag', '--list') === tag);
    check('менеджеру названо, что осталось снаружи', out.message.includes('Снаружи осталось') && out.message.includes(tag)
      && Boolean(r.cancel?.outside.some((l) => l.includes(tag))), out.message);
    check('ветка выпуска убрана', git('branch', '--list', 'office/rel/*') === '');
    check('release_status называет, что осталось снаружи', releaseStatusText(office).includes(`тег ${tag} запушен`), releaseStatusText(office));
    setReleaseCi(null);
  }

  // 3. Отмена идущего выпуска: сборка снята, вопрос снят, номер сборки.
  {
    console.log('▶ cancel_release идущего выпуска');
    const dir = resolve(root, 'running');
    const pidFile = resolve(root, 'build.pid');
    const git = makeRepo(dir, {
      // Сборка, которая сама не закончится: пишет свой pid и ждёт.
      'build.cjs': `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    });
    const target: ReleaseTarget = {
      id: 'testflight', title: 'TestFlight', kind: 'command', run: 'testflight', timeoutMin: 5,
      policy: { when: ['manual'], approve: 'always' },
      version: { scheme: 'build', level: 'patch' },
    };
    // `&&` держит оболочку родителем сборки: отмена обязана снять и потомка.
    const office = makeOffice('o-release-cancel-running', root, dir, [target], { testflight: 'node build.cjs && echo готово' });

    // Отмена, пока выпуск ждёт согласия владельца.
    const waiting = startRelease(office, 'testflight', 'manual').release?.id ?? '';
    check('выпуск ждёт согласия', await until(() => office.releases.get(waiting)?.status === 'waiting'));
    const cancelledWaiting = await cancelRelease(office, waiting, 'передумали');
    await whenReleasesIdle(office);
    const w = office.releases.get(waiting)!;
    check('отменён в ожидании', cancelledWaiting.ok && w.status === 'cancelled', cancelledWaiting.message);
    check('вопрос владельцу снят', openQuestions(office).length === 0);
    check('номер сборки не сожжён', w.build === 1 && w.cancel?.buildFree === true && cancelledWaiting.message.includes('наружу не ушёл'),
      `${w.build} ${JSON.stringify(w.cancel)}\n${cancelledWaiting.message}`);
    check('ветка выпуска убрана', git('branch', '--list', 'office/rel/*') === '');

    // Отмена во время сборки.
    const id = startRelease(office, 'testflight', 'manual').release?.id ?? '';
    await answer(office, 'Выпускай');
    check('сборка идёт', await until(() => existsSync(pidFile) && office.releases.get(id)?.status === 'building', 8000), `${office.releases.get(id)?.stage}\n${office.releases.get(id)?.failLog}`);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    check('неотданный номер взят снова', office.releases.get(id)?.build === 1, String(office.releases.get(id)?.build));
    check('рабочая копия выпуска создана', existsSync(releaseDir(office, target)));
    const startedAt = Date.now();
    const out = await cancelRelease(office, id, 'сборка не нужна');
    const r = office.releases.get(id)!;
    check('cancel_release идущего выпуска принят', out.ok && r.status === 'cancelled', out.message);
    check('отмена не ждёт таймаута сборки', Date.now() - startedAt < 10_000, `${Date.now() - startedAt} мс`);
    check('команда сборки остановлена', await until(() => !alivePid(pid), 5000));
    await whenReleasesIdle(office);
    check('выпуск остался отменённым, а не вставшим', office.releases.get(id)?.status === 'cancelled' && !office.releases.get(id)?.stop,
      office.releases.get(id)?.stage);
    check('рабочая копия и ветка выпуска убраны', !existsSync(releaseDir(office, target)) && git('branch', '--list', 'office/rel/*') === ''
      && git('worktree', 'list').split('\n').length === 1, git('worktree', 'list'));
    check('сборка запускалась — номер занят и назван в ответе', r.cancel?.buildFree === false && out.message.includes('считается занятым')
      && Boolean(r.cancel?.outside.some((l) => l.includes('команда сборки запускалась'))), out.message);
    check('менеджеру о вставшем выпуске не сообщалось', !toPm.some((t) => t.includes(id) && t.includes('встал')));

    const next = startRelease(office, 'testflight', 'manual').release?.id ?? '';
    check('следующий выпуск берёт следующий номер', await until(() => office.releases.get(next)?.build === 2), String(office.releases.get(next)?.build));
    await cancelRelease(office, next, 'проверка окончена');
    await whenReleasesIdle(office);
    const status = releaseStatusText(office);
    check('release_status: последний выпуск цели — прочерк, отменённые перечислены',
      /последний выпуск[^\n]*—/i.test(status) && status.includes(`отменён ${id}`), status);
  }

  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ менеджер отменяет вставший и идущий выпуск');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
