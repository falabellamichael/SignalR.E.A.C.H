/* SimpleREACH — VS Code extension.
 * Side-panel chat over the REACH OpenAI-compatible endpoint.
 * No dependencies: network I/O happens here in the extension host (Node 18+ fetch),
 * the webview only renders. Streaming is relayed as postMessage deltas.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

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
    model: String(cfg.get('model') || 'gpt-4o'),
    maxTokens: Number(cfg.get('maxTokens') || 2048),
    workspaceContext: cfg.get('workspaceContext') !== false,
    contextMaxKb: Math.max(8, Number(cfg.get('contextMaxKb') || 120)),
    think: cfg.get('think') !== false,
    thinkModel: String(cfg.get('thinkModel') || ''),
    thinkMaxTokens: Math.max(64, Number(cfg.get('thinkMaxTokens') || 512)),
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
    if (depth > 3) continue;          // keep the tree shallow
    lines.push('  '.repeat(Math.max(0, depth)) + rel.split(/[\\/]/).pop());
    count += 1;
  }
  return lines;
}

function buildContextBlock(files, treeLines) {
  const parts = [];
  parts.push('Workspace context (files open in VS Code):');
  if (treeLines && treeLines.length) {
    parts.push('Workspace tree:');
    parts.push(treeLines.slice(0, 80).join('\n'));
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
          this._post('workspaceState', {
            files: openTextDocuments().length,
            workspaceFolders: (vscode.workspace.workspaceFolders || []).length,
          });
          break;
        case 'abort':
          if (this._controller) this._controller.abort();
          break;
        default:
          break;
      }
    });
  }

  _post(type, payload) {
    if (this._view) this._view.webview.postMessage({ type, ...payload });
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
    const model = thinkModel || chatModel || 'gpt-4o';
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

  async _chat(body) {
    const { endpoint, maxTokens, workspaceContext, contextMaxKb, think } = config();
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
}

function deactivate() {}

module.exports = { activate, deactivate };
