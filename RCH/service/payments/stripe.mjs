// Stripe adapter. It does three things and nothing else:
//   1. creates a hosted Checkout page for a signed-in account,
//   2. proves a webhook really came from Stripe (signature over the RAW body),
//   3. turns a paid Stripe object into the normalized record payments/core.mjs
//      understands.
// It never decides what a payment is worth and never touches a balance; the
// stores do that through applyPayment, under the same rules as every provider.
//
// No Stripe SDK: two REST calls and one HMAC are smaller to audit than a
// dependency, and the fetch seam keeps every path testable offline.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../errors.mjs';
import { TOP_UP_MIN_USD_MICROS, TOP_UP_MAX_USD_MICROS } from './core.mjs';

export const STRIPE_API = 'https://api.stripe.com';
export const CHECKOUT_ORIGIN = 'https://checkout.stripe.com';
export const PORTAL_ORIGIN = 'https://billing.stripe.com';
// Every API call is pinned, so a change to the account's default version in the
// Dashboard cannot change the shapes read here. Invoice Payments (used to find
// the invoice behind a refunded payment) exist from this version on.
export const STRIPE_VERSION = '2025-03-31.basil';
// Stripe's own recommendation; older signed payloads are treated as replays.
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const CENT_MICROS = 10_000;
// Only checkouts this service created carry these keys. Anything else on the
// same Stripe account (Mike's other sales, manual invoices) is ignored.
const ACCOUNT_KEY = 'reach_account_id';
const KIND_KEY = 'reach_kind';

export function verifyStripeSignature(rawBody, header, secret, nowMs) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || header.length > 4096) return false;
  let timestamp = null; const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2).map(s => s?.trim());
    if (key === 't' && /^\d{1,12}$/.test(value || '')) timestamp = Number(value);
    else if (key === 'v1' && /^[a-f0-9]{64}$/.test(value || '')) signatures.push(Buffer.from(value, 'hex'));
  }
  if (timestamp === null || !signatures.length) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  // Every candidate is compared; Stripe sends several during secret rotation.
  return signatures.reduce((ok, candidate) => timingSafeEqual(candidate, expected) || ok, false);
}

const metadataOf = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
// Stripe moved subscription metadata on invoices in API 2025-03-31 ("basil").
// Read both shapes so the webhook endpoint's API version does not matter.
const invoiceMetadata = invoice => metadataOf(invoice.parent?.subscription_details?.metadata
  ?? invoice.subscription_details?.metadata);
const linePrice = line => line?.pricing?.price_details?.price ?? line?.price?.id ?? line?.price ?? null;
const cents = value => Number.isSafeInteger(value) && value >= 0 ? value : fail(422, 'unrecognized_payment', 'The Stripe object is missing an amount.');

// Returns { payment } for something to record, or { ignored: reason }. Throws
// only when an object that is ours cannot be read, so Stripe marks the delivery
// failed and an operator notices, rather than money being silently dropped.
export function paymentFromStripeEvent(event, { basicPriceId, livemode }) {
  if (!event || typeof event !== 'object' || typeof event.id !== 'string' || typeof event.type !== 'string') {
    fail(400, 'invalid_event', 'Invalid Stripe event.');
  }
  if (event.livemode !== livemode) return { ignored: 'wrong_mode' };
  const object = event.data?.object;
  if (!object || typeof object !== 'object') fail(400, 'invalid_event', 'Invalid Stripe event.');

  if (event.type === 'invoice.paid') {
    const metadata = invoiceMetadata(object);
    if (metadata[KIND_KEY] !== 'subscription_period' || typeof metadata[ACCOUNT_KEY] !== 'string') return { ignored: 'not_reach' };
    const amount = cents(object.total_excluding_tax);
    // A $0 invoice (a trial, a full coupon) is not a payment.
    if (amount === 0) return { ignored: 'zero_amount' };
    const line = (Array.isArray(object.lines?.data) ? object.lines.data : []).find(l => linePrice(l) === basicPriceId);
    if (!line || !Number.isSafeInteger(line.period?.end)) fail(422, 'unrecognized_payment', 'The invoice has no Basic subscription line.');
    return { payment: { provider: 'stripe', eventId: event.id, objectId: object.id, kind: 'subscription_period',
      accountId: metadata[ACCOUNT_KEY], amountUsdMicros: amount * CENT_MICROS, currency: object.currency,
      periodEnd: line.period.end * 1000 } };
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const metadata = metadataOf(object.metadata);
    if (object.mode !== 'payment' || metadata[KIND_KEY] !== 'top_up' || typeof metadata[ACCOUNT_KEY] !== 'string') return { ignored: 'not_reach' };
    // Bank debits complete later; `async_payment_succeeded` brings them back here.
    if (object.payment_status !== 'paid') return { ignored: 'not_paid' };
    const amount = cents(object.amount_total) - cents(object.total_details?.amount_tax ?? 0);
    if (amount <= 0) return { ignored: 'zero_amount' };
    return { payment: { provider: 'stripe', eventId: event.id, objectId: object.id, kind: 'top_up',
      accountId: metadata[ACCOUNT_KEY], amountUsdMicros: amount * CENT_MICROS, currency: object.currency } };
  }

  return { ignored: 'event_type' };
}

// Refunds and disputes. Stripe names only the PaymentIntent they came from, so
// the original REACH payment is found with an API lookup (see findOriginal).
// Returns { paymentIntent, reversal } with the original still to be filled in,
// or { ignored: reason }.
export function reversalFromStripeEvent(event, { livemode }) {
  if (event.livemode !== livemode) return { ignored: 'wrong_mode' };
  const object = event.data?.object;
  if (!object || typeof object !== 'object') fail(400, 'invalid_event', 'Invalid Stripe event.');
  let kind;
  if (event.type === 'refund.created' || event.type === 'refund.updated') {
    // A refund that failed or was cancelled never left the account.
    if (!['succeeded', 'pending', 'requires_action'].includes(object.status)) return { ignored: 'refund_not_effective' };
    kind = 'refund';
  } else if (event.type === 'charge.dispute.created') kind = 'dispute';
  else return null;
  if (typeof object.payment_intent !== 'string') return { ignored: 'no_payment_intent' };
  const amount = cents(object.amount);
  if (amount === 0) return { ignored: 'zero_amount' };
  return { paymentIntent: object.payment_intent, reversal: { provider: 'stripe', eventId: event.id, objectId: object.id, kind,
    amountUsdMicros: amount * CENT_MICROS, currency: object.currency } };
}

// Flattens nested params into Stripe's form encoding: a[b][0][c]=v.
export function formEncode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value && typeof value === 'object') formEncode(value, name, out);
    else if (value !== undefined) out.append(name, String(value));
  }
  return out;
}

export function checkoutParams({ kind, amountUsdMicros, accountId, basicPriceId, origin, nowMs }) {
  const metadata = { [ACCOUNT_KEY]: accountId, [KIND_KEY]: kind === 'subscription' ? 'subscription_period' : 'top_up' };
  const common = {
    client_reference_id: accountId, metadata,
    success_url: `${origin}/billing/return?checkout=success`,
    cancel_url: `${origin}/billing/return?checkout=cancelled`,
    // Stripe's minimum lifetime is 30 minutes; an hour leaves room for clock skew.
    expires_at: Math.floor(nowMs / 1000) + 3600,
  };
  if (kind === 'subscription') {
    // The subscription carries the account so every renewal invoice is ours.
    return { ...common, mode: 'subscription', line_items: [{ price: basicPriceId, quantity: 1 }],
      subscription_data: { metadata } };
  }
  return { ...common, mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'usd',
    unit_amount: amountUsdMicros / CENT_MICROS, product_data: { name: 'REACH credit top-up' } } }] };
}

export function validTopUpAmount(value) {
  return Number.isSafeInteger(value) && value % CENT_MICROS === 0
    && value >= TOP_UP_MIN_USD_MICROS && value <= TOP_UP_MAX_USD_MICROS;
}

const hostedUrl = (value, origin) => {
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || url.origin !== origin || url.username || url.password) {
    fail(502, 'payment_provider_error', 'The payment provider returned an unexpected page address.');
  }
  return url.href;
};

export function createStripeClient({ secretKey, fetchImpl = fetch, timeoutMs = 15000 }) {
  async function call(method, path, params) {
    let response, data;
    const query = method === 'GET' && params ? `?${formEncode(params)}` : '';
    try {
      response = await fetchImpl(`${STRIPE_API}${path}${query}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': STRIPE_VERSION,
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method === 'POST' ? { body: formEncode(params).toString() } : {}),
      });
      data = await response.json();
    } catch { fail(502, 'payment_provider_unavailable', 'The payment provider could not be reached. Try again shortly.'); }
    // Stripe's error text can name the key or price; it is never shown to a customer.
    if (!response.ok) fail(502, 'payment_provider_error', 'The payment provider rejected the request. Try again later.');
    return data;
  }
  const list = data => Array.isArray(data?.data) ? data.data : [];
  return {
    async createCheckoutSession(params) {
      const data = await call('POST', '/v1/checkout/sessions', params);
      return { url: hostedUrl(data.url, CHECKOUT_ORIGIN), expiresAt: Number.isSafeInteger(data.expires_at) ? new Date(data.expires_at * 1000).toISOString() : null };
    },
    // The REACH payment a PaymentIntent paid for: a top-up Checkout Session, or
    // the subscription invoice it settled. null when it is neither.
    async findOriginal(paymentIntent) {
      const [session] = list(await call('GET', '/v1/checkout/sessions', { payment_intent: paymentIntent, limit: 1 }));
      if (session?.mode === 'payment' && session.metadata?.[KIND_KEY] === 'top_up') return { originalObjectId: session.id, originalKind: 'top_up' };
      const [paid] = list(await call('GET', '/v1/invoice_payments', { payment: { type: 'payment_intent', payment_intent: paymentIntent }, limit: 1 }));
      return typeof paid?.invoice === 'string' ? { originalObjectId: paid.invoice, originalKind: 'subscription_period' } : null;
    },
    // Stripe's own page for cancelling, changing the card and downloading
    // invoices. The customer is the one on this account's subscription.
    async createPortalSession({ accountId, returnUrl }) {
      // Account IDs are generated hex, but the query language has quotes; never interpolate anything else.
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(accountId)) fail(400, 'invalid_account', 'Invalid account.');
      const query = `metadata["${ACCOUNT_KEY}"]:"${accountId}"`;
      const [subscription] = list(await call('GET', '/v1/subscriptions/search', { query, limit: 1 }));
      const customer = typeof subscription?.customer === 'string' ? subscription.customer : subscription?.customer?.id;
      if (typeof customer !== 'string') fail(404, 'no_subscription', 'This account has no card subscription to manage.');
      const data = await call('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl });
      return { url: hostedUrl(data.url, PORTAL_ORIGIN) };
    },
  };
}
