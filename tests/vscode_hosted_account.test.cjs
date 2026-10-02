'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const extensionRoot = process.env.REACH_VSCODE_TEST_PATH || path.resolve(__dirname, '../vscode');
const { createHostedAccount, serviceUrl, browserUrl, SECRET } = require(path.join(extensionRoot, 'hosted-account.js'));
const origin = 'https://account.example';
const token = 'rch_session_' + '1'.repeat(64);
const wallet = '0x' + '2'.repeat(40);
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fixture({ exchange, stored, write, request } = {}) {
  let now = 1_800_000_000_000, saved = stored;
  const calls = [], opened = [], states = [];
  const account = { walletAddress: wallet, accessToken: token, internalSession: { token },
    plan: { name: 'Pro', status: 'active' }, allowedModels: [{ id: 'cloud/model', name: 'Cloud' }],
    allowance: { includedRemaining: 100, prepaidRemaining: 10, reserved: 0, totalRemaining: 110, debt: 0 },
    rchBalance: { status: 'available', balanceBaseUnits: '1000000000000000000', decimals: 18 } };
  const session = () => ({ accessToken: token, expiresAt: new Date(now + 3_600_000).toISOString(), account });
  const host = createHostedAccount({ now: () => now,
    secrets: { get: async key => { assert.equal(key, SECRET); return saved; },
      store: async (key, value) => { assert.equal(key, SECRET); await write?.(value); saved = value; }, delete: async () => { saved = undefined; } },
    openExternal: async url => { opened.push(url); return true; }, onChange: state => states.push(state),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      const custom = await request?.(url, options);
      if (custom) return custom;
      const route = new URL(url).pathname;
      if (route === '/v1/account/config') return response({ enabled: true, redemptionEnabled: true, tokensPerRch: 100, chainId: 1 });
      if (route === '/v1/auth/start') return response({ flowId: 'f'.repeat(64), expiresAt: new Date(now + 600_000).toISOString(), loginUrl: new URL('/wallet#flow=' + 'f'.repeat(64), url).href });
      if (route === '/v1/auth/exchange') return exchange ? exchange(session(), options) : response(session());
      if (route === '/v1/auth/logout') return response({ ok: true });
      if (route === '/v1/account') return response(account);
      if (route === '/v1/models') return response({ data: [{ id: 'cloud/model' }] });
      throw new Error('Unexpected fixture route ' + route);
    },
  });
  return { host, account, calls, opened, states, saved: () => saved, advance: amount => { now += amount; },
    async login() { await host.configure(origin); await host.connect(); await host.poll(); } };
}

test('account service and browser links reject credential URLs and foreign origins', () => {
  assert.equal(serviceUrl(origin + '/'), origin);
  assert.equal(serviceUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  for (const invalid of ['http://remote.example', 'https://user:secret@account.example', origin + '/v1', origin + '?token=secret', origin + '#secret']) {
    assert.throws(() => serviceUrl(invalid));
  }
  assert.equal(browserUrl(origin + '/wallet#flow=test', origin), origin + '/wallet#flow=test');
  for (const invalid of ['https://other.example/wallet', 'https://user:secret@account.example/wallet', 'javascript:alert(1)', 'file:///tmp/wallet']) {
    assert.throws(() => browserUrl(invalid, origin));
  }
});

test('wallet login uses PKCE and secure storage while public state omits session credentials', async () => {
  const f = fixture();
  await f.login();
  const start = f.calls.find(call => call.url.endsWith('/auth/start'));
  const exchange = f.calls.find(call => call.url.endsWith('/auth/exchange'));
  const startBody = JSON.parse(start.options.body), proof = JSON.parse(exchange.options.body);
  assert.equal(crypto.createHash('sha256').update(proof.codeVerifier).digest('base64url'), startBody.codeChallenge);
  assert.equal(proof.state, startBody.state);
  assert.equal(startBody.codeVerifier, undefined);
  assert.equal(start.options.headers.Authorization, undefined);
  assert.equal(exchange.options.headers.Authorization, undefined);
  assert.equal(f.host.state().status, 'connected');
  assert.equal(f.host.state().account.walletAddress, wallet);
  assert.equal(JSON.parse(f.saved()).session.accessToken, token);
  assert.equal(JSON.stringify(f.states).includes(token), false);
  assert.equal(JSON.stringify(f.opened).includes(token), false);
  assert.equal(JSON.stringify(f.states).includes(proof.codeVerifier), false);
  assert.equal(f.host.authorize(origin + '/v1'), token);
  assert.throws(() => f.host.authorize('https://other.example/v1'), /service changed/);
  assert.deepEqual(await f.host.models(), ['cloud/model']);
  const restored = fixture({ stored: f.saved() });
  await restored.host.initialize();
  assert.equal(restored.host.connection().accessKey, token);
  restored.advance(3_600_001);
  assert.equal(restored.host.state().status, 'expired');
  assert.equal(restored.host.connection().accessKey, '');
  assert.throws(() => restored.host.authorize(origin + '/v1'), /Sign in/);
});

test('wallet redemption can start before a subscription exists', async () => {
  const f = fixture({ request: url => url.endsWith('/v1/redemptions/start')
    ? response({ url: origin + '/wallet/redeem#id=fixture', expiresAt: new Date(1_800_000_900_000).toISOString() }) : null });
  await f.login();
  f.account.plan = { status: 'none' };
  f.account.allowance = { includedRemaining: 0, prepaidRemaining: 0, totalRemaining: 0, reserved: 0, debt: 0 };
  await f.host.refresh();
  await f.host.redeem('1');
  assert.equal(f.opened.at(-1), origin + '/wallet/redeem#id=fixture');
});

test('card checkout opens only Stripe Checkout for the signed-in account', async () => {
  let cardPayments = true, checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_fixture';
  const f = fixture({ request: (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/v1/account/config') return response({ enabled: true, cardPayments });
    if (route === '/v1/billing/checkout') return response({ url: checkoutUrl, expiresAt: null, received: JSON.parse(options.body) });
    return null;
  } });
  await f.login();
  assert.equal(f.host.state().config.cardPayments, true);
  await f.host.subscribe();
  const sent = f.calls.filter(call => call.url.endsWith('/v1/billing/checkout'));
  assert.deepEqual(JSON.parse(sent[0].options.body), { kind: 'subscription' });
  assert.equal(sent[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(f.opened.at(-1), checkoutUrl);
  await f.host.topUp('12.50');
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { kind: 'top_up', amountUsdMicros: 12_500_000 });
  for (const bad of ['0.99', '501', '12.345', 'ten', '-5', '1e2', ''])
    await assert.rejects(f.host.topUp(bad), /between 1 and 500/, bad);
  checkoutUrl = 'https://checkout.stripe.com.evil.example/pay';
  await assert.rejects(f.host.subscribe(), /outside Stripe Checkout/);
  checkoutUrl = origin + '/billing/return';
  await assert.rejects(f.host.subscribe(), /outside Stripe Checkout/);
  assert.equal(f.opened.filter(url => !url.startsWith('https://checkout.stripe.com/')).length, 1); // only the wallet login page
  cardPayments = false; await f.host.refresh();
  await assert.rejects(f.host.subscribe(), /not enabled/);
});

test('cancelled exchange revokes a late token without restoring local or persisted access', async () => {
  const started = defer(), release = defer();
  const f = fixture({ exchange: async session => { started.resolve(); await release.promise; return response(session); } });
  await f.host.configure(origin); await f.host.connect();
  const poll = f.host.poll(); await started.promise;
  await f.host.cancel(); release.resolve(); await poll;
  assert.equal(f.host.state().status, 'disconnected');
  assert.equal(f.host.connection().accessKey, '');
  assert.equal(JSON.parse(f.saved()).session, null);
  assert.equal(f.calls.find(call => call.url.endsWith('/auth/logout')).options.headers.Authorization, 'Bearer ' + token);
});

for (const action of ['cancel', 'disconnect']) {
  test(`${action} during a pending credential write cannot restore the cancelled session`, async () => {
    const started = defer(), release = defer();
    const f = fixture({ write: async value => { if (JSON.parse(value).session) { started.resolve(); await release.promise; } } });
    await f.host.configure(origin); await f.host.connect();
    const poll = f.host.poll(); await started.promise;
    const cancelled = Promise.resolve(f.host[action]());
    release.resolve(); await Promise.all([poll, cancelled]);
    assert.equal(f.host.connection().accessKey, '');
    assert.equal(f.host.state().status, 'disconnected');
    assert.equal(JSON.parse(f.saved()).session, null);
    assert.equal(JSON.stringify(f.states).includes(token), false);
  });
}

test('revoked authentication removes the stored session and transport diagnostics remain private', async () => {
  let revoked = false, offline = false;
  const f = fixture({ request: async url => {
    if (offline) throw new Error('private transport Authorization: Bearer ' + token);
    if (revoked && url.endsWith('/v1/account')) return response({ error: 'private server detail ' + token }, 401);
  } });
  await f.login(); revoked = true;
  await assert.rejects(f.host.refresh(), /Sign in/);
  assert.equal(f.host.state().status, 'expired');
  assert.equal(f.host.connection().accessKey, '');
  assert.equal(JSON.parse(f.saved()).session, null);
  assert.equal(JSON.stringify(f.states).includes(token), false);
  offline = true;
  await assert.rejects(f.host.refresh(), error => !error.message.includes(token) && /could not be reached/.test(error.message));
});

function providerFixture(account) {
  const filename = path.join(extensionRoot, 'extension.js'), req = createRequire(filename);
  const calls = [], posts = [];
  const values = { provider: 'endpoint', endpoint: 'https://free.example/v1', accessKey: 'free-endpoint-key',
    model: 'cloud/model', additionalHeaders: 'Authorization: Bearer custom-endpoint-key' };
  const context = { module: { exports: {} }, console, process, Buffer, URL, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? { window: { tabGroups: { all: [] } }, workspace: { isTrusted: true,
      getConfiguration: () => ({ get: key => values[key] }) } } : name === './search' ? {} : req(name),
    fetch: async (url, options) => { calls.push({ url, options }); return response({ choices: [{ message: { content: 'cloud answer' } }] }); } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.TestProvider=ReachChatViewProvider; module.exports.setAccount=value=>{hostedAccount=value;providerSelectionOverride="subscription";}; module.exports.clearOverride=()=>{providerSelectionOverride=undefined;}; module.exports.readConfig=config;', context, { filename });
  context.module.exports.setAccount(account);
  const provider = new context.module.exports.TestProvider({ fsPath: extensionRoot });
  provider._account = account;
  provider._ideBridge = { handles: () => false };
  provider._view = { webview: { postMessage: message => posts.push(message) } };
  return { provider, calls, posts, connection: context.module.exports.readConfig,
    selectConfiguredSubscription() { values.provider = 'subscription'; context.module.exports.clearOverride(); } };
}

test('the configured subscription provider survives reload without a selection override', async () => {
  const f = fixture(); await f.login();
  const h = providerFixture(f.host);
  h.selectConfiguredSubscription();
  const connection = h.connection();
  assert.equal(connection.provider, 'subscription');
  assert.equal(connection.providerSelection, 'subscription');
  assert.equal(connection.endpoint, origin + '/v1');
  assert.equal(h.provider._authHeaders({}, connection).Authorization, 'Bearer ' + token);
  h.provider._post('config', connection);
  assert.equal(JSON.stringify(h.posts).includes(token), false);
});

test('subscription model requests stay on their origin with account auth and no webview credential leak', async () => {
  const f = fixture(); await f.login();
  const h = providerFixture(f.host), connection = h.connection();
  h.provider._bridgeIds = new Map([['codegpt-eco', 'bridge-alias']]);
  assert.equal(await h.provider._modelEndpoint(connection, 'codegpt-eco'), origin + '/v1');
  assert.equal(h.provider._wireModel('codegpt-eco'), 'codegpt-eco');
  const headers = h.provider._authHeaders({}, connection, 'codegpt-eco');
  assert.equal(headers.Authorization, 'Bearer ' + token);
  assert.match(headers['Idempotency-Key'], /^[a-f0-9-]{36}$/);
  h.provider._post('config', connection);
  h.provider._post('configSaved', { key: 'account', config: connection });
  assert.equal(JSON.stringify(h.posts).includes(token), false);
  const catalog = await h.provider._discoverModels(connection);
  assert.deepEqual(Array.from(catalog.routes, entry => Array.from(entry)), [['cloud/model', origin + '/v1']]);
  await h.provider._chat({ messages: [{ role: 'user', content: 'hello' }], model: 'cloud/model', stream: false });
  await h.provider._think('reason about it', false, 'cloud/model');
  await h.provider._deriveQuery('make a search query', 'cloud/model');
  assert.equal(h.calls.length, 3);
  for (const call of h.calls) {
    assert.equal(call.url, origin + '/v1/chat/completions');
    assert.equal(call.options.headers.Authorization, 'Bearer ' + token);
    assert.equal(call.options.redirect, 'error', 'every subscription path must refuse redirects');
    assert.match(call.options.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/);
  }
  assert.equal(new Set(h.calls.map(call => call.options.headers['Idempotency-Key'])).size, 3);
  assert.equal(JSON.stringify(h.posts).includes(token), false);
});
