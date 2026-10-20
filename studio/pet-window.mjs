import {BrowserWindow,screen} from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export function createPetWindowController({rootDir,profile,notify,getTheme=()=>null}) {
 let window=null,state={enabled:false,kind:'cat',motion:true,activity:'idle'},bounds=null;
 const file=path.join(profile,'desktop-pet.json');
 try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));state={...state,enabled:saved.enabled===true,kind:['cat','owl','bulldog'].includes(saved.kind)?saved.kind:'cat',motion:saved.motion!==false};bounds=saved.bounds;}catch{}
 const persist=()=>{fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(file,JSON.stringify({enabled:state.enabled,kind:state.kind,motion:state.motion,bounds}));};
 const publish=()=>{if(window&&!window.isDestroyed())window.webContents.send('pet:state',{...state,theme:getTheme()});notify({...state});};
 function open(){
  if(window&&!window.isDestroyed()){publish();return;}
  const work=screen.getDisplayNearestPoint(bounds&&Number.isFinite(bounds.x)&&Number.isFinite(bounds.y)?{x:bounds.x,y:bounds.y}:screen.getCursorScreenPoint()).workArea;
  const x=Math.round(Math.max(work.x,Math.min(Number.isFinite(bounds?.x)?bounds.x:work.x+work.width-310,work.x+work.width-290)));
  const y=Math.round(Math.max(work.y,Math.min(Number.isFinite(bounds?.y)?bounds.y:work.y+work.height-210,work.y+work.height-180)));
  window=new BrowserWindow({width:290,height:180,x,y,frame:false,transparent:true,resizable:false,maximizable:false,minimizable:false,alwaysOnTop:true,skipTaskbar:true,show:false,hasShadow:false,webPreferences:{preload:path.join(rootDir,'pet-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.setAlwaysOnTop(true,'screen-saver');window.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.once('ready-to-show',()=>{if(window){window.showInactive();publish();}});
  window.on('moved',()=>{if(window){const b=window.getBounds();bounds={x:b.x,y:b.y};persist();}});
  window.on('closed',()=>{window=null;state.enabled=false;persist();notify({...state});});
  window.loadFile(path.join(rootDir,'renderer/pet-window.html'));
 }
 function command(event,action,value){
  const isPet=window&&!window.isDestroyed()&&event.sender===window.webContents;
  if(isPet&&!['close','ready'].includes(action))throw new Error('Unsupported companion command');
  if(action==='get')return {...state};
  if(action==='ready'){publish();return {...state};}
  if(action==='close'){state.enabled=false;persist();if(window)window.close();publish();return {...state};}
  if(action==='configure'){
   if(!value||typeof value!=='object')throw new Error('Invalid companion settings');
   if(typeof value.enabled==='boolean')state.enabled=value.enabled;
   if(['cat','owl','bulldog'].includes(value.kind))state.kind=value.kind;
   if(typeof value.motion==='boolean')state.motion=value.motion;
   persist();if(state.enabled)open();else if(window)window.close();publish();return {...state};
  }
  if(action==='activity'){if(['idle','typing','waiting','thinking','responding','searching','reading','writing','running','checking','blocked','complete','error','cancelled'].includes(value)){state.activity=value;publish();}return;}
  if(action==='reset'){bounds=null;if(window){const w=screen.getPrimaryDisplay().workArea;window.setPosition(w.x+w.width-310,w.y+w.height-210);}persist();return;}
  throw new Error('Unknown companion command');
 }
 return {command,refreshTheme:publish,owns(sender){return !!window&&!window.isDestroyed()&&sender===window.webContents;},restore(){if(state.enabled)open();},destroy(){if(window){window.removeAllListeners('closed');window.destroy();window=null;}}};
}
