/* SimpleREACH — VS Code extension.
 * Side-panel chat over the REACH OpenAI-compatible endpoint.
 * No dependencies: network I/O happens here in the extension host (Node 18+ fetch),
 * the webview only renders. Streaming is relayed as postMessage deltas.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { webSearchDdg, searchAndFetch, hasPlaywright } = require('./search');

const CONFIG_SECTION = 'simplereach';

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
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
            } else {
              throw new Error('unknown action: ' + action);
            }
            this._post('toolResult', { uid, ok: true, result: String(result).slice(0, 40000) });
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
    let system = 'You are the PRIVATE reasoning engine of an AI assistant inside VS Code. '
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
              playwright: playwright && hasPlaywright,
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
        content: 'You are assisting the user inside VS Code. Below is the current '
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
        content: 'You are an agentic coding assistant inside VS Code with live workspace access. '
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
          + 'Actions: "read" reads one file, "search" greps the whole workspace for a pattern, "list" '
          + 'prints a directory tree (empty path = workspace root), "shell" runs a command in the '
          + 'integrated terminal (the user must approve it first — you cannot see its output). Use them '
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

function activate(context) {
  const provider = new ReachChatViewProvider(context.extensionUri);
  context.subscriptions.push(
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
}

function deactivate() {}

module.exports = { activate, deactivate };
