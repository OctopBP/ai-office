/**
 * Заметки о выпуске на языке реализации (T-679, аудит D-10 п. 1–4, 16).
 *
 * Офис говорит по-русски, а код пишет по-английски. Заметки о выпуске уходят
 * в CHANGELOG.md, аннотацию тега и OFFICE_RELEASE_NOTES — это артефакты
 * проекта, поэтому они на языке реализации.
 *
 * Проверяется: промпт заметок просит английский; выпуск без задач пишет в
 * CHANGELOG.md, тег и OFFICE_RELEASE_NOTES английскую запасную фразу; запасной
 * список из названий задач идёт как есть; карточка согласования показывает
 * владельцу те же заметки, что легли в CHANGELOG.
 *
 * Модель не зовётся: заметки отдаёт подставной агент, как в dry-run.
 *
 * Запуск: npm run test:release-notes-lang
 */
import './_isolate';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, type OfficeState, type Task } from '../src/server/state';
import {
  releaseNotesPrompt, releaseTiming, setReleaseAgents, startRelease, whenReleasesIdle, type NotesInput,
} from '../src/server/releases';
import { setPipelineAgents } from '../src/server/review';
import { releaseTagMessage } from '../src/server/vcs-messages';
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

const CYRILLIC = /[а-яё]/i;

/** Репозиторий с CHANGELOG.md; сборка копирует OFFICE_RELEASE_NOTES в `seen`. */
function makeRepo(dir: string, seen: string): ReturnType<typeof gitIn> {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = gitIn(dir);
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, '.gitignore'), '.office/\n');
  writeFileSync(resolve(dir, 'CHANGELOG.md'), '# Changelog\n');
  writeFileSync(resolve(dir, 'build.cjs'), [
    "const fs = require('node:fs');",
    `fs.copyFileSync(process.env.OFFICE_RELEASE_NOTES, ${JSON.stringify(seen)});`,
    "console.log('OFFICE_RESULT ' + JSON.stringify({ text: 'built' }));",
  ].join('\n'));
  writeFileSync(resolve(dir, 'bump.cjs'), "require('node:fs').writeFileSync('version.txt', process.argv[2] + '\\n');\n");
  writeFileSync(resolve(dir, 'version.txt'), '0\n');
  git('add', '-A');
  git('commit', '-qm', 'Start');
  return git;
}

function makeOffice(id: string, root: string, repo: string, target: ReleaseTarget): OfficeState {
  const office = getOffice(id);
  office.setStateFile(resolve(root, `${id}.json`));
  office.seed();
  office.projectDir = repo;
  office.opened = true;
  office.settings.chatLanguage = 'ru';
  office.settings.language = 'ru';
  office.settings.codeLanguage = 'en';
  office.settings.autoPipeline = true;
  office.settings.checks = { app: 'node build.cjs' };
  office.settings.release = parseReleaseConfig({ targets: [target] }, office.settings.checks);
  return office;
}

/** Последняя запись CHANGELOG.md в main: от первого «## » до следующего. */
const lastEntry = (git: ReturnType<typeof gitIn>): string =>
  git('show', 'main:CHANGELOG.md').split(/^## /m)[1] ?? '';

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
    notifyPm() {},
  });
  const prompts: string[] = [];
  const inputs: NotesInput[] = [];
  setReleaseAgents({
    // Как в dry-run: модель молчит, офис пишет заметки сам. Промпт строим тем же
    // помощником, что и настоящий агент, — проверяем, о каком языке он просит.
    async notes(state, input) {
      inputs.push(input);
      prompts.push(releaseNotesPrompt(state, input));
      return { text: '', costUsd: 0 };
    },
  });

  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'office-release-notes-lang-')));
  const target: ReleaseTarget = {
    id: 'app', title: 'Приложение', kind: 'command', run: 'app', timeoutMin: 2,
    bump: 'node bump.cjs {build}', tag: 'v{version}',
    policy: { when: ['manual'], approve: 'never' },
    version: { scheme: 'build', level: 'patch' },
  };

  // 1. Выпуск без задач: запасная фраза — на языке реализации.
  {
    console.log('▶ Выпуск без задач: запасная фраза на английском');
    const repo = resolve(root, 'empty');
    const seen = resolve(root, 'empty.notes.md');
    const git = makeRepo(repo, seen);
    writeFileSync(resolve(repo, 'readme.txt'), 'more\n');
    git('add', '-A');
    git('commit', '-qm', 'More work');
    const office = makeOffice('o-notes-lang-empty', root, repo, target);
    check('язык общения ru, язык реализации en', office.lang() === 'ru' && office.codeLang() === 'en');
    const id = startRelease(office, 'app', 'manual').release?.id ?? '';
    await whenReleasesIdle(office);
    const done = office.releases.get(id)!;
    check('выпуск состоялся', done.status === 'done', `${done.status} ${done.stage} ${JSON.stringify(done.stop)}`);
    check('заметки — английская запасная фраза', done.notes === '- small fixes', done.notes);
    check('модель без задач не звали', prompts.length === 0);
    const entry = lastEntry(git);
    check('запись CHANGELOG.md на английском', entry.includes('- small fixes') && !CYRILLIC.test(entry), entry);
    let notesFile = '';
    try { notesFile = readFileSync(seen, 'utf8'); } catch { /* проверка ниже скажет */ }
    check('OFFICE_RELEASE_NOTES на английском', notesFile.trim() === '- small fixes', notesFile);
    // У цели-команды тега нет: аннотацию собираем так же, как узел tag.
    const tagMsg = releaseTagMessage(office.codeLang(), target.title, '1', done.notes);
    check('аннотация тега на английском', tagMsg.startsWith('Release Приложение 1') && tagMsg.includes('- small fixes')
      && !tagMsg.includes('Выпуск') && !tagMsg.includes('мелкие'), tagMsg);
  }

  // 2. Выпуск с задачей: промпт просит английский, карточка — те же заметки.
  {
    console.log('▶ Выпуск с задачей: промпт на язык реализации, карточка без второй версии');
    const repo = resolve(root, 'tasks');
    const seen = resolve(root, 'tasks.notes.md');
    const git = makeRepo(repo, seen);
    const office = makeOffice('o-notes-lang-tasks', root, repo, { ...target, policy: { when: ['manual'], approve: 'always' } });
    writeFileSync(resolve(repo, 'login.txt'), 'login\n');
    git('add', '-A');
    git('commit', '-qm', 'Login');
    const task = office.createTask({ title: 'Вход по ссылке', description: '', criteria: ['x'], roleId: 'backend', status: 'done' });
    office.updateTask(task.id, {
      merged: true, mergeCommit: git('rev-parse', 'HEAD'), handoff: { did: 'Сделан вход' } as unknown as Task['handoff'],
      outcome: { kind: 'clean', at: Date.now() } as unknown as Task['outcome'],
    });

    const id = startRelease(office, 'app', 'manual').release?.id ?? '';
    // Ждём карточку согласования и отвечаем «да».
    for (let i = 0; i < 200; i += 1) {
      const q = office.questionList().find((x) => x.kind === 'gate' && !x.answeredAt && !x.dismissedAt);
      if (q) {
        const r = office.releases.get(id)!;
        check('карточка показывает те же заметки, что в выпуске', r.notes.length > 0
          && (q.text.includes(r.notes) || (q.details ?? '').includes(r.notes)), `${r.notes}\n---\n${q.text}`);
        check('в карточке одна версия заметок', (q.text.split(r.notes).length - 1) <= 1);
        office.updateQuestion(q.id, { answer: 'Выпускай', answeredAt: Date.now() });
        break;
      }
      await new Promise((ok) => setTimeout(ok, 20));
    }
    await whenReleasesIdle(office);
    const done = office.releases.get(id)!;
    check('выпуск состоялся', done.status === 'done', `${done.status} ${done.stage} ${JSON.stringify(done.stop)}`);
    const prompt = prompts[0] ?? '';
    check('агенту заметок отданы задачи выпуска', inputs[0]?.tasks.some((t) => t.id === task.id) ?? false);
    check('промпт заметок просит язык реализации (English)', /Язык: English\./.test(prompt), prompt);
    check('промпт не просит язык общения', !prompt.includes('Русский') && !prompt.includes('Russian'), prompt);
    // Запасной список — названия задач как есть: перевести их нечем.
    check('запасной список — название задачи как есть', done.notes === '- Вход по ссылке', done.notes);
    check('CHANGELOG.md получил те же заметки', lastEntry(git).includes('- Вход по ссылке'), lastEntry(git));
  }

  console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ заметки о выпуске идут на языке реализации');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
