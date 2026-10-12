'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHmac } = require('node:crypto');
const { createCliSettingsBridge, MAX_BODY_BYTES, SCOPE_FIELDS } = require('../agent/cli-settings-bridge.cjs');

async function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-cli-settings-test-'));
  const discoveryFile = path.join(root, 'studio-bridge.json');
  const state = { settings: {
    schemaVersion: 1, pageLayout: 'page-sized', reachCli: '', jevEnabled: false,
    jevApiKey: 'fixture-jev-private', activeConnection: 'provider',
    connections: [{ id: 'provider', name: 'Provider', endpoint: 'https://example.invalid/v1',
      accessKey: 'fixture-provider-private', model: 'model', enabled: true }],
    mcpServers: [
      { name: 'stdio', transport: 'stdio', command: 'node', args: ['server.js'], env: { API_KEY: 'fixture-env-private' } },
      { name: 'http', transport: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer fixture-header-private' } },
    ],
  }, calls: [] };
  const handlers = {
    'settings.save': ({ patch }) => { state.calls.push(patch); const clean = { ...patch }; delete clean.settingsRevision; delete clean.settingsScope; state.settings = { ...state.settings, ...clean }; return { ok: true }; },
    'connections.models': params => ({ ok: true, models: ['model'], ...params }),
    'mcp.status': () => ({ ok: true, servers: state.settings.mcpServers }),
    'conversations.get': () => ({ id: 'chat', name: 'Chat', dir: '/tmp/project', model: '',
      settings: { approvals: 'prompt', reviewEdits: true, budgetOverrides: { maxRounds: 20 }, maxTokens: 8192, maxRounds: 9 },
      messages: [{ content: 'private conversation text' }], pendingEdits: { content: 'private diff' } }),
    ...overrides,
  };
  const getRevision = (settings, scope = '') => {
    const snapshot = SCOPE_FIELDS[scope] ? Object.fromEntries(SCOPE_FIELDS[scope].filter(key => own(settings, key)).map(key => [key, settings[key]])) : settings;
    return createHmac('sha256', 'isolated-test-fixture').update(JSON.stringify([scope, snapshot])).digest('hex');
  };
  const getRevisions = settings => Object.fromEntries(Object.keys(SCOPE_FIELDS).map(scope => [scope, getRevision(settings, scope)]));
  const bridge = createCliSettingsBridge({ getSettings: () => state.settings, getRevision, getRevisions, handlers, discoveryFile, env: {} });
  const descriptor = await bridge.start();
  function request(method, params = {}, options = {}) {
    const data = options.raw || JSON.stringify({ method, params });
    return new Promise((resolve, reject) => {
      const req = http.request(descriptor.url + (options.path || '/call'), {
        method: options.method || 'POST', headers: { Authorization: 'Bearer ' + descriptor.token,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...options.headers },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject); req.end(data);
    });
  }
  return { ...state, state, root, discoveryFile, bridge, descriptor, request,
    cleanup() { bridge.stop(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('discovery is authenticated loopback and cleanup preserves a newer instance', async () => {
  const f = await fixture();
  try {
    const saved = JSON.parse(fs.readFileSync(f.discoveryFile, 'utf8'));
    assert.equal(saved.version, 1);
    assert.match(saved.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(saved.token, /^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.discoveryFile).mode & 0o777, 0o600);
    fs.writeFileSync(f.discoveryFile, JSON.stringify({ ...saved, token: 'new-instance' }));
    f.bridge.stop();
    assert.equal(JSON.parse(fs.readFileSync(f.discoveryFile, 'utf8')).token, 'new-instance');
  } finally { f.cleanup(); }
});

test('settings results expose configuration and secret references without saved secrets', async () => {
  const f = await fixture();
  try {
    const response = await f.request('settings.get');
    assert.equal(response.status, 200);
    const settings = response.body.result;
    assert.equal(settings.connections[0].hasAccessKey, true);
    assert.equal(settings.jevKeySource, 'saved');
    assert.deepEqual(settings.mcpServers[0].envKeys, ['API_KEY']);
    assert.deepEqual(settings.mcpServers[1].headerKeys, ['Authorization']);
    assert.ok(settings.themeOptions.some(theme => theme.id === 'dark' && theme.name === 'Dark'));
    const text = JSON.stringify(response.body);
    for (const secret of ['fixture-jev-private', 'fixture-provider-private', 'fixture-env-private', 'fixture-header-private']) assert.equal(text.includes(secret), false);
    assert.equal(own(settings.connections[0], 'accessKey'), false);
    assert.equal(own(settings.mcpServers[0], 'env'), false);
    assert.equal(own(settings.mcpServers[1], 'headers'), false);
  } finally { f.cleanup(); }
});
const own = (value, key) => Object.hasOwn(value, key);

test('omitted connection keys and MCP secrets survive edits and renames', async () => {
  const f = await fixture();
  try {
    const result = await f.request('settings.save', { patch: {
      connections: [{ id: 'provider', name: 'Renamed', endpoint: 'https://other.invalid/v1', model: 'new', enabled: true }],
      mcpServers: [
        { id: 'stdio', name: 'stdio-renamed', transport: 'stdio', command: 'node', args: ['changed.js'] },
        { id: 'http', name: 'http-renamed', transport: 'http', url: 'https://other.invalid/mcp' },
      ],
    } });
    assert.equal(result.body.result.ok, true);
    assert.equal(f.state.settings.connections[0].accessKey, 'fixture-provider-private');
    assert.deepEqual(f.state.settings.mcpServers[0].env, { API_KEY: 'fixture-env-private' });
    assert.deepEqual(f.state.settings.mcpServers[1].headers, { Authorization: 'Bearer fixture-header-private' });
    assert.equal(JSON.stringify(result.body).includes('fixture-'), false);
  } finally { f.cleanup(); }
});

test('collection edits restore masked projections while short secrets leave routing identifiers intact', async () => {
  const f = await fixture();
  try {
    f.state.settings.jevApiKey = 'a';
    f.state.settings.activeConnection = 'key-provider';
    f.state.settings.connections = [
      { id: 'key-provider', name: 'Monkey', endpoint: 'https://monkey.invalid/v1?access_token=legacy-private', model: 'monkey-model', accessKey: 'key', enabled: true },
      { id: 'other', name: 'Other', endpoint: 'https://other.invalid/v1', model: 'other-model', accessKey: '', enabled: true },
    ];
    f.state.settings.mcpServers = [
      { name: 'monkey-server', transport: 'stdio', command: 'monkey-command', args: ['--monkey-folder=/tmp/monkey'], cwd: '/tmp/monkey', env: { API_KEY: 'key' }, enabled: true },
      { name: 'legacy-http', transport: 'http', url: 'https://example.invalid/mcp?access_token=legacy-private', headers: { Authorization: 'Bearer fixture-header-private' }, enabled: true },
    ];
    const originalConnections = structuredClone(f.state.settings.connections);
    const originalServers = structuredClone(f.state.settings.mcpServers);
    const before = (await f.request('settings.get')).body.result;
    assert.equal(before.connections[0].id, 'key-provider');
    assert.equal(before.activeConnection, 'key-provider');
    assert.equal(before.mcpServers[0].id, 'monkey-server');
    assert.equal(before.mcpServers[0].transport, 'stdio');
    assert.match(before.connections[0].name, /redacted/);
    assert.match(before.mcpServers[0].args[0], /redacted/);
    const connections = before.connections.map(({ hasAccessKey, ...row }) => row);
    connections[1].enabled = false;
    const mcpServers = before.mcpServers.map(({ envKeys, headerKeys, ...row }) => row);
    mcpServers[1].enabled = false;
    const saved = await f.request('settings.save', { patch: { settingsRevision: before.settingsRevision, connections, mcpServers } });
    assert.equal(saved.status, 200);
    assert.deepEqual(f.state.settings.connections[0], originalConnections[0]);
    for (const key of ['name', 'command', 'args', 'cwd', 'env']) assert.deepEqual(f.state.settings.mcpServers[0][key], originalServers[0][key]);
    assert.equal(f.state.settings.mcpServers[1].url, originalServers[1].url);
    assert.deepEqual(f.state.settings.mcpServers[1].headers, originalServers[1].headers);
    assert.equal(f.state.settings.connections[1].enabled, false);
    assert.equal(f.state.settings.mcpServers[1].enabled, false);
    assert.equal((await f.request('settings.save', { patch: { mcpServers: [
      { id: 'legacy-http', name: 'legacy-http', transport: 'http', url: 'https://changed.invalid/mcp?access_token=new-private' },
    ] } })).status, 400);
  } finally { f.cleanup(); }
});

test('existing rows permit omitted ordinary fields while explicit empty secrets still clear', async () => {
  const f = await fixture();
  try {
    const saved = await f.request('settings.save', { patch: {
      connections: [{ id: 'provider', accessKey: '' }],
      mcpServers: [{ id: 'stdio', env: {} }, { id: 'http', headers: {} }],
    } });
    assert.equal(saved.status, 200);
    assert.equal(f.state.settings.connections[0].endpoint, 'https://example.invalid/v1');
    assert.equal(f.state.settings.connections[0].accessKey, '');
    assert.equal(f.state.settings.mcpServers[0].command, 'node');
    assert.deepEqual(f.state.settings.mcpServers[0].env, {});
    assert.equal(f.state.settings.mcpServers[1].url, 'https://example.invalid/mcp');
    assert.deepEqual(f.state.settings.mcpServers[1].headers, {});
  } finally { f.cleanup(); }
});

test('renaming an MCP server to an existing name fails before losing either configuration', async () => {
  const f = await fixture();
  try {
    const before = (await f.request('settings.get')).body.result;
    const servers = before.mcpServers.map(({ envKeys, headerKeys, ...row }) => row);
    servers[1].name = servers[0].name;
    const result = await f.request('settings.save', { patch: { mcpServers: servers } });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /unique/);
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.settings.mcpServers[1].name, 'http');
  } finally { f.cleanup(); }
});

test('explicit secret clearing is distinct from omission', async () => {
  const f = await fixture();
  try {
    const row = f.state.settings.connections[0];
    const result = await f.request('settings.save', { patch: { connections: [{ ...row, accessKey: '' }],
      mcpServers: [{ name: 'stdio', transport: 'stdio', command: 'node', env: {} }] } });
    assert.equal(result.body.result.ok, true);
    assert.equal(f.state.settings.connections[0].accessKey, '');
    assert.deepEqual(f.state.settings.mcpServers[0].env, {});
  } finally { f.cleanup(); }
});

test('optimistic revisions reject stale saves and return a fresh revision without persisting it', async () => {
  const f = await fixture();
  try {
    const initial = (await f.request('settings.get')).body.result.settingsRevision;
    assert.match(initial, /^[0-9a-f]{64}$/);
    const changed = await f.request('settings.save', { patch: { reachCli: '/new/compiler', settingsRevision: initial } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.body.result.settingsRevision, initial);
    assert.equal(own(f.state.settings, 'settingsRevision'), false);
    const stale = await f.request('settings.save', { patch: { reachCli: '/old/compiler', settingsRevision: initial } });
    assert.equal(stale.status, 400);
    assert.match(stale.body.error, /Reload/);
    assert.equal(f.state.settings.reachCli, '/new/compiler');
    assert.equal(f.state.calls.length, 1);
  } finally { f.cleanup(); }
});

test('the final, active-pool, and managed connection guards match Studio controls', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('settings.save', { patch: { connections: [] } })).status, 400);
    assert.equal((await f.request('settings.save', { patch: { connections: [{ ...f.state.settings.connections[0], enabled: false }] } })).status, 400);
    f.state.settings.connections.push({ id: 'reach_hosted', name: 'REACH service', endpoint: 'https://reach.invalid/v1', model: '', enabled: true });
    assert.equal((await f.request('settings.save', { patch: { connections: [f.state.settings.connections[0]] } })).status, 400);
    assert.equal(f.state.calls.length, 0);
  } finally { f.cleanup(); }
});

test('scoped drafts survive unrelated settings saves and still reject changes within their section', async () => {
  const f = await fixture();
  try {
    const before = (await f.request('settings.get')).body.result;
    await f.request('settings.save', { patch: { pageLayout: 'full-width', settingsRevision: before.settingsRevision } });
    const connection = await f.request('settings.save', { patch: { settingsScope: 'connection',
      settingsRevision: before.settingsRevisions.connection, reachCli: '/new/compiler' } });
    assert.equal(connection.status, 200);
    assert.notEqual(connection.body.result.settingsRevision, before.settingsRevisions.connection);
    assert.equal(connection.body.result.settingsRevisions.mcp, before.settingsRevisions.mcp);
    const stale = await f.request('settings.save', { patch: { settingsScope: 'connection',
      settingsRevision: before.settingsRevisions.connection, reachCli: '/old/compiler' } });
    assert.equal(stale.status, 400);
    const leaked = await f.request('settings.save', { patch: { settingsScope: 'mcp',
      settingsRevision: before.settingsRevisions.mcp, reachCli: '/outside/scope' } });
    assert.equal(leaked.status, 400);
    assert.equal(f.state.settings.reachCli, '/new/compiler');
    assert.equal(own(f.state.settings, 'settingsScope'), false);
  } finally { f.cleanup(); }
});

test('wrong or missing tokens, browser origins, and invalid Hosts are rejected', async () => {
  const f = await fixture();
  try {
    for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer invalid' },
      { Origin: 'https://example.invalid' }, { Origin: '' }, { Host: 'example.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const response = await f.request('settings.get', {}, { headers });
      assert.equal(response.status, 403);
      assert.equal(response.body.ok, false);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
    assert.equal(f.state.calls.length, 0);
  } finally { f.cleanup(); }
});

test('unknown routes, dispatch methods, excessive bodies, and malformed payloads fail closed', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('settings.get', {}, { path: '/ipc' })).status, 404);
    assert.equal((await f.request('settings.get', {}, { method: 'GET' })).status, 404);
    assert.equal((await f.request('agents:delete', { id: 'chat' })).status, 400);
    assert.equal((await f.request('settings.get', {}, { raw: '{broken' })).status, 400);
    assert.equal((await f.request('settings.get', {}, { raw: '{"method":"settings.get","params":false}' })).status, 400);
    assert.equal((await f.request('settings.get', {}, { raw: 'x'.repeat(MAX_BODY_BYTES + 1) })).status, 413);
    assert.equal((await f.request('settings.save', { patch: { arbitraryScript: 'exec' } })).status, 400);
    assert.equal(f.state.calls.length, 0);
  } finally { f.cleanup(); }
});

test('budget validation gives safe range errors and disabled MCP servers stay stopped', async () => {
  const f = await fixture({ 'mcp.test': () => { throw new Error('Must not start'); } });
  try {
    const invalid = await f.request('settings.save', { patch: { budgets: { contextTarget: 1 } } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /8000/);
    f.state.settings.mcpServers[0].enabled = false;
    const disabled = await f.request('mcp.test', { id: 'stdio' });
    assert.equal(disabled.status, 400);
    assert.match(disabled.body.error, /Enable/);
  } finally { f.cleanup(); }
});

test('invalid URLs, MCP values, themes and conversation controls cannot reach handlers', async () => {
  const f = await fixture({ 'theme.set': () => { throw new Error('Must not reach handler'); } });
  try {
    const invalid = [
      ['settings.save', { patch: { connections: [{ endpoint: 'https://user:secret@example.invalid/v1' }] } }],
      ['settings.save', { patch: { mcpServers: [{ name: 'server', transport: 'http', url: 'file:///private' }] } }],
      ['settings.save', { patch: { mcpServers: [{ name: 'server', transport: 'http', url: 'https://example.invalid/mcp?access_token=private' }] } }],
      ['settings.save', { patch: { mcpServers: [{ name: 'server', transport: 'http', url: 'https://example.invalid', headers: { Authorization: 'value\r\nInjected: header' } }] } }],
      ['theme.set', { theme: 'javascript:run()' }],
      ['conversations.update', { id: 'chat', patch: { settings: { approvals: 'execute-all' } } }],
    ];
    for (const [method, params] of invalid) assert.equal((await f.request(method, params)).status, 400);
    assert.equal(f.state.calls.length, 0);
  } finally { f.cleanup(); }
});

test('MCP transport changes retain only fields and credential references for the selected transport', async () => {
  const f = await fixture();
  try {
    const result = await f.request('settings.save', { patch: { mcpServers: [
      { id: 'stdio', name: 'stdio', transport: 'http', url: 'https://example.invalid/mcp', command: 'node', args: ['old.js'], cwd: '/old' },
      { id: 'http', name: 'http', transport: 'stdio', command: 'node', args: ['new.js'], url: 'https://example.invalid/old' },
    ] } });
    assert.equal(result.status, 200);
    assert.equal(own(f.state.settings.mcpServers[0], 'env'), false);
    assert.equal(own(f.state.settings.mcpServers[0], 'command'), false);
    assert.deepEqual(f.state.settings.mcpServers[0].headers, {});
    assert.equal(own(f.state.settings.mcpServers[1], 'headers'), false);
    assert.equal(own(f.state.settings.mcpServers[1], 'url'), false);
    assert.deepEqual(f.state.settings.mcpServers[1].env, {});
  } finally { f.cleanup(); }
});

test('conversation settings never expose message history or pending edits', async () => {
  const f = await fixture();
  try {
    const result = await f.request('conversations.get', { id: 'chat' });
    assert.equal(result.body.result.id, 'chat');
    assert.equal(result.body.result.settings.budgetOverrides.maxRounds, 20);
    assert.equal(result.body.result.settings.maxTokens, 8192);
    assert.equal(result.body.result.settings.maxRounds, 9);
    assert.equal(JSON.stringify(result.body).includes('private conversation'), false);
    assert.equal(own(result.body.result, 'pendingEdits'), false);
  } finally { f.cleanup(); }
});

test('service errors and returned errors do not disclose saved or submitted keys', async () => {
  const f = await fixture({
    'connections.models': () => ({ ok: false, err: 'Failed with Bearer fixture-provider-private and fixture-env-private' }),
    'theme.set': () => { throw new Error('fixture-jev-private'); },
  });
  try {
    const result = await f.request('connections.models');
    assert.equal(JSON.stringify(result.body).includes('fixture-provider-private'), false);
    assert.equal(JSON.stringify(result.body).includes('fixture-env-private'), false);
    const thrown = await f.request('theme.set', { theme: 'dark' });
    assert.equal(thrown.status, 500);
    assert.equal(JSON.stringify(thrown.body).includes('fixture-jev-private'), false);
  } finally { f.cleanup(); }
});
