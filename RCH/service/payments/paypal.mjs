// PayPal adapter. Like the Stripe adapter, it only creates pages for the
// customer and turns PayPal objects into the normalized records that
// payments/core.mjs and the stores already apply.
//
// A webhook is treated as a NOTIFICATION, never as data: after PayPal's own API
// confirms the signature, the object it names is fetched back from PayPal with
// the REST credentials and only that copy is used. A forged or replayed event
// can therefore cause at most a lookup.
import { fail } from '../errors.mjs';
import { TOP_UP_MIN_USD_MICROS, TOP_UP_MAX_USD_MICROS } from './core.mjs';

export const PAYPAL_API = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };
// The only pages the apps may open for PayPal.
export const PAYPAL_ORIGINS = { sandbox: 'https://www.sandbox.paypal.com', live: 'https://www.paypal.com' };
const CENT_MICROS = 10_000;
// Orders and subscriptions this service creates carry their kind and account in
// custom_id; anything else on the same PayPal account is ignored.
const TAG = /^reach:(top_up|subscription_period):([A-Za-z0-9_-]{8,128})$/;
export const reachTag = (kind, accountId) => `reach:${kind}:${accountId}`;
const readTag = value => {
  const match = typeof value === 'string' ? TAG.exec(value) : null;
  return match ? { kind: match[1], accountId: match[2] } : null;
};

// "20.00" -> 20_000_000. Exact decimal parsing; PayPal amounts are strings.
export function usdMicros(amount) {
  const value = amount?.value ?? amount?.total, currency = amount?.currency_code ?? amount?.currency;
  const match = typeof value === 'string' ? /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value) : null;
  if (!match || currency !== 'USD') fail(422, 'unrecognized_payment', 'The PayPal object has no US dollar amount.');
  return Number(match[1]) * 1_000_000 + Number((match[2] || '').padEnd(2, '0')) * CENT_MICROS;
}
const dollars = micros => `${Math.floor(micros / 1_000_000)}.${String((micros % 1_000_000) / CENT_MICROS).padStart(2, '0')}`;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(value) ? value : null;

export const validPayPalTopUp = value => Number.isSafeInteger(value) && value % CENT_MICROS === 0
  && value >= TOP_UP_MIN_USD_MICROS && value <= TOP_UP_MAX_USD_MICROS;

export function createPayPalClient({ mode, clientId, clientSecret, webhookId, basicPlanId, fetchImpl = fetch, now = Date.now, timeoutMs = 15000 }) {
  const base = PAYPAL_API[mode], pageOrigin = PAYPAL_ORIGINS[mode];
  let token = null;
  async function request(method, path, body, headers = {}) {
    let response, data;
    try {
      response = await fetchImpl(`${base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers, ...(body === undefined ? {} : { body }) });
      data = response.status === 204 ? {} : await response.json();
    } catch { fail(502, 'payment_provider_unavailable', 'The payment provider could not be reached. Try again shortly.'); }
    return { response, data };
  }
  async function accessToken() {
    if (token && token.expires > now()) return token.value;
    const { response, data } = await request('POST', '/v1/oauth2/token', 'grant_type=client_credentials', {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' });
    if (!response.ok || typeof data.access_token !== 'string') fail(502, 'payment_provider_error', 'The payment provider rejected the request. Try again later.');
    token = { value: data.access_token, expires: now() + Math.max(0, (Number(data.expires_in) || 0) - 60) * 1000 };
    return token.value;
  }
  // PayPal's error bodies can name the client or plan; they never reach a customer.
  async function call(method, path, body, extra = {}) {
    const { response, data } = await request(method, path, body === undefined ? undefined : JSON.stringify(body), {
      Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...extra });
    if (response.status === 404) return null;
    if (!response.ok) fail(502, 'payment_provider_error', 'The payment provider rejected the request. Try again later.');
    return data;
  }
  const approvalUrl = (links, rels) => {
    const href = (Array.isArray(links) ? links : []).find(link => rels.includes(link?.rel))?.href;
    let url;
    try { url = new URL(href); } catch { url = null; }
    if (!url || url.origin !== pageOrigin || url.username || url.password) fail(502, 'payment_provider_error', 'The payment provider returned an unexpected page address.');
    return url.href;
  };

  // A completed capture as a top-up record, or null when it is not ours. The
  // tag is on the capture, and on the order's purchase unit when captured here.
  const captureRecord = (capture, eventId, orderTag = null) => {
    const tag = readTag(capture?.custom_id) ?? orderTag;
    if (!capture || capture.status !== 'COMPLETED' || tag?.kind !== 'top_up' || !id(capture.id)) return null;
    return { provider: 'paypal', eventId, objectId: capture.id, kind: 'top_up', accountId: tag.accountId, amountUsdMicros: usdMicros(capture.amount), currency: 'usd' };
  };

  // Captures an approved REACH order. PayPal-Request-Id makes a repeated
  // capture (return page and webhook both arriving) return the same result.
  async function captureOrder(orderId, eventId) {
    if (!id(orderId)) fail(400, 'invalid_order', 'Invalid PayPal order.');
    const order = await call('GET', `/v2/checkout/orders/${orderId}`);
    const tag = readTag(order?.purchase_units?.[0]?.custom_id);
    if (tag?.kind !== 'top_up') return null;
    const captured = order.status === 'COMPLETED' ? order
      : order.status === 'APPROVED' ? await call('POST', `/v2/checkout/orders/${orderId}/capture`, {}, { 'PayPal-Request-Id': `reach-capture-${orderId}` }) : null;
    return captureRecord(captured?.purchase_units?.[0]?.payments?.captures?.[0], eventId, tag);
  }

  return {
    pageOrigin,
    async createCheckout({ kind, amountUsdMicros, accountId, origin }) {
      const returnUrl = `${origin}/v1/billing/paypal/return`, cancelUrl = `${origin}/billing/return?checkout=cancelled`;
      if (kind === 'subscription') {
        const data = await call('POST', '/v1/billing/subscriptions', { plan_id: basicPlanId, custom_id: reachTag('subscription_period', accountId),
          application_context: { brand_name: 'REACH', shipping_preference: 'NO_SHIPPING', user_action: 'SUBSCRIBE_NOW',
            return_url: `${origin}/billing/return?checkout=success`, cancel_url: cancelUrl } });
        return { url: approvalUrl(data?.links, ['approve']), expiresAt: null };
      }
      const data = await call('POST', '/v2/checkout/orders', { intent: 'CAPTURE',
        purchase_units: [{ custom_id: reachTag('top_up', accountId), description: 'REACH credit top-up',
          amount: { currency_code: 'USD', value: dollars(amountUsdMicros) } }],
        payment_source: { paypal: { experience_context: { brand_name: 'REACH', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW',
          return_url: returnUrl, cancel_url: cancelUrl } } } });
      return { url: approvalUrl(data?.links, ['payer-action', 'approve']), expiresAt: null };
    },

    // Asks PayPal whether this exact body, with these transmission headers, came
    // from PayPal for this webhook.
    async verifyWebhook(headers, event) {
      const field = name => typeof headers[name] === 'string' && headers[name].length <= 4096 ? headers[name] : null;
      const transmission = { auth_algo: field('paypal-auth-algo'), cert_url: field('paypal-cert-url'), transmission_id: field('paypal-transmission-id'),
        transmission_sig: field('paypal-transmission-sig'), transmission_time: field('paypal-transmission-time') };
      if (Object.values(transmission).some(value => !value)) return false;
      const data = await call('POST', '/v1/notifications/verify-webhook-signature', { ...transmission, webhook_id: webhookId, webhook_event: event });
      return data?.verification_status === 'SUCCESS';
    },

    captureOrder,

    // Turns a verified webhook into { payment } or { reversal } using fresh
    // copies from the API. null means the event is not about a REACH payment.
    async readEvent(event) {
      const type = event?.event_type, resourceId = id(event?.resource?.id), eventId = id(event?.id) ?? 'paypal-event';
      if (!resourceId) return null;
      if (type === 'CHECKOUT.ORDER.APPROVED') {
        const payment = await captureOrder(resourceId, eventId);
        return payment ? { payment } : null;
      }
      if (type === 'PAYMENT.CAPTURE.COMPLETED') {
        const payment = captureRecord(await call('GET', `/v2/payments/captures/${resourceId}`), eventId);
        return payment ? { payment } : null;
      }
      if (type === 'PAYMENT.SALE.COMPLETED') {
        const sale = await call('GET', `/v1/payments/sale/${resourceId}`);
        const subscriptionId = id(sale?.billing_agreement_id);
        if (!sale || sale.state !== 'completed' || !subscriptionId) return null;
        const subscription = await call('GET', `/v1/billing/subscriptions/${subscriptionId}`);
        const tag = readTag(subscription?.custom_id);
        if (tag?.kind !== 'subscription_period' || subscription.plan_id !== basicPlanId) return null;
        // The paid-through date: PayPal's next charge for this subscription.
        const periodEnd = Date.parse(subscription.billing_info?.next_billing_time);
        if (!Number.isSafeInteger(periodEnd)) fail(422, 'unrecognized_payment', 'The PayPal subscription has no next billing time.');
        return { payment: { provider: 'paypal', eventId, objectId: sale.id, kind: 'subscription_period', accountId: tag.accountId,
          amountUsdMicros: usdMicros(sale.amount), currency: 'usd', periodEnd } };
      }
      if (type === 'PAYMENT.CAPTURE.REFUNDED') {
        const refund = await call('GET', `/v2/payments/refunds/${resourceId}`);
        const up = (Array.isArray(refund?.links) ? refund.links : []).find(link => link?.rel === 'up')?.href;
        const captureId = id(/\/v2\/payments\/captures\/([^/?#]+)$/.exec(String(up ?? ''))?.[1]);
        if (!refund || refund.status !== 'COMPLETED' || !captureId) return null;
        return { reversal: { provider: 'paypal', eventId, objectId: refund.id, kind: 'refund', originalObjectId: captureId,
          originalKind: 'top_up', amountUsdMicros: usdMicros(refund.amount), currency: 'usd' } };
      }
      if (type === 'PAYMENT.SALE.REFUNDED') {
        const refund = await call('GET', `/v1/payments/refund/${resourceId}`);
        if (!refund || refund.state !== 'completed' || !id(refund.sale_id)) return null;
        return { reversal: { provider: 'paypal', eventId, objectId: refund.id, kind: 'refund', originalObjectId: refund.sale_id,
          originalKind: 'subscription_period', amountUsdMicros: usdMicros(refund.amount), currency: 'usd' } };
      }
      // A chargeback PayPal has decided against the merchant: the whole payment.
      if (type === 'PAYMENT.CAPTURE.REVERSED' || type === 'PAYMENT.SALE.REVERSED') {
        const capture = type === 'PAYMENT.CAPTURE.REVERSED';
        const object = await call('GET', capture ? `/v2/payments/captures/${resourceId}` : `/v1/payments/sale/${resourceId}`);
        const reversed = capture ? object?.status === 'REVERSED' : object?.state === 'reversed';
        if (!object || !reversed) return null;
        return { reversal: { provider: 'paypal', eventId, objectId: `reversal-${object.id}`, kind: 'dispute', originalObjectId: object.id,
          originalKind: capture ? 'top_up' : 'subscription_period', amountUsdMicros: usdMicros(object.amount), currency: 'usd' } };
      }
      return null;
    },
  };
}
