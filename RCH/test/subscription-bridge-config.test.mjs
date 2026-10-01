import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { validateConfig } from '../service/config.mjs';
import { createAccountService } from '../service/server.mjs';
import { AccountError } from '../service/store.mjs';

const subscription = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15000000 }, overageUsdMicrosPerRequest: 10000, proEnabled: false };
const model = { id: 'chatgpt-chat', name: 'ChatGPT chat', provider: 'ChatGPT bridge', access: 'requests', metered: true,
  bridge: { kind: 'tray', model: 'chatgpt-chat' }, maxInputTokens: 64000, maxInputBytes: 32000, maxOutputTokens: 4096 };
const base = { origin: 'https://accounts.example', listenHost: '127.0.0.1', port: 20978, chainId: 31337,
  database: 'private/accounts.sqlite', upstreamUrl: 'http://127.0.0.1:20777/v1', upstreamKeyEnv: 'REACH_TEST_UPSTREAM',
  models: [model], subscription, redemption: { enabled: false } };
const env = { REACH_TEST_UPSTREAM: 'server-only-test-relay-credential' };

test('Basic request policy validates without any personal provider credential', () => {
  const config = validateConfig(base, process.cwd(), env);
  assert.deepEqual(config.subscription, subscription);
  assert.deepEqual(config.models[0].bridge, model.bridge);
  assert.equal(config.subscription.proEnabled, false);
  assert.equal(config.providerApi, undefined);
});

test('request access rejects token pricing, relay inference and arbitrary bridge destinations', () => {
  for (const change of [
    { pricing: { inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1 } },
    { upstreamModel: 'openai/gpt-4o-mini' }, { providerApi: { provider: 'alibaba', keyEnv: 'OWNER_KEY' } },
    { bridge: { kind: 'tray', model: 'chatgpt-chat', url: 'https://api.openai.com/v1' } },
    { bridge: { kind: 'openai', model: 'gpt-4o-mini' } }, { bridge: { kind: 'tray', model: 'gpt-4o-mini' } },
    { bridge: { kind: 'tray', model: 'codegpt-eco-gpt-4o-mini' } }, { bridge: { kind: 'codegpt', model: 'gpt-4o-mini' } },
    { bridge: { kind: 'tray', model: 'chatgpt-chat', apiKey: 'private-test-credential' } },
  ]) assert.throws(() => validateConfig({ ...base, models: [{ ...model, ...change }] }, process.cwd(), env));
  const { subscription: absent, ...without } = base;
  assert.throws(() => validateConfig(without, process.cwd(), env));
  assert.throws(() => validateConfig({ ...base, models: [{ ...model, access: undefined }] }, process.cwd(), env));
});

test('Basic policy rejects malformed limits, hidden Pro activation and secret fields', () => {
  for (const change of [
    { proEnabled: true }, { proEnabled: undefined }, { stripeKey: 'private-test-credential' },
    { overageUsdMicrosPerRequest: 0 }, { overageUsdMicrosPerRequest: 0.01 }, { overageUsdMicrosPerRequest: '10000' },
    { basic: { ...subscription.basic, includedRequests: -1 } }, { basic: { ...subscription.basic, includedRequests: 1.5 } },
    { basic: { ...subscription.basic, includedRequests: '1500' } }, { basic: { ...subscription.basic, includedRequests: 2000 } }, { basic: { ...subscription.basic, id: 'pro' } },
    { basic: { ...subscription.basic, priceUsdMicros: 0 } }, { overageUsdMicrosPerRequest: 20000 }, { basic: { ...subscription.basic, paypalToken: 'private-test-credential' } },
  ]) assert.throws(() => validateConfig({ ...base, subscription: { ...subscription, ...change } }, process.cwd(), env));
});

test('public model and plan metadata excludes private bridge routing and requires authentication', async t => {
  const config = validateConfig(base, process.cwd(), env);
  const forbidden = () => { throw new Error('Public metadata must not reserve or settle a request.'); };
  const store = { reserveRequest: forbidden, settleRequest: forbidden, releaseRequest: forbidden, markRequestUncertain: forbidden,
    authenticate: () => { throw new AccountError(401, 'session_expired', 'Sign in to your account.'); } };
  const { server } = createAccountService({ config, store, balanceProvider: {}, redemptionProvider: {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + '/v1/account/config');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.subscription, subscription);
  assert.deepEqual(body.redemptionModels[0], { id: model.id, name: model.name, provider: model.provider, access: 'requests', capabilities: { outputTokenLimit: false },
    pricing: { unit: 'request', includedRequests: 1500, usdMicrosPerRequest: 10000 } });
  assert.equal(/bridge|upstreamKey|21302|apiKey/.test(JSON.stringify(body).replace('ChatGPT bridge', '')), false);
  const protectedModels = await fetch(origin + '/v1/models');
  assert.equal(protectedModels.status, 401);
  await protectedModels.body.cancel();
});
