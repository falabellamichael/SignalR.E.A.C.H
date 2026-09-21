'use strict';
// Actual Electron renderer/IPC. Jev is stubbed and answer models are loopback fixtures.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-jev-auto-ui-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
app.setPath('userData', profile);
delete process.env.TYPESAFE_API_KEY;
let win, jevMode = 'model', jevCalls = 0;
let pointerHold = false, pointerResponse = null;
const errors = [], modelRequests = [], jevRequests = [];
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return originalFetch(url, options);
  jevCalls++;
  const body = JSON.parse(options.body); jevRequests.push(body);
  if (jevMode === 'wait') return new Promise((_resolve, reject) => {
    if (options.signal.aborted) reject(options.signal.reason);
    else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  if (jevMode === 'error') return new Response('', { status: 503 });
  const answers = {};
  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === 'choice') {
      const options = Object.entries(question.criteria);
      const selected = options.find(([, value]) => JSON.stringify(value).includes(jevMode === 'team' ? 'Review crew' : 'Small model'))?.[0] || 'current';
      answers[id] = { type: 'choice', choice: selected, confidence: 0.99,
        probabilities: Object.fromEntries(options.map(([key]) => [key, key === selected ? 1 : 0])) };
    } else answers[id] = { type: 'noul', noul: jevMode === 'team' && ['need_agent', 'need_workspace', 'need_think'].includes(id) ? 1 : 0 };
  }
  return Response.json({ answers, usage: { input_tokens: 100, output_tokens: 20 } });
};
const server = http.createServer(async (req, res) => {
  if (req.url === '/deferred.txt') {
    if (pointerHold) { pointerResponse = res; return; }
    res.end(`http://127.0.0.1:${server.address().port}/small/v1`); return;
  }
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture-default' }, { id: 'fixture-small' }] })); return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); modelRequests.push({ url: req.url, body, authorization: req.headers.authorization });
  const content = JSON.stringify({ status: 'complete', message: 'Disposable Auto answer.', actions: [], options: [] });
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  }
});
app.on('browser-window-created', (_event, window) => {
  win = window; setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 250; i++) { if (await run(code)) return; await delay(40); }
  throw new Error(label);
}
async function submit(text) {
  await run(`composerInput.value=${JSON.stringify(text)}; composerInput.dispatchEvent(new Event('input'));`);
  await run('sendComposer()');
  await until('!composerIntentPending && !agentRunning', 'Submission did not finish');
}
const timeout = setTimeout(() => { console.error('Auto UI timed out', root); app.exit(1); }, 90000);
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Disposable project', dir: project }]));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [], jevApiKey: 'dummy-auto-fixture', jevAutoMode: false,
    connections: [
      { id: 'default', name: 'Default model', endpoint: endpoint + '/v1', accessKey: 'fixture-default-only', model: 'fixture-default', enabled: true },
      { id: 'small', name: 'Small model', endpoint: endpoint + '/small/v1', model: 'fixture-small', enabled: true },
    ], activeConnection: 'default' }));
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady(); while (!win || win.webContents.isLoading()) await delay(40);
  await until('currentAgent?.draft && !!window.ReachTeamComposer', 'Renderer did not initialize');
  await run(`showTab('agents')`);
  assert.equal(await run(`document.querySelector('#jev-auto-toggle').getAttribute('aria-checked')`), 'false');
  await run(`document.querySelector('#jev-auto-toggle').onclick()`);
  assert.equal(await run('currentAgent.settings.jevAutoMode'), true);
  assert.equal((await run('reachApi.agents.list()')).length, 0);
  await submit('Explain what a closure means in one short paragraph.');
  assert.equal(modelRequests.at(-1).body.model, 'fixture-small');
  assert.match(modelRequests.at(-1).url, /^\/small\//);
  assert.equal(modelRequests.at(-1).authorization, undefined, 'A selected keyless endpoint cannot receive another connection credential');
  let saved = await run('reachApi.agents.get(currentAgent.id)');
  assert.equal(saved.model, ''); assert.equal(saved.connectionId, '');
  assert.equal(saved.settings.features?.agent, undefined, 'Auto tool masks must not persist');
  assert.match(await run(`document.querySelector('#jev-auto-status').textContent`), /Small model|fixture-small/);
  const beforeManual = jevCalls;
  await submit('/say Keep this explicitly routed message on the selected model.');
  assert.equal(jevCalls, beforeManual, 'Slash dispatch bypasses Auto routing');
  assert.equal(modelRequests.at(-1).body.model, 'fixture-default');
  assert.equal(modelRequests.at(-1).authorization, 'Bearer fixture-default-only');

  // A team choice applies once and never switches persistent Teams on.
  const persona = await run(`reachApi.personas.create({name:'Reviewer',model:'fixture-default',prompt:'Review the request briefly.'})`);
  assert.equal(persona.ok, true);
  const team = await run(`reachApi.teams.create({name:'Review crew',mode:'parallel',members:[{personaId:${JSON.stringify(persona.persona.id)},role:'Reviewer'}]})`);
  assert.equal(team.ok, true);
  await run(`(async () => { const res = await reachApi.agents.update(currentAgent.id,{settings:{teamChat:{useHistory:false}}}); currentAgent=res.agent; })()`);
  const beforeTeamRequests = modelRequests.length;
  jevMode = 'team';
  await submit('Review the architecture and its test coverage as separate workstreams.');
  await until('teamConversationViews.get(currentAgent.id)?.deck.ended && !activeTeamRun', 'Automatically selected team did not finish');
  saved = await run('reachApi.agents.get(currentAgent.id)');
  assert.notEqual(saved.settings.teamChat?.enabled, true, 'Auto team must not stick');
  assert.equal(await run('ReachTeamComposer.enabled()'), false);
  assert.equal(saved.model, '');
  assert.ok(modelRequests.slice(beforeTeamRequests).every(request => !JSON.stringify(request.body.messages).includes('Explain what a closure means')), 'Auto teams honor the saved history opt-out');

  jevMode = 'error';
  await submit('Give a concise explanation of immutable values.');
  assert.equal(modelRequests.at(-1).body.model, 'fixture-default', 'Service failure preserves selected model');
  assert.match(await run(`document.querySelector('#jev-auto-status').textContent`), /selected|current|503/i);

  // Cancellation keeps the exact draft and starts no answer request.
  await run('selectNewChat()');
  await run(`document.querySelector('#jev-auto-toggle').onclick()`);
  const beforeStop = modelRequests.length;
  jevMode = 'wait';
  await run(`composerInput.value='Plan the fixture project carefully before making any changes.'; void sendComposer();`);
  await until('!!jevAutoRoutingAgentId && document.querySelector("#btn-send").textContent === "Stop"', 'Auto selection cannot be stopped');
  await run('sendComposer()');
  await until('!composerIntentPending && !jevAutoRoutingAgentId', 'Auto cancellation left the composer busy');
  assert.equal(modelRequests.length, beforeStop);
  assert.equal(await run('currentAgent.draft'), true);
  assert.match(await run('composerInput.value'), /^Plan the fixture/);

  // Stop and configuration changes still win after routing, during endpoint resolution.
  jevMode = 'model'; pointerHold = true;
  await run(`(async () => { const s=await reachApi.getSettings(); await reachApi.saveSettings({connections:s.connections.map(c=>c.id==='small'?{...c,endpoint:${JSON.stringify(endpoint + '/deferred.txt')}}:c)}); })()`);
  const beforeStartup = modelRequests.length;
  await run(`composerInput.value='Explain closures again with a different concise example.'; void sendComposer();`);
  for (let i=0; i<200 && !pointerResponse; i++) await delay(40);
  assert.ok(pointerResponse, 'Selected endpoint resolution did not begin');
  assert.equal(await run(`document.querySelector('#btn-send').textContent`), 'Stop');
  await run('sendComposer()');
  pointerResponse.end(endpoint + '/small/v1'); pointerResponse = null;
  await until('!composerIntentPending', 'Stopping endpoint startup left a busy composer');
  assert.equal(modelRequests.length, beforeStartup, 'Stop during endpoint discovery must prevent the model request');
  assert.equal(await run('currentAgent.draft'), true);

  await run(`composerInput.value='Explain a lexical closure with another short example.'; void sendComposer();`);
  for (let i=0; i<200 && !pointerResponse; i++) await delay(40);
  assert.ok(pointerResponse, 'Second endpoint resolution did not begin');
  await run(`reachApi.agents.update(currentAgent.id,{settings:{features:{web:false}}})`);
  pointerResponse.end(endpoint + '/small/v1'); pointerResponse = null;
  await until('!composerIntentPending', 'Changed configuration left a busy composer');
  assert.equal(modelRequests.length, beforeStartup, 'Changed settings invalidate the selected route before sending');
  assert.equal(await run('currentAgent.draft'), true);
  assert.match(await run('composerInput.value'), /^Explain a lexical closure/);

  assert.ok(jevRequests.length >= 3);
  assert.ok(jevRequests.every(body => !JSON.stringify(body).includes('dummy-auto-fixture') && !JSON.stringify(body).includes(endpoint)), 'Routing metadata must exclude credentials/endpoints');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'jev-auto.png'), (await win.capturePage()).toPNG());
  console.log('JEV AUTO UI PASS: opt-in, temporary model/provider and tools, credential isolation, explicit routing, automatic team/history preference, fallback, cancellation during routing/startup, stale settings, no persisted route changes.');
  console.log('Isolated profile and screenshot:', root);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(0);
})().catch(error => {
  console.error(error.stack || error, 'Profile:', root, errors);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(1);
});
