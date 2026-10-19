import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pgliteStores } from './helpers/pglite-store.mjs';
import { accountAccess } from '../service/eligibility.mjs';
import { PLUS_DEFAULTS } from '../service/payments/plus.mjs';

const example = JSON.parse(readFileSync(new URL('../config/subscription-bridges.example.json', import.meta.url)));
const models = [example.models.find(model => model.metered)];
const subscription = { ...example.subscription, plus: { ...PLUS_DEFAULTS } };
const pg = pgliteStores({ requiredMigration: '_rch_admin_subscription.sql' });
const replay = { contentType: 'application/json; charset=utf-8', body: '{"answer":"OK"}' };

async function fixture() {
  const f = await pg.fresh({ models, subscription });
  const admin = await f.store.ensureEmailAccount('admin@example.test');
  const customer = await f.store.ensureEmailAccount('customer@example.test');
  const setAdmin = enabled => pg.query('UPDATE reach_accounts.accounts SET role=$1 WHERE id=$2', [enabled ? 'admin' : 'user', admin.id]);
  return { ...f, admin, customer, setAdmin };
}

test('private admin role automatically grants a non-expiring subscription without altering paid plans or balances', async () => {
  const f = await fixture();
  await f.setCredit({ accountId: f.admin.id, prepaid: 123456, debt: 0 });
  const before = await f.store.accountById(f.admin.id);
  await f.setAdmin(true);
  const view = await f.store.account(f.admin.id);
  assert.equal(view.role, 'admin');
  assert.deepEqual(view.plan, { id: 'admin', name: 'REACH Admin', status: 'active', expiresAt: null, complimentary: true });
  assert.equal(accountAccess(view).website, true);
  assert.equal(accountAccess(view).apiKeyCreation, true);
  assert.deepEqual(view.allowedModels.map(model => model.id), models.map(model => model.id));
  assert.equal(view.requestAllowance.adminActive, true);
  assert.equal(view.requestAllowance.unlimited, true);
  assert.equal(view.requestAllowance.periodEndsAt, null);
  assert.equal(view.credit.balanceMicros, before.usd_prepaid);
  const after = await f.store.accountById(f.admin.id);
  assert.deepEqual({ ...after, role: before.role }, before);
  assert.deepEqual(await f.store.listPayments(f.admin.id), []);
  f.clock.now += 10 * 365 * 86400000;
  assert.equal((await f.store.account(f.admin.id)).plan.status, 'active');
  assert.equal((await f.store.requestAllowance(f.admin.id)).unlimited, true);
  const customer = await f.store.account(f.customer.id);
  assert.equal(customer.role, 'user');
  assert.equal(customer.plan.status, 'none');
  assert.deepEqual(customer.allowedModels, []);
});

test('admin requests reuse unlimited accounting, replay and tenant isolation without spending credit', async () => {
  const f = await fixture();
  await f.setAdmin(true);
  await f.setCredit({ accountId: f.admin.id, prepaid: 123456, debt: 0 });
  const request = await f.store.reserveRequest(f.admin.id, 'admin-request', models[0].id, 'fp');
  await f.store.settleRequest(request.id, replay);
  await f.store.settleRequest(request.id, replay);
  const retry = await f.store.reserveRequest(f.admin.id, 'admin-request', models[0].id, 'fp');
  assert.equal(retry.fresh, false);
  assert.deepEqual(retry.replay, replay);
  await assert.rejects(() => f.store.reserveRequest(f.admin.id, 'admin-request', models[0].id, 'different'), { code: 'idempotency_conflict' });
  await assert.rejects(() => f.store.reserveRequest(f.customer.id, 'admin-request', models[0].id, 'fp'), { code: 'allowance_exhausted' });
  const account = await f.store.account(f.admin.id);
  assert.equal(account.requestAllowance.completed, 1);
  assert.equal(account.requestAllowance.remaining, null);
  assert.equal(account.requestAllowance.overageUsdMicrosPerRequest, 0);
  assert.equal(account.credit.balanceMicros, 123456);
  assert.deepEqual(await f.store.listPayments(f.admin.id), []);
});

test('demotion immediately removes complimentary access and restores the underlying plan', async () => {
  const f = await fixture();
  await f.setAdmin(true);
  const key = await f.store.createApiKey(f.admin.id, 'Admin test');
  assert.equal((await f.store.authenticateApiKey(key.key)).role, 'admin');
  const pending = await f.store.reserveRequest(f.admin.id, 'pending', models[0].id, 'fp');
  const released = await f.store.reserveRequest(f.admin.id, 'released', models[0].id, 'fp');
  await f.store.releaseRequest(released.id);
  await f.setAdmin(false);
  const account = await f.store.authenticateApiKey(key.key);
  assert.equal(account.role, 'user');
  assert.equal(account.plan.status, 'none');
  assert.equal(accountAccess(account).website, false);
  assert.deepEqual(account.allowedModels, []);
  await assert.rejects(() => f.store.createApiKey(f.admin.id, 'No longer admin'), { code: 'api_key_ineligible' });
  await assert.rejects(() => f.store.reserveRequest(f.admin.id, 'new', models[0].id, 'fp'), { code: 'allowance_exhausted' });
  await assert.rejects(() => f.store.reserveRequest(f.admin.id, 'released', models[0].id, 'fp'), { code: 'subscription_expired' });
  await f.store.settleRequest(pending.id, replay);
  await pg.query("UPDATE reach_accounts.accounts SET plan_id='basic-wallet',plan_name='Basic',plan_version='paid-basic',plan_expires=$1 WHERE id=$2", [f.clock.now + 86400000, f.admin.id]);
  await f.setAdmin(true);
  assert.equal((await f.store.account(f.admin.id)).plan.id, 'admin');
  await f.setAdmin(false);
  assert.equal((await f.store.account(f.admin.id)).plan.id, 'basic-wallet');
  assert.equal((await f.store.requestAllowance(f.admin.id)).basicActive, true);
});

test('admin failure recovery preserves uncertainty, model qualification and debt guards', async () => {
  const f = await fixture();
  await f.setAdmin(true);
  const request = await f.store.reserveRequest(f.admin.id, 'retry', models[0].id, 'fp');
  await f.store.releaseRequest(request.id);
  assert.equal((await f.store.reserveRequest(f.admin.id, 'retry', models[0].id, 'fp')).id, request.id);
  await f.store.markRequestUncertain(request.id);
  await assert.rejects(() => f.store.releaseRequest(request.id), { code: 'reservation_closed' });
  assert.equal((await f.store.unsettledReservations(f.admin.id)).length, 1);
  await assert.rejects(() => f.store.reserveRequest(f.admin.id, 'wrong-model', 'unknown', 'fp'), { code: 'model_not_entitled' });
  await f.setCredit({ accountId: f.admin.id, prepaid: 0, debt: 1 });
  await assert.rejects(() => f.store.reserveRequest(f.admin.id, 'debt', models[0].id, 'fp'), { code: 'usage_debt' });
});

test('browser roles cannot change admin status or call the private entitlement functions', async () => {
  const f = await fixture();
  const permissions = (await pg.query(`SELECT
    has_column_privilege('anon','reach_accounts.accounts','role','UPDATE') AS anon_update,
    has_column_privilege('authenticated','reach_accounts.accounts','role','UPDATE') AS user_update,
    has_function_privilege('authenticated','public.reach_request_store(text,jsonb)','EXECUTE') AS request_call,
    has_function_privilege('authenticated','public.reach_api_key_store(text,jsonb)','EXECUTE') AS key_call,
    has_function_privilege('authenticated','reach_accounts.request_store_before_sources(text,jsonb)','EXECUTE') AS private_call,
    (SELECT relrowsecurity FROM pg_class WHERE oid='reach_accounts.accounts'::regclass) AS rls`)).rows[0];
  assert.deepEqual(permissions, { anon_update: false, user_update: false, request_call: false, key_call: false, private_call: false, rls: true });
  await assert.rejects(() => pg.query("UPDATE reach_accounts.accounts SET role='owner' WHERE id=$1", [f.admin.id]));
  await assert.rejects(() => f.store.createApiKey(f.customer.id, 'Customer'), { code: 'api_key_ineligible' });
});
