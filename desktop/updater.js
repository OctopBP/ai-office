/**
 * Обновление приложения из GitHub Releases (electron-updater). Поток ручной.
 *
 * Само приложение только проверяет, есть ли новая версия. Скачать (`download`)
 * и перезапуститься в неё (`restartNow`) — команды владельца из веба или меню:
 * обновление посреди работы не должно случаться без спроса.
 *
 * Вместе с состоянием в веб уходит признак `busy` — идёт ли в офисе работа,
 * которую оборвёт перезапуск. Кто работает, знает сервер офиса (`/api/busy`,
 * src/server/busy.ts), поэтому спрашиваем его, а не гадаем. Перезапуск
 * признак не запрещает: решает владелец, веб лишь предупреждает.
 *
 * Ошибки не показываем окнами: проверка идёт фоном раз в четыре часа, и
 * модальное окно из-за пропавшей сети было бы хуже, чем старая версия.
 * Они пишутся в журнал обновлений (paths.updateLogFile) и уходят в окно
 * фазой `error` — показывать ли их, решает веб.
 *
 * Состояние и ответы — ровно по контракту src/shared/types.ts (UpdateState,
 * UpdateCommandResult) и мосту src/shared/desktop.ts: на них опирается веб.
 */

const { app } = require('electron');
const { appendFileSync } = require('node:fs');

const paths = require('./paths');
const { t } = require('./i18n');

/** Проверка раз в четыре часа: релизы выходят не чаще, а лишние запросы к GitHub упираются в лимит. */
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** Как часто переспрашиваем занятость, пока есть что ставить: запрос локальный и дешёвый. */
const BUSY_EVERY_MS = 10 * 1000;
/** Сколько ждём ответа сервера офиса о занятости. */
const ASK_TIMEOUT_MS = 3000;

/** @type {import('../src/shared/types').UpdateState} */
let state = { phase: 'idle', busy: false };
const listeners = new Set();
/** electron-updater грузим только в собранном приложении — из исходников его может не быть в node_modules. */
let updater = null;
let timer = null;
let busyTimer = null;
/** Как спросить сервер офиса и как остановить его перед установкой — даёт main.js. */
let hooks = { port: () => 0, stopOffice: async () => {} };

/** Строка в журнал обновлений и в stdout — из исходников запуск идёт в терминале. */
function log(level, ...parts) {
  const text = parts.map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  const line = `${new Date().toISOString()} [${level}] ${text}\n`;
  (level === 'error' ? console.error : console.log)(`[office] обновление: ${text}`);
  try { appendFileSync(paths.updateLogFile(), line); } catch { /* журнал недоступен — хватит и stdout */ }
}

/**
 * Новое состояние. Признак `busy` переносится из прежнего: его меняет только
 * опрос сервера, а фазы — события electron-updater.
 */
function setState(next) {
  state = { ...next, busy: next.busy ?? state.busy };
  for (const fn of listeners) {
    try { fn(state); } catch (err) { log('error', 'подписчик состояния упал:', err); }
  }
  watchBusy();
}

/**
 * Заметки к релизу одной строкой. electron-updater отдаёт их строкой (HTML
 * из описания релиза на GitHub) или списком по версиям — веб не должен
 * разбирать оба вида.
 */
function notesText(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map((n) => n?.note ?? '').filter(Boolean).join('\n\n');
  return '';
}

const errorText = (err) => (err instanceof Error ? err.message : String(err ?? 'неизвестная ошибка'));

/**
 * Занят ли офис работой, которую оборвёт перезапуск. Сервера нет — обрывать
 * нечего. Не удалось спросить — считаем занятым: лишнее предупреждение
 * дешевле оборванной задачи.
 */
async function askBusy() {
  const port = hooks.port();
  if (!port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/busy`, { signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
    const { busy } = await res.json();
    return busy === true;
  } catch (err) {
    log('warn', 'не удалось спросить офис о занятости:', err);
    return true;
  }
}

/** Переспросить занятость и разослать, если она сменилась. */
async function refreshBusy() {
  const busy = await askBusy();
  if (busy !== state.busy) setState({ ...state, busy });
  return state;
}

/**
 * Опрос занятости идёт, только пока есть что ставить: без обновления признак
 * никому не нужен, а веб и так спросит его через getState.
 */
function watchBusy() {
  const needed = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready';
  if (needed && !busyTimer) {
    busyTimer = setInterval(() => void refreshBusy(), BUSY_EVERY_MS);
    busyTimer.unref?.();
    void refreshBusy();
  } else if (!needed && busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
}

/** Подключить обновления. Из исходников ничего не проверяем: версии там нет, а релизы собраны не из этой копии. */
function init(options) {
  hooks = { ...hooks, ...options };
  if (!app.isPackaged) {
    log('info', 'приложение не упаковано — проверка обновлений выключена');
    return;
  }
  ({ autoUpdater: updater } = require('electron-updater'));
  // Ручной поток: ни загрузки, ни установки без команды владельца.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.logger = {
    info: (...a) => log('info', ...a),
    warn: (...a) => log('warn', ...a),
    error: (...a) => log('error', ...a),
    debug: () => {},
  };

  updater.on('checking-for-update', () => setState({ phase: 'checking' }));
  updater.on('update-not-available', () => setState({ phase: 'idle' }));
  updater.on('update-available', (info) => setState({
    phase: 'available', version: info.version, notes: notesText(info.releaseNotes),
  }));
  updater.on('download-progress', (p) => setState({
    phase: 'downloading',
    version: state.version ?? '',
    percent: Math.max(0, Math.min(100, Math.round(p.percent ?? 0))),
  }));
  updater.on('update-downloaded', (info) => setState({
    phase: 'ready', version: info.version, notes: notesText(info.releaseNotes),
  }));
  updater.on('error', (err) => {
    log('error', err);
    fail(err);
  });

  void check();
  timer = setInterval(() => void check(), CHECK_EVERY_MS);
  timer.unref?.();
}

/**
 * Фаза ошибки. Скачанное обновление ошибкой следующей проверки не
 * отменяется: оно по-прежнему ждёт перезапуска, и прятать это нельзя.
 * Версию сохраняем — загрузку известной версии можно повторить.
 */
function fail(err) {
  if (state.phase === 'ready') return;
  setState({ phase: 'error', error: errorText(err), ...(state.version ? { version: state.version } : {}) });
}

/** Проверить сейчас. Возвращает состояние после проверки — в том числе ошибку. */
async function check() {
  if (!updater) {
    setState({ phase: 'error', error: t('update.err.notPackaged') });
    return state;
  }
  // Уже скачано или качается — повторная проверка только собьёт шкалу.
  if (state.phase === 'ready' || state.phase === 'downloading' || state.phase === 'checking') return state;
  try {
    await updater.checkForUpdates();
  } catch (err) {
    // Событие 'error' обычно приходит само, но не на каждую ошибку запроса.
    log('error', 'проверка не удалась:', err);
    fail(err);
  }
  return state;
}

/** Текущее состояние со свежим признаком занятости. */
async function getState() {
  if (state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready') await refreshBusy();
  return state;
}

/**
 * «Установить обновление»: начать загрузку найденной версии. Ждать конца
 * не нужно — ход загрузки уходит фазой `downloading`, итог — `ready` или `error`.
 */
async function download() {
  const canDownload = state.phase === 'available' || (state.phase === 'error' && state.version);
  if (!updater || !canDownload) {
    return { ok: false, reason: 'not-ready', message: t('update.err.notDownloadable') };
  }
  log('info', `качаю ${state.version} по команде`);
  setState({ phase: 'downloading', version: state.version, percent: 0 });
  updater.downloadUpdate().catch((err) => {
    log('error', 'загрузка не удалась:', err);
    fail(err);
  });
  return { ok: true };
}

/**
 * «Перезапустить сейчас»: поставить скачанное и перезапуститься. Занятость
 * не мешает — владельца о ней уже предупредил веб по признаку `busy`.
 */
async function restartNow() {
  if (state.phase !== 'ready' || !updater) {
    return { ok: false, reason: 'not-ready', message: t('update.err.notReady') };
  }
  log('info', `ставлю ${state.version} и перезапускаюсь${state.busy ? ' (офис занят, владелец согласился)' : ''}`);
  // Установка теперь по согласию владельца: если quitAndInstall сорвётся,
  // обновление всё равно поставится при выходе.
  updater.autoInstallOnAppQuit = true;
  // Сервер останавливаем сами и дожидаемся: он дописывает состояние офисов,
  // а quitAndInstall закрывает окна без оглядки на before-quit.
  await hooks.stopOffice();
  // Тихая установка на Windows (без мастера NSIS) и запуск новой версии после.
  setImmediate(() => {
    try {
      updater.quitAndInstall(true, true);
    } catch (err) {
      // Сервер уже остановлен, и окно без него мертво: выходим, а обновление
      // поставится при выходе (autoInstallOnAppQuit выше).
      log('error', 'quitAndInstall не удался:', err);
      app.quit();
    }
  });
  return { ok: true };
}

/** Подписка на смену состояния; возвращает отписку. */
function onState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { init, check, getState, download, restartNow, refreshBusy, onState };
