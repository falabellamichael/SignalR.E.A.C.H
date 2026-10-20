'use strict';

const http = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { gmailFetch, outlookFetch } = require('./mail-connections.cjs');
const { weatherUrl, readWeather, DEFAULT_WEATHER_URL } = require('./weather-connection.cjs');

function createAppConnections({ getSettings, saveSettings, openExternal }) {
  const status = new Map(); let pending = null, revision = 0;
  const plugins = () => getSettings().plugins || {};
  function catalog() {
    const p = plugins();
    return [
      { id: 'weather', name: 'The Weather Network', description: 'Current conditions from your saved city page (Toronto by default). No account needed.', enabled: p.weather?.enabled !== false,
        url: p.weather?.url || DEFAULT_WEATHER_URL, fields: [{ key: 'url', label: 'City current-weather URL', value: p.weather?.url || DEFAULT_WEATHER_URL }], actions: ['weather.current'] },
      { id: 'gmail', name: 'Gmail', description: 'Search and read mail with Google sign-in. Requested mail content is shared with your selected model. Sending needs a separate permission and confirmation.', enabled: p.gmail?.enabled !== false,
        account: p.gmail?.email || '', configured: !!(p.gmail?.refreshToken || p.gmail?.accessToken || p.gmail?.password), connecting: !!pending,
        sendAllowed: String(p.gmail?.scope || '').split(' ').includes('https://www.googleapis.com/auth/gmail.send'),
        fields: [{ key: 'clientId', label: 'Google Desktop OAuth client ID', value: p.gmail?.clientId || '' }, { key: 'clientSecret', label: 'Desktop client secret (if supplied by Google)', secret: true }],
        help: 'Enable Gmail API, configure the OAuth consent screen, and create a Desktop app client in Google Cloud. Add yourself as a test user if the app is in testing.',
        helpUrl: 'https://developers.google.com/workspace/gmail/api/quickstart/nodejs', actions: ['gmail.read', 'gmail.send'] },
      { id: 'github', name: 'GitHub', description: 'Repository, issue and pull request tools. Uses a saved token or GitHub CLI sign-in.', enabled: p.github?.enabled !== false,
        configured: !!p.github?.token, fields: [{ key: 'token', label: 'Personal access token (or use gh auth login)', secret: true }],
        helpUrl: 'https://github.com/settings/tokens', actions: ['github.repo', 'github.issues', 'github.prs'] },
      { id: 'outlook', name: 'Outlook / Microsoft 365', description: 'Read mail with a Microsoft Graph OAuth access token. Tokens must include Mail.Read.', enabled: p.outlook?.enabled !== false,
        account: p.outlook?.email || '', configured: !!p.outlook?.password,
        fields: [{ key: 'email', label: 'Account email', value: p.outlook?.email || '' }, { key: 'password', label: 'Microsoft Graph OAuth access token', secret: true }],
        helpUrl: 'https://developer.microsoft.com/en-us/graph/graph-explorer', actions: ['outlook.read'] },
      ...require('./extra-apps.cjs').DEFINITIONS.map(([id,name,description,label,helpUrl])=>({id,name,description,helpUrl,enabled:p[id]?.enabled===true,configured:!!p[id]?.token,fields:[{key:'token',label,secret:true},...(id==='discord'?[{key:'channel',label:'Channel ID',value:p[id]?.channel||''}]:[])],actions:[id+'.read',...(id==='todo'?['todo.create']:[])]})),
    ].map(item => ({ ...item, status: item.enabled ? status.get(item.id) || { state: item.configured ? 'saved' : item.id === 'weather' ? 'ready' : 'disconnected' } : { state: 'disabled' } }));
  }
  function save(id, patch = {}) {
    if (!catalog().some(item => item.id === id)) throw new Error('Unknown app connection.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid connection settings.');
    const settings = getSettings(), current = settings.plugins || {}, next = { ...current[id] };
    const definition = catalog().find(item => item.id === id);
    for (const field of definition.fields) {
      if (typeof patch[field.key] !== 'string') continue;
      const value = patch[field.key].trim();
      // Blank secret fields preserve the saved credential; Disconnect removes it.
      if (field.secret && !value) continue;
      next[field.key] = value.slice(0, field.secret ? 16384 : 2048);
    }
    if (id === 'weather') next.url = weatherUrl(next.url || DEFAULT_WEATHER_URL);
    if (id === 'gmail' && next.clientId !== current.gmail?.clientId) {
      for (const key of ['accessToken', 'refreshToken', 'expiresAt', 'email', 'scope', 'password']) delete next[key];
      revision++; cancel();
    }
    if (id === 'gmail' && (next.clientSecret !== current.gmail?.clientSecret || patch.enabled === false)) { revision++; cancel(); }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    saveSettings({ ...settings, plugins: { ...current, [id]: next } });
    status.delete(id);
    return catalog();
  }
  function cancel() { pending?.cancel(); }
  function disconnect(id) {
    if (!catalog().some(item => item.id === id)) throw new Error('Unknown app connection.');
    if (id === 'gmail') { revision++; cancel(); }
    const settings = getSettings(), p = settings.plugins || {};
    const next = { enabled: false };
    // Retain public client configuration for a later reconnect.
    if (id === 'gmail') next.clientId = p.gmail?.clientId || '';
    saveSettings({ ...settings, plugins: { ...p, [id]: next } });
    status.delete(id); return catalog();
  }
  async function check(id) {
    const config = plugins()[id] || {};
    if (config.enabled === false) throw new Error('Enable the connection before checking it.');
    status.set(id, { state: 'checking' });
    try {
      let note;
      if (id === 'weather') { const result = await readWeather(config); note = 'City page reachable · ' + new URL(result.url).pathname.split('/').at(-2).replaceAll('-', ' '); }
      else if (id === 'gmail') { const profile = await gmailFetch(config, 'profile'); note = profile.emailAddress; }
      else if (id === 'outlook') { const profile = await outlookFetch(config, '?$select=mail,userPrincipalName'); note = profile.mail || profile.userPrincipalName; }
      else if (id === 'github') {
        const result = await require('./plugins.cjs').testPlugin('github', config);
        if (!result.ok) throw new Error(result.err); note = result.user.login;
      } else if (require('./extra-apps.cjs').ids.includes(id)) {
        await require('./extra-apps.cjs').checkConnection(id,config);note=id==='slack'?'Token accepted; message search also requires search:read.':'Connection check succeeded';
      } else throw new Error('Unknown app connection.');
      if (JSON.stringify(config) === JSON.stringify(plugins()[id] || {})) status.set(id, { state: 'connected', note, checkedAt: Date.now() });
      else status.delete(id);
    } catch (error) {
      if (JSON.stringify(config) === JSON.stringify(plugins()[id] || {})) status.set(id, { state: 'error', note: error.message });
      else status.delete(id);
    }
    return catalog();
  }
  async function connectGmail({ allowSend = false } = {}) {
    if (pending) throw new Error('Google sign-in is already open. Finish or cancel it first.');
    const storage = getSettings().credentialStorage;
    if (storage?.encrypted !== true || storage.locked) throw new Error('Unlock your system credential vault before connecting Gmail.');
    const config = plugins().gmail || {}, version = revision;
    if (!config.clientId || !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(config.clientId)) throw new Error('Save a Google Desktop OAuth client ID first.');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const server = http.createServer(); let timeout; const controller = new AbortController();
    let resolveCode, rejectCode;
    const result = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    result.catch(() => {}); // cancellation can arrive while the browser opens
    pending = { cancel: () => { revision++; controller.abort(); rejectCode(new Error('Google sign-in cancelled.')); } };
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const redirect = `http://127.0.0.1:${server.address().port}/oauth/callback`;
      server.on('request', (request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        let url;
        try { url = new URL(request.url, redirect); }
        catch { response.writeHead(400).end('Invalid sign-in response.'); return; }
        if (request.method !== 'GET' || url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid sign-in response.'); return; }
        if (url.searchParams.has('error')) { response.end('Sign-in cancelled. Return to SignalREACH.'); rejectCode(new Error('Google sign-in was declined.')); return; }
        const code = url.searchParams.get('code');
        if (!code) { response.writeHead(400).end('Missing authorization code.'); return; }
        response.end('Sign-in received. Return to SignalREACH to check the connection.'); resolveCode(code);
      });
      timeout = setTimeout(() => { controller.abort(); rejectCode(new Error('Google sign-in timed out. Try again.')); }, 180000);
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
      if (allowSend) scopes.push('https://www.googleapis.com/auth/gmail.send');
      for (const [key, value] of Object.entries({ client_id: config.clientId, redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '), state,
        code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' })) url.searchParams.set(key, value);
      await openExternal(url.href);
      const code = await result;
      const body = new URLSearchParams({ client_id: config.clientId, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' });
      if (config.clientSecret) body.set('client_secret', config.clientSecret);
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
      const tokens = await response.json();
      if (!response.ok || !tokens.access_token || !tokens.refresh_token) throw new Error('Google did not complete authorization. Check the Desktop client configuration and try again.');
      if (!String(tokens.scope || '').split(' ').includes('https://www.googleapis.com/auth/gmail.readonly')) throw new Error('Gmail read permission was not granted. Connect again and allow reading mail.');
      const grant = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000, scope: tokens.scope || '' };
      const profile = await gmailFetch({ ...config, ...grant, enabled: true }, 'profile', { signal: controller.signal });
      if (version !== revision) throw new Error('The connection changed during sign-in. Connect again.');
      const settings = getSettings();
      saveSettings({ ...settings, plugins: { ...settings.plugins, gmail: { ...settings.plugins?.gmail, ...grant, email: profile.emailAddress, password: '', enabled: true } } });
      status.set('gmail', { state: 'connected', note: profile.emailAddress, checkedAt: Date.now() });
      return catalog();
    } finally { clearTimeout(timeout); server.close(); server.closeAllConnections(); pending = null; }
  }
  return { catalog, save, check, disconnect, connectGmail, cancel, destroy: cancel };
}
module.exports = { createAppConnections };
