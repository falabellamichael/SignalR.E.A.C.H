/* Preload for the tray popover panel — tiny IPC surface (sandboxed). */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copilotTray', {
    status: () => ipcRenderer.invoke('tray-status'),
    test: (text) => ipcRenderer.invoke('tray-test', text),
    showBrowser: () => ipcRenderer.send('show-browser'),
    hideBrowser: () => ipcRenderer.send('hide-browser'),
    reloadBrowser: () => ipcRenderer.send('reload-browser'),
    refreshPage: () => ipcRenderer.send('refresh-page'),
    signOut: () => ipcRenderer.send('sign-out'),
    quit: () => ipcRenderer.send('quit')
});
