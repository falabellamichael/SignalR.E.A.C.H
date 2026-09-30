import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { AccountStore } from '../service/store.mjs';
import { SupabaseAccountStore } from '../service/supabase-store.mjs';

const subscription = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15000000 },
  overageUsdMicrosPerRequest: 10000, proEnabled: false };
const models = [{ id: 'bridge-chat', name: 'Bridge chat', provider: 'fixture', access: 'requests', metered: true, bridge: { kind: 'tray', model: 'chatgpt-chat' } },
  { id: 'legacy-tokens', provider: 'fixture', metered: true },
  { id: 'legacy-usd', provider: 'fixture', metered: true, pricing: { inputUsdMicrosPerMillion: 1000000, outputUsdMicrosPerMillion: 1000000 } }];
const wallet = '0x' + '11'.repeat(20), otherWallet = '0x' + '22'.repeat(20);
const replay = { contentType: 'application/json; charset=utf-8', body: '{"choices":[{"message":{"content":"done"}}]}' };
let pg;
before(async () => {
  pg = await PGlite.create();
  await pg.exec('CREATE ROLE anon NOINHERIT; CREATE ROLE authenticated NOINHERIT; CREATE ROLE service_role NOINHERIT BYPASSRLS;');
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  assert.equal(files.filter(name => name.endsWith('_rch_request_subscription_ledger.sql')).length, 1);
  for (const file of files) await pg.exec(await readFile(new URL(file, directory), 'utf8'));
});
after(async () => { await pg?.close(); });

async function fixture(t, backend) {
  let now = 1_800_000_000_000, unavailableQuota = false;
  let store;
  if (backend === 'sqlite') {
    store = new AccountStore(':memory:', { subscription, models, now: () => now });
    t.after(() => store.close());
  } else {
    await pg.exec('TRUNCATE reach_accounts.accounts CASCADE');
    store = new SupabaseAccountStore({ url: 'https://fixture.supabase.co', secretKey: 'sb_secret_' + '0'.repeat(32),
      subscription, models, now: () => now, fetchImpl: async (url, request) => {
        const endpoint = new URL(url).pathname.endsWith('/reach_request_store') ? 'reach_request_store' : 'reach_account_store';
        const { p_operation, p_payload } = JSON.parse(request.body);
        if (unavailableQuota && p_operation === 'request_allowance') throw new Error('simulated quota read outage');
        try {
          const result = await pg.transaction(async transaction => {
            await transaction.exec('SET LOCAL ROLE service_role');
            const response = await transaction.query(`SELECT public.${endpoint}($1::text,$2::jsonb) AS response`, [p_operation, JSON.stringify(p_payload)]);
            return response.rows[0].response;
          });
          return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ code: error.code, message: error.message }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
      } });
  }
  const account = await store.ensureAccount(wallet);
  const sql = async (sqlite, postgres, values = []) => backend === 'sqlite'
    ? store.db.prepare(sqlite).run(...values) : pg.query(postgres, values);
  return { store, account, backend, sql, advance: amount => { now += amount; }, failQuota: value => { unavailableQuota = value; },
    async basic(version = 'basic-fixture-grant', expiry = now + 3600000) {
      return store.grantPlan({ wallet, grantId: version, planId: 'basic-wallet', name: 'Basic', models: [models[0].id], tokens: 0, expiresAt: expiry });
    },
    async fund(amount, accountId = account.id) {
      await sql('UPDATE accounts SET usd_prepaid=? WHERE id=?', 'UPDATE reach_accounts.accounts SET usd_prepaid=$1 WHERE id=$2', [amount, accountId]);
    },
    async completed(amount) {
      const first = await store.reserveRequest(account.id, 'initialize-period', models[0].id, 'initialize-fingerprint');
      await store.releaseRequest(first.id);
      await sql('UPDATE request_periods SET completed=? WHERE account_id=?', 'UPDATE reach_accounts.request_periods SET completed=$1 WHERE account_id=$2', [amount, account.id]);
    },
  };
}

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: an unfunded wallet receives no Basic grant or legacy token conversion`, async t => {
    const f = await fixture(t, backend);
    assert.deepEqual(await f.store.requestAllowance(f.account.id), { includedLimit: 0, completed: 0, reserved: 0, remaining: 0,
      periodEndsAt: null, overageUsdMicrosPerRequest: 10000, basicActive: false });
    await assert.rejects(async () => f.store.reserveRequest(f.account.id, 'unfunded', models[0].id, 'same'), { code: 'allowance_exhausted' });
    assert.deepEqual((await f.store.account(f.account.id)).allowedModels, []);
    const row = await f.store.accountById(f.account.id);
    assert.equal(row.plan_id, null); assert.equal(row.included, 0); assert.equal(row.prepaid, 0);
  });
  test(`${backend}: Basic includes exactly 1500 completions and snapshots one-cent overage`, async t => {
    const f = await fixture(t, backend); await f.basic(); await f.completed(1499); await f.fund(20000);
    const included = await f.store.reserveRequest(f.account.id, 'last-included', models[0].id, 'included');
    assert.equal((await f.store.requestAllowance(f.account.id)).remaining, 0);
    const paid = await f.store.reserveRequest(f.account.id, 'first-overage', models[0].id, 'paid');
    assert.equal((await f.store.account(f.account.id)).credit.balanceMicros, 10000);
    assert.equal((await f.store.account(f.account.id)).credit.reservedMicros, 10000);
    await f.store.settleRequest(paid.id, replay); await f.store.settleRequest(included.id, replay);
    await f.store.settleRequest(paid.id, replay); await f.store.settleRequest(included.id, replay);
    assert.equal((await f.store.requestAllowance(f.account.id)).completed, 1500);
    assert.equal((await f.store.requestAllowance(f.account.id)).remaining, 0);
    assert.equal((await f.store.account(f.account.id)).credit.reservedMicros, 0);
    const repeated = await f.store.reserveRequest(f.account.id, 'first-overage', models[0].id, 'paid');
    assert.equal(repeated.fresh, false); assert.deepEqual(repeated.replay, replay);
    assert.equal((await f.store.account(f.account.id)).credit.balanceMicros, 10000);
  });
  test(`${backend}: two reservations competing for the last included request cannot overspend`, async t => {
    const f = await fixture(t, backend); await f.basic(); await f.completed(1499);
    const results = await Promise.allSettled(['first', 'second'].map(key =>
      Promise.resolve().then(() => f.store.reserveRequest(f.account.id, key, models[0].id, key))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.code), ['allowance_exhausted']);
    assert.equal((await f.store.requestAllowance(f.account.id)).reserved, 1);
    assert.equal((await f.store.requestAllowance(f.account.id)).remaining, 0);
    const pending = results.find(result => result.status === 'fulfilled').value;
    await f.store.settleRequest(pending.id, replay);
    assert.equal((await f.store.requestAllowance(f.account.id)).completed, 1500);
  });
  test(`${backend}: disabled and malformed bridges are never eligible and catalog exposes only request prices`, async t => {
    const f = await fixture(t, backend); await f.basic();
    const disabled = { ...models[0], id: 'disabled', metered: false };
    const malformed = { ...models[0], id: 'malformed', bridge: { kind: 'tray', model: 'unapproved-model' } };
    const ambiguous = { ...models[0], id: 'default-agent', bridge: { kind: 'tray', model: 'codegpt-eco-gpt-4o-mini' } };
    f.store.models = [...models, disabled, malformed, ambiguous];
    for (const model of [disabled, malformed, ambiguous]) await assert.rejects(async () =>
      f.store.reserveRequest(f.account.id, model.id, model.id, 'fingerprint'), { code: 'model_not_entitled' });
    const catalog = (await f.store.account(f.account.id)).allowedModels;
    assert.deepEqual(catalog.map(model => model.id), [models[0].id]);
    assert.deepEqual(catalog[0].pricing, { unit: 'request', includedRequests: 1500, usdMicrosPerRequest: 10000 });
    assert.deepEqual(catalog[0].capabilities, { outputTokenLimit: false });
    assert.equal(catalog[0].access, 'requests'); assert.equal(Object.hasOwn(catalog[0], 'bridge'), false);
    assert.equal((await f.store.requestAllowance(f.account.id)).reserved, 0);
  });
  test(`${backend}: an active Pro plan receives no included requests and only funded USD can pay`, async t => {
    const f = await fixture(t, backend);
    await f.store.grantPlan({ wallet, grantId: 'legacy-pro-grant', planId: 'pro', name: 'Pro',
      models: [models[0].id], tokens: 5000, expiresAt: 1_800_003_600_000 });
    assert.equal((await f.store.requestAllowance(f.account.id)).includedLimit, 0);
    await assert.rejects(async () => f.store.reserveRequest(f.account.id, 'pro-unfunded', models[0].id, 'fingerprint'), { code: 'allowance_exhausted' });
    await f.fund(10000);
    const paid = await f.store.reserveRequest(f.account.id, 'pro-funded', models[0].id, 'fingerprint');
    await f.store.settleRequest(paid.id, replay);
    const account = await f.store.account(f.account.id);
    assert.equal(account.requestAllowance.completed, 0); assert.equal(account.credit.balanceMicros, 0);
    assert.equal(account.allowance.totalRemaining, 5000);
  });
  test(`${backend}: pending keys are stable, conflicting input rejects and failure releases slots`, async t => {
    const f = await fixture(t, backend); await f.basic();
    const pending = await f.store.reserveRequest(f.account.id, 'pending', models[0].id, 'fingerprint');
    assert.equal((await f.store.reserveRequest(f.account.id, 'pending', models[0].id, 'fingerprint')).fresh, false);
    await assert.rejects(async () => f.store.reserveRequest(f.account.id, 'pending', models[0].id, 'different'), { code: 'idempotency_conflict' });
    assert.equal((await f.store.requestAllowance(f.account.id)).reserved, 1);
    await f.store.releaseRequest(pending.id); await f.store.releaseRequest(pending.id);
    assert.equal((await f.store.requestAllowance(f.account.id)).remaining, 1500);
    assert.equal((await f.store.requestAllowance(f.account.id)).completed, 0);
    const retry = await f.store.reserveRequest(f.account.id, 'pending', models[0].id, 'fingerprint');
    assert.equal(retry.id, pending.id); assert.equal(retry.fresh, true);
    await f.store.markRequestUncertain(retry.id, 'completion_unknown');
    await assert.rejects(async () => f.store.releaseRequest(retry.id), { code: 'reservation_closed' });
    assert.equal((await f.store.requestAllowance(f.account.id)).reserved, 1);
  });
  test(`${backend}: pay-as-you-go spends one cent once; known failure refunds and debt rejects`, async t => {
    const f = await fixture(t, backend); await f.fund(10000);
    const pending = await f.store.reserveRequest(f.account.id, 'paid', models[0].id, 'paid');
    await assert.rejects(async () => f.store.reserveRequest(f.account.id, 'too-many', models[0].id, 'other'), { code: 'allowance_exhausted' });
    await f.store.releaseRequest(pending.id);
    assert.equal((await f.store.account(f.account.id)).credit.balanceMicros, 10000);
    const retry = await f.store.reserveRequest(f.account.id, 'paid', models[0].id, 'paid');
    await f.store.settleRequest(retry.id, { contentType: 'text/event-stream', body: 'data: {"choices":[]}\n\ndata: [DONE]\n\n' });
    assert.equal((await f.store.account(f.account.id)).credit.balanceMicros, 0);
    assert.equal((await f.store.reserveRequest(f.account.id, 'paid', models[0].id, 'paid')).status, 'settled');
    await f.fund(20000);
    await f.sql('UPDATE accounts SET usd_debt=1 WHERE id=?', 'UPDATE reach_accounts.accounts SET usd_debt=1 WHERE id=$1', [f.account.id]);
    await assert.rejects(async () => f.store.reserveRequest(f.account.id, 'debt', models[0].id, 'debt'), { code: 'usage_debt' });
  });
  test(`${backend}: renewal and expiry never reuse or refund an earlier included period`, async t => {
    const f = await fixture(t, backend); await f.basic();
    const first = await f.store.reserveRequest(f.account.id, 'old-success', models[0].id, 'old-success');
    const second = await f.store.reserveRequest(f.account.id, 'old-failed', models[0].id, 'old-failed');
    await f.basic('renewed-basic-grant');
    await f.store.settleRequest(first.id, replay); await f.store.releaseRequest(second.id);
    assert.equal((await f.store.requestAllowance(f.account.id)).completed, 0);
    assert.equal((await f.store.requestAllowance(f.account.id)).remaining, 1500);
    f.advance(3600001);
    assert.equal((await f.store.requestAllowance(f.account.id)).basicActive, false);
    await assert.rejects(async () => f.store.reserveRequest(f.account.id, 'expired', models[0].id, 'expired'), { code: 'allowance_exhausted' });
  });
  test(`${backend}: account isolation, unknown replay, and cross-ledger keys fail closed`, async t => {
    const f = await fixture(t, backend); await f.basic(); await f.fund(10000);
    const other = await f.store.ensureAccount(otherWallet);
    const pending = await f.store.reserveRequest(f.account.id, 'shared-key', models[0].id, 'shared');
    await assert.rejects(async () => f.store.reserveRequest(other.id, 'shared-key', models[0].id, 'shared'), { code: 'allowance_exhausted' });
    await assert.rejects(async () => f.store.settleRequest(pending.id, null), { code: 'invalid_replay' });
    assert.equal((await f.store.requestAllowance(f.account.id)).completed, 0);
    await assert.rejects(async () => f.store.reserveUsd(f.account.id, 'shared-key', 'legacy-usd', 'shared', { promptTokens: 1, completionTokens: 1 }), { code: 'idempotency_conflict' });
    const legacy = await f.store.reserveUsd(f.account.id, 'legacy-key', 'legacy-usd', 'legacy', { promptTokens: 1, completionTokens: 1 });
    await assert.rejects(async () => f.store.reserveRequest(f.account.id, 'legacy-key', models[0].id, 'legacy'), { code: 'idempotency_conflict' });
    await f.store.release(legacy.id);
    assert.equal((await f.store.unsettledReservations(f.account.id)).some(r => r.id === pending.id && r.currency === 'requests'), true);
  });
  test(`${backend}: request and legacy USD holds share the same wallet without hiding either reservation`, async t => {
    const f = await fixture(t, backend); await f.fund(20000);
    const paid = await f.store.reserveRequest(f.account.id, 'request-held', models[0].id, 'request');
    const legacy = await f.store.reserveUsd(f.account.id, 'legacy-held', 'legacy-usd', 'legacy', { promptTokens: 1, completionTokens: 1 });
    assert.deepEqual((await f.store.account(f.account.id)).credit, { currency: 'USD', balanceMicros: 9998, reservedMicros: 10002, debtMicros: 0 });
    await f.store.releaseRequest(paid.id); await f.store.release(legacy.id);
    assert.deepEqual((await f.store.account(f.account.id)).credit, { currency: 'USD', balanceMicros: 20000, reservedMicros: 0, debtMicros: 0 });
  });
}

test('PostgreSQL private request tables and both RPCs deny public roles', async () => {
  const permissions = await pg.query("SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='reach_accounts' AND tablename LIKE 'request_%' ORDER BY tablename");
  assert.equal(permissions.rows.length, 2); assert.ok(permissions.rows.every(row => row.rowsecurity));
  for (const role of ['anon','authenticated']) for (const statement of [
    'SELECT * FROM reach_accounts.request_periods', 'SELECT * FROM reach_accounts.request_reservations',
    "SELECT public.reach_request_store('request_allowance','{}'::jsonb)", "SELECT public.reach_account_store('account','{}'::jsonb)",
  ]) await assert.rejects(pg.transaction(async transaction => {
    await transaction.exec(`SET LOCAL ROLE ${role}`); await transaction.exec(statement);
  }), error => error.code === '42501');
});

test('request RLS still denies client rows if table grants are accidentally added', async t => {
  const f = await fixture(t, 'postgres'); await f.basic();
  await f.store.reserveRequest(f.account.id, 'rls-pending', models[0].id, 'fingerprint');
  for (const role of ['anon', 'authenticated']) await pg.transaction(async transaction => {
    await transaction.exec(`GRANT USAGE ON SCHEMA reach_accounts TO ${role}; GRANT SELECT,UPDATE,DELETE ON reach_accounts.request_periods,reach_accounts.request_reservations TO ${role}`);
    await transaction.exec(`SET LOCAL ROLE ${role}`);
    assert.equal((await transaction.query('SELECT * FROM reach_accounts.request_periods')).rows.length, 0);
    assert.equal((await transaction.query('SELECT * FROM reach_accounts.request_reservations')).rows.length, 0);
    assert.equal((await transaction.query("UPDATE reach_accounts.request_periods SET completed=1500 RETURNING account_id")).rows.length, 0);
    assert.equal((await transaction.query('DELETE FROM reach_accounts.request_reservations RETURNING id')).rows.length, 0);
    await transaction.exec('RESET ROLE');
    await transaction.exec(`REVOKE SELECT,UPDATE,DELETE ON reach_accounts.request_periods,reach_accounts.request_reservations FROM ${role}; REVOKE USAGE ON SCHEMA reach_accounts FROM ${role}`);
  });
  assert.equal((await f.store.requestAllowance(f.account.id)).reserved, 1);
});

test('actual request SQL rejects malformed replay and policy even when adapter checks are bypassed', async t => {
  const f = await fixture(t, 'postgres'); await f.basic();
  const pending = await f.store.reserveRequest(f.account.id, 'sql-validation', models[0].id, 'fingerprint');
  for (const record of [null, {}, { contentType: 'text/event-stream' }, { contentType: 'text/html', body: 'unsafe' }]) {
    await assert.rejects(f.store._requestRpc('settle_request', { reservationId: pending.id, replay: JSON.stringify(record) }), { code: 'invalid_replay' });
  }
  const malformed = structuredClone(subscription); malformed.overageUsdMicrosPerRequest = 0;
  await assert.rejects(f.store._rpc('reserve_request', { accountId: f.account.id, requestId: 'bad-price', model: models[0].id,
    fingerprint: 'bad-price', reservationId: randomBytes(32).toString('hex'), modelQualified: true, subscription: malformed },
  f.store.endpoint.replace(/reach_account_store$/, 'reach_request_store')), { code: 'model_not_entitled' });
  assert.equal((await f.store.requestAllowance(f.account.id)).completed, 0);
  assert.equal((await f.store.requestAllowance(f.account.id)).reserved, 1);
});

test('a committed Supabase sign-in still delivers its session during a quota read outage', async t => {
  const f = await fixture(t, 'postgres'); await f.basic();
  const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url');
  const flow=await f.store.startFlow(state,createHash('sha256').update(verifier).digest('base64url'));
  const challenge=await f.store.challenge(flow.flowId,wallet,(...args)=>args.join('|'));
  await f.store.authorize(flow.flowId,challenge.challengeId);
  f.failQuota(true);
  const result=await f.store.exchange(flow.flowId,state,verifier);
  assert.match(result.accessToken,/^rch_session_/); assert.equal(typeof result.account.then,'undefined');
  assert.deepEqual(result.account.allowedModels,[]); assert.equal(result.account.requestAllowance.status,'unavailable');
  assert.equal(result.account.requestAllowance.basicActive,false); assert.equal(result.account.requestAllowance.remaining,0);
  f.failQuota(false);
  const recovered=await f.store.authenticate(result.accessToken);
  assert.equal(recovered.requestAllowance.basicActive,true); assert.equal(recovered.requestAllowance.remaining,1500);
  assert.deepEqual(recovered.allowedModels.map(m=>m.id),[models[0].id]);
});

test('SQLite request reservations and replay survive restart without altering token balances', async t => {
  const directory=await mkdtemp(join(tmpdir(),'rch-request-ledger-'));
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const path=join(directory,'accounts.sqlite');
  let store=new AccountStore(path,{subscription,models});
  const account=store.grantPlan({wallet,grantId:'durable-basic-grant',planId:'basic',name:'Basic',models:[models[0].id],tokens:0,expiresAt:Date.now()+3600000});
  const pending=store.reserveRequest(account.id,'durable-request',models[0].id,'fingerprint');
  store.settleRequest(pending.id,replay);store.close();
  store=new AccountStore(path,{subscription,models});
  assert.deepEqual(store.reserveRequest(account.id,'durable-request',models[0].id,'fingerprint').replay,replay);
  assert.equal(store.requestAllowance(account.id).completed,1);
  assert.equal(store.account(account.id).allowance.totalRemaining,0); assert.equal(store.account(account.id).credit.balanceMicros,0);
});
