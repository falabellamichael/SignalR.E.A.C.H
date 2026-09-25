import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createModelGateway, providerUsage } from '../service/model-gateway.mjs';

const MODELS = ['codegpt', 'free'].map(id => ({ id, provider: id, metered: true,
  maxInputTokens: 100, maxInputBytes: 8000, maxOutputTokens: 20 }));
const account = { id: 'alice', allowedModels: MODELS };
const completion = (extra = {}) => ({ id: 'upstream-id', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'A measured answer.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }, usage_source: 'provider', ...extra });
const response = (value, options = {}) => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json', 'x-reach-metering': 'provider-v1', ...options.headers }, status: options.status ?? 200 });
const request = (model = 'codegpt', extra = {}) => ({ model, messages: [{ role: 'user', content: 'Hello.' }], ...extra });

class TestLedger {
  constructor(balance = 1000) { this.balance = balance; this.holds = new Map(); this.settlements = []; }
  reserve(accountId, requestId, model, fingerprint, amount) {
    const id = `${accountId}/${requestId}`;
    const existing = this.holds.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Object.assign(new Error('Request ID conflict.'), { status: 409, code: 'request_conflict' });
      return { ...existing, fresh: false };
    }
    if (this.balance < amount) throw Object.assign(new Error('Insufficient allowance.'), { status: 402, code: 'insufficient_allowance' });
    this.balance -= amount;
    const hold = { id, model, fingerprint, amount, status: 'reserved', fresh: true };
    this.holds.set(id, hold);
    return { ...hold };
  }
  settle(id, usage, replay) {
    const hold = this.holds.get(id);
    assert.equal(hold.status, 'reserved');
    this.balance += hold.amount - usage.totalTokens;
    Object.assign(hold, { status: 'settled', replay, usage });
    this.settlements.push(usage);
  }
  markUncertain(id, reason) { Object.assign(this.holds.get(id), { status: 'uncertain', reason }); }
  release(id) { const hold = this.holds.get(id); this.balance += hold.amount; this.holds.delete(id); }
}
async function fixture(t, fetchImpl, { balance = 1000, models = MODELS, maxConcurrency = 6, timeoutMs = 5000 } = {}) {
  const store = new TestLedger(balance);
  const gateway = createModelGateway({ store, models, upstreamUrl: 'http://127.0.0.1:20127/v1',
    upstreamKey: 'operator-test-secret-not-for-customers', fetchImpl, maxConcurrency, timeoutMs });
  const server = createServer((req, res) => gateway.handle(req, res, account));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, gateway, base, call: (body, id = undefined) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(id ? { 'idempotency-key': id } : {}) }, body: JSON.stringify(body) }) };
}
function streamResponse(events, close = true) {
  const text = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`).join('');
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); if (close) controller.close(); } }),
    { headers: { 'content-type': 'text/event-stream', 'x-reach-metering': 'provider-v1' } });
}
const delta = { id: 'stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] };
const finish = { ...delta, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
const usage = { ...completion(), object: 'chat.completion.chunk', choices: [] };

test('CodeGPT and free routes share one account balance; upstream secrets stay server-side', async t => {
  const sent = [];
  const f = await fixture(t, async (url, options) => { sent.push({ url, options }); return response(completion()); });
  for (const model of ['codegpt', 'free']) {
    const reply = await f.call(request(model));
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).model, model);
  }
  assert.equal(f.store.balance, 980);
  assert.deepEqual(f.store.settlements.map(s => s.provider), ['codegpt', 'free']);
  assert.equal(sent[0].options.headers['x-reach-metered'], 'provider-v1');
  assert.equal(sent[0].options.headers.authorization, 'Bearer operator-test-secret-not-for-customers');
  assert.equal(sent[0].options.redirect, 'error');
  assert.equal(sent[0].url, 'http://127.0.0.1:20127/v1/chat/completions');
});

test('parallel holds prevent spending the same allowance twice across models', async t => {
  let resolve;
  let dispatched;
  const dispatch = new Promise(r => { dispatched = r; });
  const pending = new Promise(r => { resolve = r; });
  let calls = 0;
  const f = await fixture(t, async () => { calls++; dispatched(); return pending; }, { balance: 150 });
  const first = f.call(request('codegpt'), 'first');
  await dispatch;
  const second = await f.call(request('free'), 'second');
  assert.equal(second.status, 402);
  assert.equal(calls, 1);
  resolve(response(completion()));
  assert.equal((await first).status, 200);
  assert.equal(f.store.balance, 140);
});

test('idempotent replay returns persisted completion without dispatch or a second debit', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(completion()); });
  const first = await (await f.call(request(), 'logical-request')).text();
  const second = await f.call(request(), 'logical-request');
  assert.equal(await second.text(), first);
  assert.equal(second.headers.get('x-reach-replayed'), 'true');
  assert.equal(calls, 1);
  assert.equal(f.store.balance, 990);
  const conflict = await f.call(request('free'), 'logical-request');
  assert.equal(conflict.status, 409);
  assert.equal(calls, 1);
});

test('an in-flight idempotency key cannot create another provider call', async t => {
  let resolve;
  let arrived;
  const arrival = new Promise(r => { arrived = r; });
  const pending = new Promise(r => { resolve = r; });
  let calls = 0;
  const f = await fixture(t, async () => { calls++; arrived(); return pending; });
  const first = f.call(request(), 'pending');
  await arrival;
  const repeat = await f.call(request(), 'pending');
  assert.equal(repeat.status, 409);
  assert.equal((await repeat.json()).error.code, 'request_in_progress');
  assert.equal(calls, 1);
  resolve(response(completion()));
  await first;
});

test('unknown usage, estimates, transport failures, and upstream errors retain uncertain holds', async t => {
  for (const bad of [() => response(completion({ usage_source: 'estimated' })),
    () => response(completion({ usage: undefined })),
    () => response({ error: { message: 'SECRET operator provider error' } }, { status: 503 }),
    () => { throw new Error('SECRET operator URL credentials'); }]) {
    await t.test(String(bad), async t => {
      const f = await fixture(t, async () => bad());
      const reply = await f.call(request(), 'uncertain');
      assert.equal(reply.status, 502);
      assert.doesNotMatch(await reply.text(), /SECRET/);
      assert.equal(f.store.balance, 880);
      assert.equal(f.store.holds.get('alice/uncertain').status, 'uncertain');
      assert.equal((await f.call(request(), 'uncertain')).status, 409);
    });
  }
});

test('qualified SSE streams settle once and replay the entire answer', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return streamResponse([delta, finish, usage, '[DONE]']); });
  const first = await f.call(request('free', { stream: true }), 'streamed');
  const text = await first.text();
  assert.match(text, /Hello/);
  assert.match(text, /"usage_source":"provider"/);
  assert.equal(text.match(/\[DONE\]/g).length, 1);
  assert.equal(f.store.balance, 990);
  const repeat = await f.call(request('free', { stream: true }), 'streamed');
  assert.equal(await repeat.text(), text);
  assert.equal(calls, 1);
});

test('SSE without final usage or DONE retains hold and emits a clean error', async t => {
  for (const events of [[delta, finish, '[DONE]'], [delta, finish, usage], [delta, { error: { message: 'SECRET' } }, '[DONE]']]) {
    await t.test(JSON.stringify(events), async t => {
      const f = await fixture(t, async () => streamResponse(events));
      const reply = await f.call(request('free', { stream: true }), 'broken');
      const text = await reply.text();
      assert.match(text, /"error"/);
      assert.doesNotMatch(text, /SECRET/);
      assert.equal(f.store.balance, 880);
      assert.equal(f.store.holds.get('alice/broken').status, 'uncertain');
    });
  }
});

test('JSON provider replies convert to SSE when stream was requested', async t => {
  const f = await fixture(t, async () => response(completion()));
  const reply = await f.call(request('free', { stream: true }));
  assert.equal(reply.headers.get('content-type'), 'text/event-stream');
  assert.match(await reply.text(), /"delta":\{"role":"assistant"/);
  assert.equal(f.store.balance, 990);
});

test('catalog hides unqualified routes and request caps reject before a reservation', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(completion()); },
    { models: [{ ...MODELS[0], metered: false }, MODELS[1]] });
  const catalog = await (await fetch(`${f.base}/v1/models`)).json();
  assert.deepEqual(catalog.data.map(m => m.id), ['free']);
  for (const body of [request(), request('free', { n: 2 }), request('free', { max_tokens: 21 }),
    request('free', { messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }),
    request('free', { messages: [{ role: 'user', content: 'x'.repeat(9000) }] }),
    request('free', { max_tokens: 10, max_completion_tokens: 10 }), request('free', { api_key: 'customer-secret' })]) {
    const reply = await f.call(body);
    assert.ok(reply.status === 400 || reply.status === 404);
  }
  assert.equal(calls, 0);
  assert.equal(f.store.holds.size, 0);
});

test('upstream cache, fallback, and missing protocol acknowledgement cannot be billed', async t => {
  for (const headers of [{ 'x-reach-cache': 'HIT' }, { 'x-reach-fallback': 'used' }, { 'x-reach-metering': 'unknown' }]) {
    await t.test(JSON.stringify(headers), async t => {
      const f = await fixture(t, async () => response(completion(), { headers }));
      const reply = await f.call(request());
      assert.equal(reply.status, 502);
      assert.equal((await reply.json()).error.code, 'unmetered_route');
      assert.equal(f.store.balance, 880);
    });
  }
});

test('provider usage accepts real zeroes and avoids double-charging cached or reasoning subsets', () => {
  assert.equal(providerUsage(completion({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })).totalTokens, 0);
  const measured = providerUsage(completion({ usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20,
    prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 6 } } }));
  assert.equal(measured.totalTokens, 20);
  for (const u of [{ prompt_tokens: -1, completion_tokens: 6, total_tokens: 5 },
    { prompt_tokens: 4, completion_tokens: 6, total_tokens: 11 },
    { prompt_tokens: '4', completion_tokens: 6, total_tokens: 10 },
    { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 7 } }]) {
    assert.equal(providerUsage(completion({ usage: u })), null);
  }
});

test('gateway capacity releases only a reservation known not to have dispatched', async t => {
  let resolve;
  let arrived;
  const arrival = new Promise(r => { arrived = r; });
  const pending = new Promise(r => { resolve = r; });
  let calls = 0;
  const f = await fixture(t, async () => { calls++; arrived(); return pending; }, { maxConcurrency: 1 });
  const first = f.call(request(), 'holding');
  await arrival;
  const blocked = await f.call(request('free'), 'capacity');
  assert.equal(blocked.status, 429);
  assert.equal(f.store.holds.size, 1);
  assert.equal(f.store.balance, 880);
  assert.equal(calls, 1);
  resolve(response(completion()));
  await first;
  assert.equal(f.store.balance, 990);
});

test('client disconnect propagates cancellation and keeps the uncertain reservation', async t => {
  let aborted;
  const abortSeen = new Promise(r => { aborted = r; });
  const f = await fixture(t, async (_url, { signal }) => {
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta)}\n\n`));
      signal.addEventListener('abort', () => { aborted(); controller.error(new Error('aborted')); }, { once: true });
    } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-reach-metering': 'provider-v1' } });
  });
  const reply = await f.call(request('codegpt', { stream: true }), 'cancelled');
  const reader = reply.body.getReader();
  await reader.read();
  await reader.cancel();
  await abortSeen;
  // Ledger transition runs in the same event turn after the fetch stream rejects.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.holds.get('alice/cancelled').status, 'uncertain');
  assert.equal(f.store.balance, 880);
});

test('conflicting provider usage cannot silently undercharge an SSE request', async t => {
  const conflicting = { ...usage, usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
  const f = await fixture(t, async () => streamResponse([delta, finish, usage, conflicting, '[DONE]']));
  const reply = await f.call(request('codegpt', { stream: true }), 'conflicting');
  assert.match(await reply.text(), /ambiguous_usage/);
  assert.equal(f.store.holds.get('alice/conflicting').status, 'uncertain');
  assert.equal(f.store.balance, 880);
});
