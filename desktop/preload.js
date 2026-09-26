/**
 * Мост окна ожидания. У окна офиса свой, намного более узкий мост —
 * office-preload.js: оно грузится по http, и чем меньше электроновских API
 * видно со страницы, тем меньше от них вреда.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('officeBoot', {
  onStatus: (fn) => ipcRenderer.on('boot:status', (_event, data) => fn(data)),
  onNeedEngine: (fn) => ipcRenderer.on('boot:need-engine', (_event, data) => fn(data)),
  choose: (value) => ipcRenderer.send('boot:engine-choice', value),
  openLog: () => ipcRenderer.invoke('boot:open-log'),
});
