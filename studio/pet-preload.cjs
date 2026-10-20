'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('petWindow',{
  command:(action,value)=>ipcRenderer.invoke('pet:command',action,value),
  onState:cb=>ipcRenderer.on('pet:state',(_event,state)=>cb(state)),
  chat:(action,value)=>ipcRenderer.invoke('companion:command',action,value),
  onChat:cb=>ipcRenderer.on('companion:event',(_event,payload)=>cb(payload)),
  appConnections:(action,value)=>ipcRenderer.invoke('app-connections:command',action,value),
  openLink:url=>ipcRenderer.invoke('companion:link',url),
});
