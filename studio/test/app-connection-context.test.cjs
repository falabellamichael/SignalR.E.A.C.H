'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { appConnectionContext } = require('../agent/plugins.cjs');

test('model context distinguishes saved sign-in and send consent without exposing credentials or account data', () => {
  const context = appConnectionContext({
    gmail: { enabled: true, accessToken: 'private-access', refreshToken: 'private-refresh', clientSecret: 'private-secret', email: 'private-email', scope: 'https://www.googleapis.com/auth/gmail.readonly', unknown: 'private-extra' },
    outlook: { enabled: true, password: 'private-password', scope: 'Mail.Read Mail.Send' },
    todo: { enabled: false, refreshToken: 'private-todo-refresh' },
    'private-injected-app': { token: 'private-injected-token' },
  });
  assert.match(context, /"app":"gmail","enabled":true,"authentication":"saved sign-in","sending":"permission not granted"/);
  assert.match(context, /"app":"outlook","enabled":true,"authentication":"saved manual token","sending":"permission granted"/);
  assert.match(context, /"app":"todo","enabled":false/);
  assert.match(context, /Also allow sending/);
  assert.match(context, /not proof that a provider request succeeded/);
  assert.doesNotMatch(context, /private-/);
});

test('an existing model conversation sees updated sign-in state in its next system prompt', () => {
  const store = new MemoryStore();
  let plugins = { outlook: { enabled: true, accessToken: 'private-access', scope: 'Mail.Read' } };
  const loop = new AgentLoop({ agentId: 'a', store, getPlugins: () => plugins });
  assert.match(loop._buildSystemPrompt(), /"sending":"permission not granted"/);
  plugins = { outlook: { ...plugins.outlook, scope: 'Mail.Read Mail.Send' } };
  assert.match(loop._buildSystemPrompt(), /"sending":"permission granted"/);
  plugins.outlook.allowSend = false;
  assert.match(loop._buildSystemPrompt(), /"sending":"disabled in settings"/);
  assert.equal(store.get('a').messages.length, 0, 'connection state does not become saved conversation history');
  loop.promptBuilder = () => 'Custom companion prompt.';
  assert.match(loop._buildSystemPrompt(), /Custom companion prompt\.[\s\S]*APP CONNECTIONS/);
  store.get('a').settings.features = { agent: false };
  assert.doesNotMatch(loop._buildSystemPrompt(), /APP CONNECTIONS/);
});

test('unknown manual-token scopes are not presented as a denied sending permission', () => {
  const context = appConnectionContext({ gmail: { password: 'private-password' }, github: {} });
  assert.match(context, /permission unknown; provider must verify/);
  assert.match(context, /GitHub CLI may provide access/);
  assert.equal(appConnectionContext({}), '');
});
