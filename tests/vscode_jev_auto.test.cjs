'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { routeWithJev, toolsForProfile } = require('../vscode/typesafe-auto');
const extensionPath = path.resolve(__dirname, '../vscode/extension.js');
const source = fs.readFileSync(extensionPath, 'utf8');

function answers(body, overrides = {}) {
  return { answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: overrides[id] ?? 0.05 }];
    const selected = overrides[id] || (id === 'model' ? 'model_0' : id === 'mode' ? 'direct' : 'inspect');
    return [id, { type: 'choice', choice: selected, confidence: 0.99,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) }];
  })), usage: { input_tokens: 130, output_tokens: 25 } };
}

function host({ enabled = true, key = 'secret-for-test', trusted = true, route = {}, rawResponse } = {}) {
  const calls = [], posts = [], contexts = [];
  const settings = { provider: 'endpoint', endpoint: 'https://chat.example/v1', model: 'large-code-model',
    typesafeAutoMode: enabled, think: false, webSearch: false, disabledTools: ['shell'] };
  const request = createRequire(extensionPath);
  const vscode = { ConfigurationTarget: { Global: 1 }, Uri: { joinPath: (root, rel) => ({ fsPath: path.join(root.fsPath, rel) }) }, window: { tabGroups: { all: [] } },
    workspace: { isTrusted: trusted, workspaceFolders: [], textDocuments: [],
      getConfiguration: () => ({ get: name => settings[name], update: async (name, value) => { settings[name] = value; } }) } };
  const sandbox = { module: { exports: {} }, console, process, Buffer, URL, AbortController, AbortSignal,
    TextDecoder, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? vscode : name === './search' ? {} : request(name),
    fetch: async (url, options) => {
      const body = JSON.parse(options.body || '{}');
      calls.push({ url, options, body });
      if (url === 'https://api.typesafe.ai/v1/systemone') return new Response(JSON.stringify(
        rawResponse ? rawResponse(body) : answers(body, route)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A useful answer.' }, finish_reason: 'stop' }] }));
    } };
  vm.runInNewContext(source + '\nmodule.exports.Provider = ReachChatViewProvider; module.exports.config = config;', sandbox,
    { filename: extensionPath });
  const provider = new sandbox.module.exports.Provider({ fsPath: '/extension' });
  provider._secrets = { get: async () => key };
  provider._post = (type, payload) => posts.push({ type, ...payload });
  provider._ideBridge = { handles: () => false };
  provider._compactContext = async messages => ({ messages, changed: false });
  provider._prepareWorkspaceContext = async (...args) => { contexts.push(args); return { block: 'Selected source', files: 1 }; };
  provider._modelCatalog = { key: provider._endpointKey(sandbox.module.exports.config()),
    routes: new Map([['large-code-model', settings.endpoint], ['small-fast-model', settings.endpoint]]) };
  let receive;
  provider._html = () => '';
  provider.resolveWebviewView({ webview: { onDidReceiveMessage: fn => { receive = fn; } } });
  const body = (extra = {}) => ({ autoTurnId: 'turn-1', autoRequest: 'Explain the difference between a list and a tuple.',
    model: 'large-code-model', agentic: true, includeWorkspace: true, think: false, webSearch: false,
    messages: [{ role: 'user', content: 'Explain the difference between a list and a tuple.\nPRIVATE ATTACHMENT CONTENT' }], ...extra });
  return { provider, settings, vscode, calls, posts, contexts, receive, body };
}

test('Auto applies chosen model and direct route without changing saved setup or sending attached context', async () => {
  const h = host();
  await h.provider._chat(h.body());
  assert.equal(h.calls.length, 2);
  const route = h.calls[0].body;
  assert.equal(route.model, 'jev-latest');
  assert.equal(JSON.stringify(route).includes('PRIVATE ATTACHMENT'), false);
  assert.equal(route.state.available_tools.includes('shell'), false);
  assert.equal(route.state.available_tools.includes('browser_open'), false);
  assert.equal(h.calls[1].body.model, 'small-fast-model');
  assert.match(h.calls[1].body.messages[0].content, /Agent mode is off/);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.settings.model, 'large-code-model');
  assert.equal(h.posts.find(post => post.type === 'jevAutoRoute').agentic, false);
  assert.ok(h.posts.some(post => post.result?.includes('130 input / 25 output')));
});

test('Agent route keeps selected context, narrows tools in execution, and reuses the route across tool rounds', async () => {
  const h = host({ route: { mode: 'agent', tools: 'inspect', workspace: 0.95 } });
  await h.provider._chat(h.body({ autoRequest: 'Review the parser implementation for bugs.' }));
  assert.equal(h.contexts[0][2], true);
  const sent = h.calls.at(-1).body;
  assert.match(sent.messages[0].content, /Jev Auto selected these tools/);
  assert.equal(h.provider._jevActiveTurn.result.tools.includes('read'), true);
  assert.equal(h.provider._jevActiveTurn.result.tools.includes('edit_patch'), false);
  await h.receive({ type: 'toolReq', uid: 'blocked', action: 'edit_patch' });
  assert.match(h.posts.find(post => post.uid === 'blocked').error, /did not select/);
  await h.provider._chat(h.body({ autoContinuation: true, includeWorkspace: false,
    messages: [{ role: 'user', content: 'TOOL RESULTS private source' }] }));
  assert.equal(h.calls.filter(call => call.url.includes('typesafe')).length, 1);
  assert.equal(h.calls.at(-1).body.model, 'small-fast-model');
  assert.match(h.calls.at(-1).body.messages[0].content, /Jev Auto selected these tools/);
});

test('Auto never enables disabled Agent, context, web, think, or untrusted workspace capabilities', async () => {
  const h = host({ trusted: false });
  await h.provider._chat(h.body({ includeWorkspace: false, agentic: false }));
  const request = h.calls[0].body;
  assert.deepEqual(request.state.permissions, { agent: false, workspace: false, web: false, think: false });
  assert.deepEqual(request.state.available_tools, []);
  assert.equal(request.questions.mode, undefined);
  assert.equal(request.questions.tools, undefined);
  assert.equal(request.questions.workspace, undefined);
  assert.equal(request.questions.web, undefined);
  assert.equal(request.questions.think, undefined);
  assert.equal(h.contexts.length, 0);
});

test('manual model selection pins the next prompt while other Auto decisions still apply', async () => {
  const h = host();
  await h.provider._chat(h.body({ manualModelOverride: true }));
  assert.equal(h.calls[0].body.questions.model, undefined);
  assert.equal(h.calls.at(-1).body.model, 'large-code-model');
  assert.equal(h.posts.find(post => post.type === 'jevAutoRoute').agentic, false);
});

test('disabled, missing-key, uncertain, invalid and contextual requests keep the manual route', async () => {
  for (const options of [{ enabled: false }, { key: '' },
    { rawResponse: body => { const result = answers(body); result.answers.mode.confidence = 0.4; return result; } },
    { rawResponse: body => { const result = answers(body); result.answers.mode.choice = 'invented-route'; return result; } }]) {
    const h = host(options);
    await h.provider._chat(h.body());
    assert.equal(h.calls.at(-1).body.model, 'large-code-model');
    assert.equal(h.posts.some(post => post.type === 'jevAutoRoute'), false);
    assert.match(h.calls.at(-1).body.messages[0].content, /agent_status/);
  }
  const h = host();
  await h.provider._chat(h.body({ autoRequest: 'continue with that' }));
  assert.equal(h.calls.some(call => call.url.includes('typesafe')), false);
});

test('Auto caches identical judgments and invalidates the cache when available models change', async () => {
  const h = host();
  await h.provider._chat(h.body());
  await h.provider._chat(h.body({ autoTurnId: 'turn-2' }));
  assert.equal(h.calls.filter(call => call.url.includes('typesafe')).length, 1);
  h.provider._modelCatalog.routes.set('another-model', 'https://chat.example/v1');
  await h.provider._chat(h.body({ autoTurnId: 'turn-3' }));
  assert.equal(h.calls.filter(call => call.url.includes('typesafe')).length, 2);
});

test('Stop during key lookup or a superseding request prevents routing and answer dispatch', async () => {
  for (const supersede of [false, true]) {
    const h = host();
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    h.provider._secrets.get = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const pending = h.provider._chat(h.body());
    await ready;
    if (supersede) h.provider._controller = new AbortController();
    else h.provider._controller.abort();
    release('secret');
    await pending;
    assert.equal(h.calls.length, 0);
  }
});

test('malformed service responses fall back to the existing answer path', async () => {
  const h = host({ rawResponse: () => ({ error: 'unavailable' }) });
  await h.provider._chat(h.body());
  assert.equal(h.calls.at(-1).body.model, 'large-code-model');
  assert.ok(h.posts.some(post => post.result?.includes('Jev Auto is unavailable')));
});

test('tool profiles keep only supplied names and plain context questions retain uncertain context flags', async () => {
  assert.deepEqual(toolsForProfile(['read', 'shell', 'browser_open', 'todo_write'], 'inspect'), ['read', 'todo_write']);
  const result = await routeWithJev({ key: 'unused', request: 'Explain the parser implementation.', currentModel: 'selected',
    models: ['selected'], permissions: { agent: true, workspace: true, web: false, think: false }, tools: ['read'],
    fetchImpl: async (_, options) => new Response(JSON.stringify(answers(JSON.parse(options.body), { workspace: 0.48 }))) });
  assert.equal(result.permissions.workspace, true);
});

test('single-model routes omit model judgments and deterministic routes need no Jev call', async () => {
  let calls = 0;
  const input = { key: 'unused', request: 'Explain the parser implementation.', currentModel: 'only-model',
    models: ['only-model'], permissions: { agent: false, workspace: false, web: false, think: false }, tools: [],
    fetchImpl: async (_, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.questions.model, undefined);
      return new Response(JSON.stringify(answers(body)));
    } };
  const result = await routeWithJev(input);
  assert.equal(calls, 0);
  assert.equal(result.skipped, true);
  assert.equal(result.model, 'only-model');
  assert.equal(result.agentic, false);
  await routeWithJev({ ...input, permissions: { ...input.permissions, agent: true } });
  assert.equal(calls, 1);
});

test('the actual webview done handler completes an Auto direct answer without agent recovery', () => {
  const chat = fs.readFileSync(path.resolve(__dirname, '../vscode/media/chat.js'), 'utf8');
  const done = chat.slice(chat.indexOf("      case 'done': {"), chat.indexOf("      case 'toolResult': {"));
  const agentRun = require('../vscode/media/agent-run');
  const calls = [];
  const context = { agentRun, busy: true, msg: { full: 'Here is your answer.' }, answeringNow: false,
    stopRequested: false, rafPending: false, agenticEnabled: true, pendingText: '', pendingBubble: {}, pendingEdits: [],
    pendingActionContext: '', activeResponseStep: null, agentRounds: 0, MAX_AGENT_ROUNDS: Infinity,
    UNFINISHED_RETRY_LIMIT: 2, activeRequestLength: 1, conv: { messages: [], agentRun: agentRun.start(), jevTurn: { agentic: false } },
    setRich() {}, maskFenced: text => text, saveAgentRun(value) { context.conv.agentRun = value; },
    saveConv() {}, persist() {}, showStep() {}, finishBubble(outcome) { context.outcome = outcome; },
    continueAgent() { calls.push('retry'); }, hint() {}, pickFun() {}, ABORT_LINES: [] };
  vm.runInNewContext('switch ("done") {' + done + '}', context);
  assert.equal(context.outcome, 'completed');
  assert.deepEqual(calls, []);
  assert.equal(context.conv.messages[0].content, 'Here is your answer.');
});
