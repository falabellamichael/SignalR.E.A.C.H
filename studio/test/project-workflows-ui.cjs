'use strict';
// Native workflow checks through the real preload, IPC, store, and tool runner.
// A local fixture model reads only a disposable manifest; no user profile or
// installed app is touched, and no paid model or production service is used.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-project-workflows-ui-'));
const profile = path.join(root, 'profile');
const project = path.join(root, 'project-one'), other = path.join(root, 'project-two');
for (const dir of [profile, project, other]) fs.mkdirSync(dir);
const manifest = JSON.stringify({ name: 'workflow-fixture-742', private: true });
fs.writeFileSync(path.join(project, 'package.json'), manifest);
fs.writeFileSync(path.join(other, 'package.json'), '{"name":"other-project"}');
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const store = new AgentStore(path.join(profile, 'agents.json'));
const previous = store.create({ name: 'Existing work', dir: project, model: 'workflow-selected-model' });
store.appendMessage(previous.id, { role: 'user', content: 'Existing saved conversation.' });
store.update(previous.id, { settings: { approvals: 'auto-read', reviewEdits: true, features: { web: false, terminal: false }, disabledTools: ['shell'] } });
let win;
const errors = [], requests = [], screenshots = [];
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"workflow-selected-model"}]}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const read = body.messages.some(message => message.role === 'user' && String(message.content).includes('TOOL RESULTS') && String(message.content).includes('workflow-fixture-742'));
  const content = JSON.stringify(read
    ? { status: 'complete', message: 'Fixture workflow completed after reading the selected project manifest. No security audit or migration was performed by this test model.', actions: [], options: [] }
    : { status: 'actions', message: 'Inspecting the fixture manifest.', actions: [{ name: 'read', arguments: { path: 'package.json' } }], options: [] });
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] })); }
});
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !message.includes("directive 'frame-ancestors' is ignored")) errors.push(message);
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 200; i++) { if (await run(code)) return; await delay(50); }
  throw new Error(label);
}
const timeout = setTimeout(() => { console.error('Project workflows UI timed out:', root); app.exit(1); }, 120000);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'workflow-default-model', telemetrySources: [], jevEnabled: false }));
  fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Same project name', dir: project }, { name: 'Same project name', dir: other }]));
  const appRoot = process.env.REACH_WORKFLOW_TEST_APP || path.resolve(__dirname, '..');
  if (process.env.REACH_WORKFLOW_TEST_APP) {
    // Load the physical package with its real packaged resource resolution,
    // while retaining this harness's disposable profile and local model.
    Object.defineProperty(app, 'isPackaged', { value: true });
    Object.defineProperty(process, 'resourcesPath', { value: path.dirname(appRoot) });
  }
  await import(pathToFileURL(path.join(appRoot, 'main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof ReachWorkspace !== "undefined" && typeof projectWorkflows !== "undefined" && !!currentProject', 'Renderer did not initialize');
  await run(`(async () => { setDrawer(false); await selectAgent({id:${JSON.stringify(previous.id)}}, {preserveEditors:true}); await showTab('projects'); })()`);
  // Preserve text, attachment selection, and a command draft through a real run.
  await run(`composerInput.value='UNSENT EXISTING WORK'; composerAttachments=[{attachmentId:'unsent-fixture',name:'draft.txt'}]; renderComposerAttachments(); cmdInput.value='node pending-command.js';`);
  const templateCount = await run(`document.querySelectorAll('[data-workflow]').length`);
  assert.equal(templateCount, 4);
  for (const id of ['security', 'hardening', 'migration', 'access']) {
    await run(`document.querySelector('[data-workflow=${id}]').click(); document.querySelector('#project-workflow-requirements').value=${JSON.stringify(`Fixture requirements for ${id}`)}; document.querySelector('#project-workflow-requirements').dispatchEvent(new Event('input'));`);
  }
  // Same-name folders and template selections keep distinct requirement drafts.
  await run(`selectProject({name:'Same project name',dir:${JSON.stringify(other)}})`);
  assert.equal(await run(`document.querySelector('#project-workflow-requirements').value`), '');
  await run(`selectProject({name:'Same project name',dir:${JSON.stringify(project)}},{openDraft:false})`);
  await run(`selectAgent({id:${JSON.stringify(previous.id)}},{preserveEditors:true})`);
  assert.equal(await run(`composerInput.value`), 'UNSENT EXISTING WORK');
  assert.equal(await run(`composerAttachments[0].attachmentId`), 'unsent-fixture');
  assert.equal(await run(`cmdInput.value`), 'node pending-command.js');

  const workflowIds = [];
  for (const id of ['security', 'hardening', 'migration', 'access']) {
    await run(`showTab('projects'); document.querySelector('[data-workflow=${id}]').click(); document.querySelector('#project-workflow-start').click();`);
    await until(`currentAgent?.name===${JSON.stringify({ security: 'Security review', hardening: 'Production hardening', migration: 'Cloud migration', access: 'Roles & business logic' }[id])} && currentAgent?.runState?.status==='completed' && !document.querySelector('#project-workflow-start').disabled`, `${id} workflow did not finish`);
    const agent = await run('reachApi.agents.get(currentAgent.id)'); workflowIds.push(agent.id);
    assert.equal(agent.dir, project); assert.equal(agent.model, 'workflow-selected-model');
    assert.equal(agent.settings.approvals, 'auto-read'); assert.equal(agent.settings.reviewEdits, true);
    assert.equal(agent.settings.features.terminal, false); assert.equal(agent.settings.features.web, false);
    assert.deepEqual(agent.settings.disabledTools, ['shell']);
    assert.ok(agent.messages.some(message => message.role === 'user' && message.content.includes(`Fixture requirements for ${id}`)));
    assert.ok(agent.messages.some(message => message.role === 'tool' && message.name === 'read' && JSON.parse(message.content).ok === true), 'A real structured read must execute');
    assert.ok(agent.messages.some(message => message._reachMeta?.source === 'tool-summary' && message.content.includes('workflow-fixture-742')), 'The actual selected project contents must reach the model');
    assert.equal(await run(`document.querySelector('#page-agents').classList.contains('active')`), true);
  }
  assert.equal(new Set(workflowIds).size, 4);
  await run(`selectAgent({id:${JSON.stringify(previous.id)}},{preserveEditors:true})`);
  assert.equal(await run('composerInput.value'), 'UNSENT EXISTING WORK');
  assert.equal(await run('composerAttachments[0].attachmentId'), 'unsent-fixture');
  assert.equal((await run(`reachApi.agents.get(${JSON.stringify(previous.id)})`)).messages.length, 1);
  assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), manifest);

  // Both themes, short windows, and narrow page widths retain reachable controls.
  await run(`showTab('projects')`);
  win.setMinimumSize(0, 0); // Exercise compact layouts beyond the supported shell minimum too.
  for (const [width, height] of [[1440, 960], [1000, 640], [640, 720]]) {
    win.setContentSize(width, height);
    for (const theme of ['dark', 'light']) {
      await run(`document.querySelector('#theme-select').value='${theme}'; document.querySelector('#theme-select').onchange(); document.querySelector('#project-workflows').scrollIntoView({block:'start'});`);
      await delay(250); // Allow the existing theme color transitions to settle.
      const geometry = await run(`(() => { const work=document.querySelector('#page-projects>.work'), panel=document.querySelector('#project-workflows'), start=document.querySelector('#project-workflow-start'); return {overflow:document.body.scrollWidth>innerWidth,workOverflow:work.scrollWidth>work.clientWidth+1,panel:panel.getBoundingClientRect().toJSON(),start:start.getBoundingClientRect().toJSON(),height:innerHeight}; })()`);
      assert.equal(geometry.overflow, false); assert.equal(geometry.workOverflow, false);
      await run(`document.querySelector('#project-workflow-start').scrollIntoView({block:'nearest'})`);
      assert.equal(await run(`document.querySelector('#project-workflow-start').getBoundingClientRect().bottom<=innerHeight`), true);
      const name = `projects-${theme}-${width}.png`;
      fs.writeFileSync(path.join(root, name), (await win.capturePage()).toPNG()); screenshots.push(name);
    }
  }
  assert.deepEqual(errors, []);
  const report = { appRoot, packagedArchive: !!process.env.REACH_WORKFLOW_TEST_APP, workflows: 4, requests: requests.length, structuredReads: 4, preservedDrafts: true, preservedAttachments: true, preservedCommandDraft: true, screenshots, errors };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PROJECT WORKFLOWS UI PASS', JSON.stringify(report)); console.log('Artifacts:', root);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(0);
})().catch(error => {
  console.error(error.stack || error, 'Artifacts:', root, errors);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(1);
});
