import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStripe, checkPayPal, checkResend, checkBilling, formatReport, STRIPE_EVENTS, PAYPAL_EVENTS } from '../service/payments/preflight.mjs';

const ORIGIN = 'https://reach.example';
const stripe = { mode: 'test', basicPriceId: 'price_basic000001', secretKey: 'sk_test_' + 's'.repeat(40), webhookSecret: 'whsec_' + 'w'.repeat(32) };
const paypal = { mode: 'sandbox', clientId: 'AYclient' + 'c'.repeat(30), clientSecret: 'EKsecret' + 'e'.repeat(30), webhookId: 'WEBHOOK8PT597110', basicPlanId: 'P-BASIC1234567890' };
const resend = { apiKey: 're_' + 'r'.repeat(30), from: 'REACH <login@reach.example>' };
const SECRETS = [stripe.secretKey, paypal.clientSecret, resend.apiKey];

// A provider API built from routes; every request is recorded.
function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: u, init });
    const route = routes[`${init.method} ${u.pathname}`];
    const reply = route ? route(u, init) : { status: 404, body: { error: { message: `no ${stripe.secretKey}` } } };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  };
  return { fetchImpl, calls };
}
const goodPrice = { id: stripe.basicPriceId, livemode: false, active: true, currency: 'usd', unit_amount: 1500, recurring: { interval: 'month', interval_count: 1, trial_period_days: null } };
const stripeRoutes = (over = {}) => ({
  [`GET /v1/prices/${stripe.basicPriceId}`]: () => ({ body: { ...goodPrice, ...over.price } }),
  'GET /v1/webhook_endpoints': () => ({ body: { data: over.hooks ?? [{ url: `${ORIGIN}/v1/billing/stripe/webhook`, status: 'enabled', enabled_events: STRIPE_EVENTS }] } }),
  'GET /v1/billing_portal/configurations': () => ({ body: { data: [{ is_default: true, features: { subscription_cancel: { enabled: over.cancel ?? true } } }] } }),
  ...over.routes,
});
const goodPlan = { id: paypal.basicPlanId, status: 'ACTIVE', billing_cycles: [{ tenure_type: 'REGULAR', frequency: { interval_unit: 'MONTH', interval_count: 1 },
  pricing_scheme: { fixed_price: { value: '15.0', currency_code: 'USD' } }, total_cycles: 0 }], payment_preferences: { setup_fee: { value: '0', currency_code: 'USD' } }, taxes: { percentage: '0' } };
const paypalRoutes = (over = {}) => ({
  'POST /v1/oauth2/token': () => over.token ?? { body: { access_token: 'A21-token', expires_in: 32400 } },
  [`GET /v1/billing/plans/${paypal.basicPlanId}`]: () => ({ body: { ...goodPlan, ...over.plan } }),
  [`GET /v1/notifications/webhooks/${paypal.webhookId}`]: () => ({ body: { id: paypal.webhookId, url: over.hookUrl ?? `${ORIGIN}/v1/billing/paypal/webhook`,
    event_types: (over.events ?? PAYPAL_EVENTS).map(name => ({ name })) } }),
});
const statuses = results => results.map(result => `${result.check}:${result.status}`);

test('a correct Stripe setup passes every check using only reads', async () => {
  const api = fake(stripeRoutes());
  const results = await checkStripe(stripe, { origin: ORIGIN, fetchImpl: api.fetchImpl });
  assert.deepEqual(statuses(results), ['Basic price:ok', 'Webhook:ok', 'Customer portal:ok']);
  assert.ok(api.calls.every(call => call.method === 'GET'));
  assert.ok(api.calls.every(call => call.init.headers.Authorization === `Bearer ${stripe.secretKey}` && call.init.headers['Stripe-Version']));
});

test('Stripe mistakes are named one by one', async () => {
  const run = async over => checkStripe(stripe, { origin: ORIGIN, fetchImpl: fake(stripeRoutes(over)).fetchImpl });
  const price = await run({ price: { unit_amount: 1000, currency: 'eur', recurring: { interval: 'year', interval_count: 1, trial_period_days: 7 }, livemode: true, active: false } });
  assert.equal(price[0].status, 'problem');
  for (const words of ['live mode', 'archived', 'EUR', '1000 cents', 'every month', 'free trial']) assert.match(price[0].detail, new RegExp(words));
  assert.match((await run({ hooks: [] }))[1].detail, /No Stripe webhook sends to https:\/\/reach\.example\/v1\/billing\/stripe\/webhook/);
  assert.match((await run({ hooks: [{ url: `${ORIGIN}/v1/billing/stripe/webhook`, status: 'enabled', enabled_events: ['invoice.paid'] }] }))[1].detail, /missing these events: checkout\.session\.completed/);
  assert.equal((await run({ hooks: [{ url: `${ORIGIN}/v1/billing/stripe/webhook`, status: 'enabled', enabled_events: ['*'] }] }))[1].status, 'ok');
  assert.match((await run({ hooks: [{ url: `${ORIGIN}/v1/billing/stripe/webhook`, status: 'disabled', enabled_events: STRIPE_EVENTS }] }))[1].detail, /disabled/);
  assert.match((await run({ cancel: false }))[2].detail, /Turn on cancellation/);
  // A restricted key that may not read webhooks is a skip, not a failure.
  const limited = await run({ routes: { 'GET /v1/webhook_endpoints': () => ({ status: 403, body: { error: { message: `key ${stripe.secretKey}` } } }) } });
  assert.equal(limited[1].status, 'skipped');
  const missing = await checkStripe(stripe, { origin: ORIGIN, fetchImpl: fake({ ...stripeRoutes(), [`GET /v1/prices/${stripe.basicPriceId}`]: () => ({ status: 404 }) }).fetchImpl });
  assert.match(missing[0].detail, /no price price_basic000001 in test mode/);
  const wrongKey = await checkStripe(stripe, { origin: ORIGIN, fetchImpl: fake({ [`GET /v1/prices/${stripe.basicPriceId}`]: () => ({ status: 401 }) }).fetchImpl });
  assert.deepEqual(statuses(wrongKey), ['Stripe key and Basic price:problem']);
});

test('a correct PayPal setup passes; plan and webhook mistakes are named', async () => {
  const api = fake(paypalRoutes());
  assert.deepEqual(statuses(await checkPayPal(paypal, { origin: ORIGIN, fetchImpl: api.fetchImpl })), ['PayPal credentials:ok', 'Basic plan:ok', 'Webhook:ok']);
  assert.ok(api.calls.every(call => call.method === 'GET' || call.url.pathname === '/v1/oauth2/token'), 'only the token request is a POST');
  assert.equal(api.calls[0].url.origin, 'https://api-m.sandbox.paypal.com');
  const run = async over => checkPayPal(paypal, { origin: ORIGIN, fetchImpl: fake(paypalRoutes(over)).fetchImpl });
  const plan = await run({ plan: { status: 'INACTIVE', taxes: { percentage: '8' }, payment_preferences: { setup_fee: { value: '5' } },
    billing_cycles: [{ tenure_type: 'TRIAL' }, { tenure_type: 'REGULAR', frequency: { interval_unit: 'YEAR', interval_count: 1 }, pricing_scheme: { fixed_price: { value: '150.00', currency_code: 'USD' } } }] } });
  for (const words of ['INACTIVE', 'trial', 'every month', '150.00 USD', 'setup fee', 'adds tax']) assert.match(plan[1].detail, new RegExp(words));
  assert.match((await run({ hookUrl: 'https://old.example/hook' }))[2].detail, /sends to https:\/\/old\.example\/hook/);
  assert.match((await run({ events: ['PAYMENT.SALE.COMPLETED'] }))[2].detail, /missing these events: CHECKOUT\.ORDER\.APPROVED/);
  assert.deepEqual(statuses(await run({ token: { status: 401, body: {} } })), ['PayPal credentials:problem']);
});

test('Resend: a verified domain passes, others are named, a sending-only key is a skip', async () => {
  const run = async reply => checkResend(resend, { fetchImpl: fake({ 'GET /domains': () => reply }).fetchImpl });
  assert.equal((await run({ body: { data: [{ name: 'reach.example', status: 'verified' }] } }))[0].status, 'ok');
  assert.match((await run({ body: { data: [{ name: 'reach.example', status: 'pending' }] } }))[0].detail, /pending, not verified/);
  assert.match((await run({ body: { data: [{ name: 'other.example', status: 'verified' }] } }))[0].detail, /not added to Resend/);
  assert.equal((await run({ status: 401, body: { name: 'restricted_api_key' } }))[0].status, 'skipped');
  assert.equal((await run({ status: 401, body: { name: 'validation_error' } }))[0].status, 'problem');
});

test('the report is ready only without problems, and never prints a credential', async () => {
  const routes = { ...stripeRoutes(), ...paypalRoutes(), 'GET /domains': () => ({ status: 401, body: { name: 'restricted_api_key' } }) };
  const api = fake(routes);
  // Both providers share one fake host table; route by path.
  const fetchImpl = (url, init) => api.fetchImpl(url, init);
  const config = { origin: ORIGIN, subscription: {}, payments: { stripe, paypal }, email: { resend } };
  const ready = await checkBilling(config, { fetchImpl });
  assert.equal(ready.ready, true);
  const text = formatReport(ready);
  assert.match(text, /^Stripe \(test\)/m);
  assert.match(text, /CHECK   Sending domain/);
  assert.match(text, /Ready: no problems found/);
  for (const secret of SECRETS) assert.ok(!text.includes(secret));
  const broken = await checkBilling({ ...config, payments: { stripe } }, { fetchImpl: fake({}).fetchImpl });
  assert.equal(broken.ready, false);
  const brokenText = formatReport(broken);
  assert.match(brokenText, /Not ready/);
  for (const secret of SECRETS) assert.ok(!brokenText.includes(secret), 'provider error text is never echoed');
  assert.equal((await checkBilling({ origin: ORIGIN })).ready, false, 'no Basic subscription is a problem');
});
