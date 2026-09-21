/**
 * Мост окна ожидания. Окно офиса живёт без preload: оно грузится по http со
 * своего же сервера и в электроновских API не нуждается — чем меньше их
 * видно со страницы, тем меньше от них вреда.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('officeBoot', {
  onStatus: (fn) => ipcRenderer.on('boot:status', (_event, data) => fn(data)),
  onNeedEngine: (fn) => ipcRenderer.on('boot:need-engine', (_event, data) => fn(data)),
  choose: (value) => ipcRenderer.send('boot:engine-choice', value),
  openLog: () => ipcRenderer.invoke('boot:open-log'),
});
