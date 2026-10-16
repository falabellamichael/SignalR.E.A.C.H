'use strict';
// Run with Electron: render the actual installed or source popup without real data.
const {app,BrowserWindow,ipcMain,session}=require('electron');
process.on('uncaughtException',error=>{console.error(error.stack);app.exit(1);});
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'reach-billing-popup-'));
app.setPath('userData',path.join(temp,'profile'));
const output=process.argv[2]||temp,archive=process.argv[3]||path.resolve(__dirname,'../renderer'),mode=process.argv[4]||'verify';
fs.mkdirSync(output,{recursive:true});
let renderer;
if(archive.endsWith('.asar')){require('@electron/asar').extractAll(archive,path.join(temp,'app'));renderer=path.join(temp,'app/renderer');}
else renderer=path.resolve(archive);
const html=fs.readFileSync(path.join(renderer,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>','<script src="account-view.js"></script><script src="account-menu.js"></script><script src="account.js"></script></body>');
const fixture=path.join(temp,'fixture');fs.cpSync(renderer,fixture,{recursive:true});fs.writeFileSync(path.join(fixture,'index.html'),html);
fs.writeFileSync(path.join(temp,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('reach',{account:{get:()=>ipcRenderer.invoke('fixture:get'),refresh:()=>ipcRenderer.invoke('fixture:refresh'),onState:fn=>ipcRenderer.on('fixture:state',(_e,state)=>fn(state)),subscribe:(...args)=>ipcRenderer.invoke('fixture:subscribe',...args),billing:()=>ipcRenderer.invoke('fixture:billing')}});`);
const plus={id:'plus',name:'REACH Subscription Plus',currency:'cad',amountMinor:2500,interval:'month',intervalCount:1,taxBehavior:'inclusive',unlimited:true};
let state={status:'disconnected',baseUrl:'https://fixture.invalid',secureStorageAvailable:true,config:{cardPayments:false,paypalPayments:false,redemptionEnabled:false,subscription:{basic:{id:'basic-wallet',includedRequests:1500,priceUsdMicros:15000000},overageUsdMicrosPerRequest:10000},redemptionModels:[]}};
const actions=[],errors=[],warnings=[],network=[];let win;
ipcMain.handle('fixture:get',()=>state);ipcMain.handle('fixture:refresh',()=>({ok:true,state}));ipcMain.handle('fixture:subscribe',(_e,...args)=>{actions.push(args);return {ok:true};});ipcMain.handle('fixture:billing',()=>({ok:true}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),run=code=>win.webContents.executeJavaScript(code,true);
async function publish(next){state=next;win.webContents.send('fixture:state',state);await delay(150);}
async function measure(label,width,height){
 win.setContentSize(width,height);await delay(150);await run("ReachAccountMenu.open('usage');document.querySelector('#home-card-plan-detail').scrollIntoView({block:'center'})");await delay(200);
 const data=await run(`(()=>{const card=document.querySelector('#home-card-plan-detail').closest('article');const nodes=[...card.children].filter(e=>getComputedStyle(e).display!=='none');const rect=e=>{const r=e.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(e);return {id:e.id,tag:e.tagName,top:r.top,bottom:r.bottom,contentBottom:Math.max(r.bottom,range.getBoundingClientRect().bottom),left:r.left,right:r.right,height:r.height,scrollHeight:e.scrollHeight}};const boxes=nodes.map(rect);return {description:document.querySelector('#home-card-plan-detail').textContent,badge:document.querySelector('#home-card-badge').textContent,visibleButtons:[...card.querySelectorAll('button')].filter(e=>getComputedStyle(e).display!=='none').map(e=>({id:e.id,text:e.textContent,disabled:e.disabled})),children:boxes,overlaps:boxes.slice(1).map((e,i)=>({previous:boxes[i].id||nodes[i].className,next:e.id||nodes[i+1].className,delta:e.top-boxes[i].contentBottom})).filter(x=>x.delta < -0.5),cardContainsContent:Math.max(...boxes.map(b=>b.contentBottom))<=card.getBoundingClientRect().bottom+0.5}})()`);
 const result={label,width,height,...data};fs.writeFileSync(path.join(output,label+'.json'),JSON.stringify(result,null,2)+'\n');
 try{fs.writeFileSync(path.join(output,label+'.png'),(await win.capturePage()).toPNG());}catch(error){result.captureError=error.message;}
 if(mode==='verify'){assert.deepEqual(data.overlaps,[],label+' text and controls must not overlap');assert.equal(data.cardContainsContent,true,label+' content must stay inside the card');}return result;
}
const timeout=setTimeout(()=>{console.error('Popup render timed out');app.exit(1);},60000);
(async()=>{
 await app.whenReady();const partition=session.fromPartition('billing-popup-fixture');partition.webRequest.onBeforeRequest((request,done)=>{const block=/^https?:/i.test(request.url);if(block)network.push(request.url);done({cancel:block});});
 win=new BrowserWindow({show:false,width:1000,height:820,webPreferences:{preload:path.join(temp,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,session:partition}});
 win.webContents.on('console-message',event=>{if(event.level==='error'){if(event.message.includes("frame-ancestors' is ignored when delivered via a <meta>"))warnings.push(event.message);else errors.push(event.message);}});await win.loadFile(path.join(fixture,'index.html'));await delay(400);
 const results=[];for(const [width,height] of [[1000,820],[720,540],[420,620]])results.push(await measure('unconfigured-'+width,width,height));
 if(mode==='verify'){for(const row of results){assert.match(row.description,/not enabled|not yet available/);assert.doesNotMatch(row.description,/Subscribe to Basic/);assert.equal(row.visibleButtons.length,0,'No purchase action when provider is unconfigured');}}
 await publish({...state,status:'connected',account:{plan:{status:'none'},allowedModels:[],requestAllowance:{basicActive:false,remaining:0}},config:{...state.config,cardPayments:true,cardPlans:{basic:false,plus:true},subscription:{...state.config.subscription,plus}}});
 const ready=await measure('plus-ready',1000,820);results.push(ready);if(mode==='verify'){assert.match(ready.description,/CAD25\.00.*tax included/);assert.equal(ready.visibleButtons.find(b=>b.id==='home-card-subscribe-plus')?.disabled,false);await run("document.querySelector('#home-card-subscribe-plus').click()");await delay(50);assert.deepEqual(actions,[['stripe','plus']]);}
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({mode,source:archive,results,rendererErrors:errors,existingMetaCspWarnings:warnings,externalRequests:network},null,2)+'\n');console.log('POPUP '+mode.toUpperCase()+' COMPLETE: '+JSON.stringify(results.map(r=>({label:r.label,overlaps:r.overlaps,buttons:r.visibleButtons.length}))));clearTimeout(timeout);win.destroy();app.exit(0);
})().catch(error=>{console.error(error.stack);console.error('Renderer errors: '+errors.join(' | '));clearTimeout(timeout);app.exit(1);});
