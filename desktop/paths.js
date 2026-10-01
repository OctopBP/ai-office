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

/** Папка данных: состояние офисов, реестр, движок. */
const dataDir = () => app.getPath('userData');
const stateFile = () => join(dataDir(), 'office', 'state.json');
const engineDir = () => join(dataDir(), 'engine');
/**
 * Журналы — в системной папке журналов (app.getPath('logs')): на Windows это
 * %APPDATA%\AI Office\logs, на macOS ~/Library/Logs/AI Office. Путь к ним
 * показывает экран ошибки — его человек и пришлёт, если окно не открылось.
 */
const logsDir = () => app.getPath('logs');
const logFile = () => join(logsDir(), 'server.log');
/** Журнал главного процесса (log.js): запуск, движок, окно, видеокарта. */
const mainLogFile = () => join(logsDir(), 'main.log');
/** Журнал автообновления (updater.js): у main своего терминала в собранном приложении нет. */
const updateLogFile = () => join(dataDir(), 'updates.log');
/** Порт, на котором офис живёт от запуска к запуску (`pickPort` в server.js). */
const portFile = () => join(dataDir(), 'port.json');
/** Копия localStorage окна офиса (`office:storage-*` в main.js). */
const webStorageFile = () => join(dataDir(), 'web-storage.json');
/**
 * Отметка «видеокарта падала»: при следующем запуске аппаратное ускорение
 * выключается (main.js). Удалить файл — вернуть ускорение.
 */
const gpuOffFile = () => join(dataDir(), 'gpu-off');

/**
 * Куда команда работает по умолчанию. Та же папка, что и у офиса из
 * исходников (`defaultRoot()` в offices.ts): человек, попробовавший оба
 * способа запуска, должен попадать в одно место, а не в два разных.
 */
const defaultProjectDir = () => join(app.getPath('home'), 'Office');

module.exports = {
  resourcesDir, serverEntry, webDir, gitBin,
  dataDir, stateFile, engineDir, logsDir, logFile, mainLogFile, updateLogFile, portFile, webStorageFile, gpuOffFile,
  defaultProjectDir,
};
