'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHostedAccount, serviceUrl, browserUrl, publicAccount, MANAGED_ID } = require('../agent/hosted-account.cjs');
const { derive } = require('../renderer/account-view.js');
const TOKEN = 'fixture-session-token-never-expose-to-renderer';
const ADDRESS = '0x0000000000000000000000000000000000000001';
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-account-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'account.json'), key = crypto.randomBytes(32);
  const vault = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-vault',
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
    decryptString(data) { const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0,12)); d.setAuthTag(data.subarray(-16)); return Buffer.concat([d.update(data.subarray(12,-16)), d.final()]).toString(); },
  };
  let clock = Date.now(), ready = false;
  const requests = [], opened = [], changes = [];
  const account = { id: 'a1', walletAddress: ADDRESS, plan: { name: 'Builder', status: 'active' }, allowedModels: [{ id: 'supplied-model', provider: 'codegpt' }], allowance: { includedRemaining: 200, prepaidRemaining: 100, reserved: 20, totalRemaining: 280 } };
  async function fetchImpl(url, init) {
    requests.push({ url, ...init });
    const route = new URL(url).pathname;
    let status = 200, body = {};
    if (route === '/v1/account/config') body = { enabled: true, redemptionEnabled: true, tokensPerRch: 1000000, chainId: 11155111 };
    if (route === '/v1/auth/start') body = { flowId: 'flow1', loginUrl: 'https://reach.test/login?flow=flow1', expiresAt: new Date(clock + 120000).toISOString() };
    if (route === '/v1/auth/exchange') {
      status = ready ? 200 : 202;
      body = ready ? { accessToken: TOKEN, expiresAt: new Date(clock + 3600000).toISOString(), account: { ...account, secret: TOKEN } } : { status: 'pending' };
    }
    if (route === '/v1/account') body = account;
    if (route === '/v1/redemptions/start') body = { redemptionId: 'r1', url: 'https://reach.test/redeem/r1', expiresAt: new Date(clock + 30000).toISOString() };
    return { ok: true, status, json: async () => body };
  }
  const args = { file, safeStorage: vault, fetchImpl, openExternal: async url => opened.push(url), onChange: value => changes.push(value), now: () => clock, ...options };
  const manager = createHostedAccount(args);
  return { manager, args, file, vault, requests, opened, changes, account, setReady: () => { ready = true; }, advance: ms => { clock += ms; } };
}
async function login(f) { await f.manager.configure('https://reach.test'); await f.manager.connect(); f.setReady(); await f.manager.poll(); }

test('service and browser origins reject redirects, credentials and unsafe transports', () => {
  assert.equal(serviceUrl(' https://reach.test/ '), 'https://reach.test');
  assert.equal(serviceUrl('http://127.0.0.1:8010'), 'http://127.0.0.1:8010');
  for (const value of ['http://reach.test', 'https://user:pass@reach.test', 'https://reach.test/v1', 'https://reach.test/?key=secret', 'file:///etc/passwd']) assert.throws(() => serviceUrl(value));
  assert.throws(() => browserUrl('https://evil.test/login', 'https://reach.test'));
  assert.throws(() => browserUrl('javascript:alert(1)', 'https://reach.test'));
  assert.throws(() => browserUrl('https://user:pass@reach.test/login', 'https://reach.test'));
});

test('PKCE login keeps credentials and verifiers out of public state and settings', async t => {
  const f = fixture(t); await f.manager.configure('https://reach.test'); await f.manager.connect();
  assert.equal(f.manager.state().status, 'connecting'); await f.manager.poll();
  const start = JSON.parse(f.requests.find(r => r.url.endsWith('/start')).body);
  const exchange = JSON.parse(f.requests.find(r => r.url.endsWith('/exchange')).body);
  assert.equal(start.codeChallenge, crypto.createHash('sha256').update(exchange.codeVerifier).digest('base64url'));
  assert.equal(start.state, exchange.state);
  f.setReady(); await f.manager.poll();
  assert.equal(f.manager.state().status, 'connected');
  assert.equal(f.manager.state().account.walletAddress, ADDRESS);
  assert(!JSON.stringify(f.changes).includes(TOKEN));
  assert(!JSON.stringify(f.changes).includes(exchange.codeVerifier));
  const disk = fs.readFileSync(f.file, 'utf8'); assert(!disk.includes(TOKEN)); assert(JSON.parse(disk).encryptedSession);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const settings = { activeConnection: MANAGED_ID, connections: [{ id: MANAGED_ID, endpoint: 'https://evil.test' }, { id: 'own', endpoint: 'https://own.test', accessKey: 'personal' }] };
  const hydrated = f.manager.hydrate(settings); assert.equal(hydrated.accessKey, TOKEN); assert.equal(hydrated.endpoint, 'https://reach.test/v1');
  const safe = f.manager.sanitize(hydrated); assert(!JSON.stringify(safe).includes(TOKEN)); assert.equal(safe.connections[0].accessKey, 'personal');
  const restored = createHostedAccount(f.args); assert.equal(restored.state().status, 'connected'); assert.equal(restored.managedConnection().accessKey, TOKEN);
  assert(f.requests.every(request => request.redirect === 'error'));
});

test('cancel during exchange discards and revokes a late session', async t => {
  const f = fixture(t); const original = f.args.fetchImpl; let finish;
  f.args.fetchImpl = async (url, init) => url.endsWith('/exchange') ? new Promise(resolve => { finish = resolve; }) : original(url, init);
  const manager = createHostedAccount(f.args);
  await manager.configure('https://reach.test'); await manager.connect();
  const pending = manager.poll(); manager.cancel();
  finish({ ok: true, status: 200, json: async () => ({ accessToken: TOKEN, expiresAt: new Date(Date.now() + 60000).toISOString() }) });
  await pending;
  assert.equal(manager.state().status, 'disconnected'); assert.equal(manager.managedConnection().accessKey, '');
  assert(f.requests.some(r => r.url.endsWith('/logout')));
});

test('expired sessions remove their main-process credentials', async t => {
  const f = fixture(t); await login(f); f.advance(3600001);
  assert.equal(f.manager.state().status, 'expired'); assert.equal(f.manager.managedConnection().accessKey, '');
  assert(!JSON.parse(fs.readFileSync(f.file, 'utf8')).encryptedSession);
  assert(!JSON.stringify(f.manager.sanitize({ accessKey: TOKEN, connections: [{ id: 'other', accessKey: TOKEN }] })).includes(TOKEN));
});

test('locked vault fails closed and never overwrites encrypted session', async t => {
  const f = fixture(t); await login(f); const original = fs.readFileSync(f.file, 'utf8');
  const locked = createHostedAccount({ ...f.args, safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal(locked.state().status, 'locked'); await assert.rejects(locked.connect(), /vault/);
  assert.equal(locked.managedConnection().accessKey, ''); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});

test('plaintext vault backend is rejected before starting login', async t => {
  const f = fixture(t, { safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' } });
  await f.manager.configure('https://reach.test'); await assert.rejects(f.manager.connect(), /vault/);
  assert(!f.requests.some(r => r.url.endsWith('/start')));
});

test('service changes revoke the old session and force new sign-in', async t => {
  const f = fixture(t); await login(f); await f.manager.configure('https://other.test');
  assert.equal(f.manager.state().status, 'disconnected'); assert.equal(f.manager.managedConnection().endpoint, 'https://other.test/v1');
  assert(f.requests.some(r => r.url === 'https://reach.test/v1/auth/logout' && r.headers.Authorization === 'Bearer ' + TOKEN));
});

test('redemption opens a same-origin review page and does not sign or broadcast', async t => {
  const f = fixture(t); await login(f); const result = await f.manager.redeem('1.25');
  assert.equal(result.redemptionId, 'r1'); assert.equal(f.opened.at(-1), 'https://reach.test/redeem/r1');
  const request = f.requests.at(-1); assert.deepEqual(JSON.parse(request.body), { amountRch: '1.25' });
  for (const amount of ['-1', '0', '1e6', ' 1', '0.0000000000000000001']) await assert.rejects(f.manager.redeem(amount), /positive/);
});

test('public account projection drops unrecognized fields and malformed balances', () => {
  const account = publicAccount({ walletAddress: '<script>', accessToken: TOKEN, allowance: { includedRemaining: -1 }, allowedModels: [{ id: 'm', accessKey: TOKEN }] });
  assert.equal(account.walletAddress, ''); assert.equal(account.allowance.includedRemaining, '0'); assert(!JSON.stringify(account).includes(TOKEN));
});

test('Home shows disconnected, pending, locked, entitlement and redemption states honestly', () => {
  assert.equal(derive({}).canConnect, false);
  assert.equal(derive({ status: 'connecting', baseUrl: 'https://reach.test' }).canConnect, false);
  assert.equal(derive({ status: 'expired', baseUrl: 'https://reach.test', secureStorageAvailable: true }).canConnect, true);
  assert.equal(derive({ status: 'locked', baseUrl: 'https://reach.test' }).canConnect, false);
  assert.match(derive({ status: 'disconnected', baseUrl: 'https://reach.test', secureStorageAvailable: false }).message, /credential vault/);
  const connected = derive({ status: 'connected', account: { plan: { name: 'Builder', status: 'active' }, allowedModels: [{ id: 'm' }], allowance: { totalRemaining: '9007199254740993' } }, config: { redemptionEnabled: true } });
  assert(connected.usable); assert(connected.canRedeem); assert.equal(connected.counts.totalRemaining.replaceAll(',', ''), '9007199254740993');
  assert.equal(derive({ status: 'connected', account: { plan: { status: 'inactive' } } }).usable, false);
});

test('revoked account response clears stored credentials and returns safe errors', async t => {
  const f = fixture(t); let revoked = false; const original = f.args.fetchImpl;
  const manager = createHostedAccount({ ...f.args, fetchImpl: async (url, init) => revoked && url.endsWith('/account') ? { ok: false, status: 401 } : original(url, init) });
  await manager.configure('https://reach.test'); await manager.connect(); f.setReady(); await manager.poll(); revoked = true;
  await assert.rejects(manager.refresh(), /expired or was revoked/);
  assert.equal(manager.state().status, 'expired'); assert.equal(manager.managedConnection().accessKey, '');
});

test('untrusted login redirects cannot open the browser', async t => {
  const f = fixture(t), original = f.args.fetchImpl;
  const manager = createHostedAccount({ ...f.args, fetchImpl: async (url, init) => {
    const response = await original(url, init);
    if (url.endsWith('/start')) { const data = await response.json(); response.json = async () => ({ ...data, loginUrl: 'https://evil.test/collect' }); }
    return response;
  } });
  await manager.configure('https://reach.test'); await assert.rejects(manager.connect(), /outside/);
  assert.equal(f.opened.length, 0); assert.equal(manager.state().status, 'disconnected');
});

test('cancel before auth-start completes prevents opening a stale login', async t => {
  const f = fixture(t), original = f.args.fetchImpl; let finish;
  const manager = createHostedAccount({ ...f.args, fetchImpl: async (url, init) => url.endsWith('/start') ? new Promise(resolve => { finish = () => original(url, init).then(resolve); }) : original(url, init) });
  await manager.configure('https://reach.test'); const connecting = manager.connect(); manager.cancel(); await finish(); await connecting;
  assert.equal(f.opened.length, 0); assert.equal(manager.state().status, 'disconnected');
});
