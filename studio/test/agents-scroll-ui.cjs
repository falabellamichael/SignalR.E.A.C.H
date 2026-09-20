'use strict';
// Real Electron layout and wheel input with an isolated profile. No provider
// requests, user conversations or installed-app state are touched.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const { reduce } = require('../renderer/activity-state.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-agents-scroll-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [] }));
fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Scroll fixture', dir: project }]));
const store = new AgentStore(path.join(profile, 'agents.json'));
const fixture = store.create({ name: 'A long conversation with expandable activity', dir: project });
const report = Array.from({ length: 80 }, (_, i) => `Finding ${i + 1}: the conversation remains readable while work continues.`).join('\n\n');
store.setMessages(fixture.id, [{ role: 'user', content: 'Review this project.' }, { role: 'assistant', content: report }]);
store.setTodos(fixture.id, Array.from({ length: 30 }, (_, i) => ({ text: `Review component ${i}`, status: 'completed' })));
let activity = null;
for (let i = 0; i < 20; i++) {
  activity = reduce(activity, { type: 'tool-call', tool: 'read', arguments: { path: `component-${i}.js` } });
  activity = reduce(activity, { type: 'tool-result', ok: true, result: { content: report } });
}
activity = reduce(activity, { type: 'run-state', status: 'completed', reason: 'Review complete.' });
store.setActivity(fixture.id, activity);
store.setRunState(fixture.id, { status: 'completed', reason: 'Review complete.' });
let win;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
app.on('browser-window-created', (_event, window) => { win = window; });
async function until(code, label) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await run(code)) return; await delay(30); }
  throw new Error(label);
}
async function wheelOver(selector, delta = -180) {
  win.focus(); win.webContents.focus();
  await delay(100);
  const point = await run(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    const viewport = chatScroll.getBoundingClientRect();
    return { x: Math.round(rect.left + Math.min(rect.width / 2, 100)),
      y: Math.round(Math.max(rect.top, viewport.top) + Math.min(30, (Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top)) / 2)) };
  })()`);
  const hit = await run(`document.elementFromPoint(${point.x},${point.y})?.closest(${JSON.stringify(selector)}) !== null`);
  assert.equal(hit, true, 'Wheel target must be visible: ' + selector);
  const zoom = win.webContents.getZoomFactor();
  const position = {x:Math.round(point.x * zoom),y:Math.round(point.y * zoom)};
  win.webContents.sendInputEvent({ type: 'mouseMove', ...position });
  win.webContents.sendInputEvent({ type: 'mouseWheel', ...position, deltaY: delta, deltaX: 0 });
  await delay(180);
}
const timeout = setTimeout(() => { console.error('Agents scroll UI timed out'); app.exit(1); }, 60000);
(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof selectAgent === "function" && document.querySelector("#agent-project-select option")', 'Renderer did not initialize');
  win.show();
  for (const [width, height, zoom, drawer] of [[1440, 900, 1, false], [1000, 640, 1, true], [1420, 980, 1.25, true]]) {
    win.setSize(width, height); win.webContents.setZoomFactor(zoom);
    await run(`(async () => { await showTab('agents'); await selectAgent({id:${JSON.stringify(fixture.id)}}); setDrawer(${drawer}); })()`);
    await until(`document.querySelector('#agent-activity .activity-count').textContent.includes('20 steps')`, 'Activity did not load');
    await delay(250);
    assert.equal(await run(`document.querySelector('#agent-activity').closest('#chat-scroll') !== null`), true, 'Activity details belong to the shared conversation scroller');
    const fixedBefore = await run(`({header:document.querySelector('#agent-model-info').getBoundingClientRect().toJSON(), composer:document.querySelector('.composer').getBoundingClientRect().toJSON()})`);
    await run(`chatScroll.scrollTop = 0; document.querySelector('#agent-activity .activity-details').open = true; document.querySelector('#agent-activity .activity-result').open = true;`);
    await delay(100);
    const fixedAfter = await run(`({header:document.querySelector('#agent-model-info').getBoundingClientRect().toJSON(), composer:document.querySelector('.composer').getBoundingClientRect().toJSON()})`);
    assert.ok(Math.abs(fixedBefore.header.bottom - fixedAfter.header.bottom) <= 1, 'Expanded activity must not resize the pinned header');
    assert.ok(Math.abs(fixedBefore.composer.top - fixedAfter.composer.top) <= 1, 'Expanded activity must not displace the composer');
    assert.equal(await run(`(() => {
      const scrollers = [...chatScroll.querySelectorAll('*')].filter(el =>
        el.getBoundingClientRect().height > 0 && el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(el).overflowY));
      return scrollers.map(el => el.className).join(',');
    })()`), '', 'Activity and results must not trap the wheel in nested vertical scroll areas');
    await wheelOver('#agent-activity .activity-result pre');
    assert.ok(await run('chatScroll.scrollTop > 20'), 'Wheel over activity results must scroll the conversation');
    await run('chatScroll.scrollTop = chatScroll.scrollHeight');
    assert.equal(await run(`(() => { const r = chatLog.lastElementChild.getBoundingClientRect(), s = chatScroll.getBoundingClientRect(); return r.bottom <= s.bottom + 1 && r.bottom > s.top; })()`), true, 'The last answer must be reachable');
    assert.equal(await run(`document.body.scrollHeight <= innerHeight + 1 && document.querySelector('.composer').getBoundingClientRect().bottom <= innerHeight`), true, 'The window and composer must stay within the viewport');
    assert.equal(await run(`document.querySelector('#agent-model-info').getBoundingClientRect().top`), fixedBefore.header.top, 'Header stays stationary');
    await run(`document.querySelector('#agent-activity .activity-details').open = false; chatScroll.scrollTop = 0`);
    await delay(50);
    fs.writeFileSync(path.join(root, `agents-${width}-${zoom}.png`), (await win.capturePage()).toPNG());
  }
  win.webContents.setZoomFactor(1); win.setSize(1440, 900);
  await run(`setDrawer(false); chatScroll.scrollTop = Math.min(400, chatScroll.scrollHeight / 3)`);
  const readingAt = await run('chatScroll.scrollTop');
  await run(`handleAgentEvent({agentId:currentAgent.id,type:'message-start',role:'assistant'}); handleAgentEvent({agentId:currentAgent.id,type:'delta',text:${JSON.stringify(report)}}); appendToolCallMessage('read',{path:'next.js'}); appendToolCard('read',true,false,null,'result');`);
  await delay(200);
  assert.ok(Math.abs(await run('chatScroll.scrollTop') - readingAt) <= 1, 'Streaming and tool events must not pull a reader to the bottom');
  await run(`chatScroll.scrollTop = chatScroll.scrollHeight; handleAgentEvent({agentId:currentAgent.id,type:'delta',text:${JSON.stringify(report)}});`);
  assert.ok(await run('chatScroll.scrollHeight - chatScroll.clientHeight - chatScroll.scrollTop <= 1'), 'A reader at the bottom still follows new output');
  await run(`handleAgentEvent({agentId:currentAgent.id,type:'message-end',role:'assistant',content:'Finished.'});`);
  await run(`(() => {
    startTeamRunView('scroll-team', {name:'Scroll team',mode:'parallel'},'Scroll regression');
    window.scrollTeam = activeTeamRun;
    handleTeamEvent({teamRunId:'scroll-team',type:'start',members:Array.from({length:7},(_,index)=>({index,agentId:'scroll-'+index,name:'Worker '+index,model:'fixture'}))});
    handleTeamEvent({teamRunId:'scroll-team',type:'member',index:0,memberType:'message-end',content:${JSON.stringify(report)}});
    const group = ensureEditReviewGroup({key:'team:scroll-team',host:scrollTeam.deck.reviews,title:'Proposed changes',actor:'Scroll team',resolve:async()=>({ok:true})});
    appendEditCardToGroup(group,{editId:'scroll-edit',path:'example.js',stats:{added:100,removed:0},hunks:Array.from({length:100},(_,i)=>({type:'add',text:'line '+i}))});
    group.element.open=true; group.cards.get('scroll-edit').element.open=true;
    chatScroll.scrollTop = scrollTeam.wrap.offsetTop;
  })()`);
  await delay(200);
  assert.equal(await run(`getComputedStyle(scrollTeam.cards.get(0).querySelector('.member-body')).maxHeight`), 'none', 'Team replies must flow in the shared scroller');
  assert.equal(await run(`getComputedStyle(scrollTeam.wrap.querySelector('.diff-body')).maxHeight`), 'none', 'Expanded edits must flow in the shared scroller');
  await run(`chatScroll.scrollTop = scrollTeam.wrap.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top + chatScroll.scrollTop + 40`);
  const navTop = await run(`scrollTeam.wrap.querySelector('.team-deck-nav').getBoundingClientRect().top`);
  const teamReadingAt = await run('chatScroll.scrollTop');
  await wheelOver('.team-deck .member-body');
  assert.ok(await run('chatScroll.scrollTop') > teamReadingAt + 20, 'Wheel over a team answer must scroll the page');
  assert.ok(Math.abs(await run(`scrollTeam.wrap.querySelector('.team-deck-nav').getBoundingClientRect().top`) - navTop) <= 1, 'Team tabs remain pinned while member content scrolls');
  await run(`handleTeamEvent({teamRunId:'scroll-team',type:'member',index:0,memberType:'request-start'}); handleTeamEvent({teamRunId:'scroll-team',type:'member',index:0,memberType:'reasoning',chars:1200});`);
  await until(`scrollTeam.wrap.querySelector('.team-tab-action').textContent.includes('Thinking')`, 'Pinned team tab should retain live status');
  fs.writeFileSync(path.join(root, 'team-scroll.png'), (await win.capturePage()).toPNG());
  await run(`(() => {
    const diff = scrollTeam.wrap.querySelector('.diff-body');
    chatScroll.scrollTop += diff.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top - scrollTeam.wrap.querySelector('.team-deck-nav').getBoundingClientRect().height - 20;
  })()`);
  const reviewAt = await run('chatScroll.scrollTop');
  await delay(200);
  await wheelOver('.team-deck .diff-body');
  const reviewAfter = await run(`({top:chatScroll.scrollTop, height:chatScroll.scrollHeight, client:chatScroll.clientHeight, diff:scrollTeam.wrap.querySelector('.diff-body').getBoundingClientRect().toJSON(), nav:scrollTeam.wrap.querySelector('.team-deck-nav').getBoundingClientRect().toJSON()})`);
  assert.ok(reviewAfter.top > reviewAt + 20, 'Wheel over an expanded edit must scroll the conversation: ' + JSON.stringify({before:reviewAt,after:reviewAfter}));
  await run(`chatScroll.scrollTop = 0; chatScroll.focus()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'PageDown'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'PageDown'});
  await delay(250);
  assert.ok(await run('chatScroll.scrollTop') > 20, 'Keyboard users can scroll the shared conversation');
  for (const [width,height,zoom] of [[1000,640,1],[1420,980,1.25]]) {
    win.setSize(width,height); win.webContents.setZoomFactor(zoom);
    await run('setDrawer(true)'); await delay(200);
    await run('chatScroll.scrollTop += scrollTeam.wrap.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top + 40');
    const room = await run(`({available:chatScroll.getBoundingClientRect().bottom-scrollTeam.wrap.querySelector('.team-deck-nav').getBoundingClientRect().bottom, viewport:chatScroll.clientHeight})`);
    assert.ok(room.available >= 60, 'Pinned team header must leave room to read and scroll: ' + JSON.stringify({width,height,zoom,...room}));
  }
  assert.deepEqual(await run('window.__errors'), [], 'Renderer must remain error-free');
  console.log('AGENTS SCROLL UI OK: shared vertical scrolling, wheel over results and team replies, stationary live headers and composer, readable history during streaming, tail-follow, minimum window and zoom.');
  console.log('Evidence: ' + root);
  clearTimeout(timeout); app.exit(0);
})().catch(async error => { console.error(error.stack || error); if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root,'failure.png'),(await win.capturePage()).toPNG()); console.error('Evidence: ' + root); clearTimeout(timeout); app.exit(1); });
