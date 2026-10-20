'use strict';
// Real theme controls and team renderer in a disposable, credential-free window.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const appRoot=path.resolve(process.argv.find(v=>v.startsWith('--app-root='))?.slice(11)||path.join(__dirname,'..'));
const {themes,paint}=require(path.join(appRoot,'renderer/theme-data.js'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'reach-team-themes-'));
app.setPath('userData',path.join(root,'profile'));
app.commandLine.appendSwitch('force-device-scale-factor','1');
const url=name=>pathToFileURL(path.join(appRoot,'renderer',name)).href;
fs.writeFileSync(path.join(root,'preload.cjs'),`const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('reach',{initialTheme:{theme:'dark'},setTheme:async()=>({ok:true})});`);
fs.writeFileSync(path.join(root,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${url('styles.css')}"><link rel="stylesheet" href="${url('team-deck.css')}"><script src="${url('theme-data.js')}"></script><script src="${url('theme.js')}"></script><style>
body{display:block;padding:24px;background:var(--bg);color:var(--text)}#controls{display:flex;gap:8px;align-items:center;margin-bottom:20px}#theme-accent-pop{display:none}#fixture{padding:14px;background:var(--surface);border-radius:8px}.team-model-info{margin-bottom:12px}
</style></head><body><div id="controls"><label>Theme <select id="theme-select"></select></label><button id="theme-accent">Accent</button><div id="theme-accent-pop" hidden><div id="theme-sv"><i></i></div><input id="theme-hue" type="range"><input id="theme-tint" type="range" min="0" max="100"><span id="theme-tint-value"></span></div></div><main id="fixture"></main><script src="${url('activity-state.js')}"></script><script src="${url('team-deck.js')}"></script></body></html>`);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:620,webPreferences:{preload:path.join(root,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 const errors=[],samples=[];
 win.webContents.on('console-message',event=>{if(event.level==='error'||event.level>=3)errors.push(event.message);});
 const run=code=>win.webContents.executeJavaScript(code,true);
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const rgb=hex=>'rgb('+hex.slice(1).match(/../g).map(v=>parseInt(v,16)).join(', ')+')';
 const timeout=setTimeout(()=>{console.error('Team theme verification timed out',root);app.exit(1);},45000);
 try {
  await win.loadFile(path.join(root,'index.html'));
  win.showInactive();
  await run(`(() => {
   window.themeDeck=ReachTeamDeck.create({team:{name:'Qwenstra',mode:'links'},task:'Theme verification fixture'});
   document.querySelector('#fixture').append(themeDeck.element);
   for(const [index,name] of ['CEO','Coder','Planner'].entries()) {
    const card=document.createElement('div');card.className='member-card';
    card.innerHTML='<div class="member-head"><div class="member-identity"><strong class="member-name"></strong><span class="member-model"></span></div><span class="member-state">Stopped</span><span class="member-meta">Round 1 · 2s</span><button class="member-control" disabled>Stop</button></div><div class="member-body">Activity saved. Theme verification fixture.</div>';
    themeDeck.add(card,{name,model:index?'gpt-6-astra':'Qwen/Qwen3.8-27B-FP8'});
    themeDeck.update(card,{status:index===2?'completed':'paused',count:2,round:1,steps:[],updatedAt:Date.now(),startedAt:Date.now()-2000});
   }
   window.firstThemeTile=themeDeck.element.querySelector('.team-tab');
   window.otherThemeTile=themeDeck.element.querySelectorAll('.team-tab')[1];
  })()`);
  for(const theme of themes) {
   for(const tint of [0,40,100]) {
    await run(`(() => {
     const tint=document.querySelector('#theme-tint');tint.value='0';tint.dispatchEvent(new Event('input',{bubbles:true}));
     const select=document.querySelector('#theme-select');select.value=${JSON.stringify(theme.id)};select.dispatchEvent(new Event('change',{bubbles:true}));
     tint.value=${JSON.stringify(String(tint))};tint.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await delay(200); // Let the shared button border-color transition settle.
    // setTheme is a fixture; painting still runs through the real theme controls.
    const expected=paint({theme:theme.id,tint});
    const actual=await run(`(() => {
     const selected=getComputedStyle(firstThemeTile),other=getComputedStyle(otherThemeTile),model=getComputedStyle(firstThemeTile.querySelector('.team-tab-model'));
     const panel=getComputedStyle(themeDeck.element.querySelector('.member-card'));
     const complete=getComputedStyle(themeDeck.element.querySelectorAll('.team-orbit')[2]);
     return {theme:document.documentElement.dataset.theme,selected:selected.backgroundColor,normal:other.backgroundColor,text:selected.color,muted:model.color,border:other.borderLeftColor,panel:panel.backgroundColor,success:complete.color,sameTile:firstThemeTile===themeDeck.element.querySelector('.team-tab')};
    })()`);
    const label=theme.id+' tint '+tint;
    assert.equal(actual.theme,theme.id,label);
    assert.equal(actual.normal,rgb(expected.vars.card),label+' card');
    assert.equal(actual.selected,rgb(expected.vars.hover),label+' selection');
    assert.equal(actual.text,rgb(expected.vars.text),label+' text');
    assert.equal(actual.muted,rgb(expected.vars.muted),label+' muted text');
    assert.equal(actual.border,rgb(expected.vars.line),label+' border');
    assert.equal(actual.panel,rgb(expected.vars.card),label+' member panel');
    assert.equal(actual.success,rgb(expected.vars.ok),label+' completion status');
    assert.equal(actual.sameTile,true,label+' retains tile identity');
    samples.push({label,...actual});
    if(tint===0) {
     await delay(40);
     fs.writeFileSync(path.join(root,theme.id+'.png'),(await win.webContents.capturePage({x:0,y:0,width:1100,height:620})).toPNG());
    }
   }
  }
  // The same tiles also repaint when a custom accent arrives from a saved choice.
  const custom=paint({theme:'nord',accent:'#e954b3',tint:60});
  await run(`(() => {for(const [key,value]of Object.entries(${JSON.stringify(custom.vars)}))document.documentElement.style.setProperty('--'+key,value);})()`);
  assert.equal(await run('getComputedStyle(otherThemeTile).backgroundColor'),rgb(custom.vars.card));
  assert.equal(await run('getComputedStyle(firstThemeTile).backgroundColor'),rgb(custom.vars.hover));
  assert.equal(new Set(samples.filter(s=>s.label.endsWith('tint 0')).map(s=>[s.normal,s.selected,s.text,s.muted,s.border].join('|'))).size,themes.length,'Each theme must retain its distinct palette');
  assert.deepEqual(errors,[]);
  await run('themeDeck.dispose()');
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({samples,customAccent:true,errors},null,2));
  console.log('TEAM THEMES UI PASS',JSON.stringify({themes:themes.length,settings:samples.length,customAccent:true,errors,root}));
  clearTimeout(timeout);win.destroy();app.exit(0);
 }catch(error){console.error(error.stack,errors,root);try{fs.writeFileSync(path.join(root,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}clearTimeout(timeout);win.destroy();app.exit(1);}
});
