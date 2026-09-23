'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { providerErrorDetails } = require('../agent/chat-response.cjs');
const { gateFor, gateKeyFor } = require('../agent/rate-limit.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { defaults } = require('../agent/budgets.cjs');

async function endpoint(t, responses) {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume the request */ }
    const choice = responses[Math.min(calls++, responses.length - 1)];
    if (choice.httpStatus) {
      res.writeHead(choice.httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(choice.body));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (choice.sseEvents) {
      res.end(choice.sseEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      return;
    }
    res.end(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, count: () => calls };
}

function fixture(url) {
  const store = new MemoryStore(), events = [];
  const loop = new AgentLoop({ agentId: 'empty-reply', store, endpoint: url, model: 'fixture',
    budgets: { ...defaults, requestPacing: false }, sendEvent: (_, event) => events.push(event) });
  return { loop, store, events };
}

const empty = { delta: {}, finish_reason: 'stop' };
const complete = { delta: { content: 'Done.\n```agent_status\n{"status":"complete","summary":"Done."}\n```' }, finish_reason: 'stop' };

test('an empty successful stream gets one safe retry before the answer is saved', async t => {
  const server = await endpoint(t, [empty, complete]);
  const { loop, store, events } = fixture(server.url);
  await loop.sendUserMessage('Finish the task.');
  assert.equal(server.count(), 2);
  assert.equal(store.get('empty-reply').runState.status, 'completed');
  assert.equal(store.get('empty-reply').messages.filter(message => message.role === 'assistant').length, 1);
  assert.ok(events.some(event => event.type === 'retry' && /empty response/.test(event.error)));
});

test('two empty streams pause with an honest diagnostic and no invented answer', async t => {
  const server = await endpoint(t, [empty, empty]);
  const { loop, store } = fixture(server.url);
  await loop.sendUserMessage('Finish the task.');
  assert.equal(server.count(), 2);
  assert.equal(store.get('empty-reply').runState.status, 'paused');
  assert.match(store.get('empty-reply').runState.reason, /returned no answer/);
  assert.equal(store.get('empty-reply').messages.filter(message => message.role === 'assistant').length, 0);
});

test('provider filtering is not retried as an empty transport response', async t => {
  const server = await endpoint(t, [{ delta: {}, finish_reason: 'content_filter' }]);
  const { loop, store } = fixture(server.url);
  await loop.sendUserMessage('Finish the task.');
  assert.equal(server.count(), 1);
  assert.match(store.get('empty-reply').runState.reason, /provider filtered/);
});

test('nested CodeGPT concurrency errors become a short actionable diagnostic', () => {
  const raw = JSON.stringify({ error: { message: 'CodeGPT: ' + JSON.stringify({
    errorMessage: 'Economy models are unlimited for one interactive session at a time.',
    status: 429, code: 'ECONOMY_CONCURRENCY_LIMIT',
  }) } });
  const parsed = providerErrorDetails(raw);
  assert.equal(parsed.code, 'ECONOMY_CONCURRENCY_LIMIT');
  assert.equal(parsed.status, 429);
  assert.match(parsed.message, /another configured connection/);
  assert.doesNotMatch(parsed.message, /[{}]/);
});

test('a hard provider quota does not consume repeated rate-limit attempts', async t => {
  const server = await endpoint(t, [{ httpStatus: 429, body: { error: {
    message: 'Insufficient quota', code: 'insufficient_quota',
  } } }]);
  const { loop, store } = fixture(server.url);
  await loop.sendUserMessage('Finish the task.');
  assert.equal(server.count(), 1);
  assert.match(store.get('empty-reply').runState.reason, /quota/i);
  assert.doesNotMatch(store.get('empty-reply').runState.reason, /[{}]/);
});

test('a relayed CodeGPT concurrency 429 waits once and retries without exposing JSON', async t => {
  const server = await endpoint(t, [{ httpStatus: 502, body: { error: {
    message: 'CodeGPT: ' + JSON.stringify({ status: 429, code: 'ECONOMY_CONCURRENCY_LIMIT',
      errorMessage: 'Another stream on this account is still running.' }),
  } } }, complete]);
  gateFor(gateKeyFor(server.url), { minPenaltyMs: 1 });
  const { loop, store, events } = fixture(server.url);
  await loop.sendUserMessage('Finish the task.');
  assert.equal(server.count(), 2);
  assert.equal(store.get('empty-reply').runState.status, 'completed');
  const limited = events.find(event => event.type === 'rate-limit');
  assert.match(limited?.note || '', /CodeGPT Economy concurrency limit \(HTTP 429\)/);
  assert.doesNotMatch(limited.note, /[{}]/);
});

test('a typed SSE concurrency error retries once before any output is emitted', async t => {
  const server = await endpoint(t, [{ sseEvents: [{ error: {
    provider: 'codegpt', status: 429, code: 'ECONOMY_CONCURRENCY_LIMIT',
    message: 'Another stream on this account is still running.', retryable: true, retryAfterSeconds: 0,
  } }] }, complete]);
  gateFor(gateKeyFor(server.url), { minPenaltyMs: 1 });
  const { loop, store, events } = fixture(server.url);
  await loop.sendUserMessage('Finish the task.');
  assert.equal(server.count(), 2);
  assert.equal(store.get('empty-reply').runState.status, 'completed');
  assert.ok(events.some(event => event.type === 'retry' && /HTTP 429/.test(event.error)));
});

test('an SSE error after answer text does not replay the request', async t => {
  const server = await endpoint(t, [{ sseEvents: [
    { choices: [{ delta: { content: 'Partial answer' } }] },
    { error: { status: 429, code: 'ECONOMY_CONCURRENCY_LIMIT', retryable: true,
      message: 'Another stream on this account is still running.' } },
  ] }, complete]);
  const { loop, store } = fixture(server.url);
  await loop.sendUserMessage('Finish the task.');
  assert.equal(server.count(), 1);
  assert.equal(store.get('empty-reply').runState.status, 'paused');
  assert.equal(store.get('empty-reply').messages.filter(message => message.role === 'assistant').length, 0);
});
