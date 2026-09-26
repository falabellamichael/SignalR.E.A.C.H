import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as ethers from 'ethers';
import { compile } from '../scripts/compile.mjs';

const build = await compile();
const source = await readFile(new URL('../tools/mainnet.js', import.meta.url), 'utf8');
const deployer = '0x1111111111111111111111111111111111111111';
const treasury = '0x2222222222222222222222222222222222222222';
const feed = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const config = { chainId: 1, deployer, admin: deployer, treasury, feed,
  maxOracleAgeSeconds: 7200, minEthUsd: '100', maxEthUsd: '100000', maxDeploymentFeeEth: '0.02' };
const artifact = build.artifacts.ReachCreditsLaunch;
const data = (await new ethers.ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(
  deployer, treasury, feed, 7200, ethers.parseUnits('100', 8), ethers.parseUnits('100000', 8))).data;
const gasLimit = 3300000n, maxFeePerGas = 2000000000n;
const plan = { schema: 'rch-deployment-plan-v1', createdAt: new Date().toISOString(),
  config, sourceHash: build.sourceHash,
  tokenAddress: ethers.getCreateAddress({ from: deployer, nonce: 0 }),
  saleAddress: ethers.getCreateAddress({ from: ethers.getCreateAddress({ from: deployer, nonce: 0 }), nonce: 1 }),
  dataHash: createHash('sha256').update(data).digest('hex'),
  maxCostEth: ethers.formatEther(gasLimit * maxFeePerGas),
  transaction: { chainId: 1, from: deployer, nonce: 0, data,
    gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: '1' },
};

async function render(candidate) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: true, addEventListener() {} });
    return nodes.get(id);
  };
  const payloads = new Map([
    ['/plan.json', candidate], ['/launch-artifact.json', artifact],
    ['/sale-artifact.json', build.artifacts.ReachCreditsSale],
  ]);
  const context = vm.createContext({
    window: { ethers }, document: { getElementById: element }, crypto: webcrypto,
    TextEncoder, localStorage: { getItem: () => null },
    fetch: async path => ({ ok: payloads.has(path), json: async () => payloads.get(path) }),
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setTimeout(resolve, 30));
  return element;
}

test('mainnet launch page accepts the separate payer and treasury only with matching calldata', async () => {
  const valid = await render(plan);
  assert.equal(valid('connect').disabled, false);
  assert.equal(valid('deployer').textContent, ethers.getAddress(deployer));
  assert.equal(valid('treasury').textContent, ethers.getAddress(treasury));

  const wrongTreasury = await render({ ...plan, config: { ...config, treasury: ethers.Wallet.createRandom().address } });
  assert.equal(wrongTreasury('connect').disabled, true);
  assert.match(wrongTreasury('status').textContent, /compiled RCH contract/);

  const wrongAdmin = await render({ ...plan, config: { ...config, admin: ethers.Wallet.createRandom().address } });
  assert.equal(wrongAdmin('connect').disabled, true);
  assert.match(wrongAdmin('status').textContent, /reviewed accounts/);

  const backupAdminData = (await new ethers.ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(
    treasury, treasury, feed, 7200, ethers.parseUnits('100', 8), ethers.parseUnits('100000', 8))).data;
  const backupAdmin = await render({ ...plan, config: { ...config, admin: treasury },
    dataHash: createHash('sha256').update(backupAdminData).digest('hex'),
    transaction: { ...plan.transaction, data: backupAdminData } });
  assert.equal(backupAdmin('connect').disabled, false);

  const wrongData = await render({ ...plan, transaction: { ...plan.transaction, data: plan.transaction.data + '00' } });
  assert.equal(wrongData('connect').disabled, true);
  assert.match(wrongData('status').textContent, /reviewed hash/);
});
