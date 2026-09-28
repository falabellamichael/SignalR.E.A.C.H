import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../service/config.mjs';
import { createAccountStore } from '../service/account-store.mjs';
import { SupabaseAccountStore } from '../service/supabase-store.mjs';
import { Wallet } from 'ethers';

const base = {
  origin: 'https://reach.example', listenHost: '127.0.0.1', port: 20978, chainId: 1,
  upstreamUrl: 'http://127.0.0.1:20777/v1', upstreamKeyEnv: 'REACH_TEST_UPSTREAM',
  models: [], redemption: { enabled: false },
  supabase: { url: 'https://accounts.example', secretKeyEnv: 'REACH_TEST_SUPABASE' },
};
const env = { REACH_TEST_UPSTREAM: 'private-upstream-test-key', REACH_TEST_SUPABASE: 'sb_secret_' + 'x'.repeat(40) };
const jwt = role => 'header.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.signature-for-tests';

test('Supabase storage is explicit, server-only, and never falls back to SQLite', async () => {
  const config = validateConfig(base, process.cwd(), env);
  assert.equal(config.database, undefined);
  const store = createAccountStore(config, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.ok(store instanceof SupabaseAccountStore);
  await assert.rejects(store.account('missing'), { code: 'account_store_unavailable', status: 503 });
  assert.equal(JSON.stringify(store).includes(env.REACH_TEST_SUPABASE), false);
  await store.close();
});

test('configuration rejects public keys, inline secrets, unsafe URLs and ambiguous persistence', () => {
  for (const change of [
    { database: 'private/accounts.sqlite' },
    { supabase: { ...base.supabase, secretKey: env.REACH_TEST_SUPABASE } },
    { supabase: { ...base.supabase, url: 'http://remote.example' } },
    { supabase: { ...base.supabase, url: 'https://user:password@accounts.example' } },
    { supabase: { ...base.supabase, url: 'https://accounts.example/path' } },
    { supabase: { ...base.supabase, url: 'https://accounts.example?key=secret' } },
    { supabase: { ...base.supabase, secretKeyEnv: base.upstreamKeyEnv } },
  ]) assert.throws(() => validateConfig({ ...base, ...change }, process.cwd(), env));
  for (const secret of ['', 'sb_publishable_' + 'x'.repeat(40), jwt('anon'), jwt('authenticated'), env.REACH_TEST_SUPABASE + '\n']) {
    assert.throws(() => validateConfig(base, process.cwd(), { ...env, REACH_TEST_SUPABASE: secret }));
  }
  assert.equal(validateConfig(base, process.cwd(), { ...env, REACH_TEST_SUPABASE: jwt('service_role') }).supabase.secretKey, jwt('service_role'));
});

test('existing durable SQLite configuration remains supported', () => {
  const { supabase, ...sqlite } = base;
  const config = validateConfig({ ...sqlite, database: 'private/accounts.sqlite' }, process.cwd(), env);
  assert.ok(config.database.endsWith('accounts.sqlite'));
  assert.equal(config.supabase, undefined);
});

test('legacy fixed-rate redemption is blocked on mainnet for either account store', () => {
  const redemption = { enabled: true, tokenAddress: '0x' + '22'.repeat(20), rpcUrl: 'http://127.0.0.1:8545', confirmations: 1 };
  const { supabase, ...sqlite } = base;
  for (const storage of [base, { ...sqlite, database: 'private/accounts.sqlite' }]) {
    assert.throws(() => validateConfig({ ...storage, redemption }, process.cwd(), env), /Legacy fixed-rate RCH redemption cannot be enabled on Ethereum mainnet/);
  }
  assert.equal(validateConfig({ ...base, chainId: 31337, redemption }, process.cwd(), env).redemption.enabled, true);
});

test('treasury rollout requires independent signing authority, bounded exposure and priced metering', () => {
  const privateKey = Wallet.createRandom().privateKey;
  const signingEnv = { ...env, REACH_TEST_QUOTES: privateKey };
  const model = { id: 'paid-test', metered: true, pricing: {
    inputUsdMicrosPerMillion: 150000, outputUsdMicrosPerMillion: 600000, cachedInputUsdMicrosPerMillion: 75000,
  } };
  const redemption = { enabled: true, mode: 'treasury',
    tokenAddress: '0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792',
    contractAddress: '0x' + '22'.repeat(20), contractCodeHash: '0x' + 'aa'.repeat(32),
    treasuryAddress: '0x' + '33'.repeat(20), allowedWallets: ['0x' + '44'.repeat(20)],
    quoteSignerKeyEnv: 'REACH_TEST_QUOTES', rpcUrl: 'https://ethereum.example', confirmations: 2,
    maxCreditUsdMicros: 1000000, creditBudgetUsdMicros: 5000000,
  };
  const valid = { ...base, models: [model], redemption };
  assert.equal(validateConfig(valid, process.cwd(), signingEnv).redemption.quoteSignerKey, privateKey);
  for (const change of [
    { quoteSignerKeyEnv: base.upstreamKeyEnv }, { quoteSignerKeyEnv: base.supabase.secretKeyEnv },
    { allowedWallets: [] }, { maxCreditUsdMicros: 1000001 }, { creditBudgetUsdMicros: 5000001 },
    { creditBudgetUsdMicros: 999999 }, { contractCodeHash: '0x1234' },
    { tokenAddress: '0x' + '55'.repeat(20) },
  ]) assert.throws(() => validateConfig({ ...valid, redemption: { ...redemption, ...change } }, process.cwd(), signingEnv));
  assert.throws(() => validateConfig(valid, process.cwd(), env), /quote signing credential/);
  assert.throws(() => validateConfig({ ...valid, models: [{ ...model, metered: false }] }, process.cwd(), signingEnv), /qualified priced model/);
  assert.throws(() => validateConfig({ ...valid, models: [{ ...model, pricing: { ...model.pricing, cachedInputUsdMicrosPerMillion: 150001 } }] }, process.cwd(), signingEnv), /USD model pricing/);
});
