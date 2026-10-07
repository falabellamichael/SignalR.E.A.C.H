'use strict';
// Live Agents "→ tool(args)" rows stay in the DOM but are hidden via CSS.
// Isolated Electron profile; no provider traffic.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-hide-tool-call-'));
app.setPath('userData', root);
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [] }));
fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify([{ name: 'Hide tool-call fixture', dir: root }]));
const store = new AgentStore(path.join(root, 'agents.json'));
const fixture = store.create({ name: 'Hide tool-call rows', dir: root });
store.setMessages(fixture.id, [
  { role: 'user', content: 'List the files.' },
  { role: 'assistant', content: 'Looking…' },
  { role: 'tool', name: 'list', content: '["a.js","b.js"]' },
]);

let win;
const errors = [];
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !String(message).includes('frame-ancestors')) errors.push(message);
  });
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (code) => win.webContents.executeJavaScript(code, true);
const timeout = setTimeout(() => {
  console.error('Hide tool-call UI timed out', root);
  app.exit(1);
}, 60000);

(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  for (let i = 0; i < 100; i++) {
    if (await run('typeof handleAgentEvent!=="undefined" && document.querySelector("#agent-project-select option")')) break;
    await delay(30);
  }

  await run(`(async () => {
    setDrawer(false);
    await showTab('agents');
    await selectAgent({ id: ${JSON.stringify(fixture.id)} });
  })()`);

  const history = await run(`({
    toolCalls: document.querySelectorAll('.tool-call-message').length,
    toolCards: document.querySelectorAll('.tool-card').length,
    cardVisible: [...document.querySelectorAll('.tool-card')].every((el) => getComputedStyle(el).display !== 'none'),
    assistant: [...document.querySelectorAll('.chat-msg.assistant')].some((el) => el.textContent.includes('Looking')),
  })`);
  assert.equal(history.toolCalls, 0, 'history replay never emitted live tool-call rows');
  assert.equal(history.toolCards, 1, 'history tool results still render as cards');
  assert.equal(history.cardVisible, true, 'history tool cards stay visible');
  assert.equal(history.assistant, true, 'assistant history text still renders');

  const before = await run(`({
    toolCalls: document.querySelectorAll('.tool-call-message').length,
    toolCards: document.querySelectorAll('.tool-card').length,
  })`);
  await run(`(() => {
    const id = currentAgent.id;
    handleAgentEvent({ agentId: id, type: 'tool-call', tool: 'list', arguments: { path: '.' } });
    handleAgentEvent({ agentId: id, type: 'tool-call', tool: 'glob', arguments: { pattern: '**/*.js' } });
    handleAgentEvent({ agentId: id, type: 'tool-result', tool: 'list', ok: true, pending: false, error: null, result: { entries: ['a.js'] } });
    handleAgentEvent({ agentId: id, type: 'message-start', role: 'assistant' });
    handleAgentEvent({ agentId: id, type: 'delta', text: 'Found two files.' });
    handleAgentEvent({ agentId: id, type: 'message-end', role: 'assistant', content: 'Found two files.' });
  })()`);
  const after = await run(`({
    toolCalls: document.querySelectorAll('.tool-call-message').length,
    hidden: [...document.querySelectorAll('.tool-call-message')].every((el) => getComputedStyle(el).display === 'none'),
    toolCards: document.querySelectorAll('.tool-card').length,
    cardVisible: getComputedStyle([...document.querySelectorAll('.tool-card')].at(-1)).display !== 'none',
    assistant: [...document.querySelectorAll('.chat-msg.assistant')].some((el) => (el.dataset.raw || el.textContent || '').includes('Found two files')),
  })`);
  assert.equal(after.toolCalls, before.toolCalls + 2, 'live tool-call events still append rows (CSS hide)');
  assert.equal(after.hidden, true, 'live tool-call activity rows must be display:none');
  assert.equal(after.toolCards, before.toolCards + 1, 'live tool-result events must still add tool cards');
  assert.equal(after.cardVisible, true, 'tool-result cards must remain visible');
  assert.equal(after.assistant, true, 'assistant streaming still works');
  assert.deepEqual(errors, []);
  console.log('HIDE TOOL-CALL UI PASS', root);
  clearTimeout(timeout);
  app.exit(0);
})().catch((error) => {
  console.error(error.stack, root, errors);
  clearTimeout(timeout);
  app.exit(1);
});
