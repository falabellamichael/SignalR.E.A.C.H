'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { randomBytes, createHash } = require('node:crypto');
const { normalizeToken } = require('./app-auth.cjs');
const refreshes = new Map();
let grantStore;

function configureGrantStore(store) { grantStore = store; }

async function postToken(url, body, { signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST', body: new URLSearchParams(body), redirect: 'error',
    headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  // Provider responses can contain tokens. Never pass their raw error bodies to UI/logs.
  if (!response.ok) throw new Error('The authorization service could not complete the request (HTTP ' + response.status + '). Try connecting again.');
  return data;
}

function tokenGrant(data, old = {}) {
  if (!data?.access_token || data.error) throw new Error('Authorization expired or was declined. Connect your account again.');
  return {
    accessToken: normalizeToken(data.access_token),
    refreshToken: data.refresh_token ? normalizeToken(data.refresh_token) : old.refreshToken || '',
    expiresAt: Number.isFinite(Number(data.expires_in)) && Number(data.expires_in) > 0 ? Date.now() + Number(data.expires_in) * 1000 : 0,
    scope: data.scope || old.scope || '',
  };
}

async function oauthToken(id, config, options = {}) {
  const registration = (options.clients || require('./oauth-clients.cjs').loadClients())[id];
  const hosted = ['slack', 'notion', 'discord'].includes(id) && registration?.brokerOrigin && registration.clientId === config?.clientId;
  const endpoint = id === 'github' ? 'https://github.com/login/oauth/access_token' : id === 'slack' ? 'https://slack.com/api/oauth.v2.access' : ['outlook', 'todo'].includes(id) ? 'https://login.microsoftonline.com/common/oauth2/v2.0/token' : null;
  if (!endpoint && !hosted) throw new Error('This authorization requires a registered REACH callback service.');
  if (config?.enabled === false) throw new Error('The connection is disabled.');
  if (config?.token || config?.password) return normalizeToken(config.token || config.password);
  if (!options.forceRefresh && config?.accessToken && (!config.expiresAt || Number(config.expiresAt) > Date.now() + 60000)) return normalizeToken(config.accessToken);
  if (!config?.refreshToken || !config?.clientId) throw new Error('Connect your account in Connections first.');
  const key = id + ':' + config.clientId + ':' + config.refreshToken;
  const cached = refreshes.get(key);
  if (cached && (cached.pending || cached.expiresAt > Date.now() + 60000 && (!options.forceRefresh || cached.accessToken !== config.accessToken))) return cached.pending || cached.accessToken;
  const pending = (async () => {
    const data = hosted ? await brokerRequest(id, registration, 'refresh', { refreshToken: config.refreshToken }, options) : await postToken(endpoint, {
      client_id: config.clientId, grant_type: 'refresh_token', refresh_token: config.refreshToken,
    }, options);
    const grant = tokenGrant(data.authed_user || data, config);
    if (grantStore) {
      const settings = grantStore.getSettings(), current = settings.plugins?.[id];
      if (current?.clientId !== config.clientId || current?.refreshToken !== config.refreshToken || current.enabled === false) throw new Error('The connection changed during renewal. Try again.');
      grantStore.saveSettings({ ...settings, plugins: { ...settings.plugins, [id]: { ...current, ...grant } } });
    }
    if (refreshes.size > 20) refreshes.clear();
    refreshes.set(key, grant);
    return grant.accessToken;
  })();
  refreshes.set(key, { pending });
  try { return await pending; } catch (error) { refreshes.delete(key); throw error; }
}

async function brokerRequest(id, registration, action, body, { signal, fetchImpl = fetch } = {}) {
  if (!['slack', 'notion', 'discord'].includes(id) || !['start', 'exchange', 'refresh', 'cancel', 'read', 'chat-poll', 'chat-reply', 'chat-close'].includes(action)) throw new Error('Unknown hosted connection request.');
  const origin = new URL(registration.brokerOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== registration.brokerOrigin) throw new Error('Invalid connection service.');
  const response = await fetchImpl(origin.origin + '/oauth/' + id + '/' + action, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data || data.error) throw Object.assign(new Error(response.status === 429 ? 'The provider is limiting connection requests. Waiting before retrying.' : response.status === 403 ? 'Your account does not have access to this connection or channel. Check the permissions and reconnect.' : response.status === 503 ? 'The REACH connection service is temporarily unavailable. Try again shortly.' : 'The REACH connection service could not complete this request (HTTP ' + response.status + '). Try again shortly.'), { status: response.status, ...(response.status === 429 ? { retryAfter: Math.max(1, Math.min(3600, Math.ceil(Number(data?.retryAfter) || Number(response.headers?.get?.('retry-after')) || 30))) } : {}) });
  return data;
}

async function authorizeHosted({ id, registration, openExternal, signal, fetchImpl = fetch, wait = delay }) {
  const verifier = randomBytes(48).toString('base64url'), options = { signal, fetchImpl };
  const flow = await brokerRequest(id, registration, 'start', { codeChallenge: createHash('sha256').update(verifier).digest('base64url') }, options);
  const expected = { notion: ['https://api.notion.com', '/v1/oauth/authorize'], slack: ['https://slack.com', '/oauth/v2/authorize'], discord: ['https://discord.com', '/oauth2/authorize'] }[id];
  const url = new URL(flow.authorizeUrl);
  if (!/^[A-Za-z0-9_-]{43}$/.test(flow.flowId || '') || url.origin !== expected[0] || url.pathname !== expected[1] || url.searchParams.get('client_id') !== registration.clientId || url.searchParams.get('redirect_uri') !== registration.brokerOrigin + '/oauth/' + id + '/callback') throw new Error('The callback service returned an invalid authorization page.');
  try {
    await openExternal(url.href);
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      await wait(1500, undefined, { signal }); signal?.throwIfAborted();
      const data = await brokerRequest(id, registration, 'exchange', { flowId: flow.flowId, verifier }, options);
      if (!data.pending) return tokenGrant(data);
    }
    throw new Error('Sign-in timed out. Connect again.');
  } finally {
    // Cancel also clears an abandoned grant from the callback server. Completed
    // flows have already been consumed, and a 404 is expected in that case.
    await brokerRequest(id, registration, 'cancel', { flowId: flow.flowId, verifier }, { fetchImpl }).catch(() => {});
  }
}

async function authorizeGithubDevice({ clientId, openExternal, onCode, signal, fetchImpl = fetch, wait = delay }) {
  const options = { signal, fetchImpl };
  const device = await postToken('https://github.com/login/device/code', { client_id: clientId, scope: 'repo read:user offline_access' }, options);
  if (!device.device_code || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(device.user_code || '') || device.verification_uri !== 'https://github.com/login/device') throw new Error('GitHub did not return a valid device authorization. Try again.');
  onCode(device.user_code);
  await openExternal('https://github.com/login/device');
  let interval = Math.max(5, Number(device.interval) || 5) * 1000;
  const deadline = Date.now() + Math.min(900, Math.max(1, Number(device.expires_in) || 900)) * 1000;
  while (Date.now() < deadline) {
    await wait(interval, undefined, { signal });
    signal?.throwIfAborted();
    const data = await postToken('https://github.com/login/oauth/access_token', {
      client_id: clientId, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, options);
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += 5000; continue; }
    return tokenGrant(data);
  }
  throw new Error('GitHub sign-in timed out. Connect again to get a new code.');
}

const githubToken = (config, options) => oauthToken('github', config, options);
module.exports = { configureGrantStore, oauthToken, githubToken, authorizeGithubDevice, authorizeHosted, brokerRequest, postToken, tokenGrant };
