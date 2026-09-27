import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SupabaseAccountStore } from '../service/supabase-store.mjs';
import { AccountError } from '../service/store.mjs';

const secretKey = 'sb_secret_test_fixture_not_a_real_key';
const wallet = '0x0000000000000000000000000000000000000001';
const now = 1800000000000;
const row = { id: 'a'.repeat(64), wallet, plan_id: 'pro', plan_name: 'Pro', plan_expires: now + 60000,
  plan_version: 'grant-0001', models: '["model-1"]', included: 1000, prepaid: 500, debt: 0 };
const models = [{ id: 'model-1', name: 'Model One', provider: 'hosted', metered: true },
  { id: 'unsafe', metered: false }];
const response = result => ({ ok: true, json: async () => ({ result }) });
function fixture(fetchImpl, extra = {}) {
  return new SupabaseAccountStore({ url: 'https://test.supabase.co', secretKey, models, now: () => now, fetchImpl, ...extra });
}

test('Supabase transport keeps opaque secret in apikey only and never serializes it', async () => {
  let request;
  const store = fixture(async (url, options) => { request = { url, options }; return response({ account: row, reserved: 40 }); });
  const account = await store.account(row.id);
  assert.equal(request.url, 'https://test.supabase.co/rest/v1/rpc/reach_account_store');
  assert.equal(request.options.headers.apikey, secretKey);
  assert.equal(request.options.headers.authorization, undefined, 'new secret keys are not JWT access tokens');
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.options.body), { p_operation: 'account', p_payload: { accountId: row.id, now } });
  assert.doesNotMatch(JSON.stringify(store), /sb_secret/);
  assert.doesNotMatch(JSON.stringify(account), /sb_secret/);
  assert.deepEqual(account.allowance, { includedRemaining: 1000, prepaidRemaining: 500, reserved: 40, totalRemaining: 1500, debt: 0 });
  assert.deepEqual(account.allowedModels, [{ id: 'model-1', name: 'Model One', provider: 'hosted' }]);
});

test('legacy service-role JWT uses bearer header while public/anon keys are rejected', async () => {
  const jwt = role => ['header', Buffer.from(JSON.stringify({ role })).toString('base64url'), 'signature'].join('.');
  let headers;
  const store = fixture(async (_url, options) => { headers = options.headers; return response(null); }, { secretKey: jwt('service_role') });
  await store.findAccountByWallet(wallet);
  assert.equal(headers.authorization, `Bearer ${jwt('service_role')}`);
  for (const key of [jwt('anon'), jwt('authenticated'), 'sb_publishable_example_public_key', secretKey + '\nsecret']) {
    assert.throws(() => fixture(async () => {}, { secretKey: key }), /server-only/);
  }
});

test('transport failures are sanitized and ambiguous mutations are never automatically retried', async () => {
  for (const failure of [
    async () => { throw new Error(`connection failed with ${secretKey}`); },
    async () => ({ ok: false, json: async () => ({ code: 'XX000', message: secretKey, detail: 'private SQL' }) }),
    async () => ({ ok: false, json: async () => { throw new Error(secretKey); } }),
    async () => ({ ok: true, json: async () => ({ unexpected: secretKey }) }),
  ]) {
    let calls = 0;
    const store = fixture(async (...args) => { calls++; return failure(...args); });
    await assert.rejects(store.reserve(row.id, 'request-1', 'model-1', 'fingerprint', 10), error => {
      assert.ok(error instanceof AccountError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'account_store_unavailable');
      assert.doesNotMatch(error.message, /sb_secret|private SQL|connection failed/);
      return true;
    });
    assert.equal(calls, 1, 'an unknown commit result must be reconciled with the stable request ID');
  }
});

test('known database errors map to static contract errors without reflecting diagnostic values', async () => {
  const store = fixture(async () => ({ ok: false, json: async () => ({ code: 'P0001', message: 'idempotency_conflict', details: secretKey }) }));
  await assert.rejects(store.reserve(row.id, 'request-1', 'model-1', 'fingerprint', 10), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'idempotency_conflict');
    assert.equal(error.message, 'Request ID has already been used for different input.');
    return true;
  });
});

test('caller retries preserve the account/request idempotency identity and surface server replay', async () => {
  const calls = [];
  const store = fixture(async (_url, options) => {
    calls.push(JSON.parse(options.body).p_payload);
    return response({ id: 'reservation', status: calls.length === 1 ? 'reserved' : 'settled', replay: calls.length === 1 ? null : { answer: 'saved' }, fresh: calls.length === 1 });
  });
  assert.equal((await store.reserve(row.id, 'stable-request', 'model-1', 'same-input', 10)).fresh, true);
  const replay = await store.reserve(row.id, 'stable-request', 'model-1', 'same-input', 10);
  assert.equal(replay.fresh, false);
  assert.deepEqual(replay.replay, { answer: 'saved' });
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(calls[0].accountId, calls[1].accountId);
  assert.equal(calls[0].fingerprint, calls[1].fingerprint);
});

test('PKCE exchange checks proof locally and sends only hashed proof/session credentials to the RPC', async () => {
  const state = 's'.repeat(43), verifier = 'v'.repeat(43), flowId = 'f'.repeat(64), calls = [];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const store = fixture(async (_url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    return response(request.p_operation === 'get_flow'
      ? { id: flowId, state_hash: hash(state), challenge, expires: now + 300000, account_id: row.id, consumed: 0 }
      : { expiresAt: new Date(now + 3600000).toISOString(), snapshot: { account: row, reserved: 0 } });
  });
  await assert.rejects(store.exchange(flowId, state, 'x'.repeat(43)), error => error.code === 'invalid_proof');
  assert.equal(calls.length, 1, 'invalid proof never invokes mutation');
  const result = await store.exchange(flowId, state, verifier);
  assert.match(result.accessToken, /^rch_session_[a-f0-9]{64}$/);
  const mutation = calls.at(-1);
  assert.equal(mutation.p_payload.sessionHash, hash(result.accessToken));
  const serialized = JSON.stringify(mutation);
  assert.ok(!serialized.includes(result.accessToken));
  assert.ok(!serialized.includes(verifier));
  assert.ok(!serialized.includes(state));
});

test('validation refuses unsafe usage counts and unqualified plan grants before network access', async () => {
  let calls = 0;
  const store = fixture(async () => { calls++; return response(null); });
  await assert.rejects(store.settle('reservation', { totalTokens: 5, promptTokens: 3, completionTokens: 3 }), error => error.code === 'invalid_usage');
  await assert.rejects(store.reserve(row.id, 'request', 'model-1', 'fingerprint', -1), error => error.code === 'invalid_reservation');
  await assert.rejects(store.grantPlan({ wallet, grantId: 'grant-0001', planId: 'pro', name: 'Pro', models: ['unsafe'], tokens: 10, expiresAt: now + 60000 }), error => error.code === 'invalid_grant');
  assert.equal(calls, 0);
});

test('a timed-out RPC fails closed without a retry or leaked abort diagnostic', async () => {
  let calls = 0;
  const store = fixture(async (_url, options) => {
    calls++;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error(secretKey)), { once: true }));
  }, { timeoutMs: 5 });
  // AbortSignal.timeout's timer is unref'ed; retain a bounded test deadline.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(store.account(row.id), error => error.code === 'account_store_unavailable' && !error.message.includes(secretKey));
  } finally { clearTimeout(keepAlive); }
  assert.equal(calls, 1);
});

test('snapshot import requires exact table arrays before any remote mutation', async () => {
  let calls = 0;
  const store = fixture(async (_url, options) => {
    calls++;
    const input = JSON.parse(options.body);
    assert.equal(input.p_operation, 'import_snapshot');
    assert.equal(input.p_payload.snapshot.accounts[0].id, row.id);
    return response({ accounts: 1, flows: 0, challenges: 0, sessions: 0, grants: 0, reservations: 0, redemptions: 0 });
  });
  const snapshot = { accounts: [row], flows: [], challenges: [], sessions: [], grants: [], reservations: [], redemptions: [] };
  for (const invalid of [null, [], {}, { ...snapshot, extra: [] }, { ...snapshot, sessions: null }, { ...snapshot, accounts: ['invalid'] }]) {
    await assert.rejects(store.importSnapshot(invalid), error => error.code === 'invalid_import');
  }
  assert.equal(calls, 0);
  assert.equal((await store.importSnapshot(snapshot)).accounts, 1);
  assert.equal(calls, 1);
});
