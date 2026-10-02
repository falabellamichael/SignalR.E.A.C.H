import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import { AccountStore } from '../service/store.mjs';
import { createAccountService, signInMessage } from '../service/server.mjs';
import { validateConfig } from '../service/config.mjs';
import { verifyStripeSignature, paymentFromStripeEvent, reversalFromStripeEvent, checkoutParams, formEncode, validTopUpAmount, STRIPE_VERSION, createStripeClient } from '../service/payments/stripe.mjs';

const example = JSON.parse(readFileSync(new URL('../config/subscription-bridges.example.json', import.meta.url), 'utf8'));
const SECRET = 'whsec_' + 'a'.repeat(32), KEY = 'sk_test_' + 'b'.repeat(40), PRICE = 'price_basic000001';
const DAY = 86_400_000, NOW = 1_800_000_000_000;
const sign = (body, t = Math.floor(NOW / 1000), secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

// ---- realistic Stripe objects, in both API shapes ---------------------------
const invoice = (accountId, over = {}) => ({ id: 'in_0001', object: 'invoice', currency: 'usd', status: 'paid',
  total: 1650, total_excluding_tax: 1500,
  parent: { type: 'subscription_details', subscription_details: { metadata: { reach_account_id: accountId, reach_kind: 'subscription_period' } } },
  lines: { data: [{ pricing: { price_details: { price: PRICE } }, period: { start: NOW / 1000, end: (NOW + 30 * DAY) / 1000 } }] }, ...over });
const session = (accountId, over = {}) => ({ id: 'cs_test_0001', object: 'checkout.session', mode: 'payment', payment_status: 'paid',
  currency: 'usd', amount_total: 2200, total_details: { amount_tax: 200 },
  metadata: { reach_account_id: accountId, reach_kind: 'top_up' }, ...over });
const event = (type, object, over = {}) => ({ id: 'evt_' + randomBytes(6).toString('hex'), type, livemode: false, data: { object }, ...over });
const opts = { basicPriceId: PRICE, livemode: false };

test('a Stripe signature is accepted only for the exact body, secret and a fresh timestamp', () => {
  const body = '{"id":"evt_1"}', raw = Buffer.from(body);
  assert.equal(verifyStripeSignature(raw, sign(body), SECRET, NOW), true);
  assert.equal(verifyStripeSignature(raw, sign(body, undefined, 'whsec_' + 'z'.repeat(32)), SECRET, NOW), false);
  assert.equal(verifyStripeSignature(Buffer.from(body + ' '), sign(body), SECRET, NOW), false);
  assert.equal(verifyStripeSignature(raw, sign(body, Math.floor(NOW / 1000) - 301), SECRET, NOW), false);
  assert.equal(verifyStripeSignature(raw, sign(body, Math.floor(NOW / 1000) + 301), SECRET, NOW), false);
  // During secret rotation Stripe sends one signature per secret.
  const rotated = `${sign(body, undefined, 'whsec_' + 'z'.repeat(32))},v1=${sign(body).split('v1=')[1]}`;
  assert.equal(verifyStripeSignature(raw, rotated, SECRET, NOW), true);
  for (const header of [undefined, '', 't=abc,v1=00', `t=${Math.floor(NOW / 1000)}`, 'v1=' + 'a'.repeat(64), sign(body).replace('v1=', 'v0=')])
    assert.equal(verifyStripeSignature(raw, header, SECRET, NOW), false, String(header));
  assert.equal(verifyStripeSignature(body, sign(body), SECRET, NOW), false);
});

test('a paid invoice becomes a subscription payment, excluding tax, in milliseconds', () => {
  const { payment } = paymentFromStripeEvent(event('invoice.paid', invoice('acct_12345678')), opts);
  assert.deepEqual({ ...payment, eventId: undefined }, { provider: 'stripe', eventId: undefined, objectId: 'in_0001',
    kind: 'subscription_period', accountId: 'acct_12345678', amountUsdMicros: 15_000_000, currency: 'usd', periodEnd: NOW + 30 * DAY });
  // The pre-2025 shape: metadata on subscription_details, price as an object.
  const legacy = invoice('acct_12345678', { parent: undefined, subscription_details: { metadata: { reach_account_id: 'acct_12345678', reach_kind: 'subscription_period' } },
    lines: { data: [{ price: { id: PRICE }, period: { end: (NOW + 30 * DAY) / 1000 } }] } });
  assert.equal(paymentFromStripeEvent(event('invoice.paid', legacy), opts).payment.periodEnd, NOW + 30 * DAY);
});

test('Stripe objects that are not REACH payments are ignored, and unreadable REACH ones fail loudly', () => {
  const ignored = (type, object, over) => paymentFromStripeEvent(event(type, object, over), opts).ignored;
  assert.equal(ignored('invoice.paid', invoice('acct_12345678', { parent: null })), 'not_reach');
  assert.equal(ignored('invoice.paid', invoice('acct_12345678'), { livemode: true }), 'wrong_mode');
  assert.equal(ignored('invoice.paid', invoice('acct_12345678', { total_excluding_tax: 0 })), 'zero_amount');
  assert.equal(ignored('customer.created', {}), 'event_type');
  assert.equal(ignored('checkout.session.completed', session('acct_12345678', { payment_status: 'unpaid' })), 'not_paid');
  assert.equal(ignored('checkout.session.completed', session('acct_12345678', { mode: 'subscription' })), 'not_reach');
  assert.equal(ignored('checkout.session.completed', session('acct_12345678', { metadata: {} })), 'not_reach');
  assert.throws(() => paymentFromStripeEvent(event('invoice.paid', invoice('acct_12345678', { lines: { data: [] } })), opts), { code: 'unrecognized_payment' });
  assert.throws(() => paymentFromStripeEvent(event('invoice.paid', invoice('acct_12345678', { total_excluding_tax: null })), opts), { code: 'unrecognized_payment' });
  assert.throws(() => paymentFromStripeEvent({ type: 'invoice.paid' }, opts), { code: 'invalid_event' });
});

test('a paid top-up checkout credits the amount before tax; a delayed bank payment counts when it clears', () => {
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
    const { payment } = paymentFromStripeEvent(event(type, session('acct_12345678')), opts);
    assert.equal(payment.kind, 'top_up');
    assert.equal(payment.objectId, 'cs_test_0001');
    assert.equal(payment.amountUsdMicros, 20_000_000);
  }
});

test('checkout parameters carry the account on the session and on every renewal', () => {
  const sub = formEncode(checkoutParams({ kind: 'subscription', accountId: 'acct_12345678', basicPriceId: PRICE, origin: 'https://reach.example', nowMs: NOW }));
  assert.equal(sub.get('mode'), 'subscription');
  assert.equal(sub.get('line_items[0][price]'), PRICE);
  assert.equal(sub.get('subscription_data[metadata][reach_account_id]'), 'acct_12345678');
  assert.equal(sub.get('subscription_data[metadata][reach_kind]'), 'subscription_period');
  assert.equal(sub.get('success_url'), 'https://reach.example/billing/return?checkout=success');
  assert.equal(sub.get('expires_at'), String(NOW / 1000 + 3600));
  const top = formEncode(checkoutParams({ kind: 'top_up', amountUsdMicros: 25_000_000, accountId: 'acct_12345678', basicPriceId: PRICE, origin: 'https://reach.example', nowMs: NOW }));
  assert.equal(top.get('mode'), 'payment');
  assert.equal(top.get('line_items[0][price_data][unit_amount]'), '2500');
  assert.equal(top.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(top.get('metadata[reach_kind]'), 'top_up');
  for (const [value, ok] of [[1_000_000, true], [500_000_000, true], [999_999, false], [500_010_000, false], [1_005_000, false], [12_340_000, true], ['5000000', false]])
    assert.equal(validTopUpAmount(value), ok, String(value));
});

// ---- the running service, with Stripe's API replaced by a recorder ----------
function service(t, { payments = true, stripeReply, stripeRoute } = {}) {
  let time = NOW;
  const store = new AccountStore(':memory:', { models: example.models, subscription: example.subscription, now: () => time });
  const calls = [];
  const paymentFetch = async (url, init) => {
    calls.push({ url, init, form: new URLSearchParams(init.body) });
    const routed = stripeRoute?.(new URL(url), init);
    const reply = routed ?? stripeReply ?? { status: 200, body: { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new', expires_at: NOW / 1000 + 3600 } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  const config = { origin: 'http://127.0.0.1:20978', chainId: 1, models: example.models, subscription: example.subscription,
    upstreamUrl: 'http://127.0.0.1:20777/v1', upstreamKey: 'host-only-test-credential', redemption: { enabled: false },
    ...(payments ? { payments: { stripe: { mode: 'test', basicPriceId: PRICE, secretKey: KEY, webhookSecret: SECRET } } } : {}) };
  const { server } = createAccountService({ config, store, paymentFetch, now: () => time });
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => store.close());
  const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = async () => { await ready; return `http://127.0.0.1:${server.address().port}`; };
  const signIn = (wallet = Wallet.createRandom()) => {
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    const f = store.startFlow(state, createHash('sha256').update(verifier).digest('base64url'));
    const c = store.challenge(f.flowId, wallet.address, (...a) => signInMessage(config.origin, 1, ...a));
    store.authorize(f.flowId, c.challengeId);
    const s = store.exchange(f.flowId, state, verifier);
    return { token: s.accessToken, accountId: s.account.id, wallet };
  };
  const call = async (method, path, { token, body, raw, headers = {} } = {}) => {
    const r = await fetch(await base() + path, { method, headers: { ...(body || raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const webhook = (evt, signature) => { const raw = JSON.stringify(evt); return call('POST', '/v1/billing/stripe/webhook', { raw, headers: { 'Stripe-Signature': signature ?? sign(raw) } }); };
  return { store, calls, call, signIn, webhook, advance: ms => { time += ms; } };
}

test('checkout is created for the signed-in account and never leaks provider errors', async t => {
  const s = service(t), { token, accountId } = s.signIn();
  assert.equal((await s.call('GET', '/v1/account/config')).body.cardPayments, true);
  assert.equal((await s.call('POST', '/v1/billing/checkout', { body: { kind: 'subscription' } })).status, 401);
  const created = await s.call('POST', '/v1/billing/checkout', { token, body: { kind: 'subscription' } });
  assert.equal(created.status, 200);
  assert.equal(created.body.url, 'https://checkout.stripe.com/c/pay/cs_test_new');
  const [sent] = s.calls;
  assert.equal(sent.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(sent.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(sent.form.get('client_reference_id'), accountId);
  assert.equal(sent.form.get('subscription_data[metadata][reach_account_id]'), accountId);
  assert.equal((await s.call('POST', '/v1/billing/checkout', { token, body: { kind: 'top_up', amountUsdMicros: 999_999 } })).body.error.code, 'invalid_amount');
  assert.equal((await s.call('POST', '/v1/billing/checkout', { token, body: { kind: 'lifetime' } })).body.error.code, 'invalid_checkout');
  assert.equal((await s.call('POST', '/v1/billing/checkout', { token, body: { kind: 'top_up', amountUsdMicros: 5_000_000 } })).status, 200);
  assert.equal(s.calls.at(-1).form.get('line_items[0][price_data][unit_amount]'), '500');

  const refused = service(t, { stripeReply: { status: 400, body: { error: { message: `No such price: ${PRICE}` } } } }), r = refused.signIn();
  const failed = await refused.call('POST', '/v1/billing/checkout', { token: r.token, body: { kind: 'subscription' } });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(JSON.stringify(failed.body), /price_|sk_test/);
  const phishing = service(t, { stripeReply: { status: 200, body: { url: 'https://checkout.stripe.com.evil.example/pay' } } }), p = phishing.signIn();
  assert.equal((await phishing.call('POST', '/v1/billing/checkout', { token: p.token, body: { kind: 'subscription' } })).status, 502);
});

test('a signed paid invoice activates Basic once; replays and forgeries change nothing', async t => {
  const s = service(t), { token, accountId } = s.signIn();
  const paid = event('invoice.paid', invoice(accountId));
  const forged = await s.webhook(paid, sign(JSON.stringify(paid), undefined, 'whsec_' + 'z'.repeat(32)));
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, 'signature_invalid');
  assert.equal((await s.call('GET', '/v1/account', { token })).body.plan.status, 'none');

  const first = await s.webhook(paid);
  assert.deepEqual(first.body, { received: true, status: 'applied', duplicate: false });
  const account = (await s.call('GET', '/v1/account', { token })).body;
  assert.equal(account.plan.id, 'basic-wallet');
  assert.equal(account.plan.expiresAt, new Date(NOW + 30 * DAY).toISOString());
  // Stripe redelivers, and sends a second event type for the same invoice.
  assert.equal((await s.webhook(paid)).body.duplicate, true);
  assert.equal((await s.webhook({ ...paid, id: 'evt_again' })).body.duplicate, true);
  // A second checkout would charge twice; renewals are automatic.
  assert.equal((await s.call('POST', '/v1/billing/checkout', { token, body: { kind: 'subscription' } })).body.error.code, 'plan_active');
  // A renewal invoice extends the plan.
  const renewal = invoice(accountId, { id: 'in_0002', lines: { data: [{ pricing: { price_details: { price: PRICE } }, period: { end: (NOW + 60 * DAY) / 1000 } }] } });
  assert.equal((await s.webhook(event('invoice.paid', renewal))).body.status, 'applied');
  assert.equal((await s.call('GET', '/v1/account', { token })).body.plan.expiresAt, new Date(NOW + 60 * DAY).toISOString());
});

test('a signed top-up credits the balance and shows in the account history without provider IDs', async t => {
  const s = service(t), { token, accountId } = s.signIn();
  assert.equal((await s.webhook(event('checkout.session.completed', session(accountId)))).body.status, 'applied');
  assert.equal((await s.call('GET', '/v1/account', { token })).body.credit.balanceMicros, 20_000_000);
  const history = await s.call('GET', '/v1/billing/payments', { token });
  assert.equal(history.body.data.length, 1);
  assert.equal(history.body.data[0].amountUsdMicros, 20_000_000);
  assert.doesNotMatch(JSON.stringify(history.body), /cs_test_|evt_/);
  // Unrelated Stripe traffic and unknown accounts are answered so Stripe stops retrying.
  assert.equal((await s.webhook(event('customer.created', { id: 'cus_1' }))).body.ignored, 'event_type');
  const stranger = await s.webhook(event('checkout.session.completed', session('acct_unknown01', { id: 'cs_test_0002' })));
  assert.deepEqual([stranger.status, stranger.body.status], [200, 'rejected']);
  assert.equal(s.store.flaggedPayments()[0].objectId, 'cs_test_0002');
});

test('without Stripe configured the routes are closed', async t => {
  const s = service(t, { payments: false }), { token } = s.signIn();
  assert.equal((await s.call('GET', '/v1/account/config')).body.cardPayments, false);
  assert.equal((await s.webhook(event('invoice.paid', invoice('acct_12345678')))).status, 404);
  assert.equal((await s.call('POST', '/v1/billing/checkout', { token, body: { kind: 'subscription' } })).body.error.code, 'payments_unconfigured');
});

test('Stripe configuration keeps keys in the environment and matches key to mode', () => {
  const raw = { origin: 'http://127.0.0.1:20978', port: 20978, database: 'accounts.sqlite', chainId: 1, upstreamUrl: 'http://127.0.0.1:20777/v1',
    upstreamKeyEnv: 'REACH_UPSTREAM_KEY', models: example.models, subscription: example.subscription,
    payments: { stripe: { mode: 'test', secretKeyEnv: 'STRIPE_SECRET_KEY', webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET', basicPriceId: PRICE } } };
  const env = { REACH_UPSTREAM_KEY: 'host-only-test-credential', STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET };
  const ok = validateConfig(raw, process.cwd(), env);
  assert.deepEqual(ok.payments.stripe, { mode: 'test', basicPriceId: PRICE, secretKey: KEY, webhookSecret: SECRET });
  assert.equal(validateConfig(raw, process.cwd(), { ...env, STRIPE_SECRET_KEY: 'rk_test_' + 'c'.repeat(40) }).payments.stripe.mode, 'test');
  const stripe = change => ({ ...raw, payments: { stripe: { ...raw.payments.stripe, ...change } } });
  const liveKey = { ...env, STRIPE_SECRET_KEY: 'sk_live_' + 'b'.repeat(40) };
  for (const [config, environment, message] of [
    [stripe({ mode: 'live' }), env, /live-mode secret/],                                  // test key in live mode
    [stripe({ mode: 'live' }), liveKey, /public HTTPS/],                                  // live money over loopback http
    [stripe({}), liveKey, /test-mode secret/],                                            // live key in test mode
    [stripe({}), { ...env, STRIPE_SECRET_KEY: 'pk_test_' + 'b'.repeat(40) }, /test-mode secret/], // publishable key
    [stripe({}), { ...env, STRIPE_WEBHOOK_SECRET: 'not-a-secret' }, /webhook signing secret/],
    [stripe({ webhookSecretEnv: 'STRIPE_SECRET_KEY' }), env, /two separate/],              // one variable for both
    [stripe({ secretKeyEnv: 'REACH_UPSTREAM_KEY' }), env, /two separate/],                 // shared with the upstream
    [stripe({ basicPriceId: 'prod_123456789' }), env, /price ID/],
    [stripe({ inlineKey: KEY }), env, /Invalid Stripe configuration/],
    [{ ...raw, subscription: undefined, models: [] }, env, /configure it first/],
  ]) assert.throws(() => validateConfig(config, process.cwd(), environment), message);
  const live = { ...stripe({ mode: 'live' }), origin: 'https://reach.example' };
  assert.equal(validateConfig(live, process.cwd(), liveKey).payments.stripe.mode, 'live');
});

// ---- refunds, disputes and the customer portal ---------------------------
const refundObject = (over = {}) => ({ id: 're_0001', object: 'refund', amount: 2000, currency: 'usd', status: 'succeeded',
  payment_intent: 'pi_topup', charge: 'ch_1', ...over });
const disputeObject = (over = {}) => ({ id: 'du_0001', object: 'dispute', amount: 1500, currency: 'usd', status: 'needs_response',
  payment_intent: 'pi_invoice', charge: 'ch_2', ...over });
// Stripe as the lookups see it: one top-up Checkout and one subscription invoice.
const stripeLedger = accountId => url => {
  if (url.pathname === '/v1/checkout/sessions' && url.searchParams.get('payment_intent'))
    return { status: 200, body: { data: url.searchParams.get('payment_intent') === 'pi_topup' ? [session(accountId)] : [] } };
  if (url.pathname === '/v1/invoice_payments')
    return { status: 200, body: { data: url.searchParams.get('payment[payment_intent]') === 'pi_invoice' ? [{ invoice: 'in_0001', payment: { type: 'payment_intent', payment_intent: 'pi_invoice' } }] : [] } };
  if (url.pathname === '/v1/invoices/in_0001') return { status: 200, body: invoice(accountId) };
  if (url.pathname === '/v1/subscriptions/search')
    return { status: 200, body: { data: url.searchParams.get('query') === `metadata["reach_account_id"]:"${accountId}"` ? [{ id: 'sub_1', customer: 'cus_1' }] : [] } };
  if (url.pathname === '/v1/billing_portal/sessions') return { status: 200, body: { url: 'https://billing.stripe.com/p/session/test_1' } };
  return null;
};

test('refunds and disputes are read from Stripe without trusting anything but the PaymentIntent', () => {
  const { paymentIntent, reversal } = reversalFromStripeEvent(event('refund.created', refundObject()), { livemode: false });
  assert.equal(paymentIntent, 'pi_topup');
  assert.deepEqual({ ...reversal, eventId: undefined }, { provider: 'stripe', eventId: undefined, objectId: 're_0001', kind: 'refund', amountUsdMicros: 20_000_000, currency: 'usd' });
  assert.equal(reversalFromStripeEvent(event('charge.dispute.created', disputeObject()), { livemode: false }).reversal.kind, 'dispute');
  assert.equal(reversalFromStripeEvent(event('refund.updated', refundObject({ status: 'failed' })), { livemode: false }).ignored, 'refund_not_effective');
  assert.equal(reversalFromStripeEvent(event('refund.created', refundObject({ payment_intent: null })), { livemode: false }).ignored, 'no_payment_intent');
  assert.equal(reversalFromStripeEvent(event('refund.created', refundObject()), { livemode: true }).ignored, 'wrong_mode');
  assert.equal(reversalFromStripeEvent(event('invoice.paid', {}), { livemode: false }), null, 'not a reversal event');
});

test('a refunded top-up takes the credit back; a disputed subscription ends Basic; foreign refunds are ignored', async t => {
  let accountId;
  const s = service(t, { stripeRoute: url => stripeLedger(accountId)(url) });
  const signed = s.signIn(); accountId = signed.accountId;
  await s.webhook(event('checkout.session.completed', session(accountId)));
  await s.webhook(event('invoice.paid', invoice(accountId)));
  assert.equal((await s.call('GET', '/v1/account', { token: signed.token })).body.credit.balanceMicros, 20_000_000);

  assert.deepEqual((await s.webhook(event('refund.created', refundObject()))).body, { received: true, status: 'applied', duplicate: false });
  assert.equal((await s.webhook(event('refund.updated', refundObject()))).body.duplicate, true);
  assert.equal((await s.call('GET', '/v1/account', { token: signed.token })).body.credit.balanceMicros, 0);
  const lookups = s.calls.filter(call => call.init.method === 'GET');
  assert.ok(lookups.every(call => call.init.headers['Stripe-Version'] === STRIPE_VERSION && call.init.headers.Authorization === `Bearer ${KEY}`));

  assert.equal((await s.webhook(event('charge.dispute.created', disputeObject()))).body.status, 'applied');
  assert.equal((await s.call('GET', '/v1/account', { token: signed.token })).body.plan.status, 'expired');

  assert.equal((await s.webhook(event('refund.created', refundObject({ id: 're_other', payment_intent: 'pi_elsewhere' })))).body.ignored, 'not_reach');
  const history = (await s.call('GET', '/v1/billing/payments', { token: signed.token })).body;
  assert.deepEqual(history.reversals.map(entry => entry.kind).sort(), ['dispute', 'refund']);
  assert.doesNotMatch(JSON.stringify(history), /re_0001|du_0001|pi_/);
});

test('the customer portal opens only for this account and only on billing.stripe.com', async t => {
  let accountId, portalUrl = 'https://billing.stripe.com/p/session/test_1';
  const s = service(t, { stripeRoute: url => url.pathname === '/v1/billing_portal/sessions' ? { status: 200, body: { url: portalUrl } } : stripeLedger(accountId)(url) });
  const signed = s.signIn(); accountId = signed.accountId;
  const opened = await s.call('POST', '/v1/billing/portal', { token: signed.token, body: {} });
  assert.deepEqual([opened.status, opened.body.url], [200, portalUrl]);
  const portal = s.calls.at(-1);
  assert.equal(portal.form.get('customer'), 'cus_1');
  assert.equal(portal.form.get('return_url'), 'http://127.0.0.1:20978/billing/return?portal=closed');
  assert.equal((await s.call('POST', '/v1/billing/portal', { body: {} })).status, 401);
  const other = s.signIn();
  assert.equal((await s.call('POST', '/v1/billing/portal', { token: other.token, body: {} })).body.error.code, 'no_subscription');
  portalUrl = 'https://billing.stripe.com.evil.example/p';
  assert.equal((await s.call('POST', '/v1/billing/portal', { token: signed.token, body: {} })).status, 502);
});

test('a Checkout that REACH did not create is never taken for a top-up', async () => {
  const sessions = { pi_foreign: { id: 'cs_foreign', mode: 'payment', metadata: {} }, pi_subscription: { id: 'cs_sub', mode: 'subscription', metadata: { reach_kind: 'subscription_period' } },
    pi_topup: { id: 'cs_ours', mode: 'payment', metadata: { reach_kind: 'top_up', reach_account_id: 'acct_12345678' } } };
  const client = createStripeClient({ secretKey: KEY, fetchImpl: async url => {
    const u = new URL(url);
    const data = u.pathname === '/v1/checkout/sessions' ? [sessions[u.searchParams.get('payment_intent')]].filter(Boolean) : [];
    return new Response(JSON.stringify({ data }), { status: 200 });
  } });
  assert.deepEqual(await client.findOriginal('pi_topup'), { originalObjectId: 'cs_ours', originalKind: 'top_up' });
  assert.equal(await client.findOriginal('pi_foreign'), null);
  assert.equal(await client.findOriginal('pi_subscription'), null);
});

// Repeated requests keep their key and complete form unchanged as time advances,
// across concurrent callers and even an ambiguous provider timeout.
test('subscription checkout retries share a durable idempotency key and fixed parameters', async t => {
  const s=service(t), {token}=s.signIn();
  await s.call('POST','/v1/billing/checkout',{token,body:{kind:'subscription'}});
  s.advance(10_000);
  await Promise.all(Array.from({length:4},()=>s.call('POST','/v1/billing/checkout',{token,body:{kind:'subscription'}})));
  const keys=s.calls.map(c=>c.init.headers['Idempotency-Key']);
  assert.match(keys[0],/^reach-subscription-[a-f0-9]{64}$/);
  assert.equal(new Set(keys).size,1);
  assert.equal(new Set(s.calls.map(c=>c.init.body)).size,1);
});

test('a provider response lost after creating a session is retried with the same intent', async t => {
  const sessions=new Map();let first=true;
  const s=service(t,{stripeRoute:(url,init)=>{
    const key=init.headers['Idempotency-Key'];
    if(!sessions.has(key))sessions.set(key,{status:200,body:{id:'cs_test_retry',url:'https://checkout.stripe.com/c/pay/cs_test_retry',expires_at:NOW/1000+3600}});
    if(first){first=false;throw new Error('connection lost after creation');}
    return sessions.get(key);
  }}),{token}=s.signIn();
  assert.equal((await s.call('POST','/v1/billing/checkout',{token,body:{kind:'subscription'}})).status,502);
  s.advance(2000);
  assert.equal((await s.call('POST','/v1/billing/checkout',{token,body:{kind:'subscription'}})).status,200);
  assert.equal(sessions.size,1);assert.equal(s.calls[0].init.body,s.calls[1].init.body);
});
test('expiry cannot open a second subscription when its payment webhook is delayed', async t => {
  let status='complete',subscriptionStatus='active';
  const s=service(t,{stripeRoute:(url,init)=>init.method==='GET'?{status:200,body:{id:'cs_test_new',mode:'subscription',status,subscription:{status:subscriptionStatus}}}:null});
  let {token,wallet}=s.signIn();
  assert.equal((await s.call('POST','/v1/billing/checkout',{token,body:{kind:'subscription'}})).status,200);
  const key=s.calls[0].init.headers['Idempotency-Key'];s.advance(3600_000);token=s.signIn(wallet).token;
  assert.equal((await s.call('POST','/v1/billing/checkout',{token,body:{kind:'subscription'}})).body.error.code,'checkout_pending');
  assert.ok(s.calls.filter(c=>c.init.method==='POST').every(c=>c.init.headers['Idempotency-Key']===key));
  status='expired';
  assert.equal((await s.call('POST','/v1/billing/checkout',{token,body:{kind:'subscription'}})).status,200);
  assert.notEqual(s.calls.at(-1).init.headers['Idempotency-Key'],key);

});

test('a refund arriving before its REACH payment requests redelivery and applies exactly once afterwards', async t => {
  for (const kind of ['top_up', 'subscription_period']) {
    let accountId;
    const s = service(t, { stripeRoute: url => stripeLedger(accountId)(url) });
    const signed = s.signIn(); accountId = signed.accountId;
    const refunded = event('refund.created', refundObject(kind === 'top_up' ? {} : { payment_intent: 'pi_invoice', amount: 1500 }));
    const early = await s.webhook(refunded);
    assert.equal(early.status, 503);
    assert.equal(early.body.error.code, 'payment_pending');
    assert.equal((await s.call('GET', '/v1/billing/payments', { token: signed.token })).body.reversals.length, 0);
    await s.webhook(kind === 'top_up' ? event('checkout.session.completed', session(accountId)) : event('invoice.paid', invoice(accountId)));
    assert.equal((await s.webhook(refunded)).body.status, 'applied');
    assert.equal((await s.webhook(refunded)).body.duplicate, true);
    const account = (await s.call('GET', '/v1/account', { token: signed.token })).body;
    assert.equal(kind === 'top_up' ? account.credit.balanceMicros : account.plan.status, kind === 'top_up' ? 0 : 'expired');
    assert.equal((await s.call('GET', '/v1/billing/payments', { token: signed.token })).body.reversals.length, 1);
  }
});

test('pending, action-required and failed refunds preserve credit and Basic until a final successful update', async t => {
  for (const kind of ['top_up', 'subscription_period']) {
    let accountId;
    const s = service(t, { stripeRoute: url => stripeLedger(accountId)(url) });
    const signed = s.signIn(); accountId = signed.accountId;
    await s.webhook(event('checkout.session.completed', session(accountId)));
    await s.webhook(event('invoice.paid', invoice(accountId)));
    const refund = kind === 'top_up' ? {} : { payment_intent: 'pi_invoice', amount: 1500 };
    for (const status of ['pending', 'requires_action', 'failed', 'canceled']) {
      assert.equal((await s.webhook(event('refund.updated', refundObject({ ...refund, status })))).body.ignored, 'refund_not_effective');
      const account = (await s.call('GET', '/v1/account', { token: signed.token })).body;
      assert.equal(account.credit.balanceMicros, 20_000_000);
      assert.equal(account.plan.status, 'active');
      assert.equal((await s.call('GET', '/v1/billing/payments', { token: signed.token })).body.reversals.length, 0);
    }
    assert.equal((await s.webhook(event('refund.updated', refundObject(refund)))).body.status, 'applied');
    assert.equal((await s.webhook(event('refund.updated', refundObject(refund)))).body.duplicate, true);
  }
});

test('a foreign invoice refund is acknowledged, while a failed ownership lookup requests redelivery', async t => {
  const foreign = service(t, { stripeRoute: url => {
    if (url.pathname === '/v1/checkout/sessions') return { status: 200, body: { data: [] } };
    if (url.pathname === '/v1/invoice_payments') return { status: 200, body: { data: [{ invoice: 'in_foreign' }] } };
    if (url.pathname === '/v1/invoices/in_foreign') return { status: 200, body: { id: 'in_foreign', parent: null } };
  } });
  const ignored = await foreign.webhook(event('refund.created', refundObject()));
  assert.deepEqual([ignored.status, ignored.body.ignored], [200, 'not_reach']);
  const unavailable = service(t, { stripeRoute: () => { throw new Error('provider offline'); } });
  assert.equal((await unavailable.webhook(event('refund.created', refundObject()))).status, 502);
});
