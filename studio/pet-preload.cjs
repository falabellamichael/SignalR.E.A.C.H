'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('petWindow',{
  command:(action,value)=>ipcRenderer.invoke('pet:command',action,value),
  onState:cb=>ipcRenderer.on('pet:state',(_event,state)=>cb(state)),
});
