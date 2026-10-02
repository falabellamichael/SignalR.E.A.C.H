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
    return new Response(JSON.stringify('body' in reply ? reply.body : {}), { status: reply.status ?? 200 });
  };
  return { fetchImpl, calls };
}
const goodPrice = { id: stripe.basicPriceId, livemode: false, active: true, currency: 'usd', unit_amount: 1500, billing_scheme: 'per_unit', transform_quantity: null, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', trial_period_days: null } };
const stripeRoutes = (over = {}) => ({
  [`GET /v1/prices/${stripe.basicPriceId}`]: () => ({ body: { ...goodPrice, ...over.price } }),
  'GET /v1/webhook_endpoints': () => ({ body: { data: over.hooks ?? [{ url: `${ORIGIN}/v1/billing/stripe/webhook`, status: 'enabled', enabled_events: STRIPE_EVENTS }] } }),
  'GET /v1/billing_portal/configurations': () => ({ body: { data: [{ is_default: true, active: true, livemode: false, features: { subscription_cancel: { enabled: over.cancel ?? true } } }] } }),
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
  assert.match((await run({ hookUrl: 'https://old.example/hook' }))[2].detail, /must send to https:\/\/reach\.example\/v1\/billing\/paypal\/webhook/);
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

test('the report requires every check verified, and never prints a credential', async () => {
  const routes = { ...stripeRoutes(), ...paypalRoutes(), 'GET /domains': () => ({ status: 401, body: { name: 'restricted_api_key' } }) };
  const api = fake(routes);
  // Both providers share one fake host table; route by path.
  const fetchImpl = (url, init) => api.fetchImpl(url, init);
  const config = { origin: ORIGIN, subscription: {}, payments: { stripe, paypal }, email: { resend } };
  const ready = await checkBilling(config, { fetchImpl });
  assert.equal(ready.ready, false);
  const text = formatReport(ready);
  assert.match(text, /^Stripe \(test\)/m);
  assert.match(text, /CHECK   Sending domain/);
  assert.match(text, /Not verified:.*CHECK/);
  for (const secret of SECRETS) assert.ok(!text.includes(secret));
  const broken = await checkBilling({ ...config, payments: { stripe } }, { fetchImpl: fake({}).fetchImpl });
  assert.equal(broken.ready, false);
  const brokenText = formatReport(broken);
  assert.match(brokenText, /Not ready/);
  for (const secret of SECRETS) assert.ok(!brokenText.includes(secret), 'provider error text is never echoed');
  assert.equal((await checkBilling({ origin: ORIGIN })).ready, false, 'no Basic subscription is a problem');
});


test('all verified providers pass, but a subscription and sender alone cannot take payments', async () => {
  const routes = { ...stripeRoutes(), ...paypalRoutes(), 'GET /domains': () => ({ body: { data: [{ name: 'reach.example', status: 'verified' }] } }) };
  const config = { origin: ORIGIN, subscription: {}, payments: { stripe, paypal }, email: { resend } };
  const report = await checkBilling(config, { fetchImpl: fake(routes).fetchImpl });
  assert.equal(report.ready, true);
  assert.match(formatReport(report), /Ready: provider configuration verified/);
  const noPayments = await checkBilling({ ...config, payments: {} }, { fetchImpl: fake(routes).fetchImpl });
  assert.equal(noPayments.ready, false);
  assert.match(formatReport(noPayments), /No payment provider/);
  const restricted = await checkBilling({ ...config, email: {} }, { fetchImpl: fake(stripeRoutes({ routes: {
    'GET /v1/webhook_endpoints': () => ({ status: 403 }),
  } })).fetchImpl });
  assert.equal(restricted.ready, false);
  assert.match(formatReport(restricted), /CHECK/);
});

test('provider outages, throttling and request failures never count as permission checks', async () => {
  for (const status of [400, 429, 500, 503]) {
    const reply = () => ({ status, body: { message: resend.apiKey, access_token: 'should-not-be-used' } });
    const stripeApi = fake({
      [`GET /v1/prices/${stripe.basicPriceId}`]: reply,
      'GET /v1/webhook_endpoints': reply,
      'GET /v1/billing_portal/configurations': reply,
    });
    assert.ok((await checkStripe(stripe, { origin: ORIGIN, fetchImpl: stripeApi.fetchImpl })).every(r => r.status === 'problem'));
    const paypalApi = fake({ ...paypalRoutes(),
      [`GET /v1/billing/plans/${paypal.basicPlanId}`]: reply,
      [`GET /v1/notifications/webhooks/${paypal.webhookId}`]: reply,
    });
    assert.ok((await checkPayPal(paypal, { origin: ORIGIN, fetchImpl: paypalApi.fetchImpl })).slice(1).every(r => r.status === 'problem'));
    const oauthApi = fake({ 'POST /v1/oauth2/token': reply });
    assert.deepEqual(statuses(await checkPayPal(paypal, { origin: ORIGIN, fetchImpl: oauthApi.fetchImpl })), ['PayPal credentials:problem']);
    assert.equal(oauthApi.calls.length, 1, 'no reads with a token from an unsuccessful OAuth response');
    assert.equal((await checkResend(resend, { fetchImpl: fake({ 'GET /domains': reply }).fetchImpl }))[0].status, 'problem');
  }
  for (const token of ['', ' ', null]) {
    assert.equal((await checkPayPal(paypal, { origin: ORIGIN, fetchImpl: fake(paypalRoutes({ token: { body: { access_token: token } } })).fetchImpl }))[0].status, 'problem');
  }
  for (const name of ['restricted_api_key', 'suspended_api_key', 'validation_error']) {
    assert.equal((await checkResend(resend, { fetchImpl: fake({ 'GET /domains': () => ({ status: 403, body: { name } }) }).fetchImpl }))[0].status, 'problem');
  }
  assert.equal((await checkResend(resend, { fetchImpl: fake({ 'GET /domains': () => ({ status: 403, body: { name: 'invalid_permission' } }) }).fetchImpl }))[0].status, 'skipped');
});

test('malformed successful provider replies report problems without crashing', async () => {
  for (const body of [null, [], {}, 'unexpected']) {
    const stripeApi = fake({
      [`GET /v1/prices/${stripe.basicPriceId}`]: () => ({ body }),
      'GET /v1/webhook_endpoints': () => ({ body }),
      'GET /v1/billing_portal/configurations': () => ({ body }),
    });
    assert.ok((await checkStripe(stripe, { origin: ORIGIN, fetchImpl: stripeApi.fetchImpl })).every(r => r.status === 'problem'));
    const paypalApi = fake({ ...paypalRoutes(),
      [`GET /v1/billing/plans/${paypal.basicPlanId}`]: () => ({ body }),
      [`GET /v1/notifications/webhooks/${paypal.webhookId}`]: () => ({ body }),
    });
    assert.ok((await checkPayPal(paypal, { origin: ORIGIN, fetchImpl: paypalApi.fetchImpl })).slice(1).every(r => r.status === 'problem'));
    assert.equal((await checkResend(resend, { fetchImpl: fake({ 'GET /domains': () => ({ body }) }).fetchImpl }))[0].status, 'problem');
  }
  const malformedEvents = fake(stripeRoutes({ hooks: [{ url: `${ORIGIN}/v1/billing/stripe/webhook`, status: 'enabled', enabled_events: {} }] }));
  assert.equal((await checkStripe(stripe, { origin: ORIGIN, fetchImpl: malformedEvents.fetchImpl }))[1].status, 'problem');
  const malformedDomains = fake({ 'GET /domains': () => ({ body: { data: [{ name: 42 }] } }) });
  assert.equal((await checkResend(resend, { fetchImpl: malformedDomains.fetchImpl }))[0].status, 'problem');
});

test('metered or transformed prices, finite plans and inactive portals are not Basic', async () => {
  for (const price of [
    { recurring: { ...goodPrice.recurring, usage_type: 'metered' } },
    { billing_scheme: 'tiered' }, { transform_quantity: { divide_by: 2, round: 'up' } },
  ]) {
    assert.equal((await checkStripe(stripe, { origin: ORIGIN, fetchImpl: fake(stripeRoutes({ price })).fetchImpl }))[0].status, 'problem');
  }
  const finite = { billing_cycles: [{ ...goodPlan.billing_cycles[0], total_cycles: 1 }] };
  assert.equal((await checkPayPal(paypal, { origin: ORIGIN, fetchImpl: fake(paypalRoutes({ plan: finite })).fetchImpl }))[1].status, 'problem');
  for (const override of [{ active: false }, { is_default: false }, { livemode: true }]) {
    const api = fake(stripeRoutes({ routes: { 'GET /v1/billing_portal/configurations': () => ({ body: { data: [{
      active: true, is_default: true, livemode: false, features: { subscription_cancel: { enabled: true } }, ...override,
    }] } }) } }));
    assert.equal((await checkStripe(stripe, { origin: ORIGIN, fetchImpl: api.fetchImpl }))[2].status, 'problem');
  }
});

test('successful response fields cannot echo credentials into the report', async () => {
  const routes = { ...stripeRoutes({ price: { currency: stripe.secretKey, unit_amount: stripe.secretKey } }),
    ...paypalRoutes({ plan: { status: paypal.clientSecret, billing_cycles: [{ ...goodPlan.billing_cycles[0],
      pricing_scheme: { fixed_price: { value: paypal.clientSecret, currency_code: paypal.clientSecret } } }] },
      hookUrl: `https://wrong.example/?key=${paypal.clientSecret}` }),
    'GET /domains': () => ({ body: { data: [{ name: 'reach.example', status: resend.apiKey }] } }),
  };
  const report = await checkBilling({ origin: ORIGIN, subscription: {}, payments: { stripe, paypal }, email: { resend } }, { fetchImpl: fake(routes).fetchImpl });
  assert.equal(report.ready, false);
  for (const secret of SECRETS) assert.ok(!formatReport(report).includes(secret));
});
