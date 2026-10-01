/**
 * Тексты оболочки на двух языках — для экрана ошибки запуска.
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
  },
};

const lang = () => (app.getLocale().startsWith('ru') ? 'ru' : 'en');

/** Текст по ключу с подстановкой {имён}. */
function t(key, vars = {}) {
  const text = DICT[lang()][key] ?? DICT.ru[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

module.exports = { t, lang };
