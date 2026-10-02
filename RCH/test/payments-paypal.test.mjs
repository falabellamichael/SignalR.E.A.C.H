import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import { AccountStore } from '../service/store.mjs';
import { createAccountService, signInMessage } from '../service/server.mjs';
import { validateConfig } from '../service/config.mjs';
import { usdMicros, validPayPalTopUp } from '../service/payments/paypal.mjs';

const example = JSON.parse(readFileSync(new URL('../config/subscription-bridges.example.json', import.meta.url), 'utf8'));
const NOW = 1_800_000_000_000, DAY = 86_400_000;
const CLIENT_ID = 'AYclientid' + 'x'.repeat(30), SECRET = 'EKsecret' + 'y'.repeat(30), PLAN = 'P-BASIC1234567890', WEBHOOK = 'WEBHOOK8PT597110';
const API = 'https://api-m.sandbox.paypal.com';

// PayPal as its REST API behaves, with just enough state for one customer.
function fakePayPal(accountId) {
  const calls = [];
  const state = { order: 'APPROVED', orderTag: `reach:top_up:${accountId}`, captureStatus: 'COMPLETED', captures: 0,
    subscription: { id: 'I-SUB1', plan_id: PLAN, custom_id: `reach:subscription_period:${accountId}`, status: 'ACTIVE',
      billing_info: { next_billing_time: new Date(NOW + 30 * DAY).toISOString() } } };
  const capture = () => ({ id: 'CAP1', status: state.captureStatus, amount: { currency_code: 'USD', value: '20.00' }, custom_id: state.orderTag });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const routes = {
    'POST /v1/oauth2/token': () => json({ access_token: 'A21-test-token', expires_in: 32400 }),
    'POST /v2/checkout/orders': () => json({ id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED',
      links: [{ rel: 'self', href: `${API}/v2/checkout/orders/ORDER1` }, { rel: 'payer-action', href: state.payerAction ?? 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }] }),
    'POST /v1/billing/subscriptions': () => json({ id: 'I-SUB1', status: 'APPROVAL_PENDING',
      links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1' }] }),
    'GET /v2/checkout/orders/ORDER1': () => json({ id: 'ORDER1', status: state.order, purchase_units: [{ custom_id: state.orderTag,
      ...(state.order === 'COMPLETED' ? { payments: { captures: [capture()] } } : {}) }] }),
    'POST /v2/checkout/orders/ORDER1/capture': () => { state.captures += 1; state.order = 'COMPLETED';
      return json({ id: 'ORDER1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [capture()] } }] }); },
    'GET /v2/payments/captures/CAP1': () => json(capture()),
    'POST /v1/notifications/verify-webhook-signature': (_, init) => json({ verification_status: JSON.parse(init.body).transmission_sig === 'genuine' ? 'SUCCESS' : 'FAILURE' }),
    'GET /v1/payments/sale/SALE1': () => json({ id: 'SALE1', state: state.saleState ?? 'completed', amount: { total: '15.00', currency: 'USD' }, billing_agreement_id: 'I-SUB1' }),
    'GET /v1/billing/subscriptions/I-SUB1': () => json(state.subscription),
    'GET /v2/payments/refunds/REF1': () => json({ id: 'REF1', status: state.refundStatus ?? 'COMPLETED', amount: { currency_code: 'USD', value: '20.00' },
      links: [{ rel: 'up', href: `${API}/v2/payments/captures/CAP1` }] }),
    'GET /v1/payments/refund/SREF1': () => json({ id: 'SREF1', state: 'completed', sale_id: 'SALE1', amount: { total: '15.00', currency: 'USD' } }),
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, API);
    calls.push({ method: init.method, path: u.pathname, init });
    const route = routes[`${init.method} ${u.pathname}`];
    return route ? route(u, init) : json({ name: 'RESOURCE_NOT_FOUND' }, 404);
  };
  return { fetchImpl, calls, state };
}

function service(t) {
  let time = NOW;
  const store = new AccountStore(':memory:', { models: example.models, subscription: example.subscription, now: () => time });
  const wallet = Wallet.createRandom(), verifier = randomBytes(32).toString('base64url'), stateValue = randomBytes(32).toString('base64url');
  const f = store.startFlow(stateValue, createHash('sha256').update(verifier).digest('base64url'));
  const c = store.challenge(f.flowId, wallet.address, (...a) => signInMessage('http://127.0.0.1:20978', 1, ...a));
  store.authorize(f.flowId, c.challengeId);
  const session = store.exchange(f.flowId, stateValue, verifier);
  const paypal = fakePayPal(session.account.id);
  const config = { origin: 'http://127.0.0.1:20978', chainId: 1, models: example.models, subscription: example.subscription,
    upstreamUrl: 'http://127.0.0.1:20777/v1', upstreamKey: 'host-only-test-credential', redemption: { enabled: false },
    payments: { paypal: { mode: 'sandbox', clientId: CLIENT_ID, clientSecret: SECRET, webhookId: WEBHOOK, basicPlanId: PLAN } } };
  const { server } = createAccountService({ config, store, paypalFetch: paypal.fetchImpl, now: () => time });
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => store.close());
  const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (method, path, { token, body, headers = {} } = {}) => {
    await ready;
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, text, body: /^\s*[{[]/.test(text) ? JSON.parse(text) : null };
  };
  const webhook = (type, id, sig = 'genuine') => call('POST', '/v1/billing/paypal/webhook', { body: { id: 'WH-' + randomBytes(4).toString('hex'), event_type: type, resource: { id } },
    headers: { 'PayPal-Auth-Algo': 'SHA256withRSA', 'PayPal-Cert-Url': 'https://api.sandbox.paypal.com/cert', 'PayPal-Transmission-Id': 't-1',
      'PayPal-Transmission-Sig': sig, 'PayPal-Transmission-Time': '2026-10-04T00:00:00Z' } });
  const view = async () => (await call('GET', '/v1/account', { token: session.accessToken })).body;
  return { store, paypal, call, webhook, view, token: session.accessToken, accountId: session.account.id };
}

test('PayPal amounts are read exactly and top-ups use whole cents', () => {
  assert.equal(usdMicros({ currency_code: 'USD', value: '20.00' }), 20_000_000);
  assert.equal(usdMicros({ currency: 'USD', total: '15' }), 15_000_000);
  assert.equal(usdMicros({ currency_code: 'USD', value: '0.5' }), 500_000);
  for (const bad of [{ currency_code: 'EUR', value: '1.00' }, { currency_code: 'USD', value: '1.005' }, { currency_code: 'USD', value: 20 }, null])
    assert.throws(() => usdMicros(bad), { code: 'unrecognized_payment' });
  assert.equal(validPayPalTopUp(12_340_000), true);
  assert.equal(validPayPalTopUp(1_005_000), false);
});

test('PayPal checkout opens only PayPal pages and tags every order with the account', async t => {
  const s = service(t);
  const config = (await s.call('GET', '/v1/account/config')).body;
  assert.deepEqual([config.paypalPayments, config.paypalOrigin, config.cardPayments], [true, 'https://www.sandbox.paypal.com', false]);
  const topUp = await s.call('POST', '/v1/billing/checkout', { token: s.token, body: { provider: 'paypal', kind: 'top_up', amountUsdMicros: 20_000_000 } });
  assert.equal(topUp.body.url, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1');
  const order = JSON.parse(s.paypal.calls.find(c => c.path === '/v2/checkout/orders').init.body);
  assert.deepEqual(order.purchase_units[0].amount, { currency_code: 'USD', value: '20.00' });
  assert.equal(order.purchase_units[0].custom_id, `reach:top_up:${s.accountId}`);
  assert.equal(order.payment_source.paypal.experience_context.return_url, 'http://127.0.0.1:20978/v1/billing/paypal/return');
  const sub = await s.call('POST', '/v1/billing/checkout', { token: s.token, body: { provider: 'paypal', kind: 'subscription' } });
  assert.match(sub.body.url, /^https:\/\/www\.sandbox\.paypal\.com\/webapps\/billing\/subscriptions/);
  const subscription = JSON.parse(s.paypal.calls.find(c => c.path === '/v1/billing/subscriptions').init.body);
  assert.deepEqual([subscription.plan_id, subscription.custom_id], [PLAN, `reach:subscription_period:${s.accountId}`]);
  // One OAuth token serves both requests, and the secret is only ever in Basic auth.
  const tokens = s.paypal.calls.filter(c => c.path === '/v1/oauth2/token');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].init.headers.Authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`);
  assert.ok(s.paypal.calls.filter(c => c.path !== '/v1/oauth2/token').every(c => c.init.headers.Authorization === 'Bearer A21-test-token'));
  assert.equal((await s.call('POST', '/v1/billing/checkout', { token: s.token, body: { provider: 'stripe', kind: 'subscription' } })).body.error.code, 'payments_unconfigured');
  assert.equal((await s.call('POST', '/v1/billing/checkout', { token: s.token, body: { provider: 'venmo', kind: 'subscription' } })).body.error.code, 'invalid_checkout');
  s.paypal.state.payerAction = 'https://www.paypal.com.evil.example/checkoutnow';
  assert.equal((await s.call('POST', '/v1/billing/checkout', { token: s.token, body: { provider: 'paypal', kind: 'top_up', amountUsdMicros: 5_000_000 } })).status, 502);
});

test('an approved top-up is captured on return, credited once, and every later notice is a duplicate', async t => {
  const s = service(t);
  const page = await s.call('GET', '/v1/billing/paypal/return?token=ORDER1&PayerID=PAYER1');
  assert.equal(page.status, 200);
  assert.match(page.text, /You can close this tab/);
  assert.equal(s.paypal.state.captures, 1);
  assert.equal((await s.view()).credit.balanceMicros, 20_000_000);
  const capture = s.paypal.calls.find(c => c.path === '/v2/checkout/orders/ORDER1/capture');
  assert.equal(capture.init.headers['PayPal-Request-Id'], 'reach-capture-ORDER1');
  await s.call('GET', '/v1/billing/paypal/return?token=ORDER1');
  assert.equal((await s.webhook('CHECKOUT.ORDER.APPROVED', 'ORDER1')).body.duplicate, true);
  assert.equal((await s.webhook('PAYMENT.CAPTURE.COMPLETED', 'CAP1')).body.duplicate, true);
  assert.equal(s.paypal.state.captures, 1, 'an already completed order is never captured again');
  assert.equal((await s.view()).credit.balanceMicros, 20_000_000);
  // A refund takes the credit back; a later chargeback finds nothing left to take.
  assert.equal((await s.webhook('PAYMENT.CAPTURE.REFUNDED', 'REF1')).body.status, 'applied');
  assert.equal((await s.view()).credit.balanceMicros, 0);
  s.paypal.state.captureStatus = 'REVERSED';
  const reversed = await s.webhook('PAYMENT.CAPTURE.REVERSED', 'CAP1');
  assert.equal(reversed.body.status, 'superseded');
});

test('the approved-order webhook captures when the customer never returns', async t => {
  const s = service(t);
  assert.equal((await s.webhook('CHECKOUT.ORDER.APPROVED', 'ORDER1')).body.status, 'applied');
  assert.equal((await s.view()).credit.balanceMicros, 20_000_000);
});

test('a PayPal subscription payment grants Basic to the next billing date, and a refund ends it', async t => {
  const s = service(t);
  assert.equal((await s.webhook('PAYMENT.SALE.COMPLETED', 'SALE1')).body.status, 'applied');
  const account = await s.view();
  assert.deepEqual([account.plan.id, account.plan.status, account.plan.expiresAt], ['basic-wallet', 'active', new Date(NOW + 30 * DAY).toISOString()]);
  assert.equal((await s.webhook('PAYMENT.SALE.COMPLETED', 'SALE1')).body.duplicate, true);
  assert.equal((await s.webhook('PAYMENT.SALE.REFUNDED', 'SREF1')).body.status, 'applied');
  assert.equal((await s.view()).plan.status, 'expired');
});

test('forged notices, other sellers\' sales and other plans change nothing', async t => {
  const s = service(t);
  const forged = await s.webhook('PAYMENT.SALE.COMPLETED', 'SALE1', 'forged');
  assert.deepEqual([forged.status, forged.body.error.code], [400, 'signature_invalid']);
  assert.ok(!s.paypal.calls.some(c => c.path.startsWith('/v1/payments/')), 'a forged notice triggers no lookups');
  s.paypal.state.subscription = { ...s.paypal.state.subscription, plan_id: 'P-SOMETHINGELSE00' };
  assert.equal((await s.webhook('PAYMENT.SALE.COMPLETED', 'SALE1')).body.ignored, 'not_reach');
  s.paypal.state.subscription = { ...s.paypal.state.subscription, plan_id: PLAN, custom_id: 'invoice-4711' };
  assert.equal((await s.webhook('PAYMENT.SALE.COMPLETED', 'SALE1')).body.ignored, 'not_reach');
  s.paypal.state.orderTag = 'my-shop-order-9';
  await s.call('GET', '/v1/billing/paypal/return?token=ORDER1');
  assert.equal(s.paypal.state.captures, 0, 'an order REACH did not create is never captured');
  assert.equal((await s.webhook('PAYMENT.CAPTURE.COMPLETED', 'NOPE1')).body.ignored, 'not_reach');
  assert.equal((await s.webhook('CUSTOMER.DISPUTE.CREATED', 'PP-D-1')).body.ignored, 'not_reach');
  const view = await s.view();
  assert.deepEqual([view.plan.status, view.credit.balanceMicros], ['none', 0]);
});

test('payments and refunds that have not settled change nothing', async t => {
  const s = service(t);
  s.paypal.state.captureStatus = 'PENDING';
  assert.equal((await s.webhook('PAYMENT.CAPTURE.COMPLETED', 'CAP1')).body.ignored, 'not_reach');
  s.paypal.state.captureStatus = 'COMPLETED'; s.paypal.state.orderTag = 'reach:subscription_period:' + s.accountId;
  assert.equal((await s.webhook('PAYMENT.CAPTURE.COMPLETED', 'CAP1')).body.ignored, 'not_reach', 'a capture tagged for another kind is not a top-up');
  s.paypal.state.saleState = 'pending';
  assert.equal((await s.webhook('PAYMENT.SALE.COMPLETED', 'SALE1')).body.ignored, 'not_reach');
  assert.deepEqual([(await s.view()).credit.balanceMicros, (await s.view()).plan.status], [0, 'none']);
  s.paypal.state.orderTag = 'reach:top_up:' + s.accountId;
  await s.webhook('PAYMENT.CAPTURE.COMPLETED', 'CAP1');
  s.paypal.state.refundStatus = 'FAILED';
  assert.equal((await s.webhook('PAYMENT.CAPTURE.REFUNDED', 'REF1')).body.ignored, 'not_reach');
  assert.equal((await s.view()).credit.balanceMicros, 20_000_000);
});

test('PayPal configuration keeps credentials in the environment and the plan explicit', () => {
  const raw = { origin: 'https://reach.example', port: 20978, database: 'accounts.sqlite', chainId: 1, upstreamUrl: 'http://127.0.0.1:20777/v1',
    upstreamKeyEnv: 'REACH_UPSTREAM_KEY', models: example.models, subscription: example.subscription,
    payments: { paypal: { mode: 'sandbox', clientIdEnv: 'PAYPAL_CLIENT_ID', clientSecretEnv: 'PAYPAL_CLIENT_SECRET', webhookId: WEBHOOK, basicPlanId: PLAN } } };
  const env = { REACH_UPSTREAM_KEY: 'host-only-test-credential', PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_CLIENT_SECRET: SECRET };
  assert.deepEqual(validateConfig(raw, process.cwd(), env).payments, { paypal: { mode: 'sandbox', clientId: CLIENT_ID, clientSecret: SECRET, webhookId: WEBHOOK, basicPlanId: PLAN } });
  const paypal = change => ({ ...raw, payments: { paypal: { ...raw.payments.paypal, ...change } } });
  for (const [config, environment, message] of [
    [paypal({ mode: 'test' }), env, /sandbox" or "live/],
    [paypal({ clientSecretEnv: 'PAYPAL_CLIENT_ID' }), env, /two separate/],
    [paypal({ clientIdEnv: 'REACH_UPSTREAM_KEY' }), env, /two separate/],
    [paypal({}), { ...env, PAYPAL_CLIENT_SECRET: 'short' }, /REST app secret/],
    [paypal({ basicPlanId: 'BASIC' }), env, /plan ID/],
    [paypal({ webhookId: 'webhook id' }), env, /webhook ID/],
    [paypal({ mode: 'live' }), env, null],
    [{ ...paypal({ mode: 'live' }), origin: 'http://127.0.0.1:20978' }, env, /public HTTPS/],
    [{ ...raw, payments: {} }, env, /Stripe, PayPal, or both/],
  ]) {
    if (message) assert.throws(() => validateConfig(config, process.cwd(), environment), message);
    else assert.equal(validateConfig(config, process.cwd(), environment).payments.paypal.mode, 'live');
  }
});
