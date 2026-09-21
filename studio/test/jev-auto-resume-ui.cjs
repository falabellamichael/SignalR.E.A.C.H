'use strict';

// Disposable Electron/IPC regression: a Settings save during edit review must
// retain that accepted turn's Auto route and tool mask on its continuation.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-jev-auto-resume-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project); app.setPath('userData', profile);
delete process.env.TYPESAFE_API_KEY;
const requests = [], errors = [];
let win;
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return originalFetch(url, options);
  const body = JSON.parse(options.body), answers = {};
  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === 'choice') {
      const options = Object.entries(question.criteria);
      const choice = options.find(([, value]) => JSON.stringify(value).includes('Small model'))?.[0] || 'current';
      answers[id] = { type: 'choice', choice, confidence: 1,
        probabilities: Object.fromEntries(options.map(([key]) => [key, key === choice ? 1 : 0])) };
    } else answers[id] = { type: 'noul', noul: ['need_terminal', 'need_web'].includes(id) ? 0 : 1 };
  }
  return Response.json({ answers, usage: { input_tokens: 10, output_tokens: 5 } });
};
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push({ url: req.url, body, authorization: req.headers.authorization });
  const content = JSON.stringify(requests.length % 2 === 1
    ? { status: 'actions', message: 'Propose the fixture file.', actions: [{ name: 'write', arguments: { path: 'fixture.txt', content: 'Disposable proposed text.' } }], options: [] }
    : { status: 'complete', message: 'Review decision received.', actions: [], options: [] });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
app.on('browser-window-created', (_event, window) => {
  win = window; setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 200; i++) { if (await run(code)) return; await delay(40); }
  throw new Error(label);
}
const timeout = setTimeout(() => { console.error('Auto resume fixture timed out', root); app.exit(1); }, 60000);
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Disposable fixture', dir: project }]));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ telemetrySources: [], jevApiKey: 'dummy-resume-key', jevAutoMode: true,
    connections: [
      { id: 'default', name: 'Default model', endpoint: endpoint + '/v1', model: 'fixture-default', accessKey: 'dummy-default-key', enabled: true },
      { id: 'small', name: 'Small model', endpoint: endpoint + '/small/v1', model: 'fixture-small', enabled: true },
    ], activeConnection: 'default' }));
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady(); while (!win || win.webContents.isLoading()) await delay(40);
  await until('!!currentAgent?.draft', 'Draft not initialized');
  const id = await run('currentAgent.id');
  for (const mutation of ['settings', 'connections']) {
    const query = `Create a tiny fixture text file for the ${mutation} review check.`;
    const plan = await run(`reachApi.agents.autoPlan(${JSON.stringify(id)}, ${JSON.stringify(query)})`);
    assert.equal(plan.ok, true); assert.ok(plan.token);
    const result = await run(`reachApi.agents.send(${JSON.stringify(id)}, ${JSON.stringify(query)}, [], {autoToken:${JSON.stringify(plan.token)}})`);
    assert.equal(result.ok, true);
    await until(`reachApi.agents.get(${JSON.stringify(id)}).then(a => a.runState?.status === 'waiting_edits' && Object.keys(a.pendingEdits).length === 1)`, 'Run did not reach edit review');
    const edited = mutation === 'settings'
      ? await run(`reachApi.saveSettings({theme:'light'})`)
      : await run(`reachApi.connections.save({action:'activate',id:'small'})`);
    assert.equal(edited.ok, true);
    const pending = await run(`reachApi.agents.get(${JSON.stringify(id)})`);
    const reviewed = await run(`reachApi.agents.resolveEdit(${JSON.stringify(id)}, ${JSON.stringify(Object.keys(pending.pendingEdits)[0])}, false)`);
    assert.equal(reviewed.ok, true);
    await until(`reachApi.agents.get(${JSON.stringify(id)}).then(a => a.runState?.status === 'completed')`, 'Review continuation did not complete');
  }
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.body.model, 'fixture-small');
    assert.match(request.url, /^\/small\//);
    assert.equal(request.authorization, undefined, 'Keyless selected endpoint must not inherit the active key');
    const system = request.body.messages.find(message => message.role === 'system').content;
    assert.doesNotMatch(system, /"name":"shell"|"name":"reach.run"/, 'Continuation must retain its Auto terminal restriction');
  }
  assert.equal(fs.existsSync(path.join(project, 'fixture.txt')), false, 'Rejected proposals must not write files');
  const saved = await run(`reachApi.agents.get(${JSON.stringify(id)})`);
  assert.equal(saved.model, ''); assert.equal(saved.settings.features?.terminal, undefined);
  assert.deepEqual(errors, []);
  console.log('JEV AUTO RESUME UI PASS: Settings and connection saves preserve selected model, endpoint and tool mask across actual edit-review continuation.');
  console.log('Isolated fixture:', root);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(0);
})().catch(error => {
  console.error(error.stack || error, 'Fixture:', root, errors);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(1);
});
