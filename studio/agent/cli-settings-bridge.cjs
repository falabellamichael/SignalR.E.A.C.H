'use strict';

// Narrow, authenticated loopback access to Studio's existing settings services.
// The CLI never opens the encrypted profile itself or dispatches arbitrary IPC.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { atomicWriteJson } = require('./atomic-write.cjs');
const { sanitizeMcpServers, isMcpToolName } = require('./mcp.cjs');
const { validateBudgets } = require('./budgets.cjs');

const MAX_BODY_BYTES = 256 * 1024;
const METHODS = new Set(['settings.get', 'settings.save', 'budget.schema', 'connections.models',
  'connections.test', 'mcp.status', 'mcp.test', 'mcp.tools', 'mcp.call', 'conversations.list', 'conversations.get',
  'conversations.update', 'engines.report', 'theme.set']);
const SCOPE_FIELDS = {
  connection: ['connections', 'activeConnection', 'reachCli', 'jevEnabled', 'jevAutoMode', 'jevApiKey', 'jevApiKeyAction'],
  mcp: ['mcpServers'], budgeting: ['budgets'],
};
const own = (value, key) => Object.hasOwn(value, key);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const credentialQuery = key => /(?:^|[_-])(?:api[-_]?key|access[-_]?token|token|secret|password|auth|authorization|credentials?|signature|sig)(?:$|[_-])/i.test(key);
function fail(message) { const error = new Error(message); error.bridgeValidation = true; throw error; }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unsupported settings fields.');
}
function string(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(`Invalid ${label}.`);
}
function boolean(value) { if (typeof value !== 'boolean') fail('Expected true or false.'); }
function budgets(value) { try { validateBudgets(value); } catch (error) { fail(error.message); } }
function id(value) { string(value, 96, 'identifier', true); }
function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) if (credentialQuery(key)) url.searchParams.set(key, '[redacted]');
    return url.href.replace(/\/$/, '');
  } catch { return '[invalid endpoint]'; }
}
function url(value, label) {
  string(value, 2048, label, true);
  let parsed;
  try { parsed = new URL(value); } catch { fail(`Invalid ${label}.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(`${label} must use HTTP(S) without embedded credentials.`);
  if ([...parsed.searchParams.keys()].some(credentialQuery)) fail(`${label} must not contain credentials in query parameters. Use an access key or header.`);
}
function pairs(value, kind) {
  if (!object(value) || Object.keys(value).length > 128) fail(`Invalid MCP ${kind}.`);
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`Invalid MCP ${kind} key.`);
    if (kind === 'environment' ? !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) : !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(key)) fail(`Invalid MCP ${kind} key.`);
    string(entry, kind === 'environment' ? 4096 : 512, `MCP ${kind} value`);
    if (kind === 'headers' && /[\r\n]/.test(entry)) fail('Invalid MCP header value.');
  }
}
function validatePatch(patch, savedSettings) {
  // The first pass checks structure only: displayed strings may contain
  // redaction markers. Validate their final values after restoring projections.
  const complete = savedSettings !== undefined;
  keys(patch, ['settingsScope', 'settingsRevision', 'connections', 'activeConnection', 'reachCli', 'jevEnabled', 'jevAutoMode', 'jevApiKey', 'jevApiKeyAction', 'pageLayout', 'budgets', 'mcpServers']);
  if (own(patch, 'settingsScope')) {
    if (!own(SCOPE_FIELDS, patch.settingsScope)) fail('Invalid settings scope.');
    keys(patch, ['settingsScope', 'settingsRevision', ...SCOPE_FIELDS[patch.settingsScope]]);
  }
  if (own(patch, 'settingsRevision') && !/^[0-9a-f]{64}$/.test(patch.settingsRevision)) fail('Invalid settings revision. Reload Settings before saving.');
  for (const key of ['jevEnabled', 'jevAutoMode']) if (own(patch, key)) boolean(patch[key]);
  if (own(patch, 'reachCli')) string(patch.reachCli, complete ? 4096 : MAX_BODY_BYTES, 'compiler path');
  if (own(patch, 'jevApiKey')) string(patch.jevApiKey, 4096, 'Jev key');
  if (own(patch, 'jevApiKeyAction') && patch.jevApiKeyAction !== 'clear') fail('Invalid Jev key action.');
  if (own(patch, 'pageLayout') && !['page-sized', 'full-width'].includes(patch.pageLayout)) fail('Invalid page layout.');
  if (own(patch, 'activeConnection')) string(patch.activeConnection, 64, 'connection identifier');
  if (own(patch, 'budgets')) budgets(patch.budgets);
  if (own(patch, 'connections')) {
    if (!Array.isArray(patch.connections) || patch.connections.length > 20) fail('Choose at most 20 connections.');
    const endpoints = new Set(), ids = new Set();
    for (const row of patch.connections) {
      keys(row, ['id', 'name', 'endpoint', 'accessKey', 'model', 'enabled']);
      if (own(row, 'id')) string(row.id, 64, 'connection identifier');
      if (row.id) { if (ids.has(row.id)) fail('Connection identifiers must be unique.'); ids.add(row.id); }
      if (own(row, 'name')) string(row.name, complete ? 60 : MAX_BODY_BYTES, 'connection name');
      if (own(row, 'endpoint')) string(row.endpoint, complete ? 2048 : MAX_BODY_BYTES, 'connection URL', true);
      if (complete) {
        const previous = savedSettings.connections?.find(entry => entry.id === row.id);
        if (!previous || row.endpoint !== previous.endpoint) url(row.endpoint, 'connection URL');
        const endpoint = row.endpoint.trim().replace(/\/+$/, '');
        if (endpoints.has(endpoint)) fail('Connections must have different endpoints.');
        endpoints.add(endpoint);
      }
      if (own(row, 'accessKey')) string(row.accessKey, 4096, 'access key');
      if (own(row, 'model')) string(row.model, complete ? 200 : MAX_BODY_BYTES, 'model');
      if (own(row, 'enabled')) boolean(row.enabled);
    }
  }
  if (own(patch, 'mcpServers')) {
    if (!Array.isArray(patch.mcpServers) || patch.mcpServers.length > 20) fail('Choose at most 20 MCP servers.');
    const savedServers = complete ? sanitizeMcpServers(savedSettings.mcpServers) : [];
    const names = new Set(), ids = new Set();
    for (const row of patch.mcpServers) {
      keys(row, ['id', 'name', 'enabled', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers']);
      if (own(row, 'id')) string(row.id, 64, 'MCP identifier');
      if (row.id) { if (ids.has(row.id)) fail('MCP identifiers must be unique.'); ids.add(row.id); }
      if (own(row, 'name')) string(row.name, complete ? 64 : MAX_BODY_BYTES, 'MCP server name');
      if (complete && (typeof row.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(row.name))) fail('Invalid MCP server name.');
      if (complete) { if (names.has(row.name)) fail('MCP server names must be unique.'); names.add(row.name); }
      if (own(row, 'enabled')) boolean(row.enabled);
      if ((complete || own(row, 'transport')) && !['stdio', 'http'].includes(row.transport)) fail('Invalid MCP transport.');
      if (own(row, 'url')) string(row.url, complete ? 2048 : MAX_BODY_BYTES, 'MCP URL');
      if (own(row, 'command')) string(row.command, complete ? 256 : MAX_BODY_BYTES, 'MCP command');
      if (own(row, 'args') && (!Array.isArray(row.args) || row.args.length > 32 || row.args.some(arg => typeof arg !== 'string' || arg.length > (complete ? 1024 : MAX_BODY_BYTES)))) fail('Invalid MCP arguments.');
      if (own(row, 'cwd')) string(row.cwd, complete ? 1024 : MAX_BODY_BYTES, 'MCP working directory');
      if (own(row, 'headers')) pairs(row.headers, 'headers');
      if (own(row, 'env')) pairs(row.env, 'environment');
      if (complete) {
        const previous = savedServers.find(entry => row.id ? entry.id === row.id : entry.name === row.name);
        if (row.transport === 'http') {
          if (!previous || row.url !== previous.url) url(row.url, 'MCP URL');
        } else string(row.command, 256, 'MCP command', true);
      }
    }
  }
}
function hydratePatch(patch, settings, { env = process.env, token = '', themeOptions = [] } = {}) {
  const secretSettings = { ...settings, jevApiKey: settings.jevApiKey || env.TYPESAFE_API_KEY || '' };
  const projected = redact(publicSettings(settings, env, themeOptions), secretSettings, {}, token);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function restore(row, previous, display, fields) {
    const out = { ...row };
    if (previous) for (const field of fields) {
      if (!own(row, field) || display && equal(row[field], display[field])) {
        if (own(previous, field)) out[field] = previous[field];
        else delete out[field];
      }
    }
    return out;
  }
  const next = { ...patch };
  if (own(patch, 'reachCli') && equal(patch.reachCli, projected.reachCli)) next.reachCli = settings.reachCli;
  if (patch.connections) {
    if (settings.connections?.length && !patch.connections.length) fail('At least one connection must remain.');
    const managed = settings.connections?.find(row => row.id === 'reach_hosted');
    if (managed && !patch.connections.some(row => row.id === managed.id)) fail('Manage the REACH service connection from Home.');
    next.connections = patch.connections.map(row => {
      const previous = (settings.connections || []).find(entry => entry.id === row.id);
      const display = projected.connections.find(entry => entry.id === row.id);
      const out = restore(row, previous, display, ['name', 'endpoint', 'model', 'enabled']);
      if (row.id === 'reach_hosted' && previous && (out.name !== previous.name || out.endpoint !== previous.endpoint || own(row, 'accessKey') && row.accessKey !== previous.accessKey)) fail('Manage the REACH service connection from Home.');
      return { ...out, accessKey: own(row, 'accessKey') ? row.accessKey : previous?.accessKey || '' };
    });
    const activeId = patch.activeConnection ?? settings.activeConnection;
    const active = next.connections.find(row => row.id === activeId);
    if (active?.enabled === false) fail('The active connection must remain in the team pool.');
    if (patch.activeConnection && !active) fail('Active connection not found.');
  } else if (patch.activeConnection && !settings.connections?.some(row => row.id === patch.activeConnection)) fail('Active connection not found.');
  if (patch.mcpServers) {
    const saved = sanitizeMcpServers(settings.mcpServers);
    next.mcpServers = patch.mcpServers.map(row => {
      let previous = saved.find(entry => row.id ? entry.id === row.id : entry.name === row.name);
      if (!previous && !row.id) {
        const matches = projected.mcpServers.filter(entry => entry.name === row.name);
        if (matches.length > 1) fail('Use the MCP server identifier to edit a masked server name.');
        if (matches.length === 1) previous = saved.find(entry => entry.id === matches[0].id);
      }
      if (row.id && !previous) fail('MCP server not found. Reload Settings before saving.');
      const display = previous && projected.mcpServers.find(entry => entry.id === previous.id);
      const out = restore(row, previous, display, ['name', 'enabled', 'transport', 'command', 'args', 'cwd', 'url']);
      if (previous) out.id = previous.id;
      if (out.transport === 'stdio') {
        if (!own(row, 'env')) out.env = previous?.env || {};
        delete out.url; delete out.headers;
      } else {
        if (!own(row, 'headers')) out.headers = previous?.headers || {};
        delete out.command; delete out.args; delete out.env; delete out.cwd;
      }
      return out;
    });
  }
  return next;
}
function publicMcp(row) {
  return { id: row.id, name: row.name, enabled: row.enabled !== false, transport: row.transport,
    command: row.command || '', args: row.args || [], cwd: row.cwd || '', url: safeUrl(row.url),
    envKeys: Object.keys(row.env || {}), headerKeys: Object.keys(row.headers || {}),
    ...(row.status ? { status: row.status, stale: !!row.stale, tools: typeof row.tools === 'number' ? row.tools : (row.tools || []).length,
      toolNames: row.toolNames || [], latencyMs: row.latencyMs || 0, checkedAt: row.checkedAt || 0,
      error: row.error ? 'MCP connection failed. Check the server configuration and Studio logs.' : '' } : {}) };
}
function publicConversation(row) {
  if (!row) return null;
  const settings = row.settings || {};
  return { id: row.id, name: row.name, dir: row.dir, model: row.model || '', connectionId: row.connectionId || '',
    createdAt: row.createdAt, updatedAt: row.updatedAt, conversationRevision: row.conversationRevision,
    settings: { approvals: settings.approvals || 'prompt', reviewEdits: settings.reviewEdits !== false,
      jevAutoMode: settings.jevAutoMode, budgetOverrides: settings.budgetOverrides || null,
      ...Object.fromEntries(['maxTokens', 'maxRounds'].filter(key => Number.isSafeInteger(settings[key]) && settings[key] >= 0).map(key => [key, settings[key]])) } };
}
function publicSettings(settings, env = process.env, themeOptions = []) {
  const out = {};
  for (const key of ['schemaVersion', 'pageLayout', 'reachCli', 'jevEnabled', 'jevAutoMode', 'budgets', 'theme', 'accent', 'tint', 'credentialStorage', 'activeConnection', 'model']) if (own(settings, key)) out[key] = settings[key];
  out.connections = (settings.connections || []).map(row => ({ id: row.id, name: row.name,
    endpoint: safeUrl(row.endpoint), model: row.model || '', enabled: row.enabled !== false, hasAccessKey: !!row.accessKey }));
  out.mcpServers = sanitizeMcpServers(settings.mcpServers).map(publicMcp);
  out.themeOptions = themeOptions.map(theme => ({ id: theme.id, name: theme.name }));
  out.jevKeyConfigured = !!(settings.jevApiKey || env.TYPESAFE_API_KEY);
  out.jevKeySource = settings.jevApiKey ? 'saved' : env.TYPESAFE_API_KEY ? 'environment' : '';
  return out;
}
function redact(value, settings, params = {}, token = '') {
  const secrets = new Set(token ? [token] : []);
  function collect(node, secret = false) {
    if (typeof node === 'string') { if (secret && node) secrets.add(node); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) collect(item, secret || ['accessKey', 'jevApiKey', 'env', 'headers'].includes(key));
  }
  collect(settings); collect(params);
  function walk(node) {
    if (typeof node === 'string') {
      let out = node;
      for (const secret of secrets) out = out.split(secret).join('[redacted]');
      return out.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
    }
    if (Array.isArray(node)) return node.map(walk);
    if (object(node)) return Object.fromEntries(Object.entries(node).filter(([key]) => !['accessKey', 'jevApiKey', 'encryptedAccessKey', 'encryptedJevApiKey', 'env', 'headers'].includes(key)).map(([key, item]) => [key,
      // IDs, schema enums and opaque revision tokens are routing data. A short
      // credential substring must never turn a valid identifier into a mask.
      ['id', 'activeConnection', 'connectionId', 'settingsScope', 'settingsRevision', 'settingsRevisions', 'conversationRevision',
        'transport', 'status', 'approvals', 'theme', 'scheme', 'pageLayout', 'jevKeySource', 'type', 'group',
        'themeOptions', 'envKeys', 'headerKeys', 'toolNames'].includes(key) ? item : walk(item)]));
    return node;
  }
  return walk(value);
}
function validateParams(method, params, themeOptions) {
  if (!object(params)) fail('Method parameters must be an object.');
  if (method === 'settings.save') { keys(params, ['patch']); validatePatch(params.patch); }
  else if (['connections.models', 'connections.test'].includes(method)) { keys(params, ['connectionId']); if (own(params, 'connectionId')) id(params.connectionId); }
  else if (['mcp.test', 'conversations.get'].includes(method)) { keys(params, ['id']); id(params.id); }
  else if (method === 'mcp.call') {
    keys(params, ['name', 'arguments']);
    if (typeof params.name !== 'string' || !isMcpToolName(params.name)) fail('Invalid MCP tool name.');
    if (!object(params.arguments)) fail('MCP arguments must be an object.');
  }
  else if (method === 'conversations.update') {
    keys(params, ['id', 'patch']); id(params.id); keys(params.patch, ['conversationRevision', 'name', 'model', 'settings']);
    if (own(params.patch, 'conversationRevision') && !/^[0-9a-f]{64}$/.test(params.patch.conversationRevision)) fail('Invalid conversation revision. Reload the conversation before saving.');
    if (own(params.patch, 'name')) string(params.patch.name, 80, 'conversation name');
    if (own(params.patch, 'model')) string(params.patch.model, 200, 'conversation model');
    if (own(params.patch, 'settings')) {
      const settings = params.patch.settings;
      keys(settings, ['approvals', 'reviewEdits', 'budgetOverrides', 'jevAutoMode']);
      if (own(settings, 'approvals') && !['prompt', 'auto-read', 'auto-all'].includes(settings.approvals)) fail('Invalid approval mode.');
      for (const key of ['reviewEdits', 'jevAutoMode']) if (own(settings, key)) boolean(settings[key]);
      if (settings.budgetOverrides != null) budgets(settings.budgetOverrides);
    }
  } else if (method === 'theme.set') {
    keys(params, ['theme', 'accent', 'tint']);
    if (own(params, 'theme') && !themeOptions.some(theme => theme.id === params.theme)) fail('Invalid theme.');
    if (own(params, 'accent') && params.accent !== '' && !/^#[0-9a-fA-F]{6}$/.test(params.accent)) fail('Invalid accent color.');
    if (own(params, 'tint') && (!Number.isInteger(params.tint) || params.tint < 0 || params.tint > 100)) fail('Tint must be a whole number from 0 to 100.');
  } else keys(params, []);
}

function createCliSettingsBridge({ getSettings, getRevision, getRevisions, handlers, themeOptions = [], discoveryFile = path.join(os.homedir(), '.config', 'reach-cli', 'studio-bridge.json'), env = process.env }) {
  const token = randomBytes(32).toString('hex');
  let server = null, descriptor = null;
  async function dispatch(method, params) {
    if (!METHODS.has(method)) fail('Unsupported settings method.');
    validateParams(method, params, themeOptions);
    const settings = getSettings();
    const secretSettings = { ...settings, jevApiKey: settings.jevApiKey || env.TYPESAFE_API_KEY || '' };
    if (method === 'settings.get') return redact({ ...publicSettings(settings, env, themeOptions),
      ...(getRevision ? { settingsRevision: getRevision(settings) } : {}),
      ...(getRevisions ? { settingsRevisions: getRevisions(settings) } : {}) }, secretSettings, params, token);
    if (method === 'settings.save' && params.patch.settingsRevision && getRevision && params.patch.settingsRevision !== getRevision(settings, params.patch.settingsScope || '')) fail('Settings changed in another window or the CLI. Reload this Settings panel before saving.');
    if (method === 'mcp.test') {
      const server = sanitizeMcpServers(settings.mcpServers).find(row => row.id === params.id);
      if (!server) fail('MCP server not found.');
      if (!server.enabled) fail('Enable the MCP server before testing it.');
    }
    if (typeof handlers[method] !== 'function') fail('This Studio version does not support that settings action. Restart an updated Studio.');
    let result;
    if (method === 'settings.save') {
      const patch = hydratePatch(params.patch, settings, { env, token, themeOptions });
      validatePatch(patch, settings);
      // MCP ids select the saved source during hydration/validation, while the
      // canonical persisted id remains derived from its configured name.
      if (patch.mcpServers) patch.mcpServers = patch.mcpServers.map(({ id: savedId, ...row }) => row);
      result = await handlers[method]({ ...params, patch });
    }
    else result = await handlers[method](params);
    if (method === 'settings.save' && result?.ok !== false && getRevision) result = { ...result,
      settingsRevision: getRevision(getSettings(), params.patch.settingsScope || ''),
      ...(getRevisions ? { settingsRevisions: getRevisions(getSettings()) } : {}) };
    if (method === 'mcp.status') result = { ...result, servers: (result.servers || []).map(publicMcp) };
    if (method === 'mcp.test') result = { ...result, status: result.status ? publicMcp(result.status) : null };
    if (method === 'conversations.list') result = (result || []).map(publicConversation);
    if (method === 'conversations.get') result = publicConversation(result);
    if (method === 'conversations.update' && result.agent) result = { ...result, agent: publicConversation(result.agent) };
    if (method === 'connections.models' && result.endpoint) result = { ...result, endpoint: safeUrl(result.endpoint) };
    if (result?.err && !/^(HTTP \d{3}|No endpoint configured(?: in Settings)?\.|Agent not found|MCP server not found\.)$/.test(result.err)) {
      result = { ...result, err: 'The settings action failed. Check the configuration in Studio.' };
    }
    return redact(result, secretSettings, params, token);
  }
  function cleanup() {
    try { if (JSON.parse(fs.readFileSync(discoveryFile, 'utf8')).token === token) fs.unlinkSync(discoveryFile); } catch { /* another instance may own it */ }
  }
  async function start() {
    if (descriptor) return descriptor;
    server = http.createServer(async (request, response) => {
      const reply = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(payload)); };
      const denied = () => reply(403, { ok: false, error: 'Settings bridge authentication failed.' });
      if (request.headers.host !== `127.0.0.1:${server?.address()?.port}` || own(request.headers, 'origin') || own(request.headers, 'sec-fetch-site')) return denied();
      const expected = Buffer.from('Bearer ' + token);
      const received = Buffer.from(request.headers.authorization || '');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return denied();
      if (request.method !== 'POST' || request.url !== '/call') return reply(404, { ok: false, error: 'Unknown settings route.' });
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return reply(415, { ok: false, error: 'Send application/json.' });
      if (Number(request.headers['content-length'] || 0) > MAX_BODY_BYTES) return reply(413, { ok: false, error: 'Settings request is too large.' });
      const chunks = []; let size = 0, tooLarge = false;
      try {
        for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY_BYTES) { tooLarge = true; break; } chunks.push(chunk); }
        if (tooLarge) return reply(413, { ok: false, error: 'Settings request is too large.' });
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { ok: false, error: 'Invalid settings JSON.' }); }
        keys(input, ['method', 'params']);
        const result = await dispatch(input.method, own(input, 'params') ? input.params : {});
        reply(200, { ok: true, result });
      } catch (error) {
        // Provider/process exceptions can contain response bodies or command
        // arguments. Only our own validation messages cross this boundary.
        const message = error.bridgeValidation ? error.message : 'The settings action failed. Check Studio settings and logs.';
        reply(error.bridgeValidation ? 400 : 500, { ok: false, error: message });
      }
    });
    server.requestTimeout = 20000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    descriptor = { version: 1, url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid };
    try {
      fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
      atomicWriteJson(discoveryFile, descriptor); fs.chmodSync(discoveryFile, 0o600);
    } catch (error) { cleanup(); await new Promise(resolve => server.close(resolve)); descriptor = null; throw error; }
    server.unref();
    return descriptor;
  }
  function stop() {
    cleanup(); descriptor = null;
    if (server) { server.close(); server.closeAllConnections?.(); server = null; }
  }
  return { start, stop };
}
module.exports = { createCliSettingsBridge, publicSettings, hydratePatch, MAX_BODY_BYTES, METHODS, SCOPE_FIELDS };
