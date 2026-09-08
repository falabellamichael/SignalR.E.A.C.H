/* SimpleREACH — VS Code extension.
 * Side-panel chat over the REACH OpenAI-compatible endpoint.
 * No dependencies: network I/O happens here in the extension host (Node 18+ fetch),
 * the webview only renders. Streaming is relayed as postMessage deltas.
 */
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { webSearchDdg, searchAndFetch, pageText, browsePage, disposeBrowser, refreshPlaywright, hasPlaywright } = require('./search');

const CONFIG_SECTION = 'simplereach';

const PROPOSED_SCHEME = 'reach-proposed';
const proposedDocs = new Map();

/* Provides the "proposed" side of a REACH agent edit as a virtual document so
 * the user can review changes in VS Code's native diff editor. */
const proposedProvider = {
  provideTextDocumentContent(uri) {
    return proposedDocs.get(uri.toString()) || '';
  },
};

function proposedUri(kind, rel, text) {
  const clean = (rel || '').split('/').map(encodeURIComponent).join('/');
  const uri = vscode.Uri.from({
    scheme: PROPOSED_SCHEME,
    path: '/' + kind + '/' + clean,
    query: 't=' + Date.now().toString(36),
  });
  proposedDocs.set(uri.toString(), text);
  return uri;
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/* ---- Copilot system tray supervisor (invisible browser + bridge :21302) ---- */

const TRAY_PORT = 21302;

function trayDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'SignalREACH', 'copilot', 'tray');
}

function trayHealth(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: TRAY_PORT, path: '/health', timeout: timeoutMs || 700 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/* 'running' | 'starting' | 'missing' | 'error'. The tray holds a
 * single-instance lock, so a redundant spawn simply exits. */
async function startTray() {
  if (await trayHealth()) return 'running';
  const dir = trayDir();
  const electron = path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electron) || !fs.existsSync(path.join(dir, 'main.js'))) return 'missing';
  try {
    const child = spawn(electron, [dir], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: dir,
    });
    child.on('error', () => {});
    child.unref();
    return 'starting';
  } catch (e) {
    return 'error';
  }
}

/* ---- browser engine one-click installer (REACH Browser page) ---------- */

function findNode() {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  if (process.platform === 'win32') {
    const extra = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'node.exe'),
    ];
    const pf86 = process.env['ProgramFiles(x86)'];
    if (pf86) extra.push(path.join(pf86, 'nodejs', 'node.exe'));
    candidates.push(...extra);
  } else {
    candidates.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node');
  }
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { /* keep looking */ }
  }
  return null;
}

/* npm ships as <node dir>/node_modules/npm/bin/npm-cli.js in standard
 * installs — running it with node avoids .cmd/.ps1 batch-file pitfalls in
 * the extension host. */
function npmCliPath(nodeExe) {
  const p = path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(p) ? p : null;
}

let browserInstallRunning = false;

async function installBrowserEngine(extRoot, onProgress) {
  if (browserInstallRunning) return { ok: false, error: 'install already in progress' };
  browserInstallRunning = true;
  try {
    const node = findNode();
    if (!node) {
      return { ok: false, error: 'Node.js was not found — install it from nodejs.org, reload VS Code, and try again.' };
    }
    const npmCli = npmCliPath(node);
    if (!npmCli) {
      return { ok: false, error: 'npm was not found next to node — install Node.js with npm and try again.' };
    }
    const run = (argv, stage, timeoutMs) => new Promise((resolve) => {
      let child;
      try {
        child = spawn(node, argv, { cwd: extRoot, windowsHide: true });
      } catch (e) {
        resolve({ code: -1, err: String((e && e.message) || e) });
        return;
      }
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* already gone */ }
        resolve({ code: -1, err: 'timed out after ' + Math.round(timeoutMs / 60000) + ' min' });
      }, timeoutMs);
      const feed = (chunk) => {
        out += String(chunk);
        if (onProgress) onProgress(stage, out + err);
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: String((e && e.message) || e) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
    });

    onProgress('npm', 'Installing the browser engine (npm)…');
    // --prefix pins the install to the extension dir: without it npm walks up
    // looking for a package.json and can silently install into the home dir.
    const r1 = await run([npmCli, 'install', 'playwright', '--prefix', extRoot,
      '--no-audit', '--no-fund', '--no-package-lock', '--no-save'], 'npm', 10 * 60 * 1000);
    if (r1.code !== 0) {
      return { ok: false, error: ('npm install failed: ' + (r1.err || ('exit ' + r1.code))).slice(0, 400) };
    }
    onProgress('chromium', 'Downloading headless Chromium…');
    const cli = path.join(extRoot, 'node_modules', 'playwright', 'cli.js');
    const r2 = await run([cli, 'install', 'chromium'], 'chromium', 15 * 60 * 1000);
    if (r2.code !== 0) {
      return { ok: false, error: ('Chromium download failed: ' + (r2.err || ('exit ' + r2.code))).slice(0, 400) };
    }
    const ok = refreshPlaywright();
    return ok
      ? { ok: true, error: null }
      : { ok: false, error: 'engine installed but did not load — reload VS Code (Ctrl+Shift+P → Reload Window)' };
  } finally {
    browserInstallRunning = false;
  }
}

function config() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    endpoint: String(cfg.get('endpoint') || 'http://127.0.0.1:20777/v1').replace(/\/+$/, ''),
    accessKey: String(cfg.get('accessKey') || ''),
    model: String(cfg.get('model') || 'gpt-4o-mini'),
    maxTokens: Number(cfg.get('maxTokens') || 2048),
    workspaceContext: cfg.get('workspaceContext') !== false,
    contextMaxKb: Math.max(8, Number(cfg.get('contextMaxKb') || 120)),
    think: cfg.get('think') !== false,
    thinkModel: String(cfg.get('thinkModel') || ''),
    thinkMaxTokens: Math.max(64, Number(cfg.get('thinkMaxTokens') || 512)),
    webSearch: cfg.get('webSearch') !== false,
    searchResults: Math.max(1, Math.min(10, Number(cfg.get('searchResults') || 5))),
    playwright: cfg.get('playwright') !== false,
    agentic: cfg.get('agentic') !== false,
  };
}

/* ---------- workspace context gathering ---------- */

const TREE_EXCLUDES = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**',
  '**/build/**', '**/.next/**', '**/.venv/**', '**/venv/**',
  '**/__pycache__/**', '**/*.min.js', '**/*.map', '**/*.lock',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp',
  '**/*.ico', '**/*.svg', '**/*.woff*', '**/*.ttf', '**/*.pdf',
  '**/*.zip', '**/*.exe', '**/*.dll', '**/*.bin',
];
const MAX_TREE_ENTRIES = 250;
const MAX_OPEN_FILES = 40;
const PER_FILE_BUDGET = 20 * 1024;      // per-file cap (chars)
const TOTAL_CONTEXT_BUDGET = 120 * 1024; // total context cap (chars)

const EXCLUDED_NAMES = TREE_EXCLUDES
  .map((ex) => ex.replace(/^\*\*\//, '').replace(/\/\*\*$/, ''))
  .filter((n) => n && !n.includes('/'));

function relativePath(fileUri) {
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (folder && fileUri.fsPath.startsWith(folder.uri.fsPath)) {
    return fileUri.fsPath.slice(folder.uri.fsPath.length + 1);
  }
  return vscode.workspace.asRelativePath(fileUri, false);
}

function openTextDocuments() {
  const docs = [];
  const seen = new Set();
  const active = vscode.window.activeTextEditor
    && vscode.window.activeTextEditor.document;
  if (active && !active.isUntitled) {
    docs.push(active);
    seen.add(active.uri.toString());
  }
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      const doc = tab.input.uri && vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === tab.input.uri.toString());
      if (doc && !doc.isUntitled && !seen.has(doc.uri.toString())) {
        docs.push(doc);
        seen.add(doc.uri.toString());
      }
      if (docs.length >= MAX_OPEN_FILES) break;
    }
    if (docs.length >= MAX_OPEN_FILES) break;
  }
  return docs;
}

async function buildTreeLines() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return [];
  const all = [];
  for (const folder of folders) {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'), `{${TREE_EXCLUDES.join(',')}}`, 400);
    for (const f of files) all.push(f);
  }
  all.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  const roots = new Map();
  for (const folder of folders) roots.set(folder.name, folder.uri.fsPath);
  const lines = [];
  let count = 0;
  for (const f of all) {
    if (count >= MAX_TREE_ENTRIES) { lines.push('… (more files)'); break; }
    const rel = relativePath(f);
    const depth = rel.split(/[\\/]/).length - 1;
    if (depth > 5) continue;          // keep the tree shallow
    lines.push('  '.repeat(Math.max(0, depth)) + rel.split(/[\\/]/).pop());
    count += 1;
  }
  return lines;
}

function buildContextBlock(files, treeLines) {
  const parts = [];
  parts.push('Workspace context (files open in VS Code):');
  const roots = vscode.workspace.workspaceFolders || [];
  if (roots.length) {
    parts.push('Workspace root(s): ' + roots.map((f) => f.uri.fsPath).join(' ; '));
  }
  if (treeLines && treeLines.length) {
    parts.push('Workspace tree:');
    parts.push(treeLines.slice(0, 160).join('\n'));
  }
  let used = 0;
  for (const doc of files) {
    const rel = relativePath(doc.uri);
    const content = doc.getText().slice(0, PER_FILE_BUDGET);
    if (used + content.length > TOTAL_CONTEXT_BUDGET) {
      parts.push(`… (context truncated after ${files.length} files)`);
      break;
    }
    used += content.length;
    parts.push(`\n--- ${rel} (${doc.languageId}) ---\n${content}`);
  }
  return parts.join('\n');
}

class ReachChatViewProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
    this._controller = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    const wv = webviewView.webview;
    wv.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };
    wv.html = this._html(wv);
    wv.onDidReceiveMessage(async (msg) => {
      switch (msg && msg.type) {
        case 'getConfig':
          this._post('config', config());
          break;
        case 'fetchModels':
          await this._fetchModels();
          break;
        case 'chat':
          await this._chat(msg.body || {});
          break;
        case 'workspaceToggle':
          this._workspaceState();
          break;
        case 'workspaceInfo':
          this._workspaceState();
          break;
        case 'abort':
          if (this._controller) this._controller.abort();
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:simplereach.simplereach');
          break;
        case 'openBrowser':
          vscode.commands.executeCommand('simplereach.openBrowser');
          break;
        case 'setConfig': {
          const key = String(msg.key || '');
          const allowed = ['endpoint', 'accessKey', 'model', 'maxTokens', 'workspaceContext', 'contextMaxKb', 'think', 'thinkModel', 'thinkMaxTokens', 'webSearch', 'searchResults', 'playwright'];
          if (!allowed.includes(key)) break;
          const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
          const current = cfg.get(key);
          let value = msg.value;
          if (typeof current === 'number') value = Number(value);
          else if (typeof current === 'boolean') value = value === true || value === 'true';
          else value = String(value == null ? '' : value);
          try {
            await cfg.update(key, value, vscode.ConfigurationTarget.Global);
          } catch (e) { break; }
          this._post('configSaved', { key, value, config: config() });
          if (key === 'endpoint') await this._fetchModels();
          break;
        }
        case 'applyEdit': {
          const uid = String(msg.uid || '');
          const rel = String(msg.path || '').replace(/\\/g, '/');
          const search = String(msg.search == null ? '' : msg.search);
          const replace = String(msg.replace == null ? '' : msg.replace);
          const folders = vscode.workspace.workspaceFolders || [];
          if (!folders.length) { this._post('editResult', { uid, error: 'No workspace folder is open.' }); break; }
          if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').some((p) => p === '..')) {
            this._post('editResult', { uid, error: 'Invalid path: ' + rel });
            break;
          }
          try {
            const uri = vscode.Uri.joinPath(folders[0].uri, rel);
            let current = '';
            let exists = true;
            try {
              current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            } catch (e) { exists = false; }
            let newText;
            if (!exists) {
              if (search !== '') {
                this._post('editResult', { uid, error: rel + ' does not exist (use empty search to create it).' });
                break;
              }
              newText = replace;
            } else {
              const idx = current.indexOf(search);
              if (idx === -1) {
                this._post('editResult', { uid, error: 'Search text not found in ' + rel + ' — the file may have changed.' });
                break;
              }
              newText = current.slice(0, idx) + replace + current.slice(idx + search.length);
            }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, 'utf8'));
            const td = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(td, { preview: false, preserveFocus: false });
            this._post('editResult', { uid, ok: true, path: rel });
          } catch (e) {
            this._post('editResult', { uid, error: String((e && e.message) || e) });
          }
          break;
        }
        case 'reviewEdit': {
          const uid = String(msg.uid || '');
          const rel = String(msg.path || '').replace(/\\/g, '/');
          const search = String(msg.search == null ? '' : msg.search);
          const replace = String(msg.replace == null ? '' : msg.replace);
          const folders = vscode.workspace.workspaceFolders || [];
          if (!folders.length) { this._post('editResult', { uid, error: 'No workspace folder is open.' }); break; }
          if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').some((p) => p === '..')) {
            this._post('editResult', { uid, error: 'Invalid path: ' + rel });
            break;
          }
          try {
            const uri = vscode.Uri.joinPath(folders[0].uri, rel);
            let current = '';
            let exists = true;
            try { current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); }
            catch (e) { exists = false; }
            let newText;
            if (!exists) {
              if (search !== '') {
                this._post('editResult', { uid, error: rel + ' does not exist (use empty search to create it).' });
                break;
              }
              newText = replace;
            } else {
              const idx = current.indexOf(search);
              if (idx === -1) {
                this._post('editResult', { uid, error: 'Search text not found in ' + rel + ' — the file may have changed.' });
                break;
              }
              newText = current.slice(0, idx) + replace + current.slice(idx + search.length);
            }
            const leftUri = exists ? uri : proposedUri('empty', rel, '');
            const rightUri = proposedUri('proposed', rel, newText);
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, (exists ? 'Review: ' : 'New file: ') + rel, { preview: true });
            this._post('editResult', { uid, ok: true, path: rel, reviewed: true });
          } catch (e) {
            this._post('editResult', { uid, error: String((e && e.message) || e) });
          }
          break;
        }
        case 'toolReq': {
          const uid = String(msg.uid || '');
          const action = String(msg.action || '');
          const rel = String(msg.path || '').replace(/\\/g, '/');
          const pattern = String(msg.pattern || '').slice(0, 200);
          const command = String(msg.command || '').slice(0, 1000);
          const folders = vscode.workspace.workspaceFolders || [];
          if (!folders.length) { this._post('toolResult', { uid, ok: false, error: 'No workspace folder is open.' }); break; }
          const withTimeout = (p) => Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error('tool timed out')), 15000)),
          ]);
          try {
            let result = '';
            let image = null;
            if (action === 'read') {
              if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').some((p) => p === '..')) throw new Error('invalid path');
              const uri = vscode.Uri.joinPath(folders[0].uri, rel);
              const text = Buffer.from(await withTimeout(vscode.workspace.fs.readFile(uri))).toString('utf8');
              result = '--- ' + rel + ' ---\n' + text.slice(0, 30000);
            } else if (action === 'search') {
              if (!pattern) throw new Error('no search pattern');
              result = await withTimeout(this._workspaceSearch(pattern));
            } else if (action === 'list') {
              result = await withTimeout(this._workspaceList(rel));
            } else if (action === 'shell') {
              if (!command) throw new Error('no command');
              const ok = await vscode.window.showWarningMessage(
                'REACH agent wants to run this in the integrated terminal:\n\n' + command,
                { modal: true },
                'Run', 'Cancel');
              if (ok !== 'Run') throw new Error('command not approved');
              const term = vscode.window.createTerminal('REACH Agent');
              term.show(true);
              term.sendText(command);
              result = 'Approved — command sent to the integrated terminal: ' + command
                + '\n(The output appears in the VS Code terminal panel; you cannot read it. '
                + 'Tell the user it is running there and continue based on your reasoning.)';
            } else if (action === 'browse') {
              const url = String(msg.url || '').slice(0, 800);
              if (!/^https?:\/\//i.test(url)) throw new Error('invalid url: ' + url);
              const bp = await browsePage(url, 20000);
              if (!bp.ok) throw new Error(bp.error || 'browse failed');
              image = bp.image || null;
              const shown = (bp.url && bp.url !== url) ? bp.url : url;
              result = '--- ' + shown + (bp.title ? ' (' + bp.title + ')' : '') + ' ---\n'
                + (bp.text || '(no readable text)');
              if (!image && !hasPlaywright()) {
                result += '\n\n(Engine not installed — this page was read as plain text. '
                  + 'Open the REACH Browser (globe button in the chat header) and click '
                  + '“Install browser engine” for full rendering and page snapshots.)';
              }
            } else if (action === 'websearch') {
              const query = String(msg.query || '').slice(0, 200);
              if (!query) throw new Error('no search query');
              const found = await searchAndFetch(query, 5, 2);
              const out = [];
              (found.results || []).forEach((r, i) => {
                out.push('[' + (i + 1) + '] ' + r.title + ' — ' + r.url
                  + ((r.snippet || '') ? '\n    ' + r.snippet : ''));
              });
              (found.pages || []).forEach((p) => {
                out.push('\nExcerpt from ' + p.title + ' (' + p.url + '):\n' + String(p.text).slice(0, 4000));
              });
              result = out.join('\n') || '(no results)';
            } else {
              throw new Error('unknown action: ' + action);
            }
            this._post('toolResult', { uid, ok: true, result: String(result).slice(0, 40000), image });
          } catch (e) {
            this._post('toolResult', { uid, ok: false, error: String((e && e.message) || e) });
          }
          break;
        }
        case 'runCode': {
          const code = String(msg.code || '').slice(0, 4000);
          if (!code) break;
          const ok = await vscode.window.showWarningMessage(
            'REACH will run this in the integrated terminal:\n\n' + code.slice(0, 500),
            { modal: true },
            'Run', 'Cancel');
          if (ok !== 'Run') break;
          const term = vscode.window.createTerminal('REACH Run');
          term.show(true);
          term.sendText(code);
          break;
        }
        case 'pickFiles': {
          const wantImages = msg.kind === 'images';
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: wantImages ? 'Attach Images' : 'Attach Files',
            filters: wantImages
              ? { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }
              : undefined,
          });
          if (!uris || !uris.length) break;
          const items = [];
          for (const u of uris) {
            try {
              const stat = await vscode.workspace.fs.stat(u);
              const ext = (u.path.split('.').pop() || '').toLowerCase();
              const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext);
              const name = vscode.workspace.asRelativePath(u, false).split(/[\\/]/).pop()
                || u.path.split(/[\\/]/).pop() || 'file';
              const bytes = await vscode.workspace.fs.readFile(u);
              if (isImage) {
                if (stat.size > 5 * 1024 * 1024) {
                  items.push({ name, error: 'image too large (>5MB)' });
                  continue;
                }
                const mime = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
                items.push({
                  name, size: stat.size, kind: 'image', mime,
                  dataUrl: 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64'),
                });
              } else {
                if (stat.size > 200 * 1024) {
                  items.push({ name, error: 'text file too large (>200KB)' });
                  continue;
                }
                const text = Buffer.from(bytes).toString('utf8');
                if (text.indexOf('\uFFFD') !== -1) {
                  items.push({ name, error: 'binary file — not attachable' });
                  continue;
                }
                items.push({ name, size: stat.size, kind: 'text', content: text.slice(0, 200 * 1024) });
              }
            } catch (e) {
              items.push({ name: u.path.split(/[\\/]/).pop() || 'file', error: String((e && e.message) || e) });
            }
          }
          this._post('pickedFiles', { items });
          break;
        }
        default:
          break;
      }
    });
  }

  _post(type, payload) {
    if (this._view) this._view.webview.postMessage({ type, ...payload });
  }

  _workspaceState() {
    const folders = vscode.workspace.workspaceFolders || [];
    this._post('workspaceState', {
      files: openTextDocuments().length,
      workspaceFolders: folders.length,
      roots: folders.map((f) => f.uri.fsPath),
    });
  }

  async _workspaceSearch(pattern) {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) return 'No workspace folder open.';
    const folder = folders[0];
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'), `{${TREE_EXCLUDES.join(',')}}`, 300);
    const needle = pattern.toLowerCase();
    const out = [];
    let scanned = 0;
    for (const f of files) {
      if (scanned >= 120 || out.length >= 40) break;
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8');
        scanned += 1;
        const lines = text.split('\n');
        for (let idx = 0; idx < lines.length; idx += 1) {
          if (lines[idx].toLowerCase().includes(needle)) {
            out.push(relativePath(f) + ':' + (idx + 1) + ': ' + lines[idx].trim().slice(0, 160));
            if (out.length >= 40) break;
          }
        }
      } catch (e) { /* skip unreadable files */ }
    }
    return out.length ? out.join('\n') : 'No matches for "' + pattern + '" (scanned ' + scanned + ' files).';
  }

  async _workspaceList(subPath) {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) return 'No workspace folder open.';
    const folder = folders[0];
    const base = subPath ? vscode.Uri.joinPath(folder.uri, subPath) : folder.uri;
    const out = [];
    const walk = async (uri, depth, prefix) => {
      if (depth > 3 || out.length >= 250) return;
      let entries;
      try { entries = await vscode.workspace.fs.readDirectory(uri); } catch (e) { return; }
      for (const [name, type] of entries) {
        if (out.length >= 250) return;
        if (EXCLUDED_NAMES.includes(name)) continue;
        out.push(prefix + name + (type === vscode.FileType.Directory ? '/' : ''));
        if (type === vscode.FileType.Directory) await walk(vscode.Uri.joinPath(uri, name), depth + 1, prefix + '  ');
      }
    };
    await walk(base, 0, '');
    return out.length ? out.join('\n') : '(empty directory)';
  }

  _authHeaders(extra) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    const { accessKey } = config();
    if (accessKey) headers.Authorization = `Bearer ${accessKey}`;
    return headers;
  }

  async _fetchModels() {
    const { endpoint } = config();
    try {
      const resp = await fetch(`${endpoint}/models`, { headers: this._authHeaders() });
      if (!resp.ok) {
        this._post('error', { message: `HTTP ${resp.status} loading models — is the REACH relay running?` });
        return;
      }
      const data = await resp.json();
      const ids = (data && data.data || []).map((m) => m.id);
      if (!ids.length) {
        this._post('error', { message: 'Endpoint returned no models.' });
        return;
      }
      // Prefer SimpleREACH-owned aliases (unprefixed ids); fall back to the full list.
      const reachIds = ids.filter((id) => !id.includes('/'));
      this._post('models', { models: reachIds.length ? reachIds : ids, endpoint });
    } catch (err) {
      this._post('error', { message: `Could not reach ${endpoint}: ${err.message}` });
    }
  }

  /* WhisperThink: a private reasoning pass whose output is never shown in
   * the chat flow — it only steers the final answer. Returns text or null. */
  async _think(prompt, includeWorkspace, chatModel) {
    const { endpoint, thinkModel, thinkMaxTokens, contextMaxKb } = config();
    const model = thinkModel || chatModel || 'gpt-4o-mini';
    let system = 'You are SimpleREACH — the private reasoning engine of the REACH coding assistant inside VS Code. '
      + 'The user just asked a question. Think step-by-step about the best answer: '
      + 'what matters most, which of the open files are relevant, what structure the '
      + 'reply should take, and any pitfalls. Be terse — a few short lines, no filler. '
      + 'Your output is NEVER shown to the user; it only guides the final answer.';
    if (includeWorkspace) {
      const docs = openTextDocuments();
      const treeLines = await buildTreeLines();
      system += '\n\n' + buildContextBlock(docs, treeLines).slice(0, contextMaxKb * 512);
    }
    const payload = {
      model,
      max_tokens: thinkMaxTokens,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
    try {
      const resp = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify(payload),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const choice = data && data.choices && data.choices[0];
      const text = choice && choice.message && choice.message.content;
      return (text && text.trim()) || null;
    } catch (err) {
      return null; // thinking must never block the answer
    }
  }

  /* Turn a user question into a short web-search query (model-assisted with
   * a heuristic fallback — must never block the request). */
  async _deriveQuery(prompt, chatModel) {
    const { endpoint } = config();
    const clean = prompt.replace(/\s+/g, ' ').trim().slice(0, 500);
    try {
      const resp = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify({
          model: chatModel || 'gpt-4o-mini',
          max_tokens: 30,
          stream: false,
          messages: [
            { role: 'system', content: 'Convert the user question into ONE short web search query (max 8 words). Reply with the query only.' },
            { role: 'user', content: clean },
          ],
        }),
      });
      if (!resp.ok) throw new Error('bad status');
      const data = await resp.json();
      const q = data && data.choices && data.choices[0]
        && data.choices[0].message && data.choices[0].message.content;
      if (q && q.trim().length >= 3) return q.replace(/^["']+|["']+$/g, '').trim().slice(0, 120);
    } catch (e) { /* fall through to heuristic */ }
    return clean.replace(/[^\w\s-]/g, ' ').split(/\s+/).slice(0, 10).join(' ');
  }

  async _chat(body) {
    const { endpoint, maxTokens, workspaceContext, contextMaxKb, think, webSearch, searchResults, playwright, agentic } = config();
    const messages = Array.isArray(body.messages) ? body.messages.slice() : [];
    // ---- WhisperThink: private reasoning before the answer ----
    let thought = null;
    if (body.think && think) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser) {
        this._post('thinking', {});
        thought = await this._think(lastUser.content, body.includeWorkspace, body.model);
        if (thought) {
          this._post('thought', { text: thought });
        }
      }
    }
    // ---- web search: fresh results injected as grounded context ----
    if (body.webSearch && webSearch) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser) {
        try {
          const query = await this._deriveQuery(lastUser.content, body.model);
          const { results, pages } = await searchAndFetch(query, searchResults, 2);
          if (results.length || pages.length) {
            const block = [];
            block.push('Web search results (fresh, may change daily):');
            results.forEach((r, i) => {
              block.push(`[${i + 1}] ${r.title} — ${r.url}${r.snippet ? '\n    ' + r.snippet : ''}`);
            });
            pages.forEach((p) => {
              block.push(`\nExcerpt from ${p.title} (${p.url}):\n${p.text.slice(0, 4000)}`);
            });
            const searchMsg = {
              role: 'system',
              content: block.join('\n'),
            };
            const existingSystem = messages.findIndex((m) => m.role === 'system');
            if (existingSystem >= 0) {
              messages[existingSystem] = {
                role: 'system',
                content: messages[existingSystem].content + '\n\n' + searchMsg.content,
              };
            } else {
              messages.unshift(searchMsg);
            }
            this._post('searchInfo', {
              query,
              results: results.length,
              pages: pages.length,
              playwright: playwright && hasPlaywright(),
            });
          }
        } catch (e) { /* search must never block the answer */ }
      }
    }
    // ---- workspace context injection ----
    if (body.includeWorkspace && workspaceContext) {
      const docs = openTextDocuments();
      const treeLines = await buildTreeLines();
      const contextBlock = buildContextBlock(docs, treeLines).slice(0, contextMaxKb * 1024);
      const contextMsg = {
        role: 'system',
        content: 'You are SimpleREACH, the REACH coding assistant inside VS Code. Below is the current '
          + 'workspace context — files they have open. Use it to ground answers; '
          + 'never invent file contents.\n\n' + contextBlock,
      };
      const existingSystem = messages.findIndex((m) => m.role === 'system');
      if (existingSystem >= 0) {
        messages[existingSystem] = {
          role: 'system',
          content: messages[existingSystem].content + '\n\n' + contextMsg.content,
        };
      } else {
        messages.unshift(contextMsg);
      }
      this._post('contextInfo', {
        files: docs.length,
        chars: contextBlock.length,
      });
    }
    // ---- agentic mode: the model proposes file edits as fenced JSON blocks ----
    if (body.agentic && agentic) {
      messages.unshift({
        role: 'system',
        content: 'You are SimpleREACH, an agentic coding assistant inside VS Code with live workspace access. '
          + 'The workspace roots, file tree and the contents of the user\'s open files are provided '
          + 'in the workspace context above. When the user asks you to change or create files, act '
          + 'like an agent: briefly explain what you will do, then emit each file change as a fenced '
          + 'JSON block — one ```edit block per file, like this:\n'
          + '```edit\n{"path": "relative/path/in/workspace", "search": "exact existing text", "replace": "new text"}\n```\n'
          + 'Rules: path is relative to the workspace root, forward slashes. "search" must be a small '
          + 'exact snippet of the current file; use "" as search to create a brand-new file with the '
          + 'full content in "replace". Emit multiple blocks for multiple edits. Only emit blocks when '
          + 'the change is clear — otherwise ask. The user sees each block as a diff and can accept or '
          + 'reject it, so never claim a file was already changed; you only propose edits.\n'
          + 'You may also inspect the workspace first by emitting tool blocks and then STOPPING — the '
          + 'tool results are handed back to you and you continue from there:\n'
          + '```tool\n{"action": "read", "path": "relative/path"}\n```\n'
          + '```tool\n{"action": "search", "pattern": "text to find"}\n```\n'
          + '```tool\n{"action": "list", "path": ""}\n```\n'
          + '```tool\n{"action": "shell", "command": "npm test"}\n```\n'
          + '```tool\n{"action": "browse", "url": "https://example.com"}\n```\n'
          + '```tool\n{"action": "websearch", "query": "latest news"}\n```\n'
          + 'Actions: "read" reads one file, "search" greps the whole workspace for a pattern, "list" '
          + 'prints a directory tree (empty path = workspace root), "shell" runs a command in the '
          + 'integrated terminal (the user must approve it first — you cannot see its output), "browse" '
          + 'opens a web page in a browser (reads its text and shows a snapshot), "websearch" searches the '
          + 'web and reads the top pages. Use them '
          + 'when you need to see files that are not already in the context, then finish with edit '
          + 'blocks for the actual changes.',
      });
    }
    // ---- private reasoning steering (hidden from the visible flow) ----
    if (thought) {
      const steerMsg = {
        role: 'system',
        content: '[Private reasoning — never mention or repeat this. It guides your '
          + 'answer only.]\n' + thought,
      };
      const existingSystem = messages.findIndex((m) => m.role === 'system');
      if (existingSystem >= 0) {
        messages[existingSystem] = {
          role: 'system',
          content: messages[existingSystem].content + '\n\n' + steerMsg.content,
        };
      } else {
        messages.unshift(steerMsg);
      }
    }
    const payload = Object.assign({}, body, {
      max_tokens: maxTokens || 2048,
      messages,
    });
    const url = `${endpoint}/chat/completions`;
    const controller = new AbortController();
    this._controller = controller;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text();
        this._post('error', { message: `HTTP ${resp.status}: ${text.slice(0, 300)}` });
        this._post('done', {});
        return;
      }
      if (payload.stream) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const chunk = line.slice(5).trim();
            if (chunk === '[DONE]') continue;
            try {
              const parsed = JSON.parse(chunk);
              const delta = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
              const text = delta && (delta.content || delta.reasoning_content);
              if (text) this._post('delta', { text });
            } catch (e) { /* keepalive / partial chunk */ }
          }
        }
        this._post('done', {});
      } else {
        const data = await resp.json();
        const choice = data && data.choices && data.choices[0];
        this._post('done', { full: (choice && choice.message && choice.message.content) || '' });
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        this._post('done', { aborted: true });
      } else {
        this._post('error', { message: String((err && err.message) || err) });
        this._post('done', {});
      }
    } finally {
      this._controller = null;
    }
  }

  _html(webview) {
    const nonce = getNonce();
    const mediaUri = (name) => webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', name)).toString();
    const htmlPath = path.join(this._extensionUri.fsPath, 'media', 'chat.html');
    const template = fs.readFileSync(htmlPath, 'utf8');
    return template
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{styleUri\}\}/g, mediaUri('style.css'))
      .replace(/\{\{scriptUri\}\}/g, mediaUri('chat.js'));
  }
}

/* ---- REACH Browser: right-click "Add element to chat (REACH)" ----
 * The VS Code Integrated/Simple Browser context menus are owned by VS Code
 * core (native Electron menu) — extensions cannot add items to them. So REACH
 * ships its own browser panel: pages are fetched and rendered with scripts
 * disabled, which lets us own the right-click menu and read the element the
 * user right-clicked (elementFromPoint), then send it to the REACH chat. */

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';

async function fetchPageHtml(rawUrl, timeoutMs = 15000) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Enter an http(s) URL.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    let html = await resp.text();
    if (html.length > 2.5 * 1024 * 1024) html = html.slice(0, 2.5 * 1024 * 1024);
    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = titleM
      ? String(titleM[1]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : url;
    return { ok: true, url: resp.url || url, title: title.slice(0, 120), html };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function browserHtml(extensionUri, webview) {
  const nonce = getNonce();
  const mediaUri = (name) => webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', name)).toString();
  const htmlPath = path.join(extensionUri.fsPath, 'media', 'browser.html');
  const template = fs.readFileSync(htmlPath, 'utf8');
  return template
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{styleUri\}\}/g, mediaUri('browser.css'))
    .replace(/\{\{scriptUri\}\}/g, mediaUri('browser.js'));
}

function activate(context) {
  const provider = new ReachChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposedProvider),
    vscode.window.registerWebviewViewProvider('reach.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('simplereach.openChat', () => {
      vscode.commands.executeCommand('reach.chat.focus');
    }),
    vscode.commands.registerCommand('simplereach.reload', () => {
      if (provider._view) provider._post('reload', {});
    }),
  );

  /* ---- right-click selection actions (CodeGPT-style) ---- */

  const postPrompt = (text) => {
    vscode.commands.executeCommand('reach.chat.focus');
    provider._post('startPrompt', { text });
  };

  const buildPrompt = (instruction) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('REACH: open a file first.');
      return null;
    }
    const sel = editor.selection;
    const hasSel = !!(sel && !sel.isEmpty);
    const code = hasSel ? editor.document.getText(sel) : editor.document.getText();
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    const lang = editor.document.languageId;
    return 'File: ' + rel + ' (' + lang + ')\n'
      + (hasSel ? 'Selected code' : 'File contents (no selection)') + ':\n'
      + '```' + lang + '\n' + code.slice(0, 12000) + '\n```\n\n' + instruction;
  };

  const SELECTION_ACTIONS = {
    explainSelection: 'Explain what this code does, clearly and concisely.',
    refactorSelection: 'Refactor this code to be cleaner and more idiomatic while preserving behavior. If agent mode is on, propose the changes as edit blocks.',
    fixSelection: 'Find and fix bugs in this code. Explain each issue; if agent mode is on, propose the fixes as edit blocks.',
    commentSelection: 'Add clear, concise comments to this code. If agent mode is on, propose them as edit blocks.',
    testSelection: 'Write focused unit tests for this code. If agent mode is on, propose them as edit blocks.',
    optimizeSelection: 'Optimize this code for performance and explain the tradeoffs. If agent mode is on, propose the changes as edit blocks.',
  };

  for (const [cmd, instruction] of Object.entries(SELECTION_ACTIONS)) {
    context.subscriptions.push(vscode.commands.registerCommand('simplereach.' + cmd, () => {
      const prompt = buildPrompt(instruction);
      if (prompt) postPrompt(prompt);
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand('simplereach.askSelection', () => {
    const prompt = buildPrompt('');
    if (prompt) postPrompt(prompt);
  }));

  // ---- REACH Browser panel ----
  let browserPanel = null;
  const browserState = { history: [], index: -1 };

  // Send the picked element to the REACH chat panel (focuses it first).
  const reachBrowserAddElement = (data) => {
    const text = String((data && data.text) || '').trim();
    if (!text) return;
    postPrompt('Add this element from the browser page'
      + (data.url ? ' (' + String(data.url).slice(0, 500) + ')' : '')
      + (data.title ? ' — page: "' + String(data.title).slice(0, 120) + '"' : '')
      + ' to our context:\n\n' + text.slice(0, 8000));
  };

  const browserPost = (type, payload) => {
    if (browserPanel) browserPanel.webview.postMessage(Object.assign({ type }, payload || {}));
  };

  const browserGo = async (url, push) => {
    const res = await fetchPageHtml(url);
    if (!browserPanel) return;
    if (!res.ok) {
      browserPost('pageError', { url, error: res.error });
      return;
    }
    if (push) {
      browserState.history = browserState.history.slice(0, browserState.index + 1);
      browserState.history.push({ url: res.url, title: res.title });
      browserState.index = browserState.history.length - 1;
    }
    browserPanel.title = 'REACH Browser — ' + res.title.slice(0, 40);
    browserPost('page', {
      url: res.url, title: res.title, html: res.html,
      canBack: browserState.index > 0,
      canForward: browserState.index < browserState.history.length - 1,
    });
  };

  const browserGoBack = () => {
    if (browserState.index <= 0) return;
    browserState.index -= 1;
    browserGo(browserState.history[browserState.index].url, false);
  };
  const browserGoForward = () => {
    if (browserState.index >= browserState.history.length - 1) return;
    browserState.index += 1;
    browserGo(browserState.history[browserState.index].url, false);
  };

  const openReachBrowser = () => {
    if (browserPanel) { browserPanel.reveal(); return; }
    browserPanel = vscode.window.createWebviewPanel(
      'reach.browser', 'REACH Browser',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      });
    browserPanel.webview.html = browserHtml(context.extensionUri, browserPanel.webview);
    browserPanel.onDidDispose(() => { browserPanel = null; });
    browserState.history = [];
    browserState.index = -1;
    browserPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg && msg.type) {
        case 'ready':
          // Reply to the panel's ready ping — the earlier state post may have
          // fired before the webview script attached its listener.
          browserPost('state', {
            url: '', canBack: browserState.index > 0,
            canForward: browserState.index < browserState.history.length - 1,
            engine: hasPlaywright(),
          });
          break;
        case 'navigate':
          await browserGo(String(msg.url || ''), msg.push !== false);
          break;
        case 'back':
          browserGoBack();
          break;
        case 'forward':
          browserGoForward();
          break;
        case 'reload':
          if (browserState.index >= 0) {
            await browserGo(browserState.history[browserState.index].url, false);
          }
          break;
        case 'openExternal':
          try {
            await vscode.env.openExternal(vscode.Uri.parse(String(msg.url || '')));
          } catch (e) { /* ignore */ }
          break;
        case 'addElement':
          reachBrowserAddElement(msg);
          break;
        case 'installBrowser':
          browserPost('installProgress', { stage: 'npm', line: 'Starting…' });
          {
            const res = await installBrowserEngine(context.extensionUri.fsPath, (stage, all) => {
              const lines = String(all || '').split('\n').map((l) => l.trim()).filter(Boolean);
              browserPost('installProgress', { stage, line: (lines[lines.length - 1] || '').slice(0, 160) });
            });
            browserPost('installDone', { ok: !!res.ok, error: res.error || null, engine: hasPlaywright() });
          }
          break;
        default:
          break;
      }
    });
    browserPost('state', { url: '', canBack: false, canForward: false, engine: hasPlaywright() });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('simplereach.openBrowser', openReachBrowser),
  );

  // Right-click in the REACH Browser (or an external caller with a payload)
  // -> send the page element/selection to the REACH chat.
  context.subscriptions.push(vscode.commands.registerCommand('simplereach.addElementToChat', async (arg) => {
    if (arg && (arg.content || arg.text)) {
      reachBrowserAddElement({ text: arg.content || arg.text, url: arg.url, title: arg.title });
      return;
    }
    const clip = await vscode.env.clipboard.readText().catch(() => '');
    let text = (clip || '').trim();
    if (!text) {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.selection && !ed.selection.isEmpty) text = ed.document.getText(ed.selection).trim();
    }
    if (!text) {
      vscode.window.showInformationMessage('REACH: select or copy page text first, then try again.');
      return;
    }
    reachBrowserAddElement({ text, url: '' });
  }));

  // The Copilot system tray starts with the extension (no-op when it is
  // already running); the chat panel's tray icon reflects the live state.
  startTray().catch(() => {});
}

function deactivate() {
  // Close the shared headless browser so no Chromium lingers after reload.
  disposeBrowser().catch(() => {});
}

module.exports = { activate, deactivate };
