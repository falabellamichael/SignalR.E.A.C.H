'use strict';
// Real Electron renderer with a disposable profile and synthetic events.
// No provider requests, installed-app state, or user conversations are used.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-team-chat-order-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [] }));
fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Chat order fixture', dir: project }]));
const store = new AgentStore(path.join(profile, 'agents.json'));
const fixture = store.create({ name: 'Teams chat direction', dir: project });
const savedMessages = [
  { role: 'user', content: 'U1 prompt' },
  { role: 'assistant', content: 'A1 reply', _reachMeta: { thought: 'A1 saved thought' } },
  { role: 'user', content: 'U2 prompt' },
  { role: 'assistant', content: 'A2 reply' },
];
store.setMessages(fixture.id, savedMessages);
const diskMessages = JSON.stringify(JSON.parse(fs.readFileSync(path.join(profile, 'agents.json'), 'utf8')).agents.find(agent => agent.id === fixture.id).messages);
let win;
const errors = [];
app.on('browser-window-created', (_event, window) => {
  win = window;
  // Exercise normal animation/geometry frames while the fixture is hidden.
  window.webContents.setBackgroundThrottling(false);
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => {
    const knownMetaCspWarning = "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.";
    if (level >= 3 && String(message) !== knownMetaCspWarning) errors.push(message);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = async code => {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (error) { console.error('Renderer expression failed:', code.slice(0, 240)); throw error; }
};
async function until(code, message) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await run(code)) return; await delay(30); }
  throw new Error(message);
}
async function direction(enabled) {
  await run(`currentAgent.settings = { ...currentAgent.settings, teamChat: { ...currentAgent.settings?.teamChat, enabled: ${enabled} } }; placeSelectedTeamDeck();`);
}
const savedOrder = `Array.from(chatLog.querySelectorAll(':scope > .chat-msg.user, :scope > .chat-msg.assistant'))
  .map(node => node.textContent.match(/\\b[UA][12]\\b/)?.[0]).filter(Boolean)`;
async function assertTeamsNewestFollow(label, requireVisibleRail = false) {
  const position = await run(`(() => {
    const viewport = chatScroll.getBoundingClientRect();
    const rail = orderRun.wrap.querySelector('.team-deck-nav');
    const visibleRail = rail.classList.contains('is-floating') && getComputedStyle(rail).visibility !== 'hidden';
    const reservedBottom = viewport.top + chatScroll.clientTop + rail.offsetHeight;
    const boundary = visibleRail ? Math.max(reservedBottom, rail.getBoundingClientRect().bottom) : reservedBottom;
    const newest = [...chatLog.children].find(node => !node.matches('.team-deck, .chat-branch-note, .thought-detail') && node.getBoundingClientRect().height > 0);
    const response = chatLog.querySelector(':scope > .chat-msg.assistant');
    return { follows: shouldFollowChat(), visibleRail, railClass: rail.className, boundary, viewportBottom: viewport.bottom,
      newestTop: newest.getBoundingClientRect().top, responseTop: response.getBoundingClientRect().top };
  })()`);
  assert.equal(position.follows, true, `${label}: Teams stays at its newest follow target`);
  if (requireVisibleRail) assert.equal(position.visibleRail, true, `${label}: fixture must exercise the visible floating workstation rail (${JSON.stringify(position)})`);
  assert.ok(position.newestTop >= position.boundary - 2 && position.newestTop < position.viewportBottom,
    `${label}: newest entry clears the floating rail and remains visible (${JSON.stringify(position)})`);
  assert.ok(position.responseTop >= position.boundary - 2 && position.responseTop < position.viewportBottom,
    `${label}: newest response clears the floating rail and remains visible (${JSON.stringify(position)})`);
}
const timeout = setTimeout(() => { console.error('Teams chat order UI timed out', root); app.exit(1); }, 60000);

(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof ReachTeamComposer !== "undefined" && document.querySelector("#agent-project-select option")', 'Renderer did not initialize');
  win.setContentSize(1440, 900);
  win.showInactive();
  await run(`(async () => { setDrawer(false); await showTab('agents'); await selectAgent({ id: ${JSON.stringify(fixture.id)} }); })()`);
  await run('document.fonts.ready');
  assert.deepEqual(await run(savedOrder), ['U1', 'A1', 'U2', 'A2'], 'Individual history stays chronological');
  await run(`window.savedBubbles = [...chatLog.querySelectorAll(':scope > .chat-msg')]; window.canonicalMessages = JSON.stringify(currentAgent.messages);`);

  await direction(true);
  assert.equal(await run(`chatLog.classList.contains('team-newest-first')`), true);
  assert.deepEqual(await run(savedOrder), ['A2', 'U2', 'A1', 'U1'], 'Teams shows newest response then its prompt');
  assert.equal(await run(`savedBubbles.every(node => node.isConnected)`), true, 'Changing direction preserves bubble identity');
  assert.equal(await run(`(() => { const bubble = savedBubbles.find(node => node.classList.contains('assistant') && node.textContent.includes('A1 reply')); return bubble.nextElementSibling?.classList.contains('thought-detail') && bubble.nextElementSibling.textContent === 'A1 saved thought'; })()`), true, 'Thought detail stays immediately after its assistant bubble');
  await direction(false);
  assert.deepEqual(await run(savedOrder), ['U1', 'A1', 'U2', 'A2'], 'Turning Teams off restores chronological order');
  assert.equal(await run(`savedBubbles.every(node => node.isConnected)`), true);
  await direction(true);
  await run('renderChatHistory()');
  assert.deepEqual(await run(savedOrder), ['A2', 'U2', 'A1', 'U1'], 'Saved history reopens in Teams order');
  assert.equal(await run('JSON.stringify(currentAgent.messages) === canonicalMessages'), true, 'Direction never changes saved message order or keys');

  // Create the workstation through its normal renderer event path. Its tab and
  // member order must be independent of all transcript direction changes.
  await run(`(() => {
    startTeamRunView('chat-order-team', { id: 'fixture-team', name: 'Order team', mode: 'parallel' }, 'DECK_PROMPT');
    window.orderRun = activeTeamRun;
    handleTeamEvent({ teamRunId: orderRun.teamRunId, type: 'start', members: [
      { index: 0, agentId: 'm0', name: 'Reader', model: 'fixture' },
      { index: 1, agentId: 'm1', name: 'Builder', model: 'fixture' },
      { index: 2, agentId: 'm2', name: 'Reviewer', model: 'fixture' },
    ] });
    handleTeamEvent({ teamRunId: orderRun.teamRunId, type: 'member', index: 0, memberType: 'message-end', content: 'Workstation member output remains in place.' });
    window.workstationTabs = [...orderRun.wrap.querySelectorAll('.team-tabs > .team-tab')];
    window.workstationCards = [...orderRun.wrap.querySelector('.team-panels').children];
    window.workstationChildren = [...orderRun.wrap.children];
    window.scrollerChildren = [...chatScroll.children];
  })()`);
  assert.equal(await run('orderRun.wrap.parentElement === teamDeckSlot'), true, 'Live workstation belongs above the transcript');
  await direction(false);
  await direction(true);
  assert.equal(await run(`workstationTabs.every((node, index) => node === orderRun.wrap.querySelectorAll('.team-tabs > .team-tab')[index])
    && workstationCards.every((node, index) => node === orderRun.wrap.querySelector('.team-panels').children[index])
    && workstationChildren.every((node, index) => node === orderRun.wrap.children[index])
    && scrollerChildren.every((node, index) => node === chatScroll.children[index])`), true, 'Workstation and shared-scroller child order remain unchanged');

  await run(`appendChatMessage('user', 'LIVE_USER');
    handleAgentEvent({ agentId: currentAgent.id, type: 'message-start', role: 'assistant' });
    handleAgentEvent({ agentId: currentAgent.id, type: 'delta', text: 'LIVE_RESPONSE' });
    handleAgentEvent({ agentId: currentAgent.id, type: 'message-end', content: 'LIVE_RESPONSE', thought: 'Live thought stays with the answer.' });`);
  const liveOrder = await run(`Array.from(chatLog.querySelectorAll(':scope > .chat-msg.user, :scope > .chat-msg.assistant')).slice(0, 2).map(node => node.textContent.includes('LIVE_RESPONSE') ? 'response' : node.textContent.includes('LIVE_USER') ? 'prompt' : 'other')`);
  assert.deepEqual(liveOrder, ['response', 'prompt'], 'Live Teams response appears above its prompt');
  assert.equal(await run(`chatLog.querySelector(':scope > .chat-msg.assistant').nextElementSibling?.classList.contains('thought-detail')`), true);
  await run(`appendToolCallMessage('read', { path: 'fixture.js' }); appendToolCard('read', true, false, null, 'fixture tool result'); appendQuestion({ question: 'Fixture question?', options: ['Continue'] }); appendEditCard({ editId: 'fixture-edit', path: 'fixture.js', stats: { added: 1, removed: 0 }, hunks: [{ type: 'add', text: 'fixture line' }] });`);
  assert.equal(await run(`chatLog.firstElementChild.classList.contains('edit-review-group')`), true, 'New review groups follow Teams ordering');
  await run(`currentAgent.parentChatId = 'fixture-parent'; currentAgent.forkIndex = 1; renderChatHistory();`);
  assert.equal(await run(`chatLog.firstElementChild.textContent.includes('branched from')`), true, 'Branch provenance remains above the transcript');
  await direction(false);
  await direction(true);
  assert.equal(await run(`chatLog.firstElementChild.textContent.includes('branched from')`), true, 'Direction changes keep branch provenance in place');
  await run(`delete currentAgent.parentChatId; currentAgent.forkIndex = null;`);

  // Read an older message while a long newest reply grows above it. Compare a
  // node's position within the viewport, since scrollTop must grow to preserve
  // it and asynchronous header status can move the entire viewport on screen.
  const longAnswer = Array.from({ length: 20 }, (_, index) => `Paragraph ${index}: a reader can inspect older work while this answer grows.`).join('\n\n');
  await run(`currentAgent.messages = Array.from({ length: 14 }, (_, index) => [
    { role: 'user', content: 'Older prompt ' + index },
    { role: 'assistant', content: 'Older answer ' + index + '\\n\\n' + ${JSON.stringify(longAnswer)} },
  ]).flat(); renderChatHistory(); appendChatMessage('user', 'LONG_STREAM_PROMPT');
    handleAgentEvent({ agentId: currentAgent.id, type: 'message-start', role: 'assistant' });
    handleAgentEvent({ agentId: currentAgent.id, type: 'delta', text: ${JSON.stringify(longAnswer)} });
    window.readingAnchor = [...chatLog.querySelectorAll(':scope > .chat-msg.assistant')][5];
    chatScroll.scrollTop += readingAnchor.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top - 100;`);
  await run('document.fonts.ready');
  await delay(450);
  const anchorState = `({ top: readingAnchor.getBoundingClientRect().top, viewport: chatScroll.getBoundingClientRect().toJSON(), viewportOffset: readingAnchor.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top, follows: shouldFollowChat(), scroll: chatScroll.scrollTop, height: chatScroll.scrollHeight, logTop: chatLog.getBoundingClientRect().top, anchorOffset: readingAnchor.getBoundingClientRect().top - chatLog.getBoundingClientRect().top, deckHeight: orderRun.wrap.getBoundingClientRect().height, font: document.fonts.status })`;
  const readingBefore = await run(anchorState);
  assert.equal(readingBefore.follows, false, 'Older reading position must be away from the newest edge');
  assert.ok(readingBefore.top >= readingBefore.viewport.top && readingBefore.top < readingBefore.viewport.bottom, 'Reading anchor must be visible');
  const anchorSamples = [readingBefore];
  for (let index = 0; index < 20; index++) {
    await run(`handleAgentEvent({ agentId: currentAgent.id, type: 'delta', text: ${JSON.stringify('\n\n' + longAnswer)} });`);
    await delay(60);
    anchorSamples.push(await run(anchorState));
  }
  fs.writeFileSync(path.join(root, 'anchor-samples.json'), JSON.stringify(anchorSamples, null, 2));
  const readingAfter = await run('readingAnchor.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top');
  assert.ok(Math.abs(readingAfter - readingBefore.viewportOffset) <= 2, `Streaming above older content preserves its viewport position (${readingBefore.viewportOffset} → ${readingAfter})`);
  await run(`appendChatMessage('system', 'New Teams status above the older reading position.');`);
  await delay(120);
  const statusAfter = await run('readingAnchor.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top');
  assert.ok(Math.abs(statusAfter - readingBefore.viewportOffset) <= 2, `Prepending a status preserves the older reading position (${readingBefore.viewportOffset} → ${statusAfter})`);

  await run('followChatTail(true)');
  await delay(100);
  await assertTeamsNewestFollow('Following newest Teams content');
  // A slight upward scroll reveals the existing rail while remaining within
  // the follow threshold. Verify real visible coverage as well as reservation.
  await run('chatScroll.scrollTop = Math.max(0, chatScroll.scrollTop - 4)');
  await delay(100);
  await assertTeamsNewestFollow('Newest response beneath the visible workstation rail', true);
  await run(`handleAgentEvent({ agentId: currentAgent.id, type: 'delta', text: ${JSON.stringify('\n\n' + longAnswer)} });`);
  await delay(100);
  await assertTeamsNewestFollow('Streaming while following newest Teams content');
  assert.equal(await run('orderRun.wrap.parentElement === teamDeckSlot'), true);
  assert.equal(await run(`workstationTabs.every((node, index) => node === orderRun.wrap.querySelectorAll('.team-tabs > .team-tab')[index])
    && workstationCards.every((node, index) => node === orderRun.wrap.querySelector('.team-panels').children[index])`), true, 'Streaming chat output preserves member DOM order');

  await run(`handleAgentEvent({ agentId: currentAgent.id, type: 'message-end', content: 'LONG_STREAM_DONE' });`);
  await direction(false);
  await run('followChatTail(true)');
  assert.equal(await run(`[...chatLog.querySelectorAll(':scope > .chat-msg.user, :scope > .chat-msg.assistant')].at(-1).textContent.includes('LONG_STREAM_DONE')`), true, 'Individual mode restores the live reply to the chronological end');
  assert.ok(await run('chatScroll.scrollHeight - chatScroll.clientHeight - chatScroll.scrollTop') <= 2, 'Individual mode still follows the bottom');
  await direction(true);
  await run('followChatTail(true)');
  win.showInactive();
  await delay(180);
  await assertTeamsNewestFollow('Desktop Teams view');
  fs.writeFileSync(path.join(root, 'teams-newest-first.png'), (await win.capturePage()).toPNG());
  win.setContentSize(1000, 720); await delay(160); await run('followChatTail(true)'); await delay(160);
  await assertTeamsNewestFollow('Narrow Teams view');
  fs.writeFileSync(path.join(root, 'teams-newest-first-narrow.png'), (await win.capturePage()).toPNG());
  assert.equal(await run(`document.body.scrollHeight <= innerHeight + 1 && document.querySelector('.composer').getBoundingClientRect().bottom <= innerHeight + 1`), true, 'Chat and composer remain within the window');
  assert.deepEqual(errors, [], 'Renderer remains error-free');
  const finalDiskMessages = JSON.stringify(JSON.parse(fs.readFileSync(path.join(profile, 'agents.json'), 'utf8')).agents.find(agent => agent.id === fixture.id).messages);
  assert.equal(finalDiskMessages, diskMessages, 'Synthetic rendering and direction changes leave persisted history untouched');
  console.log('TEAMS CHAT ORDER UI OK: saved/live newest-first Teams, chronological individual mode, thought adjacency, unchanged workstation, and older-reader streaming anchoring.');
  console.log('Evidence: ' + root);
  clearTimeout(timeout); app.exit(0);
})().catch(async error => {
  console.error(error.stack || error);
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.capturePage()).toPNG());
  console.error('Evidence: ' + root);
  clearTimeout(timeout); app.exit(1);
});
