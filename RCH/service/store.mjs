import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress } from 'ethers';

export class AccountError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new AccountError(status, code, message); };
export const digest = value => createHash('sha256').update(value).digest('hex');
const id = () => randomBytes(32).toString('hex');
const safeCount = n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000_000;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class AccountStore {
  constructor(path, { now = () => Date.now(), models = [] } = {}) {
    this.now = now; this.models = models;
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
    `);
  }
  close() { this.db.close(); }
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
    const reserved = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM reservations WHERE account_id=? AND status IN ('reserved','uncertain')").get(accountId).n;
    const allowed = JSON.parse(a.models);
    return { id:a.id, walletAddress:a.wallet, plan:{ id:a.plan_id, name:a.plan_name, status:active?'active':a.plan_id?'expired':'none', expiresAt:a.plan_expires?new Date(a.plan_expires).toISOString():null }, allowedModels:active?this.models.filter(m=>m.metered===true && allowed.includes(m.id)).map(({id,name,provider})=>({id,name:name||id,provider})):[], allowance:{ includedRemaining:active?a.included:0, prepaidRemaining:a.prepaid, reserved, totalRemaining:active&&a.debt===0?a.included+a.prepaid:0, debt:a.debt } };
  }
  grantPlan({wallet,grantId,planId,name,models,tokens,expiresAt}) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(grantId||'') || !planId || typeof name!=='string' || !safeCount(tokens) || !Array.isArray(models) || !models.length || !models.every(m=>this.models.some(x=>x.id===m&&x.metered===true)) || !Number.isSafeInteger(expiresAt) || expiresAt<=this.now()) fail(400,'invalid_grant','Invalid plan grant, qualified model list, allowance, or expiry.');
    const payload = JSON.stringify({wallet:getAddress(wallet),planId,name,models:[...models].sort(),tokens,expiresAt});
    return this.transaction(()=>{
      const prev=this.db.prepare('SELECT * FROM grants WHERE id=?').get(grantId);
      if(prev) { if(prev.payload!==payload) fail(409,'grant_conflict','Grant ID was already used with different values.'); return this.account(prev.account_id); }
      const a=this.ensureAccount(wallet);
      this.db.prepare('UPDATE accounts SET plan_id=?,plan_name=?,plan_expires=?,plan_version=?,models=?,included=? WHERE id=?').run(planId,name,expiresAt,grantId,JSON.stringify(models),tokens,a.id);
      this.db.prepare('INSERT INTO grants VALUES(?,?,?)').run(grantId,a.id,payload);
      return this.account(a.id);
    });
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
      const previous=this.db.prepare('SELECT * FROM reservations WHERE account_id=? AND request_id=?').get(accountId,requestId);
      if(previous) {
        if(previous.fingerprint!==fingerprint||previous.model!==model) fail(409,'idempotency_conflict','Request ID has already been used for different input.');
        if(previous.status!=='released')return {id:previous.id,status:previous.status,replay:previous.replay?JSON.parse(previous.replay):null,fresh:false};
      }
      const a=this.accountById(accountId);
      if(a.plan_expires<=this.now()||!JSON.parse(a.models).includes(model)||!this.models.some(m=>m.id===model&&m.metered===true)) fail(403,'model_not_entitled','This model requires an active REACH plan.');
      if(a.debt>0) fail(402,'usage_debt','An earlier request exceeded its allowance; account reconciliation is required.');
      if(a.included+a.prepaid<amount) fail(402,'allowance_exhausted','Not enough shared allowance for this request.');
      const ri=previous?.id||id(),inc=Math.min(a.included,amount),pre=amount-inc;
      this.db.prepare('UPDATE accounts SET included=included-?,prepaid=prepaid-? WHERE id=?').run(inc,pre,accountId);
      this.db.prepare("INSERT INTO reservations(id,account_id,request_id,model,fingerprint,amount,held_included,held_prepaid,plan_version,status,created) VALUES(?,?,?,?,?,?,?,?,?,'reserved',?) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount,held_included=excluded.held_included,held_prepaid=excluded.held_prepaid,plan_version=excluded.plan_version,status='reserved',created=excluded.created,reason=NULL").run(ri,accountId,requestId,model,fingerprint,amount,inc,pre,a.plan_version,this.now());
      return {id:ri,status:'reserved',replay:null,fresh:true};
    });
  }
  settle(reservationId,usage,responseRecord=null) {
    if(!safeCount(usage?.totalTokens)||!safeCount(usage?.promptTokens)||!safeCount(usage?.completionTokens)||usage.totalTokens!==usage.promptTokens+usage.completionTokens) fail(400,'invalid_usage','Measured usage is invalid.');
    return this.transaction(()=>{
      const r=this.db.prepare('SELECT * FROM reservations WHERE id=?').get(reservationId);if(!r) fail(404,'reservation_missing','Reservation not found.');
      if(r.status==='settled') return; if(!['reserved','uncertain'].includes(r.status)) fail(409,'reservation_closed','Reservation is closed.');
      const a=this.accountById(r.account_id),actual=usage.totalTokens;
      let included=a.included,prepaid=a.prepaid,debt=a.debt;
      if(actual<=r.amount) {
        const usedInc=Math.min(actual,r.held_included),usedPre=Math.max(0,actual-r.held_included);
        if(a.plan_version===r.plan_version&&a.plan_expires>this.now()) included+=r.held_included-usedInc;
        prepaid+=r.held_prepaid-usedPre;
      } else {
        let over=actual-r.amount;const inc=a.plan_expires>this.now()?Math.min(over,included):0;included-=inc;over-=inc;const pre=Math.min(over,prepaid);prepaid-=pre;over-=pre;debt+=over;
      }
      this.db.prepare('UPDATE accounts SET included=?,prepaid=?,debt=? WHERE id=?').run(included,prepaid,debt,a.id);
      const replay=responseRecord?JSON.stringify(responseRecord):null;
      this.db.prepare("UPDATE reservations SET status='settled',usage=?,replay=?,reason=NULL WHERE id=?").run(JSON.stringify(usage),replay&&Buffer.byteLength(replay)<=1_048_576?replay:null,r.id);
    });
  }
  markUncertain(reservationId,reason='usage_unavailable') { this.db.prepare("UPDATE reservations SET status='uncertain',reason=? WHERE id=? AND status='reserved'").run(String(reason).slice(0,200),reservationId); }
  release(reservationId,reason='not_dispatched') {
    return this.transaction(()=>{const r=this.db.prepare('SELECT * FROM reservations WHERE id=?').get(reservationId);if(!r||r.status==='released')return;if(r.status!=='reserved')fail(409,'reservation_closed','Cannot release a dispatched or settled reservation.');const a=this.accountById(r.account_id);this.db.prepare('UPDATE accounts SET included=included+?,prepaid=prepaid+? WHERE id=?').run(a.plan_version===r.plan_version&&a.plan_expires>this.now()?r.held_included:0,r.held_prepaid,a.id);this.db.prepare("UPDATE reservations SET status='released',reason=? WHERE id=?").run(reason,r.id);});
  }
  createRedemption(accountId,amount,usageTokens) {
    if(!safeCount(usageTokens)||usageTokens===0)fail(400,'invalid_redemption','Invalid usage conversion.');
    const a=this.accountById(accountId);if(a.plan_expires<=this.now())fail(403,'plan_required','An active plan is required to redeem usage credit.');
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
      const a=this.accountById(r.account_id),debtPaid=Math.min(a.debt,r.usage_tokens),credit=r.usage_tokens-debtPaid;
      if(!safeCount(a.prepaid+credit))fail(409,'credit_limit','Account credit limit requires reconciliation.');
      this.db.prepare('UPDATE accounts SET prepaid=prepaid+?,debt=debt-? WHERE id=?').run(credit,debtPaid,a.id);
      this.db.prepare("UPDATE redemptions SET status='credited',event_key=? WHERE id=?").run(eventKey,r.id);
    });
  }
}
