'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PLUGIN_TOOLS } = require('../agent/plugins.cjs');

const privateDetail = 'private-provider-response-must-not-appear';
const reply = (data, status = 403) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const grant = id => ({ enabled: true, clientId: 'fixture-' + id, accessToken: 'fixture-access-' + id, refreshToken: 'fixture-refresh-' + id, expiresAt: Date.now() + 3600000 });

test('app read tools direct sign-in failures back to App Connections without requesting pasted credentials', async t => {
  const originalFetch = global.fetch;
  const clients = require('../agent/oauth-clients.cjs'), originalClients = clients.loadClients;
  clients.loadClients = () => ({ notion: { clientId: 'fixture-notion', brokerOrigin: 'https://broker.example.invalid' } });
  t.after(() => { global.fetch = originalFetch; clients.loadClients = originalClients; });
  for (const [id, provider] of [['gmail', 'Google'], ['outlook', 'Microsoft'], ['todo', 'Microsoft'], ['drive', 'Google'], ['calendar', 'Google'], ['slack', 'Slack'], ['notion', 'Notion']]) {
    const config = grant(id);
    global.fetch = async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer ' + config.accessToken);
      assert.equal(options.oauthSignIn, undefined, 'guidance context is not a provider request option');
      return reply({ error: { message: privateDetail } });
    };
    await assert.rejects(PLUGIN_TOOLS[id + '.read'].execute({}, { getPlugins: () => ({ [id]: config }) }), error => {
      assert.match(error.message, new RegExp('Reconnect ' + provider + ' in App Connections'));
      assert.doesNotMatch(error.message, /Graph Explorer|paste|copy|API key|app password/i);
      assert.ok(![privateDetail, config.accessToken, config.refreshToken].some(value => error.message.includes(value)));
      return true;
    });
  }
});

test('OAuth mail send and expired-token failures identify reconnect and the requested permission', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  for (const [id, permission, provider] of [['gmail', 'gmail.send', 'Google'], ['outlook', 'Mail.Send', 'Microsoft']]) {
    const config = { ...grant(id), allowSend: true, email: 'fixture@example.invalid', scope: id === 'gmail' ? 'https://www.googleapis.com/auth/gmail.send' : 'Mail.Send' };
    for (const status of [401, 403]) {
      global.fetch = async (_url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer ' + config.accessToken);
        return reply({ error: { message: 'Lifetime validation failed: token expired ' + privateDetail, errors: [{ reason: 'insufficientPermissions' }] } }, status);
      };
      await assert.rejects(PLUGIN_TOOLS[id + '.send'].execute({ to: 'recipient@example.invalid', subject: 'Fixture', body: 'Fixture' }, { getPlugins: () => ({ [id]: config }) }), error => {
        assert.match(error.message, new RegExp('Reconnect ' + provider + ' in App Connections'));
        assert.ok(error.message.includes(permission));
        assert.match(error.message, /Also allow sending/);
        assert.doesNotMatch(error.message, /Graph Explorer|gmail\.readonly|Mail\.Read|copy|paste/);
        assert.ok(!error.message.includes(privateDetail));
        return true;
      });
    }
  }
});

test('manual Microsoft credentials retain Graph Explorer guidance and their precedence over a stale grant', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  for (const id of ['outlook', 'todo']) {
    const config = { ...grant(id), [id === 'outlook' ? 'password' : 'token']: 'fixture-manual' };
    global.fetch = async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer fixture-manual');
      return reply({ error: { message: privateDetail } }, 401);
    };
    await assert.rejects(PLUGIN_TOOLS[id + '.read'].execute({}, { getPlugins: () => ({ [id]: config }) }), error => {
      assert.match(error.message, /Graph Explorer/);
      assert.ok(!error.message.includes(privateDetail));
      return true;
    });
  }
});

test('Slack semantic auth failures and Google renewal failures retain sign-in guidance', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const slack = grant('slack');
  global.fetch = async () => reply({ ok: false, error: 'missing_scope', needed: privateDetail }, 200);
  await assert.rejects(PLUGIN_TOOLS['slack.read'].execute({}, { getPlugins: () => ({ slack }) }), /Reconnect Slack in App Connections.*search:read/);
  const gmail = { ...grant('gmail'), expiresAt: 1, refreshToken: 'fixture-revoked-refresh' };
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(options.body.get('refresh_token'), gmail.refreshToken);
    return reply({ error: 'invalid_grant', error_description: privateDetail }, 400);
  };
  await assert.rejects(PLUGIN_TOOLS['gmail.read'].execute({}, { getPlugins: () => ({ gmail }) }), error => {
    assert.match(error.message, /Reconnect Google in App Connections/);
    assert.ok(!error.message.includes(privateDetail));
    return true;
  });
});
