import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createAccountService } from '../service/server.mjs';
import { validateConfig } from '../service/config.mjs';
import { basicPlanModelIds, digest, requestModel } from '../service/store.mjs';
import { hostedGpuModel } from '../service/gpu-bridge.mjs';

const { models: gpu } = JSON.parse(readFileSync(new URL('../config/subscription-gpu.example.json', import.meta.url)));
const activeGpu = gpu.filter(model => model.metered === true);
const subscription = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15000000 },
  overageUsdMicrosPerRequest: 10000, proEnabled: false };
const browser = ['chatgpt-chat', 'copilot-chat', 'gemini-chat'].map(id => ({ id, provider: 'Login Provider',
  access: 'requests', metered: true, bridge: { kind: 'tray', model: id } }));
const login = [...browser,
  { id: 'rch-gpt-4o-mini', provider: 'CodeGPT', access: 'requests', metered: true,
    bridge: { kind: 'codegpt', model: 'codegpt-gpt-4o-mini' } },
  { id: 'codegpt-direct-deepseek', provider: 'CodeGPT direct', access: 'requests', metered: true,
    bridge: { kind: 'codegpt-direct', model: 'deepseek-v4.1-flash' } },
  { id: 'priced-login-alias', upstreamModel: 'codegpt-gpt-5', provider: 'CodeGPT', metered: true,
    maxInputTokens: 64000, maxInputBytes: 32000, maxOutputTokens: 4096,
    pricing: { inputUsdMicrosPerMillion: 100, outputUsdMicrosPerMillion: 100 } },
  { id: 'unrelated-provider', provider: 'Other provider', metered: true,
    maxInputTokens: 64000, maxInputBytes: 32000, maxOutputTokens: 4096 },
];

test('only deployed GPU targets qualify for API and request access', () => {
  assert.ok(gpu.every(hostedGpuModel));
  assert.deepEqual(gpu.filter(requestModel), activeGpu);
  assert.ok(login.every(model => !hostedGpuModel(model) && !requestModel(model)));
  assert.equal(hostedGpuModel({ ...gpu[0], id: 'chatgpt-chat' }), false);
  assert.equal(hostedGpuModel({ ...gpu[0], id: 'codegpt-gpt-5' }), false);
  assert.equal(hostedGpuModel({ ...gpu[0], bridge: { kind: 'gpu', model: 'ibm-granite/granite-4.2-3b-fp8' } }), false);
  assert.deepEqual(basicPlanModelIds([...gpu, ...login]), activeGpu.map(model => model.id).sort());
});

test('mixed private catalogs remain intact while every public model surface and explicit inference is GPU-only', async t => {
  const models = structuredClone([...gpu, ...login]);
  const config = validateConfig({ origin: 'https://accounts.example', port: 20978, chainId: 31337,
    database: 'private/accounts.sqlite', upstreamUrl: 'http://127.0.0.1:20777/v1',
    upstreamKeyEnv: 'REACH_TEST_UPSTREAM', models, subscription, redemption: { enabled: false } },
  process.cwd(), { REACH_TEST_UPSTREAM: 'server-only-test-relay-credential' });
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('Unavailable models cannot reserve or dispatch.'); };
  const account = { id: 'fixture', allowedModels: models.filter(model => model.metered === true), walletAddress: null, plan: { id: 'basic-wallet', status: 'active' } };
  const store = { models, reserveRequest: forbidden, settleRequest: forbidden, releaseRequest: forbidden,
    markRequestUncertain: forbidden, reserve: forbidden, reserveUsd: forbidden,
    authenticate: () => account, account: () => account, pruneExpiredAuthentication: () => {} };
  const service = createAccountService({ config, store, fetchImpl: forbidden });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  t.after(async () => { service.server.closeAllConnections(); await new Promise(resolve => service.server.close(resolve)); });
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const get = async path => {
    const response = await fetch(origin + path, { headers: { authorization: 'Bearer fixture' } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const expected = activeGpu.map(model => model.id);
  assert.deepEqual((await get('/v1/account/config')).redemptionModels.map(model => model.id), expected);
  assert.deepEqual((await get('/v1/account')).allowedModels.map(model => model.id), expected);
  assert.deepEqual((await get('/v1/models')).data.map(model => model.id), expected);
  assert.equal(service.config().modelsRevision, digest(JSON.stringify(models)));
  assert.deepEqual(config.models, models);
  for (const model of [...gpu.filter(model => model.metered !== true), ...login, { id: 'auto' }, { id: 'default' }]) {
    const response = await fetch(origin + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'Hello.' }] }) });
    assert.equal(response.status, 404, model.id);
    assert.equal((await response.json()).error.code, 'model_unavailable');
  }
  assert.equal(calls, 0);
  const next = structuredClone(models);
  next[0].maxOutputTokens = 8192;
  next.at(-1).name = 'Retained private model';
  service.updateModels(next);
  assert.deepEqual(config.models, next);
  assert.equal(service.config().modelsRevision, digest(JSON.stringify(next)));
  assert.deepEqual(service.config().redemptionModels.map(model => model.id), expected);
  assert.deepEqual((await get('/v1/models')).data.map(model => model.id), expected);
  assert.equal(calls, 0);
});
