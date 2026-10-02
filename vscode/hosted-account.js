'use strict';

// Only the extension host holds session credentials. The webview receives state().
const crypto = require('node:crypto');
const SECRET = 'simplereach.hostedAccount';
const text = (value, limit = 250) => typeof value === 'string' ? value.slice(0, limit) : '';
const count = value => /^(0|[1-9]\d{0,29})$/.test(String(value)) ? String(value) : null;
function publicRequestAllowance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { basicActive: raw.basicActive === true, periodEndsAt: text(raw.periodEndsAt),
    ...Object.fromEntries(['includedLimit','completed','reserved','remaining','overageUsdMicrosPerRequest'].map(key => [key, count(raw[key])])) };
}
function publicSubscription(raw) {
  if (!raw || typeof raw !== 'object' || !raw.basic) return null;
  return { basic: { id: text(raw.basic.id), includedRequests: count(raw.basic.includedRequests), priceUsdMicros: count(raw.basic.priceUsdMicros) },
    overageUsdMicrosPerRequest: count(raw.overageUsdMicrosPerRequest), proEnabled: false };
}
function publicModels(models) {
  return (Array.isArray(models) ? models : []).slice(0, 500).map(model =>
    typeof model === 'string' ? { id: text(model), name: text(model) }
      : { id: text(model?.id), name: text(model?.name),
        ...(model?.access === 'requests' && model.pricing?.unit === 'request'
          ? { access: 'requests', provider: text(model.provider), pricing: { unit: 'request', includedRequests: count(model.pricing.includedRequests), usdMicrosPerRequest: count(model.pricing.usdMicrosPerRequest) },
            ...(model.capabilities?.outputTokenLimit === false ? { capabilities: { outputTokenLimit: false } } : {}) } : {}),
        ...(model?.access !== 'requests' && model?.pricing && ['inputUsdMicrosPerMillion', 'outputUsdMicrosPerMillion'].every(key => count(model.pricing[key]) !== null)
          ? { provider: text(model.provider), pricing: Object.fromEntries(['inputUsdMicrosPerMillion', 'outputUsdMicrosPerMillion', 'cachedInputUsdMicrosPerMillion']
            .filter(key => model.pricing[key] != null && count(model.pricing[key]) !== null).map(key => [key, count(model.pricing[key])])) } : {}) }).filter(model => model.id);
}
function serviceUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter the hosted REACH service URL.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use an HTTPS service origin, or localhost HTTP, without paths or credentials.');
  }
  return url.origin;
}
function browserUrl(value, origin) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The service returned an invalid browser URL.'); }
  if (url.origin !== origin || url.username || url.password) throw new Error('The service returned a browser URL outside its configured origin.');
  return url.href;
}
// Stripe's Checkout and billing portal are the only pages opened outside the
// service origin, each only on its own exact Stripe origin.
const CHECKOUT_ORIGIN = 'https://checkout.stripe.com', PORTAL_ORIGIN = 'https://billing.stripe.com';
function stripePage(value, origin, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The service returned an invalid payment page.'); }
  if (url.origin !== origin || url.username || url.password) throw new Error(`The service returned a payment page outside ${name}.`);
  return url.href;
}
const checkoutUrl = value => stripePage(value, CHECKOUT_ORIGIN, 'Stripe Checkout');
const portalUrl = value => stripePage(value, PORTAL_ORIGIN, 'the Stripe billing portal');
// PayPal's own sign-in pages, fixed here rather than taken from the service.
const PAYPAL_ORIGINS = ['https://www.paypal.com', 'https://www.sandbox.paypal.com'];
function paypalUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The service returned an invalid payment page.'); }
  if (!PAYPAL_ORIGINS.includes(url.origin) || url.username || url.password) throw new Error('The service returned a payment page outside PayPal.');
  return url.href;
}
// Whole dollars or cents only, converted without floating point.
function topUpMicros(value) {
  const match = /^\$?([1-9]\d{0,2})(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  const micros = match ? Number(match[1]) * 1_000_000 + Number((match[2] || '').padEnd(2, '0')) * 10_000 : 0;
  if (micros < 1_000_000 || micros > 500_000_000) throw new Error('Enter a dollar amount between 1 and 500, for example 20 or 12.50.');
  return micros;
}
function publicAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const plan = raw.plan || {}, allowance = raw.allowance || {}, balance = raw.rchBalance || {};
  return {
    walletAddress: /^0x[0-9a-f]{40}$/i.test(raw.walletAddress) ? raw.walletAddress : '',
    email: (typeof raw.email === 'string' && raw.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(raw.email) ? raw.email : ''),
    plan: { name: text(plan.name), status: text(plan.status), expiresAt: text(plan.expiresAt) },
    allowedModels: publicModels(raw.allowedModels),
    ...(raw.requestAllowance ? { requestAllowance: publicRequestAllowance(raw.requestAllowance) } : {}),
    allowance: Object.fromEntries(['includedRemaining', 'prepaidRemaining', 'reserved', 'totalRemaining', 'debt'].map(key => [key, count(allowance[key])])),
    ...(raw.credit?.currency === 'USD' ? { credit: { currency: 'USD', ...Object.fromEntries(['balanceMicros','reservedMicros','debtMicros'].map(key => [key,count(raw.credit[key])])) } } : {}),
    rchBalance: { status: ['available', 'unavailable', 'unconfigured'].includes(balance.status) ? balance.status : 'unconfigured',
      decimals: balance.decimals === 18 ? 18 : null,
      balanceBaseUnits: balance.status === 'available' && balance.decimals === 18 ? count(balance.balanceBaseUnits) : null },
  };
}
function publicConfig(raw) {
  return { enabled: raw?.enabled === true, redemptionEnabled: raw?.redemptionEnabled === true,
    tokensPerRch: count(raw?.tokensPerRch), chainId: Number.isSafeInteger(raw?.chainId) ? raw.chainId : null,
    redemptionModels: publicModels(raw?.redemptionModels), cardPayments: raw?.cardPayments === true, paypalPayments: raw?.paypalPayments === true, emailLogin: raw?.emailLogin === true,
    ...(raw?.subscription ? { subscription: publicSubscription(raw.subscription) } : {}) };
}
function createHostedAccount({ secrets, openExternal, onChange = () => {}, fetchImpl = globalThis.fetch, now = Date.now }) {
  let baseUrl = '', session = null, account = null, config = null, flow = null;
  let phase = 'unconfigured', error = '', generation = 0, loading, polling = false;
  let persistence = Promise.resolve();
  const secure = !!(secrets?.get && secrets?.store && secrets?.delete);
  const state = () => ({ status: session && Date.parse(session.expiresAt) <= now() ? 'expired' : phase,
    baseUrl, account: session && Date.parse(session.expiresAt) <= now() ? null : publicAccount(account),
    config, error, secureStorageAvailable: secure });
  const changed = () => onChange(state());
  function persist() {
    if (!secure) return Promise.reject(new Error('VS Code secure credential storage is unavailable.'));
    const value = JSON.stringify({ baseUrl, session });
    const write = persistence.catch(() => {}).then(() => secrets.store(SECRET, value));
    persistence = write;
    return write;
  }
  function initialize() {
    if (!loading) loading = (async () => {
      if (!secure) return state();
      try {
        const saved = await secrets.get(SECRET);
        if (!saved) return state();
        const raw = JSON.parse(saved);
        baseUrl = raw.baseUrl ? serviceUrl(raw.baseUrl) : '';
        phase = baseUrl ? 'disconnected' : 'unconfigured';
        if (raw.session) {
          if (!baseUrl || typeof raw.session.accessToken !== 'string' || raw.session.accessToken.length < 20 || !Number.isFinite(Date.parse(raw.session.expiresAt))) throw new Error('Invalid stored session.');
          if (Date.parse(raw.session.expiresAt) > now()) { session = raw.session; phase = 'connected'; }
          else phase = 'expired';
        }
      } catch {
        session = null; phase = 'locked'; error = 'Saved account access could not be unlocked. Disconnect to remove it, then sign in again.';
      }
      changed(); return state();
    })();
    return loading;
  }
  async function request(route, { method = 'GET', body, token, origin = baseUrl } = {}) {
    if (!origin) throw new Error('Configure the hosted REACH service first.');
    let response;
    try {
      response = await fetchImpl(origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', 'ngrok-skip-browser-warning': '1',
          ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('The REACH service could not be reached. Check its URL and connection.'); }
    if (response.status === 401 && token === session?.accessToken && origin === baseUrl) {
      generation++; session = null; account = null; phase = 'expired'; error = 'Your session expired or was revoked. Sign in again.';
      await persist(); changed();
    }
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to your REACH account again.' : `The REACH service rejected the request (${response.status}).`);
    try { return { status: response.status, data: await response.json() }; }
    catch { throw new Error('The REACH service returned an invalid response.'); }
  }
  async function revoke(token, origin) {
    if (token) try { await request('/v1/auth/logout', { method: 'POST', body: {}, token, origin }); } catch { /* Local access is still removed. */ }
  }
  async function disconnect() {
    await initialize(); generation++; flow = null;
    const old = session, origin = baseUrl;
    session = null; account = null; error = ''; phase = baseUrl ? 'disconnected' : 'unconfigured';
    if (secure) await persist();
    changed(); await revoke(old?.accessToken, origin); return state();
  }
  async function configure(value) {
    await initialize(); const next = serviceUrl(value);
    if (next !== baseUrl) {
      const expected = generation + 1;
      await disconnect(); if (generation !== expected) return state();
      baseUrl = next; config = null; phase = 'disconnected'; await persist(); changed();
    }
    return refresh();
  }
  async function connect() {
    await initialize();
    if (!secure || phase === 'locked') throw new Error('Unlock VS Code secure credential storage before signing in.');
    if (!baseUrl) throw new Error('Configure the hosted REACH service first.');
    if (session && Date.parse(session.expiresAt) > now()) throw new Error('Disconnect the current account before signing in again.');
    session = null; const expected = ++generation, origin = baseUrl;
    flow = null; phase = 'connecting'; error = ''; changed();
    const verifier = crypto.randomBytes(32).toString('base64url'), stateValue = crypto.randomBytes(32).toString('base64url');
    try {
      const { data } = await request('/v1/auth/start', { method: 'POST', body: { state: stateValue, codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url') } });
      if (generation !== expected) return state();
      const expiry = Date.parse(data.expiresAt);
      if (!text(data.flowId) || !Number.isFinite(expiry) || expiry <= now() || expiry > now() + 15 * 60 * 1000) throw new Error('The service returned an invalid login expiry.');
      flow = { flowId: data.flowId, state: stateValue, verifier, expiresAt: data.expiresAt, generation: expected };
      if (await openExternal(browserUrl(data.loginUrl, origin)) === false) throw new Error('The wallet browser could not be opened. Try signing in again.');
    } catch (err) {
      if (generation === expected) { flow = null; phase = 'disconnected'; error = err.message; changed(); }
      throw err;
    }
    return state();
  }
  function cancel() {
    generation++; flow = null;
    if (phase === 'connecting') {
      phase = 'disconnected'; session = null; account = null;
      persist().catch(() => { error = 'The cancelled sign-in could not be removed from secure storage. Disconnect to retry.'; changed(); });
    }
    error = ''; changed(); return state();
  }
  async function poll() {
    await initialize(); const pending = flow, origin = baseUrl;
    if (!pending || polling) return state();
    if (Date.parse(pending.expiresAt) <= now()) { cancel(); error = 'Wallet sign-in timed out. Sign in again to retry.'; changed(); return state(); }
    polling = true;
    try {
      const { status, data } = await request('/v1/auth/exchange', { method: 'POST', body: { flowId: pending.flowId, state: pending.state, codeVerifier: pending.verifier } });
      if (pending !== flow || pending.generation !== generation) { await revoke(data?.accessToken, origin); return state(); }
      if (status === 202) return state();
      if (typeof data.accessToken !== 'string' || data.accessToken.length < 20 || data.accessToken.length > 8192 || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= now()) throw new Error('The service returned an invalid account session.');
      const next = { accessToken: data.accessToken, expiresAt: data.expiresAt };
      session = next;
      try { await persist(); } catch (err) { session = null; await revoke(next.accessToken, origin); throw err; }
      if (pending !== flow || pending.generation !== generation) {
        if (session === next) { session = null; await persist(); changed(); }
        else await persistence.catch(() => {});
        await revoke(next.accessToken, origin); return state();
      }
      account = publicAccount(data.account); flow = null; phase = 'connected'; error = ''; changed();
    } catch (err) { if (pending === flow) { error = err.message; changed(); } }
    finally { polling = false; }
    return state();
  }
  function connection() {
    return { endpoint: baseUrl ? baseUrl + '/v1' : '', accessKey: phase === 'connected' && session && Date.parse(session.expiresAt) > now() ? session.accessToken : '' };
  }
  function authorize(endpoint) {
    const current = connection();
    if (!current.accessKey) throw new Error('Sign in to your REACH account before using subscription models.');
    if (endpoint !== current.endpoint) throw new Error('The account service changed. Retry with the current account.');
    return current.accessKey;
  }
  async function refresh() {
    await initialize(); const expected = generation, origin = baseUrl, token = connection().accessKey;
    if (!origin) return state();
    const result = await request('/v1/account/config');
    if (expected !== generation) return state();
    config = publicConfig(result.data);
    if (token) {
      const result = await request('/v1/account', { token });
      if (expected !== generation) return state();
      account = publicAccount(result.data); phase = 'connected';
    }
    error = ''; changed(); return state();
  }
  async function models() {
    await initialize(); const expected = generation;
    const { data } = await request('/v1/models', { token: authorize(connection().endpoint) });
    if (expected !== generation) throw new Error('Account changed while models were loading. Retry.');
    return (Array.isArray(data.data) ? data.data : []).map(item => text(item?.id)).filter(Boolean);
  }
  async function redeem(amountRch) {
    await initialize(); const token = authorize(connection().endpoint), expected = generation;
    if (!config?.redemptionEnabled) throw new Error('RCH redemption is not enabled on this service.');
    if (typeof amountRch !== 'string' || !/^(0|[1-9]\d{0,20})(\.\d{1,18})?$/.test(amountRch) || !/[1-9]/.test(amountRch)) throw new Error('Enter a positive RCH amount with at most 18 decimal places.');
    const { data } = await request('/v1/redemptions/start', { method: 'POST', token, body: { amountRch } });
    if (expected !== generation) throw new Error('Account changed. Start redemption again.');
    if (!Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= now()) throw new Error('The redemption request expired.');
    if (await openExternal(browserUrl(data.url, baseUrl)) === false) throw new Error('The wallet browser could not be opened.');
    return state();
  }
  async function checkout(body) {
    await initialize(); const token = authorize(connection().endpoint), expected = generation;
    const viaPayPal = body.provider === 'paypal';
    if (viaPayPal ? !config?.paypalPayments : !config?.cardPayments) throw new Error(viaPayPal ? 'PayPal is not enabled on this service.' : 'Card payments are not enabled on this service.');
    const { data } = await request('/v1/billing/checkout', { method: 'POST', token, body });
    if (expected !== generation) throw new Error('Account changed. Start the payment again.');
    if (await openExternal(viaPayPal ? paypalUrl(data.url) : checkoutUrl(data.url)) === false) throw new Error('The payment page could not be opened.');
    return state();
  }
  // Card checkout sends no provider, as before; PayPal is named explicitly.
  const via = provider => provider === 'paypal' ? { provider: 'paypal' } : {};
  const subscribe = (provider = 'stripe') => checkout({ kind: 'subscription', ...via(provider) });
  const topUp = async (amountUsd, provider = 'stripe') => checkout({ kind: 'top_up', amountUsdMicros: topUpMicros(amountUsd), ...via(provider) });
  // Cancel, change card, download invoices: all on Stripe's billing portal.
  async function manageBilling() {
    await initialize(); const token = authorize(connection().endpoint), expected = generation;
    if (!config?.cardPayments) throw new Error('Card payments are not enabled on this service.');
    const { data } = await request('/v1/billing/portal', { method: 'POST', token, body: {} });
    if (expected !== generation) throw new Error('Account changed. Open billing again.');
    if (await openExternal(portalUrl(data.url)) === false) throw new Error('The billing page could not be opened.');
    return state();
  }
  return { initialize, state, configure, connect, cancel, poll, refresh, disconnect, redeem, subscribe, topUp, manageBilling, connection, authorize, models };
}
module.exports = { createHostedAccount, serviceUrl, browserUrl, checkoutUrl, portalUrl, paypalUrl, topUpMicros, publicAccount, publicConfig, SECRET };
