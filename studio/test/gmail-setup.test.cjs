'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAppConnections } = require('../agent/app-connections.cjs');

test('Gmail setup saves send preference, rejects malformed IDs before saving, and starts OAuth with saved configuration', async () => {
  let settings = { credentialStorage: { encrypted: true }, plugins: {} };
  let authorization;
  const apps = createAppConnections({ getSettings: () => settings, saveSettings: value => { settings = value; },
    openExternal: async url => { authorization = new URL(url); apps.cancel(); } });
  await apps.save('gmail', { clientId: 'client.apps.googleusercontent.com', allowSend: true });
  assert.equal(apps.catalog().find(item => item.id === 'gmail').allowSend, true);
  assert.equal(apps.catalog().find(item => item.id === 'gmail').sendAllowed, false);
  await assert.rejects(apps.save('gmail', { clientId: 'not-an-oauth-client' }), /client ID ending/);
  assert.equal(settings.plugins.gmail.clientId, 'client.apps.googleusercontent.com');
  await assert.rejects(apps.connectGmail({ allowSend: true }), /cancelled/);
  assert.equal(authorization.searchParams.get('client_id'), settings.plugins.gmail.clientId);
  assert.match(authorization.searchParams.get('scope'), /gmail.send/);
  await apps.save('gmail', { allowSend: false });
  assert.equal(apps.catalog().find(item => item.id === 'gmail').allowSend, false);
  apps.destroy();
});
