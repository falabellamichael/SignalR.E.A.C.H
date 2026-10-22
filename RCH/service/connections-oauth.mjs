import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createDiscordChatServer } from './discord-chat.mjs';

const providers = {
  notion: { authorize: 'https://api.notion.com/v1/oauth/authorize', token: 'https://api.notion.com/v1/oauth/token' },
  slack: { authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access' },
  discord: { authorize: 'https://discord.com/oauth2/authorize', token: 'https://discord.com/api/oauth2/token' },
};
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/\s/.test(value);
const fail = (status, message, details = {}) => { throw Object.assign(new Error(message), { status, ...details }); };
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
function authorizationPage(res, id, error = '') {
  const provider = { discord: 'Discord', slack: 'Slack', notion: 'Notion' }[id];
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const title = provider + (error ? ' connection needs attention' : ' authorization received');
  const message = error || 'Your ' + provider + ' account has authorized REACH. Studio is finishing the connection automatically.';
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.writeHead(error ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) + ' · REACH Studio</title><style>body{font:18px/1.6 system-ui,sans-serif;background:#f7f1de;color:#403b2c;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:36rem;padding:2rem}h1{font-size:1.8rem}small{color:#73664a}</style><main><small>REACH STUDIO</small><h1>' + escape(title) + '</h1><p>' + escape(message) + '</p><p>Return to REACH Studio. The app will come forward when it finishes. You can close this tab once Studio shows Connected.</p></main></html>');
}

export function validateOAuthClients(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid connection registrations.');
  for (const [id, value] of Object.entries(input)) {
    if (!Object.hasOwn(providers, id) || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['clientId', 'clientSecret', ...(id === 'discord' ? ['botToken'] : [])].includes(key))) throw new Error('Invalid connection registration fields.');
    if (!/^[A-Za-z0-9._-]{3,256}$/.test(value.clientId || '') || !validToken(value.clientSecret) || id === 'discord' && !validToken(value.botToken)) throw new Error('Incomplete connection registration.');
  }
  return input;
}

// Discord's bot may see more than the signed-in customer. Evaluate the customer's
// current roles and channel overwrites before every read; never trust desktop IDs.
export function canReadDiscordChannel({ userId, member, guild, roles, channel }) {
  if (!userId || !member || !Array.isArray(member.roles) || channel.guild_id !== guild.id || ![0, 5].includes(channel.type)) return false;
  if (guild.owner_id === userId) return true;
  const everyone = roles.find(role => role.id === guild.id);
  if (!everyone || !Array.isArray(channel.permission_overwrites)) return false;
  let permissions = BigInt(everyone.permissions);
  for (const role of roles) if (member.roles.includes(role.id)) permissions |= BigInt(role.permissions);
  if (permissions & 8n) return true;
  const overwrites = channel.permission_overwrites;
  const base = overwrites.find(overwrite => overwrite.type === 0 && overwrite.id === guild.id);
  if (base) permissions = (permissions & ~BigInt(base.deny)) | BigInt(base.allow);
  let deny = 0n, allow = 0n;
  for (const overwrite of overwrites) if (overwrite.type === 0 && member.roles.includes(overwrite.id)) { deny |= BigInt(overwrite.deny); allow |= BigInt(overwrite.allow); }
  permissions = (permissions & ~deny) | allow;
  const own = overwrites.find(overwrite => overwrite.type === 1 && overwrite.id === userId);
  if (own) permissions = (permissions & ~BigInt(own.deny)) | BigInt(own.allow);
  return (permissions & 66560n) === 66560n; // View Channel + Read Message History
}

export function createConnectionsOAuth({ origin, clients = {}, fetchImpl = fetch, now = Date.now, discordSocketFactory, discordPollMs }) {
  validateOAuthClients(clients);
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin) throw new Error('Connections require an HTTPS service origin.');
  const flows = new Map();
  const prune = () => { for (const [id, flow] of flows) if (flow.expires <= now()) flows.delete(id); };
  const timer = setInterval(prune, 60000); timer.unref();
  async function providerJson(url, options) {
    const endpoint = new URL(url), diagnostic = endpoint.hostname + endpoint.pathname.replace(/\d{10,22}/g, ':id');
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { console.info('App connection provider unavailable: ' + diagnostic); fail(502, 'The connection provider is unavailable. Try again shortly.'); }
    const raw = await response.text();
    if (raw.length > 2 * 1024 * 1024) fail(502, 'The connection response is too large.');
    let data; try { data = JSON.parse(raw); } catch { fail(502, 'The provider returned an invalid response.'); }
    if (!response.ok || !data || data.error || data.ok === false) {
      if (![401, 403, 404].includes(response.status)) console.info('App connection provider refused request: ' + diagnostic + ' (HTTP ' + response.status + ').');
      if (response.status === 429) fail(429, 'The provider is limiting connection requests. Wait before trying again.', { retryAfter: Math.max(1, Math.min(3600, Math.ceil(Number(data.retry_after) || Number(response.headers?.get?.('retry-after')) || 30))) });
      fail([401, 403, 404].includes(response.status) ? response.status : 502, 'The provider refused this connection request. Reconnect and check its permissions.');
    }
    return data;
  }
  async function grant(id, fields) {
    const client = clients[id], notion = id === 'notion';
    const headers = { Accept: 'application/json', 'Content-Type': notion ? 'application/json' : 'application/x-www-form-urlencoded' };
    if (notion) {
      headers.Authorization = 'Basic ' + Buffer.from(client.clientId + ':' + client.clientSecret).toString('base64');
      headers['Notion-Version'] = '2026-03-11';
    }
    const body = notion ? JSON.stringify(fields) : new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...fields });
    const data = await providerJson(providers[id].token, { method: 'POST', headers, body });
    const tokens = id === 'slack' ? data.authed_user || data : data;
    if (!validToken(tokens.access_token) || !validToken(tokens.refresh_token)) fail(502, 'The provider did not issue a renewable authorization.');
    const required = id === 'slack' ? ['search:read'] : id === 'discord' ? ['identify', 'guilds.members.read'] : [];
    const scopes = String(tokens.scope || '').split(/[ ,]+/);
    if (!required.every(scope => scopes.includes(scope))) fail(403, 'The required connection permissions were not granted.');
    return { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: Number.isFinite(Number(tokens.expires_in)) && Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 3600, scope: typeof tokens.scope === 'string' ? tokens.scope : '' };
  }
  const discordApi = (route, token, bot = false, options = {}) => providerJson('https://discord.com/api/v10/' + route, { ...options, headers: { ...options.headers, Authorization: (bot ? 'Bot ' : 'Bearer ') + token } });
  async function discordIdentity(body) {
    if (!validToken(body.accessToken)) fail(400, 'A Discord authorization is required.');
    const auth = await discordApi('oauth2/@me', body.accessToken);
    if (auth.application?.id !== clients.discord.clientId || !auth.user?.id || !auth.scopes?.includes('guilds.members.read')) fail(403, 'Authorize the REACH Discord application first.');
    return auth;
  }
  async function discordChannelInfo(id) {
    if (!/^\d{10,22}$/.test(id || '')) fail(400, 'Enter the Discord text channel ID in Connections.');
    const channel = await discordApi('channels/' + id, clients.discord.botToken, true);
    if (!/^\d{10,22}$/.test(channel.guild_id || '') || ![0, 5].includes(channel.type)) fail(403, 'Choose a server text or announcement channel. Direct messages and threads are not supported.');
    return channel;
  }
  async function discordChannel(body, auth) {
    const channel = await discordChannelInfo(body.channel);
    const bot = clients.discord.botToken, guild = await discordApi('guilds/' + channel.guild_id, bot, true);
    if (guild.owner_id === auth.user.id) return channel;
    const [member, roles] = await Promise.all([
      discordApi('users/@me/guilds/' + channel.guild_id + '/member', body.accessToken),
      discordApi('guilds/' + channel.guild_id + '/roles', bot, true),
    ]);
    if (!canReadDiscordChannel({ userId: auth.user.id, member, guild, roles, channel })) fail(403, 'Your Discord account cannot read this channel.');
    return channel;
  }
  async function discordRead(body) {
    const auth = await discordIdentity(body);
    if (body.operation === 'check') return { connected: true };
    await discordChannel(body, auth);
    const limit = Math.max(1, Math.min(20, Math.trunc(Number(body.limit) || 5)));
    return { messages: await discordApi('channels/' + body.channel + '/messages?limit=' + limit, clients.discord.botToken, true) };
  }
  const discordChat = clients.discord ? createDiscordChatServer({ applicationId: clients.discord.clientId, botToken: clients.discord.botToken, api: (route, options) => discordApi(route, clients.discord.botToken, true, options), now, socketFactory: discordSocketFactory, pollMs: discordPollMs }) : null;
  async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Use application/json.');
    let raw = '', length = 0;
    for await (const part of req) { length += part.length; if (length > 24576) fail(413, 'Connection request is too large.'); raw += part; }
    let value; try { value = JSON.parse(raw); } catch { fail(400, 'Invalid connection request.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid connection request.');
    return value;
  }
  async function handle(req, res) {
    const url = new URL(req.url, origin), match = /^\/oauth\/(notion|slack|discord)\/(start|exchange|refresh|cancel|callback|read|chat-poll|chat-reply|chat-close)$/.exec(url.pathname);
    if (!match) return false;
    res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const [, id, action] = match;
      if (!clients[id]) fail(503, 'This REACH connection is awaiting publisher setup.');
      if (req.method !== (action === 'callback' ? 'GET' : 'POST')) fail(405, 'Unsupported connection request.');
      prune();
      if (action === 'callback') {
        const flow = [...flows.values()].find(value => value.state === url.searchParams.get('state') && value.provider === id);
        if (!flow || flow.received) { authorizationPage(res, id, 'This authorization response is invalid or expired. Return to Studio and reconnect.'); return true; }
        flow.received = true;
        try {
          if (url.searchParams.has('error')) fail(400, 'Authorization was declined.');
          const code = url.searchParams.get('code');
          if (!validToken(code) || code.length > 4096) fail(400, 'Missing authorization code.');
          flow.grant = await grant(id, { grant_type: 'authorization_code', code, redirect_uri: origin + '/oauth/' + id + '/callback', ...(id === 'slack' ? { code_verifier: flow.providerVerifier } : {}) });
        } catch { flow.error = 'Authorization did not complete. Return to Studio and connect again.'; }
        delete flow.providerVerifier;
        authorizationPage(res, id, flow.error); return true;
      }
      const input = await body(req);
      if (action === 'start') {
        if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge || '')) fail(400, 'A connection proof is required.');
        if (flows.size >= 1000) fail(503, 'Too many sign-ins are pending. Try again shortly.');
        const flowId = random(), state = random(), verifier = randomBytes(48).toString('base64url');
        flows.set(flowId, { provider: id, state, challenge: input.codeChallenge, providerVerifier: verifier, expires: now() + 600000 });
        const auth = new URL(providers[id].authorize);
        const parameters = { client_id: clients[id].clientId, redirect_uri: origin + '/oauth/' + id + '/callback', response_type: 'code', state,
          ...(id === 'notion' ? { owner: 'user' } : id === 'slack' ? { user_scope: 'search:read', code_challenge: hash(verifier), code_challenge_method: 'S256' } : { scope: 'identify guilds.members.read bot', permissions: '8', prompt: 'consent' }) };
        for (const [key, value] of Object.entries(parameters)) auth.searchParams.set(key, value);
        json(res, 200, { flowId, authorizeUrl: auth.href }); return true;
      }
      if (action === 'exchange' || action === 'cancel') {
        const flow = flows.get(input.flowId);
        if (!flow || flow.provider !== id) fail(404, 'This sign-in expired. Connect again.');
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.verifier || '') || !timingSafeEqual(Buffer.from(hash(input.verifier)), Buffer.from(flow.challenge))) fail(403, 'The connection proof does not match.');
        if (action === 'cancel') { flows.delete(input.flowId); json(res, 200, { cancelled: true }); return true; }
        if (flow.error) { flows.delete(input.flowId); fail(400, flow.error); }
        if (!flow.grant) { json(res, 200, { pending: true }); return true; }
        flows.delete(input.flowId); json(res, 200, flow.grant); return true;
      }
      if (action === 'refresh') {
        if (!validToken(input.refreshToken)) fail(400, 'A refresh token is required.');
        json(res, 200, await grant(id, { grant_type: 'refresh_token', refresh_token: input.refreshToken })); return true;
      }
      if (action === 'read' && id === 'discord') { json(res, 200, await discordRead(input)); return true; }
      if (id === 'discord' && action.startsWith('chat-')) {
        const auth = await discordIdentity(input);
        const result = action === 'chat-poll' ? await discordChat.poll(auth.user.id, input, res) : action === 'chat-reply' ? await discordChat.reply(auth.user.id, input) : discordChat.disconnect(auth.user.id, input);
        // Idle polls contain no customer messages. Check current membership only
        // when delivering a server message, avoiding Discord's narrow member quota.
        if (action === 'chat-poll' && result.job?.guildId) try { await discordChannel({ ...input, channel: result.job.channel }, auth); }
        catch (error) {
          if (![400, 403, 404].includes(error.status)) throw error;
          // An inaccessible message must not block other channels or remain
          // available as a reply target after its permission check failed.
          discordChat.discard(auth.user.id, { bridgeId: input.bridgeId, jobId: result.job.id });
          delete result.job; result.pending = true;
          result.channelWarning = 'A Discord message could not be delivered. Use a server text channel that you and REACH can access.';
        }
        if (!res.destroyed) json(res, 200, result); return true;
      }
      fail(404, 'Connection route not found.');
    } catch (error) {
      if (!error.status || error.status === 502) console.info('App connection failed: ' + match[1] + '/' + match[2] + ' ' + (error.status ? error.message : String(error.stack || '').split('\n').slice(1, 4).join(' ')));
      if (error.retryAfter) res.setHeader('retry-after', String(error.retryAfter));
      json(res, error.status || 502, { error: error.status ? error.message : 'The connection service is unavailable. Try again shortly.', ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
    }
    return true;
  }
  return { handle, close() { clearInterval(timer); flows.clear(); discordChat?.close(); } };
}
