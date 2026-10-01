import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePayment, paymentFingerprint, grantIdFor, decideSubscriptionPayment, decideTopUpPayment, publicPayment,
  MAX_PERIOD_MS, CREDIT_CEILING_USD_MICROS } from '../service/payments/core.mjs';

const NOW = 1_800_000_000_000, DAY = 86_400_000;
const good = { provider: 'stripe', eventId: 'evt_0001', objectId: 'in_0001', kind: 'subscription_period', accountId: 'acct_12345678', amountUsdMicros: 15_000_000, periodEnd: NOW + 30 * DAY };
const policy = { basic: { priceUsdMicros: 15_000_000 } };
const account = (over = {}) => ({ plan_id: null, plan_expires: 0, usd_prepaid: 0, usd_debt: 0, ...over });
const sub = (acct, over = {}) => decideSubscriptionPayment({ account: acct, payment: { ...good, ...over }, policy, now: NOW });
const top = (acct, amountUsdMicros) => decideTopUpPayment({ account: acct, payment: { amountUsdMicros } });

test('normalizePayment accepts a well-formed record and defaults currency', () => {
  assert.deepEqual(normalizePayment(good), { ...good, currency: 'usd' });
  assert.equal(normalizePayment({ ...good, currency: 'USD' }).currency, 'usd');
});

test('normalizePayment rejects malformed records', () => {
  const bad = [null, [], 'x', { ...good, extra: 1 }, { ...good, provider: 'venmo' }, { ...good, kind: 'refund' }, { ...good, currency: 'eur' },
    { ...good, eventId: 'a b' }, { ...good, objectId: 'ab' }, { ...good, accountId: 'short' },
    { ...good, amountUsdMicros: 0 }, { ...good, amountUsdMicros: -5 }, { ...good, amountUsdMicros: 1.5 }, { ...good, amountUsdMicros: '15000000' },
    { ...good, amountUsdMicros: CREDIT_CEILING_USD_MICROS + 1 }, { ...good, periodEnd: null }, { ...good, periodEnd: 1.5 },
    { ...good, kind: 'top_up' }];
  for (const record of bad) assert.throws(() => normalizePayment(record), { code: 'invalid_payment' }, JSON.stringify(record));
  assert.doesNotThrow(() => normalizePayment({ ...good, kind: 'top_up', periodEnd: undefined }));
});

test('grantIdFor is stable, well-shaped and keyed on the payment object', () => {
  assert.match(grantIdFor(good), /^pay_[a-f0-9]{48}$/);
  assert.equal(grantIdFor(good), grantIdFor({ ...good, eventId: 'evt_other', amountUsdMicros: 1 }));
  assert.notEqual(grantIdFor(good), grantIdFor({ ...good, objectId: 'in_0002' }));
  assert.notEqual(grantIdFor(good), grantIdFor({ ...good, provider: 'paypal' }));
});

test('paymentFingerprint changes with every defining field but not the event id', () => {
  const base = paymentFingerprint(good);
  assert.equal(base, paymentFingerprint({ ...good, eventId: 'evt_other' }));
  for (const change of [{ amountUsdMicros: 16_000_000 }, { periodEnd: good.periodEnd + 1 }, { accountId: 'acct_87654321' }, { provider: 'paypal' }, { objectId: 'in_0002' }])
    assert.notEqual(base, paymentFingerprint({ ...good, ...change }), JSON.stringify(change));
});

test('subscription decisions follow the documented order', () => {
  assert.deepEqual(sub(null), { action: 'record', status: 'rejected', reason: 'account_missing' });
  assert.equal(sub(account(), { amountUsdMicros: 14_999_999 }).reason, 'amount_mismatch');
  assert.equal(sub(account(), { periodEnd: NOW }).status, 'expired');
  assert.equal(sub(account(), { periodEnd: NOW + MAX_PERIOD_MS + 1 }).reason, 'period_too_long');
  assert.equal(sub(account({ plan_id: 'custom', plan_expires: NOW + DAY })).reason, 'other_plan_active');
  assert.deepEqual(sub(account({ plan_id: 'custom', plan_expires: NOW - 1 })), { action: 'grant' });
  assert.equal(sub(account({ plan_id: 'basic-wallet', plan_expires: good.periodEnd })).status, 'superseded');
  assert.deepEqual(sub(account({ plan_id: 'basic-wallet', plan_expires: good.periodEnd - 1 })), { action: 'grant' });
  assert.deepEqual(sub(account()), { action: 'grant' });
  // the price check comes before the period checks
  assert.equal(sub(account(), { amountUsdMicros: 1, periodEnd: NOW - 1 }).reason, 'amount_mismatch');
});

test('top-up decisions repay debt first and respect the bounds', () => {
  assert.equal(top(null, 5_000_000).reason, 'account_missing');
  assert.equal(top(account(), 999_999).reason, 'amount_out_of_range');
  assert.equal(top(account(), 500_000_001).reason, 'amount_out_of_range');
  assert.deepEqual(top(account(), 1_000_000), { action: 'credit', debtPaid: 0, credit: 1_000_000 });
  assert.deepEqual(top(account({ usd_debt: 3_000_000 }), 5_000_000), { action: 'credit', debtPaid: 3_000_000, credit: 2_000_000 });
  assert.deepEqual(top(account({ usd_debt: 9_000_000 }), 5_000_000), { action: 'credit', debtPaid: 5_000_000, credit: 0 });
  assert.equal(top(account({ usd_prepaid: CREDIT_CEILING_USD_MICROS - 1_000_000 }), 2_000_000).reason, 'credit_limit');
});

test('publicPayment exposes no provider identifiers', () => {
  const view = publicPayment({ id: 'p', provider: 'stripe', kind: 'top_up', amount_usd_micros: 1, currency: 'usd', status: 'applied',
    reason: null, period_end: null, created: NOW, object_id: 'in_secret', event_id: 'evt_secret', fingerprint: 'f', account_id: 'a' });
  assert.deepEqual(Object.keys(view).sort(), ['amountUsdMicros', 'createdAt', 'currency', 'id', 'kind', 'periodEnd', 'provider', 'reason', 'status']);
});
