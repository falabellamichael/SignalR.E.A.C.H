'use strict';
// Exercise the real drawer drag and pinned team rail in a disposable profile.
// No inference calls or changes to saved conversations.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const appRoot = path.resolve(process.argv.find(v => v.startsWith('--app-root='))?.slice(11) || path.join(__dirname, '..'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-team-layout-'));
app.setPath('userData', root);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({theme:'dark',pageLayout:'page-sized',telemetrySources:[],connections:[]}));
fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify([{name:'Layout fixture',dir:root}]));
const store = new AgentStore(path.join(root, 'agents.json'));
const fixture = store.create({name:'Teams sidebar alignment',dir:root});
let win;
const errors = [], samples = [];
app.on('browser-window-created', (_event, window) => {
  win = window;
  window.webContents.setBackgroundThrottling(false);
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', event => {
    if ((event.level === 'error' || event.level >= 3) && !event.message.includes("directive 'frame-ancestors' is ignored")) errors.push(event.message);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i=0;i<100;i++) { if(await run(code)) return; await delay(30); }
  throw Error(label);
}
async function check(label) {
  let sample;
  // Layout writes are deferred out of ResizeObserver delivery. Allow the
  // native window to present those frames before checking final geometry.
  for(let attempt=0;attempt<30;attempt++) {
    await delay(30);
    sample=await run(`(() => {
    const rail=layoutDeck.element.querySelector('.team-deck-nav');
    const a=layoutDeck.element.querySelector('.team-nav-anchor').getBoundingClientRect(),r=rail.getBoundingClientRect();
    return {left:r.left,anchorLeft:a.left,width:r.width,anchorWidth:a.width,top:r.top,anchorTop:a.top,viewport:chatScroll.getBoundingClientRect().top+chatScroll.clientTop,
      floating:rail.classList.contains('is-floating'),compact:rail.classList.contains('is-compact'),connected:layoutDeck.element.isConnected,rects:layoutDeck.element.getClientRects().length,display:getComputedStyle(layoutDeck.element).display,parent:layoutDeck.element.parentElement?.id,activePage:document.querySelector('.page.active')?.id,selected:layoutDeck.element.querySelector('.team-tab[aria-selected=true]')===layoutSelected,
      sameRail:rail===layoutRail,scroll:chatScroll.scrollTop,drawer:drawer.getBoundingClientRect().width,overlay:drawer.classList.contains('overlay')};
    })()`);
    if(sample.floating && Math.abs(sample.left-sample.anchorLeft)<=1 && Math.abs(sample.width-sample.anchorWidth)<=1 && Math.abs(sample.top-sample.viewport)<=1) break;
  }
  samples.push({label,...sample});
  assert.equal(sample.floating,true,label+': rail must stay pinned '+JSON.stringify(sample));
  assert.ok(Math.abs(sample.left-sample.anchorLeft)<=1,label+': rail left is stale '+JSON.stringify(sample));
  assert.ok(Math.abs(sample.width-sample.anchorWidth)<=1,label+': rail width is stale '+JSON.stringify(sample));
  assert.ok(Math.abs(sample.top-sample.viewport)<=1,label+': rail top is stale '+JSON.stringify(sample));
  assert.equal(sample.sameRail,true,label+': rail DOM must be retained');
  assert.equal(sample.selected,true,label+': selected member must be retained');
  assert.equal(sample.compact,false,label+': sidebar changes must not fold the tabs');
  assert.equal(sample.scroll,96,label+': layout changes must not move the reading position');
}
async function dragDrawer(width) {
  const p=await run(`(() => {const r=document.querySelector('#drawer-resizer-x').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+80,width:drawer.getBoundingClientRect().width,hit:document.elementFromPoint(r.left+r.width/2,r.top+80)?.id};})()`);
  assert.equal(p.hit,'drawer-resizer-x','Drawer resize handle must be reachable');
  const zoom=win.webContents.getZoomFactor(),point=x=>({x:Math.round(x*zoom),y:Math.round(p.y*zoom)});
  win.webContents.sendInputEvent({type:'mouseMove',...point(p.x)});
  win.webContents.sendInputEvent({type:'mouseDown',...point(p.x),button:'left',clickCount:1});
  for(let i=1;i<=5;i++) {
    win.webContents.sendInputEvent({type:'mouseMove',...point(p.x-(width-p.width)*i/5)});
    await check('drag '+width+' step '+i);
  }
  win.webContents.sendInputEvent({type:'mouseUp',...point(p.x-(width-p.width)),button:'left',clickCount:1});
  await check('drag '+width+' released');
  assert.ok(Math.abs(await run('drawer.getBoundingClientRect().width')-width)<=2,'Pointer drag must resize the drawer');
}
const timeout=setTimeout(()=>{console.error('TEAM LAYOUT TIMEOUT',root);app.exit(1);},60000);
(async()=>{
  await import(pathToFileURL(path.join(appRoot,'main.mjs')).href);
  await app.whenReady();
  while(!win||win.webContents.isLoading()) await delay(30);
  await until('typeof ReachTeamDeck!=="undefined" && document.querySelector("#agent-project-select option")','Renderer did not initialize');
  await until('currentAgent?.draft === true','Initial project draft did not finish opening');
  win.setContentSize(2100,1000);
  win.showInactive();
  await run(`(async()=>{
    setDrawer(false);await showTab('agents');await selectAgent({id:${JSON.stringify(fixture.id)}});
    if(currentAgent?.id!==${JSON.stringify(fixture.id)})throw Error('Fixture conversation did not open');
    startTeamRunView('layout-fixture',{id:'fixture-team',name:'Qwenstra',mode:'links'},'Keep team tabs aligned while Files moves');
    window.layoutDeck=activeTeamRun.deck;
    for(let i=0;i<3;i++) teamCard(i,['CEO','Coder','Planner'][i],'fixture-model');
    const tail=document.createElement('div');tail.style.height='3000px';chatLog.append(tail);
    window.layoutRail=layoutDeck.element.querySelector('.team-deck-nav');
    window.layoutSelected=layoutDeck.element.querySelector('.team-tab[aria-selected=true]');
    composerInput.value='Preserve this unsent draft';
    chatScroll.scrollTop=100;
  })()`);
  await delay(150);
  await run(`if(currentAgent?.id!==${JSON.stringify(fixture.id)})throw Error('Fixture selection changed');chatScroll.scrollTop=100;`);
  await delay(80);await run('chatScroll.scrollTop=96');
  await check('drawer closed');
  await run('drawer.style.width="420px";setDrawer(true)');
  await check('drawer opened');
  fs.writeFileSync(path.join(root,'drawer-open.png'),(await win.capturePage()).toPNG());
  for(const width of [620,960,1440,960,420]) await dragDrawer(width);
  await run('document.querySelector("#rail-toggle").click()');
  await check('navigation expanded');
  await run('document.querySelector("#rail-toggle").click()');
  await check('navigation collapsed');
  await run('setDrawer(false)');await check('drawer closed again');
  for(const zoom of [1.25,1.5]) {
    win.webContents.setZoomFactor(zoom);await delay(120);
    await check('zoom '+zoom);
    await run('drawer.style.width="420px";setDrawer(true)');await check('zoom drawer open '+zoom);
    await dragDrawer(620);
    await run('setDrawer(false)');await check('zoom drawer closed '+zoom);
  }
  win.webContents.setZoomFactor(1);
  await run('layoutDeck.finish("stopped");syncSelectedTeamRun()');
  for(const mode of ['full-width','page-sized']) {
    await run(`document.documentElement.dataset.pageLayout=${JSON.stringify(mode)};drawer.style.width='420px';setDrawer(true)`);
    await check('retained team '+mode);
    await dragDrawer(620);await dragDrawer(420);
    win.setContentSize(1600,900);await check('window narrowed '+mode);
    win.setContentSize(2100,1000);await check('window widened '+mode);
    await run('setDrawer(false)');await check('retained drawer closed '+mode);
  }
  assert.equal(await run('composerInput.value'),'Preserve this unsent draft');
  await run(`layoutSelected.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));window.layoutSelected=layoutDeck.element.querySelector('.team-tab[aria-selected=true]')`);
  await check('keyboard member selection');
  await run('layoutRail.querySelector(".team-deck-toggle").click()');
  assert.equal(await run('layoutRail.classList.contains("is-compact")'),true);
  await run('layoutRail.querySelector(".team-deck-toggle").click()');
  await check('tabs expanded again');
  await run('chatScroll.scrollTop=2000');
  await until('layoutRail.classList.contains("is-compact")','Downward scrolling must fold the pinned tabs');
  const historyHeight=await run('chatScroll.scrollHeight');
  await run('chatScroll.scrollTop=1996');
  await until('!layoutRail.classList.contains("is-compact")','Upward scrolling must restore the pinned tabs');
  assert.equal(await run('chatScroll.scrollHeight'),historyHeight,'Recalling tabs must not resize history');
  await run('chatScroll.scrollTop=96');
  await check('tabs recalled after scrolling');
  await run('layoutDeck.unmount()');
  assert.equal(await run('layoutRail.classList.contains("is-floating")'),false);
  await run('layoutDeck.mount(chatScroll)');await check('remounted');
  fs.writeFileSync(path.join(root,'layout.png'),(await win.capturePage()).toPNG());
  await run('layoutDeck.dispose();setDrawer(true)');await delay(100);
  assert.equal(await run('layoutRail.classList.contains("is-floating")'),false,'Disposed deck must stay unmounted');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({samples,errors},null,2));
  console.log('TEAM LAYOUT UI PASS',JSON.stringify({samples:samples.length,errors,root}));
  clearTimeout(timeout);app.exit(0);
})().catch(async error=>{
  console.error(error.stack,root);fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({samples,errors},null,2));
  if(win&&!win.isDestroyed())fs.writeFileSync(path.join(root,'failure.png'),(await win.capturePage()).toPNG());
  clearTimeout(timeout);app.exit(1);
});
