'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IdeContext, isSensitivePath } = require('../vscode/ide-context');

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
function uri(filename) { return { scheme: 'file', fsPath: filename, path: filename.replace(/\\/g, '/'), query: 'secret-query', fragment: 'secret-fragment' }; }
function document(filename, dirty = false) {
  const lines = ['const dirtyValue = 7;', 'dirtyValue;'];
  return { uri: uri(filename), languageId: 'javascript', isDirty: dirty, isUntitled: false, version: dirty ? 9 : 1,
    lineCount: lines.length, getText: () => { throw new Error('Metadata must not read document text'); },
    lineAt: line => ({ text: lines[line], range: new Range(new Position(line, 0), new Position(line, lines[line].length)) }) };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-ide-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(project); fs.mkdirSync(outside);
  const filename = path.join(project, 'app.js');
  fs.writeFileSync(filename, 'const diskValue = 1;');
  fs.writeFileSync(path.join(outside, 'outside.js'), 'outside');
  fs.writeFileSync(path.join(project, '.env'), 'PRIVATE_KEY=do-not-send');
  const folder = { name: 'project', index: 0, uri: uri(project) };
  const doc = document(filename, true);
  const calls = [];
  const editor = { document: doc, viewColumn: 1, selections: [{ start: new Position(0, 2), end: new Position(0, 5),
    anchor: new Position(0, 2), active: new Position(0, 5) }], visibleRanges: [new Range(new Position(0, 0), new Position(1, 11))] };
  const terminal = { name: 'Build', state: { isInteractedWith: true }, creationOptions: { env: { TOKEN: 'terminal-secret' }, shellArgs: ['secret-shell-arg'] } };
  const vscode = {
    version: '1.100.0', env: { appName: 'Visual Studio Code', language: 'en', uiKind: 1,
      machineId: 'private-machine-id', sessionId: 'private-session-id' },
    Uri: { file: uri }, Position, Range,
    workspace: { name: 'project', isTrusted: true, workspaceFolders: [folder], textDocuments: [doc],
      getWorkspaceFolder(resource) { return resource.fsPath && resource.fsPath.startsWith(project + path.sep) || resource.fsPath === project ? folder : undefined; },
      openTextDocument: async resource => { calls.push(['open', resource]); return resource.fsPath === filename ? doc : document(resource.fsPath); },
      getConfiguration: section => ({ get(key) { calls.push(['setting', `${section}.${key}`]); return `${section}.${key}` === 'editor.tabSize' ? 2 : undefined; } }),
    },
    window: { activeTextEditor: editor, visibleTextEditors: [editor], activeTerminal: terminal, terminals: [terminal],
      tabGroups: { all: [{ viewColumn: 1, tabs: [{ label: 'app.js', isActive: true, isDirty: true, input: { uri: doc.uri } }] }] },
      showTextDocument: async (opened, options) => { calls.push(['show', opened, options]); return editor; },
    },
    extensions: { all: [{ id: 'example.tools', isActive: true, extensionKind: 1, extensionPath: path.join(root, 'extensions', 'example.tools'),
      exports: { token: 'private-extension-export' }, packageJSON: { name: 'tools', displayName: 'Tools', publisher: 'example', version: '1.2.3',
        repository: { type: 'git', url: 'https://username:repo-password@github.com/example/tools?token=repo-token#fragment' },
        homepage: 'javascript:bad()', contributes: {
          commands: [{ command: 'example.show', title: 'Show Tools' }],
          configuration: { properties: { 'example.token': { type: 'string', description: 'Access token', default: 'private-default' },
            'example.enabled': { type: 'boolean', description: 'Enabled', default: true } } },
          languages: [{ id: 'example', extensions: ['.example'] }],
          debuggers: [{ type: 'example', label: 'Example debugger', program: 'secret-program' }],
          taskDefinitions: [{ type: 'example', required: ['token'] }],
        } } }] },
    languages: { getDiagnostics: () => [
      [doc.uri, [{ severity: 0, message: 'Undefined dirtyValue', range: new Range(new Position(1, 0), new Position(1, 10)) }]],
      [uri(path.join(project, '.env')), [{ severity: 1, message: 'private-diagnostic-secret', range: new Range(new Position(0, 0), new Position(0, 3)) }]],
    ] },
    commands: { getCommands: async internal => { calls.push(['getCommands', internal]); return ['example.show', 'workbench.action.files.save']; },
      executeCommand: async (...args) => { calls.push(['execute', ...args]); return []; } },
    tasks: { taskExecutions: [{ task: { name: 'build', source: 'Workspace', definition: { type: 'npm', token: 'private-task-token' },
      execution: { commandLine: 'private-task-command' } } }],
      fetchTasks: async () => { calls.push(['fetchTasks']); return [{ name: 'test', source: 'Workspace', definition: { type: 'npm', script: 'test', token: 'private-task-token' },
        execution: { commandLine: 'private-task-command' } }]; } },
    debug: { activeDebugSession: { name: 'App', type: 'node', configuration: { env: { TOKEN: 'private-debug-token' } }, workspaceFolder: folder },
      breakpoints: [{ enabled: true, location: { uri: doc.uri, range: new Range(new Position(0, 0), new Position(0, 0)) },
        condition: 'private-condition', logMessage: 'private-log-message' }] },
  };
  return { context: new IdeContext(vscode), vscode, root, project, outside, filename, doc, calls };
}

test('snapshot captures dirty buffers, selections, roots and counts without providers or private host state', async t => {
  const { context, calls, project } = fixture(t);
  const snapshot = await context.snapshot();
  assert.equal(snapshot.host.version, '1.100.0');
  assert.equal(snapshot.trusted, true);
  assert.equal(snapshot.folders[0].path, project);
  assert.equal(snapshot.editors.active.document.dirty, true);
  assert.equal(snapshot.editors.active.document.version, 9);
  assert.deepEqual(snapshot.editors.active.selections[0].start, { line: 1, column: 3 });
  assert.equal(snapshot.editors.unsavedDocuments.length, 1);
  assert.deepEqual(snapshot.counts.diagnostics, { error: 1, warning: 0, information: 0, hint: 0 });
  assert.equal(snapshot.counts.extensions, 1);
  assert.equal(snapshot.counts.runningTasks, 1);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|secret-query|secret-fragment/);
});

test('extension discovery exposes bounded manifest contributions and sanitized links only', async t => {
  const { context } = fixture(t);
  const result = await context.inspect({ topic: 'extensions', extensionId: 'EXAMPLE.TOOLS', limit: 5000 });
  const extension = result.extensions[0];
  assert.equal(extension.id, 'example.tools');
  assert.equal(extension.extensionKind, 1);
  assert.equal(extension.repository, 'https://github.com/example/tools');
  assert.equal(extension.homepage, undefined);
  assert.deepEqual(extension.contributes.commands, [{ id: 'example.show', title: 'Show Tools', category: undefined }]);
  assert.equal(extension.contributes.settings[0].key, 'example.token');
  assert.deepEqual(extension.contributes.taskTypes, ['example']);
  assert.doesNotMatch(JSON.stringify(result), /private-|repo-password|repo-token|secret-program|"default"|"exports"/);
  assert.equal((await context.inspect({ topic: 'extensions', query: 'missing' })).extensions.length, 0);
});

test('diagnostics omit secret files and preserve severity and one-based ranges', async t => {
  const { context } = fixture(t);
  const result = await context.inspect({ topic: 'diagnostics', severity: 'error', limit: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.diagnostics[0].severity, 'error');
  assert.deepEqual(result.diagnostics[0].range.start, { line: 2, column: 1 });
  assert.doesNotMatch(JSON.stringify(await context.inspect({ topic: 'diagnostics' })), /private-diagnostic-secret/);
  assert.equal((await context.inspect({ topic: 'diagnostics', path: '.env' })).total, 0);
});

test('settings use a fixed safe value allowlist; terminals, tasks and debug omit configurations', async t => {
  const { context, calls } = fixture(t);
  assert.deepEqual((await context.inspect({ topic: 'settings', key: 'example.token' })).settings, []);
  assert.deepEqual(calls, []);
  assert.deepEqual((await context.inspect({ topic: 'settings', key: 'editor.tabSize' })).settings, [{ key: 'editor.tabSize', value: 2 }]);
  const tasks = await context.inspect({ topic: 'tasks' });
  assert.equal(tasks.tasks[0].name, 'test');
  assert.equal(tasks.running[0].name, 'build');
  const debug = await context.inspect({ topic: 'debug' });
  assert.equal(debug.activeSession.type, 'node');
  assert.equal(debug.breakpoints[0].hasCondition, true);
  const terminals = await context.inspect({ topic: 'terminals' });
  assert.equal(terminals.terminals[0].active, true);
  assert.doesNotMatch(JSON.stringify([tasks, debug, terminals]), /private-|terminal-secret|secret-shell-arg|"configuration"|"commandLine"|"shellArgs"/);
});

test('command inventory cannot run an arbitrary requested command', async t => {
  const { context, calls } = fixture(t);
  const result = await context.inspect({ topic: 'commands', command: 'workbench.action.files.save', query: 'example' });
  assert.deepEqual(result.commands, ['example.show']);
  assert.deepEqual(calls, [['getCommands', true]]);
  assert.equal((await context.inspect({ topic: 'execute', command: 'bad' })).available, false);
  assert.equal(calls.length, 1);
});

test('definition and reference providers receive the current dirty document and precise position', async t => {
  const { context, vscode, doc, calls } = fixture(t);
  vscode.commands.executeCommand = async (...args) => {
    calls.push(['execute', ...args]);
    return [{ targetUri: doc.uri, targetRange: new Range(new Position(0, 0), new Position(0, 20)),
      targetSelectionRange: new Range(new Position(0, 6), new Position(0, 16)) }];
  };
  const result = await context.inspect({ topic: 'definition', path: 'app.js', line: 2, column: 2 });
  assert.equal(result.available, true);
  assert.equal(result.document.version, 9);
  assert.equal(result.document.dirty, true);
  assert.equal(calls[1][1], 'vscode.executeDefinitionProvider');
  assert.deepEqual(calls[1][3], new Position(1, 1));
  assert.deepEqual(result.locations[0].selectionRange.start, { line: 1, column: 7 });
  assert.doesNotMatch(JSON.stringify(result), /secret-query|secret-fragment/);
  await context.inspect({ topic: 'references', path: 'app.js', line: 1, column: 1 });
  assert.equal(calls.at(-1)[1], 'vscode.executeReferenceProvider');
  for (const coordinates of [{ line: 0 }, { line: 100 }, { line: 1.5 }, { column: 10000 }, { column: -1 }]) {
    const invalid = await context.inspect({ topic: 'definition', path: 'app.js', ...coordinates });
    assert.equal(invalid.available, false);
  }
});

test('symbol hierarchy and hover content are bounded and serializable', async t => {
  const { context, vscode } = fixture(t);
  vscode.commands.executeCommand = async command => command === 'vscode.executeDocumentSymbolProvider'
    ? [{ name: 'parent', kind: 4, range: new Range(new Position(0, 0), new Position(1, 10)), children: [{ name: 'child', kind: 11 }] }]
    : [{ contents: [{ value: 'x'.repeat(50000), isTrusted: true, baseUri: { query: 'secret-query' } }] }];
  const symbols = await context.inspect({ topic: 'symbols', path: 'app.js', limit: 2 });
  assert.deepEqual(symbols.symbols.map(symbol => [symbol.name, symbol.parent]), [['parent', undefined], ['child', 'parent']]);
  const hover = await context.inspect({ topic: 'hover', path: 'app.js' });
  assert.equal(hover.hovers[0].contents[0].length, 4000);
  assert.doesNotMatch(JSON.stringify(hover), /isTrusted|secret-query/);
});

test('workspace resolution rejects traversal, external files, secrets, symlink escapes and ambiguous roots', async t => {
  const { context, vscode, project, outside } = fixture(t);
  for (const input of ['../outside/outside.js', path.join(outside, 'outside.js'), '.env', 'missing.js']) {
    assert.equal((await context.inspect({ topic: 'symbols', path: input })).available, false, input);
  }
  const junction = path.join(project, 'link');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await context.open({ path: 'link/outside.js' })).opened, false);
  await assert.rejects(context.resolve({ path: 'link/new.js' }, { allowMissing: true }), /outside/);
  const missing = await context.resolve({ path: 'new/nested/file.js' }, { allowMissing: true });
  assert.equal(missing.uri.fsPath, path.join(project, 'new', 'nested', 'file.js'));
  assert.equal((await context.resolve({}, { allowEmpty: true, directory: true })).uri.fsPath, project);
  vscode.workspace.workspaceFolders.push({ name: 'outside', index: 1, uri: uri(outside) });
  assert.equal((await context.open({ path: 'app.js' })).opened, false);
  assert.equal((await context.open({ path: 'app.js', workspace: 'project' })).opened, true);
  assert.equal((await context.open({ path: 'outside.js', workspace: 1 })).opened, true);
});

test('opening reveals the requested position without saving or editing a dirty buffer', async t => {
  const { context, calls } = fixture(t);
  const result = await context.open({ path: 'app.js', line: 2, column: 3 });
  assert.equal(result.opened, true);
  assert.equal(result.document.dirty, true);
  assert.deepEqual(result.position, { line: 2, column: 3 });
  assert.deepEqual(calls.map(call => call[0]), ['open', 'show']);
  assert.equal(calls[1][2].preview, true);
  assert.deepEqual(calls[1][2].selection.start, new Position(1, 2));
});

test('optional APIs fail partially and secret file classification covers common credential paths', async () => {
  const context = new IdeContext({});
  assert.equal((await context.snapshot()).counts.extensions, null);
  for (const topic of ['extensions', 'diagnostics', 'tasks', 'debug', 'terminals', 'settings', 'commands', 'symbols']) {
    assert.equal((await context.inspect({ topic })).available, false, topic);
  }
  for (const input of ['.env.local', 'x/.aws/config', '.ssh/id_ed25519', 'key.pem', 'SECRETS.json', 'C:\\repo\\.npmrc']) {
    assert.equal(isSensitivePath(input), true, input);
  }
  assert.equal(isSensitivePath('src/environment.js'), false);
});
