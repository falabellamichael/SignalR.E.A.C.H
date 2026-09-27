import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { randomBytes, createHash } from 'node:crypto';
import { Wallet, getAddress } from 'ethers';
import { AccountStore, AccountError } from '../service/store.mjs';
import { createAccountService, signInMessage } from '../service/server.mjs';
import { createModelGateway } from '../service/model-gateway.mjs';
import { createRedemptionService, redemptionInterface } from '../service/redemption.mjs';

const model = { id: 'async/measured', name: 'Measured', provider: 'test', metered: true,
  maxInputTokens: 50, maxInputBytes: 4096, maxOutputTokens: 10 };
const wallet = Wallet.createRandom();
const tokenAddress = getAddress(`0x${'22'.repeat(20)}`);
const txHash = `0x${'33'.repeat(32)}`;
const blockHash = `0x${'44'.repeat(32)}`;
const config = { origin: 'http://127.0.0.1:20978', chainId: 31337, models: [model],
  upstreamUrl: 'http://127.0.0.1:20777/v1', upstreamKey: 'server-only-test-credential', redemption: { enabled: false } };
const proof = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, state: randomBytes(32).toString('base64url'), challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 1500); })]); }
  finally { clearTimeout(timer); }
}

// Bind to the real SQLite target so its internal transactions stay synchronous;
// only the public store boundary behaves like a remote database. Every method
// yields before executing, exposing callers that forget to await its result.
function remoteStore(raw, hooks = {}) {
  return new Proxy(raw, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof value !== 'function') return value;
      if (name === 'now') return value.bind(target);
      return async (...args) => {
        await yieldTurn();
        await hooks.before?.(name, args);
        const result = value.apply(target, args);
        await hooks.after?.(name, args, result);
        return result;
      };
    },
  });
}
function ledger(t, hooks = {}) {
  const raw = new AccountStore(':memory:', { models: [model] });
  t.after(async () => { await yieldTurn(); await yieldTurn(); raw.close(); });
  const account = raw.grantPlan({ wallet: wallet.address, grantId: 'async-initial-grant', planId: 'pro', name: 'Pro',
    models: [model.id], tokens: 100, expiresAt: Date.now() + 3_600_000 });
  return { raw, account, store: remoteStore(raw, hooks) };
}
async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function jsonCall(base, path, body, token) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(2500),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const completion = () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Measured answer.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }, usage_source: 'provider' }),
{ headers: { 'content-type': 'application/json', 'x-reach-metering': 'provider-v1' } });
async function gatewayFixture(t, store, account, fetchImpl, options = {}) {
  const rejectedHandlers = [];
  const gateway = createModelGateway({ store, models: [model], upstreamUrl: config.upstreamUrl, upstreamKey: config.upstreamKey,
    fetchImpl, timeoutMs: 2000, ...options });
  const server = createServer((req, res) => {
    gateway.handle(req, res, account).catch(error => { rejectedHandlers.push(error); res.destroy(); });
  });
  const base = await listen(t, server);
  return { rejectedHandlers, call: id => fetch(base + '/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(2500),
    headers: { 'content-type': 'application/json', 'idempotency-key': id },
    body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'Hello.' }] }) }) };
}

test('account HTTP lifecycle awaits asynchronous wallet proof, session, account and logout operations', async t => {
  const { store } = ledger(t);
  const { server } = createAccountService({ config, store });
  const base = await listen(t, server);
  const p = proof();
  const flow = await jsonCall(base, '/v1/auth/start', { state: p.state, codeChallenge: p.challenge });
  assert.equal(flow.status, 200);
  assert.match(flow.body.flowId, /^[a-f0-9]{64}$/);
  const pending = await jsonCall(base, '/v1/auth/exchange', { flowId: flow.body.flowId, state: p.state, codeVerifier: p.verifier });
  assert.equal(pending.status, 202);
  const challenge = await jsonCall(base, '/v1/auth/challenge', { flowId: flow.body.flowId, address: wallet.address });
  assert.equal(challenge.status, 200);
  const verified = await jsonCall(base, '/v1/auth/verify', { flowId: flow.body.flowId, challengeId: challenge.body.challengeId,
    signature: await wallet.signMessage(challenge.body.message) });
  assert.equal(verified.status, 200);
  const exchange = await jsonCall(base, '/v1/auth/exchange', { flowId: flow.body.flowId, state: p.state, codeVerifier: p.verifier });
  assert.equal(exchange.status, 200);
  assert.equal(exchange.body.account.walletAddress, wallet.address);
  const token = exchange.body.accessToken;
  assert.equal((await jsonCall(base, '/v1/account', undefined, token)).body.allowance.includedRemaining, 100);
  assert.equal((await jsonCall(base, '/v1/models', undefined, token)).body.data[0].id, model.id);
  assert.equal((await jsonCall(base, '/v1/auth/logout', {}, token)).status, 200);
  assert.equal((await jsonCall(base, '/v1/account', undefined, token)).status, 401);
});

test('an asynchronous authorization rejection returns its safe error and cannot verify the login flow', async t => {
  const { raw, store } = ledger(t, { before(name) { if (name === 'authorize') throw new AccountError(503, 'backend_unavailable', 'Account storage is unavailable.'); } });
  const p = proof();
  const flow = raw.startFlow(p.state, p.challenge);
  const challenge = raw.challenge(flow.flowId, wallet.address, (...args) => signInMessage(config.origin, config.chainId, ...args));
  const { server } = createAccountService({ config, store });
  const base = await listen(t, server);
  const result = await jsonCall(base, '/v1/auth/verify', { flowId: flow.flowId, challengeId: challenge.challengeId,
    signature: await wallet.signMessage(challenge.message) });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'backend_unavailable');
  assert.equal(raw.getFlow(flow.flowId).account_id, null);
});

test('committed sign-in returns its account snapshot without a second storage read losing the session', async t => {
  let accountReads = 0;
  const { raw, store, account } = ledger(t, { before(name) {
    if (name === 'account') { accountReads++; throw new AccountError(503, 'backend_unavailable', 'Storage disconnected after exchange.'); }
  } });
  const p = proof();
  const flow = raw.startFlow(p.state, p.challenge);
  const challenge = raw.challenge(flow.flowId, wallet.address, (...args) => signInMessage(config.origin, config.chainId, ...args));
  raw.authorize(flow.flowId, challenge.challengeId);
  const { server } = createAccountService({ config, store });
  const base = await listen(t, server);
  const result = await jsonCall(base, '/v1/auth/exchange', { flowId: flow.flowId, state: p.state, codeVerifier: p.verifier });
  assert.equal(result.status, 200, 'the one-time proof was consumed, so return its committed session snapshot');
  assert.equal(result.body.account.id, account.id);
  assert.equal(result.body.account.allowance.includedRemaining, 100);
  assert.equal(result.body.account.rchBalance.status, 'unconfigured');
  assert.equal(raw.authenticate(result.body.accessToken).id, account.id);
  assert.equal(accountReads, 0, 'exchange already returned a consistent account snapshot');
});

test('gateway waits for reservation before dispatch and durable settlement before success or replay', async t => {
  const reserveEntered = deferred(), reserveRelease = deferred(), settleEntered = deferred(), settleRelease = deferred();
  const { raw, store, account } = ledger(t, { async before(name) {
    if (name === 'reserve') { reserveEntered.resolve(); await reserveRelease.promise; }
    if (name === 'settle') { settleEntered.resolve(); await settleRelease.promise; }
  } });
  let dispatches = 0, replyReceived = false;
  const f = await gatewayFixture(t, store, account, async () => {
    dispatches++;
    assert.equal(raw.account(account.id).allowance.reserved, 60);
    return completion();
  });
  const pending = f.call('async-reserve-settle').then(response => { replyReceived = true; return response; });
  try {
    await within(reserveEntered.promise, 'Reservation was not requested.');
    assert.equal(dispatches, 0, 'no provider call can occur while funds are unreserved');
    assert.equal(raw.account(account.id).allowance.includedRemaining, 100);
    reserveRelease.resolve();
    await within(settleEntered.promise, 'The gateway did not reach asynchronous settlement.');
    assert.equal(replyReceived, false, 'a successful response must wait for a committed settlement');
    assert.equal(raw.account(account.id).allowance.reserved, 60);
  } finally { reserveRelease.resolve(); settleRelease.resolve(); }
  const first = await pending;
  assert.equal(first.status, 200);
  const answer = await first.text();
  assert.equal(raw.account(account.id).allowance.includedRemaining, 90);
  assert.equal(raw.account(account.id).allowance.reserved, 0);
  const replay = await f.call('async-reserve-settle');
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-reach-replayed'), 'true');
  assert.equal(await replay.text(), answer);
  assert.equal(dispatches, 1);
  assert.deepEqual(f.rejectedHandlers, []);
});

test('asynchronous uncertainty persistence failure still closes the response and retains the durable hold', async t => {
  const { raw, store, account } = ledger(t, { before(name) {
    if (name === 'markUncertain') throw new AccountError(503, 'backend_unavailable', 'Private storage detail must stay server-side.');
  } });
  let dispatches = 0;
  const f = await gatewayFixture(t, store, account, async () => { dispatches++; throw new Error('Private provider failure.'); });
  const response = await f.call('uncertain-storage-offline');
  const body = await response.text();
  assert.ok(response.status >= 400);
  assert.equal(dispatches, 1);
  assert.doesNotMatch(body, /Private storage|Private provider/);
  assert.equal(raw.account(account.id).allowance.reserved, 60);
  assert.deepEqual(f.rejectedHandlers, [], 'cleanup failure must not escape the HTTP handler');
});

test('asynchronous release failure during capacity rejection closes the response without dispatching twice', async t => {
  const entered = deferred(), release = deferred();
  const { raw, store, account } = ledger(t, { before(name) {
    if (name === 'release') throw new AccountError(503, 'backend_unavailable', 'Private storage detail.');
  } });
  raw.grantPlan({ wallet: wallet.address, grantId: 'async-capacity-grant', planId: 'pro', name: 'Pro', models: [model.id], tokens: 200, expiresAt: Date.now() + 3_600_000 });
  let dispatches = 0;
  const f = await gatewayFixture(t, store, account, async () => { dispatches++; entered.resolve(); await release.promise; return completion(); }, { maxConcurrency: 1 });
  const first = f.call('capacity-first');
  try {
    await within(entered.promise, 'The first generation never dispatched.');
    const second = await f.call('capacity-second');
    assert.ok(second.status >= 400);
    assert.doesNotMatch(await second.text(), /Private storage/);
    assert.equal(dispatches, 1);
    assert.deepEqual(f.rejectedHandlers, []);
  } finally { release.resolve(); }
  assert.equal((await first).status, 200);
  assert.equal(raw.account(account.id).allowance.reserved, 60, 'failed cleanup must leave the unrefunded hold visible for reconciliation');
});

function chainProvider() {
  let row = null;
  const provider = {
    async getNetwork() { return { chainId: BigInt(config.chainId) }; },
    async getCode(address) { return address.toLowerCase() === tokenAddress.toLowerCase() ? '0x6000' : '0x'; },
    async call(transaction) {
      const name = redemptionInterface.parseTransaction(transaction).name;
      return redemptionInterface.encodeFunctionResult(name, [name === 'redemptionPaused' ? false : name === 'RCH_UNITS_PER_AI_TOKEN' ? 10n ** 12n : 1_000_000n]);
    },
    async getTransactionReceipt() {
      if (!row) return null;
      const event = redemptionInterface.encodeEventLog(redemptionInterface.getEvent('Redeemed'), [row.wallet, row.id, BigInt(row.amount), BigInt(row.usage_tokens)]);
      return { hash: txHash, status: 1, from: row.wallet, to: tokenAddress, blockHash, blockNumber: 10,
        logs: [{ ...event, address: tokenAddress, transactionHash: txHash, blockHash, blockNumber: 10, index: 0 }] };
    },
    async getTransaction() { return row && { hash: txHash, from: row.wallet, to: tokenAddress, value: 0n, chainId: BigInt(config.chainId), blockHash,
      data: redemptionInterface.encodeFunctionData('redeem', [BigInt(row.amount), row.id]) }; },
    async getBlock() { return { number: 10, hash: blockHash }; },
    async getBlockNumber() { return 10; },
    confirm(value) { row = value; },
  };
  return provider;
}

test('redemption awaits remote intent persistence, receipt credit and pending reconciliation exactly once', async t => {
  const { raw, store, account } = ledger(t);
  const provider = chainProvider();
  const service = createRedemptionService({ store, provider, config: { ...config, redemption: { enabled: true, tokenAddress, confirmations: 1 } } });
  const started = await service.start(account, '0.000001');
  assert.match(started.redemptionId, /^0x[a-f0-9]{64}$/);
  const ticket = new URLSearchParams(new URL(started.url).hash.slice(1)).get('ticket');
  const details = await service.details(started.redemptionId, ticket);
  assert.equal(details.transaction.to, tokenAddress);
  assert.equal(details.usageTokens, 1);
  const pending = await service.submit(started.redemptionId, ticket, txHash);
  assert.equal(pending.status, 'pending');
  assert.equal(raw.account(account.id).allowance.prepaidRemaining, 0);
  provider.confirm(raw.getRedemption(started.redemptionId, ticket));
  assert.equal((await service.reconcile(account.id))[0].status, 'credited');
  assert.equal(raw.account(account.id).allowance.prepaidRemaining, 1);
  assert.equal((await service.submit(started.redemptionId, ticket, txHash)).status, 'credited');
  assert.equal(raw.account(account.id).allowance.prepaidRemaining, 1);
  await assert.rejects(service.details(started.redemptionId, '0'.repeat(64)), { code: 'redemption_missing' });
});

test('startup maintenance awaits authentication pruning before asynchronous redemption reconciliation', async t => {
  const pruning = deferred(), release = deferred(), reconciled = deferred();
  let pendingReads = 0;
  const { store } = ledger(t, { async before(name) {
    if (name === 'pruneExpiredAuthentication') { pruning.resolve(); await release.promise; }
    if (name === 'pendingRedemptions') { pendingReads++; reconciled.resolve(); }
  } });
  const { server } = createAccountService({ config: { ...config, redemption: { enabled: true, tokenAddress, confirmations: 1 } },
    store, redemptionProvider: chainProvider() });
  await listen(t, server);
  try {
    await within(pruning.promise, 'Startup did not prune authentication.');
    await yieldTurn();
    assert.equal(pendingReads, 0, 'maintenance must await pruning rather than overlap remote store work');
  } finally { release.resolve(); }
  await within(reconciled.promise, 'Startup did not reconcile pending redemptions.');
  await yieldTurn();
});

test('asynchronous authentication pruning failure is contained and leaves later reconciliation for retry', async t => {
  const attempted = deferred();
  let pendingReads = 0;
  const { store } = ledger(t, { before(name) {
    if (name === 'pruneExpiredAuthentication') {
      attempted.resolve();
      throw new AccountError(503, 'backend_unavailable', 'Account storage is unavailable.');
    }
    if (name === 'pendingRedemptions') pendingReads++;
  } });
  const { server } = createAccountService({ config: { ...config, redemption: { enabled: true, tokenAddress, confirmations: 1 } },
    store, redemptionProvider: chainProvider() });
  const base = await listen(t, server);
  await within(attempted.promise, 'Startup did not try authentication maintenance.');
  await yieldTurn();
  assert.equal(pendingReads, 0);
  assert.equal((await jsonCall(base, '/healthz')).status, 200, 'maintenance failure must not crash or hang the account service');
});
