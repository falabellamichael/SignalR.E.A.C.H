'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeToken, connectionError } = require('../agent/app-auth.cjs');
const { createAppConnections } = require('../agent/app-connections.cjs');
const extra = require('../agent/extra-apps.cjs');

test('a legacy password in the public Google client ID field is never returned to the renderer', () => {
  const apps = createAppConnections({ getSettings: () => ({ plugins: { gmail: { clientId: 'legacy app password', clientSecret: 'private-client-secret-value' } } }) });
  const catalog = apps.catalog();
  const gmail = catalog.find(item => item.id === 'gmail');
  assert.equal(gmail.fields.find(field => field.key === 'clientId').value, '');
  assert.match(gmail.help, /saved client ID is invalid/);
  assert.ok(!JSON.stringify(catalog).includes('legacy app password'));
  assert.ok(!JSON.stringify(catalog).includes('private-client-secret-value'));
});

test('opaque Microsoft tokens and complete long tokens survive normalization and both save paths', async t => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ value: [] }), text: async () => JSON.stringify({ value: [] }) });
  t.after(() => { global.fetch = originalFetch; });
  const token = 'opaque+/' + 'x'.repeat(2000) + '==';
  assert.equal(normalizeToken(' Authorization: Bearer ' + token + '\r\n'), token);
  assert.equal(normalizeToken(token.slice(0, 100) + '\r\n' + token.slice(100)), token);
  let settings = { plugins: {} };
  const apps = createAppConnections({ getSettings: () => settings, saveSettings: value => { settings = value; } });
  await apps.save('todo', { token: 'Bearer ' + token, enabled: true });
  await apps.save('outlook', { password: 'Bearer ' + token });
  assert.equal(settings.plugins.todo.token, token);
  assert.equal(settings.plugins.outlook.password, token);
  const { sanitizePlugins } = require('../agent/plugins.cjs');
  const result = sanitizePlugins({ outlook: { password: token }, gmail: { password: token } });
  assert.equal(result.outlook.password, token);
  assert.equal(result.gmail.password, token);
  assert.equal(sanitizePlugins({ outlook: { password: '' } }, result).outlook.password, token);
  await assert.rejects(apps.save('todo', { token: 'x'.repeat(16385) }), /too long/);
  assert.equal(settings.plugins.todo.token, token, 'oversized values do not overwrite a saved token');
  assert.throws(() => normalizeToken('invalid token'), /spaces/);
});

test('provider errors offer specific guidance without returning response data', () => {
  const secret = 'must-never-appear';
  const cases = [
    ['todo', 401, { error: { code: 'UnknownError', message: secret } }, /Tasks.Read.*GET \/me\/todo\/lists/],
    ['todo', 401, { error: { message: 'Lifetime validation failed: token expired ' + secret } }, /expired/],
    ['outlook', 401, { error: { message: 'Invalid audience ' + secret } }, /different service/],
    ['outlook', 403, { error: { message: secret } }, /Mail.Read/],
    ['drive', 403, { error: { errors: [{ reason: 'accessNotConfigured', message: secret }] } }, /Enable the Google Drive API/],
    ['calendar', 403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }, /Enable the Google Calendar API/],
    ['drive', 401, { error: { message: secret } }, /API key or app password/],
    ['gmail', 400, { error: 'invalid_grant', error_description: secret }, /Connect Google again/],
    ['slack', 200, { error: 'missing_scope', needed: secret }, /user OAuth token with search:read/],
    ['discord', 403, { message: secret }, /Read Message History/],
    ['notion', 429, { message: secret }, /rate limiting/],
  ];
  for (const [id, status, data, expected] of cases) {
    const error = connectionError(id, status, data);
    assert.match(error.message, expected);
    assert.ok(!error.message.includes(secret));
  }
  assert.doesNotThrow(() => connectionError('drive', 403, { error: { details: {} } }));
});

test('request sends a single auth scheme and handles non-JSON failures safely', async () => {
  await assert.rejects(extra.execute('todo', {}, { token: 'Bearer opaque+/==' }, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer opaque+/==');
      return { ok: false, status: 401, text: async () => '<html>private content</html>' };
    },
  }), error => /HTTP 401/.test(error.message) && !error.message.includes('private content'));
  await assert.rejects(extra.checkConnection('slack', { token: 'test' }, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'missing_scope' }) }),
  }), /search:read/);
});

test('both Outlook check entry points verify mail access without requiring User.Read', async t => {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push(String(url));
    assert.equal(options.headers.Authorization, 'Bearer opaque+/==');
    assert.equal(new URL(url).pathname, '/v1.0/me/messages');
    assert.equal(new URL(url).searchParams.get('$select'), 'id');
    return { ok: true, json: async () => ({ value: [] }) };
  };
  const config = { password: 'Bearer opaque+/==', enabled: true };
  const apps = createAppConnections({ getSettings: () => ({ plugins: { outlook: config } }) });
  assert.equal((await apps.check('outlook')).find(item => item.id === 'outlook').status.state, 'connected');
  assert.equal((await require('../agent/plugins.cjs').testPlugin('outlook', config)).ok, true);
  assert.equal(seen.length, 2);
});
