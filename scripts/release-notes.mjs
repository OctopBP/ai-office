#!/usr/bin/env node
// Раздел «## Что нового» для тела релиза на GitHub (.github/workflows/release.yml).
//
// Офис при выпуске ставит аннотированный тег: первая строка — «<цель> <версия>»,
// дальше — заметки, которые владелец согласовал (src/server/releases.ts, узел
// `tag`). Их и берём: тег уезжает в CI вместе со сборкой, отдельный файл с
// заметками мог бы разойтись с тем, что реально выпущено.
//
// Тег поставлен руками (лёгкий или с сообщением без заметок) — раздел не
// пропадает, а заполняется коммитами с прошлого тега по первой родительской
// линии: это ровно влитые задачи и выпуски, без внутренних коммитов веток.
//
//   node scripts/release-notes.mjs v0.5.0 > body.md
import { execFileSync } from 'node:child_process';

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error('нужен тег: node scripts/release-notes.mjs <тег>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const tryGit = (...args) => {
  try { return git(...args); } catch { return null; }
};

/** Заметки из аннотации тега без строки-заголовка; у лёгкого тега — пусто. */
function tagNotes(name) {
  const ref = `refs/tags/${name}`;
  if (tryGit('cat-file', '-t', ref)?.trim() !== 'tag') return '';
  // %(contents:body) — всё после первого абзаца, то есть без «Приложение 0.5.0»;
  // подпись тега, если она есть, туда не входит.
  const body = git('for-each-ref', ref, '--format=%(contents:body)');
  // Офис разделяет пункты пустыми строками — в markdown это «рыхлый» список
  // с лишними отступами; пустые строки между пунктами убираем.
  return body
    .replace(/\r/g, '')
    .replace(/\n{2,}(?=\s*[-*] )/g, '\n')
    .trim();
}

/** Запасной список: коммиты с прошлого тега `v*` до этого, без слияний и выпусков. */
function commitsSincePrevious(name) {
  const prev = tryGit('describe', '--tags', '--abbrev=0', '--match', 'v*', `${name}^`)?.trim();
  const range = prev ? `${prev}..${name}` : name;
  const log = git('log', '--first-parent', '--no-merges', '--max-count=100', '--format=%s', range);
  const lines = log.split('\n').map((s) => s.trim()).filter(Boolean)
    // Коммит «Выпуск …» (раньше — «Версия …») ставит сам офис — это не
    // изменение, а сам выпуск.
    .filter((s) => !/^(Выпуск |Версия \d)/u.test(s));
  const list = lines.map((s) => `- ${s}`).join('\n');
  if (!list) return prev ? `Изменений с ${prev} нет.` : 'Первый выпуск.';
  return prev ? `Изменения с ${prev}:\n\n${list}` : list;
}

const notes = tagNotes(tag) || commitsSincePrevious(tag);
process.stdout.write(`## Что нового\n\n${notes}\n\n`);
