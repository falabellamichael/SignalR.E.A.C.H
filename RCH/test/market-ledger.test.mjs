import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { AccountStore, usdUsageCost } from '../service/store.mjs';
import { SupabaseAccountStore } from '../service/supabase-store.mjs';

const address = byte => `0x${byte.repeat(40)}`;
const hash = () => `0x${randomBytes(32).toString('hex')}`;
const wallet = address('1');
const amount = '1000000000000000000';
const pricing = { inputUsdMicrosPerMillion: 150000, outputUsdMicrosPerMillion: 600000, cachedInputUsdMicrosPerMillion: 75000 };
const model = { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', provider: 'OpenAI', metered: true, pricing };
let db;
before(async () => {
  db = await PGlite.create();
  await db.exec('CREATE ROLE anon NOINHERIT; CREATE ROLE authenticated NOINHERIT; CREATE ROLE service_role NOINHERIT BYPASSRLS;');
  const migrations = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, migrations), 'utf8'));
  }
});
after(async () => { await db?.close(); });

async function fixture(t, kind) {
  let time = 1800000000000;
  const models = [structuredClone(model), { id: 'unpriced', name: 'Unpriced', provider: 'fixture', metered: true }];
  let store;
  if (kind === 'SQLite') {
    store = new AccountStore(':memory:', { models, now: () => time });
    t.after(() => store.close());
  } else {
    await db.exec('TRUNCATE reach_accounts.accounts,reach_accounts.flows,reach_accounts.challenges,reach_accounts.sessions,reach_accounts.grants,reach_accounts.reservations,reach_accounts.redemptions CASCADE');
    store = new SupabaseAccountStore({ url: 'https://ledger-fixture.supabase.co', secretKey: 'sb_secret_local_test_only_0000000000', models, now: () => time,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        try {
          const result = await db.transaction(async tx => {
            await tx.exec('SET LOCAL ROLE service_role');
            return (await tx.query('SELECT public.reach_account_store($1,$2::jsonb) AS response', [body.p_operation, JSON.stringify(body.p_payload)])).rows[0].response;
          });
          return new Response(JSON.stringify(result));
        } catch (error) {
          if (error.code !== 'P0001') console.error('Unexpected market SQL failure:', error.code, error.message);
          return new Response(JSON.stringify({ code: error.code, message: error.message }), { status: 400 });
        }
      } });
  }
  const account = await store.ensureAccount(wallet);
  const quote = (creditUsdMicros = 10000, extra = {}) => ({ amount, creditUsdMicros, creditBudgetUsdMicros: 5000000,
    expiresAtMs: time + 120000, issuedAt: time / 1000, deadline: time / 1000 + 120,
    chainId: 1, tokenAddress: address('2'), treasuryAddress: address('3'), redemptionContract: address('4'),
    source: 'uniswap-v3-executable', sourceBlock: 12345, ...extra });
  const credit = async (micros = 10000, accountId = account.id, extra = {}) => {
    const intent = await store.createMarketRedemption(accountId, amount, quote(micros, extra));
    await store.submitRedemption(intent.redemptionId, intent.ticket, hash());
    await store.creditRedemption(intent.redemptionId, `1:${hash()}:0`);
    return intent;
  };
  return { store, account, quote, credit, models, advance: ms => { time += ms; } };
}
const rejects = (fn, code) => assert.rejects(async () => fn(), { code });

for (const kind of ['SQLite', 'PostgreSQL']) {
  test(`${kind}: immutable USD quote binds wallet, amount, expiry and budget before any credit`, async t => {
    const { store, account, quote } = await fixture(t, kind);
    const input = quote(), intent = await store.createMarketRedemption(account.id, amount, input);
    input.creditUsdMicros = 99999;
    const row = await store.getRedemption(intent.redemptionId, intent.ticket);
    assert.equal(row.usage_tokens, 0);
    assert.equal(row.usd_micros, 10000);
    assert.equal(JSON.parse(row.quote_json).creditUsdMicros, 10000);
    assert.equal(JSON.parse(row.quote_json).wallet, wallet);
    assert.equal(row.amount, amount);
    assert.equal((await store.account(account.id)).credit.balanceMicros, 0);
    await rejects(() => store.creditRedemption(intent.redemptionId, '1:not-pending:0'), 'redemption_not_pending');
    await rejects(() => store.createMarketRedemption(account.id, '2000000000000000000', quote()), 'invalid_redemption');
    await rejects(() => store.createMarketRedemption(account.id, amount, quote(10000, { wallet: address('5') })), 'invalid_redemption');
    await rejects(() => store.createMarketRedemption(account.id, amount, quote(10000, { expiresAtMs: 1800000000000 })), 'invalid_redemption');
    await rejects(() => store.createMarketRedemption(account.id, amount, quote(10000, { creditBudgetUsdMicros: 0 })), 'invalid_redemption');
  });

  test(`${kind}: issued promises consume the bounded budget even if quotes expire`, async t => {
    const { store, account, quote, advance } = await fixture(t, kind);
    await store.createMarketRedemption(account.id, amount, quote(7000, { creditBudgetUsdMicros: 10000 }));
    advance(180000);
    await rejects(() => store.createMarketRedemption(account.id, amount, quote(3001, { creditBudgetUsdMicros: 10000 })), 'redemption_budget_exhausted');
    await store.createMarketRedemption(account.id, amount, quote(3000, { creditBudgetUsdMicros: 10000 }));
    const other = await store.ensureAccount(address('6'));
    await store.createMarketRedemption(other.id, amount, quote(10000, { creditBudgetUsdMicros: 10000 }));
    assert.equal((await store.account(account.id)).credit.balanceMicros, 0);
  });

  test(`${kind}: finality verification credits once and cannot reuse an event across accounts`, async t => {
    const { store, account, quote } = await fixture(t, kind);
    const first = await store.createMarketRedemption(account.id, amount, quote());
    await store.submitRedemption(first.redemptionId, first.ticket, hash());
    await store.creditRedemption(first.redemptionId, '1:confirmed-event:0');
    await store.creditRedemption(first.redemptionId, '1:confirmed-event:0');
    await rejects(() => store.creditRedemption(first.redemptionId, '1:other-event:0'), 'event_conflict');
    const other = await store.ensureAccount(address('6'));
    const duplicate = await store.createMarketRedemption(other.id, amount, quote());
    await store.submitRedemption(duplicate.redemptionId, duplicate.ticket, hash());
    await rejects(() => store.creditRedemption(duplicate.redemptionId, '1:confirmed-event:0'), 'event_conflict');
    const view = await store.account(account.id);
    assert.equal(view.credit.balanceMicros, 10000);
    assert.equal(view.allowance.prepaidRemaining, 0);
    assert.equal(view.plan.status, 'none');
    assert.deepEqual(view.allowedModels.map(m => m.id), [model.id]);
    assert.equal((await store.account(other.id)).credit.balanceMicros, 0);
  });

  test(`${kind}: measured input, cached input and output use the reserved model price snapshot`, async t => {
    const { store, account, credit, models } = await fixture(t, kind);
    await credit();
    const hold = await store.reserveUsd(account.id, 'request-1', model.id, 'same-input', { promptTokens: 1000, completionTokens: 1000 });
    assert.equal((await store.account(account.id)).credit.reservedMicros, 750);
    assert.equal((await store.account(account.id)).allowance.reserved, 0);
    assert.equal((await store.reserveUsd(account.id, 'request-1', model.id, 'same-input', { promptTokens: 1000, completionTokens: 1000 })).fresh, false);
    models[0].pricing.inputUsdMicrosPerMillion *= 2;
    await store.settle(hold.id, { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, details: { prompt: { cached_tokens: 400 } } }, { answer: 'saved' });
    assert.equal((await store.account(account.id)).credit.balanceMicros, 9820); // 90 + 30 + 60 micros
    assert.equal((await store.account(account.id)).credit.reservedMicros, 0);
    const replay = await store.reserveUsd(account.id, 'request-1', model.id, 'same-input', { promptTokens: 1000, completionTokens: 1000 });
    assert.equal(replay.status, 'settled');
    assert.deepEqual(replay.replay, { answer: 'saved' });
    await store.settle(hold.id, { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 });
    assert.equal((await store.account(account.id)).credit.balanceMicros, 9820);
  });

  test(`${kind}: competing request reservations cannot overdraw credit and cannot change billing currency`, async t => {
    const { store, account, credit } = await fixture(t, kind);
    await credit(1000);
    const limits = { promptTokens: 1000, completionTokens: 1000 };
    await store.reserveUsd(account.id, 'request-1', model.id, 'same-input', limits);
    await rejects(() => store.reserveUsd(account.id, 'request-2', model.id, 'different-input', limits), 'allowance_exhausted');
    await rejects(() => store.reserveUsd(account.id, 'request-1', model.id, 'different-input', limits), 'idempotency_conflict');
    await rejects(() => store.reserve(account.id, 'request-1', model.id, 'same-input', 10), 'idempotency_conflict');
    assert.equal((await store.account(account.id)).credit.balanceMicros, 250);
  });

  test(`${kind}: undispatched holds release once, uncertain holds remain charged until verified usage`, async t => {
    const { store, account, credit } = await fixture(t, kind);
    await credit();
    const limits = { promptTokens: 1000, completionTokens: 1000 };
    const hold = await store.reserveUsd(account.id, 'request-1', model.id, 'same-input', limits);
    await store.release(hold.id);
    await store.release(hold.id);
    assert.equal((await store.account(account.id)).credit.balanceMicros, 10000);
    assert.equal((await store.reserveUsd(account.id, 'request-1', model.id, 'same-input', limits)).fresh, true);
    await store.markUncertain(hold.id);
    await rejects(() => store.release(hold.id), 'reservation_closed');
    assert.equal((await store.account(account.id)).credit.reservedMicros, 750);
    await store.settle(hold.id, { promptTokens: 1, completionTokens: 0, totalTokens: 1 });
    assert.equal((await store.account(account.id)).credit.balanceMicros, 9999);
  });

  test(`${kind}: an overage records USD debt and future USD credit pays debt before new spending`, async t => {
    const { store, account, credit } = await fixture(t, kind);
    await credit(1000);
    const hold = await store.reserveUsd(account.id, 'request-1', model.id, 'same-input', { promptTokens: 1000, completionTokens: 1000 });
    await store.settle(hold.id, { promptTokens: 0, completionTokens: 2000, totalTokens: 2000 });
    assert.deepEqual((await store.account(account.id)).credit, { currency: 'USD', balanceMicros: 0, reservedMicros: 0, debtMicros: 200 });
    await rejects(() => store.reserveUsd(account.id, 'request-2', model.id, 'same-input', { promptTokens: 1, completionTokens: 0 }), 'usage_debt');
    await credit(500);
    assert.equal((await store.account(account.id)).credit.balanceMicros, 300);
    assert.equal((await store.account(account.id)).credit.debtMicros, 0);
    assert.equal((await store.account(account.id)).allowance.debt, 0);
  });

  test(`${kind}: malformed cached usage rolls back without refunding the held charge`, async t => {
    const { store, account, credit } = await fixture(t, kind);
    await credit();
    const hold = await store.reserveUsd(account.id, 'request-1', model.id, 'same-input', { promptTokens: 1000, completionTokens: 1000 });
    await rejects(() => store.settle(hold.id, { promptTokens: 100, completionTokens: 0, totalTokens: 100, details: { prompt: { cached_tokens: 101 } } }), 'invalid_usage');
    assert.equal((await store.account(account.id)).credit.balanceMicros, 9250);
    assert.equal((await store.account(account.id)).credit.reservedMicros, 750);
  });
}

test('USD microcredit arithmetic retains integer precision and rounds once at request settlement', () => {
  assert.equal(usdUsageCost(pricing, { promptTokens: 1, completionTokens: 0 }), 1);
  assert.equal(usdUsageCost(pricing, { promptTokens: 1, completionTokens: 1 }), 1);
  assert.equal(usdUsageCost({ inputUsdMicrosPerMillion: 1000000000000, outputUsdMicrosPerMillion: 1 }, { promptTokens: 1000000, completionTokens: 0 }), 1000000000000);
  assert.throws(() => usdUsageCost(pricing, { promptTokens: 1.1, completionTokens: 0 }), { code: 'invalid_usage' });
});
