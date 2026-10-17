import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AccountStore, requestModel, basicPlanModelIds } from '../service/store.mjs';
import { SupabaseAccountStore } from '../service/supabase-store.mjs';
import { createModelGateway } from '../service/model-gateway.mjs';
import { validateConfig } from '../service/config.mjs';
import { gpuBridge } from '../service/gpu-bridge.mjs';

const { models: automaticModels } = JSON.parse(readFileSync(new URL('../config/subscription-gpu.example.json', import.meta.url)));
const models = automaticModels.map(model => ({ ...model, maxInputBytes: 32000 }));
const subscription = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15000000 },
  overageUsdMicrosPerRequest: 10000, proEnabled: false };
const wallet = '0x' + '33'.repeat(20);
const request = (extra = {}) => ({ model: models[0].id, messages: [{ role: 'user', content: 'Hello.' }], ...extra });

async function fixture(t, fetchImpl, { paid = true, models: configuredModels = models } = {}) {
  const store = new AccountStore(':memory:', { models: configuredModels, subscription });
  t.after(() => store.close());
  const account = store.ensureAccount(wallet);
  if (paid) store.grantPlan({ wallet, grantId: 'gpu-test-period', planId: 'basic-wallet', name: 'Basic',
    models: configuredModels.map(model => model.id), tokens: 0, expiresAt: Date.now() + 3600000 });
  const gateway = createModelGateway({ store, models: configuredModels, subscription, fetchImpl });
  const server = createServer((req, res) => gateway.handle(req, res, store.account(account.id)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { store, account, gateway, call: (body = request(), key = 'gpu-request') => fetch(
    `http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
    }) };
}

function answer(model, message = {}) {
  return new Response(JSON.stringify({ model, choices: [{ index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: 'A completed answer.', tool_calls: [], refusal: null,
      reasoning: null, annotations: null, ...message } }] }), { headers: { 'content-type': 'application/json' } });
}

test('live GPU limits apply before reservation and invalid destinations retain the current catalog', async t => {
  let calls = 0;
  let output;
  const f = await fixture(t, async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    output = body.max_tokens;
    return answer(body.model);
  });
  const next = structuredClone(models);
  next[0].maxInputBytes = 200;
  next[0].maxOutputTokens = 32;
  f.gateway.replaceModels(next);
  f.store.models = next;
  assert.equal((await f.call(request({ max_tokens: 33 }), 'too-long-output')).status, 400);
  assert.equal((await f.call(request({ messages: [{ role: 'user', content: 'x'.repeat(201) }] }), 'too-long-input')).status, 400);
  assert.equal(calls, 0);
  assert.equal(f.store.requestAllowance(f.account.id).completed, 0);
  const accepted = await f.call(request(), 'default-output');
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.equal(output, 32);
  assert.equal(calls, 1);
  const malicious = structuredClone(next);
  malicious[0].bridge.model = models[1].bridge.model;
  assert.throws(() => f.gateway.replaceModels(malicious), /live model update/);
  assert.throws(() => f.gateway.replaceModels(next.map(m => ({ ...m, maxOutputTokens: 1000001 }))), /GPU output limit/);
  const disabled = structuredClone(next);
  disabled[0].metered = false;
  f.gateway.replaceModels(disabled);
  f.store.models = disabled;
  assert.equal((await f.call(request(), 'disabled-model')).status, 404);
  assert.equal(calls, 1);
  assert.equal(f.store.requestAllowance(f.account.id).completed, 1);
});

test('GPU selectors validate, retain request entitlement and advertise an enforced output cap', () => {
  const config = validateConfig({ origin: 'https://accounts.example', port: 20978, chainId: 31337,
    database: 'private/accounts.sqlite', upstreamUrl: 'http://127.0.0.1:20777/v1',
    upstreamKeyEnv: 'REACH_TEST_UPSTREAM', models, subscription, redemption: { enabled: false } },
  process.cwd(), { REACH_TEST_UPSTREAM: 'server-only-test-relay-credential' });
  assert.equal(config.models.length, 3);
  assert.ok(models.every(model => !model.id.includes('granite')));
  assert.ok(models.every(requestModel));
  assert.deepEqual(basicPlanModelIds(models), models.map(m => m.id).sort());
  assert.equal(gpuBridge({ kind: 'gpu', model: '__proto__' }), null);
  assert.equal(gpuBridge({ ...models[0].bridge, url: 'http://192.0.2.1' }), null);
  assert.equal(gpuBridge({ kind: 'gpu', model: 'another/model' }), null);
});

test('GPU output defaults to available model context and honors explicit client and operator limits', async t => {
  const sent = [];
  const f = await fixture(t, async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    return answer(body.model);
  });
  for (const model of models) {
    assert.equal((await f.call(request({ model: model.id }), 'default-' + model.id)).status, 200);
    assert.equal(Object.hasOwn(sent.at(-1), 'max_tokens'), false);
  }
  const ornith = models.find(model => model.id === 'ornith-1.5-9b');
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    assert.equal((await f.call(request({ model: ornith.id, [field]: 8192 }), field)).status, 200);
    assert.equal(sent.at(-1).max_tokens, 8192);
  }
  const next = structuredClone(models);
  next.find(model => model.id === ornith.id).maxOutputTokens = 512;
  f.gateway.replaceModels(next);
  f.store.models = next;
  assert.equal((await f.call(request({ model: ornith.id }), 'lower-operator-cap')).status, 200);
  assert.equal(sent.at(-1).max_tokens, 512);
});

test('each GPU route dispatches through its fixed tunnel, settles once and replays without redispatch', async t => {
  const sent = [];
  const f = await fixture(t, async (url, options) => {
    const payload = JSON.parse(options.body);
    sent.push({ url, options, payload });
    return answer(payload.model);
  });
  assert.deepEqual(f.gateway.catalog(f.store.account(f.account.id)).data.map(m => m.capabilities),
    models.map(model => ({ outputTokenLimit: true, automaticOutput: true, jsonSchema: model.id === 'minicpm5-2b' })));
  for (const [index, model] of models.entries()) {
    const body = request({ model: model.id, stream: index % 2 === 1, max_tokens: 64 });
    const first = await f.call(body, 'model-' + index);
    assert.equal(first.status, 200);
    const text = await first.text();
    assert.match(text, /A completed answer/);
    assert.match(text, new RegExp(model.id.replaceAll('.', '\\.')));
    const replay = await f.call(body, 'model-' + index);
    assert.equal(replay.headers.get('x-reach-replayed'), 'true');
    assert.equal(await replay.text(), text);
    assert.equal(sent[index].url, gpuBridge(model.bridge).url);
    assert.equal(sent[index].payload.model, model.bridge.model);
    assert.equal(sent[index].payload.max_tokens, 64);
    assert.equal(sent[index].payload.stream, false);
    assert.deepEqual(sent[index].payload.chat_template_kwargs, { enable_thinking: true });
    if (model.id === 'ornith-1.5-9b') {
      assert.equal(sent[index].payload.temperature, 0.6);
      assert.equal(sent[index].payload.top_p, 0.95);
      assert.equal(sent[index].payload.top_k, 20);
    } else {
      assert.equal(sent[index].payload.temperature, 1.0);
      assert.equal(sent[index].payload.top_p, 0.95);
      if (model.id === 'minicpm5-2b') assert.equal(sent[index].payload.min_p, 0);
      else assert.equal(sent[index].payload.top_k, 64);
    }
    assert.equal(sent[index].options.headers.authorization, undefined);
    assert.equal(sent[index].options.redirect, 'error');
  }
  assert.equal(sent.length, models.length);
  assert.ok(f.gateway.catalog(f.store.account(f.account.id)).data.every(model => model.max_input_bytes === 32000 && model.input_limit_scope === 'messages'));
  assert.equal(f.store.requestAllowance(f.account.id).completed, models.length);
  assert.equal(f.store.requestAllowance(f.account.id).reserved, 0);
});

test('unfunded accounts and invalid output limits never reach a GPU', async t => {
  let sent = 0;
  const f = await fixture(t, async () => { sent++; throw new Error('Must not dispatch.'); }, { paid: false });
  assert.equal((await f.call()).status, 402);
  assert.equal((await f.call(request({ max_tokens: 1000001 }), 'oversized')).status, 400);
  assert.equal((await f.call(request({ model: 'codegpt-gpt-5' }), 'unconfigured')).status, 404);
  assert.equal(sent, 0);
});

test('oversized subscription input reports the exact byte limit and scope before dispatch', async t => {
  const f = await fixture(t, async () => { throw new Error('Must not dispatch.'); });
  const response = await f.call(request({ messages: [{ role: 'user', content: 'x'.repeat(models[0].maxInputBytes) }] }));
  assert.equal(response.status, 400);
  const { error } = await response.json();
  assert.equal(error.max_input_bytes, models[0].maxInputBytes);
  assert.equal(error.input_limit_scope, 'messages');
  assert.equal(f.store.requestAllowance(f.account.id).completed, 0);
  assert.equal(f.store.requestAllowance(f.account.id).reserved, 0);
});

test('automatic subscription input has no inherited 32KB or 512KB gateway ceiling', async t => {
  const automatic = models.map(({ maxInputBytes, ...model }) => model);
  let sent = 0;
  const f = await fixture(t, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.messages.length, 150);
    assert.equal(body.messages.reduce((sum, message) => sum + message.content.length, 0), 600000);
    assert.equal(body.max_tokens, undefined);
    sent++;
    return answer(body.model);
  }, { models: automatic });
  assert.ok(f.gateway.catalog(f.store.account(f.account.id)).data.every(model =>
    !Object.hasOwn(model, 'max_input_bytes') && !Object.hasOwn(model, 'input_limit_scope')));
  for (const model of automatic) {
    const response = await f.call(request({ model: model.id, messages: Array.from({ length: 150 }, () => ({ role: 'user', content: 'x'.repeat(4000) })) }), model.id);
    assert.equal(response.status, 200);
  }
  assert.equal(sent, automatic.length);
});

test('GPU schemas reach only the fixed GPU route and participate in replay identity', async t => {
  const format = { type: 'json_schema', json_schema: { name: 'reach_action', strict: false,
    schema: { type: 'object', properties: { status: { type: 'string', enum: ['complete'] } } } } };
  let sent = 0;
  const f = await fixture(t, async (_url, options) => {
    sent++; assert.deepEqual(JSON.parse(options.body).response_format, format);
    return answer(models[0].bridge.model);
  });
  assert.equal((await f.call(request({ response_format: format }), 'schema')).status, 200);
  assert.equal((await f.call(request(), 'schema')).status, 409, 'changing schema cannot reuse a paid completion');
  const external = structuredClone(format); external.json_schema.schema.$ref = 'https://example.com/schema';
  assert.equal((await f.call(request({ response_format: external }), 'external')).status, 400);
  const unnamed = structuredClone(format); delete unnamed.json_schema.name;
  assert.equal((await f.call(request({ response_format: unnamed }), 'unnamed')).status, 400);
  assert.equal(sent, 1);
});

test('GPU JSON object mode is forwarded and answers without a thinking trace', async t => {
  let sent;
  const f = await fixture(t, async (_url, options) => {
    sent = JSON.parse(options.body);
    return answer(models[0].bridge.model);
  });
  const response = await f.call(request({ response_format: { type: 'json_object' } }), 'json-object');
  assert.equal(response.status, 200);
  assert.deepEqual(sent.response_format, { type: 'json_object' });
  assert.equal(sent.chat_template_kwargs.enable_thinking, false);
  assert.equal((await f.call(request({ response_format: { type: 'json_object', schema: {} } }), 'json-object-extra')).status, 400);
});

test('Gemma Agent schema requests keep native reasoning enabled in the final GPU payload', async t => {
  const actionCodec = createRequire(import.meta.url)('../../vscode/agent-action.js');
  const body = actionCodec.prepare({ model: 'gemma-4-12b-qat', stream: true,
    messages: [{ role: 'user', content: 'Read the project files.' }] });
  // Subscription clients leave native thinking defaults to the GPU bridge.
  delete body.chat_template_kwargs;
  const before = structuredClone(body);
  let sent;
  const f = await fixture(t, async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return answer(models[0].bridge.model);
  }, { models: automaticModels });
  const reply = await f.call(body, 'gemma-agent-reasoning');
  assert.equal(reply.status, 200);
  assert.equal(sent.url, 'http://127.0.0.1:18001/v1/chat/completions');
  assert.deepEqual(sent.body.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(sent.body.response_format, body.response_format);
  assert.deepEqual(sent.body.messages, body.messages);
  assert.equal(sent.body.stream, false);
  assert.deepEqual(body, before);
});

test('wrong model identity, empty messages and provider failures release the request without charging', async t => {
  const responses = [() => answer('wrong-model'), () => answer(models[0].bridge.model, { content: '' }),
    () => answer(models[0].bridge.model, { content: null, reasoning_content: '', tool_calls: [] }),
    () => new Response('unavailable', { status: 503 })];
  const f = await fixture(t, async () => responses.shift()());
  for (let index = 0; index < 4; index++) assert.equal((await f.call(request(), 'failure-' + index)).status, 502);
  assert.equal(f.store.requestAllowance(f.account.id).completed, 0);
  assert.equal(f.store.requestAllowance(f.account.id).reserved, 0);
});

test('Supabase request authorization accepts qualified GPU routes and never forwards route URLs or credentials', async () => {
  const sent = [];
  const store = new SupabaseAccountStore({ url: 'https://fixture.supabase.co', secretKey: 'sb_secret_' + '0'.repeat(32),
    models, subscription, fetchImpl: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ result: { id: 'reservation', fresh: true, status: 'reserved' } }),
        { headers: { 'content-type': 'application/json' } });
    } });
  await store.reserveRequest('test-account', 'gpu-supabase', models[0].id, 'fingerprint');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.p_payload.modelQualified, true);
  assert.equal(sent[0].body.p_payload.model, models[0].id);
  assert.doesNotMatch(JSON.stringify(sent), /18001|gpu-bridge|sb_secret/);
});

test('CodeGPT direct models are unavailable to subscription customers before dispatch or billing', async t => {
  const model = { id: 'codegpt-direct-deepseek', name: 'DeepSeek (CodeGPT)', provider: 'CodeGPT direct',
    access: 'requests', metered: true, maxInputBytes: 32000,
    bridge: { kind: 'codegpt-direct', model: 'deepseek-v4.1-flash' } };
  let dispatched = 0;
  const f = await fixture(t, async () => { dispatched++; throw new Error('Must not dispatch.'); }, { models: [model] });
  const body = request({ model: model.id, max_tokens: 64 });
  assert.equal((await f.call(body)).status, 404);
  assert.equal((await f.call(body)).status, 404);
  assert.equal(dispatched, 0);
  assert.equal(f.store.requestAllowance(f.account.id).completed, 0);
  assert.equal(f.store.requestAllowance(f.account.id).reserved, 0);
  assert.deepEqual(f.gateway.catalog(f.store.account(f.account.id)).data, []);
});
