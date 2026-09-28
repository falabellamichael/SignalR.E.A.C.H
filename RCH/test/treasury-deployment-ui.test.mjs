import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { Interface } from 'ethers';
import { allowedRequest, readinessMatches, sameRuntime, networkFeePlan, activationWalletMode, smartActivationPlan, activationReceiptMatches, DEPLOYMENT } from '../scripts/treasury-deployment-ui.mjs';

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

test('smart activation is a single call without direct transaction gas, nonce, or fee limits', () => {
  assert.equal(activationWalletMode('0x'), 'eoa');
  assert.equal(activationWalletMode('0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b'), 'eip7702');
  assert.throws(() => activationWalletMode('0xef01001111111111111111111111111111111111111111'), /unsupported/);
  assert.throws(() => activationWalletMode('0x60006000'), /unsupported/);
  const plan = smartActivationPlan({ contractAddress: '0x1111111111111111111111111111111111111111', data: '0x3f4ba83a',
    estimatedGas: 40000n, maxFeePerGas: 400000000n, balance: 500000000000000n });
  assert.equal(plan.mode, 'wallet_sendCalls');
  assert.deepEqual(plan.calls, [{ to: '0x1111111111111111111111111111111111111111', data: '0x3f4ba83a', value: '0x0' }]);
  assert.equal(plan.transaction, undefined);
  assert.equal(plan.networkFee.directCallEstimateEth, '0.000016');
  assert.equal(plan.networkFee.maximumEth, undefined);
});

test('activation verification requires the canonical successful contract Unpaused event for the owner', () => {
  const contractAddress = '0x1111111111111111111111111111111111111111';
  const contractInterface = new Interface(['event Unpaused(address account)']);
  const log = { address: contractAddress, ...contractInterface.encodeEventLog(contractInterface.getEvent('Unpaused'), [DEPLOYMENT.owner]) };
  const receipt = { status: 1, blockHash: `0x${'a'.repeat(64)}`, logs: [log] };
  const block = { hash: receipt.blockHash };
  assert.equal(activationReceiptMatches(receipt, block, contractAddress, contractInterface), true);
  assert.equal(activationReceiptMatches({ ...receipt, status: 0 }, block, contractAddress, contractInterface), false);
  assert.equal(activationReceiptMatches(receipt, { hash: `0x${'b'.repeat(64)}` }, contractAddress, contractInterface), false);
  assert.equal(activationReceiptMatches({ ...receipt, logs: [{ ...log, address: DEPLOYMENT.owner }] }, block, contractAddress, contractInterface), false);
  const wrongOwner = { address: contractAddress, ...contractInterface.encodeEventLog(contractInterface.getEvent('Unpaused'), [contractAddress]) };
  assert.equal(activationReceiptMatches({ ...receipt, logs: [wrongOwner] }, block, contractAddress, contractInterface), false);
});

const browserSource = await readFile(new URL('../tools/treasury-deployment.js', import.meta.url), 'utf8');
const pendingKey = 'rch-treasury-deployment-pending-v1';
const flush = () => new Promise(resolve => setImmediate(resolve));
function browserHarness(storage, send, options = {}) {
  const elements = new Map();
  const node = id => { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, hidden: false, value: '' }); return elements.get(id); };
  const requests = [], callsRequests = [], apiRequests = [], walletMethods = [], walletEvents = new Map(), timers = [];
  const state = { ...DEPLOYMENT, quoteSigner: '0x2222222222222222222222222222222222222222', balanceEth: '0.000854948',
    transactionHash: null, deployment: null, backendReady: false, ...options.state };
  const plan = { transaction: { from: DEPLOYMENT.owner, chainId: '0x1', nonce: '0x20', data: '0x1234',
    type: '0x2', gas: '0x120311', maxFeePerGas: '0x1622c118', maxPriorityFeePerGas: '0x5f5e100' },
    networkFee: { maximumEth: '0.000438388', balanceEth: state.balanceEth, gasLimit: '1180433', maxFeePerGasWei: '371378904', quotedAt: '2026-09-28T00:00:00.000Z' } };
  const context = vm.createContext({ crypto: webcrypto, document: { getElementById: node },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { addEventListener() {}, setTimeout: callback => { timers.push(callback); return timers.length; }, ethereum: options.metamask === false ? undefined : { on: (event, callback) => walletEvents.set(event, callback), async request(request) {
      walletMethods.push(request.method);
      if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return options.accounts || [DEPLOYMENT.owner];
      if (request.method === 'eth_chainId') return options.chain || '0x1';
      if (request.method === 'eth_sendTransaction') { requests.push(request); return send(request); }
      if (request.method === 'wallet_getCapabilities') return options.capabilities || { '0x1': { atomic: { status: 'supported' } } };
      if (request.method === 'wallet_sendCalls') { callsRequests.push(request); return options.sendCalls(request); }
      if (request.method === 'wallet_getCallsStatus') return typeof options.callsStatus === 'function' ? options.callsStatus(request) : options.callsStatus;
      return null;
    } } }, async fetch(path, options) {
      apiRequests.push({ path, body: options.body && JSON.parse(options.body) });
      if (path === './record') {
        const body = JSON.parse(options.body);
        assert.match(body.transactionHash, /^0x[0-9a-f]{64}$/);
        state.transactionHash = body.transactionHash;
        state.deployment = { contractAddress: '0x1111111111111111111111111111111111111111', paused: true };
        return { ok: true, json: async () => ({ status: 'verified' }) };
      }
      if (path === './activation-batch') {
        const batch = JSON.parse(options.body);
        state.activationBatch = { ...batch, resolved: batch.status === 400 && batch.transactionHashes.length === 0 };
        return { ok: true, json: async () => ({ saved: true }) };
      }
      if (path === './activation-record') {
        const result = harnessOptions.activationResult || { status: 'pending' };
        if (result.status === 'verified') { state.activation = result; state.deployment = { ...state.deployment, paused: false }; }
        return { ok: true, json: async () => result };
      }
      return { ok: true, json: async () => path === './state.json' ? { ...state } : harnessOptions.plan || plan };
    } });
  const harnessOptions = options;
  vm.runInContext(browserSource, context);
  return { node, requests, callsRequests, apiRequests, walletMethods, walletEvents, timers };
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

function smartOptions(extra = {}) {
  return { state: { transactionHash: `0x${'a'.repeat(64)}`, backendReady: true,
    deployment: { contractAddress: '0x1111111111111111111111111111111111111111', paused: true } },
    plan: smartActivationPlan({ contractAddress: '0x1111111111111111111111111111111111111111', data: '0x3f4ba83a',
      estimatedGas: 40000n, maxFeePerGas: 400000000n, balance: 500000000000000n }), ...extra };
}

test('smart activation persists its batch and confirms only after server receipt and state verification', async () => {
  const storage = new Map(), callsId = `0x${'c'.repeat(128)}`, hash = `0x${'d'.repeat(64)}`;
  const options = smartOptions({ sendCalls: async () => ({ id: callsId }),
    callsStatus: { id: callsId, chainId: '0x1', status: 100 } });
  const page = browserHarness(storage, () => { throw new Error('EOA fallback is forbidden'); }, options);
  await flush();
  assert.match(page.node('networkFee').textContent, /not a maximum/);
  await page.node('unpause').onclick();
  assert.equal(page.callsRequests.length, 1);
  assert.equal(page.requests.length, 0);
  const submitted = page.callsRequests[0].params[0];
  assert.equal(submitted.version, '2.0.0'); assert.equal(submitted.atomicRequired, true);
  assert.deepEqual(Object.keys(submitted.calls[0]).sort(), ['data', 'to', 'value']);
  assert.match(submitted.id, /^0x[0-9a-f]{64}$/);
  assert.equal(JSON.parse(storage.get(pendingKey)).callsId, callsId);
  assert.equal(page.node('unsignedReview').hidden, true);
  const reloaded = browserHarness(storage, () => { throw new Error('No resend'); }, options);
  await flush();
  assert.equal(reloaded.node('unpause').disabled, true);
  assert.equal(reloaded.callsRequests.length, 0);
  options.callsStatus = { id: callsId, chainId: '0x1', status: 200, receipts: [{ transactionHash: hash, status: '0x1' }] };
  await reloaded.node('refresh').onclick();
  assert.equal(storage.has(pendingKey), true, 'Wallet confirmation alone cannot clear pending activation');
  options.activationResult = { status: 'verified', transactionHash: hash };
  await reloaded.node('refresh').onclick();
  assert.equal(storage.has(pendingKey), false);
  assert.match(reloaded.node('status').textContent, /Activation verified on Ethereum/);
});

test('smart activation preserves uncertain submission and rejects unsupported capability without fallback', async () => {
  const storage = new Map();
  const options = smartOptions({ sendCalls: async () => { throw new Error('Disconnected after submission'); },
    callsStatus: () => { throw Object.assign(new Error('Unknown batch'), { code: 5730 }); } });
  const page = browserHarness(storage, () => { throw new Error('No fallback'); }, options);
  await flush(); await page.node('unpause').onclick();
  assert.equal(page.callsRequests.length, 1); assert.equal(page.requests.length, 0);
  const pending = JSON.parse(storage.get(pendingKey));
  assert.match(pending.callsId, /^0x[0-9a-f]{64}$/);
  assert.equal(pending.phase, 'review');
  const reloaded = browserHarness(storage, () => { throw new Error('No fallback'); }, options);
  await flush();
  assert.match(reloaded.node('status').textContent, /submission is uncertain/);
  assert.equal(reloaded.node('unpause').disabled, true);
  assert.equal(reloaded.callsRequests.length, 0);
  for (const status of ['ready', 'unsupported']) {
    const unsupported = browserHarness(new Map(), () => { throw new Error('No fallback'); },
      smartOptions({ capabilities: { '0x1': { atomic: { status } } } }));
    await flush(); await unsupported.node('unpause').onclick();
    assert.equal(unsupported.callsRequests.length, 0); assert.equal(unsupported.requests.length, 0);
    assert.match(unsupported.node('status').textContent, /not reported supported calls/);
  }
});

test('smart activation rejects another batch or chain and handles reported terminal failure without resubmission', async () => {
  const callsId = `0x${'c'.repeat(64)}`;
  for (const patch of [{ id: 'another-batch' }, { chainId: '0x89' }, { status: 400 }, { status: 500 }, { status: 600 }]) {
    const storage = new Map([[pendingKey, JSON.stringify({ type: 'unpause', phase: 'submitted', callsId })]]);
    const options = smartOptions({ callsStatus: { id: callsId, chainId: '0x1', status: 100, ...patch } });
    const page = browserHarness(storage, () => { throw new Error('No resend'); }, options);
    await flush();
    assert.equal(page.callsRequests.length, 0); assert.equal(page.requests.length, 0);
    assert.equal(storage.has(pendingKey), patch.status !== 400);
    assert.match(page.node('status').textContent, patch.status === 400 ? /batch failed/ : patch.status >= 500 ? /pending guard remains/ : /mismatched/);
  }
});

test('smart activation clears definite pre-acceptance rejection but keeps duplicate-ID and unknown outcomes', async () => {
  for (const [code, remains] of [[-32602, false], [4100, false], [5700, false], [5710, false], [5740, false], [5750, false], [5760, false], [5720, true], [-32603, true]]) {
    const storage = new Map();
    const page = browserHarness(storage, () => { throw new Error('No fallback'); }, smartOptions({
      sendCalls: async () => { throw Object.assign(new Error(`Wallet error ${code}`), { code }); } }));
    await flush(); await page.node('unpause').onclick();
    assert.equal(storage.has(pendingKey), remains, `code ${code}`);
    assert.equal(page.callsRequests.length, 1); assert.equal(page.requests.length, 0);
  }
});

test('old uncertain activation hash remains guarded until an explicit failed-attempt acknowledgement', async () => {
  const hash = `0x${'f'.repeat(64)}`;
  const storage = new Map([[pendingKey, JSON.stringify({ type: 'unpause', hash })]]);
  const page = browserHarness(storage, () => { throw new Error('No automatic retry'); }, smartOptions());
  await flush();
  assert.equal(storage.has(pendingKey), true);
  assert.equal(page.node('unpause').disabled, true);
  assert.equal(page.node('failedActivationReview').hidden, false);
  assert.match(page.node('status').textContent, /not yet verified on Ethereum/);
  await page.node('discardFailedActivation').onclick();
  assert.equal(storage.has(pendingKey), false);
  assert.equal(page.node('unpause').disabled, false);
  assert.equal(page.requests.length, 0); assert.equal(page.callsRequests.length, 0);
  assert.match(page.node('status').textContent, /did not cancel or submit/);
});

test('activation polling is bounded and never sends another wallet operation', async () => {
  const storage = new Map(), callsId = `0x${'c'.repeat(64)}`;
  const options = smartOptions({ sendCalls: async () => ({ id: callsId }), callsStatus: { id: callsId, chainId: '0x1', status: 100 } });
  const page = browserHarness(storage, () => { throw new Error('No fallback'); }, options);
  await flush(); await page.node('unpause').onclick();
  for (let i = 0; i < 12; i++) { assert.equal(page.timers.length, 1); await page.timers.shift()(); }
  assert.equal(page.timers.length, 0);
  assert.equal(page.callsRequests.length, 1); assert.equal(page.requests.length, 0);
  assert.equal(page.walletMethods.includes('eth_requestAccounts'), false);
  options.callsStatus = { id: callsId, chainId: '0x1', status: 200, receipts: [{ transactionHash: `0x${'d'.repeat(64)}`, status: '0x1' }] };
  options.activationResult = { status: 'verified', transactionHash: `0x${'d'.repeat(64)}` };
  await page.node('refresh').onclick();
  assert.equal(storage.has(pendingKey), false);
  assert.match(page.node('status').textContent, /Activation verified/);
});
