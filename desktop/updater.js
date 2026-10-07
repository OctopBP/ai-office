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
 *
 * Канал обновлений (stable/beta/alpha) хранится в paths.updatePrefsFile и
 * применяется к electron-updater до первой проверки (channel.js, спека
 * docs/design/release-channels/spec.md §7.1–7.4, §7.7). Смена канала идёт
 * через одну точку входа — applyChannelChange, откат с беты — через downgrade.
 * Диалоги согласия и отката показывает главный процесс, а не окно: веб их
 * обойти не может.
 */

const { app, dialog } = require('electron');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');

const paths = require('./paths');
const channels = require('./channel');
const { backupBeforeDowngrade } = require('./backup');
const { t } = require('./i18n');

/**
 * Версия текста согласия на тестовый канал (§7.7). Поменялся текст — подними
 * число: при следующем запуске на бете диалог покажется снова.
 */
const CONSENT_TEXT = 1;

/** Проверка раз в четыре часа: релизы выходят не чаще, а лишние запросы к GitHub упираются в лимит. */
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** Как часто переспрашиваем занятость, пока есть что ставить: запрос локальный и дешёвый. */
const BUSY_EVERY_MS = 10 * 1000;
/** Сколько ждём ответа сервера офиса о занятости. */
const ASK_TIMEOUT_MS = 3000;
/**
 * Сколько «Перезапустить сейчас» ждёт, пока Squirrel.Mac заберёт скачанный zip
 * у electron-updater и проверит подпись. Обычно секунды; минуты — значит,
 * что-то не так, и гасить сервер ради установки, которой не будет, нельзя.
 */
const NATIVE_WAIT_MS = 3 * 60 * 1000;
/** Сколько ждём выхода после quitAndInstall, прежде чем выйти обычным путём. */
const QUIT_GRACE_MS = 15 * 1000;

/** @type {import('../src/shared/types').UpdateState} */
let state = { phase: 'idle', busy: false };
const listeners = new Set();
/** electron-updater грузим только в собранном приложении — из исходников его может не быть в node_modules. */
let updater = null;
let timer = null;
let busyTimer = null;
/** Настройки канала из файла; читаются при первом обращении — до него app может быть не готов. */
let prefs = null;
/**
 * Как спросить сервер офиса, как остановить его перед установкой, к какому
 * окну привязать диалоги и что сделать после смены канала — даёт main.js.
 */
let hooks = { port: () => 0, stopOffice: async () => {}, window: () => null, onChannel: () => {} };
/** Идёт откат: вторая команда отката или смены канала его не перебивает. */
let downgrading = false;
/** Идёт перезапуск в новую версию: повторные нажатия его не запускают заново. */
let restarting = false;
/**
 * Squirrel.Mac (нативный обновлятор Electron на macOS) у себя тоже скачал и
 * проверил обновление. Только после этого quitAndInstall что-то делает, и
 * только тогда обновление ставится при выходе. До T-435 сюда не доходило:
 * см. комментарий в init.
 */
let nativeReady = false;
/** Последняя ошибка Squirrel.Mac — её отдаём владельцу, если установка не вышла. */
let nativeError = null;
/** Ждущие готовности Squirrel.Mac: { done, fail }. */
const nativeWaiters = new Set();

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
    const { busy, reasons } = await res.json();
    logBusyWhy(busy === true ? (Array.isArray(reasons) && reasons.length ? reasons.join(' | ') : 'сервер не назвал причин') : '');
    return busy === true;
  } catch (err) {
    log('warn', 'не удалось спросить офис о занятости:', err);
    return true;
  }
}

/** Последняя записанная в журнал причина занятости — пусто, если офис свободен. */
let lastBusyWhy = '';

/**
 * Записать в журнал обновлений, что офис посчитал работой. Опрос идёт каждые
 * десять секунд, поэтому пишем только смену причины, а не каждый ответ.
 */
function logBusyWhy(why) {
  if (why === lastBusyWhy) return;
  lastBusyWhy = why;
  log('info', why ? `офис занят, перезапуск оборвёт работу — ${why}` : 'офис свободен, работы, которую оборвёт перезапуск, нет');
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
  // Ручной поток: без команды владельца ничего не качается. А то, что он
  // скачал сам, ставится и при обычном выходе — потому autoInstallOnAppQuit
  // включён с самого начала, а не только в restartNow.
  //
  // На macOS это не вкусовщина. MacUpdater отдаёт скачанный zip нативному
  // Squirrel.Mac через локальный сервер, и запрос к нему (checkForUpdates у
  // нативного обновлятора) делает только при autoInstallOnAppQuit = true. А
  // его quitAndInstall при autoInstallOnAppQuit = true считает, что запрос
  // уже был, и молча ждёт события от Squirrel. До T-435 флаг был false на
  // загрузке и становился true прямо перед quitAndInstall — Squirrel не
  // спрашивали ни разу, «Перезапустить сейчас» ждало вечно, а выход руками
  // ничего не ставил (в журнале 0.11.0 нет строки «requested by Squirrel.Mac»).
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.logger = {
    info: (...a) => log('info', ...a),
    warn: (...a) => log('warn', ...a),
    error: (...a) => log('error', ...a),
    // Отладочные строки MacUpdater — про локальный сервер для Squirrel.Mac и
    // его запрос за zip. Их немного, а без них по журналу не понять, дошло
    // ли обновление до установщика.
    debug: (...a) => log('debug', ...a),
  };

  channels.applyChannel(updater, getChannel());
  log('info', `канал обновлений: ${getChannel()}`);

  updater.on('checking-for-update', () => setState({ phase: 'checking' }));
  // Стабильный младше установленной беты — веб и меню предлагают откат (§7.4).
  updater.on('update-not-available', (info) => {
    const behind = getChannel() === 'stable' && channels.compareVersions(info?.version, app.getVersion()) < 0;
    setState({ phase: 'idle', ...(behind ? { stableBehind: info.version } : {}) });
  });
  updater.on('update-available', (info) => setState({
    phase: 'available', version: info.version, notes: notesText(info.releaseNotes),
  }));
  updater.on('download-progress', (p) => setState({
    phase: 'downloading',
    version: state.version ?? '',
    percent: Math.max(0, Math.min(100, Math.round(p.percent ?? 0))),
  }));
  updater.on('update-downloaded', (info) => {
    log('info', `update-downloaded: ${info.version} скачано${process.platform === 'darwin' ? ', жду Squirrel.Mac' : ''}`);
    setState({ phase: 'ready', version: info.version, notes: notesText(info.releaseNotes) });
  });
  updater.on('error', (err) => {
    log('error', 'ошибка autoUpdater:', err);
    fail(err);
  });
  watchNative();
  // Обычный выход со скачанным обновлением — строкой в журнал: по ней видно,
  // ждали ли мы установку при выходе и принял ли её Squirrel.Mac.
  // once: main.js откладывает выход до остановки сервера, и before-quit приходит дважды.
  app.once('before-quit', () => {
    if (state.phase !== 'ready' || restarting) return;
    const native = process.platform !== 'darwin' ? '' : nativeReady ? ', Squirrel.Mac его принял' : ', но Squirrel.Mac его ещё не принял — не поставится';
    log('info', `выход со скачанным ${state.version}: ставится при выходе${native}`);
  });

  // На тестовом канале без действующего согласия первая проверка ждёт диалога (§7.7).
  void ensureConsent().then(() => check());
  timer = setInterval(() => void check(), CHECK_EVERY_MS);
  timer.unref?.();
}

/**
 * Следить за нативным обновлятором (Squirrel.Mac). Его события electron-updater
 * наружу почти не пускает, а без них по журналу не понять, дошло ли
 * обновление до установщика. На Windows нативного шага нет — там установщик
 * NSIS запускает сам electron-updater.
 */
function watchNative() {
  if (process.platform !== 'darwin') return;
  const native = require('electron').autoUpdater;
  native.on('checking-for-update', () => log('info', 'Squirrel.Mac забирает скачанное обновление'));
  native.on('update-downloaded', () => {
    nativeReady = true;
    nativeError = null;
    log('info', 'Squirrel.Mac принял обновление: подпись сошлась, поставится при выходе');
    for (const w of nativeWaiters) w.done();
  });
  native.on('error', (err) => {
    nativeError = err;
    // Самая частая причина здесь — подпись новой сборки не сходится со
    // старой (другой сертификат или незаверенная сборка): Squirrel.Mac
    // такое обновление не ставит.
    log('error', 'Squirrel.Mac не принял обновление:', err);
    for (const w of nativeWaiters) w.fail(err);
  });
  native.on('before-quit-for-update', () => log('info', 'Squirrel.Mac: выхожу, чтобы поставить обновление'));
}

/**
 * Дождаться, пока Squirrel.Mac примет обновление. Если он уже ошибся или
 * ещё не начинал, просим его забрать обновление снова: адрес локального
 * сервера с zip electron-updater ему уже выдал.
 */
function waitNative() {
  if (process.platform !== 'darwin' || nativeReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = {
      done: () => { cleanup(); resolve(); },
      fail: (err) => { cleanup(); reject(err); },
    };
    const timeout = setTimeout(() => waiter.fail(new Error(t('update.err.nativeTimeout'))), NATIVE_WAIT_MS);
    function cleanup() {
      clearTimeout(timeout);
      nativeWaiters.delete(waiter);
    }
    nativeWaiters.add(waiter);
    if (nativeError) {
      nativeError = null;
      log('info', 'прошу Squirrel.Mac забрать обновление ещё раз');
      try { require('electron').autoUpdater.checkForUpdates(); } catch (err) { waiter.fail(err); }
    }
  });
}

/**
 * Модальный диалог к окну офиса, если оно видно; иначе — к приложению. Лист на
 * скрытом окне macOS не покажет, и диалог повис бы невидимым.
 */
function showDialog(options) {
  const win = hooks.window();
  return win && !win.isDestroyed() && win.isVisible() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/**
 * Диалог с галочкой: подтверждение проходит, только если галочка отмечена.
 * Кнопка по умолчанию и на Esc — «Отмена». Нативный диалог не умеет
 * выключать кнопку до галочки, поэтому без неё он показывается снова с
 * подсказкой, пока человек не отметит галочку или не нажмёт «Отмена».
 *
 * @returns {Promise<boolean>} согласился ли
 */
async function askWithCheckbox({ title, message, detail, checkbox, confirm, needCheckbox }) {
  let hint = '';
  for (;;) {
    const { response, checkboxChecked } = await showDialog({
      type: 'warning', title, message,
      detail: hint ? `${hint}\n\n${detail}` : detail,
      checkboxLabel: checkbox, checkboxChecked: false,
      buttons: [t('consent.cancel'), confirm], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return false;
    if (checkboxChecked) return true;
    hint = needCheckbox;
  }
}

/** Диалог согласия на бету или альфу (§7.7). */
function askConsent(channel) {
  return askWithCheckbox({
    title: t('consent.title'),
    message: t(`consent.${channel}.message`),
    detail: t('consent.detail'),
    checkbox: t(`consent.${channel}.checkbox`),
    confirm: t(`consent.${channel}.confirm`),
    needCheckbox: t('consent.needCheckbox'),
  });
}

/**
 * Действует ли записанное согласие для канала: оно на этот или более сырой
 * канал и на текущий текст. Согласие на альфу покрывает бету, но не наоборот.
 */
function hasConsent(channel, consent = loadPrefs().consent) {
  return Boolean(consent)
    && channels.channelRank(consent.channel) >= channels.channelRank(channel)
    && Number(consent.text) >= CONSENT_TEXT;
}

/** Записать канал и, если есть, согласие. Ошибка записи — бросает. */
function savePrefs(patch) {
  const updated = { ...loadPrefs(), ...patch };
  channels.writePrefs(paths.updatePrefsFile(), updated);
  prefs = { ...updated, fromFile: true };
}

/**
 * Тестовый канал без действующего согласия — скачанный руками бета-установщик
 * или вырос текст согласия (§7.7). Показываем диалог; отказ — канал stable,
 * без отката: версия остаётся, новых бет нет (§7.4).
 */
async function ensureConsent() {
  const channel = getChannel();
  if (channel === 'stable' || hasConsent(channel)) return;
  const agreed = await askConsent(channel);
  try {
    if (agreed) {
      savePrefs({ consent: { channel, text: CONSENT_TEXT, version: app.getVersion(), at: new Date().toISOString() } });
      log('info', `согласие на канал ${channel} получено (текст ${CONSENT_TEXT})`);
      return;
    }
    savePrefs({ channel: 'stable' });
  } catch (err) {
    log('error', 'настройки канала не записались:', err);
    if (agreed) return;
    // Записать не вышло, но без согласия на тестовом канале не остаёмся и в этом запуске.
    prefs = { ...loadPrefs(), channel: 'stable' };
  }
  log('info', `согласия на канал ${channel} нет — канал stable`);
  if (updater) channels.applyChannel(updater, 'stable');
  hooks.onChannel('stable');
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
  // Новая загрузка — новый zip: прежний ответ Squirrel.Mac к нему не относится.
  nativeReady = false;
  nativeError = null;
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
 *
 * Порядок важен. Сначала ждём, пока Squirrel.Mac примет обновление: если он
 * его отверг (подпись не сошлась), офис остаётся работать, а владелец видит
 * ошибку. Раньше сервер гасили до этого — и при сорвавшейся установке окно
 * оставалось без сервера. Потом гасим сервер и только затем quitAndInstall.
 * Повторные нажатия, пока идёт перезапуск, ничего не запускают заново.
 */
async function restartNow() {
  if (state.phase !== 'ready' || !updater) {
    return { ok: false, reason: 'not-ready', message: t('update.err.notReady') };
  }
  if (restarting) {
    log('info', 'перезапуск уже идёт — повторное нажатие пропущено');
    return { ok: true };
  }
  restarting = true;
  log('info', `перезапуск в ${state.version}: ${state.busy ? 'офис занят, владелец согласился' : 'офис свободен'}`);
  try {
    if (!nativeReady && process.platform === 'darwin') log('info', 'жду, пока Squirrel.Mac примет обновление');
    await waitNative();
  } catch (err) {
    restarting = false;
    log('error', 'установка невозможна, офис продолжает работать:', err);
    const message = t('update.err.nativeFailed', { error: errorText(err) });
    // Фазой ошибки с версией: веб покажет текст, а «Повторить» скачает заново
    // и снова отдаст обновление Squirrel.Mac.
    setState({ phase: 'error', error: message, version: state.version });
    return { ok: false, reason: 'not-ready', message };
  }
  // Сервер останавливаем сами и дожидаемся: он дописывает состояние офисов,
  // а quitAndInstall закрывает окна без оглядки на before-quit.
  log('info', 'останавливаю сервер офиса');
  try {
    await hooks.stopOffice();
  } catch (err) {
    log('error', 'сервер офиса не остановился чисто, ставлю всё равно:', err);
  }
  log('info', 'сервер остановлен, вызываю quitAndInstall');
  setImmediate(() => {
    try {
      // Тихая установка на Windows (без мастера NSIS) и запуск новой версии после.
      updater.quitAndInstall(true, true);
    } catch (err) {
      // Сервер уже остановлен, и окно без него мертво: выходим, а обновление
      // поставится при выходе (autoInstallOnAppQuit).
      log('error', 'quitAndInstall не удался, выхожу обычным путём:', err);
      app.quit();
      return;
    }
    // Страховка: если и после quitAndInstall процесс жив, выходим сами —
    // принятое обновление Squirrel.Mac и NSIS ставят и при обычном выходе.
    setTimeout(() => {
      log('warn', `через ${QUIT_GRACE_MS / 1000} с после quitAndInstall приложение ещё живо — выхожу обычным путём`);
      app.quit();
    }, QUIT_GRACE_MS).unref?.();
  });
  return { ok: true };
}

/** Настройки канала: из файла, а без него — по установленной версии (stable для обычной сборки). */
function loadPrefs() {
  if (!prefs) prefs = channels.readPrefs(paths.updatePrefsFile(), app.getVersion());
  return prefs;
}

/** Текущий канал обновлений: 'stable' | 'beta' | 'alpha'. */
function getChannel() {
  return loadPrefs().channel;
}

/**
 * Установленная версия с признаком пререлиза: `prerelease` — суффикс без
 * дефиса (`beta.3`) или '', `isPrerelease` — есть ли он.
 */
function getVersion() {
  const version = app.getVersion();
  const prerelease = channels.prereleaseOf(version);
  return { version, prerelease, isPrerelease: prerelease !== '' };
}

/**
 * Сменить канал обновлений — единственная точка входа для окна и меню.
 *
 * Переход на более сырой канал (stable → beta, beta → alpha) — только через
 * диалог согласия (§7.7); отмена или закрытие — канал прежний. Возврат на
 * более спокойный канал согласия не требует и версию не откатывает: ждём
 * следующего стабильного (§7.4), откат — отдельной командой downgrade.
 * Дальше: запись в файл, настройка electron-updater, сброс состояния и новая
 * проверка (§7.3).
 *
 * Пока идёт загрузка или откат, канал не меняется: обновление уже выбрано.
 * Скачанное, но не поставленное обновление из состояния забываем. Учти: на
 * macOS Squirrel.Mac его уже принял и поставит при выходе, если до выхода
 * владелец не скачает другое (autoInstallOnAppQuit, см. init) — это версия,
 * которую он сам скачал.
 */
async function applyChannelChange(next) {
  if (!channels.isChannel(next)) {
    return { ok: false, reason: 'not-ready', message: t('update.err.badChannel') };
  }
  const prev = getChannel();
  if (next === prev) return { ok: true };
  if (state.phase === 'downloading' || downgrading) {
    return { ok: false, reason: 'not-ready', message: t('update.err.channelWhileDownloading') };
  }
  const patch = { channel: next };
  if (channels.channelRank(next) > channels.channelRank(prev)) {
    // Согласие спрашиваем каждый раз при переходе вверх, даже если оно уже
    // записано: человек мог давно его дать и забыть, что значит бета.
    if (!(await askConsent(next))) {
      log('info', `переход ${prev} → ${next} отменён: согласия нет`);
      return { ok: false, reason: 'not-ready', message: t('consent.cancelled') };
    }
    patch.consent = { channel: next, text: CONSENT_TEXT, version: app.getVersion(), at: new Date().toISOString() };
  }
  try {
    savePrefs(patch);
  } catch (err) {
    log('error', 'канал не записался:', err);
    return { ok: false, reason: 'not-ready', message: errorText(err) };
  }
  log('info', `канал обновлений: ${prev} → ${next}`);
  hooks.onChannel(next);
  if (!updater) return { ok: true };
  channels.applyChannel(updater, next);
  setState({ phase: 'idle' });
  void check();
  return { ok: true };
}

/**
 * Стабильная версия, на которую можно откатиться: из состояния, а если её там
 * нет — проверкой на канале stable без отката. Сама проверка ничего не
 * качает и не копирует.
 */
async function stableTarget() {
  if (!state.stableBehind && state.phase !== 'checking') await check();
  return state.stableBehind ?? '';
}

/**
 * «Вернуться на стабильную сейчас» (§7.4): откат с беты на последний стабильный.
 *
 * 1. Канал — stable (без согласия: сырее он не становится).
 * 2. Предупреждение с галочкой; по умолчанию «Отмена». До подтверждения
 *    ничего не качается и не копируется.
 * 3. Копия `<userData>/office/` в `<userData>/backups/…` с правами 0700
 *    (backup.js). Секреты из системной связки ключей не выгружаются. Копия не
 *    сохранилась — отката нет.
 * 4. `allowDowngrade = true` на одну проверку и сразу обратно `false`: найденное
 *    обновление electron-updater помнит, и downloadUpdate его не перепроверяет.
 * 5. Загрузка; дальше обычный ручной поток — `ready` и restartNow с `busy`.
 */
async function downgrade() {
  if (!updater) return { ok: false, reason: 'not-ready', message: t('update.err.notPackaged') };
  if (downgrading || state.phase === 'downloading') {
    return { ok: false, reason: 'not-ready', message: t('update.err.channelWhileDownloading') };
  }
  const current = app.getVersion();
  if (!channels.isPrerelease(current)) return { ok: false, reason: 'not-ready', message: t('downgrade.notPrerelease') };
  downgrading = true;
  try {
    const prev = getChannel();
    if (prev !== 'stable') {
      savePrefs({ channel: 'stable' });
      log('info', `канал обновлений: ${prev} → stable (откат)`);
      hooks.onChannel('stable');
      channels.applyChannel(updater, 'stable');
      setState({ phase: 'idle' });
    }
    const target = await stableTarget();
    if (!target) {
      const message = state.phase === 'error' ? state.error : t('downgrade.noOlder');
      return { ok: false, reason: 'not-ready', message: message || t('downgrade.notFound') };
    }
    const agreed = await askWithCheckbox({
      title: t('downgrade.title'),
      message: t('downgrade.message', { target }),
      detail: t('downgrade.detail', { current, target, dir: join(paths.dataDir(), 'backups') }),
      checkbox: t('downgrade.checkbox'),
      confirm: t('downgrade.confirm', { target }),
      needCheckbox: t('downgrade.needCheckbox'),
    });
    if (!agreed) {
      log('info', `откат ${current} → ${target} отменён владельцем`);
      return { ok: false, reason: 'not-ready', message: t('downgrade.cancelled') };
    }

    let backup;
    try {
      backup = backupBeforeDowngrade({ dataDir: paths.dataDir(), version: current, channel: channels.channelOfVersion(current) });
    } catch (err) {
      log('error', 'копия данных перед откатом не сохранилась:', err);
      return { ok: false, reason: 'not-ready', message: t('downgrade.backupFailed', { error: errorText(err) }) };
    }
    log('info', `копия данных перед откатом: ${backup.dir} (файлов: ${backup.manifest.files.length})`);

    updater.allowDowngrade = true;
    try {
      setState({ phase: 'idle' });
      await check();
    } finally {
      updater.allowDowngrade = false;
    }
    if (state.phase !== 'available' || channels.compareVersions(state.version, current) >= 0) {
      return { ok: false, reason: 'not-ready', message: state.phase === 'error' ? state.error : t('downgrade.notFound') };
    }
    log('info', `откатываюсь ${current} → ${state.version}`);
    return download();
  } catch (err) {
    log('error', 'откат не удался:', err);
    return { ok: false, reason: 'not-ready', message: errorText(err) };
  } finally {
    downgrading = false;
  }
}

/** Стабильная версия младше установленной (для пункта отката в меню) или ''. */
const stableBehind = () => state.stableBehind ?? '';

/** Подписка на смену состояния; возвращает отписку. */
function onState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = {
  init, check, getState, download, restartNow, refreshBusy, onState, getChannel, getVersion, applyChannelChange, downgrade, stableBehind,
};
