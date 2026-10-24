'use strict';
// Real drawer handlers and CSS in a disposable renderer; no accounts or runs.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'reach-drawer-resize-')));
const root = path.resolve(__dirname, '../renderer');
const measureOnly = process.argv.includes('--measure');
const settle = win => win.webContents.executeJavaScript('new Promise(resolve=>{setTimeout(resolve,80);requestAnimationFrame(()=>requestAnimationFrame(resolve));})');
const timeout=setTimeout(()=>{console.error('Drawer resize UI timed out');app.exit(1);},30000);
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1500, height: 850, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((request, done) => done({ cancel: request.resourceType === 'script' || /^https?:/.test(request.url) }));
  await win.loadFile(path.join(root, 'index.html'));
  await win.webContents.executeJavaScript(`(() => {
    const $=selector=>document.querySelector(selector),currentProject=null,currentAgent=null,refreshFileTree=()=>{};
    ${fs.readFileSync(path.join(root, 'app-drawer.js'), 'utf8')}
    const originalGuard=applyWidthGuard;
    let checks=0;
    applyWidthGuard=()=>{checks++;originalGuard();};
    window.resizeFixture={
      prepare(){drawer.style.width='420px';setDrawer(true);checks=0;},
      burst(type='pointerup'){
        const handle=$('#drawer-resizer-x'),r=handle.getBoundingClientRect(),x=r.left+3,y=r.top+80;
        handle.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,pointerId:1,button:0,buttons:1,bubbles:true}));
        checks=0;
        for(let i=1;i<=80;i++)window.dispatchEvent(new PointerEvent('pointermove',{clientX:x-i,clientY:y,pointerId:1,buttons:1,bubbles:true}));
        return {checksBeforeFrame:checks};
      },
      finish(type='pointerup') { window.dispatchEvent(new PointerEvent(type,{pointerId:1,bubbles:true})); },
      state(){return {checks,width:drawer.getBoundingClientRect().width,saved:Number(localStorage.getItem('reach:drawer-width')),dragging:document.body.classList.contains('resizing-x'),active:$('#drawer-resizer-x').classList.contains('active'),overlay:drawer.classList.contains('overlay')};},
    };
  })()`);
  const samples=[];
  for(const ending of ['pointerup','pointercancel']) {
    await win.webContents.executeJavaScript('resizeFixture.prepare()');
    await settle(win);
    const before=await win.webContents.executeJavaScript('resizeFixture.burst().checksBeforeFrame');
    if(!measureOnly)assert.equal(before,0,'A burst of moves must wait for one frame instead of forcing layout for every event');
    await win.webContents.executeJavaScript(`resizeFixture.finish(${JSON.stringify(ending)})`);
    await settle(win);
    const result=await win.webContents.executeJavaScript('resizeFixture.state()');
    assert.ok(Math.abs(result.width-500)<1,'Releasing before the scheduled frame must retain the final pointer position');
    assert.equal(result.saved,500,'Final width is persisted');
    assert.equal(result.dragging,false);assert.equal(result.active,false);
    if(!measureOnly)assert.ok(result.checks<=3,'Resize checks must be coalesced');
    samples.push({ending,checksBeforeFrame:before,...result});
  }
  await win.webContents.executeJavaScript('resizeFixture.prepare()');
  await settle(win);
  await win.webContents.executeJavaScript('resizeFixture.burst()');
  await win.webContents.capturePage();
  await settle(win);
  const held=await win.webContents.executeJavaScript('resizeFixture.state()');
  assert.ok(Math.abs(held.width-500)<1,'The width must update while the pointer is still held');
  assert.equal(held.dragging,true);
  if(!measureOnly)assert.equal(held.checks,1,'The entire burst is applied in one drag frame');
  await win.webContents.executeJavaScript('resizeFixture.finish()');
  // Actual browser input retains pointer capture while the divider moves.
  await win.webContents.executeJavaScript('resizeFixture.prepare()');
  await settle(win);
  const start=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#drawer-resizer-x').getBoundingClientRect();return{x:Math.round(r.left+3),y:Math.round(r.top+80)};})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...start});
  win.webContents.sendInputEvent({type:'mouseDown',...start,button:'left',clickCount:1});
  for(let i=1;i<=12;i++) { win.webContents.sendInputEvent({type:'mouseMove',x:start.x-i*10,y:start.y});await settle(win); }
  win.webContents.sendInputEvent({type:'mouseUp',x:start.x-120,y:start.y,button:'left',clickCount:1});
  await settle(win);
  const native=await win.webContents.executeJavaScript('resizeFixture.state()');
  assert.ok(Math.abs(native.width-540)<1);assert.equal(native.saved,540);assert.equal(native.dragging,false);
  await win.webContents.executeJavaScript(`(() => {
    const drawer=document.querySelector('#file-drawer');drawer.dataset.panel='singular';drawer.style.width='600px';
    const panel=document.createElement('section');panel.id='singular-panel';
    panel.innerHTML='<div class="singular-col-info"><div style="min-height:2200px">Scrollable info</div></div><section class="singular-col-team"><h3>Team</h3></section>';
    drawer.append(panel);document.querySelector('.singular-col-info').scrollTop=180;
    const home=document.querySelector('.home-scroll');home.firstElementChild.style.minHeight='2200px';home.scrollTop=120;
  })()`);
  await win.webContents.capturePage();await settle(win);
  const scrollState=()=>win.webContents.executeJavaScript(`(() => {const info=document.querySelector('.singular-col-info'),home=document.querySelector('.home-scroll');return {info:info.scrollTop,home:home.scrollTop,overflow:info.scrollWidth>info.clientWidth,overlay:document.querySelector('#file-drawer').classList.contains('overlay')};})()`);
  const scrollingBefore=await scrollState();
  const dragPoint=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#drawer-resizer-x').getBoundingClientRect();return{x:Math.round(r.left+3),y:Math.round(r.top+80)};})()`);
  win.webContents.sendInputEvent({type:'mouseDown',...dragPoint,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',x:dragPoint.x-200,y:dragPoint.y});
  await win.webContents.capturePage();await settle(win);
  win.webContents.sendInputEvent({type:'mouseUp',x:dragPoint.x-200,y:dragPoint.y,button:'left',clickCount:1});
  await settle(win);
  const scrollingAfter=await scrollState();
  assert.equal(scrollingAfter.info,scrollingBefore.info);assert.equal(scrollingAfter.home,scrollingBefore.home);
  assert.equal(scrollingAfter.overflow,false);assert.equal(scrollingBefore.overlay,false);assert.equal(scrollingAfter.overlay,true);
  const painted=[];
  for(const theme of ['light','dark']) {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('#file-drawer').style.width='600px'`);
    await win.webContents.capturePage();await settle(win);
    const point=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#drawer-resizer-x').getBoundingClientRect();return{x:Math.round(r.left+3),y:Math.round(r.top+80)};})()`);
    win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
    for(const width of [620,660,700,760,800,740,680,600]) {
      win.webContents.sendInputEvent({type:'mouseMove',x:point.x-(width-600),y:point.y});
      await win.webContents.capturePage();await settle(win);
      const geometry=await win.webContents.executeJavaScript(`(()=>{const el=document.querySelector('.singular-col-info'),r=el.getBoundingClientRect();const probe=document.createElement('span');probe.style.color='var(--line)';el.append(probe);const ink=getComputedStyle(probe).color.match(/\\d+/g).map(Number);probe.remove();return{x:r.right-6,y:r.top+100,viewportWidth:innerWidth,viewportHeight:innerHeight,ink,scroll:el.scrollTop,gutter:el.offsetWidth-el.clientWidth};})()`);
      const capture=await win.webContents.capturePage(),bitmap=capture.toBitmap(),size=capture.getSize();
      const pixelX=Math.round(geometry.x*size.width/geometry.viewportWidth),pixelY=Math.round(geometry.y*size.height/geometry.viewportHeight);
      const offset=(pixelY*size.width+pixelX)*4;
      const channels=[bitmap[offset],bitmap[offset+1],bitmap[offset+2]];
      const error=rgb=>Math.max(...rgb.map((value,index)=>Math.abs(value-geometry.ink[index])));
      assert.ok(Math.min(error(channels),error([...channels].reverse()))<=3,`Scrollbar thumb must remain painted during ${theme} drag at ${width}px: ${JSON.stringify({geometry,size,channels})}`);
      assert.equal(geometry.scroll,180);assert.ok(geometry.gutter>=10&&geometry.gutter<=13);
      painted.push({theme,width,thumbPainted:true,scroll:geometry.scroll});
    }
    win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});await settle(win);
  }
  console.log(JSON.stringify({measureOnly,samples,held,native,scrollingBefore,scrollingAfter,paintedFrames:painted.length},null,2));
  clearTimeout(timeout);win.destroy();app.exit(0);
})().catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1);});
