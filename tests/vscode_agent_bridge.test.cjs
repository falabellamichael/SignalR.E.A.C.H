'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

// Give each test its own narrow dependency loader. No process-global loader
// patches, VS Code host, network, installed extension, or user settings are used.
function fixture() {
  const calls = [];
  const configuration = {};
  const values = {
    editor: { folders: [{ name: 'workspace' }] },
    git: { status: 'ok', repositories: [{ branch: 'first' }] },
    ideResult: { available: true, topic: 'editors' },
    gitResult: { status: 'noRepositories', repositories: [] },
    prResult: { status: 'noPullRequests', pullRequests: [] },
    openResult: { available: true, opened: true },
    approval: undefined,
  };
  class IdeContext {
    async snapshot() { calls.push(['editor.snapshot']); if (values.editor instanceof Error) throw values.editor; return values.editor; }
    async inspect(req) { calls.push(['editor.inspect', req]); return values.ideResult; }
    async open(req) { calls.push(['editor.open', req]); return values.openResult; }
  }
  class GitContext {
    async snapshot(options) { calls.push(['git.snapshot', options]); if (values.git instanceof Error) throw values.git; return values.git; }
    async inspect(req) { calls.push(['git.inspect', req]); return values.gitResult; }
    async pullRequests(req) { calls.push(['git.pullRequests', req]); return values.prResult; }
  }
  const task = { name: 'Build', source: 'Workspace', scope: { name: 'app', index: 0, uri: { fsPath: '/workspace/app' } } };
  const vscode = {
    workspace: { isTrusted: true, getConfiguration: namespace => {
      assert.equal(namespace, 'simplereach');
      return { get: key => configuration[key] };
    } },
    window: { showWarningMessage: async (...args) => {
      calls.push(['approve', ...args]);
      return typeof values.approval === 'function' ? values.approval() : values.approval;
    } },
    tasks: {
      fetchTasks: async () => { calls.push(['tasks.fetch']); return values.tasks; },
      executeTask: async selected => { calls.push(['tasks.execute', selected]); return { privateState: 'not for model' }; },
    },
    commands: {
      getCommands: async filterInternal => { calls.push(['commands.list', filterInternal]); return values.commands; },
      executeCommand: async (...args) => { calls.push(['commands.execute', ...args]); return { token: 'private-return-value' }; },
    },
    extensions: { all: [{ packageJSON: { contributes: { commands: [{ command: 'example.inspect' }, { command: 'simplereach.openChat' }, { command: '_private.inspect' }] } } }] },
  };
  values.tasks = [task];
  values.commands = ['example.inspect', 'simplereach.openChat', '_private.inspect', 'workbench.view.scm', 'arbitrary.internal'];
  const filename = path.resolve(__dirname, '../vscode/agent-bridge.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = function (id) {
    if (id === './ide-context') return { IdeContext };
    if (id === './git-context') return { GitContext };
    return Module.prototype.require.call(this, id);
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { ...loaded.exports, bridge: new loaded.exports.AgentBridge(vscode), vscode, configuration, calls, values, task };
}

const count = (f, kind) => f.calls.filter(call => call[0] === kind).length;

test('aborting during editor context preparation never starts a model request', async () => {
  const f = fixture();
  const posted = [];
  let requested = false;
  const provider = { _post: (...args) => posted.push(args), _chat: async () => { requested = true; } };
  const bridge = f.attachAgentBridge(provider, f.vscode);
  let release;
  bridge.prepare = () => new Promise(resolve => { release = resolve; });
  const request = provider._chat({ includeWorkspace: true });
  provider._idePreparing.cancelled = true;
  release({ messages: [] });
  await request;
  assert.equal(requested, false);
  assert.equal(provider._idePreparing, null);
  assert.deepEqual(posted, [['done', { aborted: true }]]);
});

test('prepare replaces only its tagged system messages with fresh editor and branch data', async () => {
  const f = fixture();
  const original = [
    { role: 'system', content: 'Preserve the existing coding instructions.' },
    { role: 'system', content: f.CONTEXT_PREFIX + '\nstale editor' },
    { role: 'system', content: f.TOOL_PREFIX + '\nstale tools' },
    { role: 'user', content: f.CONTEXT_PREFIX + '\nuser text remains data' },
  ];
  const posted = [];
  const first = await f.bridge.prepare({ messages: original, includeWorkspace: true, agentic: true }, (...args) => posted.push(args));
  assert.equal(first.messages.filter(m => m.content.startsWith(f.TOOL_PREFIX)).length, 1);
  assert.equal(first.messages.filter(m => m.role === 'system' && m.content.startsWith(f.CONTEXT_PREFIX)).length, 1);
  assert.ok(first.messages.includes(original[0]));
  assert.ok(first.messages.includes(original[3]));
  assert.match(first.messages.find(m => m.content.startsWith(f.CONTEXT_PREFIX)).content, /first/);
  assert.match(original[1].content, /stale editor/);
  assert.equal(posted[0][0], 'ideContextInfo');
  assert.equal(posted[0][1].available, true);
  assert.equal(posted[0][1].chars, posted[0][1].context.length);

  f.values.git = { status: 'ok', repositories: [{ branch: 'after-tool-continuation' }] };
  const next = await f.bridge.prepare({ ...first, includeWorkspace: false, includeIdeContext: true }, () => {});
  const context = next.messages.find(m => m.content.startsWith(f.CONTEXT_PREFIX)).content;
  assert.match(context, /after-tool-continuation/);
  assert.doesNotMatch(context, /"first"/);
  assert.equal(count(f, 'editor.snapshot'), 2);
  assert.equal(count(f, 'git.snapshot'), 2);
});

test('prepare requires a per-turn context toggle and respects both configuration gates', async () => {
  for (const settings of [{}, { workspaceContext: false }, { ideContext: false }]) {
    for (const body of [{}, { includeWorkspace: false, includeIdeContext: false }, { includeWorkspace: true }, { includeIdeContext: true }]) {
      const f = fixture();
      Object.assign(f.configuration, settings);
      const result = await f.bridge.prepare({ ...body, agentic: true, messages: [{ role: 'system', content: f.CONTEXT_PREFIX + ' stale' }] }, () => {});
      const allowed = settings.workspaceContext !== false && settings.ideContext !== false && (body.includeWorkspace === true || body.includeIdeContext === true);
      assert.equal(result.messages.some(m => m.content.startsWith(f.CONTEXT_PREFIX)), allowed);
      assert.equal(count(f, 'editor.snapshot'), Number(allowed));
      if (!allowed) assert.match(result.messages[0].content, /context is OFF/);
    }
  }
});

test('nonagentic requests retain enabled context but do not advertise action tools', async () => {
  for (const configured of [false, undefined]) {
    const f = fixture();
    f.configuration.agentic = configured;
    const result = await f.bridge.prepare({ includeIdeContext: true, agentic: configured === false }, () => {});
    assert.equal(result.messages.length, 1);
    assert.ok(result.messages[0].content.startsWith(f.CONTEXT_PREFIX));
  }
});

test('snapshot uses bounded local metadata only and never performs PR lookup', async () => {
  const f = fixture();
  const result = await f.bridge.snapshot();
  assert.deepEqual(result.editor, f.values.editor);
  assert.deepEqual(result.git, f.values.git);
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
  assert.deepEqual(result.extensions, f.values.ideResult);
  assert.deepEqual(f.calls, [['editor.snapshot'], ['git.snapshot', { maxRepositories: 8, maxChanges: 12 }],
    ['editor.inspect', { topic: 'extensions', limit: 20 }]]);
});

test('disabled and untrusted snapshots report structured states without inspecting editor data', async () => {
  const f = fixture();
  f.configuration.ideContext = false;
  assert.equal((await f.bridge.snapshot()).status, 'disabled');
  f.configuration.ideContext = true;
  f.vscode.workspace.isTrusted = false;
  assert.equal((await f.bridge.snapshot()).status, 'restricted');
  const posted = [];
  await f.bridge.prepare({ includeIdeContext: true }, (...args) => posted.push(args));
  assert.equal(posted[0][1].available, false);
  assert.deepEqual(f.calls, []);
});

test('snapshot provider failures preserve successful metadata without exposing raw errors', async () => {
  const f = fixture();
  f.values.editor = new Error('private provider details');
  let result = await f.bridge.snapshot();
  assert.deepEqual(result.editor, { status: 'unavailable' });
  assert.deepEqual(result.git, f.values.git);
  f.values.git = new Error('private git details');
  result = await f.bridge.snapshot();
  assert.deepEqual(result.git, { status: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(result), /private provider details|private git details/);
});

test('inspection actions forward exact selectors and preserve structured availability statuses', async () => {
  const f = fixture();
  for (const [action, expected, call] of [
    ['vscode', f.values.ideResult, 'editor.inspect'],
    ['git', f.values.gitResult, 'git.inspect'],
    ['pullRequests', f.values.prResult, 'git.pullRequests'],
    ['open', f.values.openResult, 'editor.open'],
  ]) {
    const req = { action, topic: 'extensions', repository: 1, workspace: 'app', path: 'src/main.js', line: 12 };
    assert.deepEqual(JSON.parse(await f.bridge.run(req)), expected);
    assert.deepEqual(f.calls.at(-1), [call, req]);
  }
});

test('all action routes reject disabled context or untrusted workspaces before discovery', async () => {
  for (const gate of ['workspaceContext', 'ideContext', 'trusted', 'allowIdeContext']) {
    const f = fixture();
    const req = {};
    if (gate === 'trusted') f.vscode.workspace.isTrusted = false;
    else if (gate === 'allowIdeContext') req.allowIdeContext = false;
    else f.configuration[gate] = false;
    for (const action of ['vscode', 'git', 'pullRequests', 'open', 'runTask', 'vscodeCommand']) {
      await assert.rejects(f.bridge.run({ ...req, action, name: 'Build', command: 'example.inspect' }), /context|trusted/);
    }
    assert.deepEqual(f.calls, []);
  }
});

test('bridge recognizes documented actions and rejects unrelated tool routes', async () => {
  const f = fixture();
  for (const action of ['vscode', 'git', 'pullRequests', 'open', 'runTask', 'vscodeCommand']) assert.equal(f.bridge.handles(action), true);
  for (const action of ['read', 'shell', '_private', '', undefined]) assert.equal(f.bridge.handles(action), false);
  await assert.rejects(f.bridge.run({ action: 'unknown' }), /Unsupported/);
});

test('task dispatch requires exact affirmative approval and reports start rather than success', async () => {
  const f = fixture();
  for (const response of [undefined, 'Cancel', 'run task', true]) {
    f.values.approval = response;
    await assert.rejects(f.bridge.run({ action: 'runTask', name: 'Build' }), /not approved/);
  }
  assert.equal(count(f, 'tasks.execute'), 0);
  f.values.approval = 'Run task';
  const result = await f.bridge.run({ action: 'runTask', name: 'Build', command: 'ignored arbitrary shell command' });
  assert.deepEqual(f.calls.slice(-3).map(c => c[0]), ['tasks.fetch', 'approve', 'tasks.execute']);
  assert.strictEqual(f.calls.at(-1)[1], f.task);
  const approval = f.calls.at(-2);
  assert.match(approval[1], /Build.*Workspace.*\/workspace\/app/);
  assert.deepEqual(approval[2], { modal: true });
  assert.match(result, /Completion and success have not been verified/);
});

test('tasks must match an existing exact name and an unambiguous workspace selector', async () => {
  const f = fixture();
  f.values.tasks.push({ ...f.task, scope: { name: 'other', index: 1, uri: { fsPath: '/workspace/other' } } });
  await assert.rejects(f.bridge.run({ action: 'runTask', name: 'Build' }), /More than one/);
  await assert.rejects(f.bridge.run({ action: 'runTask', name: 'Invented' }), /not found/);
  assert.equal(count(f, 'approve'), 0);
  f.values.approval = 'Run task';
  for (const workspace of ['app', '/workspace/app', 0]) {
    await f.bridge.run({ action: 'runTask', name: 'Build', workspace });
    assert.strictEqual(f.calls.at(-1)[1], f.task);
  }
});

test('trust revoked during approval prevents task and command execution', async () => {
  for (const [action, args, approval] of [['runTask', { name: 'Build' }, 'Run task'], ['vscodeCommand', { command: 'example.inspect' }, 'Execute command']]) {
    const f = fixture();
    f.values.approval = () => { f.vscode.workspace.isTrusted = false; return approval; };
    await assert.rejects(f.bridge.run({ action, ...args }), /trust changed/);
    assert.equal(count(f, 'tasks.execute') + count(f, 'commands.execute'), 0);
  }
});

test('public command dispatch passes no arguments and never returns extension private state', async () => {
  const f = fixture();
  f.values.approval = 'Execute command';
  const result = await f.bridge.run({ action: 'vscodeCommand', command: 'example.inspect', args: ['secret'], arguments: [{ path: '/outside' }] });
  assert.deepEqual(f.calls[0], ['commands.list', true]);
  assert.deepEqual(f.calls.at(-1), ['commands.execute', 'example.inspect']);
  assert.match(result, /dispatched example.inspect/);
  assert.match(result, /No command output or completion status is exposed/);
  assert.doesNotMatch(result, /private-return-value|token|secret/);
});

test('commands require exact approval and reject arbitrary, internal, or recursive IDs before prompting', async () => {
  const f = fixture();
  for (const command of ['', 'invented.command', 'arbitrary.internal', '_private.inspect', 'simplereach.openChat']) {
    await assert.rejects(f.bridge.run({ action: 'vscodeCommand', command }), /public extension command|recursively/);
  }
  assert.equal(count(f, 'approve'), 0);
  for (const approval of [undefined, 'Run task', 'execute command', true]) {
    f.values.approval = approval;
    await assert.rejects(f.bridge.run({ action: 'vscodeCommand', command: 'example.inspect' }), /not approved/);
  }
  assert.equal(count(f, 'commands.execute'), 0);
});

test('supported panels and singular extension command contributions are allowed after approval', async () => {
  const f = fixture();
  f.vscode.extensions.all = [{ packageJSON: { contributes: { commands: { command: 'example.inspect' } } } }];
  f.values.approval = 'Execute command';
  for (const command of ['workbench.view.scm', 'example.inspect']) {
    await f.bridge.run({ action: 'vscodeCommand', command });
    assert.deepEqual(f.calls.at(-1), ['commands.execute', command]);
  }
});

test('provider adapter refreshes every chat while retaining the original method receiver', async () => {
  const f = fixture();
  const chats = [], posts = [];
  const provider = {
    marker: 'original provider',
    async _chat(body) { chats.push([this.marker, body]); return 'chat-result'; },
    _post(type, data) { posts.push([this.marker, type, data]); },
  };
  const bridge = f.attachAgentBridge(provider, f.vscode);
  assert.strictEqual(provider._ideBridge, bridge);
  assert.equal(await provider._chat({ includeWorkspace: true }), 'chat-result');
  await provider._chat({ includeIdeContext: true, includeWorkspace: false, messages: chats[0][1].messages });
  assert.equal(chats.length, 2);
  assert.ok(chats.every(c => c[0] === 'original provider'));
  assert.ok(posts.every(p => p[0] === 'original provider' && p[1] === 'ideContextInfo'));
  assert.equal(count(f, 'git.snapshot'), 2);
});

test('large inspection results have a bounded output and an explicit truncation notice', () => {
  const f = fixture();
  const short = { status: 'ok' };
  assert.deepEqual(JSON.parse(f.boundedJson(short)), short);
  const result = f.boundedJson({ text: 'x'.repeat(100000) }, 1000);
  assert.ok(result.length < 1100);
  assert.match(result, /truncated; narrow the query or reduce limit/);
});
