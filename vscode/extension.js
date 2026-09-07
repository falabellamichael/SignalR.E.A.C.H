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
  };
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

  async _chat(body) {
    const { endpoint, maxTokens } = config();
    const payload = Object.assign({}, body, { max_tokens: maxTokens || 2048 });
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
