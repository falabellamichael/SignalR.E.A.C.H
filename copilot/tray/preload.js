/* Preload for the tray popover panel — tiny IPC surface (sandboxed). */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copilotTray', {
    settings: () => ipcRenderer.invoke('tray-settings'),
    saveSettings: value => ipcRenderer.invoke('tray-save-settings', value),
    models: () => ipcRenderer.invoke('tray-models'),
    hide: () => ipcRenderer.send('hide-panel'),
    onChatProgress: callback => { ipcRenderer.on('chat-progress', (_event, value) => callback(value)); },
    onChatDelta: callback => { ipcRenderer.on('chat-delta', (_event, value) => callback(value)); },
    onSettingsChanged: callback => { ipcRenderer.on('settings-changed', () => callback()); },
    status: () => ipcRenderer.invoke('tray-status'),
    test: (text) => ipcRenderer.invoke('tray-test', text),
    chat: (payload) => ipcRenderer.invoke('tray-chat', payload),
    showBrowser: () => ipcRenderer.send('show-browser'),
    hideBrowser: () => ipcRenderer.send('hide-browser'),
    toggleBrowser: () => ipcRenderer.send('toggle-browser'),
    reloadBrowser: () => ipcRenderer.send('reload-browser'),
    refreshPage: () => ipcRenderer.send('refresh-page'),
    openExternal: (url) => ipcRenderer.send('open-external', url),
    signOut: () => ipcRenderer.send('sign-out'),
    quit: () => ipcRenderer.send('quit')
});
