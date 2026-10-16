// Plus payments retain their native currency and minor units. They never mint
// RCH or add USD wallet credit. Only the Stripe adapter supplies these records.
import { createHash } from 'node:crypto';
import { fail } from '../errors.mjs';

export const PLUS_DEFAULTS = Object.freeze({ id: 'plus', name: 'REACH Subscription Plus', currency: 'cad',
  amountMinor: 2500, interval: 'month', intervalCount: 1, taxBehavior: 'inclusive', unlimited: true });
const hash = value => createHash('sha256').update(value).digest('hex');
export const plusFingerprint = value => hash(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'eventId'))));
export const plusGrantId = objectId => `plus_${hash(`stripe:${objectId}`).slice(0, 48)}`;

export function validatePlusPolicy(policy) {
  if (policy === undefined) return null;
  const names = Object.keys(PLUS_DEFAULTS);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(k => !names.includes(k))
    || policy.id !== 'plus' || typeof policy.name !== 'string' || !policy.name.trim() || policy.name.length > 80
    || !['cad', 'usd'].includes(policy.currency) || !Number.isSafeInteger(policy.amountMinor) || policy.amountMinor < 1 || policy.amountMinor > 1_000_000
    || policy.interval !== 'month' || policy.intervalCount !== 1 || policy.taxBehavior !== 'inclusive' || policy.unlimited !== true) {
    throw new Error('Configure Plus with a native-currency fixed monthly price, inclusive tax behavior and unlimited usage.');
  }
  return { ...policy };
}
export const plusActive = (account, subscription, now) => !!subscription?.plus && account?.plan_id === subscription.plus.id
  && account.plan_expires > now && /^plus_[a-f0-9]{48}$/.test(account.plan_version || '');
export const plusAccount = (account, subscription) => account?.plan_id === (subscription?.plus?.id || 'plus');

export function assertPlusPrice(price, { priceId, policy, livemode, allowArchived = false }) {
  validatePlusPolicy(policy);
  if (!policy || !priceId || price?.id !== priceId || price.livemode !== livemode || (!allowArchived && price.active !== true)
    || price.currency !== policy.currency || price.unit_amount !== policy.amountMinor || price.type !== 'recurring'
    || price.billing_scheme !== 'per_unit' || price.transform_quantity != null || price.tax_behavior !== policy.taxBehavior
    || price.recurring?.interval !== policy.interval || price.recurring?.interval_count !== policy.intervalCount
    || price.recurring?.usage_type !== 'licensed' || price.recurring?.trial_period_days) {
    fail(422, 'plus_price_mismatch', 'The configured Stripe Plus price does not match the approved currency, amount, monthly interval and inclusive tax behavior.');
  }
}
const meta = invoice => invoice?.parent?.subscription_details?.metadata ?? invoice?.subscription_details?.metadata;
const priceOf = line => line?.pricing?.price_details?.price ?? line?.price?.id ?? line?.price;
const stripeId = value => typeof value === 'string' ? value : value?.id;
export function plusInvoice(event, { priceId, policy, livemode }) {
  if (event?.type !== 'invoice.paid' || meta(event.data?.object)?.reach_plan_id !== 'plus') return null;
  if (event.livemode !== livemode) return { ignored: 'wrong_mode' };
  if (!priceId || !policy) fail(503, 'plus_unconfigured', 'Plus payment processing is not configured.');
  const invoice = event.data.object, metadata = meta(invoice), lines = invoice.lines?.data;
  const line = Array.isArray(lines) && lines.length === 1 && !invoice.lines.has_more ? lines[0] : null;
  if (metadata.reach_kind !== 'subscription_period' || !/^[A-Za-z0-9_-]{8,128}$/.test(metadata.reach_account_id || '')
    || !line || priceOf(line) !== priceId || line.quantity !== 1 || line.proration === true || line.parent?.subscription_item_details?.proration === true
    || line.discount_amounts?.some(d => d.amount !== 0) || invoice.status !== 'paid' || (invoice.paid !== undefined && invoice.paid !== true) || invoice.paid_out_of_band === true
    || invoice.currency !== policy.currency || invoice.total !== policy.amountMinor || invoice.amount_paid !== policy.amountMinor
    || !Number.isSafeInteger(line.period?.end) || !Number.isSafeInteger(line.period?.start) || line.period.end <= line.period.start
    || (line.period.end - line.period.start) * 1000 > 32 * 86400000) {
    fail(422, 'invalid_plus_invoice', 'The paid invoice does not match the configured Plus subscription.');
  }
  return { payment: normalizePlusPayment({ provider: 'stripe', eventId: event.id, objectId: invoice.id,
    accountId: metadata.reach_account_id, planId: 'plus', priceId, amountMinor: invoice.amount_paid,
    currency: invoice.currency, periodEnd: line.period.end * 1000, customerId: stripeId(invoice.customer),
    subscriptionId: stripeId(invoice.parent?.subscription_details?.subscription ?? invoice.subscription),
    checkoutId: metadata.reach_checkout_id }, { requireSession: false }) };
}
export function normalizePlusPayment(raw, { requireSession = true } = {}) {
  const fields = ['provider','eventId','objectId','accountId','planId','priceId','amountMinor','currency','periodEnd','customerId','subscriptionId','checkoutId','sessionId'];
  if (!raw || typeof raw !== 'object' || Object.keys(raw).some(k => !fields.includes(k)) || raw.provider !== 'stripe'
    || raw.planId !== 'plus' || !/^price_[A-Za-z0-9]{8,64}$/.test(raw.priceId || '')
    || !['eventId','objectId'].every(k => /^[A-Za-z0-9_.:-]{3,128}$/.test(raw[k] || ''))
    || !/^[A-Za-z0-9_-]{8,128}$/.test(raw.accountId || '') || !['cad','usd'].includes(raw.currency)
    || !Number.isSafeInteger(raw.amountMinor) || raw.amountMinor <= 0 || raw.amountMinor > 1_000_000
    || !/^cus_[A-Za-z0-9]{3,128}$/.test(raw.customerId || '') || !/^sub_[A-Za-z0-9]{3,128}$/.test(raw.subscriptionId || '')
    || !/^[a-f0-9]{64}$/.test(raw.checkoutId || '') || (requireSession && !/^cs_[A-Za-z0-9_]{3,128}$/.test(raw.sessionId || ''))
    || !Number.isSafeInteger(raw.periodEnd) || raw.periodEnd <= 0) fail(400, 'invalid_payment', 'Invalid Plus payment record.');
  return Object.fromEntries(fields.filter(k => raw[k] !== undefined).map(k => [k, raw[k]]));
}
export function plusPaymentDecision(account, payment, subscription, now, verifiedPlan = false) {
  if (!subscription?.plus) fail(409, 'subscription_unconfigured', 'Plus is not configured.');
  const reject = reason => ({ status: 'rejected', reason });
  if (!account) return reject('account_missing');
  if (payment.amountMinor !== subscription.plus.amountMinor || payment.currency !== subscription.plus.currency) return reject('amount_mismatch');
  if (payment.periodEnd <= now) return { status: 'expired', reason: 'period_over' };
  if (payment.periodEnd > now + 32 * 86400000) return reject('period_too_long');
  if (account.plan_id && !verifiedPlan && account.plan_expires > now) return reject('other_plan_active');
  if (verifiedPlan && account.plan_expires >= payment.periodEnd) return { status: 'superseded', reason: 'newer_period_active' };
  return { status: 'applied', reason: null };
}
export async function recordPlusInvoice(event, { stripe, subscription, client, store }) {
  const mapped = plusInvoice(event, { priceId: stripe.plusPriceId, policy: subscription?.plus, livemode: stripe.mode === 'live' });
  if (!mapped || mapped.ignored) return mapped;
  const binding = await store.plusCheckout(mapped.payment);
  const session = await client.readCheckoutSession(binding.sessionId);
  const payment = { ...mapped.payment, sessionId: binding.sessionId }, metadata = session?.metadata;
  if (session?.id !== payment.sessionId || session.mode !== 'subscription' || session.status !== 'complete'
    || session.payment_status !== 'paid' || session.livemode !== (stripe.mode === 'live')
    || session.client_reference_id !== payment.accountId || stripeId(session.customer) !== payment.customerId
    || stripeId(session.subscription) !== payment.subscriptionId || metadata?.reach_account_id !== payment.accountId
    || metadata?.reach_kind !== 'subscription_period' || metadata?.reach_plan_id !== 'plus'
    || metadata?.reach_checkout_id !== payment.checkoutId) fail(409, 'payment_conflict', 'The invoice is not bound to this account checkout.');
  assertPlusPrice(await client.readPrice(stripe.plusPriceId), { priceId: stripe.plusPriceId, policy: subscription.plus,
    livemode: stripe.mode === 'live', allowArchived: true });
  return { result: await store.applyPlusPayment(payment) };
}

export function normalizePlusReversal(raw) {
  if (!raw || !['refund','dispute'].includes(raw.kind) || !['cad','usd'].includes(raw.currency)
    || !['objectId','eventId','originalObjectId'].every(k => /^[A-Za-z0-9_.:-]{3,128}$/.test(raw[k] || ''))
    || !Number.isSafeInteger(raw.amountMinor) || raw.amountMinor <= 0) fail(400, 'invalid_payment', 'Invalid Plus reversal.');
  return { objectId: raw.objectId, eventId: raw.eventId, originalObjectId: raw.originalObjectId,
    kind: raw.kind, amountMinor: raw.amountMinor, currency: raw.currency };
}

const iso = value => { const date=new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; };
export const publicPlusPayment = row => ({ id: row.id, provider: 'stripe', kind: 'subscription_period', planId: 'plus',
  amountMinor: row.amount_minor, currency: row.currency, status: row.status, reason: row.reason ?? null,
  periodEnd: iso(row.period_end), createdAt: iso(row.created) });
export const publicPlusReversal = row => ({ id: row.id, provider: 'stripe', kind: row.kind, planId: 'plus', paymentId: row.payment_id,
  amountMinor: row.amount_minor, currency: row.currency, status: row.status, reason: row.reason ?? null,
  createdAt: new Date(row.created).toISOString() });
