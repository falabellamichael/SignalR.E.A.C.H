import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createConnectionsOAuth, canReadDiscordChannel, validateOAuthClients } from '../service/connections-oauth.mjs';

const origin = 'https://connections.example';
const proof = () => { const verifier = randomBytes(48).toString('base64url'); return { verifier, codeChallenge: createHash('sha256').update(verifier).digest('base64url') }; };
const reply = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
async function fixture(t, options = {}) {
  const broker = createConnectionsOAuth({ origin, clients: { notion: { clientId: 'fixture-notion', clientSecret: 'fixture-secret' }, slack: { clientId: 'fixture-slack', clientSecret: 'fixture-secret' }, discord: { clientId: 'fixture-discord', clientSecret: 'fixture-secret', botToken: 'fixture-bot' } }, ...options });
  const server = createServer(async (req, res) => { if (!await broker.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { broker.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { post: async (id, action, body) => { const r = await fetch(local + '/oauth/' + id + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }, callback: url => fetch(local + new URL(url).pathname + new URL(url).search) };
}

test('hosted OAuth binds state, provider and desktop proof, consumes each grant once, and never reflects credentials', async t => {
  let exchanges = 0;
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    exchanges++;
    assert.equal(url, 'https://api.notion.com/v1/oauth/token');
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('fixture-notion:fixture-secret').toString('base64'));
    assert.equal(options.headers['Notion-Version'], '2026-03-11');
    assert.equal(JSON.parse(options.body).redirect_uri, origin + '/oauth/notion/callback');
    return reply({ access_token: 'fixture-customer-access', refresh_token: 'fixture-customer-refresh' });
  } });
  const p = proof(), flow = (await f.post('notion', 'start', p)).body, auth = new URL(flow.authorizeUrl);
  assert.equal(auth.searchParams.get('owner'), 'user');
  assert.equal(JSON.stringify(flow).includes('fixture-secret'), false);
  const callback = new URL(auth.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', 'wrong'); callback.searchParams.set('code', 'fixture-code');
  assert.equal((await f.callback(callback)).status, 400);
  assert.equal(exchanges, 0);
  callback.searchParams.set('state', auth.searchParams.get('state'));
  const accepted = await f.callback(callback);
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get('content-type'), /text\/html/);
  assert.equal((await accepted.text()).includes('fixture-customer'), false);
  assert.equal((await f.callback(callback)).status, 400);
  assert.equal(exchanges, 1);
  assert.equal((await f.post('notion', 'exchange', { flowId: flow.flowId, verifier: proof().verifier })).status, 403);
  assert.equal((await f.post('slack', 'exchange', { flowId: flow.flowId, verifier: p.verifier })).status, 404);
  const result = await f.post('notion', 'exchange', { flowId: flow.flowId, verifier: p.verifier });
  assert.equal(result.body.access_token, 'fixture-customer-access');
  assert.equal((await f.post('notion', 'exchange', { flowId: flow.flowId, verifier: p.verifier })).status, 404);
});

test('expired and cancelled flows cannot authorize, provider errors are static, and refresh stays on fixed provider endpoints', async t => {
  let time = 1000, calls = 0;
  const f = await fixture(t, { now: () => time, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://slack.com/api/oauth.v2.access');
    assert.equal(options.body.get('refresh_token'), 'fixture-refresh');
    return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'fixture-secret-must-not-leak' }) };
  } });
  const p = proof(), flow = (await f.post('notion', 'start', p)).body;
  time += 600001;
  assert.equal((await f.post('notion', 'exchange', { flowId: flow.flowId, verifier: p.verifier })).status, 404);
  const second = (await f.post('notion', 'start', p)).body;
  assert.equal((await f.post('notion', 'cancel', { flowId: second.flowId, verifier: p.verifier })).status, 200);
  const callback = new URL(new URL(second.authorizeUrl).searchParams.get('redirect_uri')); callback.searchParams.set('state', new URL(second.authorizeUrl).searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
  assert.equal((await f.callback(callback)).status, 400);
  const failed = await f.post('slack', 'refresh', { refreshToken: 'fixture-refresh', endpoint: 'https://attacker.example' });
  assert.equal(failed.status, 502); assert.equal(JSON.stringify(failed).includes('must-not-leak'), false); assert.equal(calls, 1);
});

test('Discord channel access follows current customer roles and overrides, and rejects private threads and DMs', () => {
  const base = { userId: 'user', member: { roles: ['reader'] }, guild: { id: 'guild', owner_id: 'owner' }, roles: [{ id: 'guild', permissions: '0' }, { id: 'reader', permissions: '66560' }], channel: { guild_id: 'guild', type: 0, permission_overwrites: [] } };
  assert.equal(canReadDiscordChannel(base), true);
  const denied = { ...base, channel: { ...base.channel, permission_overwrites: [{ type: 1, id: 'user', deny: '1024', allow: '0' }] } };
  assert.equal(canReadDiscordChannel(denied), false);
  assert.equal(canReadDiscordChannel({ ...base, member: { roles: [] } }), false);
  assert.equal(canReadDiscordChannel({ ...base, channel: { ...base.channel, type: 12 } }), false);
  assert.equal(canReadDiscordChannel({ ...base, channel: { ...base.channel, guild_id: undefined, type: 1 } }), false);
  assert.equal(canReadDiscordChannel({ ...denied, userId: 'owner' }), true);
});

test('Discord proxy refuses another application token or unauthorized customer before fetching messages', async t => {
  let mode = 'other-app'; const routes = [];
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    routes.push(url);
    if (url.endsWith('oauth2/@me')) { assert.equal(options.headers.Authorization, 'Bearer fixture-customer'); return reply({ application: { id: mode === 'other-app' ? 'other-client' : 'fixture-discord' }, user: { id: 'customer' }, scopes: ['guilds.members.read', 'identify'] }); }
    assert.equal(options.headers.Authorization, url.includes('/member') ? 'Bearer fixture-customer' : 'Bot fixture-bot');
    if (url.includes('/channels/')) return reply({ id: '123456789012', guild_id: '223456789012', type: 0, permission_overwrites: [] });
    if (url.endsWith('/member')) return reply({ roles: [] });
    if (url.endsWith('/roles')) return reply([{ id: '223456789012', permissions: '0' }]);
    return reply({ id: '223456789012', owner_id: 'someone-else' });
  } });
  const input = { accessToken: 'fixture-customer', channel: '123456789012', limit: 5 };
  assert.equal((await f.post('discord', 'read', input)).status, 403);
  assert.equal(routes.length, 1);
  mode = 'right-app';
  assert.equal((await f.post('discord', 'read', input)).status, 403);
  assert.equal(routes.some(route => route.includes('/messages')), false);
});

test('private registration rejects owner grants and incomplete bot configuration', () => {
  assert.throws(() => validateOAuthClients({ notion: { clientId: 'client', clientSecret: 'secret', refreshToken: 'owner' } }));
  assert.throws(() => validateOAuthClients({ discord: { clientId: 'client', clientSecret: 'secret' } }));
});

test('Discord chat HTTP routes require this application and bind the desktop session to its authenticated user', async t => {
  let foreign = true, gatewayCalls = 0;
  class Socket extends EventTarget { readyState = 1; send() {} close() { this.readyState = 3; const event = new Event('close'); Object.defineProperty(event, 'code', { value: 1000 }); this.dispatchEvent(event); } }
  const f = await fixture(t, { discordPollMs: 2, discordSocketFactory: () => new Socket(), fetchImpl: async url => {
    if (url.endsWith('oauth2/@me')) return reply({ application: { id: foreign ? 'another-application' : 'fixture-discord' }, user: { id: '223456789012' }, scopes: ['identify', 'guilds.members.read'] });
    if (url.includes('/channels/')) return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'Unknown channel' }) };
    assert.ok(url.endsWith('/gateway/bot')); gatewayCalls++; return reply({ url: 'wss://gateway.discord.gg' });
  } });
  const input = { accessToken: 'fixture-customer', bridgeId: randomUUID(), channel: '' };
  assert.equal((await f.post('discord', 'chat-poll', input)).status, 403); assert.equal(gatewayCalls, 0);
  foreign = false;
  const connected = await f.post('discord', 'chat-poll', input); assert.equal(connected.status, 200); assert.equal(connected.body.userId, '223456789012');
  const withReadDefault = await f.post('discord', 'chat-poll', { ...input, channel: '423456789012' }); assert.equal(withReadDefault.status, 200); assert.equal(withReadDefault.body.channelWarning, undefined);
  assert.equal((await f.post('discord', 'chat-poll', { ...input, bridgeId: randomUUID() })).status, 409);
  assert.equal((await f.post('discord', 'chat-reply', { ...input, jobId: '999999999999', replyId: randomUUID(), content: 'forged reply' })).status, 404);
  assert.equal((await f.post('discord', 'chat-close', input)).status, 200);
});

test('idle Discord polls preserve the membership quota and check current access before delivering a guild message', async t => {
  let socket, memberCalls = 0, allowed = true;
  const checkedChannels = [];
  const owner = '223456789012', channel = '423456789012', guild = '623456789012';
  class Socket extends EventTarget {
    readyState = 1;
    send() {}
    packet(d) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d }) })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const f = await fixture(t, { discordPollMs: 2, discordSocketFactory: () => socket = new Socket(), fetchImpl: async url => {
    if (url.endsWith('oauth2/@me')) return reply({ application: { id: 'fixture-discord' }, user: { id: owner }, scopes: ['identify', 'guilds.members.read'] });
    if (url.includes('/channels/')) { const id = url.split('/').at(-1); checkedChannels.push(id); return reply({ id, guild_id: guild, type: 0, permission_overwrites: [] }); }
    if (url.endsWith('/guilds/' + guild)) return reply({ id: guild, owner_id: 'another-owner' });
    if (url.endsWith('/member')) { memberCalls++; return reply({ roles: allowed ? ['reader'] : [] }); }
    if (url.endsWith('/roles')) return reply([{ id: guild, permissions: '0' }, { id: 'reader', permissions: '66560' }]);
    assert.ok(url.endsWith('/gateway/bot')); return reply({ url: 'wss://gateway.discord.gg' });
  } });
  const input = { accessToken: 'fixture-customer', bridgeId: randomUUID(), channel };
  assert.equal((await f.post('discord', 'chat-poll', input)).status, 200);
  assert.equal((await f.post('discord', 'chat-poll', input)).status, 200);
  assert.equal(memberCalls, 0, 'Empty polls must not consume the member endpoint quota');
  const actualChannel = '823456789012';
  const message = { id: '523456789012', channel_id: actualChannel, guild_id: guild, author: { id: owner }, mentions: [{ id: 'fixture-discord' }], content: '<@fixture-discord> hello' };
  socket.packet(message);
  const received = await f.post('discord', 'chat-poll', input);
  assert.equal(received.status, 200); assert.equal(received.body.job.text, 'hello'); assert.equal(memberCalls, 1);
  assert.deepEqual(checkedChannels, [actualChannel], 'Check the message channel, not the saved read default');
  await f.post('discord', 'chat-reply', { ...input, jobId: message.id, ack: true });
  allowed = false; socket.packet({ ...message, id: '723456789012' });
  const denied = await f.post('discord', 'chat-poll', input);
  assert.equal(denied.status, 200); assert.equal(denied.body.job, undefined); assert.equal(memberCalls, 2);
  assert.match(denied.body.channelWarning, /could not be delivered/);
  assert.equal((await f.post('discord', 'chat-reply', { ...input, jobId: '723456789012', replyId: randomUUID(), content: 'Unauthorized reply' })).status, 404);
  allowed = true; socket.packet({ ...message, id: '923456789012', channel_id: '1023456789012' });
  assert.equal((await f.post('discord', 'chat-poll', input)).body.job.channel, '1023456789012', 'A denied channel must not block other conversations');
});

test('Discord server owners avoid redundant member checks and upstream rate limits retain the retry delay', async t => {
  const owner = '223456789012', channel = '423456789012', guild = '623456789012';
  let serverOwner = owner, memberCalls = 0;
  const f = await fixture(t, { fetchImpl: async url => {
    if (url.endsWith('oauth2/@me')) return reply({ application: { id: 'fixture-discord' }, user: { id: owner }, scopes: ['identify', 'guilds.members.read'] });
    if (url.endsWith('/channels/' + channel)) return reply({ id: channel, guild_id: guild, type: 0, permission_overwrites: [] });
    if (url.endsWith('/guilds/' + guild)) return reply({ id: guild, owner_id: serverOwner });
    if (url.endsWith('/member')) { memberCalls++; return { ok: false, status: 429, text: async () => JSON.stringify({ retry_after: 46.2, message: 'fixture-private-provider-error' }) }; }
    if (url.endsWith('/roles') || url.includes('/messages')) return reply([]);
    throw new Error('Unexpected fixture endpoint');
  } });
  const input = { accessToken: 'fixture-customer', channel };
  assert.equal((await f.post('discord', 'read', input)).status, 200); assert.equal(memberCalls, 0);
  serverOwner = 'another-owner';
  const limited = await f.post('discord', 'read', input);
  assert.equal(limited.status, 429); assert.equal(limited.body.retryAfter, 47);
  assert.equal(JSON.stringify(limited).includes('fixture-private-provider-error'), false);
});
