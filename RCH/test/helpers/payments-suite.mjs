// One behavioural suite for the payment ledger, run against BOTH account stores
// (SQLite in payments-sqlite.test.mjs, Postgres in payments-supabase.test.mjs).
//
// The rules exist twice - in JavaScript for SQLite and in SQL for Postgres - so
// the only honest proof they agree is to run the same cases through both and
// assert the same outcomes. A rule added to one implementation and forgotten in
// the other fails here, not in production.
//
// A harness supplies how to build a store; everything below is store-agnostic:
//   fresh({ models, subscription }) -> { store, clock, setCredit({accountId,prepaid,debt}) }
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';

export const DAY = 86_400_000;
export const SUBSCRIPTION = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15_000_000 },
  overageUsdMicrosPerRequest: 10_000, proEnabled: false };
export const MODELS = [{ id: 'bridge-chat', name: 'Bridge chat', provider: 'fixture', access: 'requests', metered: true,
  bridge: { kind: 'tray', model: 'chatgpt-chat' } }];
const wallet = getAddress(`0x${'11'.repeat(20)}`);
const REPLAY = { contentType: 'application/json; charset=utf-8', body: '{"ok":true}' };
// SQLite's store methods are synchronous and Postgres's are async. A synchronous
// throw would escape assert.rejects, so run the call inside an async function.
const rejects = (call, check) => assert.rejects(async () => call(), check);

export function definePaymentsSuite(label, { fresh }) {
  const t = (name, fn) => test(`${label}: ${name}`, fn);

  async function setup(options = {}) {
    const h = await fresh({ models: MODELS, subscription: SUBSCRIPTION, ...options });
    const account = await h.store.ensureAccount(wallet);
    const accountId = account.id;
    const pay = (over = {}) => ({ provider: 'stripe', eventId: 'evt_0001', objectId: 'in_0001', kind: 'subscription_period',
      accountId, amountUsdMicros: 15_000_000, periodEnd: h.clock.now + 30 * DAY, ...over });
    const topUp = (over = {}) => ({ provider: 'stripe', eventId: 'evt_t0001', objectId: 'pi_0001', kind: 'top_up',
      accountId, amountUsdMicros: 5_000_000, ...over });
    const view = () => h.store.account(accountId);
    const useOneRequest = async (n = 1) => {
      const reservation = await h.store.reserveRequest(accountId, `req-${n}-${h.clock.now}`, 'bridge-chat', `fp-${n}`);
      await h.store.settleRequest(reservation.id, REPLAY);
    };
    return { ...h, accountId, pay, topUp, view, useOneRequest };
  }

  // ------------------------------------------------------------ subscriptions

  t('a paid subscription period grants Basic until the period end', async () => {
    const s = await setup();
    const p = s.pay();
    const result = await s.store.applyPayment(p);
    assert.equal(result.status, 'applied');
    assert.equal(result.duplicate, false);
    assert.equal(result.reason, null);
    assert.match(result.grantId, /^pay_[a-f0-9]{48}$/);
    const account = await s.view();
    assert.equal(account.plan.id, 'basic-wallet');
    assert.equal(account.plan.status, 'active');
    assert.equal(account.plan.expiresAt, new Date(p.periodEnd).toISOString());
    assert.equal(account.requestAllowance.includedLimit, 1500);
    assert.equal(account.requestAllowance.remaining, 1500);
    assert.equal(account.requestAllowance.basicActive, true);
    assert.ok(account.allowedModels.some(m => m.id === 'bridge-chat'));
  });

  t('replaying the same event changes nothing and returns the original outcome', async () => {
    const s = await setup();
    const first = await s.store.applyPayment(s.pay());
    await s.useOneRequest();
    const again = await s.store.applyPayment(s.pay());
    assert.equal(again.duplicate, true);
    assert.equal(again.paymentId, first.paymentId);
    assert.equal(again.status, 'applied');
    // The allowance already spent must survive a replay; a re-grant would reset it.
    assert.equal((await s.view()).requestAllowance.remaining, 1499);
    assert.equal((await s.store.listPayments(s.accountId)).length, 1);
  });

  t('a different event for the same invoice is the same payment', async () => {
    // Stripe sends invoice.paid AND invoice.payment_succeeded for one invoice.
    const s = await setup();
    const first = await s.store.applyPayment(s.pay({ eventId: 'evt_paid' }));
    const second = await s.store.applyPayment(s.pay({ eventId: 'evt_succeeded' }));
    assert.equal(second.duplicate, true);
    assert.equal(second.paymentId, first.paymentId);
    assert.equal((await s.store.listPayments(s.accountId)).length, 1);
  });

  t('the same payment arriving with different values is a conflict, not a replay', async () => {
    const s = await setup();
    const p = s.pay();
    await s.store.applyPayment(p);
    await rejects(() => s.store.applyPayment({ ...p, periodEnd: p.periodEnd + DAY }),
      error => error.status === 409 && error.code === 'payment_conflict');
    assert.equal((await s.view()).plan.expiresAt, new Date(p.periodEnd).toISOString(), 'the first values stand');
    assert.equal((await s.store.listPayments(s.accountId)).length, 1);
  });

  t('a renewal replaces the period and starts a fresh allowance', async () => {
    const s = await setup();
    await s.store.applyPayment(s.pay());
    await s.useOneRequest();
    assert.equal((await s.view()).requestAllowance.remaining, 1499);
    s.clock.now += 30 * DAY - 1000;
    const renewal = s.pay({ eventId: 'evt_0002', objectId: 'in_0002', periodEnd: s.clock.now + 31 * DAY });
    const result = await s.store.applyPayment(renewal);
    assert.equal(result.status, 'applied');
    const account = await s.view();
    assert.equal(account.plan.expiresAt, new Date(renewal.periodEnd).toISOString());
    assert.equal(account.requestAllowance.remaining, 1500, 'a paid renewal is a new allowance');
    assert.equal((await s.store.listPayments(s.accountId)).length, 2);
  });

  t('an older invoice arriving late never shortens a newer period', async () => {
    // Webhooks are delivered late and out of order. Granting the older invoice
    // would overwrite the newer period and silently take paid time away.
    const s = await setup();
    const newer = s.pay({ eventId: 'evt_new', objectId: 'in_new', periodEnd: s.clock.now + 60 * DAY });
    await s.store.applyPayment(newer);
    await s.useOneRequest();
    const older = await s.store.applyPayment(s.pay({ eventId: 'evt_old', objectId: 'in_old', periodEnd: s.clock.now + 30 * DAY }));
    assert.equal(older.status, 'superseded');
    assert.equal(older.reason, 'newer_period_active');
    assert.equal(older.grantId, null);
    const account = await s.view();
    assert.equal(account.plan.expiresAt, new Date(newer.periodEnd).toISOString(), 'the newer period stands');
    assert.equal(account.requestAllowance.remaining, 1499, 'and so does the usage already counted against it');
    assert.deepEqual((await s.store.flaggedPayments()), [], 'a late older invoice is expected, not an alarm');
  });

  t('a payment for a period that is already over is recorded as expired and grants nothing', async () => {
    const s = await setup();
    const result = await s.store.applyPayment(s.pay({ periodEnd: s.clock.now - DAY }));
    assert.equal(result.status, 'expired');
    assert.equal(result.reason, 'period_over');
    assert.equal((await s.view()).plan.status, 'none');
    const flagged = await s.store.flaggedPayments();
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].reason, 'period_over');
  });

  t('seconds mistaken for milliseconds are expired, never granted', async () => {
    // Stripe reports unix SECONDS. An adapter that forgets to convert produces a
    // 1970 date, which must land as an expired record and not as a plan.
    const s = await setup();
    const result = await s.store.applyPayment(s.pay({ periodEnd: Math.floor((s.clock.now + 30 * DAY) / 1000) }));
    assert.equal(result.status, 'expired');
    assert.equal((await s.view()).plan.status, 'none');
  });

  t('a period far in the future is rejected rather than granted', async () => {
    // The opposite mistake - milliseconds treated as seconds, or a bad date -
    // would otherwise hand out a plan that never expires.
    const s = await setup();
    const result = await s.store.applyPayment(s.pay({ periodEnd: s.clock.now + 500 * DAY }));
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'period_too_long');
    assert.equal((await s.view()).plan.status, 'none');
  });

  t('a discounted or over-charged amount is not accepted as a full Basic payment', async () => {
    const s = await setup();
    for (const [n, amount] of [[1, 14_999_999], [2, 15_000_001], [3, 7_500_000]]) {
      const result = await s.store.applyPayment(s.pay({ eventId: `evt_a${n}`, objectId: `in_a${n}`, amountUsdMicros: amount }));
      assert.equal(result.status, 'rejected', `amount ${amount}`);
      assert.equal(result.reason, 'amount_mismatch');
    }
    assert.equal((await s.view()).plan.status, 'none');
    assert.equal((await s.store.flaggedPayments()).length, 3, 'each one is left for an operator');
  });

  t('a plan an operator granted by hand is never silently replaced', async () => {
    const s = await setup();
    await s.store.grantPlan({ wallet, grantId: 'ops-special-grant', planId: 'ops-special', name: 'Ops special',
      models: ['bridge-chat'], tokens: 0, expiresAt: s.clock.now + 90 * DAY });
    const result = await s.store.applyPayment(s.pay());
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'other_plan_active');
    assert.equal((await s.view()).plan.id, 'ops-special');
  });

  t('money for an unknown account is recorded, not lost', async () => {
    const s = await setup();
    const stranger = 'f'.repeat(64);
    const result = await s.store.applyPayment(s.pay({ accountId: stranger }));
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'account_missing');
    const flagged = await s.store.flaggedPayments();
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].accountId, stranger, 'the operator can see who it was meant for');
  });

  // ----------------------------------------------------------------- top-ups

  t('a top-up credits the account exactly once', async () => {
    const s = await setup();
    const first = await s.store.applyPayment(s.topUp());
    assert.equal(first.status, 'applied');
    assert.equal((await s.view()).credit.balanceMicros, 5_000_000);
    const replay = await s.store.applyPayment(s.topUp({ eventId: 'evt_other' }));
    assert.equal(replay.duplicate, true);
    assert.equal((await s.view()).credit.balanceMicros, 5_000_000, 'a replay must not credit twice');
  });

  t('a top-up repays debt before it adds credit', async () => {
    const s = await setup();
    await s.setCredit({ accountId: s.accountId, prepaid: 0, debt: 2_000_000 });
    await s.store.applyPayment(s.topUp({ amountUsdMicros: 5_000_000 }));
    let account = await s.view();
    assert.equal(account.credit.debtMicros, 0);
    assert.equal(account.credit.balanceMicros, 3_000_000);

    await s.setCredit({ accountId: s.accountId, prepaid: 0, debt: 4_000_000 });
    await s.store.applyPayment(s.topUp({ eventId: 'evt_t2', objectId: 'pi_0002', amountUsdMicros: 1_000_000 }));
    account = await s.view();
    assert.equal(account.credit.debtMicros, 3_000_000);
    assert.equal(account.credit.balanceMicros, 0);
  });

  t('a top-up outside the allowed range is rejected', async () => {
    const s = await setup();
    for (const [n, amount] of [[1, 999_999], [2, 500_000_001]]) {
      const result = await s.store.applyPayment(s.topUp({ eventId: `evt_r${n}`, objectId: `pi_r${n}`, amountUsdMicros: amount }));
      assert.equal(result.status, 'rejected', `amount ${amount}`);
      assert.equal(result.reason, 'amount_out_of_range');
    }
    assert.equal((await s.view()).credit.balanceMicros, 0);
  });

  t('the credit ceiling is enforced as a recorded rejection', async () => {
    const s = await setup();
    await s.setCredit({ accountId: s.accountId, prepaid: 1_000_000_000_000 - 100, debt: 0 });
    const result = await s.store.applyPayment(s.topUp({ amountUsdMicros: 1_000_000 }));
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'credit_limit');
    assert.equal((await s.view()).credit.balanceMicros, 1_000_000_000_000 - 100);
  });

  t('top-ups work on a service with no subscription configured', async () => {
    const s = await setup({ subscription: undefined, models: [] });
    const result = await s.store.applyPayment(s.topUp());
    assert.equal(result.status, 'applied');
  });

  // ---------------------------------------------------------------- integrity

  t('a failed application leaves no ledger trace, so a retry can still succeed', async () => {
    const noModels = await setup({ models: [] });
    await rejects(() => noModels.store.applyPayment(noModels.pay()),
      error => error.status === 409 && error.code === 'no_qualified_models');
    assert.deepEqual(await noModels.store.listPayments(noModels.accountId), []);

    const unconfigured = await setup({ subscription: undefined });
    await rejects(() => unconfigured.store.applyPayment(unconfigured.pay()),
      error => error.status === 409 && error.code === 'subscription_unconfigured');
    assert.deepEqual(await unconfigured.store.listPayments(unconfigured.accountId), []);
  });

  t('an invalid record is refused before anything is written', async () => {
    const s = await setup();
    const bad = [{ ...s.pay(), provider: 'venmo' }, { ...s.pay(), extra: 1 }, { ...s.pay(), amountUsdMicros: 15.5 },
      { ...s.pay(), currency: 'eur' }, { ...s.topUp(), periodEnd: s.clock.now + DAY }, { ...s.pay(), periodEnd: undefined },
      { ...s.pay(), objectId: 'in 1' }, null, []];
    for (const record of bad) {
      await rejects(() => s.store.applyPayment(record), error => error.status === 400 && error.code === 'invalid_payment');
    }
    assert.deepEqual(await s.store.listPayments(s.accountId), []);
  });

  t("the account owner's view never exposes provider identifiers", async () => {
    const s = await setup();
    await s.store.applyPayment(s.pay());
    const [entry] = await s.store.listPayments(s.accountId);
    assert.deepEqual(Object.keys(entry).sort(), ['amountUsdMicros', 'createdAt', 'currency', 'id', 'kind', 'periodEnd', 'provider', 'reason', 'status']);
    assert.equal(entry.amountUsdMicros, 15_000_000);
    assert.equal(entry.status, 'applied');
  });

  t('the review list holds only what needs a human, oldest first', async () => {
    const s = await setup();
    await s.store.applyPayment(s.pay({ eventId: 'evt_ok', objectId: 'in_ok' }));
    s.clock.now += 1000;
    await s.store.applyPayment(s.pay({ eventId: 'evt_b1', objectId: 'in_b1', amountUsdMicros: 1_000_000 }));
    s.clock.now += 1000;
    await s.store.applyPayment(s.pay({ eventId: 'evt_b2', objectId: 'in_b2', periodEnd: s.clock.now - DAY }));
    s.clock.now += 1000;
    await s.store.applyPayment(s.pay({ eventId: 'evt_old', objectId: 'in_old', periodEnd: s.clock.now + DAY }));   // superseded
    const flagged = await s.store.flaggedPayments();
    assert.deepEqual(flagged.map(entry => entry.reason), ['amount_mismatch', 'period_over']);
    assert.ok(flagged.every(entry => entry.objectId && entry.eventId && entry.accountId));
  });

  t('the payment list is newest first and bounded', async () => {
    const s = await setup();
    for (let i = 1; i <= 3; i += 1) {
      s.clock.now += 1000;
      await s.store.applyPayment(s.topUp({ eventId: `evt_n${i}`, objectId: `pi_n${i}` }));
    }
    const list = await s.store.listPayments(s.accountId);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map(entry => entry.createdAt), [...list.map(entry => entry.createdAt)].sort().reverse());
    assert.equal((await s.store.listPayments(s.accountId, 2)).length, 2);
    assert.equal((await s.store.listPayments(s.accountId, 10_000)).length, 3, 'an absurd limit falls back to the default');
  });
}
