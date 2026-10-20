'use strict';
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');
app.whenReady().then(async()=>{let w;try{
 w=new BrowserWindow({width:480,height:740,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 await w.loadURL('about:blank');
 const root=path.resolve(__dirname,'../renderer');
 await w.webContents.executeJavaScript(`document.body.innerHTML='<div id="companion-panel"><div id="host"></div></div>';document.body.style.cssText='background:#171c16;color:#e5ecd7;padding:18px;font:13px system-ui';`);
 await w.webContents.insertCSS(fs.readFileSync(path.join(root,'companion-activity.css'),'utf8'));
 for(const file of ['activity-state.js','companion-activity.js'])await w.webContents.executeJavaScript(fs.readFileSync(path.join(root,file),'utf8'));
 const result=await w.webContents.executeJavaScript(`(()=>{
  const view=ReachCompanionActivity.mount(document.querySelector('#host'));
  view.event({type:'run-state',status:'running'});view.event({type:'tool-call',tool:'weather.current',arguments:{query:'Toronto'}});
  view.event({type:'tool-result',ok:true,result:{temperature:'12 C',untrusted:'<img src=x onerror=alert(1)>'}});
  const details=document.querySelectorAll('details')[1];details.open=true;
  view.event({type:'request-start'});view.event({type:'reasoning',chars:42});
  const thinking=document.querySelector('.steps-chip').textContent;
  view.event({type:'approval-wait'});const waiting=document.querySelector('.steps-chip').textContent;
  const openPreserved=details.open;view.event({type:'approval-end'});view.event({type:'delta',text:'Summary'});view.event({type:'run-state',status:'completed'});
  return {thinking,waiting,openPreserved,rows:document.querySelectorAll('.step-line').length,safe:!document.querySelector('img'),result:document.querySelectorAll('.step-result')[1].textContent,completed:document.querySelector('.steps-chip').textContent,overflow:document.documentElement.scrollWidth>innerWidth};
 })()`);
 assert.equal(result.thinking,'Thinking');assert.match(result.waiting,/approval/);assert.equal(result.openPreserved,true);assert.equal(result.safe,true);assert.match(result.result,/temperature/);assert.equal(result.completed,'Completed');assert.equal(result.overflow,false);
 // Rendering assertions run in Chromium; screenshots are captured by the browser QA fixture.
 console.log(JSON.stringify(result));app.exit(0);
}catch(error){console.error(error);app.exit(1);}finally{w?.destroy();}});
