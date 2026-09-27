import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { createTokenBalanceReader } from '../service/token-balance.mjs';
import { AccountStore } from '../service/store.mjs';
import { createAccountService } from '../service/server.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const tokenAddress = '0x2222222222222222222222222222222222222222';
const abi = new Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
const config = { chainId: 1, origin: 'http://127.0.0.1:20978', models: [],
  upstreamUrl: 'http://127.0.0.1:20777/v1', upstreamKey: 'test-credential-only',
  redemption: { enabled: false, tokenAddress, rpcUrl: 'https://rpc.invalid' } };
function rpc() {
  const state = { balance: 269565909309000000000n, chain: 1n, decimals: 18n, fail: false, calls: [] };
  return { state, provider: {
    getNetwork: async () => ({ chainId: state.chain }), getBlockNumber: async () => 123,
    call: async tx => {
      state.calls.push(tx);
      assert.equal(tx.to.toLowerCase(), tokenAddress.toLowerCase());
      assert.equal(tx.blockTag, 123);
      if (state.fail) throw new Error('RPC is offline');
      const decoded = abi.parseTransaction(tx);
      if (decoded.name === 'balanceOf') assert.equal(decoded.args[0], wallet);
      return abi.encodeFunctionResult(decoded.name, [decoded.name === 'decimals' ? state.decimals : state.balance]);
    },
  } };
}

test('reads exact RCH holdings at one block while redemption remains disabled', async () => {
  const { provider, state } = rpc();
  const reader = createTokenBalanceReader({ config, provider });
  assert.deepEqual(await reader.read(wallet), { status: 'available', chainId: 1, tokenAddress,
    decimals: 18, balanceBaseUnits: '269565909309000000000', blockNumber: 123 });
  state.balance = 0n;
  assert.equal((await reader.read(wallet)).balanceBaseUnits, '0');
  assert.equal(config.redemption.enabled, false);
  reader.close();
});

test('unconfigured, wrong-chain, wrong-decimal and failed RPC reads never report a false zero', async () => {
  const { provider, state } = rpc();
  const unconfigured = createTokenBalanceReader({ config: { ...config, redemption: { enabled: false } }, provider });
  assert.equal((await unconfigured.read(wallet)).status, 'unconfigured');
  assert.equal(state.calls.length, 0);
  const reader = createTokenBalanceReader({ config, provider });
  for (const change of [() => { state.chain = 5n; }, () => { state.chain = 1n; state.decimals = 6n; },
    () => { state.decimals = 18n; state.fail = true; }]) {
    change();
    const result = await reader.read(wallet);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.balanceBaseUnits, null);
  }
});

test('a whole-read deadline returns unavailable while a slow RPC stage is still pending', async () => {
  for (const stage of ['getNetwork', 'getBlockNumber', 'call']) {
    const { provider, state } = rpc();
    let release, networkDone = false, blocks = 0;
    const blocked = new Promise(resolve => { release = resolve; });
    const originalNetwork = provider.getNetwork, originalBlock = provider.getBlockNumber, originalCall = provider.call;
    provider.getNetwork = async () => { if (stage === 'getNetwork') await blocked; networkDone = true; return originalNetwork(); };
    provider.getBlockNumber = async () => { blocks++; if (stage === 'getBlockNumber') await blocked; return originalBlock(); };
    provider.call = async tx => { if (stage === 'call') await blocked; return originalCall(tx); };
    const reader = createTokenBalanceReader({ config, provider, timeoutMs: 15 });
    const pending = reader.read(wallet);
    let guard;
    try {
      const result = await Promise.race([pending, new Promise(resolve => { guard = setTimeout(() => resolve({ status: 'test_deadline_exceeded' }), 250); })]);
      assert.equal(result.status, 'unavailable', `the complete lookup must stop waiting during ${stage}`);
      assert.equal(result.balanceBaseUnits, null, 'a timeout must never fabricate a zero balance');
      assert.equal(result.blockNumber, null);
      if (stage === 'getNetwork') assert.equal(networkDone, false);
    } finally { clearTimeout(guard); release(); await pending; reader.close(); }
    await new Promise(resolve => setImmediate(resolve));
    if (stage === 'getNetwork') assert.equal(blocks, 0, 'an expired lookup must not start the next RPC stage');
    if (stage !== 'call') assert.equal(state.calls.length, 0, 'an expired lookup must not start token contract calls');
  }
});

test('authenticated account returns wallet holdings without granting a plan, credit or redemption', async t => {
  const store = new AccountStore(':memory:');
  const account = store.ensureAccount(wallet);
  const accessToken = 'rch_session_' + '12'.repeat(32);
  const { createHash } = await import('node:crypto');
  store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(accessToken).digest('hex'), account.id, Date.now() + 60000);
  const { provider, state } = rpc();
  const { server } = createAccountService({ config, store, balanceProvider: provider });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer ' + accessToken };
  assert.equal((await fetch(base + '/v1/account')).status, 401);
  const result = await (await fetch(base + '/v1/account', { headers })).json();
  assert.equal(result.rchBalance.balanceBaseUnits, '269565909309000000000');
  assert.equal(result.walletAddress, wallet);
  assert.equal(result.plan.status, 'none');
  assert.equal(result.allowance.prepaidRemaining, 0);
  assert.equal(result.allowance.totalRemaining, 0);
  assert.equal(result.redemption.enabled, false);
  assert.equal(result.redemption.tokensPerRch, null);
  const publicConfig = await (await fetch(base + '/v1/account/config')).json();
  assert.equal(publicConfig.tokenAddress, tokenAddress);
  assert.equal(publicConfig.redemptionEnabled, false);
  assert.equal(publicConfig.tokensPerRch, null);
  state.fail = true;
  const failedRpc = await fetch(base + '/v1/account', { headers });
  assert.equal(failedRpc.status, 200);
  const unavailable = await failedRpc.json();
  assert.equal(unavailable.rchBalance.status, 'unavailable');
  assert.equal(unavailable.walletAddress, wallet);
});
