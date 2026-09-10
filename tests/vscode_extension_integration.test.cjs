'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

function fileUri(filename) {
  return { scheme: 'file', fsPath: filename, path: filename.replace(/\\/g, '/'),
    toString: () => pathToFileURL(filename).toString() };
}

// Exercise the real activation, host provider, bridge, and context modules.
// Only the VS Code host and the tray health HTTP call are substituted. No
// process-wide loader patch, model request, service, or installed app is used.
function fixture() {
  const messages = [], calls = [], commands = new Map(), configuration = {};
  const extensionPath = process.env.REACH_VSCODE_TEST_PATH || path.resolve(__dirname, '../vscode');
  const extensionUri = fileUri(extensionPath);
  const disposable = () => ({ dispose() {} });
  let receive, registeredProvider;
  const gitApi = { repositories: [] };
  const gitExtension = { id: 'vscode.git', isActive: true, extensionKind: 1,
    packageJSON: { name: 'git', displayName: 'Git', publisher: 'vscode', version: '1.0.0' },
    exports: { getAPI(version) { calls.push(['git.getAPI', version]); return gitApi; } } };
  const vscode = {
    version: '1.100.0', env: { appName: 'Visual Studio Code', language: 'en', uiKind: 1 },
    Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)) },
    FileType: { File: 1, Directory: 2 }, ViewColumn: { Active: -1 }, TabInputText: class TabInputText {},
    workspace: { isTrusted: true, workspaceFolders: [], textDocuments: [],
      getConfiguration: namespace => ({ get(key, fallback) {
        return Object.hasOwn(configuration, `${namespace}.${key}`) ? configuration[`${namespace}.${key}`] : fallback;
      } }),
      getWorkspaceFolder: resource => vscode.workspace.workspaceFolders.find(folder => resource.fsPath.startsWith(folder.uri.fsPath)),
      registerTextDocumentContentProvider: (scheme, provider) => { calls.push(['contentProvider', scheme, provider]); return disposable(); },
      openTextDocument: async options => { calls.push(['document.open', options]); return { ...options, uri: { scheme: 'untitled', path: 'Untitled-1' } }; },
      fs: { readFile: async () => { throw new Error('Unexpected filesystem content read'); } },
    },
    window: { visibleTextEditors: [], terminals: [], tabGroups: { all: [] },
      registerWebviewViewProvider: (id, provider) => { calls.push(['webview.register', id]); registeredProvider = provider; return disposable(); },
      showTextDocument: async (document, options) => { calls.push(['document.show', document, options]); return {}; },
      showWarningMessage: async (...args) => { calls.push(['approval', ...args]); return undefined; },
    },
    extensions: { all: [gitExtension], getExtension: id => id === 'vscode.git' ? gitExtension : undefined },
    commands: {
      registerCommand: (id, handler) => { commands.set(id, handler); return disposable(); },
      getCommands: async () => [...commands.keys()],
      executeCommand: async (...args) => { calls.push(['command.execute', ...args]); return undefined; },
    },
    languages: { getDiagnostics: () => [] }, tasks: { taskExecutions: [] }, debug: { breakpoints: [] },
  };
  const fakeHttp = { get(options, callback) {
    calls.push(['tray.health', options.host, options.port]);
    const request = new EventEmitter();
    request.destroy = () => {};
    queueMicrotask(() => callback({ statusCode: 200, resume() {} }));
    return request;
  } };
  const filename = path.join(extensionPath, 'extension.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(extensionPath);
  loaded.require = function (id) {
    if (id === 'vscode') return vscode;
    if (id === 'http') return fakeHttp;
    if (id === 'child_process') return { ...require('node:child_process'), spawn() { throw new Error('Unexpected child process'); } };
    return Module.prototype.require.call(this, id);
  };
  loaded._compile(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports.ReachChatViewProvider = ReachChatViewProvider;\n', filename);
  const context = { extensionUri, subscriptions: [] };
  loaded.exports.activate(context);
  assert.ok(registeredProvider instanceof loaded.exports.ReachChatViewProvider);
  const webview = { cspSource: 'test-webview:', asWebviewUri: resource => resource,
    postMessage: message => { messages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: handler => { receive = handler; return disposable(); },
  };
  registeredProvider.resolveWebviewView({ webview });
  return { vscode, configuration, calls, commands, context, gitApi, messages, webview, provider: registeredProvider,
    async send(request) {
      const start = messages.length;
      await receive(request);
      return messages.slice(start);
    } };
}

test('real extension activation resolves its webview and installs the actual bridge dependencies', async () => {
  const f = fixture();
  assert.equal(f.webview.options.enableScripts, true);
  assert.match(f.webview.html, /chat\.js/);
  assert.doesNotMatch(f.webview.html, /\{\{nonce\}\}|\{\{scriptUri\}\}/);
  assert.ok(f.provider._ideBridge);
  assert.equal(f.provider._ideBridge.handles('vscode'), true);
  assert.equal(f.provider._ideBridge.handles('git'), true);
  assert.equal(f.provider._ideBridge.handles('read'), false);
  assert.ok(f.commands.has('simplereach.inspectContext'));
  assert.ok(f.commands.has('simplereach.openBrowser'));
  assert.ok(f.calls.filter(call => call[0] === 'tray.health').length <= 1);
});

test('actual toolReq routes VS Code inspection before the legacy no-workspace guard', async () => {
  const f = fixture();
  const result = await f.send({ type: 'toolReq', uid: 'editor-17', action: 'vscode', topic: 'workspace', allowIdeContext: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'toolResult');
  assert.equal(result[0].uid, 'editor-17');
  assert.equal(result[0].ok, true);
  const payload = JSON.parse(result[0].result);
  assert.equal(payload.topic, 'workspace');
  assert.equal(payload.host.version, '1.100.0');
  assert.deepEqual(payload.folders, []);
  assert.equal(result[0].error, undefined);
});

test('actual Git toolReq returns real Git API state and honest empty repository results', async () => {
  const f = fixture();
  let result = await f.send({ type: 'toolReq', uid: 'git-empty', action: 'git', operation: 'status' });
  assert.equal(result[0].ok, true);
  assert.equal(JSON.parse(result[0].result).status, 'noRepositories');
  const root = fileUri(path.resolve(__dirname, '..'));
  f.gitApi.repositories.push({ rootUri: root, state: { HEAD: { name: 'integration-fixture', commit: 'abc123', ahead: 0, behind: 0 },
    remotes: [{ name: 'origin', fetchUrl: 'https://user:private-token@github.com/example/reach.git' }],
    indexChanges: [], workingTreeChanges: [], mergeChanges: [] }, status: async () => { f.calls.push(['git.refresh']); } });
  result = await f.send({ type: 'toolReq', uid: 'git-actual', action: 'git', operation: 'status', repository: 0 });
  const payload = JSON.parse(result[0].result);
  assert.equal(result[0].uid, 'git-actual');
  assert.equal(result[0].ok, true);
  assert.equal(payload.status, 'ok');
  assert.equal(payload.repository.root, root.fsPath);
  assert.equal(payload.repository.head.branch, 'integration-fixture');
  assert.doesNotMatch(result[0].result, /private-token|https:\/\/user/);
  assert.ok(f.calls.some(call => call[0] === 'git.refresh'));
});

test('actual toolReq preserves request IDs and reports bridge failures through the error result channel', async () => {
  const f = fixture();
  for (const action of ['vscode', 'git', 'pullRequests', 'open', 'runTask', 'vscodeCommand']) {
    const result = await f.send({ type: 'toolReq', uid: `disabled-${action}`, action, allowIdeContext: false });
    assert.deepEqual(result, [{ type: 'toolResult', uid: `disabled-${action}`, ok: false,
      error: 'Enable Workspace context and simplereach.ideContext to inspect VS Code.' }]);
  }
  f.vscode.workspace.isTrusted = false;
  const result = await f.send({ type: 'toolReq', uid: 'untrusted', action: 'vscode', topic: 'extensions' });
  assert.equal(result[0].ok, false);
  assert.match(result[0].error, /trusted VS Code workspace/);
  assert.equal(f.calls.some(call => call[0] === 'git.getAPI'), false);
});

test('legacy actions retain their own workspace guard and unsupported-action errors', async () => {
  const f = fixture();
  let result = await f.send({ type: 'toolReq', uid: 'legacy-no-root', action: 'read', path: 'app.js' });
  assert.deepEqual(result, [{ type: 'toolResult', uid: 'legacy-no-root', ok: false, error: 'No workspace folder is open.' }]);
  f.vscode.workspace.workspaceFolders = [{ name: 'fixture', index: 0, uri: fileUri(path.resolve(__dirname, '..')) }];
  result = await f.send({ type: 'toolReq', uid: 'unknown', action: 'not-a-tool' });
  assert.equal(result[0].uid, 'unknown');
  assert.equal(result[0].ok, false);
  assert.match(result[0].error, /unknown action: not-a-tool/);
  result = await f.send({ type: 'toolReq', uid: 'legacy-shell', action: 'shell', command: 'echo never-executed' });
  assert.equal(result[0].ok, false);
  assert.match(result[0].error, /not approved/);
  assert.ok(f.calls.some(call => call[0] === 'approval'));
  assert.equal(f.calls.some(call => call[0] === 'command.execute'), false);
});

test('registered Inspect Context command opens the observed real bridge snapshot as a JSON document', async () => {
  const f = fixture();
  const snapshot = await f.commands.get('simplereach.inspectContext')();
  assert.equal(snapshot.editor.host.version, '1.100.0');
  assert.equal(snapshot.git.status, 'noRepositories');
  assert.equal(snapshot.extensions.extensions[0].id, 'vscode.git');
  const opened = f.calls.find(call => call[0] === 'document.open');
  assert.equal(opened[1].language, 'json');
  assert.equal(opened[1].content, JSON.stringify(snapshot, null, 2));
  const shown = f.calls.find(call => call[0] === 'document.show');
  assert.equal(shown[2].preview, true);
  assert.equal(f.messages.length, 0);
});
