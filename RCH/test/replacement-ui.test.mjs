import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as ethers from 'ethers';
import { compile, sha256 } from '../scripts/compile.mjs';
import { currentEip1559Fees } from '../terminal/public/fees.mjs';

const build = await compile();
const source = (await readFile(new URL('../tools/replacement.js', import.meta.url), 'utf8'))
  .replace("import { currentEip1559Fees } from './fees.mjs';", '');
const admin = '0x1111111111111111111111111111111111111111';
const treasury = '0x5b7a910cDF232543aCB7653D71d6B92f01d342C7';
const token = '0x2222222222222222222222222222222222222222';
const oldSale = '0x3333333333333333333333333333333333333333';
const feed = '0x4444444444444444444444444444444444444444';
const expectedSale = ethers.getCreateAddress({ from: admin, nonce: 5 });
const oracle = { maxAgeSeconds: '7200', minEthUsdE8: '10000000000', maxEthUsdE8: '10000000000000' };
const saleArtifact = build.artifacts.ReachCreditsSale;
const saleInterface = new ethers.Interface(saleArtifact.abi);
const data = (await new ethers.ContractFactory(saleArtifact.abi, saleArtifact.bytecode).getDeployTransaction(
  token, feed, treasury, admin, oracle.maxAgeSeconds, oracle.minEthUsdE8, oracle.maxEthUsdE8)).data;
const plan = { schema: 'rch-sale-replacement-plan-v1', chainId: 1, admin, treasury, token, oldSale,
  feed, expectedSale, oracle, createdAt: new Date(Date.now() - 60000).toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(), dataHash: sha256(data),
  deploymentFee: { maxCostEth: '0.0001' }, transaction: { from: admin, nonce: 5, data } };
const activeManifest = { token, sale: expectedSale, initialSale: oldSale, treasury };
const payment = ethers.parseEther('0.001');
const output = ethers.parseEther('270');
const price = ethers.parseUnits('2700', 8);
const hash = '0x' + 'ab'.repeat(32);

async function render({ candidate = plan, manifest = activeManifest, approve = false } = {}) {
  const nodes = new Map(), storage = new Map(), requests = [], balanceReads = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', disabled: true, children: [],
      addEventListener(event, callback) { this[event] = callback; },
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
    });
    return nodes.get(id);
  };
  const state = { nextAction: 'complete', treasury, paused: false, price, output, chainId: '0x1',
    account: admin, confirmed: false, onQuote: null, onSend: null, refreshError: false };
  const receipt = { hash, status: 1, blockNumber: 123, logs: [
    { address: expectedSale, ...saleInterface.encodeEventLog('Purchased', [admin, payment, output, price]) },
    { address: expectedSale, ...saleInterface.encodeEventLog('ProceedsWithdrawn', [treasury, payment]) },
  ] };
  class BrowserProvider {
    async getBlock() { return { timestamp: 1800000000, baseFeePerGas: 10000000n }; }
    async send(method) {
      assert.equal(method, 'eth_feeHistory');
      return { reward: [['0x989680'], ['0x989680'], ['0x989680']] };
    }
    async estimateGas() { return 150000n; }
    async getBalance(address, blockTag) {
      balanceReads.push({ address, blockTag });
      if (address === admin) return ethers.parseEther('0.01');
      assert.equal(address, treasury);
      // Simulate an RPC caching the pre-purchase "latest" value.
      return ethers.parseEther('1') + (state.confirmed && blockTag === 123 ? payment : 0n);
    }
    async waitForTransaction() { state.confirmed = true; return receipt; }
    async getTransactionReceipt() { return state.confirmed ? receipt : null; }
  }
  class Contract {
    constructor(address, abi) { this.address = address; this.interface = new ethers.Interface(abi); }
    async treasury() { return state.treasury; }
    async MIN_PURCHASE_WEI() { return payment; }
    async quote(value) {
      assert.equal(value, payment);
      state.onQuote?.();
      return [state.output, state.price];
    }
    async paused() { return state.paused; }
    async saleClosed() { return false; }
    async balanceOf(address, options) {
      assert.equal(this.address, token); assert.equal(address, admin);
      balanceReads.push({ address: token, blockTag: options?.blockTag });
      return state.confirmed && options?.blockTag === 123 ? output : 0n;
    }
  }
  const ethereum = {
    on() {},
    async request(request) {
      requests.push(request);
      if (request.method === 'eth_chainId') return state.chainId;
      if (['eth_accounts', 'eth_requestAccounts'].includes(request.method)) return [state.account];
      assert.equal(request.method, 'eth_sendTransaction');
      if (state.onSend) return state.onSend();
      if (approve) return hash;
      throw Object.assign(new Error('User rejected'), { code: 4001 });
    },
  };
  const payloads = { 'plan.json': candidate, 'mainnet.json': manifest, 'sale-artifact.json': saleArtifact,
    'launch-artifact.json': build.artifacts.ReachCreditsLaunch, activate: { updated: true } };
  const context = vm.createContext({
    window: { ethers: { ...ethers, BrowserProvider, Contract }, ethereum },
    document: { getElementById: element, createElement: () => ({}) }, currentEip1559Fees,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key) },
    fetch: async path => {
      if (path === 'state.json') {
        if (state.refreshError) throw new Error('RPC refresh failed');
        return { ok: true, json: async () => ({ nextAction: state.nextAction, state: {},
          adminBalanceEth: '0.01', buyerRch: state.confirmed ? '270.0' : '0.0' }) };
      }
      return { ok: path in payloads, json: async () => payloads[path] };
    },
  });
  await vm.runInContext(source, context);
  return { element, state, requests, storage, receipt, balanceReads,
    click: async id => { assert.equal(element(id).disabled, false, `${id}: ${element('status').textContent}`); await element(id).click(); },
    sends: () => requests.filter(request => request.method === 'eth_sendTransaction') };
}

test('replacement page verifies plans before and after manifest activation with the server hash convention', async () => {
  for (const manifest of [{ token, sale: oldSale }, activeManifest]) {
    const ui = await render({ manifest });
    assert.equal(ui.element('connect').disabled, false, ui.element('status').textContent);
    assert.equal(ui.element('new-sale').textContent, expectedSale);
    assert.equal(ui.element('treasury').textContent, treasury);
    assert.equal(ui.element('step').textContent, 'Replacement is active');
    assert.equal(ui.element('get-quote').disabled, true);
    assert.match(ui.element('expires').textContent, /Deployment completed/);
  }
});

test('invalid plan hashes or an unrelated active manifest leave all wallet actions disabled', async () => {
  for (const options of [
    { candidate: { ...plan, dataHash: '0'.repeat(64) } },
    { manifest: { ...activeManifest, initialSale: token } },
    { manifest: { ...activeManifest, treasury: admin } },
    { candidate: { ...plan, transaction: { ...plan.transaction, data: data + '00' } } },
  ]) {
    const ui = await render(options);
    for (const id of ['connect', 'refresh', 'step', 'get-quote', 'buy']) assert.equal(ui.element(id).disabled, true);
    await ui.element('connect').click();
    assert.equal(ui.requests.length, 0);
  }
});

test('active sale quote and Buy reach one MetaMask request for exactly 0.001 ETH with guarded calldata', async () => {
  const ui = await render();
  await ui.click('connect');
  assert.equal(ui.element('step').disabled, true);
  await ui.click('get-quote');
  await ui.click('buy');
  assert.equal(ui.sends().length, 1, ui.element('status').textContent);
  const tx = ui.sends()[0].params[0];
  assert.equal(tx.from, admin); assert.equal(tx.to, expectedSale); assert.equal(tx.chainId, '0x1');
  assert.equal(BigInt(tx.value), payment);
  const decoded = saleInterface.parseTransaction(tx);
  assert.equal(decoded.name, 'buy');
  assert.equal(decoded.args.minRchOut, output * 9950n / 10000n);
  assert.equal(decoded.args.deadline, 1800000600n);
  assert.ok(BigInt(tx.gas) * BigInt(tx.maxFeePerGas) <= ethers.parseEther('0.0005'));
  assert.equal(ui.element('status').textContent, 'MetaMask request cancelled.');
});

test('real cutover drift between quote verification and submission still blocks the wallet request', async () => {
  const ui = await render();
  await ui.click('connect'); await ui.click('get-quote');
  ui.state.onQuote = () => { ui.state.nextAction = 'open-new-sale'; };
  await ui.click('buy');
  assert.equal(ui.sends().length, 0);
  assert.match(ui.element('status').textContent, /On-chain state changed/);
});

test('wrong treasury, stale quote, paused sale, and wrong chain or account cannot submit payment', async () => {
  for (const change of [
    state => { state.treasury = admin; }, state => { state.price += 1n; },
    state => { state.paused = true; }, state => { state.chainId = '0x5'; },
    state => { state.account = treasury; },
  ]) {
    const ui = await render();
    await ui.click('connect'); await ui.click('get-quote');
    change(ui.state);
    await ui.click('buy');
    assert.equal(ui.sends().length, 0);
  }
});

test('wallet review locks repeat Buy, quote and refresh until cancellation; original errors survive refresh failure', async () => {
  const ui = await render();
  await ui.click('connect'); await ui.click('get-quote');
  let rejectReview, started;
  const reviewing = new Promise(resolve => { started = resolve; });
  ui.state.onSend = () => new Promise((resolve, reject) => { rejectReview = reject; started(); });
  const buy = ui.click('buy');
  await reviewing;
  for (const id of ['connect', 'refresh', 'step', 'get-quote', 'buy']) assert.equal(ui.element(id).disabled, true);
  await ui.element('buy').click();
  assert.equal(ui.sends().length, 1);
  ui.state.refreshError = true;
  rejectReview(Object.assign(new Error('User rejected'), { code: 4001 }));
  await buy;
  assert.equal(ui.element('status').textContent, 'MetaMask request cancelled.');
});

test('confirmed purchase verifies receipt-block balances and preserves success after refresh', async () => {
  const ui = await render({ approve: true });
  await ui.click('connect'); await ui.click('get-quote'); await ui.click('buy');
  assert.equal(ui.sends().length, 1);
  assert.match(ui.element('status').textContent, /Purchase confirmed: 270.0 RCH minted/);
  assert.ok(ui.element('status').textContent.includes(treasury));
  assert.equal(ui.element('rch-balance').textContent, '270.0 RCH');
  assert.equal(ui.element('buy').disabled, true);
  assert.equal(ui.storage.has('rch-replacement-pending'), false);
  assert.ok(ui.balanceReads.some(read => read.address === token && read.blockTag === 123));
  assert.ok(ui.balanceReads.some(read => read.address === treasury && read.blockTag === 123));
});

test('receipt logs from another sale do not prove payment and cannot reuse the confirmed quote', async () => {
  const ui = await render({ approve: true });
  ui.receipt.logs.forEach(log => { log.address = oldSale; });
  await ui.click('connect'); await ui.click('get-quote'); await ui.click('buy');
  assert.match(ui.element('status').textContent, /did not prove the expected RCH mint/);
  assert.equal(ui.element('buy').disabled, true);
});
