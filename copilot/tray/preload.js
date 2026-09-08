/* Preload for the tray popover panel — tiny IPC surface (sandboxed). */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copilotTray', {
    status: () => ipcRenderer.invoke('tray-status'),
    test: (text) => ipcRenderer.invoke('tray-test', text),
    chat: (payload) => ipcRenderer.invoke('tray-chat', payload),
    showBrowser: () => ipcRenderer.send('show-browser'),
    hideBrowser: () => ipcRenderer.send('hide-browser'),
    reloadBrowser: () => ipcRenderer.send('reload-browser'),
    refreshPage: () => ipcRenderer.send('refresh-page'),
    openExternal: (url) => ipcRenderer.send('open-external', url),
    signOut: () => ipcRenderer.send('sign-out'),
    quit: () => ipcRenderer.send('quit')
});
