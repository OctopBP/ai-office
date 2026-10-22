/**
 * Проверки шаблонов того, что офис сам пишет в git и на GitHub
 * (src/server/vcs-messages.ts): выбор по языку реализации с английским как
 * запасным, нетронутые технические части и сообщение подтягивания базы в
 * настоящем репозитории.
 *
 * Запуск: npm run test:vcs-messages
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeBaseInto, taskCommitRe } from '../src/server/git';
import {
  prBody, releaseSubjects, releaseTagMessage, taskCommitMessage, taskSubject, vcsLang, vcsText, VCS_LANGS,
} from '../src/server/vcs-messages';

const results: string[] = [];
const check = (text: string, ok: boolean): void => { results.push(`${text}: ${ok}`); };

// 1. Язык шаблонов: свой для ru/en, для прочих и мусора — английский.
check('ru → ru', vcsLang('ru') === 'ru');
check('en → en', vcsLang('en') === 'en');
check('ru-RU → ru', vcsLang('ru-RU') === 'ru');
check('de → запасной en', vcsLang('de') === 'en');
check('пусто → запасной en', vcsLang('') === 'en');
check('не строка → запасной en', vcsLang(undefined) === 'en' && vcsLang(42) === 'en');

// 2. Один ключ — разный текст по языку; чужой язык — английский текст.
const sync = (lang: string): string => vcsText(lang, 'syncMerge', { base: 'origin/main', branch: 'task/T-12' });
check('sync ru', sync('ru') === 'Слияние ветки «origin/main» в task/T-12');
check('sync en', sync('en') === "Merge branch 'origin/main' into task/T-12");
check('sync fr = en', sync('fr') === sync('en'));
check('выпуск ru', vcsText('ru', 'release', { target: 'Приложение', version: '1.2.0' }) === 'Выпуск Приложение 1.2.0');
check('выпуск en', vcsText('en', 'release', { target: 'App', version: '1.2.0' }) === 'Release App 1.2.0');
check('доработка ru/en', vcsText('ru', 'rework', { task: 'T-3' }) === 'T-3: доработка'
  && vcsText('en', 'rework', { task: 'T-3' }) === 'T-3: rework');
check('частичная работа ru', vcsText('ru', 'partialStopped', { task: 'T-3' }) === 'T-3: частичная работа (остановлено)');
check('начальный коммит en', vcsText('en', 'initCommit') === 'Initial state of the working directory');

// 3. Технические части не переводятся: T-N, ветки, версии, имя узла.
for (const lang of [...VCS_LANGS, 'de']) {
  check(`${lang}: T-N и ветки как есть`, sync(lang).includes('origin/main') && sync(lang).includes('task/T-12'));
  check(`${lang}: шаг процесса — имя узла как есть`, vcsText(lang, 'settleStep', { task: 'T-9', node: 'review' }) === 'T-9: review');
  check(`${lang}: публикация агента — имя и версия как есть`,
    vcsText(lang, 'agentPublish', { name: '@me/agent', version: '0.2.1' }).startsWith('@me/agent@0.2.1: '));
}

// 4. Коммит задачи: префикс «T-N: » одинаков на всех языках, и его находит taskCommitRe.
for (const lang of [...VCS_LANGS, 'de']) {
  const msg = taskCommitMessage('T-7', 'Заголовок', 'Сделано.', lang);
  check(`${lang}: коммит задачи «T-7: заголовок»`, msg === 'T-7: Заголовок\n\nСделано.');
  check(`${lang}: taskCommitRe находит коммит задачи`, taskCommitRe('T-7').test(msg));
  check(`${lang}: заголовок PR`, taskSubject(lang, 'T-7', '  Два\n слова ') === 'T-7: Два слова');
}
check('без языка — как раньше', taskCommitMessage('T-7', 'Заголовок', null) === 'T-7: Заголовок');

// 5. Тег выпуска: заголовок по языку, заметки ниже как есть.
check('тег ru', releaseTagMessage('ru', 'Приложение', '1.0.0', '- пункт') === 'Выпуск Приложение 1.0.0\n\n- пункт');
check('тег en без заметок', releaseTagMessage('en', 'App', '1.0.0', '') === 'Release App 1.0.0');
check('темы выпуска на всех языках', JSON.stringify(releaseSubjects('App')) === JSON.stringify(['Выпуск App ', 'Release App ']));

// 6. Тело PR по языку.
const input = {
  taskId: 'T-5', title: 'Кнопка', description: 'Описание',
  criteria: [{ text: 'Первый', done: true }, { text: 'Второй', done: false }],
  report: 'Отчёт', assumed: 'Решил', left: null,
};
const ru = prBody('ru', input);
const en = prBody('en', input);
check('PR ru', ru.startsWith('**Задача T-5: Кнопка**') && ru.includes('отмечено 1 из 2') && ru.includes('Решения автора:')
  && ru.includes('- [x] Первый') && !ru.includes('Не сделано:'));
check('PR en', en.startsWith('**Task T-5: Кнопка**') && en.includes('1 of 2 ticked') && en.includes('opened automatically'));
check('PR es = en', prBody('es', input) === en);

// 7. Настоящий репозиторий: подтягивание базы ложится коммитом с сообщением по шаблону.
const dir = mkdtempSync(join(tmpdir(), 'vcs-messages-'));
const g = (...args: string[]): string => execFileSync('git', args, {
  cwd: dir, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();
try {
  g('init', '-q', '-b', 'main');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  g('add', '-A'); g('commit', '-q', '-m', 'start');
  g('checkout', '-q', '-b', 'task/T-1');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  g('add', '-A'); g('commit', '-q', '-m', 'T-1: work');
  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'c.txt'), 'c\n');
  g('add', '-A'); g('commit', '-q', '-m', 'main moved');
  g('checkout', '-q', 'task/T-1');
  const message = vcsText('ru', 'syncMerge', { base: 'main', branch: 'task/T-1' });
  const out = await mergeBaseInto(dir, 'main', 'ru', undefined, message);
  check('git: подтягивание прошло', out.kind === 'merged');
  check('git: сообщение по шаблону ru', g('log', '-1', '--format=%s') === 'Слияние ветки «main» в task/T-1');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => r.endsWith(': false'));
for (const r of results) console.log(r);
console.log(failed.length ? `\nПровалено: ${failed.length} из ${results.length}` : `\nВсе ${results.length} проверок прошли`);
if (failed.length) process.exit(1);
