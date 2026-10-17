import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createModelGateway } from '../service/model-gateway.mjs';

const subscription = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15000000 },
  overageUsdMicrosPerRequest: 10000, proEnabled: false };
const nativeModel = 'google/gemma-4-12B-it-qat-q4_0-unquantized';
const model = (extra = {}) => ({ id: 'gemma-4-12b-qat', provider: 'SignalREACH GPU', access: 'requests',
  metered: true, maxInputBytes: 4096, bridge: { kind: 'gpu', model: nativeModel }, ...extra });
const request = (extra = {}) => ({ model: 'gemma-4-12b-qat', messages: [{ role: 'user', content: 'Hello.' }], ...extra });
const completion = (extra = {}) => ({ id: 'bridge-result', object: 'chat.completion', model: nativeModel,
  choices: [{ index: 0, message: { role: 'assistant', content: 'A completed answer.' }, finish_reason: 'stop' }], ...extra });
const response = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers } });
const delta = (extra = {}) => ({ id: 'bridge-stream', object: 'chat.completion.chunk', model: nativeModel,
  choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }], ...extra });
const finish = () => delta({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
function stream(events) {
  return new Response(': waiting for browser provider\r\n\r\n'
    + events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
}

class RequestLedger {
  constructor() { this.holds = new Map(); this.reservations = []; this.settlements = []; this.releases = []; this.uncertain = []; }
  reserveRequest(accountId, requestId, modelId, fingerprint) {
    const id = `${accountId}/${requestId}`;
    const existing = this.holds.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Object.assign(new Error('Different request.'), { status: 409, code: 'request_conflict' });
      return { ...existing, fresh: false };
    }
    const hold = { id, modelId, fingerprint, status: 'reserved', fresh: true };
    this.holds.set(id, hold);
    this.reservations.push(hold);
    return { ...hold };
  }
  settleRequest(id, replay) {
    if (this.settleFailure === 'before') throw new Error('SECRET database connection failure');
    Object.assign(this.holds.get(id), { status: 'settled', replay });
    this.settlements.push({ id, replay });
    if (this.settleFailure === 'after') throw new Error('SECRET commit acknowledgement lost');
  }
  releaseRequest(id) { this.holds.get(id).status = 'released'; this.releases.push(id); }
  markRequestUncertain(id, reason) {
    this.uncertain.push({ id, reason });
    if (this.markFailure) throw new Error('SECRET database unavailable');
    const hold = this.holds.get(id);
    if (hold.status !== 'settled') Object.assign(hold, { status: 'uncertain', reason });
  }
  reserve() { throw new Error('Token ledger must not be called.'); }
  reserveUsd() { throw new Error('USD token ledger must not be called.'); }
  settle() { throw new Error('Provider usage ledger must not be called.'); }
}

async function fixture(t, fetchImpl, options = {}) {
  const models = options.models || [model()];
  const store = options.store || new RequestLedger();
  const account = options.account || { id: 'alice', allowedModels: models };
  const gateway = createModelGateway({ store, models, subscription, fetchImpl, timeoutMs: options.timeoutMs ?? 2000,
    maxConcurrency: options.maxConcurrency || 6,
    // These intentionally dangerous alternatives must never enter request dispatch.
    upstreamUrl: 'https://personal-provider.invalid/v1', upstreamKey: 'SECRET-personal-provider-key' });
  const server = createServer((req, res) => gateway.handle(req, res, account));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, gateway, base, call: (body = request(), id = 'one', extra = {}) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': id,
      authorization: 'Bearer SECRET-customer-key' }, body: JSON.stringify(body), ...extra }) };
}

test('request mode needs no upstream credentials and exposes request pricing only', () => {
  const gateway = createModelGateway({ store: new RequestLedger(), models: [model(), model({ id: 'unqualified', metered: false })], subscription });
  const catalog = gateway.catalog({ allowedModels: ['gemma-4-12b-qat', 'unqualified'] });
  assert.equal(catalog.data.length, 1);
  assert.equal(catalog.data[0].access, 'requests');
  assert.deepEqual(catalog.data[0].capabilities, { outputTokenLimit: true, automaticOutput: true, jsonSchema: false });
  assert.deepEqual(catalog.data[0].pricing, { unit: 'request', includedRequests: 1500, usdMicrosPerRequest: 10000 });
  assert.doesNotMatch(JSON.stringify(catalog), /21302|bridge|token|SECRET/);
});

test('GPU JSON charges one completed request, replays once, and forwards no credentials', async t => {
  const sent = [];
  const f = await fixture(t, async (url, options) => {
    sent.push({ url, options });
    return response(completion({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, usage_source: 'provider' }));
  });
  const first = await f.call();
  assert.equal(first.status, 200);
  const text = await first.text();
  assert.equal(JSON.parse(text).model, 'gemma-4-12b-qat');
  assert.doesNotMatch(text, /usage|token|SECRET/);
  const replay = await f.call();
  assert.equal(replay.headers.get('x-reach-replayed'), 'true');
  assert.equal(await replay.text(), text);
  assert.equal(sent.length, 1);
  assert.equal(f.store.settlements.length, 1);
  assert.equal(sent[0].url, 'http://127.0.0.1:18001/v1/chat/completions');
  assert.equal(sent[0].options.redirect, 'error');
  assert.deepEqual(sent[0].options.headers, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  assert.deepEqual(JSON.parse(sent[0].options.body), { model: nativeModel, messages: request().messages, stream: false,
    chat_template_kwargs: { enable_thinking: true }, temperature: 1, top_p: 0.95, top_k: 64 });
  const conflict = await f.call(request({ messages: [{ role: 'user', content: 'A different request.' }] }));
  assert.equal(conflict.status, 409);
  assert.equal(sent.length, 1);
});

test('GPU client output limits are enforced and participate in replay identity', async t => {
  const sent = [];
  const f = await fixture(t, async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return response(completion());
  }, { models: [model({ maxOutputTokens: 4096 })] });
  const body = request({ max_tokens: 4096 });
  assert.equal((await f.call(body)).status, 200);
  assert.equal((await f.call(body)).headers.get('x-reach-replayed'), 'true');
  assert.equal((await f.call(request({ max_tokens: 8192 }))).status, 400);
  assert.equal((await f.call(request({ max_completion_tokens: 4096 }))).status, 409);
  assert.equal((await f.call(request({ max_completion_tokens: 4096 }), 'completion-hint')).status, 200);
  assert.equal(sent.length, 2);
  for (const payload of sent) assert.equal(payload.max_tokens, 4096);
  assert.deepEqual(f.gateway.catalog({ allowedModels: ['gemma-4-12b-qat'] }).data[0].capabilities,
    { outputTokenLimit: true, automaticOutput: false, jsonSchema: false });
  assert.equal(f.store.settlements.length, 2);
});

test('CodeGPT subscription aliases are hidden and rejected before reservation or dispatch', async t => {
  const route = model({ id: 'rch-gpt-4o-mini', provider: 'codegpt', bridge: { kind: 'codegpt', model: 'codegpt-gpt-4o-mini' } });
  const f = await fixture(t, async () => { throw new Error('Must not dispatch.'); }, { models: [route] });
  assert.deepEqual(f.gateway.catalog({ allowedModels: [route] }).data, []);
  assert.equal((await f.call(request({ model: route.id, stream: true }))).status, 404);
  assert.equal(f.store.reservations.length, 0);
});

test('GPU JSON becomes complete client SSE and replay omits token metadata', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(completion({ usage: { total_tokens: 123 } })); });
  const body = request({ stream: true });
  const reply = await f.call(body);
  assert.equal(reply.status, 200);
  const text = await reply.text();
  assert.match(text, /A completed answer/);
  assert.equal(text.match(/\[DONE\]/g).length, 1);
  assert.doesNotMatch(text, /usage|123|estimated/);
  assert.equal(await (await f.call(body)).text(), text);
  assert.equal(calls, 1);
  assert.equal(f.store.settlements.length, 1);
});

test('GPU reasoning metadata is preserved for the account client', async t => {
  const f = await fixture(t, async () => response(completion({ choices: [{ index: 0,
    message: { role: 'assistant', content: 'Hello', reasoning_content: 'private reasoning text' }, finish_reason: 'stop' }] })));
  const reply = await f.call(request({ stream: true }));
  assert.equal(reply.status, 200);
  const text = await reply.text();
  assert.match(text, /Hello/);
  assert.match(text, /private reasoning text/);
  assert.match(text, /reasoning_content/);
});

test('GPU reply variations pass through JSON and SSE and replay without another generation', async t => {
  const cases = [
    { name: 'missing finish marker', message: { content: 'Answer' } },
    { name: 'model-specific finish marker', message: { role: 'assistant', content: 'Answer' }, finish: 'eos' },
    { name: 'content parts', message: { content: [{ type: 'text', text: 'Answer' }] }, finish: 'stop' },
    ...['reasoning_content', 'reasoning', 'thought'].map(field => ({ name: field,
      message: { content: null, [field]: 'Model reasoning' }, finish: 'length' })),
    { name: 'native tools', message: { content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"sudoku.html"}' } }] }, finish: 'tool_calls' },
    { name: 'legacy function', message: { content: null,
      function_call: { name: 'read', arguments: '{"path":"sudoku.html"}' } }, finish: 'function_call' },
    { name: 'refusal', message: { content: null, refusal: 'Cannot answer this request.' }, finish: 'content_filter' },
  ];
  for (const entry of cases) for (const streaming of [false, true]) await t.test(`${entry.name}, stream=${streaming}`, async t => {
    let calls = 0;
    const f = await fixture(t, async () => {
      calls++;
      return response(completion({ choices: [{ message: entry.message, finish_reason: entry.finish }] }));
    });
    const body = request({ stream: streaming });
    const reply = await f.call(body);
    assert.equal(reply.status, 200);
    const wire = await reply.text();
    const parsed = streaming ? JSON.parse(wire.split('\n')[0].slice(6)) : JSON.parse(wire);
    assert.deepEqual(parsed.choices[0][streaming ? 'delta' : 'message'], { role: 'assistant', ...entry.message });
    assert.equal(parsed.choices[0].finish_reason, entry.finish ?? null);
    assert.equal(parsed.model, body.model);
    const replay = await f.call(body);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-reach-replayed'), 'true');
    assert.equal(await replay.text(), wire);
    assert.equal(calls, 1);
    assert.equal(f.store.settlements.length, 1);
    assert.equal(f.store.releases.length, 0);
  });
});

test('request mode rejects ignored generation controls, tools, images, and oversized text before reserving', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(completion()); });
  const invalid = [request({ max_tokens: 0 }), request({ max_completion_tokens: -1 }), request({ max_tokens: 1.5 }),
    request({ max_tokens: '4096' }), request({ max_completion_tokens: 1_000_001 }), request({ max_tokens: null }),
    request({ max_tokens: 4096, max_completion_tokens: 4096 }), request({ temperature: 0 }),
    request({ top_p: 1 }), request({ n: 1 }), request({ stream_options: { include_usage: true } }),
    request({ tools: [] }), request({ hosted_actions: true }),
    request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://image.invalid' } }] }] }),
    request({ messages: [{ role: 'tool', content: 'Tool output.' }] }),
    request({ messages: [{ role: 'assistant', content: 'Answer', tool_calls: [] }] }),
    request({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] }), request({ messages: [{ role: 'user', content: ' ' }] }),
    request({ stream: 'true' })];
  for (const body of invalid) assert.equal((await f.call(body, String(invalid.indexOf(body)))).status, 400);
  assert.equal(calls, 0);
  assert.equal(f.store.reservations.length, 0);
});

test('a private login route cannot dispatch even with a GPU public alias', async t => {
  const route = model({ bridge: { kind: 'codegpt', model: 'codegpt-gpt-4o' } });
  const f = await fixture(t, () => { throw new Error('Must not dispatch.'); }, { models: [route] });
  assert.equal((await f.call(request({ messages: [{ role: 'developer', content: 'Instructions.' }] }))).status, 404);
  assert.equal(f.store.reservations.length, 0);
});

test('unsupported bridge configuration cannot smuggle a provider destination or default model', () => {
  for (const extra of [{ bridge: { kind: 'openai', model: 'gpt-4o' } },
    { bridge: { kind: 'tray', model: 'codegpt-eco' } }, { bridge: { kind: 'tray', model: 'codegpt-eco-gpt-4o-mini' } },
    { bridge: { kind: 'tray', model: 'openai/gpt-4o' } }, { bridge: { kind: 'codegpt', model: 'gpt-4o' } },
    { bridge: { kind: 'codegpt', model: 'codegpt-eco-gpt-4o' } },
    { bridge: { kind: 'tray', model: 'chatgpt-chat', url: 'https://personal.invalid' } },
    { upstreamModel: 'openai/gpt-4o' }, { pricing: { inputUsdMicrosPerMillion: 1 } }]) {
    assert.throws(() => createModelGateway({ store: new RequestLedger(), models: [model(extra)], subscription }), /Invalid subscription bridge/);
  }
});

test('invalid or incomplete bridge replies release their request hold without billing', async t => {
  const cases = [
    ['wrong model', () => response(completion({ model: 'gpt-4o' }))],
    ['missing model', () => response(completion({ model: undefined }))],
    ['empty answer', () => response(completion({ choices: [{ index: 0, message: { role: 'assistant', content: ' ' }, finish_reason: 'stop' }] }))],
    ['missing message', () => response(completion({ choices: [{ index: 0, finish_reason: 'stop' }] }))],
    ['missing choices', () => response(completion({ choices: [] }))],
    ['provider rejection', () => response({ error: { message: 'SECRET upstream details' } }, { status: 429 })],
    ['transport failure', () => { throw new Error('SECRET upstream connection'); }],
    ['invalid JSON', () => new Response('SECRET broken JSON', { headers: { 'content-type': 'application/json' } })],
    ['unidentified plain text', () => new Response('Answer without model identity', { headers: { 'content-type': 'text/plain' } })],
    ['cache hit', () => response(completion(), { headers: { 'x-reach-cache': 'HIT' } })],
    ['fallback', () => response(completion(), { headers: { 'x-reach-fallback': 'other model' } })],
    ['oversized response', () => response(completion({ choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(1024 * 1024) }, finish_reason: 'stop' }] }))],
    ['escaped replay exceeds storage limit', () => response(completion({ choices: [{ index: 0, message: { role: 'assistant', content: '"'.repeat(300000) }, finish_reason: 'stop' }] }))],
  ];
  for (const [name, upstream] of cases) await t.test(name, async t => {
    const f = await fixture(t, async () => upstream());
    const reply = await f.call();
    assert.equal(reply.status, 502);
    assert.doesNotMatch(await reply.text(), /SECRET/);
    assert.equal(f.store.settlements.length, 0);
    assert.deepEqual(f.store.releases, ['alice/one']);
  });
});

test('broken or mismatched SSE is never returned as a paid completion', async t => {
  const cases = [[delta(), finish()], [delta(), '[DONE]'], [finish(), '[DONE]'],
    [delta({ model: 'other-model' }), finish(), '[DONE]'], [delta(), { error: { message: 'SECRET' } }, '[DONE]'],
    [delta(), finish(), '[DONE]', delta()], [delta(), finish(), delta(), '[DONE]'],
    [delta({ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: null }] }), finish(), '[DONE]']];
  for (const events of cases) await t.test(String(cases.indexOf(events)), async t => {
    const f = await fixture(t, async () => stream(events));
    const reply = await f.call(request({ stream: true }));
    assert.equal(reply.status, 502);
    const text = await reply.text();
    assert.doesNotMatch(text, /Hello|SECRET/);
    assert.equal(f.store.settlements.length, 0);
    assert.equal(f.store.releases.length, 1);
  });
});

test('a pending key and gateway capacity cannot dispatch another generation', async t => {
  let resolve;
  let arrived;
  const arrival = new Promise(r => { arrived = r; });
  const pending = new Promise(r => { resolve = r; });
  let calls = 0;
  const f = await fixture(t, async () => { calls++; arrived(); return pending; }, { maxConcurrency: 1 });
  const first = f.call();
  await arrival;
  assert.equal((await f.call()).status, 409);
  assert.equal((await f.call(request(), 'capacity')).status, 429);
  assert.equal(calls, 1);
  assert.deepEqual(f.store.releases, ['alice/capacity']);
  resolve(response(completion()));
  assert.equal((await first).status, 200);
});

test('request settlement is awaited before an answer or replay becomes available', async t => {
  let settle;
  let arrived;
  const settlement = new Promise(resolve => { settle = resolve; });
  const arrival = new Promise(resolve => { arrived = resolve; });
  const store = new RequestLedger();
  const original = store.settleRequest.bind(store);
  store.settleRequest = async (id, replay) => { arrived(); await settlement; original(id, replay); };
  const f = await fixture(t, async () => response(completion()), { store });
  let returned = false;
  const first = f.call().then(reply => { returned = true; return reply; });
  await arrival;
  assert.equal(returned, false);
  assert.equal((await f.call()).status, 409);
  assert.equal(store.settlements.length, 0);
  settle();
  assert.equal((await first).status, 200);
  assert.equal(store.settlements.length, 1);
  assert.equal((await f.call()).headers.get('x-reach-replayed'), 'true');
});

test('an unfunded account cannot dispatch; an ineligible account releases its fresh reservation', async t => {
  const store = new RequestLedger();
  store.reserveRequest = () => { throw Object.assign(new Error('Insufficient credit.'), { status: 402, code: 'insufficient_allowance' }); };
  let calls = 0;
  const unfunded = await fixture(t, async () => { calls++; return response(completion()); }, { store });
  assert.equal((await unfunded.call()).status, 402);
  const ineligible = await fixture(t, async () => { calls++; return response(completion()); }, { account: { id: 'alice', allowedModels: [] } });
  assert.equal((await ineligible.call()).status, 403);
  assert.deepEqual(ineligible.store.releases, ['alice/one']);
  assert.equal(calls, 0);
});

test('timeout before bridge headers releases the request without retry', async t => {
  let calls = 0;
  const f = await fixture(t, async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('SECRET timeout')), { once: true }));
  }, { timeoutMs: 100 });
  const reply = await f.call();
  assert.equal(reply.status, 408);
  assert.equal(calls, 1);
  assert.deepEqual(f.store.releases, ['alice/one']);
  assert.doesNotMatch(await reply.text(), /SECRET/);
});

test('timeout cancels an incomplete bridge stream and releases the request', async t => {
  let cancelled = false;
  const f = await fixture(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"model":')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }), { timeoutMs: 100 });
  const reply = await f.call(request({ stream: true }));
  assert.equal(reply.status, 408);
  assert.equal(cancelled, true);
  assert.equal(f.store.settlements.length, 0);
  assert.equal(f.store.releases.length, 1);
});

test('an unlimited request still cancels dispatch and releases once on client disconnect', async t => {
  let arrived;
  let released;
  const arrival = new Promise(r => { arrived = r; });
  const release = new Promise(r => { released = r; });
  const store = new RequestLedger();
  store.releaseRequest = id => { store.releases.push(id); store.holds.get(id).status = 'released'; released(); };
  let aborted = false;
  const f = await fixture(t, async (_url, options) => {
    arrived();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      aborted = true; reject(new Error('Cancelled bridge')); }, { once: true }));
  }, { store, timeoutMs: 0 });
  const controller = new AbortController();
  const pending = f.call(request(), 'cancelled', { signal: controller.signal });
  await arrival;
  controller.abort();
  await assert.rejects(pending);
  await release;
  assert.equal(aborted, true);
  assert.equal(store.settlements.length, 0);
  assert.deepEqual(store.releases, ['alice/cancelled']);
});

test('a client closed before gateway handoff cannot reserve or dispatch a GPU request', async () => {
  for (const abortedRequest of [false, true]) {
    const store = new RequestLedger();
    let calls = 0;
    const gateway = createModelGateway({ store, models: [model()], subscription,
      fetchImpl: async () => { calls++; throw new Error('Must not dispatch'); } });
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions',
      headers: {}, aborted: abortedRequest });
    const res = Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false });
    // The close event already happened while authentication was awaiting its
    // store. Attaching another listener cannot recover that event.
    res.emit('close');
    await gateway.handle(req, res, { id: 'alice', allowedModels: [model()] }, request());
    assert.equal(calls, 0);
    assert.equal(store.reservations.length, 0);
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
});

test('unknown settlement outcome never refunds or dispatches the same key again', async t => {
  for (const failure of ['before', 'after', 'unreachable']) await t.test(failure, async t => {
    const store = new RequestLedger();
    store.settleFailure = failure === 'after' ? 'after' : 'before';
    store.markFailure = failure === 'unreachable';
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return response(completion()); }, { store });
    const first = await f.call();
    assert.equal(first.status, 503);
    const text = await first.text();
    assert.doesNotMatch(text, /completed answer|SECRET/);
    assert.equal(store.releases.length, 0);
    assert.equal(store.uncertain.length, 1);
    const repeat = await f.call();
    assert.equal(repeat.status, failure === 'after' ? 200 : 409);
    assert.equal(calls, 1);
    assert.equal(store.releases.length, 0);
  });
});
