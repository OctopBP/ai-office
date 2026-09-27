/**
 * Автообновление приложения из GitHub Releases (electron-updater).
 *
 * Обновление качается само и ставится при выходе. «Поставить сейчас» —
 * только когда в офисе никто не работает: перезапуск посреди задачи обрывает
 * сессии агентов, и деньги за их работу уходят в никуда. Кто работает, знает
 * сервер офиса, поэтому перед установкой спрашиваем его, а не гадаем.
 *
 * Ошибки не показываем окнами: проверка идёт фоном раз в четыре часа, и
 * модальное окно из-за пропавшей сети было бы хуже, чем старая версия.
 * Они пишутся в журнал обновлений (paths.updateLogFile) и уходят в окно
 * состоянием `error` — показывать ли их, решает веб.
 *
 * Состояние и ответы — ровно по контракту src/shared/desktop.ts: на него
 * опирается веб, и расходиться с ним нельзя.
 */

const { app } = require('electron');
const { appendFileSync } = require('node:fs');

const paths = require('./paths');

/** Проверка раз в четыре часа: релизы выходят не чаще, а лишние запросы к GitHub упираются в лимит. */
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** Сколько ждём ответа сервера офиса перед установкой. */
const ASK_TIMEOUT_MS = 3000;

/** @type {import('../src/shared/desktop').UpdateState} */
let state = { status: 'none' };
const listeners = new Set();
/** electron-updater грузим только в собранном приложении — из исходников его может не быть в node_modules. */
let updater = null;
let timer = null;
/** Как спросить сервер офиса и как остановить его перед установкой — даёт main.js. */
let hooks = { port: () => 0, stopOffice: async () => {} };

/** Строка в журнал обновлений и в stdout — из исходников запуск идёт в терминале. */
function log(level, ...parts) {
  const text = parts.map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  const line = `${new Date().toISOString()} [${level}] ${text}\n`;
  (level === 'error' ? console.error : console.log)(`[office] обновление: ${text}`);
  try { appendFileSync(paths.updateLogFile(), line); } catch { /* журнал недоступен — хватит и stdout */ }
}

function setState(next) {
  state = next;
  for (const fn of listeners) {
    try { fn(state); } catch (err) { log('error', 'подписчик состояния упал:', err); }
  }
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

/** Подключить обновления. Из исходников ничего не проверяем: версии там нет, а релизы собраны не из этой копии. */
function init(options) {
  hooks = { ...hooks, ...options };
  if (!app.isPackaged) {
    log('info', 'приложение не упаковано — проверка обновлений выключена');
    return;
  }
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = {
    info: (...a) => log('info', ...a),
    warn: (...a) => log('warn', ...a),
    error: (...a) => log('error', ...a),
    debug: () => {},
  };

  updater.on('checking-for-update', () => setState({ status: 'checking' }));
  updater.on('update-not-available', () => setState({ status: 'none' }));
  updater.on('update-available', (info) => setState({ status: 'available', version: info.version }));
  updater.on('download-progress', (p) => setState({
    status: 'downloading',
    version: state.status === 'available' || state.status === 'downloading' ? state.version : '',
    percent: Math.max(0, Math.min(100, Math.round(p.percent ?? 0))),
  }));
  updater.on('update-downloaded', (info) => setState({
    status: 'ready', version: info.version, notes: notesText(info.releaseNotes),
  }));
  updater.on('error', (err) => {
    log('error', err);
    // Скачанное обновление ошибкой следующей проверки не отменяется: оно
    // по-прежнему поставится при выходе, и прятать это нельзя.
    if (state.status !== 'ready') setState({ status: 'error', message: errorText(err) });
  });

  void check();
  timer = setInterval(() => void check(), CHECK_EVERY_MS);
  timer.unref?.();
}

/** Проверить сейчас. Возвращает состояние после проверки — в том числе ошибку. */
async function check() {
  if (!updater) {
    setState({ status: 'error', message: 'Обновления проверяются только в собранном приложении' });
    return state;
  }
  // Уже скачано или качается — повторная проверка только собьёт шкалу.
  if (state.status === 'ready' || state.status === 'downloading' || state.status === 'checking') return state;
  try {
    await updater.checkForUpdates();
  } catch (err) {
    // Событие 'error' обычно приходит само, но не на каждую ошибку запроса.
    log('error', 'проверка не удалась:', err);
    if (state.status !== 'ready') setState({ status: 'error', message: errorText(err) });
  }
  return state;
}

/**
 * Идёт ли работа в каком-нибудь офисе. Смотрим `activity.live` из списка
 * офисов: это живые сессии — исполнители, менеджер, разговор. Задача,
 * которая просто висит на доске в работе, перезапуску не мешает, а сессия
 * мешает. Не удалось спросить — считаем, что работа идёт: обновление всё
 * равно поставится при выходе, а оборванная задача не вернётся.
 */
async function officeBusy() {
  const port = hooks.port();
  if (!port) return false;   // сервера нет — обрывать нечего
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/offices`, { signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
    const { offices } = await res.json();
    return Array.isArray(offices) && offices.some((o) => o?.activity?.live === true);
  } catch (err) {
    log('warn', 'не удалось спросить офис о работе:', err);
    return true;
  }
}

/** Перезапуститься в новую версию — если офис свободен. */
async function installNow() {
  if (state.status !== 'ready' || !updater) {
    return { ok: false, reason: 'not-ready', message: 'Обновление ещё не скачано' };
  }
  if (await officeBusy()) {
    log('info', `установка ${state.version} отложена до выхода: идут задачи`);
    return { ok: false, reason: 'busy', message: 'Идут задачи — обновление поставится при выходе из приложения' };
  }
  log('info', `ставлю ${state.version} и перезапускаюсь`);
  // Сервер останавливаем сами и дожидаемся: он дописывает состояние офисов,
  // а quitAndInstall закрывает окна без оглядки на before-quit.
  await hooks.stopOffice();
  // Тихая установка на Windows (без мастера NSIS) и запуск новой версии после.
  setImmediate(() => {
    try {
      updater.quitAndInstall(true, true);
    } catch (err) {
      // Сервер уже остановлен, и окно без него мертво: выходим, а обновление
      // поставится при выходе (autoInstallOnAppQuit).
      log('error', 'quitAndInstall не удался:', err);
      app.quit();
    }
  });
  return { ok: true };
}

const getState = () => state;

/** Подписка на смену состояния; возвращает отписку. */
function onState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { init, check, installNow, getState, onState };
