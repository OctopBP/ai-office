/**
 * Приложение: окно и сервер офиса.
 *
 * Порядок запуска один и тот же и на macOS, и на Windows: окно ожидания →
 * сервер на постоянном порту
 * локальной петли (pickPort в server.js) → окно офиса на этом порту. Пока сервер не ответил, окна
 * офиса не существует: белый экран с неработающим сокетом объясняет человеку
 * меньше, чем строка «Запускаю офис…».
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } = require('electron');
const { existsSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const paths = require('./paths');
const server = require('./server');
const updater = require('./updater');
const log = require('./log');
const { t } = require('./i18n');

/**
 * Имя и идентификатор, под которыми система показывает уведомления. Из
 * исходников Electron назвался бы «Electron»; собранное приложение берёт имя
 * из productName, но задать явно дешевле, чем выяснять, кто победил.
 * AppUserModelId на Windows обязателен: без него уведомления не показываются
 * вовсе. Совпадает с appId сборки (builder.config.js) — под ним установщик
 * регистрирует ярлык. Из исходников ярлыка нет, и Windows узнаёт процесс
 * только по пути к исполняемому файлу.
 */
const APP_ID = 'dev.aioffice.app';
app.setName('AI Office');
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

// Журнал — до всего остального: поломку запуска на чужой машине иначе не по
// чему разбирать (T-187).
log.init();
console.log(`[office] запуск ${app.getVersion()}, ${process.platform} ${process.arch}, ${require('node:os').release()}, Electron ${process.versions.electron}`);

/**
 * Видеокарта. Если в прошлый раз её процесс падал (отметка gpuOffFile) или
 * ускорение выключено руками (OFFICE_DISABLE_GPU=1), запускаемся без него:
 * упавший GPU-процесс на Windows — это чёрное окно, а без ускорения окно
 * рисуется программно. 3D-офис без WebGL веб заменяет пояснением, остальное
 * работает. Решается только до готовности приложения.
 */
const gpuOff = process.env.OFFICE_DISABLE_GPU === '1' || existsSync(paths.gpuOffFile());
if (gpuOff) {
  console.log(`[office] аппаратное ускорение выключено${process.env.OFFICE_DISABLE_GPU === '1' ? ' (OFFICE_DISABLE_GPU)' : ` (видеокарта падала, отметка ${paths.gpuOffFile()})`}`);
  app.disableHardwareAcceleration();
}

/** Одно приложение — один офис: второй запуск поднимает уже открытое окно. */
if (!app.requestSingleInstanceLock()) app.quit();

let bootWindow = null;
let mainWindow = null;
let child = null;
let port = 0;
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
process.on('uncaughtException', (err) => {
  console.error('[office] исключение в главном процессе:', err);
  void showFailure(String(err?.stack ?? err));
});

/** Экран ошибки уже показан: вторая причина обычно следствие первой. */
let failed = false;

/**
 * Запуск сорвался — показать это словами, а не чёрным окном. Окно ожидания
 * становится экраном ошибки: причина, папка журналов, «перезапустить» и
 * «выход». Окно офиса, если было, закрывается — пустое оно только сбивает.
 */
async function showFailure(reason) {
  console.error(`[office] экран ошибки: ${reason}`);
  if (failed || !app.isReady()) return;
  failed = true;
  if (!bootWindow) {
    createBootWindow();
    await new Promise((done) => bootWindow.webContents.once('did-finish-load', done));
  }
  bootWindow.setResizable(true);
  bootWindow.setSize(620, 420);
  bootWindow.center();
  bootWindow.webContents.send('boot:failure', {
    title: t('fail.title'),
    reason,
    hint: t('fail.hint'),
    logs: paths.logsDir(),
    open: t('fail.openLogs'),
    retry: t('fail.retry'),
    quit: t('fail.quit'),
  });
  raise(bootWindow);
  if (mainWindow) {
    const broken = mainWindow;
    mainWindow = null;
    broken.destroy();
  }
}

ipcMain.on('boot:failure-action', (_event, action) => {
  if (action === 'logs') void shell.openPath(paths.logsDir());
  else if (action === 'retry') { app.relaunch(); app.quit(); }
  else if (action === 'quit') app.quit();
});

/**
 * Сколько ждать, что веб нарисовал хоть что-то. Пустой #root через столько
 * секунд — значит, скрипты не загрузились или упали: раньше это и было
 * «чёрное окно» без единого слова (T-187).
 */
const BLANK_SEC = 20;
/** Сколько ждать, что страница офиса вообще загрузилась. */
const LOAD_SEC = 45;

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
    webPreferences: { spellcheck: false, preload: join(__dirname, 'office-preload.js') },
  });
  watchMainWindow(mainWindow);
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
  // Мигание кнопки на панели задач (setBadge) — призыв вернуться; вернулись — хватит.
  mainWindow.on('focus', () => mainWindow?.flashFrame(false));
  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * Сторож окна офиса: всё, из-за чего оно осталось бы пустым, превращается в
 * экран ошибки, а ошибки страницы — в строки журнала main.
 */
function watchMainWindow(win) {
  const contents = win.webContents;
  let loadTimer = setTimeout(() => {
    void showFailure(t('fail.timeout', { sec: LOAD_SEC }));
  }, LOAD_SEC * 1000);
  let blankTimer = null;
  const clear = () => { clearTimeout(loadTimer); clearTimeout(blankTimer); };
  win.once('closed', clear);

  contents.on('did-start-loading', () => clearTimeout(blankTimer));
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 — переход прерван новым (перезагрузка, смена адреса), это не сбой.
    if (!isMainFrame || code === -3) return;
    clear();
    console.error(`[office] страница не загрузилась: ${description} (${code}) ${url}`);
    void showFailure(t('fail.load', { error: description, code }));
  });
  contents.on('did-finish-load', () => {
    clearTimeout(loadTimer);
    clearTimeout(blankTimer);
    blankTimer = setTimeout(async () => {
      if (win.isDestroyed()) return;
      let filled = 0;
      try {
        filled = await contents.executeJavaScript("document.getElementById('root')?.childElementCount ?? 0");
      } catch (err) {
        console.error('[office] не удалось проверить страницу:', err);
        return;
      }
      if (!filled) void showFailure(t('fail.blank', { sec: BLANK_SEC }));
    }, BLANK_SEC * 1000);
  });
  contents.on('render-process-gone', (_event, details) => {
    console.error(`[office] процесс окна завершился: ${details.reason} (код ${details.exitCode})`);
    if (details.reason === 'clean-exit') return;
    clear();
    void showFailure(t('fail.renderer', { reason: `${details.reason} (${details.exitCode})` }));
  });
  // Ошибки и предупреждения страницы — в журнал: без них пустое окно не
  // объяснить. Сигнатура события — объектом (Electron 35+).
  contents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event;
    if (level !== 'error' && level !== 'warning') return;
    console.log(`[web ${level}] ${message}${sourceId ? ` (${sourceId}:${lineNumber})` : ''}`);
  });
}

/** Сервер упал сам, не по нашей команде: окно офиса без него мертво. */
function watchChild(started) {
  started.once('exit', (code, signal) => {
    if (stopping || started !== child) return;
    console.error(`[office] сервер завершился: ${signal ?? `код ${code}`}`);
    void showFailure(t('fail.serverExit', { code: signal ?? code }));
  });
}

/** Чем запускать сервер: свой git и язык терминального журнала. */
const serverOptions = () => ({
  gitBin: paths.gitBin(),
  lang: app.getLocale().startsWith('ru') ? 'ru' : 'en',
});

/** Поднять сервер и показать офис. */
async function startOffice() {
  say('Запускаю офис…');
  try {
    const started = await server.start(serverOptions());
    port = started.port;
    child = started.child;
    watchChild(child);
  } catch (err) {
    await showFailure(`${t('fail.serverStart')}\n${err.message}`);
    return;
  }
  createMainWindow();
  updater.init({
    port: () => port,
    // Перед установкой обновления сервер гасим сами: так он успевает
    // дописать состояние, а before-quit потом не ждёт его второй раз.
    stopOffice: async () => {
      stopping = true;
      await server.stop(child);
      child = null;
    },
  });
}

/** Перезапуск сервера: порт обычно тот же, окно всё равно перезагружается на него. */
async function restartOffice() {
  if (!mainWindow) return;
  stopping = true;
  await server.stop(child);
  stopping = false;
  try {
    const started = await server.start(serverOptions());
    port = started.port;
    child = started.child;
    watchChild(child);
  } catch (err) {
    await showFailure(`${t('fail.serverStart')}\n${err.message}`);
    return;
  }
  mainWindow?.loadURL(`http://127.0.0.1:${port}/`);
}

/**
 * «Проверить обновления…» из меню. Веб показывает состояние сам, но меню
 * работает и без него, поэтому итог проверки говорим здесь же. Ошибку — нет:
 * она уже в журнале обновлений и в состоянии окна, а модальное окно из-за
 * пропавшей сети хуже, чем тишина.
 */
async function updatesFromMenu() {
  const state = await updater.check();
  const version = app.getVersion();
  if (state.status === 'none') {
    await dialog.showMessageBox({
      type: 'info', title: 'Обновления', message: 'Установлена последняя версия.', detail: `AI Office ${version}`,
    });
  } else if (state.status === 'available' || state.status === 'downloading') {
    await dialog.showMessageBox({
      type: 'info', title: 'Обновления', message: `Нашлась версия ${state.version}.`,
      detail: 'Она скачивается и поставится при выходе из приложения.',
    });
  } else if (state.status === 'ready') {
    const { response } = await dialog.showMessageBox({
      type: 'question', title: 'Обновления', message: `Версия ${state.version} скачана.`,
      detail: 'Перезапустить приложение сейчас? Иначе обновление поставится при выходе.',
      buttons: ['Перезапустить', 'Позже'], defaultId: 0, cancelId: 1,
    });
    if (response !== 0) return;
    const result = await updater.installNow();
    if (!result.ok) {
      await dialog.showMessageBox({ type: 'info', title: 'Обновления', message: result.message });
    }
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const office = {
    label: 'Офис',
    submenu: [
      { label: 'Проверить обновления…', click: () => void updatesFromMenu() },
      { label: 'Перезапустить офис', click: () => void restartOffice() },
      { type: 'separator' },
      { label: 'Папка данных', click: () => shell.openPath(paths.dataDir()) },
      { label: 'Журнал сервера', click: () => shell.openPath(paths.logFile()) },
      { label: 'Папка журналов', click: () => shell.openPath(paths.logsDir()) },
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

/**
 * Поднять окно: из свёрнутого, из-за других окон и, на macOS, из другого
 * приложения. window.focus() из страницы этого не умеет — система отдаёт
 * фокус только процессу, который сам попросил.
 */
function raise(window) {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
}

app.on('second-instance', () => raise(mainWindow ?? bootWindow));

/** Команды моста принимаем только от окна офиса и только со своего сервера. */
const fromOffice = (event) =>
  mainWindow !== null
  && event.sender === mainWindow.webContents
  && event.senderFrame?.url.startsWith(`http://127.0.0.1:${port}/`);

/** Последнее показанное число — чтобы мигать на Windows только при росте. */
let badge = 0;

/**
 * Значок ожидающего владельца. На macOS — число на иконке в доке. На Windows
 * числа на кнопке панели задач нет, есть наложение-картинка: рисуем кружок с
 * цифрой сами и вдобавок мигаем кнопкой, если ожидающего стало больше, а окно
 * не в фокусе. Ноль снимает и то и другое.
 */
function setBadge(count) {
  const n = Math.max(0, Math.min(999, Math.floor(count)));
  const grew = n > badge;
  badge = n;
  if (process.platform === 'darwin') {
    app.dock?.setBadge(n ? String(n) : '');
    return;
  }
  if (process.platform !== 'win32') {
    app.setBadgeCount(n);
    return;
  }
  if (!mainWindow) return;
  mainWindow.setOverlayIcon(n ? badgeIcon(n) : null, n ? `Ждут ответа: ${n}` : '');
  if (!n) mainWindow.flashFrame(false);
  else if (grew && !mainWindow.isFocused()) mainWindow.flashFrame(true);
}

/** Цифры 3×5 для наложения: шрифтов в main нет, а картинка нужна растровая. */
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

/** Красный кружок с числом, 32×32 при масштабе 2 — 16×16 точек на панели задач. */
function badgeIcon(n) {
  const size = 32;
  const text = n > 9 ? '9+' : String(n);
  const scale = text.length === 1 ? 4 : 3;
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b) => {
    const i = (y * size + x) * 4;
    // createFromBitmap ждёт BGRA.
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255;
  };
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - c) ** 2 + (y - c) ** 2 <= (size / 2) ** 2) put(x, y, 0xd9, 0x30, 0x25);
    }
  }
  const w = (text.length * 4 - 1) * scale;
  const left = Math.round((size - w) / 2);
  const top = Math.round((size - 5 * scale) / 2);
  [...text].forEach((ch, k) => {
    GLYPHS[ch].forEach((row, gy) => {
      [...row].forEach((bit, gx) => {
        if (bit !== '1') return;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            put(left + (k * 4 + gx) * scale + dx, top + gy * scale + dy, 255, 255, 255);
          }
        }
      });
    });
  });
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

/**
 * Копия localStorage окна офиса в папке данных. Порт постоянный (pickPort в
 * server.js), но если он занят, офис встаёт на запасной — а там другой origin
 * и пустое хранилище. Копия подставляет настройки на любом порту, так что
 * тема, графика и уведомления не зависят от того, какой порт достался.
 */
const STORAGE_LIMIT = 2 * 1024 * 1024;

function readWebStorage() {
  try {
    const data = JSON.parse(readFileSync(paths.webStorageFile(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

ipcMain.on('office:storage-load', (event) => {
  event.returnValue = fromOffice(event) ? readWebStorage() : {};
});
ipcMain.on('office:storage-save', (event, data) => {
  if (!fromOffice(event) || !data || typeof data !== 'object') return;
  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') clean[key] = value;
  }
  const text = JSON.stringify(clean);
  if (text.length > STORAGE_LIMIT) return;
  // Через временный файл: оборванная запись не должна стоить всех настроек.
  const file = paths.webStorageFile();
  try {
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.error('[office] копия настроек окна не записалась:', err);
  }
});

ipcMain.on('office:focus', (event) => { if (fromOffice(event)) raise(mainWindow); });
ipcMain.on('office:badge', (event, count) => {
  if (fromOffice(event) && Number.isFinite(count)) setBadge(count);
});

// Обновление приложения: состояние — в окно офиса, команды — только от него.
updater.onState((state) => mainWindow?.webContents.send('office:update', state));
ipcMain.handle('office:update-state', (event) => (fromOffice(event) ? updater.getState() : null));
ipcMain.handle('office:update-check', (event) => (fromOffice(event) ? updater.check() : null));
ipcMain.handle('office:update-install', (event) => (fromOffice(event)
  ? updater.installNow()
  : { ok: false, reason: 'not-ready', message: 'Команда не из окна офиса' }));

/**
 * Упавшая видеокарта — частая причина чёрного окна на Windows (старый или
 * виртуальный драйвер). Ставим отметку: следующий запуск пойдёт без
 * аппаратного ускорения, а причина останется в журнале.
 */
app.on('child-process-gone', (_event, details) => {
  console.error(`[office] процесс ${details.type} завершился: ${details.reason} (код ${details.exitCode})`);
  if (details.type !== 'GPU' || details.reason === 'clean-exit' || gpuOff) return;
  try { writeFileSync(paths.gpuOffFile(), `${new Date().toISOString()} ${details.reason} ${details.exitCode}\n`); } catch { /* отметим в другой раз */ }
});

app.whenReady().then(async () => {
  console.log('[office] видеокарта:', JSON.stringify(app.getGPUFeatureStatus()));
  buildMenu();
  createBootWindow();
  // Дожидаемся загрузки страницы ожидания: строки состояния, отправленные
  // раньше, ушли бы в пустоту.
  await new Promise((done) => bootWindow.webContents.once('did-finish-load', done));
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
