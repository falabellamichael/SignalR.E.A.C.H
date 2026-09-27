'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { defaults } = require('../agent/budgets.cjs');
const activity = require('../agent/activity.cjs');

function harness({ enabled = true, direct = false, verdicts = [0.98], fetchImpl } = {}) {
  const store = new MemoryStore(), events = [], requests = [];
  store.get('a').settings.features = { agent: !direct };
  const loop = new AgentLoop({ store, agentId: 'a', budgets: { ...defaults, autoCompact: false, maxRounds: 5 },
    jev: { enabled, apiKey: 'fixture', fetchImpl: fetchImpl || (async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ answers: {
        requirements: { type: 'noul', noul: verdicts[Math.min(requests.length - 1, verdicts.length - 1)] },
        evidence: { type: 'noul', noul: 0.97 },
      }, usage: { input_tokens: 55, output_tokens: 3 } }) };
    }) }, sendEvent: (_channel, event) => events.push(event) });
  let modelCalls = 0;
  loop._budgetedAnswer = async () => {
    modelCalls++;
    const message = modelCalls === 1 ? 'An incomplete explanation.' : 'Here is the corrected explanation with an example: items[0].';
    return { content: direct ? message : JSON.stringify({ status: 'complete', message, actions: [], options: [] }) };
  };
  return { loop, store, events, requests, modelCalls: () => modelCalls };
}

test('enabled completion checks are automatic in direct and Agent mode; failure gets one correction', async () => {
  for (const direct of [false, true]) {
    const h = harness({ direct, verdicts: [0.02, 0.98] });
    await h.loop.sendUserMessage('Explain array indexing and include one example.');
    assert.equal(h.modelCalls(), 2);
    assert.equal(h.requests.length, 2);
    assert.equal(h.store.get('a').runState.status, 'completed');
    assert.ok(h.store.get('a').messages.some(message => message._reachMeta?.source === 'recovery' && /runtime task-compliance/.test(message.content)));
    assert.deepEqual(h.events.filter(event => event.type === 'jev-policy').map(event => event.reason), ['failed', 'passed']);
  }
});

test('a second failing check pauses instead of reporting successful completion or retrying forever', async () => {
  for (const direct of [false, true]) {
    const h = harness({ direct, verdicts: [0.01] });
    await h.loop.sendUserMessage('Explain array indexing and include one example.');
    assert.equal(h.modelCalls(), 2);
    assert.equal(h.store.get('a').runState.status, 'paused');
    assert.match(h.store.get('a').runState.reason, /Jev task check/);
  }
});

test('disabled Jev sends no checks and leaves the normal completion path alone', async () => {
  const h = harness({ enabled: false });
  await h.loop.sendUserMessage('Explain array indexing.');
  assert.equal(h.modelCalls(), 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.events.some(event => event.type === 'jev-policy'), false);
  assert.equal(h.store.get('a').runState.status, 'completed');
});

test('uncertainty and service failures preserve the answer and show an unverified alert', async () => {
  for (const options of [{ verdicts: [0.5] }, { fetchImpl: async () => ({ ok: false, status: 529 }) }]) {
    const h = harness(options);
    await h.loop.sendUserMessage('Explain array indexing.');
    assert.equal(h.modelCalls(), 1);
    assert.equal(h.store.get('a').runState.status, 'completed');
    const alert = h.events.find(event => event.type === 'jev-policy');
    assert.equal(alert.severity, 'warning');
    assert.ok(['uncertain', 'http-529'].includes(alert.reason));
  }
});

test('Stop during review prevents completion and repair even when fetch ignores cancellation', async () => {
  let h;
  h = harness({ fetchImpl: async () => { h.loop.stop(); return new Promise(() => {}); } });
  await h.loop.sendUserMessage('Explain array indexing.');
  assert.equal(h.modelCalls(), 1);
  assert.equal(h.store.get('a').runState.status, 'stopped');
  assert.equal(h.events.some(event => event.type === 'jev-policy'), false);
});

test('compliance alerts survive the activity reducer without turning an outage into run failure', () => {
  let state = activity.reduce(null, { type: 'run-state', status: 'running', at: 1 });
  state = activity.reduce(state, { type: 'jev-policy', severity: 'warning', message: 'Jev compliance alert · http-429.', at: 2 });
  assert.equal(state.status, 'running');
  assert.equal(state.steps.at(-1).title, 'Jev compliance alert');
  assert.equal(state.steps.at(-1).status, 'error');
  assert.match(state.steps.at(-1).result, /http-429/);
});
