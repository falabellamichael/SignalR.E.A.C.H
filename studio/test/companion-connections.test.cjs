'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { companionSettings } = require('../agent/companion-chat.cjs');

function available(id, config, settings = {}) {
  const result = companionSettings(settings, { [id]: { enabled: true, ...config } });
  return name => !result.disabledTools.includes(`${id}.${name}`);
}

test('companion exposes mail sending for supported Google and Microsoft grants', () => {
  const grants = {
    gmail: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://mail.google.com/',
    ],
    outlook: ['Mail.Read Mail.Send', 'https://graph.microsoft.com/Mail.Send'],
  };
  for (const [id, scopes] of Object.entries(grants)) {
    for (const scope of scopes) {
      const canUse = available(id, { accessToken: 'fixture-oauth', scope });
      assert.equal(canUse('read'), true, `${id}: ${scope}`);
      assert.equal(canUse('send'), true, `${id}: ${scope}`);
    }
  }
});

test('companion keeps read tools available while hiding mail sending for read-only grants', () => {
  for (const [id, scope] of [['gmail', 'https://www.googleapis.com/auth/gmail.readonly'], ['outlook', 'Mail.Read']]) {
    const canUse = available(id, { accessToken: 'fixture-oauth', scope, allowSend: true });
    assert.equal(canUse('read'), true, id);
    assert.equal(canUse('send'), false, id);
  }
});

test('companion respects send opt-out, disabled connections, and explicit tool restrictions', () => {
  for (const [id, scope] of [['gmail', 'https://www.googleapis.com/auth/gmail.send'], ['outlook', 'Mail.Send']]) {
    assert.equal(available(id, { scope, allowSend: false })('send'), false, id);
    const disabled = available(id, { scope, enabled: false });
    assert.equal(disabled('read'), false, id);
    assert.equal(disabled('send'), false, id);
    assert.equal(available(id, { scope }, { disabledTools: [`${id}.send`] })('send'), false, id);
  }
});

test('companion preserves configured mail credentials when granted scopes are unknown', () => {
  for (const id of ['gmail', 'outlook']) {
    for (const field of ['accessToken', 'refreshToken', 'token', 'password']) {
      assert.equal(available(id, { [field]: 'fixture-manual' })('send'), true, `${id}: ${field}`);
      assert.equal(available(id, { [field]: 'fixture-manual', allowSend: false })('send'), false, `${id}: ${field}`);
    }
  }
});

test('companion does not offer mail sends for unconfigured accounts with unknown scopes', () => {
  const empty = companionSettings();
  for (const id of ['gmail', 'outlook']) {
    assert.equal(empty.disabledTools.includes(`${id}.send`), true, id);
    for (const config of [{}, { allowSend: true }, { accessToken: '', refreshToken: '', token: '', password: '' }]) {
      const canUse = available(id, config);
      assert.equal(canUse('send'), false, id);
      assert.equal(canUse('read'), true, id);
    }
  }
});

test('companion mail tools retain application approval requirements', () => {
  const result = companionSettings({ approvals: 'auto', reviewEdits: false }, { outlook: { enabled: true, scope: 'Mail.Send' } });
  assert.equal(result.disabledTools.includes('outlook.send'), false);
  assert.equal(result.approvals, 'prompt');
  assert.equal(result.reviewEdits, true);
});
