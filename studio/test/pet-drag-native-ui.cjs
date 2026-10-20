'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');const os=require('node:os');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{let ctl;try{
 const {createPetWindowController}=await import('../pet-window.mjs');const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pet-drag-native-'));
 ctl=createPetWindowController({rootDir:path.resolve(__dirname,'..'),profile,notify:()=>{}});
 const calls=[];ipcMain.handle('pet:command',(event,action,value)=>{calls.push(action);return ctl.command(event,action,value);});
 ipcMain.handle('companion:command',()=>({messages:[],running:false}));ipcMain.handle('app-connections:command',()=>({ok:true,items:[]}));
 ctl.command({sender:{}},'configure',{enabled:true});const w=BrowserWindow.getAllWindows()[0];await new Promise(r=>w.webContents.isLoading()?w.webContents.once('did-finish-load',r):r());
 ctl.command({sender:w.webContents},'expand',true);w.show();await delay(200);
 await w.webContents.insertCSS('.blank-gap{height:80px;flex-shrink:0}');
 await w.webContents.executeJavaScript(`document.querySelector('#companion-messages').innerHTML=Array.from({length:30},()=>'<div class="blank-gap" style="height:80px;flex-shrink:0"></div>').join('');`);
 const rect=await w.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#companion-messages').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
 console.log('NATIVE FIXTURE',await w.webContents.executeJavaScript(`(()=>{const el=document.querySelector('#companion-messages');return {height:el.clientHeight,scroll:el.scrollHeight,children:el.children.length,hidden:document.querySelector('#companion-panel').hidden,region:getComputedStyle(el).webkitAppRegion}})()`),rect);
 w.focus();w.webContents.focus();w.webContents.debugger.attach('1.3');
 const wheel=async(x,y,delta)=>w.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaY:delta,deltaX:0});
 const before=w.getBounds();
 for(let trial=0;trial<3;trial++){
  await w.webContents.executeJavaScript("document.querySelector('#companion-messages').scrollTop=0");
  w.webContents.sendInputEvent({type:'mouseMove',...rect});await wheel(rect.x,rect.y,180);await delay(120);
  assert.ok(await w.webContents.executeJavaScript("document.querySelector('#companion-messages').scrollTop>0"));
  w.webContents.sendInputEvent({type:'mouseDown',...rect,button:'left',clickCount:1});await delay(40);
  w.webContents.sendInputEvent({type:'mouseMove',x:rect.x+20,y:rect.y+12,button:'left'});await delay(80);
  assert.ok(calls.includes('drag-start'));assert.ok(calls.includes('drag-move'));
  await wheel(rect.x+20,rect.y+12,120);await delay(80);
  w.webContents.sendInputEvent({type:'mouseUp',x:rect.x+20,y:rect.y+12,button:'left',clickCount:1});
  assert.equal(await w.webContents.executeJavaScript("document.body.classList.contains('pet-dragging')"),false);
 }
 // Renderer may request movement only for its own window; no arbitrary x/y IPC exists.
 assert.throws(()=>ctl.command({sender:{}},'drag-start'),/Only the companion/);
 console.log('NATIVE DRAG/WHEEL OK: three repeated whitespace-scroll/drag/wheel-cancel cycles in real Electron');
 ctl.destroy();app.exit(0);
 }catch(e){console.error(e);ctl?.destroy();app.exit(1);}});
