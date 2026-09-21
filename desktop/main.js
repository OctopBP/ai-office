/**
 * Приложение: окно, движок, сервер офиса.
 *
 * Порядок запуска один и тот же и на macOS, и на Windows: окно ожидания →
 * поиск движка (и, если надо, его загрузка) → сервер на свободном порту
 * локальной петли → окно офиса на этом порту. Пока сервер не ответил, окна
 * офиса не существует: белый экран с неработающим сокетом объясняет человеку
 * меньше, чем строка «Запускаю офис…».
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { join } = require('node:path');

const paths = require('./paths');
const engine = require('./engine');
const server = require('./server');

/** Одно приложение — один офис: второй запуск поднимает уже открытое окно. */
if (!app.requestSingleInstanceLock()) app.quit();

let bootWindow = null;
let mainWindow = null;
let child = null;
let port = 0;
/** Чем считаем. Пусто — движка нет; офис об этом скажет проверкой окружения. */
let claudeBin = '';
/** Сервер останавливаем мы сами — его выход не поломка. */
let stopping = false;

const icon = join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

/**
 * Строка состояния в окно ожидания — и та же строка в stdout: запуск из
 * исходников идёт в терминале, и видеть ход загрузки там надо не меньше.
 */
function say(text, extra = {}) {
  if (!extra.progress) console.log(`[office] ${text}`);
  bootWindow?.webContents.send('boot:status', { text, ...extra });
}

// Ошибку в main видно только так: окна к этому моменту может не быть вовсе.
process.on('unhandledRejection', (err) => console.error('[office] сбой запуска:', err));

function createBootWindow() {
  bootWindow = new BrowserWindow({
    width: 520, height: 300, resizable: false, maximizable: false, minimizable: false,
    title: 'AI Office', icon, show: false, backgroundColor: '#111214',
    webPreferences: { preload: join(__dirname, 'preload.js') },
  });
  bootWindow.removeMenu();
  bootWindow.loadFile(join(__dirname, 'boot.html'));
  bootWindow.once('ready-to-show', () => bootWindow?.show());
  bootWindow.on('closed', () => { bootWindow = null; });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360, height: 900, minWidth: 960, minHeight: 640,
    title: 'AI Office', icon, show: false, backgroundColor: '#0d0e11',
    webPreferences: { spellcheck: false },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    bootWindow?.close();
  });
  // Внешние ссылки — в системный браузер: окно офиса не навигатор, и уехать
  // из него на сторонний сайт значит потерять офис.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/** Чем запускать сервер: движок, свой git и язык терминального журнала. */
const serverOptions = () => ({
  claudeBin,
  gitBin: paths.gitBin(),
  lang: app.getLocale().startsWith('ru') ? 'ru' : 'en',
});

/** Поиск движка с показом результата в окне ожидания. */
async function ensureEngine() {
  say('Ищу движок агентов…');
  claudeBin = engine.find();
  if (claudeBin) { say(`Движок на месте: ${claudeBin}`); return; }

  // Ответ человека ждём событием, а не диалогом: диалог поверх окна ожидания
  // на Windows иногда уезжает за него, и приложение выглядит зависшим.
  const choice = await new Promise((done) => {
    ipcMain.once('boot:engine-choice', (_event, value) => done(value));
    bootWindow?.webContents.send('boot:need-engine', { pkg: engine.platformPackage() });
  });
  if (choice !== 'install') { say('Продолжаю без движка'); return; }

  try {
    // Размера архива npm не сообщает, поэтому считаем скачанное, а не проценты:
    // шкала без итога врёт, а мегабайты — нет.
    claudeBin = await engine.install((share, bytes) => {
      const mb = Math.round(bytes / 1024 / 1024);
      say(`Скачиваю движок: ${mb} МБ`, { progress: share });
    });
    say('Движок установлен', { progress: 1 });
  } catch (err) {
    say(`Движок не поставился: ${err.message}`, { progress: 0, failed: true });
  }
}

/** Поднять сервер и показать офис. */
async function startOffice() {
  say('Запускаю офис…');
  try {
    const started = await server.start(serverOptions());
    port = started.port;
    child = started.child;
    child.once('exit', (code) => {
      // Сервер упал сам, не по нашей команде: окно офиса без него мертво.
      if (!stopping && mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'error', title: 'Офис остановился',
          message: `Сервер офиса завершился (код ${code}).`,
          detail: 'Что случилось — в журнале сервера.',
          buttons: ['Открыть журнал', 'Закрыть'], defaultId: 0,
        }).then(({ response }) => { if (response === 0) shell.openPath(paths.logFile()); });
      }
    });
  } catch (err) {
    const { response } = await dialog.showMessageBox({
      type: 'error', title: 'Офис не запустился', message: err.message,
      detail: `Журнал: ${paths.logFile()}`,
      buttons: ['Открыть журнал', 'Выход'], defaultId: 0,
    });
    if (response === 0) await shell.openPath(paths.logFile());
    app.quit();
    return;
  }
  createMainWindow();
}

/** Перезапуск сервера: порт новый, окно перезагружается на него. */
async function restartOffice() {
  if (!mainWindow) return;
  stopping = true;
  await server.stop(child);
  stopping = false;
  const started = await server.start(serverOptions());
  port = started.port;
  child = started.child;
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

/** Движок по требованию из меню — и когда его нет, и когда хочется свежий. */
async function engineFromMenu() {
  const found = engine.find();
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'Движок агентов',
    message: found ? `Движок на месте:\n${found}` : 'Движок не установлен.',
    detail: found
      ? 'Можно скачать заново — например, если он повреждён.'
      : `Приложение скачает ${engine.platformPackage()} из npm — около 310 МБ.`,
    buttons: [found ? 'Скачать заново' : 'Скачать', 'Отмена'], defaultId: found ? 1 : 0, cancelId: 1,
  });
  if (response !== 0) return;
  try {
    claudeBin = await engine.install();
    await dialog.showMessageBox({
      type: 'info', title: 'Движок агентов', message: 'Движок установлен.',
      detail: 'Чтобы офис начал им считать, перезапустите его: меню «Офис» → «Перезапустить офис».',
    });
  } catch (err) {
    dialog.showErrorBox('Движок не поставился', err.message);
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const office = {
    label: 'Офис',
    submenu: [
      { label: 'Движок агентов…', click: () => void engineFromMenu() },
      { label: 'Перезапустить офис', click: () => void restartOffice() },
      { type: 'separator' },
      { label: 'Папка данных', click: () => shell.openPath(paths.dataDir()) },
      { label: 'Журнал сервера', click: () => shell.openPath(paths.logFile()) },
      { type: 'separator' },
      isMac ? { role: 'quit', label: 'Выход из AI Office' } : { role: 'quit', label: 'Выход' },
    ],
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu', label: 'AI Office' }] : []),
    office,
    { role: 'editMenu', label: 'Правка' },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить окно' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный размер' },
        { role: 'zoomIn', label: 'Крупнее' },
        { role: 'zoomOut', label: 'Мельче' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
      ],
    },
    { role: 'windowMenu', label: 'Окно' },
  ]));
}

app.on('second-instance', () => {
  const window = mainWindow ?? bootWindow;
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.whenReady().then(async () => {
  buildMenu();
  createBootWindow();
  // Дожидаемся загрузки страницы ожидания: строки состояния, отправленные
  // раньше, ушли бы в пустоту.
  await new Promise((done) => bootWindow.webContents.once('did-finish-load', done));
  await ensureEngine();
  await startOffice();
});

app.on('activate', () => {
  if (!mainWindow && port) createMainWindow();
});

app.on('window-all-closed', () => {
  // На macOS приложение живёт без окон, но офис — не редактор: без окна он
  // только тратит лимит. Закрыли окно — закрыли офис, на обеих системах.
  app.quit();
});

app.on('before-quit', async (event) => {
  if (stopping || !child) return;
  // Даём серверу дописать состояние офисов: иначе доска откатится к
  // последнему сохранению, а работа исполнителей за последние секунды пропадёт.
  event.preventDefault();
  stopping = true;
  await server.stop(child);
  child = null;
  app.quit();
});

ipcMain.handle('boot:open-log', () => shell.openPath(paths.logFile()));
