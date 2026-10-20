'use strict';
const {app,BrowserWindow,ipcMain,screen}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{let ctl;try{
 const {createPetWindowController}=await import('../pet-window.mjs');
 const log=[];ctl=createPetWindowController({rootDir:path.resolve(__dirname,'..'),profile:fs.mkdtempSync(path.join(os.tmpdir(),'pet-hold-')),notify:()=>{}});
 ipcMain.handle('pet:command',(event,action,value)=>{log.push({action,value});return ctl.command(event,action,value);});
 ipcMain.handle('companion:command',()=>({messages:[],running:false}));ipcMain.handle('app-connections:command',()=>({ok:true,items:[]}));
 ctl.command({sender:{}},'configure',{enabled:true});const w=BrowserWindow.getAllWindows()[0];await new Promise(resolve=>w.webContents.isLoading()?w.webContents.once('did-finish-load',resolve):resolve());w.show();w.focus();
 w.on('resize',()=>console.log('RESIZE',JSON.stringify(w.getBounds())));w.on('move',()=>console.log('MOVE',JSON.stringify(w.getBounds())));
 console.log('DISPLAYS',JSON.stringify(screen.getAllDisplays().map(d=>({id:d.id,scale:d.scaleFactor,bounds:d.bounds}))));
 for(const expanded of [false,true,false]){
  ctl.command({sender:w.webContents},'expand',expanded);await delay(200);
  for(const spot of [{x:100,y:12},{x:140,y:170}]){
   const before=w.getBounds(),start=log.length;
   w.webContents.sendInputEvent({type:'mouseMove',...spot});w.webContents.sendInputEvent({type:'mouseDown',...spot,button:'left',clickCount:1});await delay(1500);
   const held=w.getBounds();w.webContents.sendInputEvent({type:'mouseUp',...spot,button:'left',clickCount:1});await delay(100);
   console.log('HOLD',JSON.stringify({expanded,spot,before,held,calls:log.slice(start)}));assert.deepEqual(held,before,'Stationary hold must not change bounds');
  }
 }
 const originalCursor=screen.getCursorScreenPoint;let cursor={x:500,y:500};screen.getCursorScreenPoint=()=>cursor;
 try{
  for(const expanded of [false,true]){
   ctl.command({sender:w.webContents},'expand',expanded);await delay(100);
   const initial=w.getBounds();ctl.command({sender:w.webContents},'drag-start');
   const sizes=[];
   for(let i=1;i<=20;i++){cursor={x:500+i*3,y:500+i*2};ctl.command({sender:w.webContents},'drag-move');await delay(15);const b=w.getBounds();sizes.push([b.width,b.height]);}
   console.log('DRAG SIZE',JSON.stringify({expanded,initial,sizes}));
   assert.ok(sizes.every(([width,height])=>width===initial.width&&height===initial.height),'Dragging must preserve original size exactly');
   ctl.command({sender:w.webContents},'drag-end');
  }
 }finally{screen.getCursorScreenPoint=originalCursor;}
 console.log('HOLD SIZE OK');ctl.destroy();app.exit(0);
}catch(error){console.error(error);ctl?.destroy();app.exit(1);}});
