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
export const publicPayment = row => {
  // Keep malformed periods reviewable even outside JavaScript's Date range.
  // The raw timestamp stays in the ledger; only its public ISO value is null.
  const periodEnd = row.period_end == null ? null : new Date(row.period_end);
  return {
    id: row.id, provider: row.provider, kind: row.kind, amountUsdMicros: row.amount_usd_micros,
    currency: row.currency, status: row.status, reason: row.reason ?? null,
    periodEnd: periodEnd && Number.isFinite(periodEnd.getTime()) ? periodEnd.toISOString() : null,
    createdAt: new Date(row.created).toISOString() };
};

// What an operator needs to chase a flagged payment.
export const reviewPayment = row => ({ ...publicPayment(row), accountId: row.account_id,
  objectId: row.object_id, eventId: row.event_id });

// ---- reversals: refunds and disputes -----------------------------------------
//
// A reversal never edits the payment it reverses. It is its own append-only
// row, keyed on the provider's refund or dispute object, pointing at the
// original payment. What it is worth depends on what the original bought:
//   top-up        the reversed dollars leave the balance; whatever was already
//                 spent becomes debt, which blocks paid requests until repaid.
//   subscription  a full reversal of the CURRENT period ends Basic now. Partial
//                 refunds and refunds of an older period are left for a human.
// The reversal is capped at what the original added, so a refund that includes
// tax cannot take more credit than the payment gave.
export const REVERSAL_KINDS = Object.freeze(['refund', 'dispute']);
const REVERSAL_FIELDS = new Set(['provider', 'eventId', 'objectId', 'kind', 'originalObjectId', 'originalKind', 'amountUsdMicros', 'currency']);

export function normalizeReversal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  for (const key of Object.keys(input)) if (!REVERSAL_FIELDS.has(key)) invalid();
  const { provider, eventId, objectId, kind, originalObjectId, originalKind, amountUsdMicros } = input;
  const currency = input.currency === undefined ? 'usd' : typeof input.currency === 'string' ? input.currency.toLowerCase() : null;
  if (!PAYMENT_PROVIDERS.includes(provider) || !REVERSAL_KINDS.includes(kind) || !PAYMENT_KINDS.includes(originalKind) || currency !== 'usd') invalid();
  if (!text(eventId, REFERENCE) || !text(objectId, REFERENCE) || !text(originalObjectId, REFERENCE)) invalid();
  if (!Number.isSafeInteger(amountUsdMicros) || amountUsdMicros <= 0 || amountUsdMicros > CREDIT_CEILING_USD_MICROS) invalid();
  return { provider, eventId, objectId, kind, originalObjectId, originalKind, amountUsdMicros, currency };
}

export const reversalFingerprint = r => createHash('sha256').update(JSON.stringify(
  [r.provider, r.objectId, r.kind, r.originalObjectId, r.originalKind, r.amountUsdMicros, r.currency])).digest('hex');

// `prior` sums earlier reversals of the same payment: `requested` is what the
// provider returned, `applied` is what was actually taken back.
// The order here is part of the contract, as for payments: the Postgres
// function repeats it and the shared suite runs the same cases against both.
export function decideReversal({ original, account, prior, reversal, now }) {
  if (original.status !== 'applied') return { action: 'record', status: 'superseded', reason: 'original_not_applied' };
  if (!account) return reject('account_missing');
  const remaining = original.amount_usd_micros - prior.applied;
  if (original.kind === 'top_up') {
    if (remaining <= 0) return { action: 'record', status: 'superseded', reason: 'already_reversed' };
    const applied = Math.min(reversal.amountUsdMicros, remaining);
    const fromCredit = Math.min(account.usd_prepaid, applied), debt = applied - fromCredit;
    if (account.usd_debt + debt > CREDIT_CEILING_USD_MICROS) return reject('credit_limit');
    return { action: 'debit', applied, fromCredit, debt };
  }
  if (prior.requested + reversal.amountUsdMicros < original.amount_usd_micros) return reject('partial_reversal');
  if (account.plan_version !== original.grant_id) return reject('period_not_current');
  if (account.plan_expires <= now) return { action: 'record', status: 'superseded', reason: 'plan_already_ended' };
  return { action: 'end_plan', applied: Math.max(0, Math.min(reversal.amountUsdMicros, remaining)) };
}

export const reversalResult = (row, duplicate) => ({
  reversalId: row.id, status: row.status, reason: row.reason ?? null, kind: row.kind,
  appliedUsdMicros: row.applied_usd_micros, duplicate });

export const publicReversal = row => ({
  id: row.id, provider: row.provider, kind: row.kind, paymentId: row.payment_id,
  amountUsdMicros: row.amount_usd_micros, appliedUsdMicros: row.applied_usd_micros, currency: row.currency,
  status: row.status, reason: row.reason ?? null, createdAt: new Date(row.created).toISOString() });

export const reviewReversal = row => ({ ...publicReversal(row), accountId: row.account_id,
  objectId: row.object_id, eventId: row.event_id });
