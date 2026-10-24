'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAppConnections } = require('../agent/app-connections.cjs');
const { PLUGIN_TOOLS } = require('../agent/plugins.cjs');
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });

test('a pasted mail token is verified before persistence and a failed replacement retains the previous grant', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  for (const id of ['gmail', 'outlook']) {
    const previous = { enabled: true, accessToken: 'previous-access', refreshToken: 'previous-refresh', clientId: 'previous-client', expiresAt: Date.now() + 3600000 };
    let settings = { plugins: { [id]: previous } }, saves = 0, finish;
    const apps = createAppConnections({ getSettings: () => settings, saveSettings: value => { settings = value; saves++; } });
    global.fetch = async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer candidate-token');
      assert.match(String(url), id === 'gmail' ? /\/profile$/ : /\/messages\?/);
      assert.equal(saves, 0);
      return new Promise(resolve => { finish = resolve; });
    };
    const pending = apps.save(id, { password: 'Bearer candidate-token' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saves, 0);
    assert.deepEqual(settings.plugins[id], previous);
    finish(reply({ error: { message: 'provider-private-details' } }, 401));
    await assert.rejects(pending, error => /HTTP 401/.test(error.message) && !error.message.includes('provider-private-details'));
    assert.equal(saves, 0);
    assert.deepEqual(settings.plugins[id], previous);
    global.fetch = async () => reply(id === 'gmail' ? { emailAddress: 'verified@example.invalid' } : { value: [] });
    const items = await apps.save(id, { password: 'Bearer candidate-token' });
    assert.equal(saves, 1);
    assert.equal(settings.plugins[id].password, 'candidate-token');
    assert.equal(settings.plugins[id].refreshToken, undefined);
    assert.equal(items.find(item => item.id === id).status.state, 'connected');
    assert.ok(!JSON.stringify(items).includes('candidate-token'));
  }
});

test('a successful check cannot restore an account disconnected while validation was pending', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let settings = { plugins: { outlook: { password: 'previous' } } }, finish;
  const apps = createAppConnections({ getSettings: () => settings, saveSettings: value => { settings = value; } });
  global.fetch = async () => new Promise(resolve => { finish = resolve; });
  const pending = apps.save('outlook', { password: 'candidate' });
  await new Promise(resolve => setImmediate(resolve));
  apps.disconnect('outlook');
  finish(reply({ value: [] }));
  await assert.rejects(pending, /changed while checking/);
  assert.deepEqual(settings.plugins.outlook, { enabled: false });
});

test('validation preserves settings changed for another connection while the provider responds', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let settings = { plugins: { outlook: {} }, theme: 'before' };
  const apps = createAppConnections({ getSettings: () => settings, saveSettings: value => { settings = value; } });
  global.fetch = async () => { settings = { ...settings, theme: 'after', plugins: { ...settings.plugins, gmail: { password: 'other-account' } } }; return reply({ value: [] }); };
  await apps.save('outlook', { password: 'candidate' });
  assert.equal(settings.theme, 'after');
  assert.equal(settings.plugins.gmail.password, 'other-account');
});

test('Gmail and Outlook OAuth require send consent when selected and never save an unusable grant', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  for (const id of ['gmail', 'outlook']) {
    for (const failure of ['send-permission', 'provider-check', 'none']) {
      const previous = { password: 'previous' };
      let settings = { credentialStorage: { encrypted: true }, plugins: { [id]: previous } }, saves = 0, providerChecks = 0;
      const baseScope = id === 'gmail' ? 'https://www.googleapis.com/auth/gmail.readonly' : 'Mail.Read';
      const sendScope = id === 'gmail' ? 'https://www.googleapis.com/auth/gmail.send' : 'Mail.Send';
      global.fetch = async (url, options) => {
        if (String(url).includes('/token')) return reply({ access_token: 'candidate-access', refresh_token: 'candidate-refresh', expires_in: 3600, scope: baseScope + (failure !== 'send-permission' ? ' ' + sendScope : '') });
        providerChecks++;
        assert.equal(saves, 0);
        assert.equal(options.headers.Authorization, 'Bearer candidate-access');
        return failure === 'provider-check' ? reply({ error: { message: 'private-provider-detail' } }, 403) : reply(id === 'gmail' ? { emailAddress: 'verified@example.invalid' } : { value: [] });
      };
      const apps = createAppConnections({ clients: { google: { clientId: 'fixture.apps.googleusercontent.com' }, microsoft: { clientId: 'fixture-microsoft' } }, getSettings: () => settings, saveSettings: value => { settings = value; saves++; }, openExternal: async value => {
        const authorization = new URL(value);
        assert.match(authorization.searchParams.get('scope'), /(?:gmail\.send|Mail\.Send)/);
        const callback = new URL(authorization.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
        assert.equal((await originalFetch(callback)).status, 200);
      } });
      if (failure === 'none') {
        const items = await apps.connectAuthorization({ id, allowSend: true });
        assert.equal(items.find(item => item.id === id).sendAllowed, true);
        assert.equal(settings.plugins[id].allowSend, true);
      } else await assert.rejects(apps.connectAuthorization({ id, allowSend: true }), failure === 'send-permission' ? /permission was not granted.*(?:gmail\.send|Mail\.Send)/ : /HTTP 403/);
      assert.equal(providerChecks, failure === 'send-permission' ? 0 : 1);
      assert.equal(saves, failure === 'none' ? 1 : 0);
      if (failure !== 'none') assert.deepEqual(settings.plugins[id], previous);
      apps.destroy();
    }
  }
});

test('Outlook send uses the saved OAuth grant and renewal path without requiring a pasted password', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('/token')) return reply({ access_token: 'renewed-outlook-token', refresh_token: 'renewed-refresh', expires_in: 3600, scope: 'Mail.Read Mail.Send' });
    assert.equal(options.headers.Authorization, 'Bearer renewed-outlook-token');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).message.toRecipients[0].emailAddress.address, 'recipient@example.invalid');
    return reply({}, 202);
  };
  const result = await PLUGIN_TOOLS['outlook.send'].execute({ to: 'recipient@example.invalid', subject: 'Fixture', body: 'Fixture' }, { getPlugins: () => ({ outlook: { enabled: true, clientId: 'fixture-client', accessToken: 'expired', refreshToken: 'send-renew-fixture', expiresAt: 1, scope: 'Mail.Read Mail.Send' } }) });
  assert.equal(result.accepted, true);
  assert.equal(calls.filter(url => url.endsWith('/sendMail')).length, 1);
  assert.equal(calls.length, 2);
});

test('mail send errors identify send permission, and known read-only grants make no send request', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => { calls++; return reply({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, 403); };
  for (const id of ['gmail', 'outlook']) {
    const tool = PLUGIN_TOOLS[id + '.send'], args = { to: 'recipient@example.invalid', subject: 'Fixture', body: 'Fixture' };
    const config = { enabled: true, password: 'candidate', email: 'sender@example.invalid' };
    await assert.rejects(tool.execute(args, { getPlugins: () => ({ [id]: config }) }), id === 'gmail' ? /gmail\.send/ : /Mail\.Send/);
    const previousCalls = calls;
    await assert.rejects(tool.execute(args, { getPlugins: () => ({ [id]: { ...config, scope: id === 'gmail' ? 'https://www.googleapis.com/auth/gmail.readonly' : 'Mail.Read' } }) }), /Also allow sending/);
    assert.equal(calls, previousCalls);
  }
});
