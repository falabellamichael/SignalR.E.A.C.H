import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AccountStore } from '../service/store.mjs';
import { createModelGateway, providerUsage } from '../service/model-gateway.mjs';

const OPENAI_KEY = 'test-only-openai-provider-secret';
const GEMINI_KEY = 'test-only-gemini-provider-secret';
const OPENCODE_KEY = 'test-only-opencode-provider-secret';
const ALIBABA_KEY = 'test-only-alibaba-provider-secret';
const RELAY_KEY = 'test-only-owner-relay-secret';
const INITIAL_CREDIT = 100000;
const PRICING = { inputUsdMicrosPerMillion: 1000000, outputUsdMicrosPerMillion: 2000000,
  cachedInputUsdMicrosPerMillion: 250000 };
const MODELS = [
  { id: 'paid-openai', provider: 'OpenAI', upstreamModel: 'gpt-4o',
    providerApi: { provider: 'openai', apiKey: OPENAI_KEY } },
  { id: 'paid-gemini', provider: 'Google', upstreamModel: 'gemini-3.7-flash',
    providerApi: { provider: 'gemini', apiKey: GEMINI_KEY } },
  { id: 'paid-opencode', provider: 'OpenCode', upstreamModel: 'glm-5.2',
    providerApi: { provider: 'opencode', apiKey: OPENCODE_KEY } },
  { id: 'paid-alibaba', provider: 'Alibaba', upstreamModel: 'glm-5.2',
    providerApi: { provider: 'alibaba', apiKey: ALIBABA_KEY } },
].map(model => ({ ...model, metered: true, pricing: PRICING,
  maxInputTokens: 100, maxInputBytes: 8000, maxOutputTokens: 20 }));
const rawCompletion = (extra = {}) => ({ id: 'provider-completion', object: 'chat.completion',
  model: 'actual-provider-model', choices: [{ index: 0,
    message: { role: 'assistant', content: 'A measured answer.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } },
  ...extra });
const jsonResponse = (value, { headers = {}, status = 200 } = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers } });
const request = (model = MODELS[0].id, extra = {}) => ({ model,
  messages: [{ role: 'user', content: 'Hello.' }], ...extra });
const delta = { id: 'provider-stream', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content: 'Measured stream.' }, finish_reason: null }] };
const finish = { ...delta, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
const streamUsage = (extra = {}) => ({ ...rawCompletion(), object: 'chat.completion.chunk', choices: [], ...extra });
function streamResponse(events) {
  return new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(t, fetchImpl, { models = MODELS, maxConcurrency = 6 } = {}) {
  const now = 1800000000000;
  const store = new AccountStore(':memory:', { models, now: () => now });
  t.after(() => store.close());
  const account = store.ensureAccount('0x' + '11'.repeat(20));
  const quote = { amount: '10000000000000000000', creditUsdMicros: INITIAL_CREDIT,
    creditBudgetUsdMicros: 5000000, issuedAt: now / 1000, deadline: now / 1000 + 300,
    expiresAtMs: now + 300000, chainId: 1, source: 'in-memory test quote',
    tokenAddress: '0x' + '22'.repeat(20), treasuryAddress: '0x' + '33'.repeat(20),
    redemptionContract: '0x' + '44'.repeat(20) };
  const redemption = store.createMarketRedemption(account.id, quote.amount, quote);
  store.submitRedemption(redemption.redemptionId, redemption.ticket, '0x' + '55'.repeat(32));
  store.creditRedemption(redemption.redemptionId, '1:in-memory-test-event:0');
  const gateway = createModelGateway({ store, models, upstreamUrl: 'http://127.0.0.1:20127/v1',
    upstreamKey: RELAY_KEY, fetchImpl, maxConcurrency, timeoutMs: 5000 });
  const server = createServer((req, res) => gateway.handle(req, res, store.account(account.id)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, accountId: account.id, gateway, base,
    view: () => store.account(account.id),
    reservation: id => store.db.prepare('SELECT * FROM reservations WHERE account_id=? AND request_id=?').get(account.id, id),
    call: (body, id = 'logical-request') => fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': id }, body: JSON.stringify(body) }) };
}

for (const [index, destination, key] of [
  [0, 'https://api.openai.com/v1/chat/completions', OPENAI_KEY],
  [1, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', GEMINI_KEY],
  [2, 'https://opencode.ai/zen/v1/chat/completions', OPENCODE_KEY],
  [3, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', ALIBABA_KEY],
]) test(`${MODELS[index].provider} direct API uses its fixed destination and debits verified USD usage once`, async t => {
  const sent = [];
  const f = await fixture(t, async (url, options) => {
    sent.push({ url, options });
    // Operator-only data in a provider reply must not leak through the envelope.
    return jsonResponse(rawCompletion({ apiKey: key, providerApi: { provider: 'private', apiKey: key } }));
  });
  assert.equal(f.view().plan.status, 'none');
  const first = await f.call(request(MODELS[index].id));
  assert.equal(first.status, 200);
  const text = await first.text(), body = JSON.parse(text);
  assert.equal(body.model, MODELS[index].id);
  assert.equal(body.usage_source, 'provider');
  assert.equal(body.usage.total_tokens, 16);
  assert.equal(sent[0].url, destination);
  assert.equal(sent[0].options.headers.authorization, `Bearer ${key}`);
  for (const otherKey of [OPENAI_KEY, GEMINI_KEY, OPENCODE_KEY, ALIBABA_KEY, RELAY_KEY].filter(value => value !== key)) {
    assert.ok(!JSON.stringify(sent[0].options.headers).includes(otherKey));
  }
  assert.equal(sent[0].options.headers['x-reach-metered'], undefined);
  assert.equal(sent[0].options.redirect, 'error');
  assert.equal(sent[0].options.headers['cache-control'], 'no-store');
  const upstreamBody = JSON.parse(sent[0].options.body);
  assert.equal(upstreamBody.model, MODELS[index].upstreamModel);
  assert.equal(upstreamBody.max_tokens, 20);
  assert.equal(upstreamBody.stream_options, undefined);
  assert.doesNotMatch(sent[0].options.body, /providerApi|apiKey|test-only/);
  assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 19);
  assert.equal(f.view().credit.reservedMicros, 0);
  assert.equal(f.reservation('logical-request').status, 'settled');
  const repeated = await f.call(request(MODELS[index].id));
  assert.equal(repeated.headers.get('x-reach-replayed'), 'true');
  assert.equal(await repeated.text(), text);
  assert.equal(sent.length, 1);
  assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 19);
  const catalog = await (await fetch(`${f.base}/v1/models`)).text();
  for (const rendered of [text, catalog, JSON.stringify(f.view())]) {
    for (const secret of [OPENAI_KEY, GEMINI_KEY, OPENCODE_KEY, ALIBABA_KEY, RELAY_KEY]) assert.ok(!rendered.includes(secret));
    assert.doesNotMatch(rendered, /providerApi|apiKey|upstreamModel/);
  }
});

test('raw usage is accepted only on direct API routes and estimated or incoherent counters fail closed', () => {
  assert.equal(providerUsage(rawCompletion()), null);
  assert.equal(providerUsage(rawCompletion(), true).totalTokens, 16);
  assert.equal(providerUsage(rawCompletion({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), true).totalTokens, 0);
  for (const extra of [{ usage_source: 'estimated' }, { usage_source: 'unknown' },
    { usage: { ...rawCompletion().usage, estimated: true } },
    { usage: { ...rawCompletion().usage, total_tokens: 17 } },
    { usage: { ...rawCompletion().usage, prompt_tokens: '10' } },
    { usage: { ...rawCompletion().usage, completion_tokens_details: { reasoning_tokens: 7 } } }]) {
    assert.equal(providerUsage(rawCompletion(extra), true), null);
  }
});

test('Gemini thinking normalization uses provider totals only and never relaxes another driver', () => {
  const thinking = rawCompletion({ usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 68 } });
  const normalized = providerUsage(thinking, true, 'gemini');
  assert.equal(normalized.promptTokens, 5);
  assert.equal(normalized.completionTokens, 63);
  assert.equal(normalized.totalTokens, 68);
  assert.equal(normalized.details.completion.reasoning_tokens, 62);
  assert.equal(thinking.usage.completion_tokens, 1, 'Do not mutate the original provider evidence.');
  for (const provider of ['openai', 'opencode', 'alibaba', undefined]) {
    assert.equal(providerUsage(thinking, true, provider), null);
  }
  assert.equal(providerUsage({ ...thinking, usage_source: 'provider' }, false, 'gemini'), null);
  const alreadyIncluded = rawCompletion({ usage: { prompt_tokens: 5, completion_tokens: 63, total_tokens: 68,
    completion_tokens_details: { reasoning_tokens: 62 } } });
  assert.deepEqual(providerUsage(alreadyIncluded, true, 'gemini'), normalized);
  const withExplicitReasoning = rawCompletion({ usage: { ...thinking.usage,
    completion_tokens_details: { reasoning_tokens: 62 } } });
  assert.deepEqual(providerUsage(withExplicitReasoning, true, 'gemini'), normalized);
});

for (const stream of [false, true]) test(`Gemini ${stream ? 'SSE' : 'JSON'} bills thinking once and replays normalized usage`, async t => {
  const model = { ...MODELS[1], maxOutputTokens: 100 };
  const providerCounters = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 68 };
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return stream ? streamResponse([delta, finish, streamUsage({ usage: providerCounters }), '[DONE]'])
      : jsonResponse(rawCompletion({ usage: providerCounters }));
  }, { models: [model] });
  const reply = await f.call(request(model.id, { stream }), 'thinking');
  assert.equal(reply.status, 200);
  const text = await reply.text();
  const body = stream ? text.split('\n').filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6))).find(chunk => chunk.usage) : JSON.parse(text);
  assert.deepEqual(body.usage, { ...providerCounters, completion_tokens: 63,
    completion_tokens_details: { reasoning_tokens: 62 } });
  assert.equal(body.usage_source, 'provider');
  assert.equal(body.usage.prompt_tokens + body.usage.completion_tokens, body.usage.total_tokens);
  // Five input tokens plus 63 output tokens; thinking is a subset of output.
  assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 131);
  assert.equal(f.view().credit.reservedMicros, 0);
  const settled = f.reservation('thinking');
  assert.equal(settled.status, 'settled');
  assert.equal(JSON.parse(settled.usage).completionTokens, 63);
  const repeated = await f.call(request(model.id, { stream }), 'thinking');
  assert.equal(repeated.headers.get('x-reach-replayed'), 'true');
  assert.equal(await repeated.text(), text);
  assert.equal(calls, 1);
  assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 131);
});

test('Gemini arithmetic rejects invalid evidence even with a provider acknowledgement header', async t => {
  const counters = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 68 };
  for (const [name, extra] of [
    ['estimated source', { usage_source: 'estimated', usage: counters }],
    ['estimated counters', { usage: { ...counters, estimated: true } }],
    ['missing completion', { usage: { prompt_tokens: 5, total_tokens: 68 } }],
    ['total below visible counts', { usage: { ...counters, total_tokens: 5 } }],
    ['noninteger total', { usage: { ...counters, total_tokens: '68' } }],
    ['conflicting reasoning', { usage: { ...counters, completion_tokens_details: { reasoning_tokens: 61 } } }],
    ['malformed reasoning details', { usage: { ...counters, completion_tokens_details: [] } }],
    ['noninteger reasoning', { usage: { ...counters, completion_tokens_details: { reasoning_tokens: '62' } } }],
  ]) await t.test(name, async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return jsonResponse(rawCompletion(extra), {
      headers: { 'x-reach-metering': 'provider-v1' },
    }); });
    const reply = await f.call(request('paid-gemini'), 'invalid-thinking');
    assert.equal(reply.status, 502);
    assert.equal((await reply.json()).error.code, 'usage_unavailable');
    assert.equal(f.reservation('invalid-thinking').status, 'uncertain');
    assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 140);
    assert.equal(f.view().credit.reservedMicros, 140);
    assert.equal(calls, 1);
  });
});

test('direct JSON missing, estimated, and inconsistent usage retains credit holds without retrying', async t => {
  for (const [name, extra] of [
    ['missing', { usage: undefined }], ['estimated source', { usage_source: 'estimated' }],
    ['unknown source', { usage_source: 'unknown' }], ['nested estimate', { usage: { ...rawCompletion().usage, estimated: true } }],
    ['inconsistent total', { usage: { ...rawCompletion().usage, total_tokens: 99 } }],
    ['impossible cached subset', { usage: { ...rawCompletion().usage, prompt_tokens_details: { cached_tokens: 11 } } }],
  ]) await t.test(name, async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return jsonResponse(rawCompletion(extra)); });
    const reply = await f.call(request(), 'unverified');
    assert.equal(reply.status, 502);
    assert.equal((await reply.json()).error.code, 'usage_unavailable');
    assert.equal(f.reservation('unverified').status, 'uncertain');
    assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 140);
    assert.equal(f.view().credit.reservedMicros, 140);
    assert.equal((await f.call(request(), 'unverified')).status, 409);
    assert.equal(calls, 1);
  });
});

for (const model of MODELS) test(`${model.provider} raw SSE usage settles once and the entire stream replays`, async t => {
  let calls = 0, dispatched;
  const f = await fixture(t, async (_url, options) => {
    calls++; dispatched = JSON.parse(options.body);
    return streamResponse([delta, finish, streamUsage(), '[DONE]']);
  });
  const reply = await f.call(request(model.id, { stream: true }), 'streamed');
  assert.equal(reply.status, 200);
  const text = await reply.text();
  assert.match(text, /Measured stream/);
  assert.match(text, /"usage_source":"provider"/);
  assert.equal(text.match(/\[DONE\]/g).length, 1);
  assert.equal(dispatched.model, model.upstreamModel);
  assert.deepEqual(dispatched.stream_options, { include_usage: true });
  assert.equal(f.reservation('streamed').status, 'settled');
  assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 19);
  const repeated = await f.call(request(model.id, { stream: true }), 'streamed');
  assert.equal(repeated.headers.get('x-reach-replayed'), 'true');
  assert.equal(await repeated.text(), text);
  assert.equal(calls, 1);
  assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 19);
});

test('direct SSE rejects unverified, unfinished, or conflicting final usage and preserves the hold', async t => {
  for (const [name, events] of [
    ['no usage', [delta, finish, '[DONE]']],
    ['estimated usage', [delta, finish, streamUsage({ usage_source: 'estimated' }), '[DONE]']],
    ['nested estimate', [delta, finish, streamUsage({ usage: { ...rawCompletion().usage, estimated: true } }), '[DONE]']],
    ['inconsistent total', [delta, finish, streamUsage({ usage: { ...rawCompletion().usage, total_tokens: 99 } }), '[DONE]']],
    ['valid followed by estimated final usage', [delta, finish, streamUsage(), streamUsage({ usage_source: 'estimated' }), '[DONE]']],
    ['valid followed by inconsistent final usage', [delta, finish, streamUsage(), streamUsage({ usage: { ...rawCompletion().usage, total_tokens: 99 } }), '[DONE]']],
    ['no DONE', [delta, finish, streamUsage()]],
    ['conflicting counters', [delta, finish, streamUsage(), streamUsage({ usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }), '[DONE]']],
  ]) await t.test(name, async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return streamResponse(events); });
    const text = await (await f.call(request('paid-gemini', { stream: true }), 'bad-stream')).text();
    assert.match(text, /"error"/);
    assert.equal(f.reservation('bad-stream').status, 'uncertain');
    assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 140);
    assert.equal(f.view().credit.reservedMicros, 140);
    assert.equal(calls, 1);
  });
});

test('GPT-5 direct routes convert output limits and reject unsupported sampling before holding credit', async t => {
  const reasoning = { ...MODELS[0], id: 'paid-luna', upstreamModel: 'gpt-5.6-luna' };
  const sent = [];
  const f = await fixture(t, async (_url, options) => { sent.push(JSON.parse(options.body)); return jsonResponse(rawCompletion()); }, { models: [reasoning] });
  for (const extra of [{ temperature: 0.5 }, { top_p: 0.9 }, { presence_penalty: 1 }, { frequency_penalty: -1 }]) {
    const reply = await f.call(request(reasoning.id, extra));
    assert.equal(reply.status, 400);
    assert.equal((await reply.json()).error.code, 'unsupported_parameter');
  }
  assert.equal(sent.length, 0);
  assert.equal(f.view().credit.reservedMicros, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM reservations').get().count, 0);
  const reply = await f.call(request(reasoning.id, { max_tokens: 8, temperature: 1, top_p: 1, presence_penalty: 0, frequency_penalty: 0 }));
  assert.equal(reply.status, 200);
  await reply.text();
  assert.equal(sent[0].model, 'gpt-5.6-luna');
  assert.equal(sent[0].max_completion_tokens, 8);
  for (const key of ['max_tokens', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) assert.equal(sent[0][key], undefined);
  const equivalent = await f.call(request(reasoning.id, { max_completion_tokens: 8 }));
  assert.equal(equivalent.headers.get('x-reach-replayed'), 'true');
  await equivalent.text();
  assert.equal(sent.length, 1);
});

test('direct routes reject client credentials, destination overrides, and caps before a hold or dispatch', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return jsonResponse(rawCompletion()); });
  for (const body of [request('paid-openai', { max_tokens: 21 }),
    request('paid-gemini', { messages: [{ role: 'user', content: 'x'.repeat(8100) }] }),
    request('paid-openai', { max_tokens: 2, max_completion_tokens: 2 }),
    request('paid-openai', { providerApi: { provider: 'gemini', apiKey: 'client-secret' } }),
    request('paid-openai', { upstreamUrl: 'https://example.invalid/steal' }),
    request('paid-gemini', { api_key: 'client-secret' }), request('paid-openai', { n: 2 }),
    request('unknown-model')]) {
    const reply = await f.call(body);
    assert.ok([400, 404].includes(reply.status));
    await reply.text();
  }
  assert.equal(calls, 0);
  assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM reservations').get().count, 0);
});

test('direct APIs reject hosted paid tools before reservation while preserving ordinary function tools', async t => {
  let calls = 0;
  const f = await fixture(t, async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).tools[0].type, 'function');
    return jsonResponse(rawCompletion());
  });
  for (const model of MODELS) {
    for (const type of ['google_search', 'code_interpreter']) {
      const reply = await f.call(request(model.id, { tools: [{ type }] }), `${model.id}-${type}`);
      assert.equal(reply.status, 400, `${model.id} must reject ${type}`);
      assert.equal((await reply.json()).error.code, 'invalid_tools');
    }
  }
  assert.equal(calls, 0);
  assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM reservations').get().count, 0);
  for (const model of MODELS) {
    const reply = await f.call(request(model.id, { tools: [{ type: 'function', function: {
      name: 'lookup_local_label', parameters: { type: 'object', properties: {} },
    } }] }), `${model.id}-function`);
    assert.equal(reply.status, 200);
    await reply.text();
  }
  assert.equal(calls, MODELS.length);
});

test('operator direct-driver configuration cannot choose another host or an unsupported credential shape', () => {
  for (const providerApi of [null, { provider: 'anthropic', apiKey: OPENAI_KEY },
    { provider: 'openai', apiKey: 'short' }, { provider: 'gemini', apiKey: GEMINI_KEY + '\n' },
    { provider: 'openai', apiKey: OPENAI_KEY, url: 'https://example.invalid/steal' },
    { provider: 'gemini', apiKey: GEMINI_KEY, keyEnv: 'CLIENT_SUPPLIED_KEY' }]) {
    assert.throws(() => createModelGateway({ store: {}, models: [{ ...MODELS[0], providerApi }],
      upstreamUrl: 'http://127.0.0.1:20127/v1', upstreamKey: RELAY_KEY,
      fetchImpl: () => { assert.fail('Invalid configuration must never dispatch.'); } }), /provider API configuration/);
  }
});

test('direct provider errors, transport failures, cache hits, and fallback replies remain uncertain and sanitized', async t => {
  for (const [name, respond] of [
    ['provider rejected', () => jsonResponse({ error: { message: OPENAI_KEY, url: `https://example.invalid/${RELAY_KEY}` } }, { status: 503 })],
    ['transport rejected', () => { throw new Error(`Provider authorization Bearer ${GEMINI_KEY}`); }],
    ['cache hit', () => jsonResponse(rawCompletion(), { headers: { 'x-reach-cache': 'HIT' } })],
    ['fallback reply', () => jsonResponse(rawCompletion(), { headers: { 'x-reach-fallback': 'used' } })],
    ['stream rejected', () => streamResponse([delta, { error: { message: GEMINI_KEY } }, '[DONE]'])],
  ]) await t.test(name, async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return respond(); });
    const reply = await f.call(request('paid-gemini', { stream: name === 'stream rejected' }), 'provider-error');
    const text = await reply.text();
    assert.match(text, /"error"/);
    for (const secret of [OPENAI_KEY, GEMINI_KEY, OPENCODE_KEY, ALIBABA_KEY, RELAY_KEY]) assert.ok(!text.includes(secret));
    assert.doesNotMatch(text, /example\.invalid/);
    assert.equal(f.reservation('provider-error').status, 'uncertain');
    assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 140);
    assert.equal((await f.call(request('paid-gemini', { stream: name === 'stream rejected' }), 'provider-error')).status, 409);
    assert.equal(calls, 1);
  });
});

test('direct routes share concurrency and in-flight idempotency without duplicate debits or fallback', async t => {
  let resolve, arrived;
  const arrival = new Promise(r => { arrived = r; });
  const pending = new Promise(r => { resolve = r; });
  let calls = 0;
  const f = await fixture(t, async () => { calls++; arrived(); return pending; }, { maxConcurrency: 1 });
  const first = f.call(request(), 'holding');
  await arrival;
  try {
    const repeated = await f.call(request(), 'holding');
    assert.equal(repeated.status, 409);
    assert.equal((await repeated.json()).error.code, 'request_in_progress');
    const conflict = await f.call(request('paid-gemini'), 'holding');
    assert.equal(conflict.status, 409);
    await conflict.text();
    const capacity = await f.call(request('paid-gemini'), 'capacity');
    assert.equal(capacity.status, 429);
    assert.equal((await capacity.json()).error.code, 'gateway_capacity');
    assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 140);
    assert.equal(f.view().credit.reservedMicros, 140);
    assert.equal(f.reservation('capacity').status, 'released');
    assert.equal(calls, 1);
  } finally { resolve(jsonResponse(rawCompletion())); }
  assert.equal((await first).status, 200);
  assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 19);
});

test('legacy relay routes still require both the protocol acknowledgement and provider usage source', async t => {
  const legacy = { ...MODELS[0] };
  delete legacy.providerApi;
  for (const [name, responseBody, headers] of [
    ['raw usage', rawCompletion(), { 'x-reach-metering': 'provider-v1' }],
    ['missing acknowledgement', rawCompletion({ usage_source: 'provider' }), {}],
  ]) await t.test(name, async t => {
    const f = await fixture(t, async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:20127/v1/chat/completions');
      assert.equal(options.headers.authorization, `Bearer ${RELAY_KEY}`);
      assert.equal(options.headers['x-reach-metered'], 'provider-v1');
      return jsonResponse(responseBody, { headers });
    }, { models: [legacy] });
    const reply = await f.call(request(), 'legacy');
    assert.equal(reply.status, 502);
    await reply.text();
    assert.equal(f.reservation('legacy').status, 'uncertain');
    assert.equal(f.view().credit.balanceMicros, INITIAL_CREDIT - 140);
  });
});
