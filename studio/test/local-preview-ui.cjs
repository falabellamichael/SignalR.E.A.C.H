'use strict';

// Opt-in live acceptance: electron test/local-preview-ui.cjs --live-27b
// Uses the configured 27B provider in a separate profile and temporary project.
// Credentials stay in the OS vault/configuration and are never printed.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!process.argv.includes('--live-27b')) throw new Error('Pass --live-27b to authorize the live provider acceptance run.');
const originalProfile = path.join(process.env.APPDATA, 'Reach Studio');
const originalSettings = JSON.parse(fs.readFileSync(path.join(originalProfile, 'settings.json'), 'utf8'));
const connection = originalSettings.connections.find(c => c.enabled !== false && /27b/i.test(c.model));
if (!connection) throw new Error('No configured 27B connection was found.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-local-preview-ui-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
// Preserve the encrypted settings' OS-vault context in the isolated profile.
if (fs.existsSync(path.join(originalProfile, 'Local State'))) {
  fs.copyFileSync(path.join(originalProfile, 'Local State'), path.join(profile, 'Local State'));
}
os.homedir = () => root;
process.env.LOCALAPPDATA = path.join(root, 'local');
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ schemaVersion: 1, theme: 'dark',
  connections: [connection], activeConnection: connection.id, endpoint: connection.endpoint, model: connection.model,
  budgets: originalSettings.budgets, jevEnabled: false, jevAutoMode: false, mcpServers: [] }));
const browserModule = require('../browser/host.cjs');
const BaseBrowser = browserModule.StudioBrowser;
let browser, win;
browserModule.StudioBrowser = class extends BaseBrowser {
  constructor(window) { super(window); browser = this; }
};
app.on('browser-window-created', (_event, window) => { win = window; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = async code => {
  const result = await win.webContents.executeJavaScript(`(async () => { try { ${code} } catch (error) { return { previewTestError: error.message }; } })()`, true);
  if (result?.previewTestError) throw new Error(result.previewTestError);
  return result;
};
const deadline = setTimeout(() => { console.error('Live preview acceptance timed out. Evidence:', root); app.exit(1); }, 180000);
const started = Date.now();

(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(50);
  win.show();
  await run(`await selectProject({ name: 'Coffee preview validation', dir: ${JSON.stringify(project)} });
    const created = await reachApi.agents.create('Coffee preview validation', ${JSON.stringify(project)}, ${JSON.stringify(connection.model)});
    if (!created.ok) throw new Error(created.err);
    window.previewTestAgentId = created.agent.id;
    await selectAgent(created.agent);
    showTab('agents');
    reachApi.agents.onEditPending(({agentId, edit}) => { if (agentId === window.previewTestAgentId) void reachApi.agents.resolveEdit(agentId, edit.editId, true); });
    reachApi.agents.onApprovalRequest(payload => { void reachApi.agents.respondApproval(payload.requestId, false); });
    void reachApi.agents.send(window.previewTestAgentId, 'Build a complete responsive coffee webpage in coffee.html with navigation, a hero, a drinks menu, brewing tips and a footer. Write the file and open it in the in-app browser.');`);
  const id = await run('return window.previewTestAgentId;');
  let agent;
  while (true) {
    await delay(500);
    agent = JSON.parse(fs.readFileSync(path.join(profile, 'agents.json'), 'utf8')).agents.find(a => a.id === id);
    if (agent && ['completed', 'blocked', 'question', 'failed', 'stopped', 'paused'].includes(agent.runState?.status)) break;
  }
  const tools = agent.messages.filter(m => m.role === 'tool').map(m => ({ name: m.name, result: JSON.parse(m.content) }));
  console.log('LIVE_MODEL', connection.model, 'STATUS', agent.runState.status, 'TOOLS', JSON.stringify(tools.map(t => ({ name: t.name, ok: t.result.ok, error: t.result.error }))));
  assert.equal(agent.runState.status, 'completed', agent.runState.reason);
  assert.ok(tools.some(t => ['write', 'edit_patch'].includes(t.name) && t.result.ok), 'model must actually write the website');
  assert.ok(!tools.some(t => t.name === 'shell'), 'static website must not need a shell server');
  assert.ok(fs.readFileSync(path.join(project, 'coffee.html'), 'utf8').includes('<'));
  const page = browser.state().tabs.find(tab => /^http:\/\/127\.0\.0\.1:\d+\/coffee.html$/.test(tab.url));
  assert.ok(page, 'model must open the managed preview in the native browser');
  assert.equal(page.error, '');
  const tab = browser.tabs.get(page.id);
  const rendered = await tab.view.webContents.executeJavaScript(`({title: document.title, text: document.body.innerText, width: innerWidth, height: innerHeight, styles: document.styleSheets.length})`);
  assert.match(rendered.text, /coffee/i);
  assert.ok(rendered.styles > 0);
  assert.equal(tab.view.getVisible(), true);
  fs.writeFileSync(path.join(root, 'preview-desktop.png'), (await win.capturePage()).toPNG());
  // Reopening an existing agent tab must reveal it after the drawer was hidden.
  await run("await selectDrawerPanel('files');");
  await delay(100);
  assert.equal(tab.view.getVisible(), false);
  const { runToolCall } = require('../agent/agent-tool-runner.cjs');
  const reopened = await runToolCall(id, 'browser', { op: 'preview', path: 'coffee.html' }, {
    projectDir: project, agentId: id, signal: new AbortController().signal,
    browserExecutor: (op, args, ctx) => browser.agentCommand(op, args, { ...ctx, owner: 'chat:' + id }),
  });
  await delay(150);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.tabId, page.id);
  assert.equal(tab.view.getVisible(), true);
  const evidence = { model: connection.model, elapsedMs: Date.now() - started,
    status: agent.runState.status, tools: tools.map(t => ({ name: t.name, ok: t.result.ok })),
    url: page.url, rendered, existingTabRevealed: true, root };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log('LOCAL_PREVIEW_LIVE_OK', JSON.stringify(evidence));
  clearTimeout(deadline);
  if (process.argv.includes('--hold')) await delay(45000);
  app.exit(0);
})().catch(error => {
  clearTimeout(deadline);
  console.error('Local preview acceptance failed:', error.message, 'Evidence:', root);
  app.exit(1);
});
