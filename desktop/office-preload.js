/**
 * Мост окна офиса. Страница грузится по http с нашего же сервера, поэтому
 * наружу торчат только безвредные команды: поднять окно, показать число
 * ожидающего на значке и управлять обновлением приложения. Ни файлов, ни
 * процессов отсюда не видно.
 *
 * Веб проверяет наличие `window.officeDesktop` и без него ведёт себя как в
 * браузере — мост не обязателен. Контракт — src/shared/desktop.ts.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('officeDesktop', {
  focus: () => ipcRenderer.send('office:focus'),
  setBadge: (count) => ipcRenderer.send('office:badge', Number(count) || 0),
  updates: {
    getState: () => ipcRenderer.invoke('office:update-state'),
    onState: (cb) => {
      // Колбэк получает только состояние: объект события Electron в страницу не отдаём.
      const listener = (_event, state) => cb(state);
      ipcRenderer.on('office:update', listener);
      return () => ipcRenderer.removeListener('office:update', listener);
    },
    check: () => ipcRenderer.invoke('office:update-check'),
    download: () => ipcRenderer.invoke('office:update-download'),
    restartNow: () => ipcRenderer.invoke('office:update-restart'),
    // Канал обновлений: 'stable' | 'beta' | 'alpha'. Смену решает главный
    // процесс (там же диалог согласия на бету и альфу) — отсюда только просьба.
    getChannel: () => ipcRenderer.invoke('office:update-channel-get'),
    setChannel: (channel) => ipcRenderer.invoke('office:update-channel-set', String(channel)),
    // Откат с беты на стабильный: предупреждение и копию данных делает главный процесс.
    downgrade: () => ipcRenderer.invoke('office:update-downgrade'),
    // Установленная версия: { version, prerelease: 'beta.3' | '', isPrerelease }.
    getVersion: () => ipcRenderer.invoke('office:app-version'),
  },
});

/**
 * Копия localStorage в папке данных (T-107).
 *
 * localStorage привязан к origin с портом; если постоянный порт офиса занят и
 * окно открылось на запасном, хранилище там пустое. Preload выполняется до
 * скриптов страницы и видит то же хранилище, поэтому недостающие ключи
 * подставляются из копии раньше, чем веб прочитает тему или графику. Ключи,
 * которые в хранилище уже есть, не трогаем: на своём origin они свежее копии.
 *
 * Перехватить setItem страницы из изолированного мира нельзя, поэтому копия
 * снимается опросом и при уходе со страницы — веб об этом ничего не знает и
 * в браузере работает как раньше.
 */
function snapshot() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) data[key] = localStorage.getItem(key) ?? '';
  }
  return data;
}

let last = '';

try {
  const saved = ipcRenderer.sendSync('office:storage-load') ?? {};
  for (const [key, value] of Object.entries(saved)) {
    if (typeof value === 'string' && localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }
  last = JSON.stringify(snapshot());
} catch {
  // Хранилище недоступно — окно живёт с умолчаниями, как в приватном режиме.
}

function save() {
  try {
    const data = snapshot();
    const text = JSON.stringify(data);
    if (text === last) return;
    last = text;
    ipcRenderer.send('office:storage-save', data);
  } catch { /* повторим на следующем тике */ }
}

setInterval(save, 2000);
window.addEventListener('pagehide', save);
window.addEventListener('beforeunload', save);
