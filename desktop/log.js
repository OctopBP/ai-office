/**
 * Журнал главного процесса.
 *
 * У собранного приложения нет терминала: всё, что main говорил в stdout,
 * пропадало, и поломку запуска на чужой машине разбирать было не по чему —
 * человек видел чёрное окно, а мы ничего (T-187). Поэтому console.log и
 * console.error главного процесса дублируются в файл в app.getPath('logs'),
 * рядом с журналом сервера. Файл открывается дозаписью: прошлые запуски
 * остаются, а чтобы журнал не рос вечно, слишком большой при старте
 * переименовывается в .old.
 */

const { appendFileSync, mkdirSync, renameSync, statSync } = require('node:fs');
const { dirname } = require('node:path');
const { format } = require('node:util');

const paths = require('./paths');

const LIMIT = 5 * 1024 * 1024;

/** Длинный журнал — в .old, новый начинается с нуля. Одна копия, не ротация. */
function trim(file) {
  try {
    if (statSync(file).size > LIMIT) renameSync(file, `${file}.old`);
  } catch { /* файла ещё нет */ }
}

let ready = false;

function write(level, args) {
  if (!ready) return;
  const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`;
  try { appendFileSync(paths.mainLogFile(), line); } catch { /* журнал недоступен — остаётся stdout */ }
}

/** Подключить журнал. Зовётся один раз, когда app уже знает свои пути. */
function init() {
  try {
    mkdirSync(dirname(paths.mainLogFile()), { recursive: true });
    trim(paths.mainLogFile());
    trim(paths.logFile());
    ready = true;
  } catch { /* папка журналов недоступна — пишем только в stdout */ }
  for (const [method, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write(level, args);
    };
  }
}

module.exports = { init };
