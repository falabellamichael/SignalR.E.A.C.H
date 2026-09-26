import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, Contract, parseEther } from 'ethers';
import { chain, send } from './helpers/chain.mjs';
import { compile } from '../scripts/compile.mjs';
import { configFrom, validateRpcUrl, prepare, broadcast, inspectDeployment, purchaseQuote } from '../scripts/workflow.mjs';

const build = await compile();
async function setup(t) {
  const f = await chain(t);
  const dir = await mkdtemp(join(tmpdir(), 'rch-workflow-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { chainId: 1337, deployer: await f.deployer.getAddress(), admin: await f.admin.getAddress(), treasury: await f.treasury.getAddress(), feed: await f.feed.getAddress(), maxOracleAgeSeconds: 3600, minEthUsd: '100', maxEthUsd: '100000', maxDeploymentFeeEth: '1' };
  const wallet = new Wallet(f.rpc.getInitialAccounts()[config.deployer.toLowerCase()].secretKey);
  return { ...f, config, wallet, dir };
}

test('production build is reproducible and excludes mock contracts', async () => {
  const second = await compile();
  assert.equal(build.sourceHash, second.sourceHash);
  assert.deepEqual(build.artifacts, second.artifacts);
  assert.equal(build.artifacts.MockEthUsdFeed, undefined);
  assert.ok(Object.keys(build.input.sources).some((name) => name.startsWith('@openzeppelin/')));
});

test('configuration rejects missing addresses, unsafe RPCs, L2 chains, numeric prices, and ambiguous fields', async (t) => {
  const f = await setup(t);
  assert.throws(() => configFrom({ ...f.config, chainId: 10 }), /Only Ethereum/);
  assert.throws(() => configFrom({ ...f.config, minEthUsd: 100 }), /decimal string/);
  assert.throws(() => configFrom({ ...f.config, typo: true }), /unknown fields/);
  assert.throws(() => configFrom({ ...f.config, admin: '0x0000000000000000000000000000000000000000' }), /zero address/);
  assert.throws(() => validateRpcUrl('http://example.com', 1), /HTTPS/);
  assert.throws(() => validateRpcUrl('https://example.com', 1337), /loopback/);
  assert.equal(validateRpcUrl('http://127.0.0.1:8545', 1337), 'http://127.0.0.1:8545');
  await assert.rejects(prepare(f.provider, { ...f.config, chainId: 1 }, build), /chain ID/);
  await assert.rejects(prepare(f.provider, { ...f.config, maxDeploymentFeeEth: '0.000000000001' }, build), /cost exceeds/);
});

test('reviewed local plan deploys atomically, verifies code, and produces executable purchase calldata', async (t) => {
  const f = await setup(t);
  const plan = await prepare(f.provider, f.config, build);
  const out = join(f.dir, 'deployment.json');
  const record = await broadcast(f.provider, plan, build, f.wallet, out, 1337);
  assert.equal(record.state, 'verified');
  assert.equal(JSON.parse(await readFile(out, 'utf8')).txHash, record.txHash);
  const { state, sale } = await inspectDeployment(f.provider, record, build, { initial: true });
  assert.equal(state.salePaused, true);
  await assert.rejects(purchaseQuote(f.provider, record, build, '0.004'), /not accepting/);
  await send(sale.connect(f.admin).unpause());
  await assert.rejects(purchaseQuote(f.provider, record, build, '0.0009'), /Minimum purchase is 0.001 ETH/);
  const minimumQuote = await purchaseQuote(f.provider, record, build, '0.001');
  assert.equal(minimumQuote.transaction.value, `0x${parseEther('0.001').toString(16)}`);
  const quote = await purchaseQuote(f.provider, record, build, '0.004');
  const tx = await f.buyer.sendTransaction(quote.transaction);
  await tx.wait();
  const token = new Contract(record.plan.tokenAddress, build.artifacts.ReachCreditsLaunch.abi, f.provider);
  assert.ok(await token.balanceOf(await f.buyer.getAddress()) > 0n);
  await assert.rejects(inspectDeployment(f.provider, { ...record, plan: { ...record.plan, sourceHash: 'wrong' } }, build), /source hash/);
  await assert.rejects(inspectDeployment(f.provider, { ...record, plan: { ...record.plan, saleAddress: f.config.feed } }, build), /code does not match/);
});

test('wrong signer, chain confirmation, stale plan, modified build, and reused output cannot send a deployment', async (t) => {
  const f = await setup(t);
  const plan = await prepare(f.provider, f.config, build);
  const out = join(f.dir, 'deploy.json');
  const before = await f.provider.getTransactionCount(f.config.deployer);
  await assert.rejects(broadcast(f.provider, plan, build, f.wallet, out, 1), /confirmation/);
  await assert.rejects(broadcast(f.provider, plan, build, Wallet.createRandom(), out, 1337), /Signing account/);
  await assert.rejects(broadcast(f.provider, { ...plan, createdAt: '2000-01-01' }, build, f.wallet, out, 1337), /expired/);
  await assert.rejects(broadcast(f.provider, { ...plan, sourceHash: 'modified' }, build, f.wallet, out, 1337), /Code or deployer nonce/);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, 'existing record');
  await assert.rejects(broadcast(f.provider, plan, build, f.wallet, out, 1337), { code: 'EEXIST' });
  assert.equal(await f.provider.getTransactionCount(f.config.deployer), before);
});

test('a changed deployer nonce invalidates its prepared addresses before broadcasting', async (t) => {
  const f = await setup(t);
  const plan = await prepare(f.provider, f.config, build);
  await send(f.deployer.sendTransaction({ to: f.config.treasury, value: parseEther('0.0001') }));
  await assert.rejects(broadcast(f.provider, plan, build, f.wallet, join(f.dir, 'out.json'), 1337), /nonce changed/);
});

test('an uncertain RPC response preserves the signed transaction hash for verification', async (t) => {
  const f = await setup(t);
  const plan = await prepare(f.provider, f.config, build);
  const out = join(f.dir, 'uncertain.json');
  const interrupted = new Proxy(f.provider, {
    get(target, property) {
      if (property === 'broadcastTransaction') return async (raw) => {
        await target.broadcastTransaction(raw);
        throw new Error('Simulated connection loss after node acceptance');
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(broadcast(interrupted, plan, build, f.wallet, out, 1337), /requires verification/);
  const record = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(record.state, 'needs-verification');
  assert.ok(await f.provider.getTransactionReceipt(record.txHash));
  assert.equal((await inspectDeployment(f.provider, record, build, { initial: true })).state.salePaused, true);
});
