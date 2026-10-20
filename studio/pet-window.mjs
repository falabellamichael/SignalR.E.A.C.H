import {BrowserWindow,screen} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const {atomicWriteJson}=createRequire(import.meta.url)('./agent/atomic-write.cjs');

export function createPetWindowController({rootDir,profile,notify,getTheme=()=>null}) {
 let window=null,state={enabled:false,kind:'cat',motion:true,activity:'idle',expanded:false},bounds=null;
 let dragSession=null,requestedBounds=null,anchorOffset={x:0,y:0};
 const file=path.join(profile,'desktop-pet.json');
 try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));state={...state,enabled:saved.enabled===true,kind:['cat','owl','bulldog'].includes(saved.kind)?saved.kind:'cat',motion:saved.motion!==false,expanded:saved.expanded===true};bounds=saved.bounds;}catch{}
 const persist=()=>atomicWriteJson(file,{enabled:state.enabled,kind:state.kind,motion:state.motion,expanded:state.expanded,bounds});
 const publish=()=>{if(window&&!window.isDestroyed())window.webContents.send('pet:state',{...state,theme:getTheme()});notify({...state});};
 function fit(){
  if(!window||window.isDestroyed())return;
  const current=requestedBounds||window.getBounds();
  const anchor=bounds||{x:current.x,y:current.y};
  const work=screen.getDisplayNearestPoint({x:Math.round(anchor.x+145),y:Math.round(anchor.y+90)}).workArea;
  const width=Math.min(state.expanded?420:290,work.width),height=Math.min(state.expanded?660:180,work.height);
  // The saved coordinates always describe the pet, not the expanded chat.
  const left=state.expanded&&anchor.x+width>work.x+work.width;
  const up=state.expanded&&anchor.y+height>work.y+work.height;
  const x=Math.round(Math.max(work.x,Math.min(anchor.x-(left?width-290:0),work.x+work.width-width)));
  const y=Math.round(Math.max(work.y,Math.min(anchor.y-(up?height-180:0),work.y+work.height-height)));
  anchorOffset={x:anchor.x-x,y:anchor.y-y};
  state.expandUp=up;state.expandLeft=left;
  requestedBounds={x,y,width,height};
  window.setBounds(requestedBounds);
 }
 function open(){
  if(window&&!window.isDestroyed()){publish();return;}
  const work=screen.getDisplayNearestPoint(bounds&&Number.isFinite(bounds.x)&&Number.isFinite(bounds.y)?{x:bounds.x,y:bounds.y}:screen.getCursorScreenPoint()).workArea;
  const x=Math.round(Math.max(work.x,Math.min(Number.isFinite(bounds?.x)?bounds.x:work.x+work.width-310,work.x+work.width-290)));
  const y=Math.round(Math.max(work.y,Math.min(Number.isFinite(bounds?.y)?bounds.y:work.y+work.height-210,work.y+work.height-180)));
  window=new BrowserWindow({width:290,height:180,x,y,frame:false,transparent:true,resizable:false,maximizable:false,minimizable:false,alwaysOnTop:true,skipTaskbar:true,show:false,hasShadow:false,webPreferences:{preload:path.join(rootDir,'pet-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.setAlwaysOnTop(true,'screen-saver');window.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  bounds={x,y};fit();
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.once('ready-to-show',()=>{if(window){window.showInactive();publish();}});
  window.on('moved',()=>{if(window){const position=window.getBounds();const b={...requestedBounds,x:position.x,y:position.y};requestedBounds=b;bounds={x:b.x+anchorOffset.x,y:b.y+anchorOffset.y};persist();}});
  window.on('closed',()=>{window=null;state.enabled=false;persist();notify({...state});});
  window.loadFile(path.join(rootDir,'renderer/pet-window.html'));
 }
 function command(event,action,value){
  const isPet=window&&!window.isDestroyed()&&event.sender===window.webContents;
  if(isPet&&!['close','ready','expand','drag-start','drag-move','drag-end'].includes(action))throw new Error('Unsupported companion command');
  if(action.startsWith('drag-')){
   if(!isPet)throw new Error('Only the companion can move its window.');
   if(action==='drag-start'){const point=screen.getCursorScreenPoint();dragSession={point,lastPoint:point,bounds:{...requestedBounds},expanded:state.expanded};return;}
   if(action==='drag-end'){dragSession=null;return;}
   if(action==='drag-move'&&dragSession){
    const point=screen.getCursorScreenPoint();
    if(point.x===dragSession.lastPoint.x&&point.y===dragSession.lastPoint.y)return;
    if(state.expanded!==dragSession.expanded){dragSession=null;return;}
    dragSession.lastPoint=point;
    const x=dragSession.bounds.x+point.x-dragSession.point.x,y=dragSession.bounds.y+point.y-dragSession.point.y;
    // Keep the original geometry throughout this gesture, rather than reading
    // back DPI-rounded dimensions on every move and accumulating their error.
    const scale=screen.getDisplayNearestPoint(point).scaleFactor;
    // Integer DIP coordinates must retain their physical-pixel phase. At 175%
    // the repeat interval is 4 DIPs; rounding each edge independently changes size.
    let step=1;while(step<100&&Math.abs(step*scale-Math.round(step*scale))>1e-6)step++;
    const alignedDelta=value=>Math.round(value/step)*step;
    requestedBounds={...dragSession.bounds,x:dragSession.bounds.x+alignedDelta(x-dragSession.bounds.x),y:dragSession.bounds.y+alignedDelta(y-dragSession.bounds.y)};
    window.setBounds(requestedBounds);
    return;
   }
   return;
  }
  if(action==='get')return {...state};
  if(action==='ready'){publish();return {...state};}
  if(action==='expand'){state.expanded=value===true;fit();persist();publish();if(state.expanded)window?.focus();return {...state};}
  if(action==='close'){state.enabled=false;persist();if(window)window.close();publish();return {...state};}
  if(action==='configure'){
   if(!value||typeof value!=='object')throw new Error('Invalid companion settings');
   if(typeof value.enabled==='boolean')state.enabled=value.enabled;
   if(['cat','owl','bulldog'].includes(value.kind))state.kind=value.kind;
   if(typeof value.motion==='boolean')state.motion=value.motion;
   persist();if(state.enabled)open();else if(window)window.close();publish();return {...state};
  }
  if(action==='activity'){if(['idle','typing','waiting','thinking','responding','searching','reading','writing','running','checking','blocked','complete','error','cancelled'].includes(value)){state.activity=value;publish();}return;}
  if(action==='reset'){const w=screen.getPrimaryDisplay().workArea;bounds={x:w.x+w.width-310,y:w.y+w.height-210};fit();persist();return;}
  throw new Error('Unknown companion command');
 }
 const displayChanged=()=>fit();screen.on('display-metrics-changed',displayChanged);screen.on('display-removed',displayChanged);
 return {command,send(channel,payload){if(window&&!window.isDestroyed())window.webContents.send(channel,payload);},refreshTheme:publish,owns(sender){return !!window&&!window.isDestroyed()&&sender===window.webContents;},restore(){if(state.enabled)open();},destroy(){screen.removeListener('display-metrics-changed',displayChanged);screen.removeListener('display-removed',displayChanged);if(window){window.removeAllListeners('closed');window.destroy();window=null;}}};
}
