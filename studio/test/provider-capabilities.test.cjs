'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { resolveBudgets } = require('../agent/budgets.cjs');
const connections = require('../agent/connections.cjs');
const { createCapabilityStore, normalizeCapabilities } = require('../agent/provider-capabilities.cjs');

test('output-token capabilities preserve explicit booleans without interpreting other values', () => {
  const facts = normalizeCapabilities([
    { endpoint: 'http://subscription.invalid/v1', model: 'm', outputTokenLimit: false },
    { endpoint: 'http://native.invalid/v1', model: 'm', outputTokenLimit: true },
    { endpoint: 'http://unknown.invalid/v1', model: 'm', outputTokenLimit: 'false' },
  ]);
  assert.equal(facts[0].outputTokenLimit, false);
  assert.equal(facts[1].outputTokenLimit, true);
  assert.equal(Object.hasOwn(facts[2], 'outputTokenLimit'), false);
});

test('model discovery persists subscription output capability through normalized settings', async () => {
  const endpoint = 'http://subscription.invalid/v1';
  let settings = connections.normalizeSettings({ connections: [
    { id: 'subscription', name: 'Subscription', endpoint, model: 'deepseek-v4.1-flash' },
  ], activeConnection: 'subscription' }).settings;
  const capabilityStore = createCapabilityStore({ load: () => settings, save: value => { settings = connections.normalizeSettings(value).settings; } });
  await capabilityStore.discover('subscription', endpoint, '', async url => {
    assert.equal(url, endpoint + '/models');
    return { ok: true, json: async () => ({ data: [
      { id: 'deepseek-v4.1-flash', max_input_bytes: 32000, input_limit_scope: 'messages', capabilities: { outputTokenLimit: false } },
      { id: 'unknown-model', access: 'requests' },
    ] }) };
  });
  const reloaded = createCapabilityStore({ load: () => settings, save: () => {} });
  assert.deepEqual(reloaded.get('subscription', endpoint, 'deepseek-v4.1-flash'), {
    endpoint, model: 'deepseek-v4.1-flash', outputTokenLimit: false,
    maxInputBytes: 32000, inputLimitScope: 'messages',
  });
  assert.equal(reloaded.get('subscription', endpoint, 'unknown-model'), null, 'access mode alone is not an output capability');
  assert.equal(reloaded.get('subscription', 'http://other.invalid/v1', 'deepseek-v4.1-flash'), null, 'facts belong to the resolved endpoint');
});

test('catalog refresh replaces and clears output capability while preserving response observations', () => {
  const endpoint = 'http://refresh.invalid/v1';
  let settings = connections.normalizeSettings({ connections: [
    { id: 'refresh', name: 'Refresh', endpoint, model: 'm' },
  ], activeConnection: 'refresh' }).settings;
  const capabilityStore = createCapabilityStore({ load: () => settings, save: value => { settings = connections.normalizeSettings(value).settings; } });
  capabilityStore.record('refresh', endpoint, 'm', { streaming: true, maxTokensCeiling: 2048 });
  capabilityStore.recordCatalog('refresh', endpoint, { data: [{ id: 'm', capabilities: { outputTokenLimit: false } }] });
  assert.equal(capabilityStore.get('refresh', endpoint, 'm').outputTokenLimit, false);
  capabilityStore.recordCatalog('refresh', endpoint, { data: [{ id: 'm', capabilities: { outputTokenLimit: true } }] });
  assert.equal(capabilityStore.get('refresh', endpoint, 'm').outputTokenLimit, true);
  capabilityStore.recordCatalog('refresh', endpoint, { data: [{ id: 'm' }] });
  assert.deepEqual(capabilityStore.get('refresh', endpoint, 'm'), { endpoint, model: 'm', streaming: true, maxTokensCeiling: 2048 });
  capabilityStore.recordCatalog('refresh', endpoint, { data: [{ id: 'm', capabilities: { outputTokenLimit: false } }] });
  capabilityStore.recordCatalog('refresh', endpoint, { data: [{ id: 'm', capabilities: { outputTokenLimit: 'false' } }] });
  assert.equal(Object.hasOwn(capabilityStore.get('refresh', endpoint, 'm'), 'outputTokenLimit'), false);
});

test('a second loop on one connection skips a reasoning parameter already rejected by its provider', async t => {
  const endpoint = 'http://provider.invalid/v1';
  let settings = connections.normalizeSettings({ connections: [
    { id: 'conn-1', name: 'Provider', endpoint, model: 'Qwen3' },
  ], activeConnection: 'conn-1' }).settings;
  const capabilityStore = createCapabilityStore({ load: () => settings, save: value => { settings = connections.normalizeSettings(value).settings; } });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return body.chat_template_kwargs
      ? { ok: false, status: 400, text: async () => 'chat_template_kwargs unsupported', headers: { get: () => null } }
      : { ok: true };
  };
  t.after(() => { global.fetch = originalFetch; });
  const makeLoop = () => {
    const loop = new AgentLoop({ agentId: 'a', store: { get: () => ({ settings: {} }) },
      endpoint, connectionId: 'conn-1', capabilityStore, model: 'Qwen3',
      budgets: { ...resolveBudgets(), maxTokens: 512 } });
    loop.abortController = new AbortController();
    return loop;
  };
  await makeLoop()._fetchChat([{ role: 'user', content: 'hello' }], { stream: false });
  assert.equal(requests.length, 2, 'first loop retries without the rejected hint');
  assert.equal(settings.connections[0].capabilities[0].reasoningParam, false);
  await makeLoop()._fetchChat([{ role: 'user', content: 'hello' }], { stream: false });
  assert.equal(requests.length, 3, 'second loop sends one request');
  assert.equal(requests.filter(body => body.chat_template_kwargs).length, 1);
});

test('settings form saves preserve facts only while the connection URL is unchanged', () => {
  const current = { connections: [{ id: 'a', endpoint: 'http://one/v1', capabilities: [
    { endpoint: 'http://one/v1', model: 'm', streaming: true },
  ] }] };
  const same = connections.preserveCapabilities(current, { connections: [{ id: 'a', endpoint: 'http://one/v1' }] });
  assert.equal(same.connections[0].capabilities[0].streaming, true);
  const changed = connections.preserveCapabilities(current, { connections: [{ id: 'a', endpoint: 'http://two/v1' }] });
  assert.equal(changed.connections[0].capabilities, undefined);
});

test('an observed output-token ceiling is reused by the next loop', async t => {
  const endpoint = 'http://token-cap.invalid/v1';
  let settings = connections.normalizeSettings({ connections: [
    { id: 'cap', name: 'Cap', endpoint, model: 'm' },
  ], activeConnection: 'cap' }).settings;
  const capabilityStore = createCapabilityStore({ load: () => settings, save: value => { settings = connections.normalizeSettings(value).settings; } });
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requested.push(body.max_tokens);
    return body.max_tokens > 1024
      ? { ok: false, status: 400, text: async () => 'max_tokens must be at most 1024', headers: { get: () => null } }
      : { ok: true };
  };
  t.after(() => { global.fetch = originalFetch; });
  const makeLoop = () => {
    const loop = new AgentLoop({ agentId: 'a', store: { get: () => ({ settings: {} }) }, endpoint,
      connectionId: 'cap', capabilityStore, model: 'm', budgets: { ...resolveBudgets(), maxTokens: 2048 } });
    loop.abortController = new AbortController();
    return loop;
  };
  await makeLoop()._fetchChat([{ role: 'user', content: 'hi' }], { stream: false });
  await makeLoop()._fetchChat([{ role: 'user', content: 'hi' }], { stream: false });
  assert.deepEqual(requested, [2048, 1024, 1024]);
  assert.equal(settings.connections[0].capabilities[0].maxTokensCeiling, 1024);
});
