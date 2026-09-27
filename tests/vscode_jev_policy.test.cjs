'use strict';
// Shared host policy used by the extension and packaged Studio runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reviewCompletion, notice, taskForReview } = require('../vscode/jev-policy');
const response = (requirements = 0.98, evidence = 0.98) => ({ ok: true, json: async () => ({
  answers: { requirements: { type: 'noul', noul: requirements }, evidence: { type: 'noul', noul: evidence } },
  usage: { input_tokens: 81, output_tokens: 4 } }) });
const input = { apiKey: 'fixture-key', request: 'Explain list indexing with one example.', answer: 'Index 0 selects the first entry, for example items[0].' };

test('task extraction preserves follow-up requirements without forwarding tool output or attachments', () => {
  const messages = [{ role: 'user', content: 'Explain array indexing with an example.' },
    { role: 'user', content: 'TOOL RESULTS private file text' },
    { role: 'user', content: 'runtime correction', _reachMeta: { source: 'recovery' } },
    { role: 'user', content: 'continue' }];
  assert.equal(taskForReview(messages), 'Explain array indexing with an example.\nFollow-up: continue');
  assert.equal(taskForReview([], 'continue'), '');
  assert.equal(taskForReview([], 'TOOL RESULTS private source'), '');
  assert.equal(taskForReview([], 'Review this\nAttached context:\nprivate source'), '');
  assert.equal(taskForReview([{ role: 'user', content: 'private attachment data', _reachMeta: { display: 'Review the document.' } }]), 'Review the document.');
});

test('batches narrow judgments, strips tool data, validates and accounts for usage', async () => {
  const result = await reviewCompletion({ ...input, observations: [{ tool: 'read', ok: true, output: 'PRIVATE SOURCE', path: 'PRIVATE PATH', arguments: 'PRIVATE ARGS' }],
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body.questions), ['requirements', 'evidence']);
      assert.deepEqual(body.state.observed_tools, [{ tool: 'read', ok: true, pending: false }]);
      assert.doesNotMatch(options.body, /PRIVATE/);
      return response();
    } });
  assert.equal(result.reason, 'passed');
  assert.deepEqual(result.usage, { inputTokens: 81, outputTokens: 4 });
});

test('failure and uncertainty are distinct; malformed answers never pass', async () => {
  assert.deepEqual((await reviewCompletion({ ...input, fetchImpl: async () => response(0.03) })).failed, ['requirements']);
  assert.equal((await reviewCompletion({ ...input, fetchImpl: async () => response(0.5) })).reason, 'uncertain');
  for (const bad of [null, '1', -1, 2, NaN]) {
    assert.equal((await reviewCompletion({ ...input, fetchImpl: async () => response(bad) })).reason, 'invalid-response');
  }
});

test('cache includes task, answer, evidence and credential identity without double billing', async () => {
  let calls = 0;
  const cache = new Map(), fetchImpl = async () => { calls++; return response(); };
  await reviewCompletion({ ...input, cache, fetchImpl });
  const repeated = await reviewCompletion({ ...input, cache, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(repeated.cached, true);
  assert.equal(repeated.usage, null);
  for (const changed of [{ request: 'Explain tuples.' }, { answer: 'Different answer.' }, { observations: [{ tool: 'shell', ok: false }] }, { apiKey: 'different' }]) {
    await reviewCompletion({ ...input, ...changed, cache, fetchImpl });
  }
  assert.equal(calls, 5);
  assert.doesNotMatch([...cache.keys()].join(''), /fixture|Explain/);
});

test('missing key and oversized inputs alert without sending incomplete data', async () => {
  for (const change of [{ apiKey: '' }, { request: 'x'.repeat(1501) }, { answer: 'x'.repeat(6001) }]) {
    const result = await reviewCompletion({ ...input, ...change, fetchImpl: () => assert.fail('No request expected') });
    assert.equal(notice('task completion', result).severity, 'warning');
  }
});

test('HTTP, JSON and network errors fall back visibly and are not cached', async () => {
  for (const fetchImpl of [async () => ({ ok: false, status: 401 }), async () => ({ ok: false, status: 429 }),
    async () => ({ ok: false, status: 529 }), async () => { throw new Error('private diagnostic'); },
    async () => ({ ok: true, json: async () => { throw new Error('private body'); } })]) {
    const cache = new Map();
    const result = await reviewCompletion({ ...input, fetchImpl, cache });
    assert.equal(notice('task completion', result).severity, 'warning');
    assert.equal(cache.size, 0);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('Stop and timeout bound even transports or response bodies that ignore abort', async () => {
  const controller = new AbortController();
  const promise = reviewCompletion({ ...input, signal: controller.signal,
    fetchImpl: async () => { controller.abort(new Error('stopped')); return new Promise(() => {}); } });
  await assert.rejects(promise, /stopped/);
  const result = await reviewCompletion({ ...input, timeoutMs: 5,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  assert.equal(result.reason, 'request-timeout');
});
