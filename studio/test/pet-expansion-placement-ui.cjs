'use strict';
const {app,BrowserWindow,ipcMain,screen}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{let ctl;try{
 const {createPetWindowController}=await import('../pet-window.mjs');
 const work=screen.getPrimaryDisplay().workArea;
 const locations=[{name:'top-left',x:work.x+30,y:work.y+30,up:false,left:false},{name:'top-right',x:work.x+work.width-320,y:work.y+30,up:false,left:true},{name:'bottom-left',x:work.x+30,y:work.y+work.height-210,up:true,left:false},{name:'bottom-right',x:work.x+work.width-320,y:work.y+work.height-210,up:true,left:true}];
 ipcMain.handle('pet:command',(e,a,v)=>ctl.command(e,a,v));ipcMain.handle('companion:command',()=>({messages:[],running:false}));ipcMain.handle('app-connections:command',()=>({ok:true,items:[]}));
 for(const location of locations){
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pet-expand-'));fs.writeFileSync(path.join(profile,'desktop-pet.json'),JSON.stringify({bounds:{x:location.x,y:location.y},enabled:true}));
  ctl=createPetWindowController({rootDir:path.resolve(__dirname,'..'),profile,notify:()=>{}});ctl.restore();const w=BrowserWindow.getAllWindows()[0];await new Promise(r=>w.webContents.isLoading()?w.webContents.once('did-finish-load',r):r());await delay(120);
  const position=async()=>{const bounds=w.getBounds();const rect=await w.webContents.executeJavaScript(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x,y:r.y}})()`);return {x:bounds.x+rect.x,y:bounds.y+rect.y};};
  const original=await position();const initialBounds=w.getBounds();
  for(let i=0;i<5;i++){
   const state=ctl.command({sender:w.webContents},'expand',true);await delay(80);
   const actual=w.getBounds();
   const expected={x:initialBounds.x,y:initialBounds.y};
   assert.ok(Math.abs(actual.x-expected.x)<=1&&Math.abs(actual.y-expected.y)<=1,JSON.stringify({location,actual,expected}));
   const layout=await w.webContents.executeJavaScript(`(()=>{const pet=document.querySelector('main').getBoundingClientRect(),chat=document.querySelector('#companion-panel').getBoundingClientRect();return {petTop:pet.top,petBottom:pet.bottom,chatTop:chat.top}})()`);
   assert.ok(layout.petTop<layout.chatTop&&layout.petBottom<=layout.chatTop+1,'Pet must always be above chat');
   ctl.command({sender:w.webContents},'expand',false);await delay(80);const collapsed=await position();assert.ok(Math.abs(collapsed.x-original.x)<=2&&Math.abs(collapsed.y-original.y)<=2,'collapse drift '+location.name);
  }
  console.log('ANCHOR OK',location.name);ctl.destroy();ctl=null;await delay(40);
 }
 console.log('EXPANSION OK: 20 native expand/collapse cycles across all four screen corners, pet always above chat; opening and collapsing never reposition window');app.exit(0);
}catch(e){console.error(e);ctl?.destroy();app.exit(1);}});
