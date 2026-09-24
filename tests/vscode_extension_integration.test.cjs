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
function fixture(commandRunner) {
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
    EventEmitter: class {
      constructor() { this.handlers=[]; this.event=fn=>{this.handlers.push(fn);return disposable();}; }
      fire(value) { this.handlers.forEach(fn=>fn(value)); }
      dispose() { this.handlers=[]; }
    },
    version: '1.100.0', env: { appName: 'Visual Studio Code', language: 'en', uiKind: 1 },
    Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)) },
    FileType: { File: 1, Directory: 2 }, ViewColumn: { Active: -1 }, TabInputText: class TabInputText {},
    workspace: { isTrusted: true, workspaceFolders: [], textDocuments: [],
      onDidChangeConfiguration: () => disposable(),
      getConfiguration: namespace => ({ get(key, fallback) {
        return Object.hasOwn(configuration, `${namespace}.${key}`) ? configuration[`${namespace}.${key}`] : fallback;
      } }),
      getWorkspaceFolder: resource => vscode.workspace.workspaceFolders.find(folder => resource.fsPath.startsWith(folder.uri.fsPath)),
      registerTextDocumentContentProvider: (scheme, provider) => { calls.push(['contentProvider', scheme, provider]); return disposable(); },
      openTextDocument: async options => { calls.push(['document.open', options]); return { ...options, uri: { scheme: 'untitled', path: 'Untitled-1' } }; },
      fs: { readFile: async () => { throw new Error('Unexpected filesystem content read'); } },
    },
    window: { visibleTextEditors: [], terminals: [], tabGroups: { all: [] },
      createTerminal: options => { calls.push(['terminal.create',options]);options.pty.open();return {show(){}}; },
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
    if (id === './agent-command' && commandRunner) return {runAgentCommand:commandRunner};
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

test('engine report command exposes real host tool evidence and protected edits fail before applying', async t => {
  const os = require('node:os');
  const engines = require(path.join(process.env.REACH_VSCODE_TEST_PATH || path.resolve(__dirname, '../vscode'), 'engine-core.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-vscode-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  engines.configure(path.join(root, 'ledger.jsonl'));
  const f = fixture();
  f.vscode.workspace.workspaceFolders = [{ uri: fileUri(root), name: 'fixture', index: 0 }];
  const result = await f.send({ type: 'toolReq', uid: 'guard-test', action: 'edit_patch', path: '.env', hunks: [{ search: 'old', replace: 'new' }] });
  assert.match(result.find(m => m.type === 'toolResult').error, /protected file/);
  assert.equal(engines.getLedger().report().observations, 1);
  assert.equal(engines.getLedger().records[0].tool, 'edit_patch');
  assert.equal(engines.getLedger().records[0].success, false);
  await f.commands.get('simplereach.engineReport')();
  const opened = f.calls.find(c => c[0] === 'document.open');
  assert.equal(JSON.parse(opened[1].content).observations, 1);
});

test('real extension edits retain dirty buffers and produce editor receipts', async t => {
  const os = require('node:os'), engines = require(path.join(process.env.REACH_VSCODE_TEST_PATH || path.resolve(__dirname, '../vscode'), 'engine-core.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-vscode-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  engines.configure(path.join(root, 'ledger.jsonl'));
  const f = fixture(); let content = 'human unsaved work\nold', saves = 0;
  const doc = { isDirty: true, getText: () => content, positionAt: i => i, save: async () => { saves++; return true; } };
  f.vscode.workspace.workspaceFolders = [{ uri: fileUri(root), name: 'fixture', index: 0 }];
  f.vscode.workspace.openTextDocument = async () => doc;
  f.vscode.Range = class { constructor(start, end) { this.start = start; this.end = end; } };
  f.vscode.WorkspaceEdit = class { replace(uri, range, text) { this.range = range; this.text = text; } };
  f.vscode.workspace.applyEdit = async edit => { content = content.slice(0, edit.range.start) + edit.text + content.slice(edit.range.end); return true; };
  const result = await f.send({ type: 'applyEdit', uid: 'edit-test', path: 'a.txt', search: 'old', replace: 'new' });
  assert.equal(result.find(m => m.type === 'editResult').ok, true);
  assert.equal(content, 'human unsaved work\nnew'); assert.equal(saves, 0);
  const receipt = engines.getLedger().records.find(r => r.kind === 'receipt');
  assert.equal(receipt.storage, 'editor'); assert.equal(receipt.afterHash, engines.hash(content));
});

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
  assert.equal(result.find(m => m.type === 'toolResult').ok, false);
  assert.match(result.find(m => m.type === 'toolResult').error, /not approved/);
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

test('approved shell dispatch creates one output terminal and invokes the command runner once',async()=>{
 const executions=[];
 const f=fixture(async(command,options)=>{executions.push(command);options.onOutput('ACTUAL OUTPUT\n');return {ok:true,code:0,output:'exit code 0\nACTUAL OUTPUT'};});
 f.vscode.workspace.workspaceFolders=[{uri:fileUri(path.resolve(__dirname,'..'))}];
 f.vscode.window.showWarningMessage=async()=> 'Run';
 const result=await f.send({type:'toolReq',uid:'single',action:'shell',command:'node fixture.js'});
 assert.deepEqual(executions,['node fixture.js']);
 assert.equal(f.calls.filter(c=>c[0]==='terminal.create').length,1);
 assert.match(result.find(m=>m.type==='toolResult').result,/ACTUAL OUTPUT/);
 assert.ok(result.some(m=>m.note?.includes('has not started')));
 assert.ok(result.some(m=>m.note?.includes('Command started')));
 assert.equal(f.provider._commandControllers.size,0);
});

test('Stop while approval is pending prevents a late approval from launching the command',async()=>{
 let approve,executions=0;
 const f=fixture(async()=>{executions++;});
 f.vscode.workspace.workspaceFolders=[{uri:fileUri(path.resolve(__dirname,'..'))}];
 f.vscode.window.showWarningMessage=()=>new Promise(resolve=>{approve=resolve;});
 const pending=f.send({type:'toolReq',uid:'stopped',action:'shell',command:'never-run'});
 await f.send({type:'abort'});approve('Run');
 const messages=await pending;
 assert.equal(executions,0);assert.equal(messages.find(m=>m.type==='toolResult').ok,false);
 assert.equal(f.calls.some(c=>c[0]==='terminal.create'),false);
});

test('disabled IDE tools are blocked before reaching their executor',async()=>{
 const f=fixture();f.configuration['simplereach.disabledTools']=['vscode','git'];
 for(const action of ['vscode','git']){
  const messages=await f.send({type:'toolReq',uid:action,action});
  assert.equal(messages[0].ok,false);assert.match(messages[0].error,/disabled/);
 }
 assert.equal(f.calls.some(c=>c[0]==='git.getAPI'),false);
});
