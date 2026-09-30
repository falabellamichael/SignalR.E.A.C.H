import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore, modelUsdPricing } from '../service/store.mjs';
import { SupabaseAccountStore } from '../service/supabase-store.mjs';

const cutover = Date.parse('2027-01-01T00:00:00.000Z');
const initial = { inputUsdMicrosPerMillion: 2000000, outputUsdMicrosPerMillion: 4000000, cachedInputUsdMicrosPerMillion: 500000 };
const later = { inputUsdMicrosPerMillion: 4000000, outputUsdMicrosPerMillion: 8000000, cachedInputUsdMicrosPerMillion: 1000000 };
const model = { id: 'scheduled-model', name: 'Scheduled model', provider: 'test', metered: true,
  maxInputTokens: 100, maxInputBytes: 8000, maxOutputTokens: 20,
  pricing: initial, pricingAfter: { effectiveAt: '2027-01-01T00:00:00.000Z', ...later } };

test('published price cutovers select exact UTC rates and omit schedule metadata', () => {
  assert.deepEqual(modelUsdPricing(model, cutover - 1), initial);
  assert.deepEqual(modelUsdPricing(model, cutover), later);
  assert.deepEqual(modelUsdPricing(model, cutover + 1000), later);
  assert.deepEqual(modelUsdPricing({ pricing: initial }, cutover), initial);
  assert.equal(modelUsdPricing({ pricing: { ...initial, cachedInputUsdMicrosPerMillion: -1 } }, cutover), null);
});

test('daily provider tariffs use UTC boundaries and return only rate snapshots', () => {
  const dailyModel = { ...model, pricingAfter: undefined,
    pricingDaily: { utcStartHour: 14, utcEndHour: 24, ...later } };
  for (const [stamp, expected] of [
    ['2026-09-30T00:00:00.000Z', initial], ['2026-09-30T13:59:59.999Z', initial],
    ['2026-09-30T14:00:00.000Z', later], ['2026-09-30T23:59:59.999Z', later],
    ['2026-10-01T00:00:00.000Z', initial],
  ]) assert.deepEqual(modelUsdPricing(dailyModel, Date.parse(stamp)), expected);
});

test('a reservation keeps its price snapshot across a scheduled rate change', t => {
  let time = cutover - 1000;
  const store = new AccountStore(':memory:', { models: [model], now: () => time });
  t.after(() => store.close());
  const account = store.ensureAccount('0x' + '11'.repeat(20));
  const quote = { amount: '10000000000000000000', creditUsdMicros: 1000000, creditBudgetUsdMicros: 5000000,
    issuedAt: time / 1000, deadline: time / 1000 + 300, expiresAtMs: time + 300000,
    chainId: 1, source: 'test scheduled price', tokenAddress: '0x' + '22'.repeat(20), treasuryAddress: '0x' + '33'.repeat(20), redemptionContract: '0x' + '44'.repeat(20) };
  const intent = store.createMarketRedemption(account.id, quote.amount, quote);
  store.submitRedemption(intent.redemptionId, intent.ticket, '0x' + '55'.repeat(32));
  store.creditRedemption(intent.redemptionId, '1:test-price-schedule:0');
  assert.deepEqual(store.account(account.id).allowedModels[0].pricing, initial);
  const hold = store.reserveUsd(account.id, 'before-cutover', model.id, 'before-fingerprint', { promptTokens: 10, completionTokens: 6 });
  assert.equal(store.account(account.id).credit.reservedMicros, 44);
  time = cutover;
  assert.deepEqual(store.account(account.id).allowedModels[0].pricing, later);
  const usage = { promptTokens: 10, completionTokens: 6, totalTokens: 16, model: model.id, provider: model.provider, source: 'provider', details: { prompt: { cached_tokens: 4 }, completion: {} } };
  store.settle(hold.id, usage);
  assert.equal(store.account(account.id).credit.balanceMicros, 1000000 - 38);
  assert.equal(store.account(account.id).credit.reservedMicros, 0);
  const next = store.reserveUsd(account.id, 'after-cutover', model.id, 'after-fingerprint', { promptTokens: 10, completionTokens: 6 });
  assert.equal(store.account(account.id).credit.reservedMicros, 88);
  store.settle(next.id, usage);
  assert.equal(store.account(account.id).credit.balanceMicros, 1000000 - 38 - 76);
});

test('Supabase reservations receive the selected rate snapshot at the UTC boundary', async () => {
  let time = cutover - 1;
  const payloads = [];
  const store = new SupabaseAccountStore({ url: 'https://example.supabase.co', secretKey: 'sb_secret_test_price_schedule_credential',
    models: [model], now: () => time, fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      payloads.push(payload);
      return new Response(JSON.stringify({ result: { id: payload.p_payload.reservationId, fresh: true, status: 'reserved' } }), { headers: { 'content-type': 'application/json' } });
    },
  });
  await store.reserveUsd('test-account', 'before-cutover', model.id, 'before-fingerprint', { promptTokens: 10, completionTokens: 6 });
  time = cutover;
  await store.reserveUsd('test-account', 'after-cutover', model.id, 'after-fingerprint', { promptTokens: 10, completionTokens: 6 });
  assert.deepEqual(payloads.map(record => record.p_payload.pricing), [initial, later]);
  assert.deepEqual(payloads.map(record => record.p_payload.amount), [44, 88]);
  assert.ok(payloads.every(record => !JSON.stringify(record).includes('effectiveAt')));
});
