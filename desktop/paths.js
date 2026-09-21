/**
 * Где у приложения что лежит.
 *
 * Разделение одно и важное: **программа только читает, данные только пишутся**.
 * Внутри .app и Program Files писать нельзя (на macOS это ещё и ломает
 * подпись), поэтому состояние офисов, движок и настройки уходят в папку данных
 * пользователя, а ресурсы — пакеты ролей, процессы, собранный веб — остаются
 * в самой программе.
 */

const { app } = require('electron');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

/** Ресурсы программы: собранный сервер, веб и файлы, которые сервер читает. */
const resourcesDir = () => (app.isPackaged
  ? process.resourcesPath
  // Без упаковки те же ресурсы лежат рядом — их кладёт scripts/pack-desktop.mjs.
  : join(__dirname, 'resources'));

const serverEntry = () => join(resourcesDir(), 'server', 'index.mjs');
const webDir = () => join(resourcesDir(), 'web');

/**
 * Свой git. Есть только в Windows-сборке: там системного git может не быть
 * вовсе, а без него офис теряет изоляцию задач по worktree. На macOS пусто —
 * git приходит с Command Line Tools, и подменять его своим незачем.
 */
const gitBin = () => {
  const bin = join(resourcesDir(), 'git', 'cmd', 'git.exe');
  return existsSync(bin) ? bin : '';
};

/** Папка данных: состояние офисов, реестр, движок, журнал. */
const dataDir = () => app.getPath('userData');
const stateFile = () => join(dataDir(), 'office', 'state.json');
const engineDir = () => join(dataDir(), 'engine');
const logFile = () => join(dataDir(), 'server.log');

/**
 * Куда команда работает по умолчанию. Та же папка, что и у офиса из
 * исходников (`defaultRoot()` в offices.ts): человек, попробовавший оба
 * способа запуска, должен попадать в одно место, а не в два разных.
 */
const defaultProjectDir = () => join(app.getPath('home'), 'Office');

module.exports = {
  resourcesDir, serverEntry, webDir, gitBin,
  dataDir, stateFile, engineDir, logFile, defaultProjectDir,
};
