'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAppConnections } = require('../agent/app-connections.cjs');
const { validateClients } = require('../agent/oauth-clients.cjs');
const { authorizeGithubDevice, githubToken, configureGrantStore, brokerRequest } = require('../agent/oauth-grants.cjs');
const reply = data => ({ ok: true, status: 200, json: async () => data });

test('hosted connection errors preserve rate-limit metadata without exposing provider details', async () => {
  await assert.rejects(brokerRequest('discord', { brokerOrigin: 'https://fixture.example' }, 'chat-poll', {}, { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ retryAfter: 46.2, error: 'fixture-secret' }) }) }), error => error.status === 429 && error.retryAfter === 47 && !error.message.includes('fixture-secret'));
});

test('hosted Slack, Notion and Discord complete with a customer proof, use server secrets, and preserve manual tokens', async t => {
  const { createConnectionsOAuth } = await import('../../RCH/service/connections-oauth.mjs');
  const { createServer } = require('node:http');
  const originalFetch = global.fetch, origin = 'https://broker.fixture';
  const clients = Object.fromEntries(['slack','notion','discord'].map(id => [id, { clientId: 'fixture-' + id, brokerOrigin: origin }]));
  const serverClients = Object.fromEntries(Object.entries(clients).map(([id,value]) => [id,{clientId:value.clientId,clientSecret:'fixture-server-secret',...(id==='discord'?{botToken:'fixture-bot'}:{})}]));
  const broker = createConnectionsOAuth({ origin, clients: serverClients, fetchImpl: async url => {
    if (String(url).endsWith('oauth2/@me')) return { ...reply({ application:{id:clients.discord.clientId},user:{id:'fixture-user'},scopes:['identify','guilds.members.read'] }), text:async()=>JSON.stringify({ application:{id:clients.discord.clientId},user:{id:'fixture-user'},scopes:['identify','guilds.members.read'] }) };
    const scope = String(url).includes('slack') ? 'search:read' : String(url).includes('discord') ? 'identify guilds.members.read bot' : '';
    const tokens = {access_token:'fixture-customer',refresh_token:'fixture-renew',expires_in:3600,scope};
    return { ...reply(tokens), text: async () => JSON.stringify(String(url).includes('slack')?{ok:true,authed_user:tokens}:tokens) };
  } });
  const server = createServer((req,res)=>broker.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const local='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{global.fetch=originalFetch;broker.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  global.fetch=async(url,options)=>{
    if(String(url).startsWith(origin))return originalFetch(String(url).replace(origin,local),options);
    assert.equal(options.headers.Authorization,'Bearer fixture-customer');
    const data=String(url).includes('slack')?{ok:true}:{results:[]};
    return {...reply(data),text:async()=>JSON.stringify(data)};
  };
  for(const id of ['slack','notion','discord']){
    let settings={credentialStorage:{encrypted:true},plugins:id==='discord'?{discord:{channel:'423456789012'}}:{}};
    const apps=createAppConnections({clients,getSettings:()=>settings,saveSettings:next=>{settings=next;},openExternal:async value=>{
      const url=new URL(value),callback=new URL(url.searchParams.get('redirect_uri'));
      assert.equal(url.searchParams.get('client_id'),clients[id].clientId);
      if (id === 'discord') assert.equal(url.searchParams.get('permissions'), '8');
      assert.equal(url.searchParams.has('client_secret'),false);
      callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','fixture-code');
      assert.equal((await originalFetch(callback.href.replace(origin,local))).status,200);
    }});
    const result=await apps.connectAuthorization({id});
    assert.equal(result.find(item=>item.id===id).status.state,'connected');
    assert.equal(settings.plugins[id].accessToken,'fixture-customer');
    assert.equal(settings.plugins[id].clientSecret,undefined);
    if (id === 'discord') assert.equal(settings.plugins.discord.channel, '423456789012', 'A saved channel is retained without blocking account authorization');
    apps.save(id,{token:'Bearer fixture-manual',enabled:true});
    assert.equal(settings.plugins[id].token,'fixture-manual');
    assert.equal(settings.plugins[id].refreshToken,undefined);
    apps.destroy();
  }
});

test('Microsoft and Slack use PKCE callbacks, reject wrong state, and persist each customer grant', async () => {
  const originalFetch = global.fetch;
  try {
    for (const id of ['outlook', 'todo', 'slack']) {
      let settings = { credentialStorage: { encrypted: true }, plugins: {} }, authorization;
      let verifier;
      const scope = id === 'outlook' ? 'Mail.Read' : id === 'todo' ? 'Tasks.ReadWrite' : 'search:read';
      global.fetch = async (url, options = {}) => {
        if (String(url).includes('/oauth2/v2.0/token') || String(url).includes('/oauth.v2.access')) {
          assert.equal(options.body.get('client_secret'), null);
          verifier = options.body.get('code_verifier');
          const data = { access_token: 'fixture-' + id, refresh_token: 'fixture-renew-' + id, expires_in: 3600, scope };
          return reply(id === 'slack' ? { ok: true, authed_user: data } : data);
        }
        assert.equal(options.headers.Authorization, 'Bearer fixture-' + id);
        const data = id === 'slack' ? { ok: true } : { value: [] };
        return { ...reply(data), text: async () => JSON.stringify(data) };
      };
      const apps = createAppConnections({ clients: { microsoft: { clientId: 'fixture-microsoft' }, slack: { clientId: 'fixture-slack' } }, getSettings: () => settings, saveSettings: next => { settings = next; }, openExternal: async url => {
        authorization = new URL(url);
        const callback = new URL(authorization.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', 'wrong-state'); callback.searchParams.set('code', 'fixture-code');
        assert.equal((await originalFetch(callback)).status, 400);
        callback.searchParams.set('state', authorization.searchParams.get('state'));
        assert.equal((await originalFetch(callback)).status, 200);
      } });
      const result = await apps.connectAuthorization({ id });
      assert.equal(result.find(item => item.id === id).status.state, 'connected');
      assert.equal(result.find(item => item.id === id).connecting, false);
      assert.equal(settings.plugins[id].refreshToken, 'fixture-renew-' + id);
      assert.equal(require('node:crypto').createHash('sha256').update(verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
      if (id === 'slack') { assert.equal(authorization.searchParams.get('user_scope'), 'search:read'); assert.equal(authorization.searchParams.has('scope'), false); }
      else { assert.equal(authorization.searchParams.get('prompt'), 'select_account'); assert.match(authorization.searchParams.get('scope'), /offline_access/); }
      apps.disconnect(id);
      assert.equal(settings.plugins[id].refreshToken, undefined);
      apps.destroy();
    }
  } finally { global.fetch = originalFetch; }
});

test('publisher configuration refuses customer tokens and confidential client secrets', () => {
  const clients = validateClients({ google: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'desktop-fixture' }, github: { clientId: 'fixture-client' } });
  assert.equal(clients.github.clientId, 'fixture-client');
  for (const input of [{ google: { clientId: 'fixture.apps.googleusercontent.com', refreshToken: 'private' } }, { github: { clientId: 'fixture-client', clientSecret: 'private' } }, { discord: { clientId: 'fixture-client', token: 'private' } }]) assert.throws(() => validateClients(input), /configuration/);
});

test('publisher Google client opens account selection without inheriting invalid saved client credentials', async () => {
  let settings = { credentialStorage: { encrypted: true }, plugins: { gmail: { clientId: 'invalid legacy client', clientSecret: 'legacy-secret' } } };
  const clients = { google: { clientId: 'publisher.apps.googleusercontent.com', clientSecret: 'desktop-fixture' } };
  let authorization;
  const apps = createAppConnections({ clients, getSettings: () => settings, saveSettings: next => { settings = next; }, openExternal: async url => { authorization = new URL(url); apps.cancel(); } });
  await assert.rejects(apps.connectGoogle({ id: 'drive' }), /cancelled/);
  assert.equal(authorization.searchParams.get('client_id'), clients.google.clientId);
  assert.equal(authorization.searchParams.get('prompt'), 'select_account consent');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(authorization.searchParams.has('login_hint'), false);
  assert.equal(JSON.stringify(apps.catalog()).includes('legacy-secret'), false);
  assert.equal(apps.catalog().find(item => item.id === 'gmail').fields.some(field => field.key === 'clientId'), false);
  apps.destroy();
});

test('GitHub device flow shows only the user code, respects polling and uses no client secret', async () => {
  const waits = [], requests = [], codes = [], browser = [];
  let polls = 0;
  const grant = await authorizeGithubDevice({ clientId: 'fixture-client', onCode: code => codes.push(code), openExternal: async url => browser.push(url), wait: async ms => waits.push(ms), fetchImpl: async (url, options) => {
    const body = Object.fromEntries(options.body); requests.push({ url, body });
    if (url.endsWith('/device/code')) return reply({ device_code: 'fixture-private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    polls++;
    if (polls === 1) return reply({ error: 'authorization_pending' });
    if (polls === 2) return reply({ error: 'slow_down' });
    return reply({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 28800, scope: 'repo read:user' });
  } });
  assert.deepEqual(codes, ['ABCD-EFGH']);
  assert.deepEqual(browser, ['https://github.com/login/device']);
  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.equal(grant.accessToken, 'fixture-access');
  assert.ok(requests.every(request => !Object.hasOwn(request.body, 'client_secret')));
});

test('GitHub rotating refresh grant is persisted once and never restored after disconnect', async () => {
  let settings = { plugins: { github: { enabled: true, clientId: 'refresh-client', accessToken: 'expired', refreshToken: 'old-fixture', expiresAt: 1 } } };
  let saves = 0, calls = 0;
  configureGrantStore({ getSettings: () => settings, saveSettings: next => { saves++; settings = next; } });
  try {
    const config = settings.plugins.github;
    const options = { fetchImpl: async (_url, options) => { calls++; assert.equal(options.body.get('refresh_token'), 'old-fixture'); return reply({ access_token: 'renewed', refresh_token: 'rotated-fixture', expires_in: 28800 }); } };
    assert.deepEqual(await Promise.all([githubToken(config, options), githubToken(config, options)]), ['renewed', 'renewed']);
    assert.equal(calls, 1); assert.equal(saves, 1);
    assert.equal(settings.plugins.github.refreshToken, 'rotated-fixture');
    const stale = { ...settings.plugins.github, expiresAt: 1 };
    await assert.rejects(githubToken(stale, { fetchImpl: async () => { settings = { plugins: { github: { enabled: false } } }; return reply({ access_token: 'must-not-save', refresh_token: 'must-not-restore', expires_in: 28800 }); } }), /changed/);
    assert.equal(saves, 1);
    assert.equal(settings.plugins.github.enabled, false);
  } finally { configureGrantStore(undefined); }
});
