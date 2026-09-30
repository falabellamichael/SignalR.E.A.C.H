import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig, loadConfig } from '../service/config.mjs';
import { loadHostConfig } from '../scripts/accounts-host.mjs';

const names = { upstream: 'RCH_TEST_HOST_UPSTREAM', openai: 'RCH_TEST_OPENAI', gemini: 'RCH_TEST_GEMINI', opencode: 'RCH_TEST_OPENCODE', alibaba: 'RCH_TEST_ALIBABA',
  supabase: 'RCH_TEST_HOST_SUPABASE', quotes: 'RCH_TEST_HOST_QUOTES' };
const secrets = { upstream: 'synthetic-private-relay-key', openai: 'synthetic-private-openai-key',
  gemini: 'synthetic-private-gemini-key', opencode: 'synthetic-private-opencode-key', alibaba: 'synthetic-private-alibaba-key', supabase: 'sb_secret_' + 'x'.repeat(40) };
const prices = { inputUsdMicrosPerMillion: 150000, outputUsdMicrosPerMillion: 600000, cachedInputUsdMicrosPerMillion: 75000 };
const model = (provider = 'openai', keyEnv = names.openai) => ({ id: provider + '-model', metered: true,
  maxInputTokens: 128000, maxInputBytes: 64000, maxOutputTokens: 4096,
  pricing: { ...prices }, providerApi: { provider, keyEnv } });
const config = models => ({ origin: 'http://127.0.0.1:20978', port: 20978, chainId: 1,
  database: 'accounts.sqlite', upstreamUrl: 'http://127.0.0.1:20777/v1', upstreamKeyEnv: names.upstream,
  models, redemption: { enabled: false } });
const env = { [names.upstream]: secrets.upstream, [names.openai]: secrets.openai,
  [names.gemini]: secrets.gemini, [names.opencode]: secrets.opencode, [names.alibaba]: secrets.alibaba, [names.supabase]: secrets.supabase };

function secretSafeFailure(job) {
  assert.throws(job, error => {
    for (const secret of Object.values(secrets)) assert.equal(error.message.includes(secret), false, 'error omits credentials');
    return true;
  });
}
function environment(t, values) {
  const previous = new Map(Object.keys(values).map(name => [name, process.env[name]]));
  Object.entries(values).forEach(([name, value]) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  t.after(() => previous.forEach((value, name) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; }));
}
function files(t, raw, providers) {
  const directory = mkdtempSync(join(tmpdir(), 'rch-provider-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (name, value) => {
    const file = join(directory, name);
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    return file;
  };
  const result = { directory, put, configFile: put('config.json', raw), keyFile: put('upstream.key', secrets.upstream) };
  if (providers !== undefined) result.providerFile = put('provider-keys.json', providers);
  return result;
}

test('provider credentials resolve only from declared environment variables without mutating raw configuration', () => {
  const raw = config([model(), { ...model(), id: 'second-openai-model' }, model('gemini', names.gemini), model('opencode', names.opencode), model('alibaba', names.alibaba)]);
  const resolved = validateConfig(raw, process.cwd(), env);
  assert.deepEqual(resolved.models[0].providerApi, { provider: 'openai', apiKey: secrets.openai });
  assert.deepEqual(resolved.models[1].providerApi, resolved.models[0].providerApi, 'same-provider models share a declared key');
  assert.deepEqual(resolved.models[2].providerApi, { provider: 'gemini', apiKey: secrets.gemini });
  assert.deepEqual(resolved.models[3].providerApi, { provider: 'opencode', apiKey: secrets.opencode });
  assert.deepEqual(resolved.models[4].providerApi, { provider: 'alibaba', apiKey: secrets.alibaba });
  assert.deepEqual(raw.models[0].providerApi, { provider: 'openai', keyEnv: names.openai });
  assert.equal(JSON.stringify(raw).includes(secrets.openai), false);
});

test('provider API configuration rejects unsupported providers, inline secrets and authority collisions', () => {
  for (const providerApi of [null, [], { provider: 'other', keyEnv: names.openai },
    { provider: 'openai', keyEnv: names.openai, apiKey: secrets.openai },
    { provider: 'openai', keyEnv: names.openai, api_key: secrets.openai },
    { provider: 'openai', keyEnv: secrets.openai }, { provider: 'openai', keyEnv: names.upstream }]) {
    secretSafeFailure(() => validateConfig(config([{ ...model(), providerApi }]), process.cwd(), env));
  }
  for (const value of [undefined, '', 'short', secrets.openai + '\n', secrets.openai + '\r']) {
    secretSafeFailure(() => validateConfig(config([model()]), process.cwd(), { ...env, [names.openai]: value }));
  }
  const supabase = { ...config([model('openai', names.supabase)]), database: undefined,
    supabase: { url: 'https://accounts.example', secretKeyEnv: names.supabase } };
  secretSafeFailure(() => validateConfig(supabase, process.cwd(), env));
  secretSafeFailure(() => validateConfig({ ...config([model('openai', names.quotes)]),
    redemption: { enabled: false, quoteSignerKeyEnv: names.quotes } }, process.cwd(), { ...env, [names.quotes]: secrets.openai }));
  secretSafeFailure(() => validateConfig(config([model(), model('gemini', names.openai)]), process.cwd(), env));
  secretSafeFailure(() => validateConfig(config([model(), model('opencode', names.openai)]), process.cwd(), env));
  secretSafeFailure(() => validateConfig(config([model(), model('alibaba', names.openai)]), process.cwd(), env));
});

test('scheduled pricing accepts canonical ISO UTC and bounded rates while preserving existing pricing', () => {
  const after = { effectiveAt: '2026-10-05T00:00:00.000Z', ...prices,
    inputUsdMicrosPerMillion: 180000, outputUsdMicrosPerMillion: 720000 };
  const raw = config([{ ...model(), pricingAfter: after }]);
  const result = validateConfig(raw, process.cwd(), env);
  assert.deepEqual(result.models[0].pricing, prices);
  assert.deepEqual(result.models[0].pricingAfter, after);
  assert.equal(validateConfig(config([{ id: 'legacy', metered: true }]), process.cwd(), env).models[0].pricingAfter, undefined);
});

test('scheduled pricing rejects invalid dates, non-positive rates and extra or secret fields', () => {
  const after = { effectiveAt: '2026-10-05T00:00:00.000Z', ...prices };
  for (const effectiveAt of ['2026-10-05', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00.000+00:00',
    '2026-02-30T00:00:00.000Z', '1969-12-31T23:59:59.999Z', 'invalid', 0, null]) {
    secretSafeFailure(() => validateConfig(config([{ ...model(), pricingAfter: { ...after, effectiveAt } }]), process.cwd(), env));
  }
  for (const change of [{ inputUsdMicrosPerMillion: 0 }, { outputUsdMicrosPerMillion: -1 },
    { inputUsdMicrosPerMillion: 1.5 }, { outputUsdMicrosPerMillion: 1_000_000_001 },
    { cachedInputUsdMicrosPerMillion: 150001 }, { apiKey: secrets.openai }]) {
    secretSafeFailure(() => validateConfig(config([{ ...model(), pricingAfter: { ...after, ...change } }]), process.cwd(), env));
  }
  secretSafeFailure(() => validateConfig(config([{ ...model(), pricing: undefined, pricingAfter: after }]), process.cwd(), env));
});

test('daily pricing preserves explicit UTC hours and reviewed baseline and off-peak prices', () => {
  const baseline = { inputUsdMicrosPerMillion: 300000, outputUsdMicrosPerMillion: 1200000, cachedInputUsdMicrosPerMillion: 30000 };
  const daily = { utcStartHour: 14, utcEndHour: 24, inputUsdMicrosPerMillion: 150000,
    outputUsdMicrosPerMillion: 600000, cachedInputUsdMicrosPerMillion: 15000 };
  const raw = config([{ ...model('alibaba', names.alibaba), pricing: baseline, pricingDaily: daily }]);
  const resolved = validateConfig(raw, process.cwd(), env);
  assert.deepEqual(resolved.models[0].pricing, baseline);
  assert.deepEqual(resolved.models[0].pricingDaily, daily);
  assert.deepEqual(resolved.models[0].providerApi, { provider: 'alibaba', apiKey: secrets.alibaba });
  assert.deepEqual(validateConfig(config([{ ...model(), pricingDaily: { ...daily, utcStartHour: 0 } }]), process.cwd(), env).models[0].pricingDaily,
    { ...daily, utcStartHour: 0 }, 'a full UTC day is a valid configured interval');
});

test('daily pricing rejects invalid intervals, prices, unknown fields and ambiguous or missing baselines', () => {
  const daily = { utcStartHour: 14, utcEndHour: 24, ...prices };
  for (const change of [{ utcStartHour: -1 }, { utcStartHour: 24 }, { utcStartHour: 14.5 },
    { utcStartHour: '14' }, { utcEndHour: 0 }, { utcEndHour: 14 }, { utcEndHour: 25 },
    { utcEndHour: 23.5 }, { utcEndHour: '24' }, { inputUsdMicrosPerMillion: 0 },
    { outputUsdMicrosPerMillion: -1 }, { cachedInputUsdMicrosPerMillion: 150001 },
    { timezone: 'UTC+8' }, { effectiveAt: '2026-10-05T00:00:00.000Z' }, { apiKey: secrets.alibaba }]) {
    secretSafeFailure(() => validateConfig(config([{ ...model(), pricingDaily: { ...daily, ...change } }]), process.cwd(), env));
  }
  secretSafeFailure(() => validateConfig(config([{ ...model(), pricing: undefined, pricingDaily: daily }]), process.cwd(), env));
  secretSafeFailure(() => validateConfig(config([{ ...model(), pricingDaily: daily,
    pricingAfter: { effectiveAt: '2026-10-05T00:00:00.000Z', ...prices } }]), process.cwd(), env));
});

test('loadConfig resolves the file-relative legacy database and provider environment seam', t => {
  environment(t, env);
  const fixture = files(t, config([model()]));
  const resolved = loadConfig(fixture.configFile);
  assert.equal(resolved.database, join(fixture.directory, 'accounts.sqlite'));
  assert.deepEqual(resolved.models[0].providerApi, { provider: 'openai', apiKey: secrets.openai });
  const broken = fixture.put('broken.json', '{"apiKey":"' + secrets.openai + '"');
  secretSafeFailure(() => loadConfig(broken));
});

test('private provider JSON loads as fifth launcher argument and restores pre-existing environment values', t => {
  const before = { [names.upstream]: 'inherited-relay', [names.openai]: 'inherited-openai', [names.gemini]: undefined };
  environment(t, before);
  const fixture = files(t, config([model(), model('gemini', names.gemini)]),
    { [names.openai]: secrets.openai, [names.gemini]: secrets.gemini });
  const resolved = loadHostConfig([fixture.configFile, fixture.keyFile, '', '', fixture.providerFile]);
  assert.equal(resolved.upstreamKey, secrets.upstream);
  assert.deepEqual(resolved.models.map(value => value.providerApi), [
    { provider: 'openai', apiKey: secrets.openai }, { provider: 'gemini', apiKey: secrets.gemini }]);
  for (const [name, value] of Object.entries(before)) assert.equal(process.env[name], value);
});

test('OpenCode private credential file uses its separate declared key without touching another provider', t => {
  environment(t, { [names.upstream]: undefined, [names.opencode]: undefined, [names.openai]: 'inherited-openai' });
  const fixture = files(t, config([model('opencode', names.opencode)]), { [names.opencode]: secrets.opencode });
  const resolved = loadHostConfig([fixture.configFile, fixture.keyFile, '', '', fixture.providerFile]);
  assert.deepEqual(resolved.models[0].providerApi, { provider: 'opencode', apiKey: secrets.opencode });
  assert.equal(process.env[names.opencode], undefined);
  assert.equal(process.env[names.upstream], undefined);
  assert.equal(process.env[names.openai], 'inherited-openai');
});

test('Alibaba private credential file resolves independently and restores inherited values on success and failure', t => {
  const before = { [names.upstream]: undefined, [names.alibaba]: 'inherited-alibaba', [names.gemini]: 'inherited-gemini' };
  environment(t, before);
  const fixture = files(t, config([model('alibaba', names.alibaba)]), { [names.alibaba]: secrets.alibaba });
  const args = [fixture.configFile, fixture.keyFile, '', '', fixture.providerFile];
  assert.deepEqual(loadHostConfig(args).models[0].providerApi, { provider: 'alibaba', apiKey: secrets.alibaba });
  for (const [name, value] of Object.entries(before)) assert.equal(process.env[name], value);
  writeFileSync(fixture.configFile, JSON.stringify({ ...config([model('alibaba', names.alibaba)]), port: -1 }));
  secretSafeFailure(() => loadHostConfig(args));
  for (const [name, value] of Object.entries(before)) assert.equal(process.env[name], value);
});

test('legacy two-file and Supabase three-file launch configurations remain compatible and restore environment', t => {
  environment(t, { [names.upstream]: undefined, [names.supabase]: 'inherited-supabase' });
  const fixture = files(t, config([]));
  assert.equal(loadHostConfig([fixture.configFile, fixture.keyFile]).models.length, 0);
  assert.equal(process.env[names.upstream], undefined);
  const supabaseConfig = { ...config([]), database: undefined,
    supabase: { url: 'https://accounts.example', secretKeyEnv: names.supabase } };
  const configFile = fixture.put('supabase.json', supabaseConfig);
  const supabaseKeyFile = fixture.put('supabase.key', secrets.supabase);
  assert.equal(loadHostConfig([configFile, fixture.keyFile, supabaseKeyFile]).supabase.secretKey, secrets.supabase);
  assert.equal(process.env[names.supabase], 'inherited-supabase');
  assert.equal(process.env[names.upstream], undefined);
});

test('legacy four-file treasury launcher preserves the private quote signer environment', t => {
  const quoteKey = '0x' + '11'.repeat(32);
  environment(t, { [names.upstream]: undefined, [names.supabase]: undefined, [names.quotes]: 'inherited-quotes' });
  const raw = { ...config([{ id: 'legacy-mini', metered: true, pricing: { ...prices } }]), database: undefined,
    supabase: { url: 'https://accounts.example', secretKeyEnv: names.supabase },
    redemption: { enabled: true, mode: 'treasury', tokenAddress: '0x6cfb2531696f99cd4511f281abece4b6a67c3792',
      contractAddress: '0x' + '22'.repeat(20), contractCodeHash: '0x' + 'aa'.repeat(32),
      treasuryAddress: '0x' + '33'.repeat(20), allowedWallets: ['0x' + '44'.repeat(20)],
      quoteSignerKeyEnv: names.quotes, rpcUrl: 'https://ethereum.example', confirmations: 2,
      maxCreditUsdMicros: 1000000, creditBudgetUsdMicros: 5000000 } };
  const fixture = files(t, raw);
  const supabaseFile = fixture.put('supabase.key', secrets.supabase);
  const quoteFile = fixture.put('quotes.key', quoteKey);
  assert.equal(loadHostConfig([fixture.configFile, fixture.keyFile, supabaseFile, quoteFile]).redemption.quoteSignerKey, quoteKey);
  assert.equal(process.env[names.quotes], 'inherited-quotes');
  assert.equal(process.env[names.supabase], undefined);
  assert.equal(process.env[names.upstream], undefined);
});

test('launcher cleanup covers loadConfig failure after temporary host and provider secrets are installed', t => {
  const before = { [names.upstream]: 'inherited-relay', [names.openai]: undefined, [names.supabase]: 'inherited-supabase' };
  environment(t, before);
  const raw = { ...config([model()]), port: -1, database: undefined,
    supabase: { url: 'https://accounts.example', secretKeyEnv: names.supabase } };
  const fixture = files(t, raw, { [names.openai]: secrets.openai });
  const supabaseFile = fixture.put('supabase.key', secrets.supabase);
  secretSafeFailure(() => loadHostConfig([fixture.configFile, fixture.keyFile, supabaseFile, '', fixture.providerFile]));
  for (const [name, value] of Object.entries(before)) assert.equal(process.env[name], value);
});

test('provider credential file rejects undeclared variables, unsafe values, missing keys and non-regular files', t => {
  environment(t, { [names.upstream]: 'inherited-relay', [names.openai]: undefined });
  const fixture = files(t, config([model()]));
  for (const providerKeys of [{ [names.openai]: secrets.openai, OWNER_PRIVATE: secrets.gemini },
    { [names.openai]: secrets.openai, [names.upstream]: secrets.upstream }, {}, [],
    { [names.openai]: 123 }, { [names.openai]: secrets.openai + '\n' }]) {
    const providerFile = fixture.put('provider-keys.json', providerKeys);
    secretSafeFailure(() => loadHostConfig([fixture.configFile, fixture.keyFile, '', '', providerFile]));
    assert.equal(process.env[names.upstream], 'inherited-relay');
    assert.equal(process.env[names.openai], undefined);
  }
  secretSafeFailure(() => loadHostConfig([fixture.configFile, fixture.keyFile, '', '', fixture.directory]));
  const malformed = fixture.put('provider-keys.json', '{"' + names.openai + '":"' + secrets.openai + '"');
  secretSafeFailure(() => loadHostConfig([fixture.configFile, fixture.keyFile, '', '', malformed]));
});

test('launcher console failure omits raw configuration secrets', t => {
  const fixture = files(t, config([{ ...model(), providerApi: { provider: 'openai', keyEnv: names.openai, apiKey: secrets.openai } }]),
    { [names.openai]: secrets.openai });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/accounts-host.mjs', import.meta.url)),
    fixture.configFile, fixture.keyFile, '', '', fixture.providerFile], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Account service setup failed/);
  for (const secret of Object.values(secrets)) assert.equal((result.stdout + result.stderr).includes(secret), false);
});
