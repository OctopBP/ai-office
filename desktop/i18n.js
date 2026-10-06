/**
 * Тексты оболочки на двух языках — для экрана ошибки запуска и обновлений.
 *
 * Словари веба (src/web/i18n) здесь недоступны: экран ошибки показывается
 * ровно тогда, когда веб не загрузился. Язык — системный, как и у журнала
 * сервера (OFFICE_LANG в main.js): настройки интерфейса лежат у сервера, а он
 * в этот момент может быть мёртв.
 */

const { app } = require('electron');

const DICT = {
  ru: {
    'fail.title': 'Офис не открылся',
    'fail.serverStart': 'Сервер офиса не запустился.',
    'fail.serverExit': 'Сервер офиса остановился (код {code}).',
    'fail.load': 'Окно не смогло загрузить офис: {error} ({code}).',
    'fail.timeout': 'Страница офиса не загрузилась за {sec} секунд.',
    'fail.blank': 'Интерфейс офиса не отрисовался за {sec} секунд — страница осталась пустой.',
    'fail.renderer': 'Процесс окна завершился: {reason}.',
    'fail.hint': 'Если повторится — пришлите нам оба журнала из этой папки:',
    'fail.openLogs': 'Открыть журналы',
    'fail.retry': 'Перезапустить офис',
    'fail.quit': 'Выход',
    'update.title': 'Обновления',
    'update.latest': 'Установлена последняя версия.',
    'update.available': 'Доступна версия {version}.',
    'update.available.detail': 'Скачать её сейчас? Ставится обновление только по вашей команде.',
    'update.download': 'Скачать',
    'update.later': 'Позже',
    'update.downloading': 'Версия {version} скачивается.',
    'update.ready': 'Версия {version} скачана.',
    'update.ready.detail': 'Перезапустить приложение сейчас?',
    'update.ready.busy': 'В офисе идёт работа — перезапуск её оборвёт. Перезапустить всё равно?',
    'update.restart': 'Перезапустить',
    'update.err.notDownloadable': 'Скачивать нечего: новая версия не найдена',
    'update.err.notReady': 'Обновление ещё не скачано',
    'update.err.notPackaged': 'Обновления проверяются только в собранном приложении',
    'update.err.notOffice': 'Команда не из окна офиса',
  },
  en: {
    'fail.title': 'The office did not open',
    'fail.serverStart': 'The office server did not start.',
    'fail.serverExit': 'The office server stopped (code {code}).',
    'fail.load': 'The window could not load the office: {error} ({code}).',
    'fail.timeout': 'The office page did not load within {sec} seconds.',
    'fail.blank': 'The office interface did not render within {sec} seconds — the page stayed empty.',
    'fail.renderer': 'The window process exited: {reason}.',
    'fail.hint': 'If it happens again, send us both logs from this folder:',
    'fail.openLogs': 'Open logs',
    'fail.retry': 'Restart office',
    'fail.quit': 'Quit',
    'update.title': 'Updates',
    'update.latest': 'You have the latest version.',
    'update.available': 'Version {version} is available.',
    'update.available.detail': 'Download it now? Updates are installed only when you say so.',
    'update.download': 'Download',
    'update.later': 'Later',
    'update.downloading': 'Version {version} is downloading.',
    'update.ready': 'Version {version} is downloaded.',
    'update.ready.detail': 'Restart the app now?',
    'update.ready.busy': 'Work is running in the office — restarting will interrupt it. Restart anyway?',
    'update.restart': 'Restart',
    'update.err.notDownloadable': 'Nothing to download: no new version found',
    'update.err.notReady': 'The update is not downloaded yet',
    'update.err.notPackaged': 'Updates are checked only in the packaged app',
    'update.err.notOffice': 'The command did not come from the office window',
  },
};

const lang = () => (app.getLocale().startsWith('ru') ? 'ru' : 'en');

/** Текст по ключу с подстановкой {имён}. */
function t(key, vars = {}) {
  const text = DICT[lang()][key] ?? DICT.ru[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

module.exports = { t, lang };
