'use strict';

const http = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { gmailFetch, outlookFetch } = require('./mail-connections.cjs');
const { weatherUrl, readWeather, DEFAULT_WEATHER_URL } = require('./weather-connection.cjs');
const { normalizeToken } = require('./app-auth.cjs');
const validGoogleClientId = value => typeof value === 'string' && /^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(value);
const GOOGLE_SCOPES = { gmail: 'https://www.googleapis.com/auth/gmail.readonly', drive: 'https://www.googleapis.com/auth/drive.readonly', calendar: 'https://www.googleapis.com/auth/calendar.readonly' };
const MICROSOFT_SCOPES = { outlook: 'https://graph.microsoft.com/Mail.Read', todo: 'https://graph.microsoft.com/Tasks.ReadWrite' };

function createAppConnections({ getSettings, saveSettings, openExternal, clients = {}, getProjects = () => [], getDiscordChatStatus = () => null }) {
  const status = new Map(); let pending = null, revision = 0;
  const plugins = () => getSettings().plugins || {};
  function googleConfig(id) {
    const p = plugins(), own = p[id] || {}, shared = p.gmail || {};
    const source = validGoogleClientId(own.clientId) ? own : validGoogleClientId(shared.clientId) ? shared : clients.google || {};
    return { ...own, clientId: source.clientId || '', clientSecret: source.clientSecret || '' };
  }
  function catalog() {
    const p = plugins();
    return [
      { id: 'weather', name: 'The Weather Network', description: 'Current conditions from your saved city page (Toronto by default). No account needed.', enabled: p.weather?.enabled !== false,
        url: p.weather?.url || DEFAULT_WEATHER_URL, fields: [{ key: 'url', label: 'City current-weather URL', value: p.weather?.url || DEFAULT_WEATHER_URL }], actions: ['weather.current'] },
      { id: 'gmail', name: 'Gmail', description: 'Search and read mail with Google sign-in. Requested mail content is shared with your selected model. Sending needs a separate permission and confirmation.', enabled: p.gmail?.enabled !== false,
        account: p.gmail?.email || '', configured: !!(p.gmail?.refreshToken || p.gmail?.accessToken || p.gmail?.password), connecting: pending?.id === 'gmail',
        sendAllowed: String(p.gmail?.scope || '').split(' ').includes('https://www.googleapis.com/auth/gmail.send'),
        allowSend: p.gmail?.allowSend ?? String(p.gmail?.scope || '').split(' ').includes('https://www.googleapis.com/auth/gmail.send'),
        fields: [{ key: 'password', label: 'Google OAuth access token (optional alternative to sign-in)', secret: true }, ...(!clients.google ? [{ key: 'clientId', label: 'Google Desktop OAuth client ID', value: validGoogleClientId(p.gmail?.clientId) ? p.gmail.clientId : '' }, { key: 'clientSecret', label: 'Desktop client secret (if supplied by Google)', secret: true }] : [])],
        help: clients.google ? 'Connect Google, choose your account, then authorize REACH Studio. A pasted access token is optional and expires.' : (p.gmail?.clientId && !validGoogleClientId(p.gmail.clientId) ? 'The saved client ID is invalid and has been hidden. Enter an OAuth client ID, not an app password. ' : '') + 'Enable Gmail API, configure the OAuth consent screen, and create a Desktop app client in Google Cloud. Add yourself as a test user if the app is in testing.',
        helpUrl: 'https://developers.google.com/workspace/gmail/api/quickstart/nodejs', actions: ['gmail.read', 'gmail.send'] },
      { id: 'github', name: 'GitHub', description: 'Repository, issue and pull request tools. Uses a saved token or GitHub CLI sign-in.', enabled: p.github?.enabled !== false,
        configured: !!(p.github?.token || p.github?.accessToken || p.github?.refreshToken), oauthProvider: clients.github ? 'GitHub' : undefined, connecting: pending?.id === 'github', fields: [{ key: 'token', label: 'Personal access token (optional alternative to sign-in)', secret: true }],
        helpUrl: 'https://github.com/settings/tokens', actions: ['github.repo', 'github.issues', 'github.prs'] },
      { id: 'outlook', name: 'Outlook / Microsoft 365', description: 'Read mail with a Microsoft Graph OAuth access token. Tokens must include Mail.Read.', enabled: p.outlook?.enabled !== false,
        account: p.outlook?.email || '', configured: !!(p.outlook?.password || p.outlook?.accessToken || p.outlook?.refreshToken), oauthProvider: clients.microsoft ? 'Microsoft' : undefined, connecting: pending?.id === 'outlook',
        fields: [{ key: 'email', label: 'Account email', value: p.outlook?.email || '' }, { key: 'password', label: 'Microsoft Graph OAuth access token', secret: true }],
        helpUrl: 'https://developer.microsoft.com/en-us/graph/graph-explorer', actions: ['outlook.read'] },
      ...require('./extra-apps.cjs').DEFINITIONS.map(([id,name,description,label,helpUrl])=>({id,name,description,helpUrl:id==='todo'?'https://developer.microsoft.com/en-us/graph/graph-explorer':helpUrl,
        help: id==='todo'?(clients.microsoft?'Connect Microsoft and authorize REACH Studio to read and create your tasks. A pasted Graph token remains an optional alternative.':'In Graph Explorer, sign in, run GET /me/todo/lists, and grant Tasks.ReadWrite before copying the new access token.'): id==='discord'&&clients.discord?'Connect Discord and authorize the REACH bot for your server. The installation requests Administrator permission. Enable Discord chat below, then DM REACH or mention it in any server text channel you and the bot can access. The saved channel is the default for reading messages. Only your linked Discord account controls your Studio.': GOOGLE_SCOPES[id]?(clients.google?'Connect Google, choose your account, then authorize REACH Studio. A pasted access token is optional and expires.':'Connect Google for automatic token renewal. Uses the Desktop OAuth client saved for Gmail unless you enter a different client below. Enable this app’s API and add yourself as a test user in Google Cloud. A pasted token is optional and expires.'):undefined,
        googleSignIn:!!GOOGLE_SCOPES[id],oauthProvider:id==='todo'&&clients.microsoft?'Microsoft':clients[id]&&['slack','notion','discord'].includes(id)?name:undefined,usesCallbackService:!!clients[id]?.brokerOrigin,connecting:pending?.id===id,
        enabled:p[id]?.enabled===true,configured:!!(p[id]?.token||p[id]?.refreshToken||p[id]?.accessToken),fields:[{key:'token',label,secret:true},...(GOOGLE_SCOPES[id]&&!clients.google?[{key:'clientId',label:'Google Desktop OAuth client ID',value:validGoogleClientId(googleConfig(id).clientId)?googleConfig(id).clientId:''},{key:'clientSecret',label:'Desktop client secret (if supplied by Google)',secret:true}]:[]),...(id==='discord'?[{key:'channel',label:'Default text channel ID for reading messages (optional)',value:p[id]?.channel||''}]:[])],actions:[id+'.read',...(id==='todo'?['todo.create']:[])]})),
    ].map(item => ({ ...item, ...(item.id === 'discord' ? { chat: { enabled: p.discord?.chatEnabled === true, workspace: p.discord?.workspace || '', projects: getProjects().map(project => ({ name: project.name || require('node:path').basename(project.dir), dir: project.dir })), status: getDiscordChatStatus() } } : {}), status: item.enabled || pending?.id === item.id ? status.get(item.id) || { state: item.configured ? 'saved' : item.id === 'weather' ? 'ready' : 'disconnected' } : { state: 'disabled' } }));
  }
  function save(id, patch = {}) {
    if (!catalog().some(item => item.id === id)) throw new Error('Unknown app connection.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid connection settings.');
    const settings = getSettings(), current = settings.plugins || {}, next = { ...current[id] };
    if (id === 'discord') {
      if (Object.hasOwn(patch, 'chatEnabled')) { if (typeof patch.chatEnabled !== 'boolean') throw new Error('Invalid Discord chat setting.'); next.chatEnabled = patch.chatEnabled; }
      if (Object.hasOwn(patch, 'workspace')) { if (typeof patch.workspace !== 'string' || patch.workspace && !getProjects().some(project => project.dir === patch.workspace)) throw new Error('Choose a saved Studio project for Discord chat.'); next.workspace = patch.workspace; }
    }
    const definition = catalog().find(item => item.id === id);
    for (const field of definition.fields) {
      if (typeof patch[field.key] !== 'string') continue;
      const value = patch[field.key].trim();
      // Blank secret fields preserve the saved credential; Disconnect removes it.
      if (field.secret && !value) continue;
      next[field.key] = field.key === 'token' || field.key === 'password' ? normalizeToken(value) : value.slice(0, field.secret ? 16384 : 2048);
    }
    if (id === 'weather') next.url = weatherUrl(next.url || DEFAULT_WEATHER_URL);
    if (GOOGLE_SCOPES[id]) {
      if (Object.hasOwn(patch, 'clientId') && next.clientId && !validGoogleClientId(next.clientId)) {
        throw new Error('Enter the Google Desktop OAuth client ID ending in .apps.googleusercontent.com, not the client secret or an API key.');
      }
      if (id === 'gmail' && typeof patch.allowSend === 'boolean') next.allowSend = patch.allowSend;
    }
    if (GOOGLE_SCOPES[id] && next.clientId !== current[id]?.clientId) {
      for (const key of ['accessToken', 'refreshToken', 'expiresAt', 'email', 'scope', 'password']) delete next[key];
      revision++; cancel();
    }
    if (GOOGLE_SCOPES[id] && (next.clientSecret !== current[id]?.clientSecret || patch.enabled === false)) { revision++; cancel(); }
    if (GOOGLE_SCOPES[id] && typeof patch.token === 'string' && patch.token.trim()) {
      for (const key of ['accessToken', 'refreshToken', 'expiresAt', 'scope']) delete next[key];
      revision++; cancel();
    }
    if (id === 'gmail' && typeof patch.password === 'string' && patch.password.trim()) {
      next.password = normalizeToken(patch.password);
      for (const key of ['accessToken', 'refreshToken', 'expiresAt', 'scope']) delete next[key];
      revision++; cancel();
    }
    if (['github','todo','slack','outlook','notion','discord'].includes(id) && [patch.token,patch.password].some(value=>typeof value==='string'&&value.trim())) {
      for (const key of ['accessToken', 'refreshToken', 'expiresAt', 'scope']) delete next[key];
    }
    if (pending?.id === id) { revision++; cancel(); }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    saveSettings({ ...settings, plugins: { ...current, [id]: next } });
    status.delete(id);
    return catalog();
  }
  function cancel() { pending?.cancel(); }
  function disconnect(id) {
    if (!catalog().some(item => item.id === id)) throw new Error('Unknown app connection.');
    if (GOOGLE_SCOPES[id] || pending?.id === id) { revision++; cancel(); }
    const settings = getSettings(), p = settings.plugins || {};
    const next = { enabled: false };
    // Retain public client configuration for a later reconnect.
    if (id === 'gmail') { next.clientId = p.gmail?.clientId || ''; next.allowSend = p.gmail?.allowSend === true; }
    else if (GOOGLE_SCOPES[id]) next.clientId = p[id]?.clientId || '';
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
      else if (id === 'outlook') { await outlookFetch(config, '/messages?$top=1&$select=id'); note = 'Mail access verified'; }
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
  async function connectAuthorization({ id = 'gmail', allowSend = false } = {}) {
    if (['slack', 'notion', 'discord'].includes(id) && clients[id]?.brokerOrigin) return connectHosted(id);
    const google = Object.hasOwn(GOOGLE_SCOPES, id), microsoft = Object.hasOwn(MICROSOFT_SCOPES, id);
    if (!google && !microsoft && id !== 'slack') throw new Error('Unknown app connection.');
    const provider = google ? 'Google' : microsoft ? 'Microsoft' : 'Slack';
    if (pending) throw new Error('Sign-in is already open. Finish or cancel it first.');
    const storage = getSettings().credentialStorage;
    if (storage?.encrypted !== true || storage.locked) throw new Error('Unlock your system credential vault before connecting ' + provider + '.');
    const config = google ? googleConfig(id) : { ...plugins()[id], clientId: clients[microsoft ? 'microsoft' : 'slack']?.clientId }, version = revision;
    if (!config.clientId) throw new Error(provider + ' sign-in requires a registered application in this build. You can save an access token instead.');
    if (google && !validGoogleClientId(config.clientId)) throw new Error('The saved Google client ID is invalid. It must end in .apps.googleusercontent.com.');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const server = http.createServer(); let timeout; const controller = new AbortController();
    let resolveCode, rejectCode;
    const result = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    result.catch(() => {}); // cancellation can arrive while the browser opens
    pending = { id, cancel: () => { revision++; controller.abort(); rejectCode(new Error(provider + ' sign-in cancelled.')); } };
    status.set(id, { state: 'authorizing', note: 'Choose your account and authorize REACH Studio in the browser.' });
    try {
      const host = google ? '127.0.0.1' : 'localhost';
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(id === 'slack' ? 53683 : 0, host, resolve); });
      const redirect = `http://${host}:${server.address().port}/oauth/callback`;
      server.on('request', (request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        let url;
        try { url = new URL(request.url, redirect); }
        catch { response.writeHead(400).end('Invalid sign-in response.'); return; }
        if (request.method !== 'GET' || url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid sign-in response.'); return; }
        if (url.searchParams.has('error')) { response.end('Sign-in cancelled. Return to REACH Studio.'); rejectCode(new Error(provider + ' sign-in was declined.')); return; }
        const code = url.searchParams.get('code');
        if (!code) { response.writeHead(400).end('Missing authorization code.'); return; }
        response.end('Sign-in received. Return to SignalREACH to check the connection.'); resolveCode(code);
      });
      timeout = setTimeout(() => { controller.abort(); rejectCode(new Error(provider + ' sign-in timed out. Try again.')); }, 180000);
      const url = new URL(google ? 'https://accounts.google.com/o/oauth2/v2/auth' : microsoft ? 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' : 'https://slack.com/oauth/v2/authorize');
      const scopes = google ? [GOOGLE_SCOPES[id]] : microsoft ? [MICROSOFT_SCOPES[id], 'offline_access'] : ['search:read'];
      if (id === 'gmail' && allowSend) scopes.push('https://www.googleapis.com/auth/gmail.send');
      for (const [key, value] of Object.entries({ client_id: config.clientId, redirect_uri: redirect, response_type: 'code', state,
        code_challenge: challenge, code_challenge_method: 'S256', ...(google ? { scope: scopes.join(' '), access_type: 'offline', prompt: 'select_account consent' } : microsoft ? { scope: scopes.join(' '), prompt: 'select_account' } : { user_scope: scopes.join(',') }) })) url.searchParams.set(key, value);
      await openExternal(url.href);
      const code = await result;
      const body = new URLSearchParams({ client_id: config.clientId, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' });
      if (google && config.clientSecret) body.set('client_secret', config.clientSecret);
      const endpoint = google ? 'https://oauth2.googleapis.com/token' : microsoft ? 'https://login.microsoftonline.com/common/oauth2/v2.0/token' : 'https://slack.com/api/oauth.v2.access';
      const data = await require('./oauth-grants.cjs').postToken(endpoint, body, { signal: controller.signal });
      const tokens = id === 'slack' ? data.authed_user || data : data;
      if (!tokens.access_token || !tokens.refresh_token) throw new Error(provider + ' did not complete authorization with token renewal. Check the application configuration and try again.');
      const requested = (google ? GOOGLE_SCOPES[id] : microsoft ? MICROSOFT_SCOPES[id] : 'search:read').split('/').at(-1).toLowerCase();
      if (!String(tokens.scope || '').split(/[ ,]+/).some(scope => scope.split('/').at(-1).toLowerCase() === requested)) throw new Error('The required ' + provider + ' permission was not granted. Connect again and allow this app.');
      const grant = require('./oauth-grants.cjs').tokenGrant(tokens);
      const connected = { ...config, ...grant, enabled: true, token: '', password: '' };
      let note = provider + ' connected; token renewal enabled';
      if (id === 'gmail') { const profile = await gmailFetch(connected, 'profile', { signal: controller.signal }); connected.email = profile.emailAddress; note = profile.emailAddress; }
      else if (id === 'outlook') await outlookFetch(connected, '/messages?$top=1&$select=id', { signal: controller.signal });
      else await require('./extra-apps.cjs').checkConnection(id, connected, { signal: controller.signal });
      if (version !== revision) throw new Error('The connection changed during sign-in. Connect again.');
      const settings = getSettings();
      saveSettings({ ...settings, plugins: { ...settings.plugins, [id]: { ...settings.plugins?.[id], ...connected } } });
      status.set(id, { state: 'connected', note, checkedAt: Date.now() });
      pending = null;
      return catalog();
    } catch (error) { status.set(id, { state: 'error', note: error.message }); throw error; }
    finally { clearTimeout(timeout); server.close(); server.closeAllConnections(); pending = null; }
  }
  const connectGoogle = options => {
    if (options?.id && !Object.hasOwn(GOOGLE_SCOPES, options.id)) throw new Error('Unknown Google app connection.');
    return connectAuthorization(options);
  };
  const connectGmail = options => connectGoogle({ ...options, id: 'gmail' });
  async function connectHosted(id) {
    if (pending) throw new Error('Sign-in is already open. Finish or cancel it first.');
    const storage = getSettings().credentialStorage;
    if (storage?.encrypted !== true || storage.locked) throw new Error('Unlock your system credential vault before connecting.');
    const controller = new AbortController(), version = revision;
    const timeout = setTimeout(() => controller.abort(), 600000);
    pending = { id, cancel: () => { revision++; controller.abort(); } };
    status.set(id, { state: 'authorizing', note: 'Choose your own account and authorize REACH Studio in the browser.' });
    try {
      const grant = await require('./oauth-grants.cjs').authorizeHosted({ id, registration: clients[id], openExternal, signal: controller.signal });
      const connected = { ...plugins()[id], ...grant, clientId: clients[id].clientId, enabled: true, token: '' };
      // A stale channel must not discard a successful account authorization.
      await require('./extra-apps.cjs').checkConnection(id, id === 'discord' ? { ...connected, channel: '' } : connected, { signal: controller.signal, clients });
      if (version !== revision) throw new Error('The connection changed during sign-in. Connect again.');
      const settings = getSettings();
      saveSettings({ ...settings, plugins: { ...settings.plugins, [id]: connected } });
      status.set(id, { state: 'connected', note: id === 'discord' ? 'Discord authorized. Enable chat for DMs and mentions in any accessible server text channel.' : 'Connected; automatic token renewal enabled', checkedAt: Date.now() });
      pending = null; return catalog();
    } catch (error) {
      const note = controller.signal.aborted ? 'Sign-in cancelled or timed out.' : error.message;
      status.set(id, { state: 'error', note }); throw new Error(note);
    } finally { clearTimeout(timeout); pending = null; }
  }
  async function connectGithub() {
    if (pending) throw new Error('Sign-in is already open. Finish or cancel it first.');
    const storage = getSettings().credentialStorage;
    if (storage?.encrypted !== true || storage.locked) throw new Error('Unlock your system credential vault before connecting GitHub.');
    const clientId = clients.github?.clientId;
    if (!clientId) throw new Error('This build does not include the REACH GitHub registration. A personal access token can be saved instead.');
    const controller = new AbortController(), version = revision;
    const timeout = setTimeout(() => controller.abort(), 900000);
    pending = { id: 'github', cancel: () => { revision++; controller.abort(); } };
    try {
      const grant = await require('./oauth-grants.cjs').authorizeGithubDevice({ clientId, openExternal, signal: controller.signal,
        onCode: code => status.set('github', { state: 'authorizing', note: 'In the GitHub page, enter code ' + code + ', choose your account, and authorize REACH Studio.' }),
      });
      const connected = { ...grant, clientId, enabled: true, token: '' };
      const result = await require('./plugins.cjs').testPlugin('github', connected);
      if (!result.ok) throw new Error(result.err);
      if (version !== revision) throw new Error('The connection changed during sign-in. Connect again.');
      const settings = getSettings();
      saveSettings({ ...settings, plugins: { ...settings.plugins, github: { ...settings.plugins?.github, ...connected, username: result.user.login } } });
      status.set('github', { state: 'connected', note: result.user.login, checkedAt: Date.now() });
      pending = null;
      return catalog();
    } catch (error) {
      const note = controller.signal.aborted ? 'GitHub sign-in cancelled or timed out.' : error.message;
      status.set('github', { state: 'error', note });
      throw new Error(note);
    } finally { clearTimeout(timeout); pending = null; }
  }
  return { catalog, save, check, disconnect, connectGmail, connectGoogle, connectAuthorization, connectGithub, cancel, destroy: cancel };
}
module.exports = { createAppConnections };
