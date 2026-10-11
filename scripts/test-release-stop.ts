/**
 * Причина остановки выпуска доходит до менеджера (T-552).
 *
 * Реальный случай: выпуск встал с «… — не git-репозиторий», владелец увидел
 * это в ленте, а менеджер — нет, и попросил владельца прислать текст ошибки.
 *
 * Проверяется: выпуск из папки без git хранит стадию и причину, виден в
 * `release_status` и целиком в `get_release`, менеджеру уходит системное
 * сообщение с id и причиной (повтор надзора с той же причиной — без второго
 * сообщения); упавшая сборка оставляет хвост журнала в 40 строк, и значения
 * переменных офиса в нём закрыты.
 *
 * Запуск: npm run test:release-stop
 */
import './_isolate';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice } from '../src/server/state';
import {
  driveRelease, releaseStatusText, releaseText, releaseTiming, resumeRelease, setReleaseAgents, startRelease, whenReleasesIdle,
} from '../src/server/releases';
import { setPipelineAgents } from '../src/server/review';
import { memoryKeychain } from '../src/server/engines/keys';
import { setSecret, useSecretStore } from '../src/server/secrets';
import { parseReleaseConfig, STOP_LOG_LINES, type ReleaseTarget } from '../src/shared/release';

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

const SECRET = 'tok-very-secret-552';

async function main(): Promise<void> {
  process.on('beforeExit', () => {
    console.error('\n❌ проверки зависли: выпуск ждёт того, чего не будет');
    process.exit(1);
  });
  releaseTiming.taskPollMs = 20;
  useSecretStore(memoryKeychain());

  // Сообщения менеджеру — тем же каналом, каким их шлёт конвейер ревью.
  const toPm: string[] = [];
  setPipelineAgents({
    async review() { return { verdict: 'changes', text: '', reviewerId: null, error: 'нет' }; },
    async rework() { return { ok: false, message: 'нет' }; },
    notifyPm(_state, text) { toPm.push(text); },
  });
  setReleaseAgents({ async notes() { return { text: '- заметки', costUsd: 0 }; } });

  const root = mkdtempSync(resolve(tmpdir(), 'office-release-stop-'));
  const target: ReleaseTarget = {
    id: 'testflight', title: 'TestFlight', kind: 'command', run: 'testflight', timeoutMin: 2,
    policy: { when: ['manual'], approve: 'never' },
    version: { scheme: 'build', level: 'patch' },
  };

  // 1. Папка проекта — не git-репозиторий.
  {
    console.log('▶ Выпуск из папки, которая не git-репозиторий');
    const plain = resolve(root, 'Polka');
    execFileSync('mkdir', ['-p', plain]);
    const office = getOffice('o-release-stop-plain');
    office.setStateFile(resolve(root, 'plain-state.json'));
    office.seed();
    office.projectDir = plain;
    office.opened = true;
    office.settings.checks = { testflight: 'node build.js' };
    office.settings.release = parseReleaseConfig({ targets: [target] }, office.settings.checks);

    const started = startRelease(office, 'testflight', 'manual');
    const id = started.release?.id ?? '';
    await whenReleasesIdle(office);
    const r = office.releases.get(id)!;
    const why = `${plain} — не git-репозиторий.`;
    check('выпуск встал', r.status === 'failed');
    check('в выпуске — стадия и причина', r.stop?.node === 'snapshot' && r.stop.reason === why && r.stop.at > 0, JSON.stringify(r.stop));
    check('до сборки не дошло — хвоста журнала нет', r.stop?.log === '');
    check('владельцу в ленте — как раньше', office.chat.some((m) => m.text.includes('встал') && m.text.includes(why)));

    const status = releaseStatusText(office);
    check('release_status: id, стадия и причина', status.includes(`встал ${id}`) && status.includes('snapshot') && status.includes(why), status);
    check('release_status: когда встал', status.includes(new Date(r.stop!.at).toISOString().slice(0, 10)));

    const one = releaseText(office, id);
    check('get_release: цель, стадии с исходом, причина', one.ok && one.message.includes('testflight «TestFlight»')
      && /Снимок \(snapshot\) — исход fail/.test(one.message) && one.message.includes(why), one.message);
    check('get_release: про журнал сказано, что его нет', one.message.includes('Журнала сборки нет'));
    check('get_release: нет такого выпуска — отказ с подсказкой', (() => {
      const none = releaseText(office, 'нет-1');
      return !none.ok && none.message.includes(id);
    })());

    check('менеджеру — сообщение с id, причиной и get_release',
      toPm.length === 1 && toPm[0].includes(id) && toPm[0].includes(why) && toPm[0].includes('get_release'), toPm.join('\n---\n'));
    // Повтор надзора встаёт там же: пересказывать менеджеру то же самое незачем.
    await driveRelease(office, id);
    check('повтор с той же причиной — без второго сообщения', toPm.length === 1 && office.releases.get(id)?.status === 'failed');
    check('явный resume_release — менеджер узнаёт заново', resumeRelease(office, id).ok
      && (await whenReleasesIdle(office), toPm.length === 2));
  }

  // 2. Сборка падает: хвост журнала, секреты закрыты.
  {
    console.log('▶ Упавшая сборка: хвост журнала и переменные офиса');
    toPm.length = 0;
    const dir = resolve(root, 'project');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git('config', 'user.email', 'office@local');
    git('config', 'user.name', 'AI Office');
    writeFileSync(resolve(dir, '.gitignore'), '.office/\n');
    // Шестьдесят строк, значение переменной офиса в предпоследней, код возврата 1.
    writeFileSync(resolve(dir, 'build.js'), [
      "for (let i = 1; i <= 60; i += 1) console.log('строка ' + i);",
      "console.error('upload failed with ' + process.env.DEPLOY_TOKEN);",
      "console.error('error: сборка не прошла');",
      'process.exit(1);',
    ].join('\n'));
    git('add', '-A');
    git('commit', '-qm', 'Начало');

    const office = getOffice('o-release-stop-build');
    office.setStateFile(resolve(root, 'build-state.json'));
    office.seed();
    office.projectDir = dir;
    office.opened = true;
    office.settings.autoPipeline = true;
    office.settings.checks = { testflight: 'node build.js' };
    office.settings.release = parseReleaseConfig({ targets: [target] }, office.settings.checks);
    await setSecret(office.officeId, 'DEPLOY_TOKEN', SECRET);

    const started = startRelease(office, 'testflight', 'manual');
    const id = started.release?.id ?? '';
    check('сборка упала — заведена починка', await until(() => Boolean(office.releases.get(id)?.fixTaskId)), started.message);
    const kept = office.releases.get(id)?.failLog ?? '';
    check('хвост сохранён ещё до остановки', kept.includes('сборка не прошла'));
    // Починка не удалась — выпуск встаёт и ждёт решения.
    office.updateTask(office.releases.get(id)!.fixTaskId!, { status: 'failed' });
    await whenReleasesIdle(office);
    const r = office.releases.get(id)!;
    const log = r.stop?.log ?? '';
    check('встал на починке и ждёт решения', r.status === 'failed' && r.stop?.node === 'fix' && r.stop.needsDecision, JSON.stringify(r.stop));
    check(`хвост — последние ${STOP_LOG_LINES} строк`, log.split('\n').length === STOP_LOG_LINES
      && log.includes('строка 60') && !log.includes('строка 10\n') && log.endsWith('error: сборка не прошла'), log);
    check('значение переменной офиса в хвосте закрыто', !log.includes(SECRET) && log.includes('upload failed with ***'), log);

    const one = releaseText(office, id).message;
    check('get_release: причина и хвост журнала', one.includes('Причина остановки') && one.includes('Хвост журнала сборки')
      && one.includes('строка 60') && /Сборка командой \(build\) — исход fail/.test(one), one);
    const status = releaseStatusText(office);
    const persisted = JSON.stringify(office.toPersisted());
    check('значения нет ни в get_release, ни в release_status, ни в состоянии, ни в сообщении менеджеру',
      ![one, status, persisted, ...toPm, ...office.chat.map((m) => m.text)].some((t) => t.includes(SECRET)));
    check('release_status: вставший выпуск под целью', status.includes(`встал ${id}`) && status.includes('(fix)') && status.includes('resume_release'), status);
    check('менеджеру — сообщение с id и подсказкой про get_release', toPm.some((t) => t.includes(id) && t.includes('get_release')), toPm.join('\n---\n'));
  }

  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ причина остановки выпуска доходит до менеджера');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
