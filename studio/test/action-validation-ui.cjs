'use strict';
// Actual renderer with an isolated profile and no model requests.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const source = process.env.REACH_TEST_ROOT || path.resolve(__dirname, '..');
const { AgentStore } = require(path.join(source, 'agent/agent-store.cjs'));
const { parseAgentResponse } = require(path.join(source, 'agent/agent-response.cjs'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-action-validation-ui-'));
app.setPath('userData', root);
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [] }));
fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify([{ name: 'Recovery fixture', dir: root }]));
const store = new AgentStore(path.join(root, 'agents.json'));
const fixture = store.create({ name: 'Action recovery verification', dir: root });
const captured = fs.readFileSync(path.join(__dirname, 'fixtures/malformed-edit-patch.txt'), 'utf8');
const parsed = parseAgentResponse(captured);
store.setMessages(fixture.id, [{ role: 'user', content: 'Apply a targeted border change.' },
  { role: 'assistant', content: captured, _reachMeta: { display: parsed.display, validationError: parsed.error } }]);
store.setRunState(fixture.id, { status: 'paused', reason: parsed.error });
let win;
const errors = [];
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  win.webContents.on('console-message', event => {
    // Existing Electron file-page CSP diagnostic, unrelated to chat rendering.
    if (event.level === 'error' && event.message !== "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.") errors.push(event.message);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  for (let i = 0; i < 150; i++) { if (await run(code)) return; await delay(40); }
  throw Error('Renderer did not become ready: ' + code);
}
const timeout = setTimeout(() => { console.error('Action validation UI timeout', root); app.exit(1); }, 30000);
(async () => {
  await import(pathToFileURL(path.join(source, 'main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(40);
  await until('typeof selectAgent === "function" && document.querySelector("#agent-project-select option")');
  await run(`(async () => { await showTab('agents'); await selectAgent({ id: ${JSON.stringify(fixture.id)} }); })()`);
  await until('document.querySelector("#chat-log .chat-msg.assistant") !== null');
  const check = async () => {
    const text = await run('document.querySelector("#chat-log").textContent');
    assert.match(text, /No actions from this response were executed/);
    assert.doesNotMatch(text, /"hunks"|"status":"actions"|thick-bottom-right/);
  };
  await check();
  await run(`handleAgentEvent({agentId:currentAgent.id,type:'message-start',role:'assistant'});
    handleAgentEvent({agentId:currentAgent.id,type:'message-end',role:'assistant',content:${JSON.stringify(parsed.display)},provisional:true});`);
  await check();
  await run(`handleAgentEvent({agentId:currentAgent.id,type:'message-start',role:'assistant'});
    handleAgentEvent({agentId:currentAgent.id,type:'message-end',role:'assistant',content:'The targeted border change is ready for review.',provisional:false});`);
  assert.equal(await run('[...document.querySelectorAll("#chat-log .chat-msg.assistant")].at(-1).textContent.includes("ready for review")'), true);
  assert.deepEqual(errors, []);
  console.log('ACTION VALIDATION UI PASS', source, root);
  clearTimeout(timeout); app.exit(0);
})().catch(error => { console.error(error.stack, root); clearTimeout(timeout); app.exit(1); });
