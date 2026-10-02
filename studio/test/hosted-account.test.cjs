'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHostedAccount, serviceUrl, browserUrl, publicAccount, MANAGED_ID } = require('../agent/hosted-account.cjs');
const { derive, formatRch, formatUsd } = require('../renderer/account-view.js');
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

test('hosted ngrok API requests pass through the tunnel warning', async t => {
  const ngrok = fixture(t); await ngrok.manager.configure('https://example.ngrok-free.dev');
  assert.equal(ngrok.requests[0].headers['ngrok-skip-browser-warning'], '1');
  const direct = fixture(t); await direct.manager.configure('https://reach.test');
  assert.equal(direct.requests[0].headers['ngrok-skip-browser-warning'], undefined);
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
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
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

test('card checkout sends the session, validates the amount and opens only Stripe Checkout', async t => {
  let cardPayments = true, checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_fixture', portal = 'https://billing.stripe.com/p/session/test_1';
  const sent = [];
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    const body = route === '/v1/account/config' ? { enabled: true, cardPayments }
      : route === '/v1/auth/start' ? { flowId: 'flow1', loginUrl: 'https://reach.test/login?flow=flow1', expiresAt: new Date(Date.now() + 120000).toISOString() }
      : route === '/v1/auth/exchange' ? { accessToken: TOKEN, expiresAt: new Date(Date.now() + 3600000).toISOString(), account: { id: 'a1', walletAddress: ADDRESS } }
      : route === '/v1/billing/checkout' ? (sent.push({ body: JSON.parse(init.body), auth: init.headers.Authorization }), { url: checkoutUrl, expiresAt: null })
      : route === '/v1/billing/portal' ? { url: portal }
      : { id: 'a1', walletAddress: ADDRESS };
    return { ok: true, status: 200, json: async () => body };
  };
  const f = fixture(t, { fetchImpl, now: Date.now });
  await f.manager.configure('https://reach.test'); await f.manager.connect(); await f.manager.poll();
  assert.equal(f.manager.state().config.cardPayments, true);
  await f.manager.subscribe();
  await f.manager.topUp('$25');
  assert.deepEqual(sent.map(entry => entry.body), [{ kind: 'subscription' }, { kind: 'top_up', amountUsdMicros: 25_000_000 }]);
  assert.ok(sent.every(entry => entry.auth === 'Bearer ' + TOKEN));
  assert.deepEqual(f.opened.slice(-2), [checkoutUrl, checkoutUrl]);
  for (const amount of ['0.5', '500.01', '1,000', ' ', '12.345']) await assert.rejects(f.manager.topUp(amount), /between 1 and 500/);
  for (checkoutUrl of ['https://reach.test/pay', 'http://checkout.stripe.com/pay', 'https://user:pw@checkout.stripe.com/pay'])
    await assert.rejects(f.manager.subscribe(), /outside Stripe Checkout/);
  assert.equal(f.opened.length, 3, 'login page plus the two Stripe pages only');
  await f.manager.manageBilling();
  assert.equal(f.opened.at(-1), portal);
  portal = 'https://reach.test/billing';
  await assert.rejects(f.manager.manageBilling(), /outside the Stripe billing portal/);
  assert.doesNotMatch(JSON.stringify(f.manager.state()), new RegExp(TOKEN));
  cardPayments = false; await f.manager.refresh();
  await assert.rejects(f.manager.subscribe(), /not enabled/);
});

test('public account projection drops unrecognized fields and malformed balances', () => {
  const account = publicAccount({ walletAddress: '<script>', accessToken: TOKEN, allowance: { includedRemaining: -1 }, allowedModels: [{ id: 'm', accessKey: TOKEN }] });
  assert.equal(account.walletAddress, ''); assert.equal(account.allowance.includedRemaining, '0'); assert(!JSON.stringify(account).includes(TOKEN));
});

test('wallet holdings retain exact decimals without changing allowance or subscription eligibility', async t => {
  const f = fixture(t);
  f.account.rchBalance = { status: 'available', chainId: 1, tokenAddress: ADDRESS, decimals: 18,
    balanceBaseUnits: '269565909309000000000', blockNumber: 123, secret: TOKEN };
  f.account.plan.status = 'none'; f.account.allowedModels = [];
  f.account.allowance = { includedRemaining: 0, prepaidRemaining: 0, reserved: 0, totalRemaining: 0 };
  await login(f); await f.manager.refresh();
  const state = f.manager.state(), view = derive(state);
  assert.equal(view.walletBalance, '269.565909309 RCH');
  assert.equal(view.counts.prepaidRemaining, '0'); assert.equal(view.usable, false);
  assert.match(view.walletBalanceDetail, /Ethereum Mainnet/);
  assert(!JSON.stringify(state).includes(TOKEN));
  f.account.rchBalance.status = 'unavailable'; await f.manager.refresh();
  assert.equal(derive(f.manager.state()).walletBalance, '—');
  assert.match(derive(f.manager.state()).walletBalanceDetail, /temporarily unavailable/);
  await f.manager.disconnect();
  assert.equal(derive(f.manager.state()).walletBalance, '—');
});

test('malformed holdings cannot become a balance and formatting preserves all 18 decimals', () => {
  assert.equal(formatRch('0'), '0 RCH');
  assert.equal(formatRch('1'), '0.000000000000000001 RCH');
  assert.equal(formatRch('123456789012345678901234567890'), '123,456,789,012.34567890123456789 RCH');
  const valid = { status: 'available', chainId: 1, tokenAddress: ADDRESS, decimals: 18,
    balanceBaseUnits: '1', blockNumber: 123 };
  for (const change of [{balanceBaseUnits:'-1'},{balanceBaseUnits:'1e18'},{balanceBaseUnits:'1.5'},
    {balanceBaseUnits:1},{decimals:6},{chainId:0},{tokenAddress:'bad'},{balanceBaseUnits:(1n<<256n).toString()}]) {
    const projected = publicAccount({rchBalance:{...valid,...change}});
    assert.equal(projected.rchBalance.status, 'unavailable');
    assert.equal(derive({status:'connected',account:projected}).walletBalance, '—');
  }
});

test('Home shows disconnected, pending, locked, entitlement and redemption states honestly', () => {
  assert.equal(derive({}).canConnect, false);
  assert.equal(derive({ status: 'connecting', baseUrl: 'https://reach.test' }).canConnect, false);
  assert.equal(derive({ status: 'expired', baseUrl: 'https://reach.test', secureStorageAvailable: true }).canConnect, true);
  assert.equal(derive({ status: 'locked', baseUrl: 'https://reach.test' }).canConnect, false);
  assert.match(derive({ status: 'disconnected', baseUrl: 'https://reach.test', secureStorageAvailable: false }).message, /credential vault/);
  const connected = derive({ status: 'connected', account: { plan: { name: 'Builder', status: 'active' }, allowedModels: [{ id: 'm' }], allowance: { totalRemaining: '9007199254740993' } }, config: { redemptionEnabled: true } });
  assert(connected.usable); assert(connected.canRedeem); assert.equal(connected.counts.totalRemaining.replaceAll(',', ''), '9007199254740993');
  const prepaid = derive({ status: 'connected', account: { plan: { status: 'none' }, allowedModels: [{ id: 'm' }], allowance: { prepaidRemaining: 50, totalRemaining: 50 } }, config: { redemptionEnabled: true } });
  assert.equal(prepaid.usable, true); assert.equal(prepaid.canRedeem, true); assert.equal(prepaid.plan, 'RCH prepaid access');
  assert.equal(derive({ status: 'connected', account: { plan: { status: 'inactive' } } }).usable, false);
});

test('USD credit preserves subcent value, holds and legacy allowance independently', () => {
  const projected = publicAccount({ walletAddress: ADDRESS, plan: { status: 'none' }, allowedModels: [{ id: 'priced-model' }],
    allowance: { totalRemaining: 10 }, credit: { currency: 'USD', balanceMicros: 300, reservedMicros: 50, debtMicros: 0, secret: TOKEN } });
  assert.deepEqual(projected.credit, { currency: 'USD', balanceMicros: '300', reservedMicros: '50', debtMicros: '0' });
  const model = derive({ status: 'connected', account: projected });
  assert.equal(model.usdCredit.available, 'US$0.0003'); assert.equal(model.counts.totalRemaining, '10');
  assert.equal(model.usable, true); assert.equal(model.plan, 'RCH prepaid access');
  projected.allowance.totalRemaining = '0'; projected.credit.balanceMicros = '0';
  assert.equal(derive({ status: 'connected', account: projected }).usable, false);
  assert.equal(formatUsd('1'), 'US$0.000001'); assert.equal(formatUsd('123450000'), 'US$123.45');
  assert.equal(formatUsd(-1), '—'); assert.equal(formatUsd('1e6'), '—');
  assert.equal(publicAccount({ credit: { currency: 'USD', balanceMicros: -1 } }).credit.balanceMicros, '0');
  const models = publicAccount({ allowedModels: [{ id: 'priced', pricing: { inputUsdMicrosPerMillion: 150000, outputUsdMicrosPerMillion: 600000,
    cachedInputUsdMicrosPerMillion: 75000, secret: TOKEN } }] }).allowedModels;
  assert.deepEqual(models[0].pricing, { inputUsdMicrosPerMillion: '150000', outputUsdMicrosPerMillion: '600000', cachedInputUsdMicrosPerMillion: '75000' });
  assert(!JSON.stringify(models).includes(TOKEN));
});

test('treasury mode and USD credit reach the renderer without exposing credentials', async t => {
  const f = fixture(t), original = f.args.fetchImpl;
  const manager = createHostedAccount({ ...f.args, fetchImpl: async (url, init) => {
    const response = await original(url, init);
    if (url.endsWith('/config')) response.json = async () => ({ enabled: true, chainId: 1, redemptionEnabled: true,
      redemptionMode: 'treasury', treasuryAddress: ADDRESS, tokensPerRch: null, quoteSignerKey: TOKEN,
      redemptionModels: [{ id: 'priced', pricing: { inputUsdMicrosPerMillion: 150000, outputUsdMicrosPerMillion: 600000 }, accessKey: TOKEN }] });
    return response;
  } });
  await manager.configure('https://reach.test');
  assert.equal(manager.state().config.redemptionMode, 'treasury');
  assert.equal(manager.state().config.tokensPerRch, null);
  assert.equal(manager.state().config.treasuryAddress, ADDRESS);
  assert.equal(manager.state().config.redemptionModels[0].pricing.inputUsdMicrosPerMillion, '150000');
  assert(!JSON.stringify(manager.state()).includes(TOKEN));
});

test('known quote failures explain redemption recovery without reflecting server secrets', async t => {
  const f = fixture(t), original = f.args.fetchImpl;
  const manager = createHostedAccount({ ...f.args, fetchImpl: async (url, init) => url.endsWith('/redemptions/start')
    ? { ok: false, status: 503, json: async () => ({ error: { code: 'market_price_unavailable', message: TOKEN } }) }
    : original(url, init) });
  await manager.configure('https://reach.test'); await manager.connect(); f.setReady(); await manager.poll();
  await assert.rejects(manager.redeem('1'), error => /verified market quote/.test(error.message) && !error.message.includes(TOKEN));
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
