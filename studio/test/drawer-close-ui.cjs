'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(app.getPath('temp'),'reach-drawer-close-ui-'+process.pid));
const root=path.resolve(__dirname,'../renderer');
(async()=>{
 await app.whenReady();
 const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true}});
 // Isolate drawer behavior from account, network and project services.
 win.webContents.session.webRequest.onBeforeRequest((request,done)=>done({cancel:request.resourceType==='script'||/^https?:/.test(request.url)}));
 await win.loadFile(path.join(root,'index.html'));
 await win.webContents.executeJavaScript(`(()=>{
  const $=selector=>document.querySelector(selector);
  const currentProject=null,currentAgent=null;
  const refreshFileTree=()=>{};
  ${fs.readFileSync(path.join(root,'app-drawer.js'),'utf8')}
  window.drawerTest={open:()=>setDrawer(true),layout:applyDrawerLayout};
 })()`);
 for(const width of [1200,640]){
  win.setContentSize(width,800);
  for(const layout of ['top','side'])for(const panel of ['files','browser','singular']){
   const result=await win.webContents.executeJavaScript(`(()=>{
    const drawer=document.querySelector('#file-drawer');
    drawer.dataset.panel=${JSON.stringify(panel)};drawerTest.layout(${JSON.stringify(layout)},false);drawerTest.open();
    const before=getComputedStyle(drawer).display;
    document.querySelector('#btn-close-drawer').click();
    const closed=getComputedStyle(drawer).display;
    const toggleActive=document.querySelector('#btn-toggle-files').classList.contains('active');
    drawerTest.open();return {before,closed,toggleActive,reopened:getComputedStyle(drawer).display};
   })()`);
   assert.notEqual(result.before,'none');assert.equal(result.closed,'none',`${width} ${layout} ${panel} close`);
   assert.equal(result.toggleActive,false);assert.notEqual(result.reopened,'none');
  }
 }
 console.log('Drawer closes and reopens in all 12 layout/panel/width combinations.');
 win.destroy();app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
