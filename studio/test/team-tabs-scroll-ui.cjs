'use strict';
// Deterministic directional scrolling in the real renderer. Disposable profile;
// no provider calls or changes to the installed application.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-directional-tabs-'));
app.setPath('userData', root);
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ theme: 'light', telemetrySources: [] }));
fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify([{ name: 'Fixture', dir: root }]));
const store = new AgentStore(path.join(root, 'agents.json'));
const fixture = store.create({ name: 'Directional team tabs', dir: root });
let win;
const errors = [];
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, message) {
  for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay(30); }
  throw new Error(message);
}
const timeout = setTimeout(() => { console.error('Directional tabs timed out', root); app.exit(1); }, 60000);
(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof ReachTeamDeck !== "undefined" && document.querySelector("#agent-project-select option")', 'Renderer did not initialize');
  await run(`(async () => {
    setDrawer(false); await showTab('agents'); await selectAgent({id:${JSON.stringify(fixture.id)}});
    startTeamRunView('directional', {id:'fixture-team',name:'Team1',mode:'links'}, 'Check directional scrolling');
    window.deck = activeTeamRun.deck;
    for (let i=0;i<8;i++) teamCard(i,'Member '+i,'fixture');
    window.rail = deck.element.querySelector('.team-deck-nav');
    const tail = document.createElement('div'); tail.style.height='5000px'; chatLog.append(tail);
    composerInput.focus();
  })()`);
  for (const [width, height, zoom] of [[1440,900,1],[1000,640,1],[1420,980,1.25]]) {
    win.setContentSize(width,height); win.webContents.setZoomFactor(zoom);
    await run('chatScroll.scrollTop=0'); await delay(120);
    await run('chatScroll.scrollTop=100');
    await until(`rail.classList.contains('is-floating') && !rail.inert`, 'Tabs follow near the top');
    await run('chatScroll.scrollTop=2400');
    await until(`rail.classList.contains('is-concealed') && rail.inert`, 'Downward scrolling past the breakpoint hides tabs');
    const before = await run('({height:chatScroll.scrollHeight,top:chatScroll.scrollTop})');
    await run('chatScroll.scrollTop-=3');
    await until(`!rail.classList.contains('is-concealed') && !rail.inert`, 'Small upward movement recalls tabs beyond the whole deck');
    assert.equal(await run('chatScroll.scrollHeight'), before.height, 'Showing tabs does not resize history');
    assert.ok(Math.abs(await run('chatScroll.scrollTop') - (before.top - 3)) < 1, 'Showing tabs does not jump scroll position');
    assert.ok(await run('Math.abs(rail.getBoundingClientRect().top-chatScroll.getBoundingClientRect().top)<1'), 'Tabs pin to conversation viewport at any depth');
    assert.equal(await run(`document.querySelectorAll('.team-deck-nav').length`), 1, 'No duplicate floating rail');
    assert.ok(await run(`rail.querySelector('.team-tabs').scrollWidth > rail.querySelector('.team-tabs').clientWidth`), 'Large teams retain horizontal overflow');
    fs.writeFileSync(path.join(root, `recalled-${width}.png`), (await win.capturePage()).toPNG());
    await run('chatScroll.scrollTop+=3');
    await until('rail.inert', 'Scrolling back down hides recalled tabs');
    await run('chatScroll.scrollTop=0');
    await until('!rail.inert && !rail.classList.contains("is-floating")', 'Tabs restore in place at the top');
  }
  await run(`deck.unmount(); chatScroll.scrollTop=2000`); await delay(100);
  assert.equal(await run(`rail.classList.contains('is-floating')`), false, 'Unmount removes scroll listeners');
  await run(`deck.mount(chatScroll); chatScroll.scrollTop-=3`);
  await until(`rail.classList.contains('is-floating') && !rail.inert`, 'Remount restores the original rail');
  await run(`deck.dispose(); chatScroll.scrollTop+=20`); await delay(100);
  assert.equal(await run(`rail.classList.contains('is-floating')`), false, 'Disposal removes floating state and listeners');
  assert.deepEqual(errors, []);
  console.log('DIRECTIONAL TEAM TABS UI PASS', root);
  clearTimeout(timeout); app.exit(0);
})().catch(async error => {
  console.error(error.stack, root);
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.capturePage()).toPNG());
  clearTimeout(timeout); app.exit(1);
});
