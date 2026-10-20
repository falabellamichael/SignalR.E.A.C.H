'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
app.whenReady().then(async()=>{
 let ctl;const root=fs.mkdtempSync(path.join(os.tmpdir(),'reach-pet-window-'));
 try{
  const {createPetWindowController}=await import('../pet-window.mjs');
  const {paint}=require('../renderer/theme-data.js');let theme=paint({theme:'light',accent:'#cc5500',tint:40});
  const states=[];ctl=createPetWindowController({getTheme:()=>theme,rootDir:path.resolve(__dirname,'..'),profile:root,notify:s=>states.push(s)});
  ipcMain.handle('pet:command',(event,action,value)=>ctl.command(event,action,value));
  ctl.command({sender:{}},'configure',{enabled:true,kind:'owl',motion:true});
  const w=BrowserWindow.getAllWindows()[0];await new Promise(resolve=>w.webContents.isLoading()?w.webContents.once('did-finish-load',resolve):resolve());
  assert.equal(w.isAlwaysOnTop(),true);assert.equal(w.isResizable(),false);
  assert.equal(await w.webContents.executeJavaScript("!!document.querySelector('#pet-close')"),true);
  assert.equal(w.webContents.getLastWebPreferences().sandbox,true);
  ctl.command({sender:w.webContents},'ready');
  for(const choice of [{theme:'light',accent:'#cc5500',tint:40},{theme:'nord',accent:'#33bb99',tint:60}]){
   theme=paint(choice);ctl.refreshTheme();
   await w.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,80))');
   const actual=await w.webContents.executeJavaScript("({theme:document.documentElement.dataset.theme,gold:getComputedStyle(document.documentElement).getPropertyValue('--gold').trim(),panel:getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()})");
   assert.equal(actual.theme,theme.theme);assert.equal(actual.gold,theme.vars.gold);assert.equal(actual.panel,theme.vars.panel);
  }
  assert.throws(()=>ctl.command({sender:w.webContents},'configure',{enabled:false}),/Unsupported/);
  w.setPosition(100,100);ctl.command({sender:{}},'activity','thinking');
  await new Promise(resolve=>setTimeout(resolve,200));
  const image=await w.webContents.capturePage();fs.writeFileSync(path.join(os.tmpdir(),'reach-native-pet.png'),image.toPNG());
  ctl.command({sender:w.webContents},'close');
  assert.equal(ctl.command({sender:{}},'get').enabled,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'desktop-pet.json'))).enabled,false);
  console.log('PET WINDOW OK: native topmost, isolated renderer, close synchronizes settings, configuration persists');app.exit(0);
 }catch(e){console.error(e);app.exit(1);}finally{ctl?.destroy();}
});
