/**
 * Разовый импорт уже написанных документов проекта в библиотеку офиса
 * (src/server/docs.ts).
 *
 * Запуск:
 *
 *   npm run import:docs -- <офис> [директория]
 *
 *   <офис>        файл состояния офиса, например
 *                 ".office/offices/o-2.json" или
 *                 "~/Library/Application Support/AI Office/.office/offices/o-2.json";
 *                 библиотека лежит рядом с ним — папка o-2.docs/
 *   [директория]  корень проекта, в котором лежит docs/; по умолчанию — текущая
 *
 * Что заносится:
 *   docs/design/<тема>/spec.md  → документация ('documentation');
 *   docs/<роль>/<T-N>/**.md     → рабочие материалы задачи T-N ('working'),
 *                                 сразу в архиве: задачи давно закрыты.
 *   Папка задачи внутри docs/design (docs/design/T-312/) — тоже материал
 *   задачи, а не документация.
 * Название — первый заголовок файла, описание — первый абзац, автор — 'import'.
 *
 * Повторный запуск дублей не плодит: документ помнит путь своего файла
 * относительно корня проекта (поле source, например docs/design/rules/spec.md),
 * и уже занесённые файлы пропускаются.
 *
 * Скрипт пишет прямо в папку библиотеки. Работающий сервер увидит документы при
 * следующем чтении (оглавление читается с диска каждый раз), но события doc.*
 * открытым окнам не придут — обновите окно «Документы».
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { importFromDir, type ImportResult } from '../src/server/docs';
import { expandHome } from '../src/server/offices';
import { getOffice } from '../src/server/state';

const TASK_DIR = /^T-\d+$/;

function usage(message: string): never {
  console.error(`${message}\n\nЗапуск: npm run import:docs -- <файл состояния офиса> [корень проекта]`);
  process.exit(1);
}

function dirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => !name.startsWith('.') && statSync(join(path, name)).isDirectory())
    .sort();
}

const [officeArg, projectArg] = process.argv.slice(2);
if (!officeArg) usage('Не указан офис.');
const stateFile = resolve(expandHome(officeArg));
if (!/\.json$/i.test(stateFile)) usage(`Офис задаётся файлом состояния .json: ${stateFile}`);
if (!existsSync(stateFile)) usage(`Нет файла состояния офиса: ${stateFile}`);
const project = resolve(expandHome(projectArg ?? '.'));
const docsRoot = join(project, 'docs');
if (!existsSync(docsRoot)) usage(`Нет папки docs в ${project}`);

// Офис нужен только ради пути к библиотеке. Состояние не поднимаем (restore()
// не зовём) и сразу выгружаем: выгруженный офис не пишет в свой файл. Иначе
// строка ленты о каждом документе сохранила бы пустую заготовку поверх доски
// офиса, а файлом в это время может владеть работающий сервер.
const state = getOffice(basename(stateFile).replace(/\.json$/i, ''));
state.setStateFile(stateFile);
state.retire();

const total: ImportResult = { created: [], skipped: [] };
function add(r: ImportResult): void {
  total.created.push(...r.created);
  total.skipped.push(...r.skipped);
}

// Документация: спеки тем.
const design = join(docsRoot, 'design');
const specs = dirs(design)
  .filter((name) => !TASK_DIR.test(name) && existsSync(join(design, name, 'spec.md')))
  .map((name) => join(name, 'spec.md'));
if (specs.length) add(importFromDir(state, design, 'documentation', { base: project, files: specs }));
console.log(`документация: ${specs.length} спек`);

// Материалы задач: docs/<роль>/<T-N>/.
let tasks = 0;
for (const role of dirs(docsRoot)) {
  for (const task of dirs(join(docsRoot, role)).filter((name) => TASK_DIR.test(name))) {
    tasks++;
    add(importFromDir(state, join(docsRoot, role, task), 'working', { base: project, archived: true, taskId: task }));
  }
}
console.log(`материалы задач: ${tasks} папок`);

console.log(`занесено ${total.created.length}, уже были ${total.skipped.length} → ${state.docsDir()}`);
if (total.created.length) console.log(total.created.join(' '));
