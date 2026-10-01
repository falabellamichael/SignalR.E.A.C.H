import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { getAddress } from 'ethers';
import { SupabaseAccountStore } from '../service/supabase-store.mjs';
import { AccountStore } from '../service/store.mjs';
import { readAccountSnapshot } from '../service/account-import.mjs';

// These are PostgreSQL compatibility tests for the existing token ledger. They
// execute the migration itself and the real adapter; they do not model live
// provider prices or prove multi-session lock scheduling in hosted Postgres.
const wallet = getAddress(`0x${'11'.repeat(20)}`);
const otherWallet = getAddress(`0x${'22'.repeat(20)}`);
const models = [{ id: 'measured/model', name: 'Measured', provider: 'fixture', metered: true },
  { id: 'measured/other', name: 'Other', provider: 'fixture', metered: true }];
const txHash = `0x${'33'.repeat(32)}`;
let db, privateSchema, tables, now, store;
const identifier = value => { assert.match(value, /^[a-z_][a-z0-9_]*$/); return `"${value}"`; };

before(async () => {
  db = await PGlite.create();
  await db.exec('CREATE ROLE anon NOINHERIT; CREATE ROLE authenticated NOINHERIT; CREATE ROLE service_role NOINHERIT BYPASSRLS;');
  // The test lives under RCH/test, two levels below the repository root.
  const rootDirectory = new URL('../../supabase/migrations/', import.meta.url);
  const migrationFiles = (await readdir(rootDirectory)).filter(name => name.endsWith('_reach_shared_subscription_accounts.sql'));
  assert.equal(migrationFiles.length, 1, 'use the committed account-ledger migration, not a test-only SQL implementation');
  const migration = await readFile(new URL(migrationFiles[0], rootDirectory), 'utf8');
  assert.ok(migration.trim(), 'the account migration must contain executable SQL');
  await db.exec(migration);
  await db.exec(await readFile(new URL('20260928041723_rch_prepaid_access.sql', rootDirectory), 'utf8'));
  await db.exec(await readFile(new URL('20260928042248_rch_prepaid_overage.sql', rootDirectory), 'utf8'));
  await db.exec(await readFile(new URL('20260928050119_rch_market_usd_ledger.sql', rootDirectory), 'utf8'));
  const schemas = await db.query("SELECT schemaname FROM pg_tables WHERE tablename = 'accounts' AND schemaname NOT IN ('public','pg_catalog','information_schema')");
  assert.equal(schemas.rows.length, 1, 'financial account tables belong in one private schema');
  privateSchema = schemas.rows[0].schemaname;
  tables = (await db.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [privateSchema])).rows.map(row => row.tablename);
  assert.ok(tables.includes('reservations') && tables.includes('redemptions'));
});
after(async () => { await db?.close(); });

async function asRole(role, callback) {
  return db.transaction(async transaction => {
    await transaction.exec(`SET LOCAL ROLE ${identifier(role)}`);
    return callback(transaction);
  });
}
beforeEach(async () => {
  await db.exec(`TRUNCATE ${tables.map(table => `${identifier(privateSchema)}.${identifier(table)}`).join(', ')} CASCADE`);
  now = 1_800_000_000_000;
  store = new SupabaseAccountStore({ url: 'https://ledger-fixture.supabase.co', secretKey: 'sb_secret_local_test_only_0000000000', models, now: () => now,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, '/rest/v1/rpc/reach_account_store');
      const { p_operation, p_payload } = JSON.parse(options.body);
      try {
        const result = await asRole('service_role', async transaction => {
          const response = await transaction.query('SELECT public.reach_account_store($1::text,$2::jsonb) AS response', [p_operation, JSON.stringify(p_payload)]);
          return response.rows[0].response;
        });
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      } catch (error) {
        if (error.code !== 'P0001') console.error('Unexpected ledger SQL failure:', error.code, error.message);
        return new Response(JSON.stringify({ code: error.code, message: error.message }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    } });
});
const grant = (tokens = 100, grantId = 'initial-plan-grant', address = wallet) => store.grantPlan({ wallet: address, grantId,
  planId: 'pro', name: 'Pro', models: [models[0].id], tokens, expiresAt: now + 3_600_000 });
const usage = total => ({ promptTokens: total, completionTokens: 0, totalTokens: total, provider: 'fixture', model: models[0].id });
const proof = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, state: randomBytes(32).toString('base64url'), challenge: createHash('sha256').update(verifier).digest('base64url') };
};
async function pendingCredit(accountId, tokens = 10) {
  const intent = await store.createRedemption(accountId, (BigInt(tokens) * 10n ** 12n).toString(), tokens);
  await store.submitRedemption(intent.redemptionId, intent.ticket, txHash);
  return intent;
}

test('actual SQL wallet flows enforce challenge replacement, proof keys, single use and revocation', async () => {
  const p = proof();
  const flow = await store.startFlow(p.state, p.challenge);
  assert.equal(await store.exchange(flow.flowId, p.state, p.verifier), null);
  const first = await store.challenge(flow.flowId, wallet, (...args) => args.join('|'));
  const next = await store.challenge(flow.flowId, wallet, (...args) => args.join('|'));
  await assert.rejects(store.getChallenge(flow.flowId, first.challengeId), { code: 'challenge_expired' });
  await assert.rejects(store.exchange(flow.flowId, 'x'.repeat(43), p.verifier), { code: 'invalid_proof' });
  const accountId = await store.authorize(flow.flowId, next.challengeId);
  await assert.rejects(store.authorize(flow.flowId, next.challengeId), { code: 'challenge_expired' });
  const session = await store.exchange(flow.flowId, p.state, p.verifier);
  assert.equal(session.account.id, accountId);
  assert.equal(session.account.walletAddress, wallet);
  assert.equal((await store.authenticate(session.accessToken)).id, accountId);
  assert.equal((await store.ensureAccount(wallet)).id, accountId, 'a wallet maps to the same account across sessions');
  await assert.rejects(store.exchange(flow.flowId, p.state, p.verifier), { code: 'flow_expired' });
  const secrets = await db.query(`SELECT hash FROM ${identifier(privateSchema)}.sessions`);
  assert.equal(secrets.rows.length, 1);
  assert.equal(secrets.rows[0].hash.includes(session.accessToken), false);
  await store.logout(session.accessToken);
  await assert.rejects(store.authenticate(session.accessToken), { code: 'session_expired' });
});

test('actual SQL prunes expired authentication without discarding financial records', async () => {
  const account = await grant();
  const reservation = await store.reserve(account.id, 'retained-hold', models[0].id, 'input', 20);
  const p = proof();
  const flow = await store.startFlow(p.state, p.challenge);
  await store.challenge(flow.flowId, wallet, () => 'A signed message');
  now += 600_001;
  await store.pruneExpiredAuthentication();
  await assert.rejects(store.getFlow(flow.flowId), { code: 'flow_expired' });
  assert.equal((await store.unsettledReservations(account.id))[0].id, reservation.id);
  assert.equal((await store.account(account.id)).allowance.reserved, 20);
});

test('actual SQL plan grants are idempotent and reject conflicting replay without changing balances', async () => {
  const first = await grant();
  assert.deepEqual(await grant(), first);
  await assert.rejects(grant(900), { code: 'grant_conflict' });
  assert.equal((await store.account(first.id)).allowance.includedRemaining, 100);
  assert.equal((await store.findAccountByWallet(wallet)).id, first.id);
  assert.equal(await store.findAccountByWallet(otherWallet), null);
});

test('actual SQL shared reservations reject overspending and settle or replay exactly once', async () => {
  const account = await grant();
  const attempts = await Promise.allSettled([
    store.reserve(account.id, 'first', models[0].id, 'first-input', 60),
    store.reserve(account.id, 'second', models[0].id, 'second-input', 60),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'allowance_exhausted');
  const winner = attempts[0].status === 'fulfilled' ? 'first' : 'second';
  const reservation = attempts.find(result => result.status === 'fulfilled').value;
  assert.equal((await store.account(account.id)).allowance.reserved, 60);
  assert.equal((await store.reserve(account.id, winner, models[0].id, `${winner}-input`, 60)).fresh, false);
  await assert.rejects(store.reserve(account.id, winner, models[0].id, 'different-input', 60), { code: 'idempotency_conflict' });
  const replay = { contentType: 'application/json', body: '{"answer":"complete"}' };
  await store.settle(reservation.id, usage(10), replay);
  await store.settle(reservation.id, usage(10), replay);
  assert.equal((await store.account(account.id)).allowance.includedRemaining, 90);
  assert.equal((await store.account(account.id)).allowance.reserved, 0);
  const repeated = await store.reserve(account.id, winner, models[0].id, `${winner}-input`, 60);
  assert.equal(repeated.status, 'settled');
  assert.deepEqual(repeated.replay, replay);
});

test('actual SQL retains uncertain holds, protects renewed allowance and reuses only released requests', async () => {
  const account = await grant();
  const old = await store.reserve(account.id, 'old-period', models[0].id, 'input', 80);
  await grant(200, 'renewed-plan-grant');
  await store.settle(old.id, usage(10));
  assert.equal((await store.account(account.id)).allowance.includedRemaining, 200, 'a refund from the old plan cannot inflate the new plan');
  const uncertain = await store.reserve(account.id, 'uncertain', models[0].id, 'input', 50);
  await store.markUncertain(uncertain.id);
  await assert.rejects(store.release(uncertain.id), { code: 'reservation_closed' });
  assert.equal((await store.account(account.id)).allowance.reserved, 50);
  await store.settle(uncertain.id, usage(5));
  const released = await store.reserve(account.id, 'not-dispatched', models[0].id, 'same-input', 40);
  await store.release(released.id);
  await store.release(released.id);
  assert.equal((await store.account(account.id)).allowance.includedRemaining, 195);
  const retry = await store.reserve(account.id, 'not-dispatched', models[0].id, 'same-input', 40);
  assert.equal(retry.fresh, true);
  assert.equal((await store.account(account.id)).allowance.reserved, 40);
});

test('actual SQL redemption pays usage debt before prepaid credit and prevents event reuse atomically', async () => {
  const account = await grant();
  const reservation = await store.reserve(account.id, 'overage', models[0].id, 'input', 60);
  await store.settle(reservation.id, usage(110));
  assert.equal((await store.account(account.id)).allowance.debt, 10);
  await assert.rejects(store.reserve(account.id, 'blocked-by-debt', models[0].id, 'input', 1), { code: 'usage_debt' });
  const first = await pendingCredit(account.id, 30);
  await store.creditRedemption(first.redemptionId, '31337:fixture-transaction:0');
  await store.creditRedemption(first.redemptionId, '31337:fixture-transaction:0');
  const balance = (await store.account(account.id)).allowance;
  assert.equal(balance.debt, 0);
  assert.equal(balance.prepaidRemaining, 20);
  const second = await pendingCredit(account.id, 50);
  await assert.rejects(store.creditRedemption(second.redemptionId, '31337:fixture-transaction:0'), { code: 'event_conflict' });
  assert.equal((await store.account(account.id)).allowance.prepaidRemaining, 20, 'the failing event claim rolls back its balance mutation');
  assert.equal((await store.getRedemption(second.redemptionId, second.ticket)).status, 'pending');
  await assert.rejects(store.getRedemption(second.redemptionId, '0'.repeat(64)), { code: 'redemption_missing' });
  now += 3_600_001;
  await store.creditRedemption(second.redemptionId, '31337:fixture-transaction:1');
  assert.equal((await store.account(account.id)).allowance.prepaidRemaining, 70, 'already submitted redemption survives plan expiry');
  assert.equal((await store.account(account.id)).allowance.totalRemaining, 70, 'redeemed credit remains usable after plan expiry');
});

test('actual SQL starts metered access from a verified redemption without a plan', async () => {
  const account = await store.ensureAccount(wallet);
  assert.equal((await store.account(account.id)).plan.status, 'none');
  const intent = await pendingCredit(account.id, 50);
  await store.creditRedemption(intent.redemptionId, '31337:no-plan-redemption:0');
  const credited = await store.account(account.id);
  assert.equal(credited.allowance.totalRemaining, 50);
  assert.deepEqual(credited.allowedModels.map(model => model.id), models.map(model => model.id));
  const held = await store.reserve(account.id, 'prepaid-only', models[0].id, 'request', 40);
  await store.settle(held.id, usage(10));
  assert.equal((await store.account(account.id)).allowance.totalRemaining, 40);
});

test('actual SQL charges prepaid rather than restricted plan allowance for another model', async () => {
  const account = await grant();
  const intent = await pendingCredit(account.id, 100);
  await store.creditRedemption(intent.redemptionId, '31337:other-model-credit:0');
  const held = await store.reserve(account.id, 'other-model-overage', models[1].id, 'request', 20);
  await store.settle(held.id, { ...usage(30), model: models[1].id });
  const balance = (await store.account(account.id)).allowance;
  assert.equal(balance.includedRemaining, 100);
  assert.equal(balance.prepaidRemaining, 70);
});

async function prepaidRefundBeyondCreditCap(ledger) {
  const cap = 1_000_000_000_000;
  const account = await ledger.grantPlan({ wallet, grantId: 'refund-cap-plan', planId: 'pro', name: 'Pro',
    models: [models[0].id], tokens: 0, expiresAt: now + 3_600_000 });
  async function credit(tokens, event) {
    const intent = await ledger.createRedemption(account.id, (BigInt(tokens) * 10n ** 12n).toString(), tokens);
    await ledger.submitRedemption(intent.redemptionId, intent.ticket, txHash);
    await ledger.creditRedemption(intent.redemptionId, event);
  }
  await credit(cap, 'initial-cap-credit');
  const released = await ledger.reserve(account.id, 'refund-release', models[0].id, 'input-a', 40);
  const settled = await ledger.reserve(account.id, 'refund-settlement', models[0].id, 'input-b', 30);
  await credit(70, 'restore-available-credit-cap');
  await ledger.release(released.id);
  assert.equal((await ledger.account(account.id)).allowance.prepaidRemaining, cap + 40,
    'returning an existing hold must preserve funds even after new credit fills the available balance');
  await ledger.settle(settled.id, usage(10));
  assert.equal((await ledger.account(account.id)).allowance.prepaidRemaining, cap + 60);
  assert.equal((await ledger.account(account.id)).allowance.reserved, 0);
  await assert.rejects(credit(1, 'new-credit-above-cap'), { code: 'credit_limit' });
  assert.equal((await ledger.account(account.id)).allowance.prepaidRemaining, cap + 60,
    'the credit-time cap still rejects new credit and leaves refunded balances intact');
  return account;
}

test('SQL matches SQLite when prepaid hold refunds exceed the new-credit cap', async () => {
  const sqlite = new AccountStore(':memory:', { models, now: () => now });
  try { await prepaidRefundBeyondCreditCap(sqlite); }
  finally { sqlite.close(); }
  await prepaidRefundBeyondCreditCap(store);
});

test('snapshot import preserves a legitimate SQLite prepaid refund above the credit cap', async () => {
  const sqlite = new AccountStore(':memory:', { models, now: () => now });
  try {
    const original = await prepaidRefundBeyondCreditCap(sqlite);
    const names = ['accounts', 'flows', 'challenges', 'sessions', 'grants', 'reservations', 'redemptions'];
    await store.importSnapshot(Object.fromEntries(names.map(name => [name, sqlite.db.prepare(`SELECT * FROM ${name}`).all()])));
    const restored = await store.account(original.id);
    assert.equal(restored.allowance.prepaidRemaining, 1_000_000_000_060);
    assert.equal(restored.allowance.reserved, 0);
  } finally { sqlite.close(); }
});

test('actual SQL rejects malformed settlement even when bypassing adapter validation and rolls back the hold', async () => {
  const account = await grant();
  const reservation = await store.reserve(account.id, 'invalid-usage', models[0].id, 'input', 60);
  for (const invalid of [
    { promptTokens: 10, completionTokens: 20, totalTokens: 5 },
    { completionTokens: 0, totalTokens: 5 },
    { promptTokens: 5, totalTokens: 5 },
    { promptTokens: null, completionTokens: 0, totalTokens: 5 },
    { promptTokens: 5, completionTokens: null, totalTokens: 5 },
  ]) {
    await assert.rejects(store._rpc('settle', { reservationId: reservation.id, usage: invalid, replay: null }), { code: 'invalid_usage' });
  }
  assert.equal((await store.account(account.id)).allowance.reserved, 60);
  assert.equal((await store.account(account.id)).allowance.includedRemaining, 40);
});

test('anonymous and signed-in client roles cannot call the RPC or read private balances', async () => {
  await grant();
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asRole(role, transaction => transaction.query('SELECT public.reach_account_store($1,$2::jsonb)', ['find_account', JSON.stringify({ wallet, now })])), { code: '42501' });
    await assert.rejects(asRole(role, transaction => transaction.query(`SELECT * FROM ${identifier(privateSchema)}.accounts`)), { code: '42501' });
  }
  const protectedTables = await db.query('SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind=$2', [privateSchema, 'r']);
  assert.ok(protectedTables.rows.length >= 7);
  assert.ok(protectedTables.rows.every(table => table.relrowsecurity), 'all financial/authentication tables enable RLS');
});

test('RLS independently denies client rows and mutations even if table grants are accidentally added', async () => {
  const account = await grant();
  for (const role of ['anon', 'authenticated']) {
    await db.transaction(async transaction => {
      await transaction.exec(`GRANT USAGE ON SCHEMA ${identifier(privateSchema)} TO ${identifier(role)}; GRANT SELECT,UPDATE,DELETE ON ${identifier(privateSchema)}.accounts TO ${identifier(role)}; SET LOCAL ROLE ${identifier(role)}`);
      assert.equal((await transaction.query(`SELECT id FROM ${identifier(privateSchema)}.accounts`)).rows.length, 0);
      assert.equal((await transaction.query(`UPDATE ${identifier(privateSchema)}.accounts SET prepaid=999 WHERE id=$1 RETURNING id`, [account.id])).rows.length, 0);
      assert.equal((await transaction.query(`DELETE FROM ${identifier(privateSchema)}.accounts WHERE id=$1 RETURNING id`, [account.id])).rows.length, 0);
      await transaction.rollback();
    });
    await assert.rejects(db.transaction(async transaction => {
      await transaction.exec(`GRANT USAGE ON SCHEMA ${identifier(privateSchema)} TO ${identifier(role)}; GRANT INSERT ON ${identifier(privateSchema)}.accounts TO ${identifier(role)}; SET LOCAL ROLE ${identifier(role)}`);
      await transaction.query(`INSERT INTO ${identifier(privateSchema)}.accounts (id,wallet) VALUES ($1,$2)`, ['a'.repeat(64), otherWallet]);
    }), { code: '42501' });
  }
  assert.equal((await store.account(account.id)).allowance.prepaidRemaining, 0);
});

function sqliteSnapshot(database = ':memory:') {
  const source = new AccountStore(database, { models, now: () => now });
  try {
    const account = source.grantPlan({ wallet, grantId: 'import-original-grant', planId: 'pro', name: 'Pro', models: [models[0].id], tokens: 100, expiresAt: now + 3_600_000 });
    const p = proof();
    const flow = source.startFlow(p.state, p.challenge);
    const challenge = source.challenge(flow.flowId, wallet, () => 'Original customer sign-in');
    source.authorize(flow.flowId, challenge.challengeId);
    const session = source.exchange(flow.flowId, p.state, p.verifier);
    const reservation = source.reserve(account.id, 'existing-request', models[0].id, 'saved-input', 20);
    source.markUncertain(reservation.id, 'dispatched_before_migration');
    const credited = source.createRedemption(account.id, '10000000000000', 10);
    source.submitRedemption(credited.redemptionId, credited.ticket, txHash);
    source.creditRedemption(credited.redemptionId, '31337:original-event:0');
    const pending = source.createRedemption(account.id, '5000000000000', 5);
    source.submitRedemption(pending.redemptionId, pending.ticket, `0x${'55'.repeat(32)}`);
    const names = ['accounts', 'flows', 'challenges', 'sessions', 'grants', 'reservations', 'redemptions'];
    const snapshot = Object.fromEntries(names.map(name => [name, source.db.prepare(`SELECT * FROM ${name}`).all()]));
    return { snapshot, account, session, reservation, credited, pending };
  } finally { source.close(); }
}

test('operator snapshot reader preserves the SQLite source and rejects missing or non-file paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reach-account-snapshot-'));
  const database = join(directory, 'accounts.sqlite');
  t.after(async () => {
    for (const suffix of ['', '-wal', '-shm']) await rm(database + suffix, { force: true });
    await rmdir(directory);
  });
  const original = sqliteSnapshot(database);
  const before = await readFile(database);
  const snapshot = readAccountSnapshot(database);
  assert.deepEqual(snapshot, original.snapshot);
  assert.deepEqual(await readFile(database), before, 'a read-only import preview must not migrate or rewrite the source');
  await store.importSnapshot(snapshot);
  assert.equal((await store.account(original.account.id)).allowance.reserved, 20);
  const missing = join(directory, 'missing.sqlite');
  assert.throws(() => readAccountSnapshot(missing), { code: 'ENOENT' });
  await assert.rejects(readFile(missing), { code: 'ENOENT' });
  assert.throws(() => readAccountSnapshot(directory), /regular SQLite account database/);
});

test('legacy snapshot export permits empty request tables but refuses either populated request table', async t => {
  const subscription = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15000000 },
    overageUsdMicrosPerRequest: 10000, proEnabled: false };
  const requestModels = [{ id: 'request-bridge', metered: true, access: 'requests', bridge: { kind: 'tray', model: 'chatgpt-chat' } }];
  for (const populatedTable of ['request_periods', 'request_reservations']) await t.test(populatedTable, async child => {
    const directory = await mkdtemp(join(tmpdir(), 'reach-request-snapshot-'));
    const database = join(directory, 'accounts.sqlite');
    child.after(() => rm(directory, { recursive: true, force: true }));
    const source = new AccountStore(database, { subscription, models: requestModels });
    try {
      const account = source.ensureAccount(wallet);
      const empty = readAccountSnapshot(database);
      assert.equal(empty.accounts.length, 1);
      assert.equal(Object.hasOwn(empty, 'request_periods'), false);
      assert.equal(Object.hasOwn(empty, 'request_reservations'), false);
      if (populatedTable === 'request_periods') {
        source.grantPlan({ wallet, grantId: 'snapshot-basic-grant', planId: 'basic-wallet', name: 'Basic',
          models: [requestModels[0].id], tokens: 0, expiresAt: Date.now() + 3600000 });
        const reservation = source.reserveRequest(account.id, 'initialize', requestModels[0].id, 'fingerprint');
        source.releaseRequest(reservation.id);
        // Isolate the period check: there are no reservation rows to catch it.
        source.db.prepare('DELETE FROM request_reservations').run();
      } else {
        source.db.prepare('UPDATE accounts SET usd_prepaid=10000 WHERE id=?').run(account.id);
        const reservation = source.reserveRequest(account.id, 'paid-request', requestModels[0].id, 'fingerprint');
        source.releaseRequest(reservation.id);
        assert.equal(source.db.prepare('SELECT COUNT(*) AS n FROM request_periods').get().n, 0);
      }
    } finally { source.close(); }
    const before = await readFile(database);
    assert.throws(() => readAccountSnapshot(database), /snapshot cannot preserve request billing records/);
    assert.deepEqual(await readFile(database), before, 'refusing the export must not alter the source ledger');
  });
});

test('legacy snapshot export refuses applied and rejected payments without losing replay protection', async t => {
  for (const amount of [5_000_000, 999_999]) await t.test(`amount ${amount}`, async child => {
    const directory = await mkdtemp(join(tmpdir(), 'reach-payment-snapshot-'));
    const database = join(directory, 'accounts.sqlite');
    child.after(() => rm(directory, { recursive: true, force: true }));
    const source = new AccountStore(database);
    let account, payment, result;
    try {
      account = source.ensureAccount(wallet);
      assert.equal(readAccountSnapshot(database).accounts.length, 1, 'an empty payment ledger permits legacy exports');
      payment = { provider: 'manual', eventId: 'evt_snapshot', objectId: 'bank-ref-snapshot', kind: 'top_up',
        accountId: account.id, amountUsdMicros: amount };
      result = source.applyPayment(payment);
      assert.equal(result.status, amount === 5_000_000 ? 'applied' : 'rejected');
    } finally { source.close(); }
    const before = await readFile(database);
    assert.throws(() => readAccountSnapshot(database), /snapshot cannot preserve payment records/);
    assert.deepEqual(await readFile(database), before, 'refusing the export must preserve the source ledger');
    const restored = new AccountStore(database);
    try {
      const replay = restored.applyPayment(payment);
      assert.equal(replay.duplicate, true);
      assert.equal(replay.paymentId, result.paymentId);
      assert.equal(restored.account(account.id).credit.balanceMicros, amount === 5_000_000 ? amount : 0);
      assert.equal(restored.listPayments(account.id).length, 1);
    } finally { restored.close(); }
  });
});

test('SQLite snapshot import preserves wallet identity, sessions, holds and redemption uniqueness', async () => {
  const original = sqliteSnapshot();
  await store.importSnapshot(original.snapshot);
  const restored = await store.account(original.account.id);
  assert.equal(restored.id, original.account.id);
  assert.equal(restored.walletAddress, wallet);
  assert.equal(restored.allowance.includedRemaining, 80);
  assert.equal(restored.allowance.prepaidRemaining, 10);
  assert.equal(restored.allowance.reserved, 20);
  assert.equal((await store.authenticate(original.session.accessToken)).id, original.account.id);
  const holds = await store.unsettledReservations(original.account.id);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].id, original.reservation.id);
  assert.equal(holds[0].status, 'uncertain');
  assert.deepEqual(Object.keys(holds[0]).sort(), ['account_id', 'amount', 'created', 'currency', 'id', 'model', 'reason', 'request_id', 'status'],
    'reconciliation exposes metadata only, without saved request fingerprints, provider usage or replay bodies');
  assert.equal((await store.pendingRedemptions(original.account.id))[0].id, original.pending.redemptionId);
  await store.creditRedemption(original.credited.redemptionId, '31337:original-event:0');
  await assert.rejects(store.creditRedemption(original.pending.redemptionId, '31337:original-event:0'), { code: 'event_conflict' });
  assert.equal((await store.account(original.account.id)).allowance.prepaidRemaining, 10);
  assert.equal((await store.getRedemption(original.pending.redemptionId, original.pending.ticket)).status, 'pending');
});

test('snapshot import refuses a nonempty target without replacing existing subscription state', async () => {
  const existing = await grant(70, 'target-existing-grant', otherWallet);
  await assert.rejects(store.importSnapshot(sqliteSnapshot().snapshot), { code: 'import_target_not_empty' });
  assert.equal((await store.account(existing.id)).allowance.includedRemaining, 70);
  assert.equal(await store.findAccountByWallet(wallet), null);
});

test('invalid snapshot foreign keys roll back every inserted row and permit a corrected import', async () => {
  const original = sqliteSnapshot();
  const invalid = structuredClone(original.snapshot);
  invalid.reservations[0].account_id = 'f'.repeat(64);
  await assert.rejects(store.importSnapshot(invalid), { code: 'invalid_import' });
  for (const table of tables) {
    const result = await db.query(`SELECT count(*)::int AS total FROM ${identifier(privateSchema)}.${identifier(table)}`);
    assert.equal(result.rows[0].total, 0, `${table} must remain empty after the failed import`);
  }
  await store.importSnapshot(original.snapshot);
  assert.equal((await store.account(original.account.id)).allowance.reserved, 20);
});
