import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress } from 'ethers';

import { AccountError, fail } from './errors.mjs';
import { normalizePayment, paymentFingerprint, grantIdFor, decideSubscriptionPayment, decideTopUpPayment,
  paymentResult, publicPayment, reviewPayment, normalizeReversal, reversalFingerprint, decideReversal,
  reversalResult, publicReversal, reviewReversal } from './payments/core.mjs';
export { AccountError, fail };
export const digest = value => createHash('sha256').update(value).digest('hex');
const id = () => randomBytes(32).toString('hex');
const safeCount = n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000_000;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function requestBillingPolicy(subscription) {
  if (subscription === undefined) return null;
  if (!subscription || subscription.basic?.id !== 'basic-wallet' || subscription.basic.includedRequests !== 1500
    || subscription.basic.priceUsdMicros !== 15000000 || subscription.overageUsdMicrosPerRequest !== 10000
    || subscription.proEnabled !== false) throw new Error('Configure the approved Basic request subscription policy.');
  return { basic: { ...subscription.basic }, overageUsdMicrosPerRequest: 10000, proEnabled: false };
}
export const requestModel = model => model?.access === 'requests' && model.metered === true
  && typeof model.bridge?.model === 'string' && model.bridge.model !== 'codegpt-eco-gpt-4o-mini'
  && (model.bridge.kind === 'tray'
    ? /^(?:copilot-chat|chatgpt-chat|gemini-chat|codegpt-eco-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100})$/.test(model.bridge.model)
    : model.bridge.kind === 'codegpt' && /^codegpt-(?!eco(?:-|$))[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(model.bridge.model));
export const basicPlanModelIds = models => models.filter(requestModel).map(m => m.id).sort();
export function basicRequestPeriod(account, subscription, now) {
  return subscription && ['basic', subscription.basic.id].includes(account.plan_id)
    && account.plan_expires > now && typeof account.plan_version === 'string' && account.plan_version.length
    ? `${account.plan_version}:${account.plan_expires}` : null;
}
export function requestReplay(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !['application/json; charset=utf-8', 'text/event-stream'].includes(record.contentType)
    || typeof record.body !== 'string') fail(400, 'invalid_replay', 'A completed request requires a valid replay record.');
  const replay = JSON.stringify({ contentType: record.contentType, body: record.body });
  if (Buffer.byteLength(replay) > 1048576) fail(400, 'invalid_replay', 'The completed request replay exceeds the service limit.');
  return replay;
}

export function modelUsdPricing(model) {
  const p = model?.pricing;
  return p && safeCount(p.inputUsdMicrosPerMillion) && safeCount(p.outputUsdMicrosPerMillion)
    && (p.cachedInputUsdMicrosPerMillion === undefined || safeCount(p.cachedInputUsdMicrosPerMillion) && p.cachedInputUsdMicrosPerMillion <= p.inputUsdMicrosPerMillion)
    && p.inputUsdMicrosPerMillion + p.outputUsdMicrosPerMillion > 0 ? p : null;
}
export function usdUsageCost(pricing, usage) {
  if (!modelUsdPricing({ pricing }) || !safeCount(usage?.promptTokens) || !safeCount(usage?.completionTokens)) fail(400,'invalid_usage','Measured usage or model price is invalid.');
  const cached = usage.details?.prompt?.cached_tokens ?? 0;
  if (!safeCount(cached) || cached > usage.promptTokens) fail(400,'invalid_usage','Measured cached usage is invalid.');
  const cost = (BigInt(usage.promptTokens - cached) * BigInt(pricing.inputUsdMicrosPerMillion)
    + BigInt(cached) * BigInt(pricing.cachedInputUsdMicrosPerMillion ?? pricing.inputUsdMicrosPerMillion)
    + BigInt(usage.completionTokens) * BigInt(pricing.outputUsdMicrosPerMillion) + 999999n) / 1000000n;
  if (cost > 1000000000000n) fail(400,'invalid_usage','Measured usage exceeds the credit limit.');
  return Number(cost);
}
export function marketQuotePayload(amount, quote, now, wallet) {
  if (typeof amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amount) || !quote || Array.isArray(quote)
    || !safeCount(quote.creditUsdMicros) || quote.creditUsdMicros === 0
    || !safeCount(quote.creditBudgetUsdMicros) || quote.creditBudgetUsdMicros === 0
    || !Number.isSafeInteger(quote.expiresAtMs) || quote.expiresAtMs <= now || quote.expiresAtMs > now + 900000
    || !Number.isSafeInteger(quote.issuedAt) || quote.issuedAt > Math.floor(now / 1000) + 5
    || quote.issuedAt < Math.floor(now / 1000) - 300
    || !Number.isSafeInteger(quote.deadline) || quote.deadline * 1000 !== quote.expiresAtMs
    || quote.deadline <= quote.issuedAt || quote.amount !== amount
    || !Number.isSafeInteger(quote.chainId) || quote.chainId <= 0
    || typeof quote.source !== 'string' || !quote.source.length || quote.source.length > 200) fail(400,'invalid_redemption','Invalid market quote.');
  try {
    for (const key of ['tokenAddress','treasuryAddress','redemptionContract']) getAddress(quote[key]);
    if (quote.wallet && getAddress(quote.wallet) !== getAddress(wallet)) throw new Error('Wallet mismatch');
  } catch { fail(400,'invalid_redemption','Invalid market quote address.'); }
  const payload = JSON.stringify({ ...quote, wallet: getAddress(wallet), amount });
  if (Buffer.byteLength(payload) > 32768) fail(400,'invalid_redemption','Market quote is too large.');
  return payload;
}

export class AccountStore {
  constructor(path, { now = () => Date.now(), models = [], subscription } = {}) {
    this.now = now; this.models = models; this.subscription = requestBillingPolicy(subscription);
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { if (lstatSync(path).isSymbolicLink()) throw new Error('Account database must not be a symlink.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const previousMask=process.umask(0o077);
    try { this.db = new DatabaseSync(path); } finally { process.umask(previousMask); }
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,wallet TEXT UNIQUE NOT NULL,plan_id TEXT,plan_name TEXT,plan_expires INTEGER NOT NULL DEFAULT 0,plan_version TEXT,models TEXT NOT NULL DEFAULT '[]',included INTEGER NOT NULL DEFAULT 0,prepaid INTEGER NOT NULL DEFAULT 0,debt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS flows(id TEXT PRIMARY KEY,state_hash TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL,account_id TEXT,consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,flow_id TEXT NOT NULL,wallet TEXT NOT NULL,message TEXT NOT NULL,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,request_id TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,amount INTEGER NOT NULL,held_included INTEGER NOT NULL,held_prepaid INTEGER NOT NULL,plan_version TEXT,status TEXT NOT NULL,created INTEGER NOT NULL,usage TEXT,replay TEXT,reason TEXT,UNIQUE(account_id,request_id));
      CREATE TABLE IF NOT EXISTS redemptions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,wallet TEXT NOT NULL,amount TEXT NOT NULL,usage_tokens INTEGER NOT NULL,ticket_hash TEXT NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'created',tx_hash TEXT,event_key TEXT UNIQUE,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reservation_account_status ON reservations(account_id,status);
      CREATE INDEX IF NOT EXISTS redemption_status ON redemptions(status);
      CREATE INDEX IF NOT EXISTS challenge_expiry ON challenges(expires);
      CREATE INDEX IF NOT EXISTS flow_expiry ON flows(expires);
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
      CREATE TABLE IF NOT EXISTS request_periods(account_id TEXT NOT NULL REFERENCES accounts(id),period_key TEXT NOT NULL,plan_version TEXT NOT NULL,period_ends INTEGER NOT NULL,included_limit INTEGER NOT NULL CHECK(included_limit=1500),completed INTEGER NOT NULL DEFAULT 0 CHECK(completed BETWEEN 0 AND included_limit),PRIMARY KEY(account_id,period_key));
      CREATE TABLE IF NOT EXISTS request_reservations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,period_key TEXT,included INTEGER NOT NULL CHECK(included IN (0,1)),charge_usd_micros INTEGER NOT NULL CHECK(charge_usd_micros IN (0,10000)),status TEXT NOT NULL CHECK(status IN ('reserved','uncertain','released','settled')),created INTEGER NOT NULL,replay TEXT,reason TEXT,UNIQUE(account_id,request_id),FOREIGN KEY(account_id,period_key) REFERENCES request_periods(account_id,period_key),CHECK(included=1 AND charge_usd_micros=0 AND period_key IS NOT NULL OR included=0 AND charge_usd_micros=10000 AND period_key IS NULL));
      CREATE INDEX IF NOT EXISTS request_reservation_account_period ON request_reservations(account_id,period_key,status);
      CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,provider TEXT NOT NULL CHECK(provider IN ('stripe','paypal','manual')),event_id TEXT NOT NULL,object_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('subscription_period','top_up')),account_id TEXT NOT NULL,amount_usd_micros INTEGER NOT NULL CHECK(amount_usd_micros>0),currency TEXT NOT NULL CHECK(currency='usd'),period_end INTEGER,status TEXT NOT NULL CHECK(status IN ('applied','superseded','expired','rejected')),reason TEXT,grant_id TEXT,fingerprint TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(provider,object_id,kind),CHECK(kind='subscription_period' AND period_end IS NOT NULL OR kind='top_up' AND period_end IS NULL),CHECK((status='applied')=(reason IS NULL)));
      CREATE INDEX IF NOT EXISTS payment_account ON payments(account_id,created);
      CREATE INDEX IF NOT EXISTS payment_review ON payments(status) WHERE status IN ('rejected','expired');
      CREATE TABLE IF NOT EXISTS payment_reversals(id TEXT PRIMARY KEY,provider TEXT NOT NULL CHECK(provider IN ('stripe','paypal','manual')),event_id TEXT NOT NULL,object_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('refund','dispute')),payment_id TEXT NOT NULL REFERENCES payments(id),account_id TEXT NOT NULL,amount_usd_micros INTEGER NOT NULL CHECK(amount_usd_micros>0),applied_usd_micros INTEGER NOT NULL CHECK(applied_usd_micros>=0),currency TEXT NOT NULL CHECK(currency='usd'),status TEXT NOT NULL CHECK(status IN ('applied','superseded','rejected')),reason TEXT,fingerprint TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(provider,object_id,kind),CHECK((status='applied')=(reason IS NULL)),CHECK(status='applied' OR applied_usd_micros=0));
      CREATE INDEX IF NOT EXISTS reversal_payment ON payment_reversals(payment_id);
      CREATE INDEX IF NOT EXISTS reversal_account ON payment_reversals(account_id,created);
    `);
    // Additive migration preserves every existing account and token reservation.
    for (const [table, columns] of Object.entries({ accounts: { usd_prepaid: 'INTEGER NOT NULL DEFAULT 0', usd_debt: 'INTEGER NOT NULL DEFAULT 0' },
      reservations: { currency: "TEXT NOT NULL DEFAULT 'tokens'", pricing_json: 'TEXT' },
      redemptions: { usd_micros: 'INTEGER NOT NULL DEFAULT 0', quote_json: 'TEXT' } })) {
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
      for (const [column, definition] of Object.entries(columns)) if (!existing.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  close() { this.db.close(); }
  findAccountByWallet(wallet) { return this.db.prepare('SELECT * FROM accounts WHERE wallet=? COLLATE NOCASE').get(getAddress(wallet)) ?? null; }
  unsettledReservations(accountId) {
    const columns = 'id,account_id,request_id,model,amount,status,created,reason,currency';
    const legacy = accountId
      ? this.db.prepare(`SELECT ${columns} FROM reservations WHERE account_id=? AND status IN ('reserved','uncertain') ORDER BY created`).all(accountId)
      : this.db.prepare(`SELECT ${columns} FROM reservations WHERE status IN ('reserved','uncertain') ORDER BY created`).all();
    const requestColumns="id,account_id,request_id,model,charge_usd_micros AS amount,status,created,reason,'requests' AS currency,included";
    const requests=accountId
      ? this.db.prepare(`SELECT ${requestColumns} FROM request_reservations WHERE account_id=? AND status IN ('reserved','uncertain') ORDER BY created`).all(accountId)
      : this.db.prepare(`SELECT ${requestColumns} FROM request_reservations WHERE status IN ('reserved','uncertain') ORDER BY created`).all();
    return [...legacy,...requests].sort((a,b)=>a.created-b.created);
  }
  pruneExpiredAuthentication() {
    return this.transaction(()=>{
      this.db.prepare('DELETE FROM challenges WHERE expires<=?').run(this.now());
      this.db.prepare('DELETE FROM flows WHERE expires<=?').run(this.now());
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.now());
    });
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  accountById(accountId) { const a = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId); if (!a) fail(401,'account_missing','Account is unavailable.'); return a; }
  ensureAccount(wallet) {
    wallet = getAddress(wallet);
    this.db.prepare('INSERT OR IGNORE INTO accounts(id,wallet) VALUES(?,?)').run(id(),wallet);
    return this.db.prepare('SELECT * FROM accounts WHERE wallet=?').get(wallet);
  }
  account(accountId) {
    const a = this.accountById(accountId), active = a.plan_expires > this.now();
    const held = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN currency='tokens' THEN amount ELSE 0 END),0) AS tokens,COALESCE(SUM(CASE WHEN currency='USD' THEN amount ELSE 0 END),0) AS usd FROM reservations WHERE account_id=? AND status IN ('reserved','uncertain')").get(accountId);
    const allowed = JSON.parse(a.models);
    const requestAllowance = this.subscription ? this.requestAllowance(accountId) : null;
    const requestHeld = this.db.prepare("SELECT COALESCE(SUM(charge_usd_micros),0) AS usd FROM request_reservations WHERE account_id=? AND status IN ('reserved','uncertain')").get(accountId).usd;
    return { id:a.id, walletAddress:a.wallet, plan:{ id:a.plan_id, name:a.plan_name, status:active?'active':a.plan_id?'expired':'none', expiresAt:a.plan_expires?new Date(a.plan_expires).toISOString():null }, allowedModels:this.models.filter(m=>m.access==='requests'
      ? requestModel(m) && !!this.subscription && (requestAllowance.basicActive || a.usd_prepaid>0)
      : m.metered===true && (a.usd_prepaid>0&&modelUsdPricing(m)||a.prepaid>0||active&&allowed.includes(m.id))).map(m=>({id:m.id,name:m.name||m.id,provider:m.provider,...(requestModel(m)?{access:'requests',pricing:{unit:'request',includedRequests:this.subscription.basic.includedRequests,usdMicrosPerRequest:this.subscription.overageUsdMicrosPerRequest},capabilities:{outputTokenLimit:false}}:modelUsdPricing(m)?{pricing:{...m.pricing}}:{})})), allowance:{ includedRemaining:active?a.included:0, prepaidRemaining:a.prepaid, reserved:held.tokens, totalRemaining:a.debt===0?(active?a.included:0)+a.prepaid:0, debt:a.debt }, credit:{currency:'USD',balanceMicros:a.usd_prepaid,reservedMicros:held.usd+requestHeld,debtMicros:a.usd_debt}, ...(requestAllowance?{requestAllowance}:{}) };
  }
  requestAllowance(accountId) {
    const a=this.accountById(accountId),period=basicRequestPeriod(a,this.subscription,this.now());
    const completed=period?this.db.prepare('SELECT completed FROM request_periods WHERE account_id=? AND period_key=?').get(accountId,period)?.completed||0:0;
    const reserved=period?this.db.prepare("SELECT COUNT(*) AS n FROM request_reservations WHERE account_id=? AND period_key=? AND included=1 AND status IN ('reserved','uncertain')").get(accountId,period).n:0;
    const includedLimit=period?this.subscription.basic.includedRequests:0;
    return {includedLimit,completed,reserved,remaining:Math.max(0,includedLimit-completed-reserved),periodEndsAt:period?new Date(a.plan_expires).toISOString():null,overageUsdMicrosPerRequest:this.subscription?.overageUsdMicrosPerRequest??0,basicActive:!!period};
  }
  reserveRequest(accountId,requestId,model,fingerprint) {
    if(!this.subscription||!this.models.some(m=>m.id===model&&requestModel(m)))fail(403,'model_not_entitled','This model is not available for request access.');
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/.test(requestId)||typeof fingerprint!=='string'||!fingerprint.length||fingerprint.length>128)fail(400,'invalid_reservation','Invalid request reservation.');
    return this.transaction(()=>{
      const a=this.accountById(accountId);
      if(this.db.prepare('SELECT 1 FROM reservations WHERE account_id=? AND request_id=?').get(accountId,requestId))fail(409,'idempotency_conflict','Request ID has already been used for different input.');
      const previous=this.db.prepare('SELECT * FROM request_reservations WHERE account_id=? AND request_id=?').get(accountId,requestId);
      if(previous){
        if(previous.model!==model||previous.fingerprint!==fingerprint)fail(409,'idempotency_conflict','Request ID has already been used for different input.');
        if(previous.status!=='released')return{id:previous.id,status:previous.status,replay:previous.replay?JSON.parse(previous.replay):null,fresh:false};
      }
      const period=basicRequestPeriod(a,this.subscription,this.now()),allowance=this.requestAllowance(accountId),included=!!period&&allowance.remaining>0;
      const charge=included?0:this.subscription.overageUsdMicrosPerRequest;
      if(a.usd_debt>0)fail(402,'usage_debt','An earlier request requires account reconciliation.');
      if(!included&&a.usd_prepaid<charge)fail(402,'allowance_exhausted','Not enough USD credit for this request.');
      if(included)this.db.prepare('INSERT OR IGNORE INTO request_periods(account_id,period_key,plan_version,period_ends,included_limit) VALUES(?,?,?,?,?)').run(accountId,period,a.plan_version,a.plan_expires,this.subscription.basic.includedRequests);
      if(charge)this.db.prepare('UPDATE accounts SET usd_prepaid=usd_prepaid-? WHERE id=?').run(charge,accountId);
      const ri=previous?.id||id();
      this.db.prepare("INSERT INTO request_reservations(id,account_id,request_id,model,fingerprint,period_key,included,charge_usd_micros,status,created) VALUES(?,?,?,?,?,?,?,?,'reserved',?) ON CONFLICT(id) DO UPDATE SET period_key=excluded.period_key,included=excluded.included,charge_usd_micros=excluded.charge_usd_micros,status='reserved',created=excluded.created,replay=NULL,reason=NULL").run(ri,accountId,requestId,model,fingerprint,included?period:null,included?1:0,charge,this.now());
      return{id:ri,status:'reserved',replay:null,fresh:true};
    });
  }
  settleRequest(reservationId,responseRecord) {
    const replay=requestReplay(responseRecord);
    return this.transaction(()=>{
      const r=this.db.prepare('SELECT * FROM request_reservations WHERE id=?').get(reservationId);
      if(!r)fail(404,'reservation_missing','Reservation not found.');
      if(r.status==='settled')return;
      if(!['reserved','uncertain'].includes(r.status))fail(409,'reservation_closed','Reservation is closed.');
      if(r.included){
        const update=this.db.prepare('UPDATE request_periods SET completed=completed+1 WHERE account_id=? AND period_key=? AND completed<included_limit').run(r.account_id,r.period_key);
        if(update.changes!==1)fail(409,'credit_limit','Request allowance requires reconciliation.');
      }
      this.db.prepare("UPDATE request_reservations SET status='settled',replay=?,reason=NULL WHERE id=?").run(replay,r.id);
    });
  }
  releaseRequest(reservationId) {
    return this.transaction(()=>{
      const r=this.db.prepare('SELECT * FROM request_reservations WHERE id=?').get(reservationId);
      if(!r)fail(404,'reservation_missing','Reservation not found.');
      if(r.status==='released')return;
      if(r.status!=='reserved')fail(409,'reservation_closed','An uncertain or completed request requires reconciliation.');
      if(r.charge_usd_micros){
        const a=this.accountById(r.account_id);
        if(!safeCount(a.usd_prepaid+r.charge_usd_micros))fail(409,'credit_limit','Account credit limit requires reconciliation.');
        this.db.prepare('UPDATE accounts SET usd_prepaid=usd_prepaid+? WHERE id=?').run(r.charge_usd_micros,r.account_id);
      }
      this.db.prepare("UPDATE request_reservations SET status='released',reason='not_completed' WHERE id=?").run(r.id);
    });
  }
  markRequestUncertain(reservationId,reason='completion_unknown') {
    this.db.prepare("UPDATE request_reservations SET status='uncertain',reason=? WHERE id=? AND status='reserved'").run(String(reason).slice(0,200),reservationId);
  }
  grantPlan({wallet,grantId,planId,name,models,tokens,expiresAt},nested=false) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(grantId||'') || !planId || typeof name!=='string' || !safeCount(tokens) || !Array.isArray(models) || !models.length || !models.every(m=>this.models.some(x=>x.id===m&&(x.metered===true||this.subscription&&requestModel(x)))) || !Number.isSafeInteger(expiresAt) || expiresAt<=this.now()) fail(400,'invalid_grant','Invalid plan grant, qualified model list, allowance, or expiry.');
    const payload = JSON.stringify({wallet:getAddress(wallet),planId,name,models:[...models].sort(),tokens,expiresAt});
    const run=()=>{
      const prev=this.db.prepare('SELECT * FROM grants WHERE id=?').get(grantId);
      if(prev) { if(prev.payload!==payload) fail(409,'grant_conflict','Grant ID was already used with different values.'); return this.account(prev.account_id); }
      const a=this.ensureAccount(wallet);
      this.db.prepare('UPDATE accounts SET plan_id=?,plan_name=?,plan_expires=?,plan_version=?,models=?,included=? WHERE id=?').run(planId,name,expiresAt,grantId,JSON.stringify(models),tokens,a.id);
      this.db.prepare('INSERT INTO grants VALUES(?,?,?)').run(grantId,a.id,payload);
      return this.account(a.id);
    };
    return nested?run():this.transaction(run);
  }
  // ---- payments: a provider-neutral ledger (rules live in payments/core.mjs) ----
  basicPlanModels() { return basicPlanModelIds(this.models); }
  // Records one payment and applies its effect in a SINGLE transaction. Business-rule
  // failures (wrong amount, expired period, unknown account) are recorded as a
  // `rejected`/`expired` row and returned, not thrown: a throw would make the provider
  // retry for days. Only infrastructure failures and genuine conflicts throw, so a
  // retry after a crash converges.
  applyPayment(raw) {
    const payment=normalizePayment(raw),fingerprint=paymentFingerprint(payment);
    if(payment.kind==='subscription_period'){
      if(!this.subscription)fail(409,'subscription_unconfigured','Request subscriptions are not configured on this service.');
      if(!this.basicPlanModels().length)fail(409,'no_qualified_models','No qualified request models are configured for the plan grant.');
    }
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM payments WHERE provider=? AND object_id=? AND kind=?').get(payment.provider,payment.objectId,payment.kind);
      if(existing){
        if(existing.fingerprint!==fingerprint)fail(409,'payment_conflict','This payment was already recorded with different values.');
        return paymentResult(existing,true);
      }
      const now=this.now(),account=this.db.prepare('SELECT * FROM accounts WHERE id=?').get(payment.accountId)??null;
      const decision=payment.kind==='subscription_period'
        ?decideSubscriptionPayment({account,payment,policy:this.subscription,now})
        :decideTopUpPayment({account,payment});
      let grantId=null;
      if(decision.action==='grant'){
        grantId=grantIdFor(payment);
        this.grantPlan({wallet:account.wallet,grantId,planId:this.subscription.basic.id,name:'Basic',models:this.basicPlanModels(),tokens:0,expiresAt:payment.periodEnd},true);
      } else if(decision.action==='credit'){
        this.db.prepare('UPDATE accounts SET usd_prepaid=usd_prepaid+?,usd_debt=usd_debt-? WHERE id=?').run(decision.credit,decision.debtPaid,account.id);
      }
      const row={id:id(),provider:payment.provider,event_id:payment.eventId,object_id:payment.objectId,kind:payment.kind,account_id:payment.accountId,
        amount_usd_micros:payment.amountUsdMicros,currency:payment.currency,period_end:payment.periodEnd,status:decision.status??'applied',
        reason:decision.reason??null,grant_id:grantId,fingerprint,created:now};
      this.db.prepare('INSERT INTO payments(id,provider,event_id,object_id,kind,account_id,amount_usd_micros,currency,period_end,status,reason,grant_id,fingerprint,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.id,row.provider,row.event_id,row.object_id,row.kind,row.account_id,row.amount_usd_micros,row.currency,row.period_end,row.status,row.reason,row.grant_id,row.fingerprint,row.created);
      return paymentResult(row,false);
    });
  }
  listPayments(accountId,limit=50) {
    const bounded=Number.isSafeInteger(limit)&&limit>=1&&limit<=200?limit:50;
    return this.db.prepare('SELECT * FROM payments WHERE account_id=? ORDER BY created DESC,id LIMIT ?').all(accountId,bounded).map(publicPayment);
  }
  flaggedPayments() {
    return this.db.prepare("SELECT * FROM payments WHERE status IN ('rejected','expired') ORDER BY created,id").all().map(reviewPayment);
  }
  // Records one refund or dispute and applies its effect in ONE transaction.
  // Returns null when the original payment is not in this ledger: a refund of
  // something REACH never sold is not ours to record.
  applyReversal(raw) {
    const reversal=normalizeReversal(raw),fingerprint=reversalFingerprint(reversal);
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM payment_reversals WHERE provider=? AND object_id=? AND kind=?').get(reversal.provider,reversal.objectId,reversal.kind);
      if(existing){
        if(existing.fingerprint!==fingerprint)fail(409,'payment_conflict','This payment was already recorded with different values.');
        return reversalResult(existing,true);
      }
      const original=this.db.prepare('SELECT * FROM payments WHERE provider=? AND object_id=? AND kind=?').get(reversal.provider,reversal.originalObjectId,reversal.originalKind);
      if(!original)return null;
      const now=this.now(),account=this.db.prepare('SELECT * FROM accounts WHERE id=?').get(original.account_id)??null;
      const prior=this.db.prepare('SELECT COALESCE(SUM(amount_usd_micros),0) AS requested,COALESCE(SUM(applied_usd_micros),0) AS applied FROM payment_reversals WHERE payment_id=?').get(original.id);
      const decision=decideReversal({original,account,prior,reversal,now});
      if(decision.action==='debit')this.db.prepare('UPDATE accounts SET usd_prepaid=usd_prepaid-?,usd_debt=usd_debt+? WHERE id=?').run(decision.fromCredit,decision.debt,account.id);
      else if(decision.action==='end_plan')this.db.prepare('UPDATE accounts SET plan_expires=? WHERE id=?').run(now,account.id);
      const row={id:id(),provider:reversal.provider,event_id:reversal.eventId,object_id:reversal.objectId,kind:reversal.kind,payment_id:original.id,
        account_id:original.account_id,amount_usd_micros:reversal.amountUsdMicros,applied_usd_micros:decision.applied??0,currency:reversal.currency,
        status:decision.status??'applied',reason:decision.reason??null,fingerprint,created:now};
      this.db.prepare('INSERT INTO payment_reversals(id,provider,event_id,object_id,kind,payment_id,account_id,amount_usd_micros,applied_usd_micros,currency,status,reason,fingerprint,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.id,row.provider,row.event_id,row.object_id,row.kind,row.payment_id,row.account_id,row.amount_usd_micros,row.applied_usd_micros,row.currency,row.status,row.reason,row.fingerprint,row.created);
      return reversalResult(row,false);
    });
  }
  listReversals(accountId,limit=50) {
    const bounded=Number.isSafeInteger(limit)&&limit>=1&&limit<=200?limit:50;
    return this.db.prepare('SELECT * FROM payment_reversals WHERE account_id=? ORDER BY created DESC,id LIMIT ?').all(accountId,bounded).map(publicReversal);
  }
  flaggedReversals() {
    return this.db.prepare("SELECT * FROM payment_reversals WHERE status='rejected' ORDER BY created,id").all().map(reviewReversal);
  }
  startFlow(state,challenge) {
    if(typeof state!=='string'||typeof challenge!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(state)||!/^[A-Za-z0-9_-]{43}$/.test(challenge)) fail(400,'invalid_flow','Invalid sign-in state or proof key.');
    const flowId=id(),expires=this.now()+600_000;
    this.db.prepare('INSERT INTO flows(id,state_hash,challenge,expires) VALUES(?,?,?,?)').run(flowId,digest(state),challenge,expires);
    return {flowId,expiresAt:new Date(expires).toISOString()};
  }
  getFlow(flowId) { if(typeof flowId!=='string'||!/^[a-f0-9]{64}$/.test(flowId))fail(400,'invalid_flow','Invalid sign-in flow.'); const f=this.db.prepare('SELECT * FROM flows WHERE id=?').get(flowId); if(!f||f.expires<=this.now()||f.consumed) fail(410,'flow_expired','Sign-in expired. Start again in Studio.'); return f; }
  challenge(flowId,wallet,makeMessage) {
    return this.transaction(()=>{
      const f=this.getFlow(flowId); if(f.account_id) fail(409,'flow_verified','Sign-in has already been verified.');
      wallet=getAddress(wallet); const challengeId=id(),expires=Math.min(f.expires,this.now()+300_000),nonce=id();
      const message=makeMessage(wallet,nonce,new Date(this.now()).toISOString(),new Date(expires).toISOString());
      this.db.prepare('UPDATE challenges SET consumed=1 WHERE flow_id=?').run(flowId);
      this.db.prepare('INSERT INTO challenges VALUES(?,?,?,?,?,0)').run(challengeId,flowId,wallet,message,expires);
      return {challengeId,message,address:wallet,expiresAt:new Date(expires).toISOString()};
    });
  }
  getChallenge(flowId,challengeId) {
    this.getFlow(flowId);if(typeof challengeId!=='string'||!/^[a-f0-9]{64}$/.test(challengeId))fail(400,'invalid_challenge','Invalid challenge.');const c=this.db.prepare('SELECT * FROM challenges WHERE id=? AND flow_id=?').get(challengeId,flowId);
    if(!c||c.consumed||c.expires<=this.now()) fail(410,'challenge_expired','This sign-in challenge is no longer valid.');return c;
  }
  authorize(flowId,challengeId) {
    return this.transaction(()=>{ const c=this.getChallenge(flowId,challengeId);const a=this.ensureAccount(c.wallet);
      this.db.prepare('UPDATE challenges SET consumed=1 WHERE id=?').run(challengeId);
      this.db.prepare('UPDATE flows SET account_id=? WHERE id=?').run(a.id,flowId);return a.id;
    });
  }
  exchange(flowId,state,verifier) {
    return this.transaction(()=>{
      const f=this.getFlow(flowId); if(typeof state!=='string'||typeof verifier!=='string'||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)||!equal(f.state_hash,digest(state||''))||!equal(f.challenge,createHash('sha256').update(verifier).digest('base64url'))) fail(401,'invalid_proof','The sign-in proof does not match.');
      if(!f.account_id) return null;
      const token='rch_session_'+id(),expires=this.now()+3600_000;
      this.db.prepare('UPDATE flows SET consumed=1 WHERE id=?').run(flowId);
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),f.account_id,expires);
      return {accessToken:token,expiresAt:new Date(expires).toISOString(),account:this.account(f.account_id)};
    });
  }
  authenticate(token) {
    if(typeof token!=='string'||!/^rch_session_[a-f0-9]{64}$/.test(token)) fail(401,'session_required','Connect your wallet to REACH.');
    const s=this.db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(digest(token),this.now());
    if(!s) fail(401,'session_expired','Your REACH session expired. Connect your wallet again.');return this.account(s.account_id);
  }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); }
  reserve(accountId,requestId,model,fingerprint,amount) {
    if(!safeCount(amount)||amount===0||typeof requestId!=='string'||requestId.length>128) fail(400,'invalid_reservation','Invalid request reservation.');
    return this.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM request_reservations WHERE account_id=? AND request_id=?').get(accountId,requestId))fail(409,'idempotency_conflict','Request ID has already been used for different input.');
      const previous=this.db.prepare('SELECT * FROM reservations WHERE account_id=? AND request_id=?').get(accountId,requestId);
      if(previous) {
        if(previous.fingerprint!==fingerprint||previous.model!==model||previous.currency!=='tokens') fail(409,'idempotency_conflict','Request ID has already been used for different input.');
        if(previous.status!=='released')return {id:previous.id,status:previous.status,replay:previous.replay?JSON.parse(previous.replay):null,fresh:false};
      }
      const a=this.accountById(accountId);
      const planEntitled=a.plan_expires>this.now()&&JSON.parse(a.models).includes(model);
      if((!planEntitled&&a.prepaid===0)||!this.models.some(m=>m.id===model&&m.metered===true)) fail(403,'model_not_entitled','This model requires an active plan or redeemed RCH credit.');
      if(a.debt>0) fail(402,'usage_debt','An earlier request exceeded its allowance; account reconciliation is required.');
      if((planEntitled?a.included:0)+a.prepaid<amount) fail(402,'allowance_exhausted','Not enough shared allowance for this request.');
      const ri=previous?.id||id(),inc=planEntitled?Math.min(a.included,amount):0,pre=amount-inc;
      this.db.prepare('UPDATE accounts SET included=included-?,prepaid=prepaid-? WHERE id=?').run(inc,pre,accountId);
      this.db.prepare("INSERT INTO reservations(id,account_id,request_id,model,fingerprint,amount,held_included,held_prepaid,plan_version,status,created) VALUES(?,?,?,?,?,?,?,?,?,'reserved',?) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount,held_included=excluded.held_included,held_prepaid=excluded.held_prepaid,plan_version=excluded.plan_version,status='reserved',created=excluded.created,reason=NULL").run(ri,accountId,requestId,model,fingerprint,amount,inc,pre,a.plan_version,this.now());
      return {id:ri,status:'reserved',replay:null,fresh:true};
    });
  }
  reserveUsd(accountId,requestId,model,fingerprint,limits) {
    const route=this.models.find(m=>m.id===model&&m.metered===true),pricing=modelUsdPricing(route);
    if(!pricing)fail(403,'model_not_entitled','This model has no verified usage price.');
    const amount=usdUsageCost(pricing,limits);
    if(amount===0||typeof requestId!=='string'||!requestId.length||requestId.length>128)fail(400,'invalid_reservation','Invalid request reservation.');
    return this.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM request_reservations WHERE account_id=? AND request_id=?').get(accountId,requestId))fail(409,'idempotency_conflict','Request ID has already been used for different input.');
      const previous=this.db.prepare('SELECT * FROM reservations WHERE account_id=? AND request_id=?').get(accountId,requestId);
      if(previous){
        if(previous.fingerprint!==fingerprint||previous.model!==model||previous.currency!=='USD')fail(409,'idempotency_conflict','Request ID has already been used for different input.');
        if(previous.status!=='released')return{id:previous.id,status:previous.status,replay:previous.replay?JSON.parse(previous.replay):null,fresh:false};
      }
      const a=this.accountById(accountId);
      if(a.usd_debt>0)fail(402,'usage_debt','An earlier request exceeded its credit; account reconciliation is required.');
      if(a.usd_prepaid<amount)fail(402,'allowance_exhausted','Not enough USD credit for this request.');
      const ri=previous?.id||id();
      this.db.prepare('UPDATE accounts SET usd_prepaid=usd_prepaid-? WHERE id=?').run(amount,accountId);
      this.db.prepare("INSERT INTO reservations(id,account_id,request_id,model,fingerprint,amount,held_included,held_prepaid,plan_version,status,created,currency,pricing_json) VALUES(?,?,?,?,?,?,0,0,NULL,'reserved',?,'USD',?) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount,status='reserved',created=excluded.created,pricing_json=excluded.pricing_json,reason=NULL,usage=NULL,replay=NULL").run(ri,accountId,requestId,model,fingerprint,amount,this.now(),JSON.stringify(pricing));
      return{id:ri,status:'reserved',replay:null,fresh:true};
    });
  }
  settle(reservationId,usage,responseRecord=null) {
    if(!safeCount(usage?.totalTokens)||!safeCount(usage?.promptTokens)||!safeCount(usage?.completionTokens)||usage.totalTokens!==usage.promptTokens+usage.completionTokens) fail(400,'invalid_usage','Measured usage is invalid.');
    return this.transaction(()=>{
      const r=this.db.prepare('SELECT * FROM reservations WHERE id=?').get(reservationId);if(!r) fail(404,'reservation_missing','Reservation not found.');
      if(r.status==='settled') return; if(!['reserved','uncertain'].includes(r.status)) fail(409,'reservation_closed','Reservation is closed.');
      if(r.currency==='USD'){
        const a=this.accountById(r.account_id),actual=usdUsageCost(JSON.parse(r.pricing_json),usage),delta=r.amount-actual;
        const available=a.usd_prepaid+delta,debt=a.usd_debt+Math.max(0,-available);
        if(!safeCount(Math.max(0,available))||!safeCount(debt))fail(409,'credit_limit','Account credit limit requires reconciliation.');
        this.db.prepare('UPDATE accounts SET usd_prepaid=?,usd_debt=? WHERE id=?').run(Math.max(0,available),debt,a.id);
        const replay=responseRecord?JSON.stringify(responseRecord):null;
        this.db.prepare("UPDATE reservations SET status='settled',usage=?,replay=?,reason=NULL WHERE id=?").run(JSON.stringify({...usage,chargedUsdMicros:actual}),replay&&Buffer.byteLength(replay)<=1048576?replay:null,r.id);
        return;
      }
      const a=this.accountById(r.account_id),actual=usage.totalTokens;
      let included=a.included,prepaid=a.prepaid,debt=a.debt;
      if(actual<=r.amount) {
        const usedInc=Math.min(actual,r.held_included),usedPre=Math.max(0,actual-r.held_included);
        if(a.plan_version===r.plan_version&&a.plan_expires>this.now()) included+=r.held_included-usedInc;
        prepaid+=r.held_prepaid-usedPre;
      } else {
        let over=actual-r.amount;const planEntitled=a.plan_expires>this.now()&&a.plan_version===r.plan_version&&JSON.parse(a.models).includes(r.model);
        const inc=planEntitled?Math.min(over,included):0;included-=inc;over-=inc;const pre=Math.min(over,prepaid);prepaid-=pre;over-=pre;debt+=over;
      }
      this.db.prepare('UPDATE accounts SET included=?,prepaid=?,debt=? WHERE id=?').run(included,prepaid,debt,a.id);
      const replay=responseRecord?JSON.stringify(responseRecord):null;
      this.db.prepare("UPDATE reservations SET status='settled',usage=?,replay=?,reason=NULL WHERE id=?").run(JSON.stringify(usage),replay&&Buffer.byteLength(replay)<=1_048_576?replay:null,r.id);
    });
  }
  markUncertain(reservationId,reason='usage_unavailable') { this.db.prepare("UPDATE reservations SET status='uncertain',reason=? WHERE id=? AND status='reserved'").run(String(reason).slice(0,200),reservationId); }
  release(reservationId,reason='not_dispatched') {
    return this.transaction(()=>{const r=this.db.prepare('SELECT * FROM reservations WHERE id=?').get(reservationId);if(!r||r.status==='released')return;if(r.status!=='reserved')fail(409,'reservation_closed','Cannot release a dispatched or settled reservation.');const a=this.accountById(r.account_id);
      if(r.currency==='USD'){if(!safeCount(a.usd_prepaid+r.amount))fail(409,'credit_limit','Account credit limit requires reconciliation.');this.db.prepare('UPDATE accounts SET usd_prepaid=usd_prepaid+? WHERE id=?').run(r.amount,a.id);}
      else this.db.prepare('UPDATE accounts SET included=included+?,prepaid=prepaid+? WHERE id=?').run(a.plan_version===r.plan_version&&a.plan_expires>this.now()?r.held_included:0,r.held_prepaid,a.id);
      this.db.prepare("UPDATE reservations SET status='released',reason=? WHERE id=?").run(reason,r.id);});
  }
  createMarketRedemption(accountId,amount,quote) {
    return this.transaction(()=>{
      const a=this.accountById(accountId),payload=marketQuotePayload(amount,quote,this.now(),a.wallet);
      const promised=this.db.prepare('SELECT COALESCE(SUM(usd_micros),0) AS amount FROM redemptions WHERE account_id=?').get(accountId).amount;
      if(promised+quote.creditUsdMicros>quote.creditBudgetUsdMicros)fail(402,'redemption_budget_exhausted','The market redemption credit budget has been reached.');
      const redemptionId='0x'+id(),ticket=id(),expires=quote.expiresAtMs;
      this.db.prepare('INSERT INTO redemptions(id,account_id,wallet,amount,usage_tokens,ticket_hash,expires,created,usd_micros,quote_json) VALUES(?,?,?,?,0,?,?,?,?,?)').run(redemptionId,accountId,a.wallet,amount,digest(ticket),expires,this.now(),quote.creditUsdMicros,payload);
      return{redemptionId,ticket,expiresAt:new Date(expires).toISOString()};
    });
  }
  createRedemption(accountId,amount,usageTokens) {
    if(!safeCount(usageTokens)||usageTokens===0)fail(400,'invalid_redemption','Invalid usage conversion.');
    const a=this.accountById(accountId);
    const redemptionId='0x'+id(),ticket=id(),expires=this.now()+900_000;
    this.db.prepare('INSERT INTO redemptions(id,account_id,wallet,amount,usage_tokens,ticket_hash,expires,created) VALUES(?,?,?,?,?,?,?,?)').run(redemptionId,accountId,a.wallet,amount,usageTokens,digest(ticket),expires,this.now());
    return {redemptionId,ticket,expiresAt:new Date(expires).toISOString()};
  }
  getRedemption(redemptionId,ticket) { const r=this.db.prepare('SELECT * FROM redemptions WHERE id=?').get(redemptionId);if(!r||!equal(r.ticket_hash,digest(ticket||'')))fail(404,'redemption_missing','Redemption is unavailable.');return r; }
  submitRedemption(redemptionId,ticket,txHash) {
    if(!/^0x[a-fA-F0-9]{64}$/.test(txHash||''))fail(400,'invalid_transaction','Invalid transaction hash.');
    const r=this.getRedemption(redemptionId,ticket);
    if(r.tx_hash&&r.tx_hash.toLowerCase()!==txHash.toLowerCase())fail(409,'transaction_conflict','This redemption already has a transaction.');
    this.db.prepare("UPDATE redemptions SET tx_hash=?,status=CASE WHEN status='credited' THEN status ELSE 'pending' END WHERE id=?").run(txHash.toLowerCase(),redemptionId);return this.db.prepare('SELECT * FROM redemptions WHERE id=?').get(redemptionId);
  }
  replaceFailedRedemption(redemptionId,ticket,previousTxHash,nextTxHash) {
    if(!/^0x[a-fA-F0-9]{64}$/.test(nextTxHash||''))fail(400,'invalid_transaction','Invalid transaction hash.');
    return this.transaction(()=>{const r=this.getRedemption(redemptionId,ticket);
      if(r.status!=='pending'||r.tx_hash?.toLowerCase()!==previousTxHash?.toLowerCase())fail(409,'transaction_conflict','The pending transaction changed.');
      this.db.prepare('UPDATE redemptions SET tx_hash=? WHERE id=?').run(nextTxHash.toLowerCase(),redemptionId);
      return this.getRedemption(redemptionId,ticket);
    });
  }
  pendingRedemptions(accountId) { return accountId?this.db.prepare("SELECT * FROM redemptions WHERE account_id=? AND tx_hash IS NOT NULL AND status='pending'").all(accountId):this.db.prepare("SELECT * FROM redemptions WHERE tx_hash IS NOT NULL AND status='pending'").all(); }
  creditRedemption(redemptionId,eventKey) {
    return this.transaction(()=>{
      const r=this.db.prepare('SELECT * FROM redemptions WHERE id=?').get(redemptionId);if(!r)fail(404,'redemption_missing','Unknown redemption.');if(r.status==='credited'){if(r.event_key!==eventKey)fail(409,'event_conflict','Redemption already credited from a different event.');return;}
      if(r.status!=='pending'||!r.tx_hash||typeof eventKey!=='string'||!eventKey)fail(409,'redemption_not_pending','A verified pending transaction is required.');
      if(this.db.prepare('SELECT id FROM redemptions WHERE event_key=?').get(eventKey))fail(409,'event_conflict','This event has already credited a different redemption.');
      if(r.usd_micros>0){
        const a=this.accountById(r.account_id),debtPaid=Math.min(a.usd_debt,r.usd_micros),credit=r.usd_micros-debtPaid;
        if(!safeCount(a.usd_prepaid+credit))fail(409,'credit_limit','Account credit limit requires reconciliation.');
        this.db.prepare('UPDATE accounts SET usd_prepaid=usd_prepaid+?,usd_debt=usd_debt-? WHERE id=?').run(credit,debtPaid,a.id);
        this.db.prepare("UPDATE redemptions SET status='credited',event_key=? WHERE id=?").run(eventKey,r.id);return;
      }
      const a=this.accountById(r.account_id),debtPaid=Math.min(a.debt,r.usage_tokens),credit=r.usage_tokens-debtPaid;
      if(!safeCount(a.prepaid+credit))fail(409,'credit_limit','Account credit limit requires reconciliation.');
      this.db.prepare('UPDATE accounts SET prepaid=prepaid+?,debt=debt-? WHERE id=?').run(credit,debtPaid,a.id);
      this.db.prepare("UPDATE redemptions SET status='credited',event_key=? WHERE id=?").run(eventKey,r.id);
    });
  }
}
