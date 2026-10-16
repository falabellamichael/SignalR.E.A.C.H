import { randomBytes } from 'node:crypto';
import { fail } from './errors.mjs';
import { normalizePlusPayment, normalizePlusReversal, plusFingerprint, plusGrantId, plusPaymentDecision, plusActive, plusAccount, publicPlusPayment, publicPlusReversal } from './payments/plus.mjs';
const id = () => randomBytes(32).toString('hex');
const result = (row, duplicate) => ({ paymentId: row.id, status: row.status, reason: row.reason, grantId: row.grant_id, duplicate });

// Separate tables avoid changing legacy USD/payment/request constraints or
// converting historical records. No quota, balance or financial charge exists
// on a Plus request; durable records only provide idempotency and reconciliation.
export class PlusSqliteLedger {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plus_payments(id TEXT PRIMARY KEY,object_id TEXT NOT NULL UNIQUE,event_id TEXT NOT NULL,account_id TEXT NOT NULL,price_id TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>0),currency TEXT NOT NULL CHECK(currency IN ('cad','usd')),period_end INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('applied','superseded','expired','rejected')),reason TEXT,grant_id TEXT,fingerprint TEXT NOT NULL,created INTEGER NOT NULL,customer_id TEXT NOT NULL,subscription_id TEXT NOT NULL,checkout_id TEXT NOT NULL,session_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS plus_payment_receipt ON plus_payments(account_id,grant_id,period_end,status);
      CREATE INDEX IF NOT EXISTS plus_payment_subscription ON plus_payments(subscription_id);
      CREATE INDEX IF NOT EXISTS plus_payment_checkout ON plus_payments(checkout_id);
      CREATE TABLE IF NOT EXISTS plus_reversals(id TEXT PRIMARY KEY,object_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('refund','dispute')),event_id TEXT NOT NULL,payment_id TEXT NOT NULL REFERENCES plus_payments(id),amount_minor INTEGER NOT NULL CHECK(amount_minor>0),currency TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,fingerprint TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(object_id,kind));
      CREATE TABLE IF NOT EXISTS plus_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,plan_version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('reserved','uncertain','released','settled')),replay TEXT,reason TEXT,created INTEGER NOT NULL,UNIQUE(account_id,request_id));
      CREATE INDEX IF NOT EXISTS plus_request_account ON plus_requests(account_id,plan_version,status);
    `);
  }
  hasPayment(objectId) { return !!this.db.prepare('SELECT 1 FROM plus_payments WHERE object_id=?').get(objectId); }
  checkout(payment) {
    const rows = this.db.prepare('SELECT * FROM plus_payments WHERE subscription_id=? OR checkout_id=?').all(payment.subscriptionId,payment.checkoutId);
    if (rows.length) {
      if (rows.some(row => row.account_id !== payment.accountId || row.customer_id !== payment.customerId
        || row.subscription_id !== payment.subscriptionId || row.checkout_id !== payment.checkoutId || row.price_id !== payment.priceId))
        fail(409,'payment_conflict','The subscription is already bound to a different checkout.');
      return {sessionId:rows[0].session_id};
    }
    const row=this.db.prepare('SELECT * FROM subscription_checkouts WHERE account_id=? AND id=?').get(payment.accountId,payment.checkoutId);
    if (!row?.provider_object_id) fail(503,'plus_checkout_pending','The Plus checkout must be recorded before its invoice can be applied.');
    return {sessionId:row.provider_object_id};
  }
  portalCustomer(accountId) {
    return this.db.prepare("SELECT p.customer_id FROM plus_payments p JOIN accounts a ON a.id=p.account_id AND a.plan_version=p.grant_id WHERE a.id=? AND p.status='applied'").get(accountId)?.customer_id || null;
  }
  hasRequestKey(accountId, requestId) { return !!this.db.prepare('SELECT 1 FROM plus_requests WHERE account_id=? AND request_id=?').get(accountId, requestId); }
  verified(account) {
    return !!account && account.plan_id==='plus' && !!this.db.prepare("SELECT 1 FROM plus_payments WHERE account_id=? AND grant_id=? AND period_end=? AND status='applied'").get(account.id,account.plan_version,account.plan_expires);
  }
  active(account) { return plusActive(account,this.store.subscription,this.store.now()) && this.verified(account); }
  allowance(account) {
    if (!plusAccount(account, this.store.subscription)) return null;
    const active = this.active(account);
    const rows = this.db.prepare("SELECT status,COUNT(*) AS n FROM plus_requests WHERE account_id=? AND plan_version=? GROUP BY status").all(account.id, account.plan_version);
    const n = status => rows.find(r => r.status === status)?.n || 0;
    return { plusActive: active, unlimited: active, basicActive: false, includedLimit: null, remaining: null,
      completed: n('settled'), reserved: n('reserved') + n('uncertain'), overageUsdMicrosPerRequest: 0,
      periodEndsAt: account.plan_expires ? new Date(account.plan_expires).toISOString() : null };
  }
  reserve(account, requestId, model, fingerprint) {
    const previous = this.db.prepare('SELECT * FROM plus_requests WHERE account_id=? AND request_id=?').get(account.id, requestId);
    if (!previous && !plusAccount(account, this.store.subscription)) return null;
    if (previous && (previous.model !== model || previous.fingerprint !== fingerprint)) fail(409, 'idempotency_conflict', 'Request ID has already been used for different input.');
    if (previous && previous.status !== 'released') return { id: previous.id, status: previous.status, fresh: false, replay: previous.replay ? JSON.parse(previous.replay) : null };
    if (!this.active(account)) fail(402, 'subscription_expired', 'A verified paid Plus period is required for subscription models; wallet credit remains separate.');
    if (account.usd_debt > 0) fail(402, 'usage_debt', 'An earlier request requires account reconciliation.');
    for (const table of ['reservations','request_reservations']) if (this.db.prepare(`SELECT 1 FROM ${table} WHERE account_id=? AND request_id=?`).get(account.id, requestId)) fail(409, 'idempotency_conflict', 'Request ID has already been used for another billing mode.');
    const request = previous?.id || id();
    this.db.prepare("INSERT INTO plus_requests(id,account_id,request_id,model,fingerprint,plan_version,status,created) VALUES(?,?,?,?,?,?,'reserved',?) ON CONFLICT(id) DO UPDATE SET plan_version=excluded.plan_version,status='reserved',replay=NULL,reason=NULL,created=excluded.created").run(request, account.id, requestId, model, fingerprint, account.plan_version, this.store.now());
    return { id: request, status: 'reserved', fresh: true, replay: null };
  }
  finish(reservationId, action, replay = null) {
    const row = this.db.prepare('SELECT * FROM plus_requests WHERE id=?').get(reservationId);
    if (!row) return false;
    if (action === 'uncertain') { this.db.prepare("UPDATE plus_requests SET status='uncertain',reason=? WHERE id=? AND status='reserved'").run(replay, row.id); return true; }
    const target = action === 'settle' ? 'settled' : 'released';
    if (row.status === target) return true;
    if (!(action === 'settle' ? ['reserved','uncertain'] : ['reserved']).includes(row.status)) fail(409, 'reservation_closed', 'An uncertain or completed request requires reconciliation.');
    this.db.prepare('UPDATE plus_requests SET status=?,replay=?,reason=? WHERE id=?').run(target, action === 'settle' ? replay : null, action === 'settle' ? null : 'not_completed', row.id);
    return true;
  }
  unsettled(accountId) {
    return this.db.prepare("SELECT id,account_id,request_id,model,0 AS amount,status,created,reason,'requests' AS currency,1 AS unlimited FROM plus_requests WHERE status IN ('reserved','uncertain') AND (? IS NULL OR account_id=?) ORDER BY created").all(accountId || null, accountId || null);
  }
  listPayments(accountId, flagged = false) {
    return this.db.prepare(`SELECT * FROM plus_payments WHERE ${flagged ? "status IN ('rejected','expired')" : 'account_id=?'} ORDER BY created DESC,id LIMIT 200`).all(...(flagged ? [] : [accountId])).map(row => ({ ...publicPlusPayment(row), ...(flagged ? {accountId:row.account_id,objectId:row.object_id,eventId:row.event_id} : {}) }));
  }
  listReversals(accountId, flagged = false) {
    return this.db.prepare(`SELECT r.*,p.account_id FROM plus_reversals r JOIN plus_payments p ON p.id=r.payment_id WHERE ${flagged ? "r.status='rejected'" : 'p.account_id=?'} ORDER BY r.created DESC,r.id LIMIT 200`).all(...(flagged ? [] : [accountId])).map(row => ({...publicPlusReversal(row),...(flagged ? {accountId:row.account_id,objectId:row.object_id,eventId:row.event_id} : {})}));
  }
  applyPayment(raw) {
    const payment = normalizePlusPayment(raw), fingerprint = plusFingerprint(payment), store = this.store;
    return store.transaction(() => {
      const old = this.db.prepare('SELECT * FROM plus_payments WHERE object_id=?').get(payment.objectId);
      if (old) { if (old.fingerprint !== fingerprint) fail(409, 'payment_conflict', 'This invoice was already recorded with different values.'); return result(old, true); }
      if (this.db.prepare("SELECT 1 FROM payments WHERE provider='stripe' AND object_id=?").get(payment.objectId)) fail(409, 'payment_conflict', 'The invoice belongs to another plan.');
      if (this.checkout(payment).sessionId !== payment.sessionId) fail(409,'payment_conflict','The invoice checkout differs from the recorded checkout.');
      const account = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(payment.accountId);
      const current=this.db.prepare("SELECT subscription_id FROM plus_payments WHERE account_id=? AND grant_id=? AND status='applied'").get(account?.id || '',account?.plan_version || '');
      if (current && account.plan_expires>store.now() && current.subscription_id!==payment.subscriptionId) fail(409,'payment_conflict','Another paid subscription is still active.');
      const decision = plusPaymentDecision(account, payment, store.subscription, store.now(), this.verified(account));
      const models = store.basicPlanModels();
      if (decision.status === 'applied' && !models.length) fail(409, 'no_qualified_models', 'No qualified subscription models are configured.');
      const grant = decision.status === 'applied' ? plusGrantId(payment.objectId) : null;
      if (grant) store.grantPlan({ accountId: account.id, grantId: grant, planId: 'plus', name: store.subscription.plus.name,
        models, tokens: 0, expiresAt: payment.periodEnd }, true);
      const row = { id: id(), ...decision, grant_id: grant };
      this.db.prepare('INSERT INTO plus_payments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, payment.objectId, payment.eventId, payment.accountId,
        payment.priceId, payment.amountMinor, payment.currency, payment.periodEnd, row.status, row.reason, grant, fingerprint, store.now(),payment.customerId,payment.subscriptionId,payment.checkoutId,payment.sessionId);
      return result(row, false);
    });
  }
  applyReversal(raw) {
    const reversal = normalizePlusReversal(raw), fingerprint = plusFingerprint(reversal);
    return this.store.transaction(() => {
      const old = this.db.prepare('SELECT * FROM plus_reversals WHERE object_id=? AND kind=?').get(reversal.objectId, reversal.kind);
      if (old) { if (old.fingerprint !== fingerprint) fail(409, 'payment_conflict', 'This reversal was already recorded with different values.'); return { status: old.status, reason: old.reason, duplicate: true }; }
      const payment = this.db.prepare('SELECT * FROM plus_payments WHERE object_id=?').get(reversal.originalObjectId);
      if (!payment) return null;
      if (reversal.currency !== payment.currency) fail(400, 'invalid_payment', 'Reversal currency differs from the original payment.');
      const account = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(payment.account_id), prior = this.db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS amount FROM plus_reversals WHERE payment_id=?').get(payment.id).amount;
      const reason = payment.status !== 'applied' ? 'original_not_applied' : prior + reversal.amountMinor < payment.amount_minor ? 'partial_reversal'
        : !account ? 'account_missing' : account.plan_version !== payment.grant_id ? 'period_not_current' : account.plan_expires <= this.store.now() ? 'plan_already_ended' : null;
      if (!reason) this.db.prepare('UPDATE accounts SET plan_expires=? WHERE id=?').run(this.store.now(), account.id);
      const status = reason ? 'rejected' : 'applied';
      this.db.prepare('INSERT INTO plus_reversals VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id(), reversal.objectId, reversal.kind, reversal.eventId, payment.id,
        reversal.amountMinor, reversal.currency, status, reason, fingerprint, this.store.now());
      return { status, reason, duplicate: false };
    });
  }
}
