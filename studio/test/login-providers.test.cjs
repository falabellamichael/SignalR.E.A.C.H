'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LOGIN_PROVIDERS_ENDPOINT: endpoint, resolveEndpoint, providerRequestOptions } = require('../agent/endpoint.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { createCapabilityStore } = require('../agent/provider-capabilities.cjs');
const { resolveTeamConnections } = require('../agent/team-connections.cjs');
const { TeamRunner } = require('../agent/team-runner.cjs');
const { AgentNet } = require('../agent/agent-net.cjs');

test('empty Studio agent and team models default to Gemma and preserve explicit login choices', t => {
  const gpu = 'gemma-4-12b-qat';
  const loop = model => new AgentLoop({ agentId: 'default-model', store: { get: () => ({ settings: {} }) }, endpoint, model });
  assert.equal(loop('').model, gpu);
  assert.equal(loop('chatgpt-chat').model, 'chatgpt-chat');
  const settings = { connections: [{ id: 'gpu', endpoint: 'http://127.0.0.1:20777/v1', model: '' }], activeConnection: 'gpu' };
  assert.equal(resolveTeamConnections({ settings, personas: [{ id: 'worker' }] })[0].model, gpu);
  assert.equal(resolveTeamConnections({ settings, personas: [{ id: 'worker', model: 'copilot-chat' }] })[0].model, 'copilot-chat');
  for (const memberConnections of [null, [{ endpoint: 'http://127.0.0.1:20777/v1' }]]) {
    assert.equal(TeamRunner.prototype._memberConn.call({ memberConnections, personas: [{}], defaultModel: '' }, 0).model, gpu);
  }
  const net = new AgentNet({ teamRunId: 'default-fixture', teamName: 'Fixture', endpoint, defaultModel: '', sendEvent: () => {} });
  t.after(() => net.stop());
  assert.equal(net.spawn({ name: 'GPU worker', task: 'fixture', deferStart: true, operatorAdded: true }).model, gpu);
  assert.equal(net.spawn({ name: 'Login worker', task: 'fixture', model: 'chatgpt-chat', deferStart: true, operatorAdded: true }).model, 'chatgpt-chat');
});

test('Login Providers retain their fixed local root and never inherit keys or redirects', async () => {
  assert.equal(await resolveEndpoint(endpoint + '/'), endpoint);
  for (const suffix of ['/models', '/models/', '/chat/completions', '/chat/completions/']) {
    assert.equal(await resolveEndpoint(endpoint + suffix), endpoint);
  }
  const options = providerRequestOptions(endpoint, 'do-not-forward', { headers: { authorization: 'also-private', 'Content-Type': 'application/json' } });
  assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'X-Reach-Client': 'studio' });
  assert.equal(options.redirect, 'error');
  for (const foreign of ['https://remote.test/_reach/login-providers', 'http://127.0.0.1:21302/_reach/login-providers', 'http://localhost:20777/_reach/login-providers']) {
    const regular = providerRequestOptions(foreign, 'own-key');
    assert.equal(regular.headers['X-Reach-Client'], undefined);
    assert.equal(regular.headers.Authorization, 'Bearer own-key');
  }
  for (const foreign of ['http://localhost:20777/_reach/login-providers/models', 'http://127.0.0.2:20777/_reach/login-providers/chat/completions']) {
    assert.equal(providerRequestOptions(await resolveEndpoint(foreign), '').headers['X-Reach-Client'], undefined);
  }
});

test('actual agent answer and summary transports send the local marker without a connection key', async t => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true }; };
  t.after(() => { global.fetch = originalFetch; });
  const loop = new AgentLoop({ agentId: 'login-test', store: { get: () => ({ settings: {} }) },
    endpoint, accessKey: 'legacy-key', model: 'chatgpt-chat', budgets: { requestPacing: false } });
  loop.abortController = new AbortController();
  await loop._fetchChat([{ role: 'user', content: 'hello' }], { stream: true });
  await loop._fetchChat([{ role: 'user', content: 'summarize' }], { stream: false, purpose: 'summary' });
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(url, endpoint + '/chat/completions');
    assert.equal(options.headers['X-Reach-Client'], 'studio');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).model, 'chatgpt-chat');
  }
  assert.deepEqual(requests.map(({ options }) => JSON.parse(options.body).stream), [true, false]);
});

test('capability discovery uses the same private transport boundary', async () => {
  const store = createCapabilityStore({ load: () => ({}), save: () => {} });
  const calls = [];
  await store.discover('login', endpoint, 'old-key', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: [] }) };
  });
  assert.equal(calls[0].url, endpoint + '/models');
  assert.equal(calls[0].options.headers['X-Reach-Client'], 'studio');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.redirect, 'error');
});
