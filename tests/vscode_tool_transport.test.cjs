'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const filename = path.resolve(__dirname, '../vscode/media/chat.js');
const source = fs.readFileSync(filename, 'utf8');

// Load the actual webview functions without starting its DOM and VS Code API
// bootstrapping. Function-level closing braces use the IIFE's two-space indent.
function extractFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `Missing source function ${name}`);
  const end = source.indexOf('\n  }', start);
  assert.notEqual(end, -1, `Missing closing brace for ${name}`);
  return source.slice(start, end + '\n  }'.length);
}

function fixture(includeWorkspace = true) {
  const posts = [], steps = [];
  const state = {
    includeWorkspace,
    stepRows: [{ closed: false, real: false }],
    contTools: [], contResolved: 0, agentRounds: 0, agentMessages: [], pendingBubble: null,
    conv: { model: 'example-model', messages: [{ role: 'user', content: 'Inspect my repository and extension.' }] },
    pendingText: '', pendingActionContext: '', activeRequestLength: 1, persist() {}, saveConv() {},
    startSteps: () => steps.push(['start']),
    closeStep: step => { step.closed = true; },
    pickVoice: (action, detail) => ({ text: `${action}: ${detail || ''}`, title: action }),
    addStepRow: (...args) => steps.push(['row', ...args]),
    showStep: (...args) => steps.push(['show', ...args]),
    post: (type, body) => posts.push({ type, body: JSON.parse(JSON.stringify(body)) }),
  };
  state.agentMessages = state.conv.messages.slice();
  vm.createContext(state);
  vm.runInContext(['repairJson', 'extractTools', 'beginToolRound', 'continueAgent'].map(extractFunction).join('\n'), state, { filename });
  return { state, posts, steps, parse: text => state.extractTools(text) };
}

const fence = request => '```tool\n' + JSON.stringify(request) + '\n```';

test('all new tool actions retain their selectors and options through parsing and dispatch', () => {
  const f = fixture();
  const requests = [
    { action: 'vscode', topic: 'extensions', extensionId: 'ms-python.python', query: 'Python', details: true, limit: 7 },
    { action: 'vscode', topic: 'diagnostics', path: 'src/app.js', severity: 'warning', workspace: 0, limit: 3 },
    { action: 'vscode', topic: 'settings', key: 'editor.tabSize', query: 'tab' },
    { action: 'git', operation: 'diff', repository: 0, workspace: 0, staged: true, path: 'src/app.js', maxChars: 12345, maxChanges: 25, limit: 9 },
    { action: 'pullRequests', repository: 0, remote: 'upstream', lookup: false, state: 'all', limit: 8 },
    { action: 'open', workspace: 0, path: 'src/app.js', line: 7, column: 3 },
    { action: 'runTask', workspace: 0, name: 'Build' },
    { action: 'vscodeCommand', command: 'example.inspect' },
  ];
  const parsed = f.parse(requests.map(fence).join('\n'));
  assert.equal(parsed.text, '');
  assert.equal(parsed.tools.length, requests.length);
  f.state.beginToolRound(parsed.tools);
  assert.equal(f.posts.length, requests.length);
  requests.forEach((request, index) => {
    for (const [key, value] of Object.entries(request)) {
      assert.deepEqual(parsed.tools[index][key], value, `parser lost ${request.action}.${key}`);
      assert.deepEqual(f.posts[index].body[key], value, `dispatch lost ${request.action}.${key}`);
    }
    assert.equal(f.posts[index].type, 'toolReq');
    assert.equal(f.posts[index].body.allowIdeContext, true);
    assert.equal(typeof f.posts[index].body.uid, 'string');
    assert.equal(f.posts[index].body.result, null);
  });
  assert.equal(f.steps[0][0], 'start');
  assert.equal(f.steps.filter(step => step[0] === 'row').length, requests.length);
  assert.equal(f.state.contResolved, 0);
});

test('workspace and repository selectors preserve zero, exact names, and absolute roots', () => {
  const f = fixture();
  for (const selector of [0, 1, 'web-app', 'D:\\Projects\\web-app']) {
    const request = { action: 'git', repository: selector, workspace: selector };
    const parsed = f.parse(fence(request)).tools[0];
    assert.equal(parsed.repository, selector);
    assert.equal(parsed.workspace, selector);
    f.state.beginToolRound([parsed]);
    assert.equal(f.posts.at(-1).body.repository, selector);
    assert.equal(f.posts.at(-1).body.workspace, selector);
  }
});

test('range aliases and navigation coordinates survive transport without becoming undefined', () => {
  const f = fixture();
  for (const request of [
    { action: 'read', path: 'src\\main.js', startLine: 12, endLine: 45 },
    { action: 'read', path: 'src\\main.js', start_line: 12, end_line: 45 },
    { action: 'read', path: 'src\\main.js', startLine: 12, start_line: 99, endLine: 45, end_line: 100 },
  ]) {
    const parsed = f.parse(fence(request)).tools[0];
    assert.equal(parsed.path, 'src/main.js');
    assert.equal(parsed.startLine, 12);
    assert.equal(parsed.endLine, 45);
    f.state.beginToolRound([parsed]);
    assert.equal(f.posts.at(-1).body.startLine, 12);
    assert.equal(f.posts.at(-1).body.endLine, 45);
  }
  const parsed = f.parse(fence({ action: 'vscode', topic: 'definition', workspace: 0, path: 'src/main.js', line: 25, column: 9 })).tools[0];
  assert.equal(parsed.line, 25);
  assert.equal(parsed.column, 9);
});

test('optional Git controls preserve omission and false without enabling PR lookup accidentally', () => {
  const f = fixture();
  const defaults = f.parse(fence({ action: 'pullRequests' })).tools[0];
  for (const field of ['lookup', 'state', 'maxChars', 'maxChanges', 'workspace', 'line', 'column', 'startLine', 'endLine']) {
    assert.equal(defaults[field], undefined, `unspecified ${field} must stay unspecified`);
  }
  f.state.beginToolRound([defaults]);
  assert.equal(f.posts.at(-1).body.lookup, undefined);
  for (const lookup of [false, true]) {
    const parsed = f.parse(fence({ action: 'pullRequests', lookup, limit: 2 })).tools[0];
    f.state.beginToolRound([parsed]);
    assert.equal(f.posts.at(-1).body.lookup, lookup);
  }
  const worktree = f.parse(fence({ action: 'git', operation: 'diff', staged: false, maxChars: 2000, maxChanges: 1 })).tools[0];
  assert.equal(worktree.staged, false);
  assert.equal(worktree.maxChars, 2000);
  assert.equal(worktree.maxChanges, 1);
});

test('parser accepts only fenced supported actions and preserves invalid blocks as visible text', () => {
  const f = fixture();
  for (const input of [
    JSON.stringify({ action: 'git' }),
    '```json\n{"action":"git"}\n```',
    fence({ action: 'executeAnything', command: 'arbitrary command' }),
    fence({ action: 'deleteWorkspace' }),
    fence([{ action: 'git' }]),
    '```tool\n{"action":"git"\n```',
  ]) {
    const parsed = f.parse(input);
    assert.equal(parsed.tools.length, 0);
    assert.equal(parsed.text, input);
  }
  for (const action of ['read', 'search', 'list', 'shell', 'browse', 'websearch']) {
    assert.equal(f.parse(fence({ action })).tools[0].action, action);
  }
  const mixed = `Before\n${fence({ action: 'git' })}\n${fence({ action: 'arbitrary' })}\nAfter`;
  const parsed = f.parse(mixed);
  assert.equal(parsed.tools.length, 1);
  assert.match(parsed.text, /Before/);
  assert.match(parsed.text, /"arbitrary"/);
  assert.match(parsed.text, /After/);
});

test('tool-supplied arguments, result, uid, and permission flags cannot replace transport-owned values', () => {
  const f = fixture(false);
  const parsed = f.parse(fence({
    action: 'vscodeCommand', command: 'example.inspect', args: ['arbitrary'], arguments: ['private'],
    uid: 'forged-tool-id', result: 'forged-success', allowIdeContext: true,
  })).tools[0];
  assert.equal(parsed.args, undefined);
  assert.equal(parsed.arguments, undefined);
  assert.equal(parsed.uid, undefined);
  assert.equal(parsed.result, undefined);
  assert.equal(parsed.allowIdeContext, undefined);
  f.state.beginToolRound([parsed]);
  assert.equal(f.posts[0].body.allowIdeContext, false);
  assert.notEqual(f.posts[0].body.uid, 'forged-tool-id');
  assert.equal(f.posts[0].body.result, null);
  // Even an object passed directly to the dispatcher cannot override the UI toggle.
  f.state.beginToolRound([{ ...parsed, allowIdeContext: true }]);
  assert.equal(f.posts.at(-1).body.allowIdeContext, false);
});

test('new inspection text fields remain bounded while zero and false controls remain typed', () => {
  const f = fixture();
  const request = { action: 'vscode', topic: 't'.repeat(100), remote: 'r'.repeat(300), query: 'q'.repeat(300),
    extensionId: 'e'.repeat(300), name: 'n'.repeat(300), state: 's'.repeat(100), key: 'k'.repeat(300),
    repository: 0, workspace: 0, staged: false, lookup: false };
  const parsed = f.parse(fence(request)).tools[0];
  for (const [field, length] of Object.entries({ topic: 80, remote: 200, query: 200, extensionId: 200, name: 200, state: 40, key: 200 })) {
    assert.equal(parsed[field].length, length, field);
  }
  assert.equal(parsed.repository, 0);
  assert.equal(parsed.workspace, 0);
  assert.equal(parsed.staged, false);
  assert.equal(parsed.lookup, false);
});

test('continuation carries tool results and renews IDE context without re-enabling source/search/thinking', () => {
  for (const includeWorkspace of [true, false]) {
    const f = fixture(includeWorkspace);
    const originalMessages = JSON.stringify(f.state.conv.messages);
    f.state.pendingText = 'I will inspect the selected repository.';
    f.state.contTools = [{ action: 'git', operation: 'status', result: '{"status":"ok","branch":"feature"}' }];
    f.state.continueAgent();
    const request = f.posts[0];
    assert.equal(request.type, 'chat');
    assert.equal(request.body.body.model, 'example-model');
    assert.equal(request.body.body.includeIdeContext, includeWorkspace);
    assert.equal(request.body.body.includeWorkspace, false);
    assert.equal(request.body.body.think, false);
    assert.equal(request.body.body.webSearch, false);
    assert.equal(request.body.body.agentic, true);
    assert.equal(request.body.body.stream, true);
    assert.match(request.body.body.messages.at(-1).content, /TOOL RESULTS.*\n\n\[git status\]/s);
    assert.match(request.body.body.messages.at(-1).content, /"branch":"feature"/);
    assert.equal(request.body.body.messages.at(-2).content, 'I will inspect the selected repository.');
    assert.equal(f.state.pendingText, '');
    assert.equal(f.state.agentRounds, 1);
    assert.equal(JSON.stringify(f.state.conv.messages), originalMessages);
  }
});

test('multiple tool rounds retain earlier results and separate each model generation', () => {
  const f = fixture();
  f.state.pendingText = 'First-generation narration';
  f.state.contTools = [{ action: 'git', operation: 'status', result: 'first-round-result' }];
  f.state.continueAgent();
  assert.equal(f.state.pendingText, '');
  f.state.pendingText = 'Second-generation narration';
  f.state.contTools = [{ action: 'vscode', topic: 'extensions', result: 'second-round-result' }];
  f.state.continueAgent();
  const messages = f.posts.at(-1).body.body.messages;
  assert.equal(messages.length, 5);
  assert.equal(messages[1].content, 'First-generation narration');
  assert.match(messages[2].content, /first-round-result/);
  assert.equal(messages[3].content, 'Second-generation narration');
  assert.match(messages[4].content, /second-round-result/);
  assert.equal(f.state.pendingText, '');
  assert.equal(f.state.agentRounds, 2);
});

test('continuation does nothing after its conversation is gone', () => {
  const f = fixture();
  f.state.conv = null;
  f.state.pendingText = 'keep';
  f.state.continueAgent();
  assert.equal(f.posts.length, 0);
  assert.equal(f.state.pendingText, 'keep');
  assert.equal(f.state.agentRounds, 0);
});
