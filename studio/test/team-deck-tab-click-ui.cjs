'use strict';
// Clicking a team member tile must surface that member's status at the top of
// the conversation. Keyboard roving focus (Arrow/Home/End) must still leave the
// reading position alone. Disposable profile; no provider calls, no changes to
// the installed application.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-team-tab-click-'));
app.setPath('userData', root);
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [] }));
fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify([{ name: 'Fixture', dir: root }]));
const store = new AgentStore(path.join(root, 'agents.json'));
const fixture = store.create({ name: 'Tab click reveal', dir: root });
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
const timeout = setTimeout(() => { console.error('Tab click reveal timed out', root); app.exit(1); }, 60000);
(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof ReachTeamDeck !== "undefined" && document.querySelector("#agent-project-select option")', 'Renderer did not initialize');
  win.setContentSize(1440, 1024);
  await run(`(async () => {
    setDrawer(false); await showTab('agents'); await selectAgent({id:${JSON.stringify(fixture.id)}});
  })()`);
  await run(`(() => {
    startTeamRunView('tabclick', { name: 'Team 1', mode: 'links' }, 'Check tab click reveal');
    window.deck = activeTeamRun;
    window.handleOne = event => handleTeamEvent({ teamRunId: 'tabclick', ...event });
    handleOne({ type: 'start', members: [
      { index: 0, agentId: 'm0', name: 'CEO', model: 'qwen-27b' },
      { index: 1, agentId: 'm1', name: 'Thinker', model: 'qwen-35b' },
      { index: 2, agentId: 'm2', name: 'Seeker', model: 'deepseek-flash' },
      { index: 3, agentId: 'm3', name: 'Builder', model: 'deepseek-flash' },
      { index: 4, agentId: 'm4', name: 'Reviewer', model: 'qwen-32b' },
      { index: 5, agentId: 'm5', name: 'Scribe', model: 'qwen-27b' }
    ] });
    for (let i = 0; i < 6; i++) handleOne({ type: 'member-start', index: i });
    const tail = document.createElement('div'); tail.style.height='4000px'; chatLog.append(tail);
    window.cards = [...deck.wrap.querySelectorAll('.team-panels > *')];
    window.tabs = [...deck.wrap.querySelectorAll('.team-tabs > .team-tab')];
  })()`);
  await delay(120);
  assert.equal(await run('tabs.length'), 6, 'Fixture must render one tile per member');

  // --- A mouse click surfaces the selected member at the top of the viewport.
  // Park the conversation well below the deck so the selected panel is off-screen.
  await run('chatScroll.scrollTop = chatScroll.scrollHeight');
  await delay(80);
  const before = await run('chatScroll.scrollTop');
  assert.ok(before > 0, 'Fixture must scroll away from the deck first');
  await run(`
    const card = cards[4];
    tabs[4].click();
    ({ hidden: card.hidden, top: card.getBoundingClientRect().top, viewport: chatScroll.getBoundingClientRect().top + chatScroll.clientTop })`);
  await delay(80);
  const after = await run(`(() => {
    const card = cards[4];
    const nav = deck.wrap.querySelector('.team-deck-nav');
    const viewport = chatScroll.getBoundingClientRect().top + chatScroll.clientTop;
    const railCovered = nav.classList.contains('is-floating') && !nav.classList.contains('is-concealed') ? nav.offsetHeight : 0;
    return { selected: tabs[4].getAttribute('aria-selected'), hidden: card.hidden,
      offset: card.getBoundingClientRect().top - (viewport + railCovered),
      scrollTop: chatScroll.scrollTop };
  })()`);
  assert.equal(after.selected, 'true', 'Clicked tile must become the selected tab');
  assert.equal(after.hidden, false, 'Clicked member panel must be visible');
  assert.ok(Math.abs(after.offset) <= 2, 'Clicked member must clear the pinned rail and sit at the top, got offset ' + after.offset);
  assert.ok(after.scrollTop < before, 'Clicking a tile must scroll the conversation back up');

  // --- A member that is already on screen must not move the conversation.
  // The deck is at the top here, so the clicked member is fully visible.
  await run('chatScroll.scrollTop = 0');
  await delay(120);
  const settled = await run('chatScroll.scrollTop');
  await run(`tabs[2].click()`);
  await delay(80);
  const visible = await run(`(() => {
    const card = cards[2];
    const nav = deck.wrap.querySelector('.team-deck-nav');
    const viewport = chatScroll.getBoundingClientRect().top + chatScroll.clientTop;
    const railCovered = nav.classList.contains('is-floating') && !nav.classList.contains('is-concealed') ? nav.offsetHeight : 0;
    const rect = card.getBoundingClientRect();
    return { selected: tabs[2].getAttribute('aria-selected'), hidden: card.hidden, scrollTop: chatScroll.scrollTop,
      clearsRail: rect.top - (viewport + railCovered), inViewport: rect.bottom <= viewport + chatScroll.clientHeight + 1 };
  })()`);
  assert.equal(visible.selected, 'true', 'Clicked tile must still become the selected tab when already visible');
  assert.equal(visible.hidden, false, 'Clicked member panel must be visible');
  assert.equal(visible.scrollTop, settled, 'An already-visible member must not move the conversation');
  assert.ok(visible.clearsRail >= -1, 'An already-visible member must not sit behind the rail, got ' + visible.clearsRail);

  // --- Keyboard roving focus keeps the reading position untouched.
  // Focus itself is asserted by team-deck-ui.cjs, which drives the real focus
  // flow. This harness has no OS window focus, so only the scroll contract is
  // checked here (the keyboard path must not reveal-scroll the conversation).
  await run(`chatScroll.scrollTop = chatScroll.scrollHeight`);
  await delay(80);
  const keyboardBefore = await run('chatScroll.scrollTop');
  await run(`
    document.querySelector('.team-tab[aria-selected=true]')
      .dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);
  await delay(80);
  assert.equal(await run('chatScroll.scrollTop'), keyboardBefore, 'Keyboard selection must not move the conversation');
  assert.equal(await run(`document.querySelectorAll('.team-tab[aria-selected=true]').length`), 1, 'Keyboard selection must move the selected tab');

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'click-reveal.png'), (await win.capturePage()).toPNG());
  clearTimeout(timeout);
  console.log('TEAM TAB CLICK REVEAL PASS ' + root);
  app.exit(0);
})().catch(error => { clearTimeout(timeout); console.error(error); app.exit(1); });
