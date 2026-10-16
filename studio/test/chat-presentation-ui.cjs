'use strict';

// Real renderer/IPC against a disposable profile and loopback provider.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-chat-presentation-ui-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
app.setPath('userData', profile);
const store = new AgentStore(path.join(profile, 'agents.json'));
const agent = store.create({ name: 'Chat presentation regression', dir: project, model: 'fixture' });
store.update(agent.id, { settings: { features: { agent: false } } });
const envelope = message => JSON.stringify({ status: 'complete', message, actions: [], options: [] });
const old = envelope('Saved reply displays normally.');
store.appendMessage(agent.id, { role: 'user', content: 'hey' });
store.appendMessage(agent.id, { role: 'assistant', content: old, _reachMeta: { display: old } });
store.setRunState(agent.id, { status: 'completed' });

let win, release, requests = 0;
const errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    return;
  }
  for await (const _chunk of req) { /* consume request */ }
  requests++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = content => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
  const reply = envelope('New reply displays normally.');
  send(reply.slice(0, 24));
  await new Promise(resolve => { release = resolve; });
  for (const character of reply.slice(24)) { send(character); await delay(1); }
  res.end('data: [DONE]\n\n');
});
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', details => {
    if (details.level === 'error' && !details.message.startsWith("The Content Security Policy directive 'frame-ancestors'")) errors.push(details.message);
  });
});
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await run(code)) return;
    await delay(30);
  }
  throw new Error(label);
}
const timeout = setTimeout(() => { console.error('Chat presentation UI timed out:', root); app.exit(1); }, 45000);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark',
    endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', telemetrySources: [], jevEnabled: false }));
  fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Fixture', dir: project }]));
  await import(pathToFileURL(process.argv[2] || path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof selectAgent === "function" && currentAgent', 'Renderer did not initialize');
  win.setContentSize(1440, 960);
  await run(`setDrawer(false); showTab('agents'); selectAgent({id:${JSON.stringify(agent.id)}})`);
  await until(`chatLog.textContent.includes('Saved reply displays normally.')`, 'Saved wrapper was not repaired');
  assert.equal(await run(`chatLog.textContent.includes('"status"')`), false);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath)).agents[0].messages[1]._reachMeta.display, old, 'Projection preserves saved history');
  await run(`window.presentationLeaks = [];
    window.presentationObserver = new MutationObserver(() => {
      const text = [...chatLog.querySelectorAll('.chat-msg.assistant')].map(node => node.textContent).join('\\n');
      if (text.includes('"status"') || text.includes('"actions"')) presentationLeaks.push(text);
    });
    presentationObserver.observe(chatLog, {childList:true, subtree:true, characterData:true});
    composerInput.value = 'how are you?'; composerInput.dispatchEvent(new Event('input', {bubbles:true})); sendComposer();`);
  for (let attempt = 0; attempt < 250 && !release; attempt++) await delay(20);
  assert.equal(typeof release, 'function', 'Provider started streaming');
  await delay(100);
  assert.equal(await run(`chatLog.textContent.includes('"status"')`), false, 'No protocol flash during partial stream');
  release();
  await until(`!agentRunning && chatLog.textContent.includes('New reply displays normally.')`, 'New reply did not finish normally');
  assert.deepEqual(await run('presentationLeaks'), []);
  assert.equal(requests, 1);
  const saved = JSON.parse(fs.readFileSync(store.filePath)).agents[0];
  assert.equal(saved.messages.at(-1).content, 'New reply displays normally.');
  assert.equal(saved.messages[1]._reachMeta.display, old, 'New sends preserve the original older history');
  await run(`selectAgent({id:${JSON.stringify(agent.id)}})`);
  await until(`chatLog.textContent.includes('New reply displays normally.')`, 'Reloaded chat did not display the answer');
  assert.equal(await run(`chatLog.textContent.includes('"status"')`), false);
  fs.writeFileSync(path.join(root, 'chat-presentation.png'), (await win.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  console.log('CHAT PRESENTATION UI PASS: saved reply projection, fragmented SSE without protocol flashes, normal new reply, reopen, unchanged old history.');
  console.log('Evidence:', root);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(0);
})().catch(error => {
  console.error(error.stack || error, 'Evidence:', root, errors);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(1);
});
