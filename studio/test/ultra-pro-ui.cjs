'use strict';
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const { presets } = require('../agent/budgets.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-ultra-ui-'));
const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
app.setPath('userData', profile); os.homedir = () => root;
let win;
app.on('browser-window-created', (_, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.setBackgroundThrottling(false);
});
const delay = ms => new Promise(r => setTimeout(r, ms));
const run = code => win.webContents.executeJavaScript(code, true);
const requests = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'ornith-fixture', capabilities: { outputTokenLimit: true, jsonSchema: true } }] }));
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  if (body.max_tokens > 512) { res.writeHead(400); return res.end(JSON.stringify({ error: { code: 'output_limit', message: 'Output limit must be between 1 and 512.' } })); }
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'complete', message: 'Verified final answer.', actions: [], options: [] }) }, finish_reason: 'stop' }] }));
});
const timeout = setTimeout(() => { console.error('Ultra_Pro UI timed out.'); app.exit(1); }, 90000);
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    connections: [{ id: 'fixture', name: 'Fixture', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'ornith-fixture' }],
    activeConnection: 'fixture', budgets: presets.unrestricted,
  }));
  const fixture = new AgentStore(path.join(profile, 'agents.json')).create({ name: 'Ultra fixture', dir: root });
  const target = process.argv[2] ? path.resolve(process.argv[2], 'main.mjs') : path.resolve(__dirname, '../main.mjs');
  await import(pathToFileURL(target).href); await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(50);
  await run("openSettingsPanel('budgeting')");
  assert.equal(await run("document.querySelector('#budget-ultraPro').getAttribute('role')"), 'switch');
  assert.equal(await run("document.querySelector('#budget-ultraPro').checked"), false);
  await run("document.querySelector('#budget-ultraPro').click(); document.querySelector('#btn-save-budgets').onclick()");
  let settings = await run('reachApi.getSettings()');
  assert.equal(settings.budgets.ultraPro, true);
  assert.equal(settings.budgets.maxTokens, 0, 'Normal output setting is retained');
  assert.equal(settings.budgets.autoCompact, false, 'Normal compression setting is retained');
  await run(`reachApi.agents.send(${JSON.stringify(fixture.id)}, 'Answer concisely.')`);
  let agent;
  for (let i = 0; i < 100; i++) { agent = await run(`reachApi.agents.get(${JSON.stringify(fixture.id)})`); if (agent.runState?.status === 'completed') break; await delay(50); }
  assert.equal(agent.runState.status, 'completed');
  assert.deepEqual(requests.map(r => r.max_tokens), [1024, 512]);
  assert.match(requests[1].messages[0].content, /Hard output allowance: 512/);
  await run("document.querySelector('#budget-ultraPro').click(); document.querySelector('#btn-save-budgets').onclick()");
  settings = await run('reachApi.getSettings()');
  assert.equal(settings.budgets.ultraPro, false);
  assert.equal(settings.budgets.maxTokens, 0);
  assert.equal(settings.budgets.autoCompact, false);
  console.log(JSON.stringify({ ui: 'passed', persisted: true, normalBudgetsRestored: true, providerCapLearned: true, completed: true, profile }));
  clearTimeout(timeout); server.close(); app.exit(0);
})().catch(error => { console.error(error.stack); clearTimeout(timeout); server.close(); app.exit(1); });
