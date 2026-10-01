// Provider-neutral payment rules. No I/O, no database, no network.
//
// A payment provider (Stripe, PayPal, or an operator recording one by hand) only
// ever produces a normalized payment record. This module decides what that
// record is worth, and both account stores apply the decision inside one
// transaction. Keeping the rules here, and nowhere near an HTTP handler or a
// provider SDK, is what lets the same behaviour be proven against SQLite and
// Postgres by a single test suite.
//
// WHAT AN ADAPTER MUST PASS
//   amountUsdMicros   what bought the product, in USD micro-dollars, EXCLUDING tax
//                     and excluding processor fees. Tax is not ours and fees are a
//                     cost of doing business; neither may inflate a balance.
//   periodEnd         epoch MILLISECONDS. Stripe reports seconds; convert them.
//   objectId          the provider's payment object (invoice, capture, sale). This
//                     - not the event ID - is the idempotency key, because a
//                     provider routinely sends several events for one payment.
import { createHash } from 'node:crypto';
import { fail } from '../errors.mjs';

export const PAYMENT_PROVIDERS = Object.freeze(['stripe', 'paypal', 'manual']);
export const PAYMENT_KINDS = Object.freeze(['subscription_period', 'top_up']);
export const PAYMENT_STATUSES = Object.freeze(['applied', 'superseded', 'expired', 'rejected']);
// Outcomes a human has to look at. `superseded` is deliberately not one: a late
// older invoice is expected and harmless.
export const NEEDS_REVIEW = Object.freeze(['rejected', 'expired']);
export const BASIC_PLAN_IDS = Object.freeze(['basic', 'basic-wallet']);

export const TOP_UP_MIN_USD_MICROS = 1_000_000;        // $1
export const TOP_UP_MAX_USD_MICROS = 500_000_000;      // $500
export const CREDIT_CEILING_USD_MICROS = 1_000_000_000_000;
// A paid period may not end more than this far ahead. Billing is monthly, so 400
// days is generous, and it turns a seconds-versus-milliseconds mistake in an
// adapter into a recorded rejection instead of a plan that never expires.
export const MAX_PERIOD_MS = 400 * 24 * 60 * 60 * 1000;

const REFERENCE = /^[A-Za-z0-9_.:-]{3,128}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{8,128}$/;
const FIELDS = new Set(['provider', 'eventId', 'objectId', 'kind', 'accountId', 'amountUsdMicros', 'currency', 'periodEnd']);
const text = (value, pattern) => typeof value === 'string' && pattern.test(value);
const invalid = () => fail(400, 'invalid_payment', 'Invalid payment record.');

export function normalizePayment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) invalid();
  const { provider, eventId, objectId, kind, accountId, amountUsdMicros } = input;
  const periodEnd = input.periodEnd ?? null;
  const currency = input.currency === undefined ? 'usd' : typeof input.currency === 'string' ? input.currency.toLowerCase() : null;
  if (!PAYMENT_PROVIDERS.includes(provider) || !PAYMENT_KINDS.includes(kind) || currency !== 'usd') invalid();
  if (!text(eventId, REFERENCE) || !text(objectId, REFERENCE) || !text(accountId, ACCOUNT)) invalid();
  if (!Number.isSafeInteger(amountUsdMicros) || amountUsdMicros <= 0 || amountUsdMicros > CREDIT_CEILING_USD_MICROS) invalid();
  if (kind === 'subscription_period') {
    if (!Number.isSafeInteger(periodEnd) || periodEnd <= 0) invalid();
  } else if (periodEnd !== null) invalid();
  return { provider, eventId, objectId, kind, accountId, amountUsdMicros, currency, periodEnd };
}

// Everything that defines the payment, so the same object arriving again with
// different values is detected instead of being silently treated as a replay.
export const paymentFingerprint = p => createHash('sha256').update(JSON.stringify(
  [p.provider, p.objectId, p.kind, p.accountId, p.amountUsdMicros, p.currency, p.periodEnd])).digest('hex');

// Deterministic, so a replay produces the same grant and the grant ledger's own
// conflict check agrees. Hashed because provider IDs are not guaranteed to fit
// the grant-ID alphabet or length.
export const grantIdFor = p => `pay_${createHash('sha256').update(`${p.provider}:${p.kind}:${p.objectId}`).digest('hex').slice(0, 48)}`;

const reject = reason => ({ action: 'record', status: 'rejected', reason });

// The order here is part of the contract: the Postgres function repeats it
// line for line, and the shared suite runs the same cases against both.
export function decideSubscriptionPayment({ account, payment, policy, now }) {
  if (!account) return reject('account_missing');
  if (payment.amountUsdMicros !== policy.basic.priceUsdMicros) return reject('amount_mismatch');
  if (payment.periodEnd <= now) return { action: 'record', status: 'expired', reason: 'period_over' };
  if (payment.periodEnd > now + MAX_PERIOD_MS) return reject('period_too_long');
  const basic = BASIC_PLAN_IDS.includes(account.plan_id);
  // Never silently replace a plan an operator granted by hand.
  if (!basic && account.plan_id && account.plan_expires > now) return reject('other_plan_active');
  // Webhooks arrive late and out of order. An older invoice must never shorten a
  // newer paid period, so it is recorded and the plan is left alone.
  if (basic && account.plan_expires >= payment.periodEnd) return { action: 'record', status: 'superseded', reason: 'newer_period_active' };
  return { action: 'grant' };
}

export function decideTopUpPayment({ account, payment }) {
  if (!account) return reject('account_missing');
  const amount = payment.amountUsdMicros;
  if (amount < TOP_UP_MIN_USD_MICROS || amount > TOP_UP_MAX_USD_MICROS) return reject('amount_out_of_range');
  // Same rule as a redemption credit: outstanding debt is repaid first.
  const debtPaid = Math.min(account.usd_debt, amount), credit = amount - debtPaid;
  if (account.usd_prepaid + credit > CREDIT_CEILING_USD_MICROS) return reject('credit_limit');
  return { action: 'credit', debtPaid, credit };
}

export const paymentResult = (row, duplicate) => ({
  paymentId: row.id, status: row.status, reason: row.reason ?? null, kind: row.kind,
  grantId: row.grant_id ?? null, duplicate });

// What the account's own owner may see about a payment. No provider object IDs,
// no event IDs, no fingerprint.
export const publicPayment = row => ({
  id: row.id, provider: row.provider, kind: row.kind, amountUsdMicros: row.amount_usd_micros,
  currency: row.currency, status: row.status, reason: row.reason ?? null,
  periodEnd: row.period_end == null ? null : new Date(row.period_end).toISOString(),
  createdAt: new Date(row.created).toISOString() });

// What an operator needs to chase a flagged payment.
export const reviewPayment = row => ({ ...publicPayment(row), accountId: row.account_id,
  objectId: row.object_id, eventId: row.event_id });
