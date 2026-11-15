// Ponte minimo tra l'app e Windows: l'app sa di girare nella versione desktop
// e può mettere la finestra a schermo intero.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SolcoDesktop', {
  toggleFullscreen: () => ipcRenderer.send('solco:fullscreen'),
});
