'use strict';
// Genuine Electron settings handlers and renderer draft protection. Everything
// lives in this disposable profile; the only provider is an in-process model list.
const { app, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

delete process.env.TYPESAFE_API_KEY;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-cli-settings-ui-'));
const profile = path.join(root, 'profile');
const project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
// Isolate the bridge discovery descriptor as well as Electron's private store.
os.homedir = () => root;
app.setPath('userData', profile);
const settingsFile = path.join(profile, 'settings.json');
const discoveryFile = path.join(root, '.config', 'reach-cli', 'studio-bridge.json');
const secrets = ['bridge-fixture-access-key', 'bridge-fixture-jev-key', 'bridge-fixture-mcp-value'];
let descriptor, win, modelRequests = 0, chatRequests = 0, modelAuthPreserved = true;
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await run(code)) return;
    await delay(30);
  }
  throw new Error(label);
}
function redact(value) {
  let output = String(value);
  for (const secret of [...secrets, descriptor?.token].filter(Boolean)) output = output.split(secret).join('[redacted]');
  return output;
}
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !/frame-ancestors.*ignored/.test(message)) errors.push(redact(message));
  });
});
const server = http.createServer((request, response) => {
  if (request.url === '/v1/models') {
    modelRequests++;
    modelAuthPreserved &&= request.headers.authorization === 'Bearer ' + secrets[0];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 'fixture-model-next' }] }));
  } else {
    chatRequests++;
    response.writeHead(404); response.end('Only fixture model listing is supported.');
  }
});
async function request(method, params = {}, authenticated = true) {
  const body = JSON.stringify({ method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(descriptor.url + '/call', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      ...(authenticated ? { Authorization: 'Bearer ' + descriptor.token } : {}),
    } }, response => {
      let output = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { output += chunk; });
      response.on('end', () => {
        try {
          for (const secret of [...secrets, descriptor.token]) assert.ok(!output.includes(secret), 'Bridge response exposed a fixture credential.');
          resolve({ status: response.statusCode, body: JSON.parse(output) });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Fixture bridge request timed out.')));
    req.on('error', reject); req.end(body);
  });
}
async function call(method, params = {}) {
  const reply = await request(method, params);
  assert.equal(reply.status, 200, redact(reply.body.error || 'Bridge method failed.'));
  assert.equal(reply.body.ok, true, 'Bridge request failed.');
  return reply.body.result;
}
const connectionPatch = settings => settings.connections.map(({ id, name, endpoint, model, enabled }) => ({ id, name, endpoint, model, enabled }));
async function save(patch) {
  const current = await call('settings.get');
  const result = await call('settings.save', { patch: { ...patch, settingsRevision: current.settingsRevision } });
  assert.equal(result.ok, true, 'Settings did not save.');
  return result;
}
function verifyKeys() {
  const disk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const encrypted = safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  if (encrypted) {
    assert.equal(disk.connections[0].accessKey, undefined, 'Connection key was stored in plaintext.');
    assert.ok(safeStorage.decryptString(Buffer.from(disk.connections[0].encryptedAccessKey, 'base64')) === secrets[0], 'Saved connection key was not preserved.');
    assert.equal(disk.jevApiKey, undefined, 'Jev key was stored in plaintext.');
    assert.ok(safeStorage.decryptString(Buffer.from(disk.encryptedJevApiKey, 'base64')) === secrets[1], 'Saved Jev key was not preserved.');
  } else {
    assert.ok(disk.connections[0].accessKey === secrets[0], 'Connection key was not preserved.');
    assert.ok(disk.jevApiKey === secrets[1], 'Jev key was not preserved.');
  }
  return encrypted;
}
const timeout = setTimeout(() => { console.error('CLI SETTINGS BRIDGE UI timed out. Isolated profile:', profile); app.exit(1); }, 55000);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', telemetrySources: [], jevApiKey: secrets[1],
    connections: [{ id: 'conn_fixture', name: 'Local fixture', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-model', accessKey: secrets[0], enabled: true }],
    activeConnection: 'conn_fixture',
    mcpServers: [{ name: 'Off-Tools', enabled: false, transport: 'stdio', command: 'never-start-this-fixture', args: [], env: { FIXTURE_PRIVATE: secrets[2] } }],
  }));
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading() || !fs.existsSync(discoveryFile)) await delay(30);
  descriptor = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
  assert.equal(descriptor.pid, process.pid, 'Discovery must describe this isolated instance.');
  await until('typeof openSettingsPanel === "function" && typeof renderMcp === "function"', 'Settings renderer did not initialize.');
  assert.equal(win.isVisible(), false, 'The fixture must keep the Electron window hidden.');

  assert.equal((await request('settings.get', {}, false)).status, 403, 'Bridge must require authentication.');
  let settings = await call('settings.get');
  assert.match(settings.settingsRevision, /^[0-9a-f]{64}$/);
  assert.equal(settings.connections[0].hasAccessKey, true);
  assert.equal(settings.connections[0].accessKey, undefined);
  assert.equal(settings.jevKeyConfigured, true);
  assert.equal(settings.jevApiKey, undefined);
  assert.deepEqual(settings.mcpServers[0].envKeys, ['FIXTURE_PRIVATE']);
  assert.equal(settings.mcpServers[0].env, undefined);

  const rows = connectionPatch(settings); rows[0].model = 'fixture-model-next';
  await save({ connections: rows, activeConnection: 'conn_fixture', jevEnabled: true, jevAutoMode: true });
  settings = await call('settings.get');
  assert.equal(settings.model, 'fixture-model-next');
  assert.equal(settings.jevEnabled, true); assert.equal(settings.jevAutoMode, true);
  verifyKeys();
  const models = await call('connections.models', { connectionId: 'conn_fixture' });
  assert.equal(models.ok, true); assert.deepEqual(models.models, ['fixture-model', 'fixture-model-next']);
  assert.equal((await call('connections.test', { connectionId: 'conn_fixture' })).ok, true);

  const schema = await call('budget.schema');
  assert.equal(schema.fields.length, 42, 'Bridge must use all Studio budget fields.');
  await save({ budgets: { ...schema.defaults, maxRounds: 0, requestTimeoutMs: 0, messageHandoffs: 0 } });
  settings = await call('settings.get');
  assert.equal(settings.budgets.maxRounds, 0); assert.equal(settings.budgets.requestTimeoutMs, 0); assert.equal(settings.budgets.messageHandoffs, 0);
  const theme = await call('theme.set', { theme: 'light', accent: '#337799', tint: 15 });
  assert.equal(theme.theme, 'light'); assert.equal((await call('settings.get')).theme, 'light');

  const created = await run(`reachApi.agents.create('Bridge fixture chat', ${JSON.stringify(project)}, 'fixture-model')`);
  assert.equal(created.ok, true, 'Renderer could not create an isolated fixture conversation.');
  const id = created.agent.id;
  const changed = await call('conversations.update', { id, patch: { name: 'Bridge renamed chat', model: 'fixture-model-next', settings: { approvals: 'auto-read', reviewEdits: false, budgetOverrides: { maxTokens: 0, maxRounds: 0 } } } });
  assert.equal(changed.ok, true); assert.equal(changed.agent.name, 'Bridge renamed chat');
  const conversation = await call('conversations.get', { id });
  assert.equal(conversation.settings.approvals, 'auto-read'); assert.equal(conversation.settings.reviewEdits, false);
  assert.equal(conversation.settings.budgetOverrides.maxTokens, 0); assert.equal(conversation.messages, undefined);
  assert.ok((await call('conversations.list')).some(row => row.id === id));

  const mcp = (await call('settings.get')).mcpServers[0];
  await save({ mcpServers: [{ id: mcp.id, name: mcp.name, enabled: false, transport: 'stdio', command: 'still-never-start-this-fixture', args: [] }] });
  const status = await call('mcp.status');
  assert.equal(status.ok, true); assert.equal(status.servers[0].enabled, false);
  assert.equal(status.servers[0].status, 'unknown');
  assert.equal(status.servers[0].tools, 0, 'Disabled MCP fixture must never be started.');
  assert.deepEqual(status.servers[0].envKeys, ['FIXTURE_PRIVATE']);
  assert.ok(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).mcpServers[0].env.FIXTURE_PRIVATE === secrets[2], 'Omitted MCP environment was not preserved.');

  // The renderer must reject its old draft while preserving both the draft and
  // the newer CLI settings. An edit after opening the panel is draft-only.
  await run('loadSettings()');
  await run('openSettingsPanel("connection")');
  await run(`(() => { document.querySelector('#conn-list .conn-edit').click(); const input = document.querySelector('#conn-editor .conn-model'); input.value = 'unsaved-renderer-model'; input.dispatchEvent(new Event('input')); })()`);
  const latestRows = connectionPatch(await call('settings.get')); latestRows[0].model = 'newer-cli-model';
  await save({ connections: latestRows, activeConnection: 'conn_fixture' });
  await run('document.querySelector("#btn-save-settings").onclick()');
  assert.match(await run('document.querySelector("#settings-status").textContent'), /changed.*CLI|Reload.*Settings/i);
  assert.equal((await call('settings.get')).model, 'newer-cli-model', 'Renderer overwrote the newer CLI model.');
  assert.equal(await run('connDraft[0].model'), 'unsaved-renderer-model', 'Rejected save lost the unsaved renderer draft.');
  await run('document.querySelector("#settings-status-reload").onclick()');
  assert.equal(await run('connDraft[0].model'), 'newer-cli-model', 'Reload did not recover the latest connection settings.');

  // A different panel's appearance edit must not reject a fresh connection save.
  await run(`(() => { if (!document.querySelector('#conn-editor .conn-model')) document.querySelector('#conn-list .conn-edit').click(); const input = document.querySelector('#conn-editor .conn-model'); input.value = 'unrelated-save-allowed'; input.dispatchEvent(new Event('input')); })()`);
  await call('theme.set', { theme: 'dark' });
  await run('document.querySelector("#btn-save-settings").onclick()');
  assert.equal((await call('settings.get')).model, 'unrelated-save-allowed');
  assert.equal((await call('settings.get')).theme, 'dark');

  // A conversation draft uses its own revision so CLI changes cannot disappear
  // when a still-open renderer settings form is submitted.
  await run(`selectAgent({ id: ${JSON.stringify(id)} })`);
  await run('openSettingsPanel("conversation")');
  await run(`(() => { const input = document.querySelector('#agent-set-name'); input.value = 'Unsaved renderer chat'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const latestConversation = await call('conversations.get', { id });
  await call('conversations.update', { id, patch: { conversationRevision: latestConversation.conversationRevision, name: 'Newer CLI chat' } });
  await run('document.querySelector("#btn-agent-set-save").onclick()');
  assert.match(await run('document.querySelector("#agent-settings-status").textContent'), /changed.*CLI|Reload.*Settings/i);
  assert.equal((await call('conversations.get', { id })).name, 'Newer CLI chat');
  assert.equal(await run('document.querySelector("#agent-set-name").value'), 'Unsaved renderer chat');
  await run('document.querySelector("#agent-settings-status-reload").onclick()');
  assert.equal(await run('document.querySelector("#agent-set-name").value'), 'Newer CLI chat');

  // Reopening a dirty form must keep its original revision along with its
  // original field values. Refreshing the shared agent object is insufficient.
  await run(`(() => { const input = document.querySelector('#agent-set-name'); input.value = 'Unsaved reopened chat'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await call('conversations.update', { id, patch: { settings: { approvals: 'auto-all' } } });
  await run('openSettingsPanel("appearance")');
  await run('openSettingsPanel("conversation")');
  assert.equal(await run('document.querySelector("#agent-set-name").value'), 'Unsaved reopened chat');
  await run('document.querySelector("#btn-agent-set-save").onclick()');
  assert.match(await run('document.querySelector("#agent-settings-status").textContent'), /changed.*CLI|Reload.*Settings/i);
  const reopenedConversation = await call('conversations.get', { id });
  assert.equal(reopenedConversation.name, 'Newer CLI chat');
  assert.equal(reopenedConversation.settings.approvals, 'auto-all');
  await run('document.querySelector("#agent-settings-status-reload").onclick()');
  assert.equal(await run('document.querySelector("#agent-set-approvals").value'), 'auto-all');

  // Global budget and MCP forms have the same stale-write protection.
  await run('openSettingsPanel("budgeting")');
  await run(`(() => { const input = document.querySelector('#budget-maxTokens'); input.value = '333'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const newerBudgets = (await call('settings.get')).budgets;
  await save({ budgets: { ...newerBudgets, maxTokens: 444 } });
  await run('document.querySelector("#btn-save-budgets").onclick()');
  assert.match(await run('document.querySelector("#budget-status").textContent'), /changed.*CLI|Reload.*Settings/i);
  assert.equal((await call('settings.get')).budgets.maxTokens, 444);
  assert.equal(await run('document.querySelector("#budget-maxTokens").value'), '333');
  await run('document.querySelector("#budget-status-reload").onclick()');
  assert.equal(await run('document.querySelector("#budget-maxTokens").value'), '444');

  // Local budgets also retain the revision of their dirty controls after a
  // different panel has reloaded the same conversation object.
  await run(`(() => { const scope = document.querySelector('#budget-scope'); scope.value = 'conversation'; scope.onchange(); const input = document.querySelector('#budget-maxTokens'); input.value = '222'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await call('conversations.update', { id, patch: { settings: { budgetOverrides: { maxTokens: 555, maxRounds: 0 } } } });
  await run('openSettingsPanel("conversation")');
  await run('openSettingsPanel("budgeting")');
  assert.equal(await run('document.querySelector("#budget-maxTokens").value'), '222');
  await run('document.querySelector("#btn-save-budgets").onclick()');
  assert.match(await run('document.querySelector("#budget-status").textContent'), /changed.*CLI|Reload.*Settings/i);
  assert.equal((await call('conversations.get', { id })).settings.budgetOverrides.maxTokens, 555);
  assert.equal((await call('settings.get')).budgets.maxTokens, 444, 'Local stale saves must preserve global budgets.');
  await run('document.querySelector("#budget-status-reload").onclick()');
  assert.equal(await run('document.querySelector("#budget-maxTokens").value'), '555');

  await run('openSettingsPanel("mcp")');
  await until('mcpDraft.length === 1', 'MCP panel did not load the disabled fixture.');
  await run(`(() => { mcpDraft[0].command = 'unsaved-renderer-command'; mcpDirty = true; renderMcp(); })()`);
  const currentMcp = (await call('settings.get')).mcpServers[0];
  await save({ mcpServers: [{ id: currentMcp.id, name: currentMcp.name, enabled: false, transport: 'stdio', command: 'newer-cli-command', args: [] }] });
  await run('document.querySelector("#btn-save-mcp").onclick()');
  assert.match(await run('document.querySelector("#mcp-status").textContent'), /changed.*CLI|Reload.*Settings/i);
  assert.equal((await call('settings.get')).mcpServers[0].command, 'newer-cli-command');
  assert.equal(await run('mcpDraft[0].command'), 'unsaved-renderer-command');
  await run('document.querySelector("#mcp-status-reload").onclick()');
  assert.equal(await run('mcpDraft[0].command'), 'newer-cli-command');
  const encrypted = verifyKeys();
  assert.ok(modelRequests >= 2, 'Model discovery did not reach the in-process provider.');
  assert.equal(modelAuthPreserved, true, 'Omitted saved connection credential did not reach the model fixture.');
  assert.equal(chatRequests, 0, 'The smoke test attempted a model completion.');
  assert.deepEqual(errors, [], 'Renderer reported console errors.');
  console.log('CLI SETTINGS BRIDGE UI PASS: genuine handlers, secret preservation, all 42 budgets, appearance, conversation settings, disabled MCP, model listing, stale connection/conversation/budget/MCP drafts, dirty panel reopen, Reload actions, independent panel saves.');
  console.log('Credential preservation:', encrypted ? 'OS-encrypted vault verified.' : 'Platform fallback verified.');
  console.log('Isolated profile:', profile);
  clearTimeout(timeout); server.close(); app.exit(0);
})().catch(error => {
  console.error(redact(error.stack || error), 'Isolated profile:', profile, errors);
  clearTimeout(timeout); server.close(); app.exit(1);
});
