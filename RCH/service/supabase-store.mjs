import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { getAddress } from 'ethers';
import { AccountError, digest, fail, marketQuotePayload, modelUsdPricing, usdUsageCost, requestBillingPolicy, requestModel, requestReplay, basicPlanModelIds } from './store.mjs';
import { normalizePayment, paymentFingerprint, grantIdFor, publicPayment, reviewPayment,
  normalizeReversal, reversalFingerprint, publicReversal, reviewReversal } from './payments/core.mjs';

const id = () => randomBytes(32).toString('hex');
const safeCount = n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000_000;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ERRORS = {
  account_missing: [401, 'Account is unavailable.'], invalid_grant: [400, 'Invalid plan grant, qualified model list, allowance, or expiry.'],
  grant_conflict: [409, 'Grant ID was already used with different values.'], invalid_flow: [400, 'Invalid sign-in flow.'],
  flow_expired: [410, 'Sign-in expired. Start again in Studio.'], flow_verified: [409, 'Sign-in has already been verified.'],
  invalid_challenge: [400, 'Invalid challenge.'], challenge_expired: [410, 'This sign-in challenge is no longer valid.'],
  invalid_proof: [401, 'The sign-in proof does not match.'], session_expired: [401, 'Your REACH session expired. Connect your wallet again.'],
  invalid_reservation: [400, 'Invalid request reservation.'], idempotency_conflict: [409, 'Request ID has already been used for different input.'],
  model_not_entitled: [403, 'This model requires an active REACH plan.'], usage_debt: [402, 'An earlier request exceeded its allowance; account reconciliation is required.'],
  allowance_exhausted: [402, 'Not enough shared allowance for this request.'], invalid_usage: [400, 'Measured usage is invalid.'],
  reservation_missing: [404, 'Reservation not found.'], reservation_closed: [409, 'Reservation is closed.'],
  invalid_redemption: [400, 'Invalid usage conversion.'], plan_required: [403, 'An active plan is required to redeem usage credit.'],
  redemption_missing: [404, 'Redemption is unavailable.'], invalid_transaction: [400, 'Invalid transaction hash.'],
  transaction_conflict: [409, 'This redemption already has a different transaction.'],
  redemption_not_pending: [409, 'A verified pending transaction is required.'], event_conflict: [409, 'This event has already credited a different redemption.'],
  credit_limit: [409, 'Account credit limit requires reconciliation.'],
  redemption_budget_exhausted: [402, 'The market redemption credit budget has been reached.'],
  import_target_not_empty: [409, 'The shared account store must be empty before importing a snapshot.'],
  invalid_import: [400, 'The account snapshot is invalid. No records were imported.'],
  invalid_replay: [400, 'A completed request requires a valid bounded replay record.'],
  invalid_payment: [400, 'Invalid payment record.'],
  payment_conflict: [409, 'This payment was already recorded with different values.'],
  subscription_unconfigured: [409, 'Request subscriptions are not configured on this service.'],
};
const SNAPSHOT_TABLES = ['accounts', 'flows', 'challenges', 'sessions', 'grants', 'reservations', 'redemptions'];
const unavailable = () => new AccountError(503, 'account_store_unavailable', 'The shared account store is temporarily unavailable.');

// This adapter is server-only. Browser/Studio clients use the authenticated
// account service; they never receive a Supabase credential or mutate balances.
export class SupabaseAccountStore {
  #secretKey;
  constructor({ url, secretKey, models = [], subscription, now = () => Date.now(), fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    let endpoint;
    try { endpoint = new URL(url); } catch { throw new Error('Configure a valid Supabase project URL.'); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
      || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
      throw new Error('Supabase requires an HTTPS project origin, or loopback HTTP for local tests.');
    }
    let legacy = false;
    try { legacy = JSON.parse(Buffer.from(String(secretKey).split('.')[1], 'base64url')).role === 'service_role'; } catch { /* opaque secret */ }
    if (typeof secretKey !== 'string' || /[\r\n]/.test(secretKey)
      || !(secretKey.startsWith('sb_secret_') && secretKey.length >= 24 || legacy)) throw new Error('Configure a server-only Supabase secret or service_role key.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid Supabase request timeout.');
    this.endpoint = `${endpoint.origin}/rest/v1/rpc/reach_account_store`;
    this.#secretKey = secretKey;
    this.legacyKey = legacy;
    this.models = models;
    this.subscription = requestBillingPolicy(subscription);
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  async close() {}
  async _rpc(operation, payload = {}, endpoint = this.endpoint) {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw unavailable();
    try {
      const headers = { 'content-type': 'application/json', apikey: this.#secretKey };
      if (this.legacyKey) headers.authorization = `Bearer ${this.#secretKey}`;
      // Never retry an ambiguous mutation automatically: the server may have
      // committed before the connection failed. Stable IDs allow reconciliation.
      const response = await this.fetchImpl(endpoint, { method: 'POST', headers, redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs), body: JSON.stringify({ p_operation: operation, p_payload: { ...payload, now } }) });
      let data;
      try { data = await response.json(); } catch { throw unavailable(); }
      if (!response.ok) {
        const known = data?.code === 'P0001' && Object.hasOwn(ERRORS, data.message) ? ERRORS[data.message] : null;
        if (known) throw new AccountError(known[0], data.message, known[1]);
        throw unavailable();
      }
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, 'result')) throw unavailable();
      return data.result;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      // Fetch errors and PostgREST diagnostics may echo URLs, headers, payloads,
      // or SQL internals. No provider error text crosses the service boundary.
      throw unavailable();
    }
  }
  _paymentRpc(operation, payload = {}) {
    return this._rpc(operation, { ...payload, subscription: this.subscription }, this.endpoint.replace(/reach_account_store$/, 'reach_payment_store'));
  }
  _requestRpc(operation, payload = {}) {
    return this._rpc(operation, { ...payload, subscription: this.subscription }, this.endpoint.replace(/reach_account_store$/, 'reach_request_store'));
  }
  async _view(snapshot) {
    const a = snapshot.account, active = a.plan_expires > this.now(), allowed = JSON.parse(a.models);
    let request = null;
    if (this.subscription) try { request = await this._requestRpc('request_allowance', { accountId: a.id }); }
    catch {
      // Authentication exchange already committed its single-use proof. Deliver
      // the session, but disable model access until the quota read recovers.
      request = { unavailable: true, reservedUsdMicros: 0, allowance: { status: 'unavailable',
        includedLimit: 0, completed: 0, reserved: 0, remaining: 0, periodEndsAt: null,
        overageUsdMicrosPerRequest: this.subscription.overageUsdMicrosPerRequest, basicActive: false } };
    }
    return { id: a.id, walletAddress: a.wallet,
      plan: { id: a.plan_id, name: a.plan_name, status: active ? 'active' : a.plan_id ? 'expired' : 'none', expiresAt: a.plan_expires ? new Date(a.plan_expires).toISOString() : null },
      allowedModels: this.models.filter(m => request?.unavailable ? false : m.access === 'requests' ? requestModel(m) && !!this.subscription && (request.allowance.basicActive || a.usd_prepaid > 0)
        : m.metered === true && (a.usd_prepaid > 0 && modelUsdPricing(m) || a.prepaid > 0 || active && allowed.includes(m.id))).map(m => ({ id: m.id, name: m.name || m.id, provider: m.provider, ...(requestModel(m) ? { access: 'requests', pricing: { unit: 'request', includedRequests: this.subscription.basic.includedRequests, usdMicrosPerRequest: this.subscription.overageUsdMicrosPerRequest }, capabilities: { outputTokenLimit: false } } : modelUsdPricing(m) ? { pricing: { ...m.pricing } } : {}) })),
      allowance: { includedRemaining: active ? a.included : 0, prepaidRemaining: a.prepaid, reserved: snapshot.reserved,
        totalRemaining: a.debt === 0 ? (active ? a.included : 0) + a.prepaid : 0, debt: a.debt },
      credit: { currency: 'USD', balanceMicros: a.usd_prepaid ?? 0, reservedMicros: (snapshot.reservedUsdMicros ?? 0) + (request?.reservedUsdMicros ?? 0), debtMicros: a.usd_debt ?? 0 },
      ...(request ? { requestAllowance: request.allowance } : {}) };
  }
  async pruneExpiredAuthentication() { await this._rpc('prune_auth'); }
  async importSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || Object.keys(snapshot).length !== SNAPSHOT_TABLES.length
      || !SNAPSHOT_TABLES.every(table => Array.isArray(snapshot[table])
        && snapshot[table].every(row => row && typeof row === 'object' && !Array.isArray(row)))) {
      fail(400, 'invalid_import', ERRORS.invalid_import[1]);
    }
    return this._rpc('import_snapshot', { snapshot });
  }
  async accountById(accountId) { return this._rpc('account_by_id', { accountId }); }
  async findAccountByWallet(wallet) { return this._rpc('find_account', { wallet: getAddress(wallet) }); }
  async ensureAccount(wallet) { return this._rpc('ensure_account', { wallet: getAddress(wallet), accountId: id() }); }
  async account(accountId) { return this._view(await this._rpc('account', { accountId })); }
  async grantPlan({ wallet, grantId, planId, name, models, tokens, expiresAt }) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(grantId || '') || !planId || typeof name !== 'string' || !safeCount(tokens)
      || !Array.isArray(models) || !models.length || !models.every(m => this.models.some(x => x.id === m && (x.metered === true || this.subscription && requestModel(x))))
      || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) fail(400, 'invalid_grant', ERRORS.invalid_grant[1]);
    wallet = getAddress(wallet);
    const payload = JSON.stringify({ wallet, planId, name, models: [...models].sort(), tokens, expiresAt });
    return this._view(await this._rpc('grant_plan', { wallet, grantId, planId, name, models, tokens, expiresAt, payload, accountId: id() }));
  }
  // ---- payments: the same provider-neutral ledger as the SQLite store ----
  // The rules run in one Postgres function so the ledger row and its effect
  // commit together. Business-rule failures come back as a recorded status.
  async applyPayment(raw) {
    const payment = normalizePayment(raw);
    let models;
    if (payment.kind === 'subscription_period') {
      if (!this.subscription) fail(409, 'subscription_unconfigured', ERRORS.subscription_unconfigured[1]);
      models = basicPlanModelIds(this.models);
      if (!models.length) fail(409, 'no_qualified_models', 'No qualified request models are configured for the plan grant.');
    }
    return this._paymentRpc('apply_payment', { ...payment, paymentId: id(), fingerprint: paymentFingerprint(payment),
      grantId: grantIdFor(payment), ...(models ? { models } : {}) });
  }
  async listPayments(accountId, limit = 50) { return (await this._paymentRpc('list_payments', { accountId, limit })).map(publicPayment); }
  async flaggedPayments() { return (await this._paymentRpc('flagged_payments')).map(reviewPayment); }
  _reversalRpc(operation, payload = {}) {
    return this._rpc(operation, payload, this.endpoint.replace(/reach_account_store$/, 'reach_payment_reversal_store'));
  }
  // Same contract as the SQLite store: null when the original is not ours.
  async applyReversal(raw) {
    const reversal = normalizeReversal(raw);
    return this._reversalRpc('apply_reversal', { ...reversal, reversalId: id(), fingerprint: reversalFingerprint(reversal) });
  }
  async listReversals(accountId, limit = 50) { return (await this._reversalRpc('list_reversals', { accountId, limit })).map(publicReversal); }
  async flaggedReversals() { return (await this._reversalRpc('flagged_reversals')).map(reviewReversal); }
  async startFlow(state, challenge) {
    if (typeof state !== 'string' || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) fail(400, 'invalid_flow', 'Invalid sign-in state or proof key.');
    return this._rpc('start_flow', { flowId: id(), stateHash: digest(state), challenge });
  }
  async getFlow(flowId) {
    if (typeof flowId !== 'string' || !/^[a-f0-9]{64}$/.test(flowId)) fail(400, 'invalid_flow', 'Invalid sign-in flow.');
    return this._rpc('get_flow', { flowId });
  }
  async challenge(flowId, wallet, makeMessage) {
    const f = await this.getFlow(flowId);
    if (f.account_id) fail(409, 'flow_verified', 'Sign-in has already been verified.');
    wallet = getAddress(wallet);
    const now = this.now(), expires = Math.min(f.expires, now + 300000), challengeId = id();
    const message = makeMessage(wallet, id(), new Date(now).toISOString(), new Date(expires).toISOString());
    return this._rpc('create_challenge', { flowId, challengeId, wallet, message, expires });
  }
  async getChallenge(flowId, challengeId) {
    if (typeof challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(challengeId)) fail(400, 'invalid_challenge', 'Invalid challenge.');
    return this._rpc('get_challenge', { flowId, challengeId });
  }
  async authorize(flowId, challengeId) { return this._rpc('authorize', { flowId, challengeId, accountId: id() }); }
  async exchange(flowId, state, verifier) {
    const f = await this.getFlow(flowId);
    if (typeof state !== 'string' || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
      || !equal(f.state_hash, digest(state)) || !equal(f.challenge, createHash('sha256').update(verifier).digest('base64url'))) fail(401, 'invalid_proof', 'The sign-in proof does not match.');
    const token = 'rch_session_' + id();
    const result = await this._rpc('exchange', { flowId, stateHash: digest(state), challenge: createHash('sha256').update(verifier).digest('base64url'), sessionHash: digest(token) });
    return result ? { accessToken: token, expiresAt: result.expiresAt, account: await this._view(result.snapshot) } : null;
  }
  async authenticate(token) {
    if (typeof token !== 'string' || !/^rch_session_[a-f0-9]{64}$/.test(token)) fail(401, 'session_required', 'Connect your wallet to REACH.');
    return this._view(await this._rpc('authenticate', { sessionHash: digest(token) }));
  }
  async logout(token) { await this._rpc('logout', { sessionHash: digest(token) }); }
  async reserve(accountId, requestId, model, fingerprint, amount) {
    if (!safeCount(amount) || amount === 0 || typeof requestId !== 'string' || requestId.length > 128) fail(400, 'invalid_reservation', 'Invalid request reservation.');
    return this._rpc('reserve', { accountId, requestId, model, fingerprint, amount, reservationId: id(), modelQualified: this.models.some(m => m.id === model && m.metered === true) });
  }
  async settle(reservationId, usage, responseRecord = null) {
    if (!safeCount(usage?.totalTokens) || !safeCount(usage?.promptTokens) || !safeCount(usage?.completionTokens)
      || usage.totalTokens !== usage.promptTokens + usage.completionTokens) fail(400, 'invalid_usage', 'Measured usage is invalid.');
    const replay = responseRecord ? JSON.stringify(responseRecord) : null;
    await this._rpc('settle', { reservationId, usage, replay: replay && Buffer.byteLength(replay) <= 1048576 ? replay : null });
  }
  async reserveUsd(accountId, requestId, model, fingerprint, limits) {
    const route = this.models.find(m => m.id === model && m.metered === true), pricing = modelUsdPricing(route);
    if (!pricing) fail(403, 'model_not_entitled', 'This model has no verified usage price.');
    const amount = usdUsageCost(pricing, limits);
    if (amount === 0 || typeof requestId !== 'string' || !requestId.length || requestId.length > 128) fail(400, 'invalid_reservation', 'Invalid request reservation.');
    return this._rpc('reserve_usd', { accountId, requestId, model, fingerprint, amount, pricing, limits, reservationId: id(), modelQualified: true });
  }
  async requestAllowance(accountId) { return (await this._requestRpc('request_allowance', { accountId })).allowance; }
  async reserveRequest(accountId, requestId, model, fingerprint) {
    if (!this.subscription || !this.models.some(m => m.id === model && requestModel(m))) fail(403, 'model_not_entitled', 'This model is not available for request access.');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(requestId) || typeof fingerprint !== 'string' || !fingerprint.length || fingerprint.length > 128) fail(400, 'invalid_reservation', 'Invalid request reservation.');
    return this._requestRpc('reserve_request', { accountId, requestId, model, fingerprint, reservationId: id(), modelQualified: true });
  }
  async settleRequest(reservationId, responseRecord) { await this._requestRpc('settle_request', { reservationId, replay: requestReplay(responseRecord) }); }
  async releaseRequest(reservationId) { await this._requestRpc('release_request', { reservationId }); }
  async markRequestUncertain(reservationId, reason = 'completion_unknown') { await this._requestRpc('mark_request_uncertain', { reservationId, reason: String(reason).slice(0, 200) }); }
  async markUncertain(reservationId, reason = 'usage_unavailable') { await this._rpc('mark_uncertain', { reservationId, reason: String(reason).slice(0, 200) }); }
  async release(reservationId, reason = 'not_dispatched') { await this._rpc('release', { reservationId, reason }); }
  async unsettledReservations(accountId) {
    const legacy = await this._rpc('unsettled_reservations', { accountId: accountId || null });
    const requests = this.subscription ? await this._requestRpc('unsettled_requests', { accountId: accountId || null }) : [];
    return [...legacy, ...requests].sort((a, b) => a.created - b.created);
  }
  async createRedemption(accountId, amount, usageTokens) {
    if (!safeCount(usageTokens) || usageTokens === 0) fail(400, 'invalid_redemption', 'Invalid usage conversion.');
    const redemptionId = '0x' + id(), ticket = id();
    const result = await this._rpc('create_redemption', { accountId, amount, usageTokens, redemptionId, ticketHash: digest(ticket) });
    return { ...result, ticket };
  }
  async createMarketRedemption(accountId, amount, quote) {
    const account = await this.accountById(accountId);
    const quoteJson = marketQuotePayload(amount, quote, this.now(), account.wallet);
    const redemptionId = '0x' + id(), ticket = id();
    const result = await this._rpc('create_market_redemption', { accountId, amount, quote: JSON.parse(quoteJson), redemptionId, ticketHash: digest(ticket) });
    return { ...result, ticket };
  }
  async getRedemption(redemptionId, ticket) { return this._rpc('get_redemption', { redemptionId, ticketHash: digest(ticket || '') }); }
  async submitRedemption(redemptionId, ticket, txHash) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) fail(400, 'invalid_transaction', 'Invalid transaction hash.');
    return this._rpc('submit_redemption', { redemptionId, ticketHash: digest(ticket || ''), txHash: txHash.toLowerCase() });
  }
  async replaceFailedRedemption(redemptionId, ticket, previousTxHash, nextTxHash) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(nextTxHash || '')) fail(400, 'invalid_transaction', 'Invalid transaction hash.');
    return this._rpc('replace_redemption', { redemptionId, ticketHash: digest(ticket || ''), previousTxHash: previousTxHash?.toLowerCase(), nextTxHash: nextTxHash.toLowerCase() });
  }
  async pendingRedemptions(accountId) { return this._rpc('pending_redemptions', { accountId: accountId || null }); }
  async creditRedemption(redemptionId, eventKey) { await this._rpc('credit_redemption', { redemptionId, eventKey }); }
}
