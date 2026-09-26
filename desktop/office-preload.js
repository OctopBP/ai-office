/**
 * Мост окна офиса. Страница грузится по http с нашего же сервера, поэтому
 * наружу торчат ровно две команды, обе безвредные: поднять окно и показать
 * число ожидающего на значке. Ни файлов, ни процессов отсюда не видно.
 *
 * Веб проверяет наличие `window.officeDesktop` и без него ведёт себя как в
 * браузере — мост не обязателен.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('officeDesktop', {
  focus: () => ipcRenderer.send('office:focus'),
  setBadge: (count) => ipcRenderer.send('office:badge', Number(count) || 0),
});
