import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { allowedRequest, readinessMatches, sameRuntime, networkFeePlan, DEPLOYMENT } from '../scripts/treasury-deployment-ui.mjs';

test('deployment helper rejects remote origins, forwarded requests, and missing write origin', () => {
  const origin = 'http://127.0.0.1:12345', prefix = '/random-review-token/';
  const req = { method: 'GET', url: prefix + 'state.json', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:12345' } };
  assert.equal(allowedRequest(req, origin, prefix), true);
  for (const headers of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'x-forwarded-for': '127.0.0.1' }]) {
    assert.equal(allowedRequest({ ...req, headers: { ...req.headers, ...headers } }, origin, prefix), false);
  }
  assert.equal(allowedRequest({ ...req, url: '/state.json' }, origin, prefix), false);
  assert.equal(allowedRequest({ ...req, socket: { remoteAddress: '192.168.1.2' } }, origin, prefix), false);
  assert.equal(allowedRequest({ ...req, method: 'POST' }, origin, prefix), false);
  assert.equal(allowedRequest({ ...req, method: 'POST', headers: { ...req.headers, origin, 'content-type': 'application/json' } }, origin, prefix), true);
});

test('activation readiness is bound to contract, treasury, signer, mainnet, and fresh backend check', () => {
  const address = '0x1111111111111111111111111111111111111111', signer = '0x2222222222222222222222222222222222222222';
  const now = Date.now(), ready = { ...DEPLOYMENT, contractAddress: address, quoteSigner: signer, backendReady: true, checkedAt: new Date(now).toISOString() };
  assert.equal(readinessMatches(ready, address, signer, now), true);
  for (const patch of [{ backendReady: false }, { chainId: 31337 }, { treasury: address }, { contractAddress: signer }, { quoteSigner: address }, { checkedAt: new Date(now - 3_600_001).toISOString() }, { checkedAt: new Date(now + 1).toISOString() }]) {
    assert.equal(readinessMatches({ ...ready, ...patch }, address, signer, now), false);
  }
});

test('runtime verifier tolerates only declared immutable bytes and rejects changed code', () => {
  const artifact = { deployedBytecode: '0x6000000055', immutableReferences: { '1': [{ start: 1, length: 3 }] } };
  assert.equal(sameRuntime('0x60abcdef55', artifact), true);
  assert.equal(sameRuntime('0x61abcdef55', artifact), false);
  assert.equal(sameRuntime('0x60abcdef56', artifact), false);
  assert.equal(sameRuntime('0x60abcdef', artifact), false);
});

test('network fee plan pads gas upward and checks the exact EIP-1559 maximum cost', () => {
  const input = { estimatedGas: 983694n, maxFeePerGas: 371378904n, maxPriorityFeePerGas: 100000000n,
    baseFeePerGas: 135689452n, balance: 854948000000000n };
  const plan = networkFeePlan(input);
  assert.equal(BigInt(plan.transaction.gas), 1180433n);
  assert.equal(plan.transaction.type, '0x2');
  assert.equal(BigInt(plan.transaction.maxFeePerGas), input.maxFeePerGas);
  assert.equal(BigInt(plan.transaction.maxPriorityFeePerGas), input.maxPriorityFeePerGas);
  const maximum = 1180433n * input.maxFeePerGas;
  assert.equal(BigInt(plan.networkFee.maximumWei), maximum);
  assert.doesNotThrow(() => networkFeePlan({ ...input, balance: maximum, maxCostWei: maximum }));
  assert.throws(() => networkFeePlan({ ...input, balance: maximum - 1n }), /pending balance/);
  assert.throws(() => networkFeePlan({ ...input, balance: maximum, value: 1n }), /pending balance/);
  assert.throws(() => networkFeePlan({ ...input, maxCostWei: maximum - 1n }), /fee cap/);
  assert.throws(() => networkFeePlan({ ...input, maxFeePerGas: null }), /invalid maxFeePerGas/);
  assert.throws(() => networkFeePlan({ ...input, maxPriorityFeePerGas: input.maxFeePerGas + 1n }), /unusable/);
  assert.throws(() => networkFeePlan({ ...input, baseFeePerGas: input.maxFeePerGas }), /unusable/);
});

const browserSource = await readFile(new URL('../tools/treasury-deployment.js', import.meta.url), 'utf8');
const pendingKey = 'rch-treasury-deployment-pending-v1';
const flush = () => new Promise(resolve => setImmediate(resolve));
function browserHarness(storage, send, options = {}) {
  const elements = new Map();
  const node = id => { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, hidden: false, value: '' }); return elements.get(id); };
  const requests = [], walletMethods = [], walletEvents = new Map();
  const state = { ...DEPLOYMENT, quoteSigner: '0x2222222222222222222222222222222222222222', balanceEth: '0.000854948',
    transactionHash: null, deployment: null, backendReady: false, ...options.state };
  const plan = { transaction: { from: DEPLOYMENT.owner, chainId: '0x1', nonce: '0x20', data: '0x1234',
    type: '0x2', gas: '0x120311', maxFeePerGas: '0x1622c118', maxPriorityFeePerGas: '0x5f5e100' },
    networkFee: { maximumEth: '0.000438388', balanceEth: state.balanceEth, gasLimit: '1180433', maxFeePerGasWei: '371378904', quotedAt: '2026-09-28T00:00:00.000Z' } };
  const context = vm.createContext({ document: { getElementById: node },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { addEventListener() {}, ethereum: options.metamask === false ? undefined : { on: (event, callback) => walletEvents.set(event, callback), async request(request) {
      walletMethods.push(request.method);
      if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return options.accounts || [DEPLOYMENT.owner];
      if (request.method === 'eth_chainId') return options.chain || '0x1';
      if (request.method === 'eth_sendTransaction') { requests.push(request); return send(request); }
      return null;
    } } }, async fetch(path, options) {
      if (path === './record') {
        const body = JSON.parse(options.body);
        assert.match(body.transactionHash, /^0x[0-9a-f]{64}$/);
        state.transactionHash = body.transactionHash;
        state.deployment = { contractAddress: '0x1111111111111111111111111111111111111111', paused: true };
        return { ok: true, json: async () => ({ status: 'verified' }) };
      }
      return { ok: true, json: async () => path === './state.json' ? { ...state } : plan };
    } });
  vm.runInContext(browserSource, context);
  return { node, requests, walletMethods, walletEvents };
}

test('unsigned wallet review survives reload and blocks another send while receipt recovery remains usable', async () => {
  const storage = new Map();
  const first = browserHarness(storage, () => new Promise(() => {}));
  await flush(); await first.node('connect').onclick();
  assert.match(first.node('networkFee').textContent, /0\.000438388 ETH/);
  void first.node('deploy').onclick(); await flush();
  assert.equal(first.requests.length, 1);
  assert.equal(JSON.parse(storage.get(pendingKey)).phase, 'review');
  assert.equal(first.requests[0].params[0].maxFeePerGas, '0x1622c118');
  const reloaded = browserHarness(storage, () => { throw new Error('Duplicate wallet request'); });
  await flush(); await reloaded.node('connect').onclick();
  await reloaded.node('deploy').onclick();
  assert.equal(reloaded.requests.length, 0);
  assert.equal(reloaded.node('deploy').disabled, true);
  assert.equal(reloaded.node('unsignedReview').hidden, false);
  reloaded.node('hash').value = `0x${'a'.repeat(64)}`;
  await reloaded.node('recover').onclick();
  assert.equal(storage.has(pendingKey), false);
  assert.match(reloaded.node('result').textContent, /Verified contract/);
});

test('wallet rejection clears only unsigned review; unknown wallet failures retain the recovery guard', async () => {
  for (const [code, remains] of [[4001, false], [-32603, true]]) {
    const storage = new Map();
    const page = browserHarness(storage, async () => { throw Object.assign(new Error('Wallet failed'), { code }); });
    await flush(); await page.node('connect').onclick(); await page.node('deploy').onclick();
    assert.equal(storage.has(pendingKey), remains);
    if (remains) {
      await page.node('cancelledReview').onclick();
      assert.equal(storage.has(pendingKey), false);
      assert.equal(page.node('deploy').disabled, false);
    }
  }
});

test('reload restores an authorized owner and enables ready activation without a connection prompt', async () => {
  const options = { state: { transactionHash: `0x${'a'.repeat(64)}`, backendReady: true,
    deployment: { contractAddress: '0x1111111111111111111111111111111111111111', paused: true } } };
  const page = browserHarness(new Map(), () => { throw new Error('No transaction should be sent'); }, options);
  await flush();
  assert.equal(page.node('unpause').disabled, false);
  assert.match(page.node('wallet').textContent, /on Ethereum mainnet/);
  await page.node('refresh').onclick();
  assert.equal(page.node('unpause').disabled, false);
  assert.equal(page.walletMethods.includes('eth_requestAccounts'), false);
  assert.equal(page.requests.length, 0);
  options.chain = '0x89';
  page.walletEvents.get('chainChanged')(); await flush();
  assert.equal(page.node('unpause').disabled, true);
  assert.match(page.node('status').textContent, /another network/);
  options.chain = '0x1';
  page.walletEvents.get('chainChanged')(); await flush();
  assert.equal(page.node('unpause').disabled, false);
  assert.equal(page.walletMethods.includes('eth_requestAccounts'), false);
});

test('reload explains missing MetaMask, missing authorization, and wrong wallet without prompting', async () => {
  for (const [options, message] of [[{ metamask: false }, /not available in this browser/],
    [{ accounts: [] }, /no account is connected/],
    [{ accounts: ['0x1111111111111111111111111111111111111111'] }, /Select Account 1/]]) {
    const page = browserHarness(new Map(), () => { throw new Error('No transaction should be sent'); }, options);
    await flush();
    assert.equal(page.node('deploy').disabled, true);
    assert.match(page.node('wallet').textContent, message);
    assert.match(page.node('status').textContent, message);
    assert.equal(page.walletMethods.includes('eth_requestAccounts'), false);
    assert.equal(page.requests.length, 0);
  }
});
