'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('providerAccounts', {
    list: () => ipcRenderer.invoke('provider-logins:list'),
    open: id => ipcRenderer.invoke('provider-logins:open', id),
});
