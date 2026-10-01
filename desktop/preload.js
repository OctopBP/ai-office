/**
 * Мост окна ожидания. У окна офиса свой, намного более узкий мост —
 * office-preload.js: оно грузится по http, и чем меньше электроновских API
 * видно со страницы, тем меньше от них вреда.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('officeBoot', {
  onStatus: (fn) => ipcRenderer.on('boot:status', (_event, data) => fn(data)),
  openLog: () => ipcRenderer.invoke('boot:open-log'),
  onFailure: (fn) => ipcRenderer.on('boot:failure', (_event, data) => fn(data)),
  failureAction: (action) => ipcRenderer.send('boot:failure-action', action),
});
