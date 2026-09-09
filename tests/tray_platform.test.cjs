const { test }=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {createRequire}=require('node:module');
const file=path.resolve(__dirname,'../copilot/tray/main.js');
const source=fs.readFileSync(file,'utf8');

for(const platform of ['darwin','win32','linux']) test(platform+' tray opens a panel through its native controls',async()=>{
 class Window extends EventEmitter {
  constructor(options){super();this.options=options;this.visible=false;this.webContents={setWindowOpenHandler(){},send(){}};}
  isDestroyed(){return false;} isVisible(){return this.visible;} hide(){this.visible=false;} show(){this.visible=true;} showInactive(){this.visible=true;} focus(){} setBounds(value){this.bounds=value;} loadFile(){return Promise.resolve();} setVisibleOnAllWorkspaces(){this.spaces=true;}
 }
 class Tray extends EventEmitter{
  setToolTip(){} setContextMenu(menu){this.menu=menu;} setIgnoreDoubleClickEvents(value){this.single=value;} getBounds(){return {x:900,y:0,width:22,height:24};} popUpContextMenu(menu){this.popup=menu;}
 }
 const app=new EventEmitter();app.getPath=()=>'/unused';app.setPath=()=>{};app.requestSingleInstanceLock=()=>true;app.whenReady=()=>({then(){}});app.dock={setMenu(menu){this.menu=menu;}};
 const image={isEmpty:()=>false,resize(){return this;}};
 const Menu={buildFromTemplate:items=>({items}),setApplicationMenu(){}};
 const req=createRequire(file);
 const ctx={console:{log(){}},process:{platform,env:{}},module:{exports:{}},__dirname:path.dirname(file),URL,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,
 require:name=>name==='electron'?{app,BrowserWindow:Window,Tray,Menu,nativeImage:{createFromPath:()=>image},screen:{getDisplayNearestPoint:()=>({workArea:{x:0,y:0,width:1200,height:900}}),getCursorScreenPoint:()=>({x:1,y:1})}}:name==='node:fs'?{mkdirSync(){},appendFileSync(){}}:name==='./endpoint'?{createEndpointClient:()=>({getSettings:()=>({provider:'endpoint'})})}:req(name)};
 vm.runInNewContext(source+'\nmodule.exports={createTray,getTray:()=>tray,getPanel:()=>panel};',ctx,{filename:file});
 ctx.module.exports.createTray();const tray=ctx.module.exports.getTray();
 if(platform==='darwin'){
  assert.equal(tray.menu,undefined);assert.equal(tray.single,true);
  tray.emit('click');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ctx.module.exports.getPanel().visible,true);
  assert.equal(ctx.module.exports.getPanel().bounds.y,32);
  assert.equal(ctx.module.exports.getPanel().spaces,true);
  tray.emit('right-click');assert.ok(tray.popup.items.some(i=>i.label==='Open Tray Panel'));
 } else {
  tray.menu.items.find(i=>i.label==='Open Tray Panel').click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ctx.module.exports.getPanel().visible,true);
 }
});
