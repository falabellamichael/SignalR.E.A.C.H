'use strict';

// A deliberately serializable view of public VS Code APIs. Never serialize an
// extension export, a terminal launch configuration, or a debugger config.
const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 100;
const SAFE_SETTINGS = Object.freeze([
  'editor.tabSize', 'editor.insertSpaces', 'editor.detectIndentation',
  'editor.wordWrap', 'editor.formatOnSave', 'editor.formatOnPaste',
  'editor.defaultFormatter', 'editor.fontSize', 'editor.minimap.enabled',
  'files.autoSave', 'files.eol', 'files.encoding', 'files.trimTrailingWhitespace',
  'files.insertFinalNewline', 'workbench.colorTheme', 'workbench.iconTheme',
  'git.enabled', 'git.autofetch', 'git.confirmSync',
]);
const TOPICS = Object.freeze(['workspace', 'editors', 'diagnostics', 'extensions',
  'tasks', 'debug', 'terminals', 'settings', 'commands', 'symbols',
  'definition', 'references', 'hover']);

function array(value) { return Array.isArray(value) ? value : []; }
function text(value, max = 300) { return typeof value === 'string' ? value.slice(0, max) : undefined; }
function limit(value) { return Number.isInteger(value) ? Math.max(1, Math.min(MAX_ITEMS, value)) : 30; }
function matches(value, query) { return !query || String(value || '').toLowerCase().includes(String(query).toLowerCase()); }
function secretPath(value) {
  const parts = String(value || '').replace(/\\/g, '/').toLowerCase().split('/');
  return parts.some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/.test(part)
    || /\.(?:pem|pfx|p12|key|keystore)$/.test(part))
    || parts.some(part => ['.ssh', '.aws', '.azure', '.gnupg'].includes(part));
}
function safeUrl(value) {
  let input = typeof value === 'string' ? value : value && value.url;
  if (typeof input !== 'string') return undefined;
  input = input.replace(/^git\+/, '');
  const scp = /^git@([^:/\s]+):(.+)$/.exec(input);
  if (scp) input = `https://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(input);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString().slice(0, 1000);
  } catch (_) { return undefined; }
}
function position(value) {
  return value && Number.isInteger(value.line) && Number.isInteger(value.character)
    ? { line: value.line + 1, column: value.character + 1 } : undefined;
}
function range(value) { return value ? { start: position(value.start), end: position(value.end) } : undefined; }
function scopedPath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
// Agent context probes run without a timeout: a language provider that is slow
// to answer is still worth waiting for, and cutting it off silently drops
// context the model asked for. An explicit budget is still honoured if a caller
// passes one.
async function bounded(operation, timeoutMs = 0) {
  if (!(timeoutMs > 0)) return operation();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('VS Code provider timed out')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

class IdeContext {
  constructor(vscode) { this.vscode = vscode; }

  _folders() { return array(this.vscode.workspace && this.vscode.workspace.workspaceFolders); }

  _resource(uri) {
    if (!uri) return undefined;
    const resource = { scheme: text(uri.scheme, 60), path: text(uri.scheme === 'file' ? uri.fsPath : uri.path, 2000) };
    let folder;
    try { folder = this.vscode.workspace.getWorkspaceFolder(uri); } catch (_) { /* optional API */ }
    if (folder) {
      resource.workspace = text(folder.name);
      resource.workspaceIndex = folder.index;
      resource.relativePath = uri.scheme === 'file'
        ? path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')
        : path.posix.relative(folder.uri.path, uri.path);
    }
    return resource;
  }

  _document(document) {
    if (!document) return undefined;
    return {
      ...this._resource(document.uri), language: text(document.languageId, 100),
      dirty: Boolean(document.isDirty), untitled: Boolean(document.isUntitled),
      version: document.version, lineCount: document.lineCount,
      excludedFromContent: secretPath(document.uri && (document.uri.fsPath || document.uri.path)),
    };
  }

  _editor(editor) {
    if (!editor) return undefined;
    return { document: this._document(editor.document), viewColumn: editor.viewColumn,
      selections: array(editor.selections).slice(0, 20).map(selection => ({
        ...range(selection), anchor: position(selection.anchor), active: position(selection.active),
      })), visibleRanges: array(editor.visibleRanges).slice(0, 20).map(range) };
  }

  _workspace() {
    const vscode = this.vscode;
    const env = vscode.env || {};
    const workspace = vscode.workspace || {};
    return {
      host: { version: text(vscode.version), appName: text(env.appName),
        remoteName: text(env.remoteName) || null, language: text(env.language),
        uiKind: env.uiKind, appHost: text(env.appHost) },
      name: text(workspace.name), trusted: workspace.isTrusted === true,
      workspaceFile: this._resource(workspace.workspaceFile),
      folders: this._folders().map(folder => ({ name: text(folder.name), index: folder.index, ...this._resource(folder.uri) })),
      capabilities: { topics: TOPICS, openWorkspaceFile: true, arbitraryCommandExecution: false,
        terminalOutput: false, settingValues: SAFE_SETTINGS },
    };
  }

  _editors(req = {}) {
    const window = this.vscode.window || {};
    const max = limit(req.limit);
    const documents = array((this.vscode.workspace || {}).textDocuments);
    const groups = array(window.tabGroups && window.tabGroups.all);
    const tabs = [];
    for (const group of groups) {
      for (const tab of array(group.tabs)) {
        const input = tab.input || {};
        if (!matches(tab.label, req.query)) continue;
        tabs.push({ label: text(tab.label), active: Boolean(tab.isActive), dirty: Boolean(tab.isDirty),
          pinned: Boolean(tab.isPinned), preview: Boolean(tab.isPreview), viewColumn: group.viewColumn,
          resource: this._resource(input.uri), original: this._resource(input.original),
          modified: this._resource(input.modified), notebookType: text(input.notebookType), viewType: text(input.viewType) });
      }
    }
    return { active: this._editor(window.activeTextEditor),
      visible: array(window.visibleTextEditors).slice(0, max).map(editor => this._editor(editor)),
      documents: documents.filter(doc => matches(doc.uri && (doc.uri.fsPath || doc.uri.path), req.query)).slice(0, max).map(doc => this._document(doc)),
      tabs: tabs.slice(0, max), totalDocuments: documents.length, totalTabs: tabs.length,
      note: 'Editor documents describe current buffers, including unsaved changes; tab resources contain no URI queries or contents.' };
  }

  _diagnostics(req = {}) {
    const api = this.vscode.languages;
    if (!api || typeof api.getDiagnostics !== 'function') return { available: false, diagnostics: [] };
    const output = [];
    const counts = { error: 0, warning: 0, information: 0, hint: 0 };
    let total = 0;
    for (const [uri, diagnostics] of api.getDiagnostics()) {
      const filename = uri.fsPath || uri.path;
      if (secretPath(filename) || !matches(filename, req.path || req.query)) continue;
      for (const diagnostic of array(diagnostics)) {
        const severity = ['error', 'warning', 'information', 'hint'][diagnostic.severity] || 'information';
        if (req.severity && String(req.severity).toLowerCase() !== severity) continue;
        counts[severity] += 1; total += 1;
        if (output.length < limit(req.limit)) output.push({ resource: this._resource(uri), severity,
          message: text(diagnostic.message, 2000), source: text(diagnostic.source),
          code: typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number' ? diagnostic.code
            : diagnostic.code && text(String(diagnostic.code.value)), range: range(diagnostic.range) });
      }
    }
    return { available: true, diagnostics: output, counts, total, truncated: total > output.length };
  }

  _extension(extension, details) {
    const manifest = extension.packageJSON || {};
    const info = { id: text(extension.id), name: text(manifest.displayName || manifest.name),
      publisher: text(manifest.publisher), version: text(manifest.version), active: Boolean(extension.isActive),
      extensionKind: typeof extension.extensionKind === 'number' ? extension.extensionKind : undefined,
      path: text(extension.extensionPath, 2000),
      repository: safeUrl(manifest.repository), homepage: safeUrl(manifest.homepage),
      description: text(manifest.description, 500) };
    if (!details) return info;
    const contributes = manifest.contributes || {};
    const commands = array(contributes.commands);
    const configurations = Array.isArray(contributes.configuration) ? contributes.configuration : [contributes.configuration];
    const settings = [];
    for (const config of configurations) {
      for (const [key, declaration] of Object.entries(config && config.properties || {})) {
        if (settings.length >= 60) break;
        const schema = declaration || {};
        settings.push({ key: text(key), type: typeof schema.type === 'string' ? text(schema.type)
          : array(schema.type).map(item => text(item)).filter(Boolean),
        description: text(schema.description || schema.markdownDescription, 300) });
      }
    }
    info.contributes = {
      commands: commands.slice(0, 40).map(command => ({ id: text(command.command), title: text(command.title), category: text(command.category) })),
      commandCount: commands.length, settings,
      languages: array(contributes.languages).slice(0, 30).map(language => ({ id: text(language.id),
        aliases: array(language.aliases).slice(0, 10).map(value => text(value)),
        extensions: array(language.extensions).slice(0, 20).map(value => text(value)) })),
      debuggers: array(contributes.debuggers).slice(0, 20).map(debuggerInfo => ({ type: text(debuggerInfo.type), label: text(debuggerInfo.label),
        languages: array(debuggerInfo.languages).slice(0, 20).map(value => text(value)) })),
      taskTypes: array(contributes.taskDefinitions).slice(0, 20).map(task => text(task.type)),
    };
    return info;
  }

  _extensions(req = {}) {
    const all = array(this.vscode.extensions && this.vscode.extensions.all);
    const filtered = all.filter(extension => (!req.extensionId || extension.id.toLowerCase() === String(req.extensionId).toLowerCase())
      && matches(`${extension.id} ${(extension.packageJSON || {}).displayName || ''} ${(extension.packageJSON || {}).description || ''}`, req.query));
    const max = limit(req.limit);
    return { available: Boolean(this.vscode.extensions), total: all.length, matched: filtered.length,
      extensions: filtered.slice(0, max).map(extension => this._extension(extension, Boolean(req.extensionId || req.query || req.details))),
      truncated: filtered.length > max, note: 'Only installed manifest metadata is exposed; extensions are not activated and exports/settings values are not read.' };
  }

  _task(task) {
    if (!task) return undefined;
    return { name: text(task.name), source: text(task.source), type: text(task.definition && task.definition.type),
      group: text(task.group && task.group.id), background: Boolean(task.isBackground),
      scope: typeof task.scope === 'number' ? task.scope : task.scope && { name: text(task.scope.name), ...this._resource(task.scope.uri) } };
  }

  async _tasks(req = {}) {
    const api = this.vscode.tasks;
    if (!api) return { available: false, tasks: [], running: [] };
    const running = array(api.taskExecutions).slice(0, limit(req.limit)).map(execution => this._task(execution.task));
    if (typeof api.fetchTasks !== 'function') return { available: false, running, tasks: [] };
    try {
      const tasks = array(await bounded(() => api.fetchTasks())).filter(task => matches(`${task.name} ${task.source} ${task.definition && task.definition.type}`, req.query));
      return { available: true, tasks: tasks.slice(0, limit(req.limit)).map(task => this._task(task)), running,
        total: tasks.length, truncated: tasks.length > limit(req.limit), note: 'Discovery only; no task has been executed. Task commands, arguments and environment are excluded.' };
    } catch (_) { return { available: false, running, tasks: [], note: 'Task discovery is unavailable or timed out.' }; }
  }

  _debug(req = {}) {
    const api = this.vscode.debug;
    if (!api) return { available: false };
    const session = api.activeDebugSession;
    const breakpoints = array(api.breakpoints);
    return { available: true, activeSession: session ? { name: text(session.name), type: text(session.type),
      workspace: session.workspaceFolder && text(session.workspaceFolder.name) } : null,
      breakpoints: breakpoints.slice(0, limit(req.limit)).map(breakpoint => ({
        enabled: Boolean(breakpoint.enabled), resource: this._resource(breakpoint.location && breakpoint.location.uri),
        range: range(breakpoint.location && breakpoint.location.range),
        functionName: text(breakpoint.functionName), hasCondition: Boolean(breakpoint.condition),
        hasLogMessage: Boolean(breakpoint.logMessage),
      })), totalBreakpoints: breakpoints.length,
      note: 'Session and breakpoint metadata only; debugger configuration, conditions, log expressions and variables are excluded.' };
  }

  _terminals(req = {}) {
    const window = this.vscode.window || {};
    const terminals = array(window.terminals);
    return { available: Array.isArray(window.terminals), total: terminals.length,
      terminals: terminals.filter(terminal => matches(terminal.name, req.query)).slice(0, limit(req.limit)).map(terminal => ({
        name: text(terminal.name), active: terminal === window.activeTerminal,
        interacted: Boolean(terminal.state && terminal.state.isInteractedWith),
        exitCode: terminal.exitStatus && terminal.exitStatus.code,
      })), note: 'Terminal metadata only. Existing terminal output/history and shell launch configuration are not exposed.' };
  }

  _settings(req = {}) {
    const api = this.vscode.workspace;
    if (!api || typeof api.getConfiguration !== 'function') return { available: false, settings: [] };
    const uri = this.vscode.window && this.vscode.window.activeTextEditor && this.vscode.window.activeTextEditor.document.uri;
    const settings = [];
    for (const key of SAFE_SETTINGS.filter(key => (!req.key || req.key === key) && matches(key, req.query))) {
      const dot = key.indexOf('.');
      try {
        const value = api.getConfiguration(key.slice(0, dot), uri).get(key.slice(dot + 1));
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) settings.push({ key, value: typeof value === 'string' ? text(value) : value });
      } catch (_) { /* optional configuration may be unavailable */ }
    }
    return { available: true, settings, allowedKeys: SAFE_SETTINGS,
      note: 'Only these editor/files/workbench/git settings can expose values. Extension schemas are available through topic extensions; their defaults and values are excluded.' };
  }

  async _commands(req = {}) {
    const api = this.vscode.commands;
    if (!api || typeof api.getCommands !== 'function') return { available: false, commands: [] };
    try {
      const commands = array(await bounded(() => api.getCommands(true))).filter(command => matches(command, req.query)).sort();
      return { available: true, commands: commands.slice(0, limit(req.limit)).map(command => text(command)),
        total: commands.length, truncated: commands.length > limit(req.limit),
        note: 'Discovery only; this tool does not execute command IDs.' };
    } catch (_) { return { available: false, commands: [], note: 'Command discovery is unavailable or timed out.' }; }
  }

  async resolve(req = {}, options = {}) {
    const folders = this._folders();
    let folder;
    if (req.workspace !== undefined) {
      const selected = folders.filter(item => typeof req.workspace === 'number'
        ? item.index === req.workspace : item.name === req.workspace || item.uri.fsPath === req.workspace || item.uri.path === req.workspace);
      if (selected.length !== 1) throw new Error('Select one workspace folder by its exact name, absolute root path, or zero-based index.');
      folder = selected[0];
    } else {
      if (folders.length !== 1) throw new Error('A workspace selector is required when there are multiple folders or no folder is open.');
      folder = folders[0];
    }
    const input = options.allowEmpty && !req.path ? '.' : req.path;
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('A workspace file path is required.');
    if (secretPath(input)) throw new Error('Known credential and secret files are excluded.');
    if (input.replace(/\\/g, '/').split('/').some(part => part === '..')) throw new Error('Path traversal is not allowed.');
    if (folder.uri.scheme === 'file') {
      const root = path.resolve(folder.uri.fsPath);
      const target = path.resolve(root, input);
      if (!scopedPath(root, target)) throw new Error('The path must stay inside the selected workspace folder.');
      let realRoot, realTarget;
      let existing = target;
      try {
        realRoot = await fs.promises.realpath(root);
        while (true) {
          try { realTarget = await fs.promises.realpath(existing); break; }
          catch (error) {
            if (!options.allowMissing || error.code !== 'ENOENT' || existing === root) throw error;
            // A dangling symlink must not be mistaken for a missing directory.
            try { await fs.promises.lstat(existing); throw new Error('Unresolvable symbolic link'); }
            catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
            existing = path.dirname(existing);
          }
        }
      } catch (_) { throw new Error('The workspace path does not exist or is not readable.'); }
      if (!scopedPath(realRoot, realTarget) || secretPath(realTarget)) throw new Error('The resolved file is outside the workspace or is a known secret file.');
      if (existing === target) {
        const stat = await fs.promises.stat(realTarget);
        if (options.directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(options.directory ? 'The path must identify a directory.' : 'The path must identify a file.');
      }
      return { uri: this.vscode.Uri.file(target), folder };
    }
    if (folder.uri.scheme !== 'vscode-remote') throw new Error('Navigation is supported for local and VS Code remote workspace files.');
    if (/^[a-zA-Z]:|^[a-zA-Z][a-zA-Z0-9+.-]*:|^\\/.test(input)) throw new Error('Use a path relative to the selected remote workspace.');
    const root = path.posix.normalize(folder.uri.path).replace(/\/$/, '');
    const normalized = input.replace(/\\/g, '/');
    const target = path.posix.isAbsolute(normalized) ? path.posix.normalize(normalized) : path.posix.join(root, normalized);
    if (target !== root && !target.startsWith(`${root}/`)) throw new Error('The path must stay inside the selected workspace folder.');
    return { uri: folder.uri.with({ path: target, query: '', fragment: '' }), folder };
  }

  async _resolve(req) { return (await this.resolve(req)).uri; }

  async _navigation(req) {
    if (!this.vscode.commands || typeof this.vscode.commands.executeCommand !== 'function') return { available: false };
    const uri = await this._resolve(req);
    const document = await bounded(() => this.vscode.workspace.openTextDocument(uri));
    const provider = { symbols: 'vscode.executeDocumentSymbolProvider', definition: 'vscode.executeDefinitionProvider',
      references: 'vscode.executeReferenceProvider', hover: 'vscode.executeHoverProvider' }[req.topic];
    const args = [uri];
    if (req.topic !== 'symbols') args.push(this._requestedPosition(document, req));
    let result;
    try { result = array(await bounded(() => this.vscode.commands.executeCommand(provider, ...args))); }
    catch (_) { return { available: false, document: this._document(document), note: 'Language provider is unavailable or timed out.' }; }
    const max = limit(req.limit);
    if (req.topic === 'hover') {
      let budget = 12000;
      const hovers = result.slice(0, max).map(hover => ({ range: range(hover.range),
        contents: array(hover.contents).slice(0, 10).map(content => {
          const raw = typeof content === 'string' ? content : content && content.value;
          const value = text(raw, Math.min(budget, 4000));
          budget -= value ? value.length : 0;
          return value;
        }).filter(Boolean) }));
      return { available: true, document: this._document(document), hovers };
    }
    if (req.topic === 'symbols') {
      const symbols = [];
      const visit = (items, parent, depth) => {
        if (depth > 20) return;
        for (const symbol of items) {
          if (symbols.length >= max) return;
          const location = symbol.location;
          if (location && secretPath(location.uri && (location.uri.fsPath || location.uri.path))) continue;
          if (matches(symbol.name, req.query)) symbols.push({ name: text(symbol.name), kind: symbol.kind,
            detail: text(symbol.detail, 500), parent: text(parent || symbol.containerName),
            resource: this._resource(location ? location.uri : uri),
            range: range(location ? location.range : symbol.range), selectionRange: range(symbol.selectionRange) });
          visit(array(symbol.children), symbol.name, depth + 1);
        }
      };
      visit(result, undefined, 0);
      return { available: true, document: this._document(document), symbols, truncated: symbols.length >= max };
    }
    const locations = result.filter(location => {
      const resource = location.targetUri || location.uri;
      return resource && !secretPath(resource.fsPath || resource.path);
    });
    return { available: true, document: this._document(document), locations: locations.slice(0, max).map(location => ({
      resource: this._resource(location.targetUri || location.uri),
      range: range(location.targetRange || location.range), selectionRange: range(location.targetSelectionRange),
    })), total: locations.length, truncated: locations.length > max };
  }

  _requestedPosition(document, req) {
    const line = req.line === undefined ? 1 : req.line;
    const column = req.column === undefined ? 1 : req.column;
    if (!Number.isInteger(line) || line < 1 || line > document.lineCount || !Number.isInteger(column) || column < 1) {
      throw new Error('Line and column must be positive one-based integers within the document.');
    }
    const lineInfo = document.lineAt(line - 1);
    const length = lineInfo.range ? lineInfo.range.end.character : lineInfo.text.length;
    if (column > length + 1) throw new Error('Column is outside the selected line.');
    return new this.vscode.Position(line - 1, column - 1);
  }

  async open(req = {}) {
    try {
      const uri = await this._resolve(req);
      const document = await bounded(() => this.vscode.workspace.openTextDocument(uri));
      const at = this._requestedPosition(document, req);
      const selection = new this.vscode.Range(at, at);
      await bounded(() => this.vscode.window.showTextDocument(document, { preview: true, selection }));
      return { available: true, opened: true, document: this._document(document), position: position(at) };
    } catch (error) { return { available: false, opened: false, error: text(error.message, 500) }; }
  }

  async snapshot() {
    const state = this._workspace();
    const editors = this._editors({ limit: 8 });
    let diagnostics;
    try { diagnostics = this._diagnostics({ limit: 1 }); } catch (_) { diagnostics = { available: false }; }
    state.editors = { active: editors.active, visible: editors.visible, tabs: editors.tabs,
      unsavedDocuments: array((this.vscode.workspace || {}).textDocuments).filter(document => document.isDirty).slice(0, 12).map(document => this._document(document)) };
    state.counts = { openDocuments: editors.totalDocuments, tabs: editors.totalTabs,
      diagnostics: diagnostics.available ? diagnostics.counts : null,
      extensions: this.vscode.extensions ? array(this.vscode.extensions.all).length : null,
      runningTasks: this.vscode.tasks ? array(this.vscode.tasks.taskExecutions).length : null,
      terminals: this.vscode.window && Array.isArray(this.vscode.window.terminals) ? this.vscode.window.terminals.length : null,
      activeDebugSession: Boolean(this.vscode.debug && this.vscode.debug.activeDebugSession),
      breakpoints: this.vscode.debug ? array(this.vscode.debug.breakpoints).length : null };
    return state;
  }

  async inspect(req = {}) {
    const topic = req.topic || 'workspace';
    try {
      let result;
      switch (topic) {
        case 'workspace': result = this._workspace(); break;
        case 'editors': result = this._editors(req); break;
        case 'diagnostics': result = this._diagnostics(req); break;
        case 'extensions': result = this._extensions(req); break;
        case 'tasks': result = await this._tasks(req); break;
        case 'debug': result = this._debug(req); break;
        case 'terminals': result = this._terminals(req); break;
        case 'settings': result = this._settings(req); break;
        case 'commands': result = await this._commands(req); break;
        case 'symbols': case 'definition': case 'references': case 'hover':
          result = await this._navigation({ ...req, topic }); break;
        default: return { topic, available: false, error: `Unknown VS Code topic. Supported: ${TOPICS.join(', ')}` };
      }
      return { topic, ...result };
    } catch (error) { return { topic, available: false, error: text(error.message, 500) }; }
  }
}

module.exports = { IdeContext, isSensitivePath: secretPath };
