'use strict';
// Real renderer, preload and IPC with disposable projects and a loopback provider.
// No installed profile, saved conversations or external inference services are used.
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-new-chat-ui-'));
const profile = path.join(root, 'profile');
const project = path.join(root, 'project-one');
const otherProject = path.join(root, 'project-two');
for (const dir of [profile, project, otherProject]) fs.mkdirSync(dir);
const attachment = path.join(root, 'attachment.txt');
fs.writeFileSync(attachment, 'Disposable attachment: COBALT-742.');
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');

let win, hold = true;
const requests = [], releases = [], errors = [];
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture-default' }, { id: 'fixture-selected' }] }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  if (hold) await new Promise(resolve => releases.push(resolve));
  if (res.destroyed) return;
  const content = JSON.stringify({ status: 'complete', message: 'Disposable answer: COBALT-742.', actions: [], options: [] });
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  }
});
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [attachment] });
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await run(code)) return;
    await delay(40);
  }
  throw new Error(label);
}
function diskAgents() {
  const file = path.join(profile, 'agents.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).agents : [];
}
async function type(text) {
  await run(`composerInput.value=${JSON.stringify(text)}; composerInput.dispatchEvent(new Event('input',{bubbles:true}));`);
}
async function send(text) {
  await type(text);
  assert.equal(await run(`document.querySelector('#btn-send').textContent`), 'Send');
  await run('sendComposer()');
}
async function newChat() {
  await run(`document.querySelector('#btn-new-chat').onclick()`);
  await until('currentAgent?.draft === true && !composerIntentPending', 'New Chat did not select its draft');
  return run('currentAgent.id');
}
async function confirmDeletion(code) {
  await run(`void (${code});`);
  await until(`!!document.querySelector('dialog[open]')`, 'Delete confirmation was not shown');
  await run(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Confirm').click()`);
  await until(`currentAgent?.draft === true && !document.querySelector('dialog[open]')`, 'Deleting the selected conversation did not return to New Chat');
}
async function assertEmptyView() {
  await until('chatLog.children.length === 0 && chatLog.getBoundingClientRect().height === 0', 'Empty chat log still occupies a bubble below telemetry');
  assert.equal(await run('agentView.classList.contains("hidden")'), false, 'The composer view stays available');
  assert.equal(await run('composerInput.getBoundingClientRect().height > 0 && !composerInput.disabled'), true);
  assert.equal(await run('document.querySelector("#telemetry-dashboard").hidden'), false);
  assert.equal(await run('document.querySelectorAll("#tree-new-chat").length'), 1);
}
const timeout = setTimeout(() => {
  console.error('New Chat UI timed out:', root);
  app.exit(1);
}, 60000);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    theme: 'dark', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-default',
    telemetrySources: [], jevEnabled: false,
  }));
  fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([
    { name: 'Project one', dir: project }, { name: 'Project two', dir: otherProject },
  ]));
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof ReachWorkspace !== "undefined" && currentAgent?.draft === true && !!document.querySelector("#tree-new-chat")', 'Startup did not open New Chat');
  win.setContentSize(1440, 960);
  await run(`setDrawer(false); showTab('agents')`);
  await assertEmptyView();
  const firstDraft = await run('currentAgent.id');
  assert.equal(await run('currentAgent.dir'), project);
  assert.equal(await run('document.querySelector("#tree-new-chat").textContent.trim()'), 'New Chat');
  assert.equal((await run('reachApi.agents.list()')).length, 0);
  assert.equal(diskAgents().length, 0, 'Opening New Chat does not save an empty record');
  await type('Unsent text survives navigation.');
  for (let i = 0; i < 3; i++) assert.equal(await newChat(), firstDraft);
  assert.equal(await run('composerInput.value'), 'Unsent text survives navigation.');
  assert.equal((await run('reachApi.agents.list()')).length, 0);

  // The existing model, tool and attachment controls work before the first send.
  await run(`document.querySelector('[role=switch][aria-label=Web]').click()`);
  await until(`currentAgent.settings.features.web === false && !document.querySelector('[role=switch][aria-label=Web]').disabled`, 'Draft Web preference did not save');
  await run(`document.querySelector('#composer-model').click()`);
  await until(`!![...document.querySelectorAll('.model-choice')].find(button => button.textContent === 'fixture-selected')`, 'Draft model picker did not load');
  await run(`[...document.querySelectorAll('.model-choice')].find(button => button.textContent === 'fixture-selected').click()`);
  await until(`currentAgent.model === 'fixture-selected' && !document.querySelector('#composer-model').disabled`, 'Draft model preference did not save');
  await run(`document.querySelector('#btn-attach').onclick()`);
  assert.equal(await run('composerAttachments.length'), 1);
  assert.equal(diskAgents().length, 0, 'Configuring or attaching to a draft does not save a chat');
  await type('');
  fs.writeFileSync(path.join(root, 'new-chat-empty.png'), (await win.capturePage()).toPNG());

  await send('First saved conversation');
  await until('!currentAgent.draft && agentRunning', 'First send did not promote the current draft');
  assert.equal(await run('currentAgent.id'), firstDraft, 'Promotion retains attachment and settings ownership');
  let saved = await run(`reachApi.agents.get(${JSON.stringify(firstDraft)})`);
  assert.equal(saved.settings.features.web, false);
  assert.equal(saved.model, 'fixture-selected');
  assert.equal(saved.messages.filter(message => message.role === 'user').length, 1);
  assert.match(JSON.stringify(saved.messages), /attachment\.txt/);
  assert.equal((await run('reachApi.agents.list()')).length, 1);
  assert.equal(diskAgents().length, 1);
  await until(`document.querySelectorAll('#agent-tree .tree-delete').length === 1`, 'First send did not add one history entry');
  assert.equal(await run(`!!(document.querySelector('#tree-new-chat').compareDocumentPosition(document.querySelector('#agent-tree .tree-delete')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true, 'Saved history is below permanent New Chat');
  for (let attempt = 0; attempt < 200 && !requests.length; attempt++) await delay(25);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'fixture-selected');

  // The permanent entry can open a fresh draft while the former chat continues.
  const secondDraft = await newChat();
  assert.notEqual(secondDraft, firstDraft);
  await assertEmptyView();
  assert.equal((await run(`reachApi.agents.get(${JSON.stringify(firstDraft)})`)).runState.status, 'running');
  assert.equal(await run('!!agentRunning'), false);
  await type('Project one draft');
  await run(`selectProject({name:'Project two',dir:${JSON.stringify(otherProject)}})`);
  await until(`currentAgent?.draft === true && currentAgent.dir === ${JSON.stringify(otherProject)}`, 'Project switching did not select its draft');
  const projectTwoDraft = await run('currentAgent.id');
  assert.notEqual(projectTwoDraft, secondDraft);
  await type('Project two draft');
  await run(`selectProject({name:'Project one',dir:${JSON.stringify(project)}})`);
  assert.equal(await run('currentAgent.id'), secondDraft);
  assert.equal(await run('composerInput.value'), 'Project one draft');
  await run(`selectProject({name:'Project two',dir:${JSON.stringify(otherProject)}})`);
  assert.equal(await run('currentAgent.id'), projectTwoDraft);
  assert.equal(await run('composerInput.value'), 'Project two draft');
  await run(`selectAgent({id:${JSON.stringify(firstDraft)}})`);
  hold = false;
  for (const release of releases.splice(0)) release();
  await until('!agentRunning && currentAgent.runState.status === "completed"', 'Background conversation did not finish after returning');
  await confirmDeletion(`document.querySelector('#btn-agent-delete').onclick()`);
  await assertEmptyView();
  assert.equal((await run('reachApi.agents.list()')).length, 0);

  // Removing a parent while viewing its branch must also land in New Chat.
  await send('Disposable parent conversation');
  await until('!currentAgent.draft && !agentRunning && currentAgent.runState.status === "completed"', 'Parent fixture did not complete');
  const parentId = await run('currentAgent.id');
  const branch = await run(`reachApi.agents.fork(${JSON.stringify(parentId)})`);
  assert.equal(branch.ok, true);
  await run(`selectAgent({id:${JSON.stringify(branch.agent.id)}})`);
  await confirmDeletion(`deleteAgentById(${JSON.stringify(parentId)}, 'Disposable parent conversation')`);
  await assertEmptyView();
  assert.equal((await run('reachApi.agents.list()')).length, 0);

  // A rejected attachment send keeps the unsent draft instead of a blank history row.
  await run(`document.querySelector('#btn-attach').onclick()`);
  assert.equal(await run('composerAttachments.length'), 1);
  fs.unlinkSync(attachment);
  const beforeRejected = requests.length;
  const rejectedDraft = await run('currentAgent.id');
  await send('Keep this unsent draft.');
  assert.equal(await run('composerInput.value'), 'Keep this unsent draft.');
  assert.equal(await run('composerAttachments.length'), 1);
  assert.equal(await run('currentAgent.id'), rejectedDraft);
  assert.equal(await run('currentAgent.draft'), true);
  assert.equal(await run('document.querySelector("#btn-send").disabled'), false);
  assert.equal((await run('reachApi.agents.list()')).length, 0);
  assert.equal(diskAgents().length, 0);
  assert.equal(requests.length, beforeRejected);

  // Commands work from an unbound landing draft; only a message needs a folder.
  let folderPicks = 0;
  dialog.showOpenDialog = async () => {
    folderPicks++;
    return { canceled: false, filePaths: [otherProject] };
  };
  await run('(async () => { agentProjectDir = null; currentProject = null; await selectNewChat(); })()');
  const unboundDraft = await run('currentAgent.id');
  assert.equal(await run('currentAgent.draft'), true);
  assert.equal(await run('!!currentAgent.dir'), false);
  await type('/help');
  await run('sendComposer()');
  assert.equal(folderPicks, 0, 'Help must not open a folder picker');
  assert.equal(await run('currentAgent.id'), unboundDraft);
  assert.equal(await run('currentAgent.draft'), true);
  assert.equal(await run('composerInput.value'), '');
  assert.equal(diskAgents().length, 0);
  await type('/msg @current --model "unterminated');
  await run('sendComposer()');
  assert.equal(folderPicks, 0, 'Malformed command arguments must reach their normal validation');
  assert.equal(await run('composerIntentPending'), false);
  assert.match(await run('chatLog.textContent'), /Command not sent:/);
  assert.equal(await run('composerInput.value'), '/msg @current --model "unterminated');
  await type('@current First message from an unbound draft.');
  await run('sendComposer()');
  await until('!currentAgent.draft && !agentRunning && currentAgent.runState.status === "completed"', 'Mention send from an unbound draft did not finish');
  assert.equal(folderPicks, 1);
  assert.equal(await run('currentAgent.id'), unboundDraft, 'Choosing a folder preserves the initial draft identity');
  assert.equal(await run('currentAgent.dir'), otherProject);
  assert.equal(await run('composerInput.value'), '');
  saved = await run(`reachApi.agents.get(${JSON.stringify(unboundDraft)})`);
  assert.equal(saved.messages.filter(message => message.role === 'user').length, 1);
  assert.match(saved.messages.find(message => message.role === 'user').content, /First message from an unbound draft/);
  assert.equal((await run('reachApi.agents.list()')).length, 1);
  assert.equal(diskAgents().length, 1);

  // First submission determines history order, including a draft opened earlier.
  await newChat();
  assert.equal(await run('currentAgent.dir'), otherProject);
  await send('Newest saved conversation');
  await until('!currentAgent.draft && !agentRunning && currentAgent.runState.status === "completed"', 'Second saved conversation did not finish');
  await until(`document.querySelectorAll('#agent-tree .tree-name').length === 2`, 'Second conversation did not enter history');
  assert.equal(await run(`document.querySelector('#agent-tree .tree-name').textContent`), 'Newest saved conversation');
  assert.equal((await run('reachApi.agents.list()')).length, 2);
  assert.equal(diskAgents().length, 2);
  assert.deepEqual(errors, []);
  console.log('NEW CHAT UI PASS: startup, permanent navigation, no empty bubble, draft settings and attachments, promotion, background run, project drafts, deletion, branch deletion, rejected send, unbound help and mention dispatch, newest conversation first.');
  console.log('Isolated profile and screenshot:', root);
  clearTimeout(timeout);
  server.closeAllConnections(); server.close(); app.exit(0);
})().catch(error => {
  console.error(error.stack || error, 'Isolated profile:', root, errors);
  clearTimeout(timeout);
  server.closeAllConnections(); server.close(); app.exit(1);
});
