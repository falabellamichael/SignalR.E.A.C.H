'use strict';

/* Reach Studio — Model Context Protocol (MCP) client runtime.
 *
 * Stdlib only: spawns configured servers and speaks JSON-RPC 2.0 over
 * stdio (newline-delimited or LSP Content-Length framing) or MCP's
 * Streamable HTTP transport. The module is Electron-free and every side
 * effect (spawn, fetch) is injectable, so tests can drive a real server
 * in-process without any network.
 *
 * Trust model: an MCP server is a third-party process. Its tool results
 * are untrusted data — the agent layer wraps them exactly like any other
 * tool output, and a server that fails or hangs can only time out, never
 * take a run with it.
 */

const { spawn } = require('node:child_process');

const MAX_MCP_SERVERS = 20;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MCP_PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'reach-studio', version: '1.0.0' };
const DEFAULT_HANDSHAKE_MS = 10000;
const DEFAULT_CALL_MS = 60000;

/* A server id is a lowercase slug of its display name. Slugs only ever
 * contain [a-z0-9-], so the `__` separator in an exposed tool name is
 * unambiguous and `name.split('__', 1)` recovers the owning server. */
function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
  return base.slice(0, 48) || 'server';
}

/* Exposed tool name: `<server-slug>__<tool>`. Tool characters outside
 * [a-zA-Z0-9_] become underscores, so the separator survives any name. */
function mcpToolName(serverId, toolName) {
  const clean = String(toolName || '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return clean ? `${serverId}__${clean}` : '';
}

/* The only characters mcpToolName() can produce. The codec, the response
 * parser and the loop's dispatch all use this one predicate so a built-in
 * name (dotted, never `__`) can never be misrouted to the manager and an
 * unknown name can never sneak past validation. */
const MCP_TOOL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}__[A-Za-z0-9_]{1,64}$/;
function isMcpToolName(name) {
  return typeof name === 'string' && MCP_TOOL_NAME_RE.test(name);
}

/* Validate user-supplied server configs into a canonical array. Anything
 * that is not an object, has no usable name, or fails its transport's
 * required fields is dropped — the Settings form validates for the user,
 * but a hand-edited settings.json must never crash the manager. */
function sanitizeMcpServers(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if (out.length >= MAX_MCP_SERVERS) break;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > 64 || !NAME_RE.test(name)) continue;
    const entry = {
      id: slugify(name),
      name,
      enabled: raw.enabled !== false,
      transport: raw.transport === 'http' ? 'http' : 'stdio',
    };
    if (entry.transport === 'http') {
      let url = '';
      try {
        const parsed = new URL(typeof raw.url === 'string' ? raw.url : '');
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
      } catch { url = ''; }
      if (!url) continue;
      entry.url = url;
      entry.headers = {};
      if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
        for (const [key, value] of Object.entries(raw.headers)) {
          if (typeof key === 'string' && key.length >= 1 && key.length <= 64
              && typeof value === 'string' && value.length <= 512) entry.headers[key] = value;
        }
      }
    } else {
      const command = typeof raw.command === 'string' ? raw.command.trim() : '';
      if (!command || command.length > 256) continue;
      entry.command = command;
      entry.args = Array.isArray(raw.args)
        ? raw.args.filter(a => typeof a === 'string' && a.length >= 0 && a.length <= 1024).slice(0, 32)
        : [];
      entry.env = {};
      if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
        for (const [key, value] of Object.entries(raw.env)) {
          if (ENV_KEY_RE.test(key) && typeof value === 'string' && value.length <= 4096) entry.env[key] = value;
        }
      }
      entry.cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim().slice(0, 1024) : '';
    }
    out.push(entry);
  }
  // A duplicated name would make "route tool X to server Y" ambiguous. Keep
  // the first and re-key the rest deterministically, mirroring the
  // connection-id dedupe in connections.cjs.
  const seen = new Map();
  for (const entry of out) {
    const n = seen.get(entry.id) || 0;
    seen.set(entry.id, n + 1);
    if (n > 0) { entry.id = `${entry.id}-${n + 1}`; entry.name = `${entry.name}-${n + 1}`; }
  }
  return out;
}

function mcpErrorText(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) {
    return Number.isFinite(error.code) ? `MCP error ${error.code}: ${error.message}` : `MCP error: ${error.message}`;
  }
  return 'MCP error';
}

/* Flatten an MCP tools/call result to the text the model sees. Servers may
 * return content blocks, a plain string, or a bare object. */
function textContent(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map(part => (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') ? part.text : '')
      .filter(Boolean).join('\n');
  }
  return JSON.stringify(result);
}

/* Parse one SSE response body for the message matching our request id.
 * A Streamable HTTP answer may arrive as `data:` frames carrying several
 * messages; only the id-matched result matters to us. */
function parseSseResponse(text, id) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.startsWith('data:')) continue;
    let message;
    try { message = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (message && typeof message === 'object' && message.id === id) {
      if (message.error) throw new Error(mcpErrorText(message.error));
      return message.result;
    }
  }
  return undefined;
}

function combineSignal(timeoutMs, signal) {
  const parts = [AbortSignal.timeout(timeoutMs)];
  if (signal) parts.push(signal);
  return parts.length > 1 ? AbortSignal.any(parts) : parts[0];
}

/* JSON-RPC framing over a pair of streams. Auto-detects the transport the
 * first bytes imply: a bare `{` starts a newline-delimited JSON stream,
 * a `Content-Length:` header starts an LSP-style framed stream (used by
 * some servers that reuse LSP framing). One request at a time is NOT
 * required — pending responses are matched by id, so an early
 * notification never wedges a later answer. */
function createFramedChannel(readable, write) {
  const pending = new Map();
  let nextId = 1;
  let mode = null;       // null until the first non-blank byte decides
  let buf = '';
  let headers = null;    // lsp mode: header block being assembled
  let wantBody = 0;
  let body = '';
  let settled = false;

  function failAll(error) {
    if (settled) return;
    settled = true;
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  }
  function findHeaderEnd(text) {
    const crlf = text.indexOf('\r\n\r\n');
    if (crlf !== -1) return crlf + 4;
    const lf = text.indexOf('\n\n');
    if (lf !== -1) return lf + 2;
    return -1;
  }
  function handleMessage(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message && typeof message === 'object' && 'id' in message && message.id !== null && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(mcpErrorText(message.error)));
      else entry.resolve(message.result);
    }
    // Notifications (no id) are ignored: the settings flow only issues
    // requests that must be answered.
  }
  function feed(chunk) {
    if (settled) return;
    buf += chunk;
    for (;;) {
      if (mode === null) {
        const at = buf.search(/[^\s]/);
        if (at === -1) return;
        buf = buf.slice(at);
        if (!buf.length) return;
        if (buf.startsWith('{')) mode = 'line';
        else if (/^content-length:/i.test(buf)) mode = 'lsp';
        else { failAll(new Error('MCP server speaks an unsupported frame format.')); return; }
      }
      if (mode === 'line') {
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handleMessage(line);
        continue;
      }
      // lsp
      if (!headers) {
        const end = findHeaderEnd(buf);
        if (end === -1) return;
        headers = {};
        for (const line of buf.slice(0, end).split(/\r?\n/)) {
          const at = line.indexOf(':');
          if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
        }
        wantBody = Number(headers['content-length'] || 0);
        body = '';
        buf = buf.slice(end);
      }
      const need = wantBody - body.length;
      if (buf.length >= need) {
        body += buf.slice(0, need);
        buf = buf.slice(need);
        if (wantBody > 0) handleMessage(body);
        headers = null;
        wantBody = 0;
        body = '';
      } else return;
    }
  }
  function frame(text) {
    if (mode === 'lsp') return 'Content-Length: ' + Buffer.byteLength(text) + '\r\n\r\n' + text;
    return text + '\n';
  }
  function send(method, params, timeoutMs) {
    if (settled) return Promise.reject(new Error('MCP server connection closed.'));
    const id = nextId++;
    const entry = {};
    const promise = new Promise((resolve, reject) => {
      entry.timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      entry.resolve = value => { clearTimeout(entry.timer); resolve(value); };
      entry.reject = error => { clearTimeout(entry.timer); reject(error); };
    });
    pending.set(id, entry);
    try {
      write(frame(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} })));
    } catch (error) {
      pending.delete(id);
      entry.reject(error);
    }
    return promise;
  }
  function notify(method, params) {
    if (settled) return;
    try { write(frame(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }))); } catch { /* best effort */ }
  }
  readable.on('data', chunk => feed(chunk.toString('utf8')));
  readable.on('close', () => failAll(new Error('MCP server connection closed.')));
  readable.on('end', () => failAll(new Error('MCP server connection closed.')));
  readable.on('error', error => failAll(error));
  return {
    send,
    notify,
    close: () => failAll(new Error('MCP connection closed.')),
    _feedForTests: feed,
  };
}

function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Cancelled.'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

const INIT_PARAMS = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO };

function createStdioClient(server, deps = {}) {
  const spawnImpl = deps.spawn || spawn;
  const handshakeMs = deps.handshakeMs || DEFAULT_HANDSHAKE_MS;
  const callMs = deps.callMs || DEFAULT_CALL_MS;
  let serverInfo = null;
  let child;
  try {
    child = spawnImpl(server.command, server.args, {
      cwd: server.cwd || undefined,
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { kind: 'stdio', serverInfo: () => null, close: () => {}, _failed: String(error?.message || error) };
  }
  const startError = {};
  child.once('error', error => { startError.error = error; });
  const channel = createFramedChannel(child.stdout, text => {
    try { child.stdin.write(text); } catch { /* process is dying; pending requests time out */ }
  });
  child.stdout.on('error', () => {}); // a write failure must not crash main
  child.unref?.();
  return {
    kind: 'stdio',
    serverInfo: () => serverInfo,
    async initialize(signal) {
      if (startError.error) throw new Error(`Cannot start MCP server "${server.command}": ${startError.error.code === 'ENOENT' ? 'command not found' : startError.error.message}`);
      const result = await withSignal(channel.send('initialize', INIT_PARAMS, handshakeMs), signal);
      serverInfo = result?.serverInfo || null;
      channel.notify('notifications/initialized', {});
      return result;
    },
    async tools(signal) {
      return await withSignal(channel.send('tools/list', {}, callMs), signal);
    },
    async callTool(name, args, signal) {
      return await withSignal(channel.send('tools/call', { name, arguments: args || {} }, callMs), signal);
    },
    close() {
      try { child.stdin?.end?.(); } catch { /* ignore */ }
      try { child.kill?.(); } catch { /* ignore */ }
      channel.close();
    },
  };
}

function createHttpClient(server, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const handshakeMs = deps.handshakeMs || DEFAULT_HANDSHAKE_MS;
  const callMs = deps.callMs || DEFAULT_CALL_MS;
  const sessionHeader = {};
  let idCounter = 1;
  let serverInfo = null;
  const post = async (method, params, timeoutMs, signal) => {
    const body = { jsonrpc: '2.0', id: idCounter++, method, params: params || {} };
    let response;
    try {
      response = await fetchImpl(server.url, {
        method: 'POST',
        signal: combineSignal(timeoutMs, signal),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...server.headers,
          ...sessionHeader,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('Cancelled.');
      throw new Error(`MCP endpoint unreachable: ${error?.cause?.code || error?.message || error}`);
    }
    if (response.status === 202) return { result: undefined, headers: response.headers };
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`MCP endpoint returned HTTP ${response.status}${text ? ': ' + text.slice(0, 300) : ''}`);
    }
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const text = await response.text();
    if (!text.trim()) return { result: undefined, headers: response.headers };
    let result;
    if (type.includes('text/event-stream')) {
      result = parseSseResponse(text, body.id);
    } else {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const match = list.find(m => m && typeof m === 'object' && m.id === body.id);
      if (match && match.error) throw new Error(mcpErrorText(match.error));
      result = match ? match.result : undefined;
    }
    return { result, headers: response.headers };
  };
  return {
    kind: 'http',
    serverInfo: () => serverInfo,
    async initialize(signal) {
      const { result, headers } = await post('initialize', INIT_PARAMS, handshakeMs, signal);
      const sessionId = headers.get?.('mcp-session-id');
      if (sessionId) sessionHeader['mcp-session-id'] = sessionId;
      serverInfo = result?.serverInfo || null;
      return result;
    },
    async tools(signal) {
      return (await post('tools/list', {}, callMs, signal)).result;
    },
    async callTool(name, args, signal) {
      return (await post('tools/call', { name, arguments: args || {} }, callMs, signal)).result;
    },
    close() { /* stateless transport; nothing to release */ },
  };
}

function createMcpClient(server, deps = {}) {
  return server.transport === 'http' ? createHttpClient(server, deps) : createStdioClient(server, deps);
}

/* One manager per app instance. It owns the configured-server list (read
 * from settings on every access, so the Settings panel never needs to
 * push changes in), the per-server connection cache, and the status the
 * settings UI shows. Every public method is safe to call concurrently:
 * in-flight handshakes are de-duplicated per server. */
class McpManager {
  constructor({ getSettings, handshakeMs = DEFAULT_HANDSHAKE_MS, callMs = DEFAULT_CALL_MS, logger = null } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.handshakeMs = handshakeMs;
    this.callMs = callMs;
    this.logger = logger;
    this.clients = new Map();      // id -> live client
    this.inFlight = new Map();     // id -> handshake promise
    this.status = new Map();       // id -> { status, error, tools, latencyMs, checkedAt, serverInfo }
    this.lastConfigs = new Map();  // id -> JSON of the config that produced the status
  }
  configuredServers() {
    try { return sanitizeMcpServers((this.getSettings() || {}).mcpServers); }
    catch { return []; }
  }
  statusFor(id) {
    return this.status.get(id) || { status: 'unknown', error: '', tools: [], latencyMs: 0, checkedAt: 0 };
  }
  /* Drop connections and status for servers that are no longer configured —
   * a removed or renamed stdio server would otherwise leave its child process
   * running forever. Called from the two periodic reads (statusList for the
   * panel, toolDescriptors for agent runs). */
  pruneUnconfigured() {
    const ids = new Set(this.configuredServers().map(s => s.id));
    for (const [id, client] of this.clients) {
      if (!ids.has(id)) { try { client.close(); } catch { /* ignore */ } this.clients.delete(id); }
    }
    for (const id of this.status.keys()) if (!ids.has(id)) this.status.delete(id);
    for (const id of this.lastConfigs.keys()) if (!ids.has(id)) this.lastConfigs.delete(id);
  }
  statusList() {
    this.pruneUnconfigured();
    return this.configuredServers().map(server => {
      const st = this.statusFor(server.id);
      const checking = this.inFlight.has(server.id);
      // The row doubles as the Settings panel's draft source, so it carries the
      // full sanitized config — not just what the status pills need.
      return {
        id: server.id,
        name: server.name,
        enabled: server.enabled,
        transport: server.transport,
        command: server.command || '',
        args: server.args || [],
        env: server.env || {},
        cwd: server.cwd || '',
        url: server.url || '',
        headers: server.headers || {},
        status: checking ? 'checking' : st.status,
        /* True when the last handshake ran under a different config — an old
         * 'ok' next to edited values would be a lie, so the UI shows the row
         * as stale until it reconnects. */
        stale: !checking && this.lastConfigs.has(server.id) && this.lastConfigs.get(server.id) !== JSON.stringify(server),
        error: st.error || '',
        serverInfo: st.serverInfo || '',
        tools: (st.tools || []).length,
        toolNames: (st.tools || []).map(t => mcpToolName(server.id, t.name)).filter(Boolean),
        latencyMs: st.latencyMs || 0,
        checkedAt: st.checkedAt || 0,
      };
    });
  }
  /* Handshake (initialize + tools/list) if the server is unknown, its
   * config changed, or the previous attempt failed. Returns the status
   * row; never throws — a broken server shows 'error', it does not take
   * the settings panel or an agent run down with it. */
  async ensureLoaded(id, { force = false } = {}) {
    const server = this.configuredServers().find(s => s.id === id);
    if (!server) throw new Error('MCP server is no longer configured.');
    const signature = JSON.stringify(server);
    const current = this.statusFor(id);
    const stale = force
      || this.lastConfigs.get(id) !== signature
      || current.status === 'error'
      || current.status === 'unknown';
    if (!stale) return current;
    if (this.clients.has(id)) {
      try { this.clients.get(id).close(); } catch { /* ignore */ }
      this.clients.delete(id);
    }
    const running = this.inFlight.get(id);
    if (running) return await running;
    const promise = (async () => {
      const started = Date.now();
      this.status.set(id, { status: 'checking', error: '', tools: [], latencyMs: 0, checkedAt: 0 });
      const client = createMcpClient(server, { handshakeMs: this.handshakeMs, callMs: this.callMs });
      try {
        const init = await client.initialize();
        const toolsResult = await client.tools();
        this.clients.set(id, client);
        this.status.set(id, {
          status: 'ok',
          error: '',
          tools: Array.isArray(toolsResult?.tools) ? toolsResult.tools : [],
          latencyMs: Date.now() - started,
          checkedAt: Date.now(),
          serverInfo: (init?.serverInfo || client.serverInfo?.() || {}).name || '',
        });
      } catch (error) {
        try { client.close(); } catch { /* ignore */ }
        this.status.set(id, {
          status: 'error',
          error: String(error?.message || error),
          tools: [],
          latencyMs: Date.now() - started,
          checkedAt: Date.now(),
        });
      } finally {
        this.lastConfigs.set(id, signature);
      }
      return this.statusFor(id);
    })();
    this.inFlight.set(id, promise);
    try { return await promise; }
    finally { this.inFlight.delete(id); }
  }
  async test(id) {
    return await this.ensureLoaded(id, { force: true });
  }
  /* Flat descriptors for the agent loop's tool advertisement. A server
   * that fails to load is skipped, never fatal: the model simply does
   * not see its tools. */
  async toolDescriptors() {
    const out = [];
    this.pruneUnconfigured();
    for (const server of this.configuredServers()) {
      if (!server.enabled) continue;
      let status;
      try { status = await this.ensureLoaded(server.id); } catch { continue; }
      if (status.status !== 'ok') continue;
      for (const tool of status.tools || []) {
        const exposed = mcpToolName(server.id, tool?.name);
        if (!exposed) continue;
        out.push({
          name: exposed,
          description: String(tool?.description || `MCP tool ${tool?.name} (server ${server.name})`).slice(0, 1024),
          inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        });
      }
    }
    return out;
  }
  /* Execute one exposed tool. The name encodes the owning server
   * (`<slug>__<tool>`); the slug cannot contain `__` so the split is
   * unambiguous. Returns { ok, text | error } — the caller wraps it in
   * the standard untrusted-data tool result. */
  async callTool(toolName, args, { signal = null } = {}) {
    const name = String(toolName || '');
    const idx = name.indexOf('__');
    if (idx < 1 || idx === name.length - 2) return { ok: false, error: 'Not an MCP tool name.' };
    const slug = name.slice(0, idx);
    const tool = name.slice(idx + 2);
    const server = this.configuredServers().find(s => s.id === slug);
    if (!server) return { ok: false, error: `MCP server "${slug}" is not configured.` };
    if (!server.enabled) return { ok: false, error: `MCP server "${server.name}" is disabled in Settings → MCP.` };
    try {
      const status = await this.ensureLoaded(server.id);
      if (status.status === 'error') return { ok: false, error: `MCP server "${server.name}" is unavailable: ${status.error}` };
      const client = this.clients.get(server.id);
      if (!client) return { ok: false, error: `MCP server "${server.name}" is not connected.` };
      const result = await client.callTool(tool, args || {}, signal);
      const text = textContent(result);
      if (result && result.isError) return { ok: false, error: text || 'MCP tool returned an error.' };
      return { ok: true, text: text || '(no output)' };
    } catch (error) {
      // A failed call invalidates the connection so the next one reconnects
      // instead of reusing a dead pipe.
      try { this.clients.get(server.id)?.close(); } catch { /* ignore */ }
      this.clients.delete(server.id);
      const st = this.statusFor(server.id);
      if (st.status === 'ok') this.status.set(server.id, { ...st, status: 'error', error: String(error?.message || error) });
      return { ok: false, error: `MCP call failed: ${String(error?.message || error)}` };
    }
  }
  closeAll() {
    for (const client of this.clients.values()) {
      try { client.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.status.clear();
    this.lastConfigs.clear();
  }
}

module.exports = {
  MAX_MCP_SERVERS,
  MCP_PROTOCOL_VERSION,
  DEFAULT_HANDSHAKE_MS,
  DEFAULT_CALL_MS,
  slugify,
  mcpToolName,
  isMcpToolName,
  sanitizeMcpServers,
  mcpErrorText,
  textContent,
  parseSseResponse,
  createFramedChannel,
  createMcpClient,
  McpManager,
};
