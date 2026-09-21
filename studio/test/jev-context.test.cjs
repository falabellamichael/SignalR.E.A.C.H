'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideContext, recentQuery } = require('../agent/jev-context.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { resolveBudgets } = require('../agent/budgets.cjs');
const activity = require('../renderer/activity-state.js');

const symbols = [{ name: 'computeTotal', path: 'src/math.ts', kind: 'function', line: 1 }];
const response = (noul, usage = { input_tokens: 42, output_tokens: 0 }) => ({
  ok: true, json: async () => ({ answers: { use_code_context: { type: 'noul', noul } }, usage }),
});

test('Jev request contains metadata only and conservatively skips unrelated context', async () => {
  let body;
  const result = await decideContext({ apiKey: 'test-key', query: 'What is the capital of Canada?', symbols,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      body = JSON.parse(init.body);
      return response(0.04);
    } });
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state.candidate_symbols, [{ name: 'computeTotal', path: 'src/math.ts', kind: 'function' }]);
  assert.ok(!JSON.stringify(body).includes('return a + b'));
  assert.equal(result.inject, false);
  assert.equal(result.reason, 'jev-skip');
  assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 0 });
});

test('explicit symbol requests, vague followups, and long user text keep context without a call', async () => {
  const failFetch = () => { throw new Error('should not call'); };
  assert.equal((await decideContext({ apiKey: 'key', query: 'Explain computeTotal', symbols, fetchImpl: failFetch })).inject, true);
  assert.equal((await decideContext({ apiKey: 'key', query: 'yes', symbols, fetchImpl: failFetch })).inject, true);
  assert.equal((await decideContext({ apiKey: 'key', query: 'Please continue with the previous work now', symbols, fetchImpl: failFetch })).reason, 'explicit-or-vague');
  assert.equal(recentQuery([{ role: 'user', content: 'a'.repeat(501) }]), '');
  assert.equal(recentQuery([
    { role: 'user', content: 'Explain the project' },
    { role: 'assistant', content: 'private generated patch' },
    { role: 'user', content: 'tool output', _reachMeta: { source: 'tool-summary' } },
  ]), 'Explain the project');
});

test('malformed, ambiguous, and failed Jev results retain context', async () => {
  const options = { apiKey: 'key', query: 'Tell me how this project responds to user requests', symbols };
  assert.equal((await decideContext({ ...options, fetchImpl: async () => response(0.5) })).inject, true);
  assert.equal((await decideContext({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { use_code_context: { type: 'choice', noul: 0 } } }) }) })).reason, 'invalid-response');
  assert.equal((await decideContext({ ...options, fetchImpl: async () => ({ ok: false, status: 401 }) })).inject, true);
  assert.equal((await decideContext({ ...options, fetchImpl: async () => { throw new Error('offline'); } })).inject, true);
  assert.equal((await decideContext({ ...options, fetchImpl: async () => response(0.9, { input_tokens: 12 }) })).usage, null);
});

test('Stop abort is propagated instead of continuing to the answer model', async () => {
  const controller = new AbortController();
  await assert.rejects(decideContext({ apiKey: 'key', query: 'How does the project handle files?', symbols,
    signal: controller.signal,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      controller.abort();
    }),
  }), /stopped/);
});

test('Activity reports Jev usage once and identifies cached selections', () => {
  let state = activity.reduce(null, { type: 'run-state', status: 'running', at: 1 });
  state = activity.reduce(state, { type: 'jev-context', reason: 'jev-skip', injected: false,
    usage: { inputTokens: 42, outputTokens: 0 }, cached: false, at: 2 });
  state = activity.reduce(state, { type: 'jev-context', reason: 'jev-skip', injected: false,
    usage: null, cached: true, at: 3 });
  assert.match(state.steps.at(-2).result, /42 Jev input tokens/);
  assert.match(state.steps.at(-1).note, /cached/);
  assert.ok(!/42 Jev input tokens/.test(state.steps.at(-1).result));
});

test('AgentLoop applies and caches a Jev skip without reporting duplicate usage', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-jev-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/math.ts'), 'export function computeTotal(a: number, b: number) { return a + b; }\n');
  const store = new MemoryStore();
  store.get('a').messages = [{ role: 'user', content: 'What is the capital of Canada?' }];
  const events = [];
  let calls = 0;
  const loop = new AgentLoop({ agentId: 'a', store, endpoint: 'http://127.0.0.1:9/v1', model: 'test', projectDir: dir,
    budgets: resolveBudgets({}, {}), sendEvent: (_channel, event) => events.push(event),
    jev: { enabled: true, apiKey: 'test-key', fetchImpl: async () => { calls++; return response(0.02); } } });
  // Use a query that matches the local index, without naming the candidate
  // exactly. Jev can then decide whether the retrieved source is useful.
  const request = [{ role: 'user', content: 'compute numbers in this app' }];
  store.get('a').messages = [{ role: 'user', content: 'compute numbers in this app' }];
  const first = await loop._withSelectedCodeContext(request);
  const second = await loop._withSelectedCodeContext(request);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(calls, 1);
  const jevEvents = events.filter(e => e.type === 'jev-context');
  assert.equal(jevEvents.length, 2);
  assert.equal(jevEvents[0].usage.inputTokens, 42);
  assert.equal(jevEvents[1].usage, null);
  assert.equal(jevEvents[1].cached, true);
});
