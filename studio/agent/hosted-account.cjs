'use strict';

// Hosted credentials live only in Electron main and the OS-encrypted session
// file. The renderer receives this module's explicit public projection.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteJson } = require('./atomic-write.cjs');
const MANAGED_ID = 'reach_hosted';
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
function serviceUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter the hosted REACH service URL.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && loopback(url.hostname))) {
    throw new Error('Use an HTTPS service origin, or HTTP on localhost for development; omit paths and credentials.');
  }
  return url.origin;
}
function browserUrl(value, base) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The service returned an invalid browser URL.'); }
  if (url.origin !== base || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('The service returned a browser URL outside its configured origin.');
  }
  return url.href;
}
const text = (value, limit = 250) => typeof value === 'string' ? value.slice(0, limit) : '';
const count = value => /^(0|[1-9]\d{0,29})$/.test(String(value)) ? String(value) : '0';
function publicAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const allowance = raw.allowance || {}, plan = raw.plan || {};
  return {
    id: text(raw.id), walletAddress: /^0x[0-9a-f]{40}$/i.test(raw.walletAddress) ? raw.walletAddress : '',
    plan: { id: text(plan.id), name: text(plan.name), status: text(plan.status), expiresAt: text(plan.expiresAt) },
    allowedModels: (Array.isArray(raw.allowedModels) ? raw.allowedModels : []).slice(0, 500).map(model =>
      typeof model === 'string' ? { id: text(model), name: text(model), provider: '' }
        : { id: text(model?.id), name: text(model?.name), provider: text(model?.provider) }).filter(model => model.id),
    allowance: Object.fromEntries(['includedRemaining', 'prepaidRemaining', 'reserved', 'totalRemaining', 'debt'].map(key => [key, count(allowance[key])])),
  };
}
function publicConfig(raw) {
  return { enabled: raw?.enabled === true, chainId: Number.isSafeInteger(raw?.chainId) ? raw.chainId : null,
    tokenAddress: /^0x[0-9a-f]{40}$/i.test(raw?.tokenAddress) ? raw.tokenAddress : '',
    redemptionEnabled: raw?.redemptionEnabled === true, tokensPerRch: count(raw?.tokensPerRch),
    loginMethod: text(raw?.loginMethod) };
}
function createHostedAccount({ file, safeStorage, fetchImpl = globalThis.fetch, openExternal, onChange = () => {}, now = Date.now }) {
  let loaded = false, baseUrl = '', session = null, flow = null, config = null, account = null;
  let phase = 'unconfigured', error = '', generation = 0, polling = false;
  const issuedSecrets = new Set();
  const filename = () => typeof file === 'function' ? file() : file;
  const available = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  function persist() {
    const output = { schemaVersion: 1, baseUrl };
    if (session) {
      if (!available()) throw new Error('Unlock the system credential vault before connecting your wallet.');
      output.encryptedSession = safeStorage.encryptString(JSON.stringify(session)).toString('base64');
    }
    fs.mkdirSync(path.dirname(filename()), { recursive: true });
    atomicWriteJson(filename(), output);
    fs.chmodSync(filename(), 0o600);
  }
  function initialize() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(filename(), 'utf8'));
      if (raw.schemaVersion !== 1) throw new Error('Unsupported account file.');
      baseUrl = raw.baseUrl ? serviceUrl(raw.baseUrl) : '';
      phase = baseUrl ? 'disconnected' : 'unconfigured';
      if (raw.encryptedSession) {
        if (!available()) throw new Error('Credential vault locked.');
        const decoded = JSON.parse(safeStorage.decryptString(Buffer.from(raw.encryptedSession, 'base64')));
        if (!decoded.accessToken || !Number.isFinite(Date.parse(decoded.expiresAt))) throw new Error('Invalid saved session.');
        session = { accessToken: String(decoded.accessToken), expiresAt: decoded.expiresAt };
        issuedSecrets.add(session.accessToken);
        phase = Date.parse(session.expiresAt) > now() ? 'connected' : 'expired';
        if (phase === 'expired') session = null;
      }
    } catch (err) {
      if (err.code === 'ENOENT') return;
      session = null; phase = 'locked'; error = 'Saved account access could not be unlocked. Unlock your system credential vault and restart Studio, or disconnect to remove this session.';
    }
  }
  function expire() {
    if (session && Date.parse(session.expiresAt) <= now()) {
      session = null; account = null; phase = 'expired'; error = 'Your session expired. Connect your wallet again.';
      persist(); return true;
    }
    return false;
  }
  function state() {
    initialize(); expire();
    return { status: phase, baseUrl, account: publicAccount(account), config: config ? { ...config } : null,
      expiresAt: session?.expiresAt || '', flowExpiresAt: flow?.expiresAt || '', error,
      connectionId: MANAGED_ID, secureStorageAvailable: available() };
  }
  function changed() { onChange(state()); }
  async function request(route, { method = 'GET', body, token, origin = baseUrl } = {}) {
    if (!origin) throw new Error('Configure the hosted REACH service first.');
    let response;
    try {
      response = await fetchImpl(origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('The REACH service could not be reached. Check its URL and connection.'); }
    if (response.status === 401 && token && token === session?.accessToken && origin === baseUrl) {
      session = null; account = null; phase = 'expired'; error = 'Your session expired or was revoked. Connect your wallet again.';
      persist(); changed();
      throw new Error(error);
    }
    if (!response.ok) throw new Error(response.status === 429 ? 'The service is busy. Please try again shortly.' : `The REACH service rejected the request (${response.status}).`);
    let data;
    try { data = await response.json(); } catch { throw new Error('The REACH service returned an invalid response.'); }
    return { status: response.status, data };
  }
  async function revoke(token, origin) {
    if (!token || !origin) return;
    try { await request('/v1/auth/logout', { method: 'POST', body: {}, token, origin }); } catch { /* The local session is still removed; server sessions expire. */ }
  }
  async function disconnect() {
    initialize(); generation++; flow = null;
    const old = session; session = null; account = null; error = ''; phase = baseUrl ? 'disconnected' : 'unconfigured';
    persist(); changed(); await revoke(old?.accessToken, baseUrl);
    return state();
  }
  async function configure(value) {
    initialize(); const next = serviceUrl(value);
    if (next !== baseUrl) {
      const expected = generation + 1;
      await disconnect();
      if (generation !== expected) return state();
      baseUrl = next; config = null; phase = 'disconnected'; persist(); changed();
    }
    const expected = generation, origin = baseUrl;
    const response = await request('/v1/account/config');
    if (expected === generation && origin === baseUrl) { config = publicConfig(response.data); error = ''; changed(); }
    return state();
  }
  async function connect() {
    initialize();
    if (!baseUrl) throw new Error('Configure the hosted REACH service first.');
    if (!available() || phase === 'locked') throw new Error('Unlock the system credential vault before connecting your wallet.');
    if (session) throw new Error('Disconnect the current wallet before connecting another.');
    const expected = ++generation, origin = baseUrl;
    flow = null; phase = 'connecting'; error = ''; changed();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const stateValue = crypto.randomBytes(32).toString('base64url');
    try {
      const { data } = await request('/v1/auth/start', { method: 'POST', body: { codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'), state: stateValue } });
      if (generation !== expected || origin !== baseUrl) return state();
      const expires = Date.parse(data.expiresAt);
      if (!text(data.flowId) || !Number.isFinite(expires) || expires <= now() || expires > now() + 15 * 60 * 1000) throw new Error('The service returned an invalid login expiry.');
      const loginUrl = browserUrl(data.loginUrl, baseUrl);
      flow = { flowId: data.flowId, state: stateValue, verifier, expiresAt: data.expiresAt, generation: expected };
      await openExternal(loginUrl);
      if (generation === expected) changed();
    } catch (err) {
      if (generation === expected) { flow = null; phase = 'disconnected'; error = err.message; changed(); }
      throw err;
    }
    return state();
  }
  function cancel() {
    initialize(); generation++; flow = null;
    if (phase === 'connecting') phase = 'disconnected';
    error = ''; changed(); return state();
  }
  async function poll() {
    initialize(); if (expire()) changed();
    const pending = flow, origin = baseUrl;
    if (!pending || polling) return state();
    if (Date.parse(pending.expiresAt) <= now()) { cancel(); error = 'Wallet sign-in timed out. Connect again to retry.'; changed(); return state(); }
    polling = true;
    try {
      const { status, data } = await request('/v1/auth/exchange', { method: 'POST', body: { flowId: pending.flowId, state: pending.state, codeVerifier: pending.verifier } });
      if (pending !== flow || pending.generation !== generation) { await revoke(data?.accessToken, origin); return state(); }
      if (status === 202) return state();
      if (typeof data.accessToken !== 'string' || data.accessToken.length < 20 || data.accessToken.length > 8192 || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= now()) throw new Error('The service returned an invalid account session.');
      const nextSession = { accessToken: data.accessToken, expiresAt: data.expiresAt };
      session = nextSession; issuedSecrets.add(nextSession.accessToken);
      try { persist(); } catch (err) { session = null; await revoke(nextSession.accessToken, origin); throw err; }
      account = publicAccount(data.account); flow = null; phase = 'connected'; error = ''; changed();
    } catch (err) {
      if (pending === flow) { error = err.message; changed(); }
    } finally { polling = false; }
    return state();
  }
  async function refresh() {
    initialize(); if (expire()) changed();
    const expected = generation, token = session?.accessToken;
    if (!baseUrl) return state();
    const response = await request('/v1/account/config');
    if (generation !== expected) return state();
    config = publicConfig(response.data);
    if (token) {
      const result = await request('/v1/account', { token });
      if (generation !== expected || session?.accessToken !== token) return state();
      account = publicAccount(result.data); phase = 'connected';
    }
    error = ''; changed(); return state();
  }
  async function redeem(amountRch) {
    initialize(); expire();
    if (!session) throw new Error('Connect your wallet before redeeming RCH.');
    if (!config?.redemptionEnabled) throw new Error('RCH redemption is not enabled on this service.');
    if (typeof amountRch !== 'string' || !/^(0|[1-9]\d{0,20})(\.\d{1,18})?$/.test(amountRch) || !/[1-9]/.test(amountRch)) throw new Error('Enter a positive RCH amount with at most 18 decimal places.');
    const expected = generation;
    const { data } = await request('/v1/redemptions/start', { method: 'POST', token: session.accessToken, body: { amountRch } });
    if (generation !== expected) throw new Error('Wallet connection changed. Start redemption again.');
    const url = browserUrl(data.url, baseUrl);
    if (!Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= now()) throw new Error('The redemption request has expired.');
    await openExternal(url);
    return { redemptionId: text(data.redemptionId), expiresAt: text(data.expiresAt) };
  }
  function managedConnection(existing = {}) {
    initialize(); expire();
    if (!baseUrl) return null;
    return { id: MANAGED_ID, name: 'REACH subscription', endpoint: baseUrl + '/v1',
      accessKey: session?.accessToken || '', model: text(existing.model) || account?.allowedModels?.[0]?.id || '',
      enabled: existing.enabled !== false };
  }
  function hydrate(settings) {
    const current = settings.connections?.find(connection => connection.id === MANAGED_ID);
    if (!current) return settings;
    const managed = managedConnection(current);
    const list = (settings.connections || []).filter(connection => connection.id !== MANAGED_ID);
    if (managed) list.push(managed);
    return { ...settings, connections: list, ...(settings.activeConnection === MANAGED_ID ? {
      endpoint: managed?.endpoint || '', accessKey: managed?.accessKey || '', model: managed?.model || '' } : {}) };
  }
  function sanitize(settings) {
    const out = { ...settings, connections: (settings.connections || []).map(connection => connection.id === MANAGED_ID
      ? { ...connection, accessKey: '', endpoint: baseUrl ? baseUrl + '/v1' : '', managed: true } : { ...connection }) };
    if (out.activeConnection === MANAGED_ID) { out.accessKey = ''; out.endpoint = baseUrl ? baseUrl + '/v1' : ''; }
    // Legacy settings patches can copy an active credential into another row.
    // Retain redaction knowledge after expiry while older main-process requests
    // may still hold their snapshots; do not persist even expired credentials.
    for (const token of issuedSecrets) {
      if (out.accessKey === token) out.accessKey = '';
      out.connections = out.connections.map(connection => connection.accessKey === token ? { ...connection, accessKey: '' } : connection);
    }
    return out;
  }
  return { state, configure, connect, cancel, poll, refresh, disconnect, redeem, hydrate, sanitize, managedConnection };
}
module.exports = { createHostedAccount, serviceUrl, browserUrl, publicAccount, publicConfig, MANAGED_ID };
