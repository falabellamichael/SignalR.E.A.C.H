import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'ethers';
import { AccountStore } from '../service/store.mjs';
import { createRedemptionService, redemptionInterface } from '../service/redemption.mjs';

const wallet = getAddress(`0x${'11'.repeat(20)}`);
const tokenAddress = getAddress(`0x${'22'.repeat(20)}`);
const hash = `0x${'33'.repeat(32)}`;
const blockHash = `0x${'44'.repeat(32)}`;
const otherHash = `0x${'55'.repeat(32)}`;
const rejection = (code) => (error) => { assert.equal(error.code, code, error.message); return true; };

class FakeProvider {
  constructor(chainId) {
    this.chainId = BigInt(chainId); this.paused = false; this.rate = 1_000_000n; this.units = 10n ** 12n;
    this.code = '0x6000'; this.walletCode = '0x'; this.head = 101; this.finalizedHeight = 101;
    this.blocks = new Map([[100, { number: 100, hash: blockHash }], [101, { number: 101, hash: otherHash }]]);
    this.receipts = new Map(); this.transactions = new Map(); this.calls = [];
  }
  check() { if (this.unavailable) throw new Error('https://secret-rpc-key.invalid connection unavailable'); }
  async getNetwork() { this.check(); return { chainId: this.chainId }; }
  async getCode(address) { this.check(); return address.toLowerCase() === tokenAddress.toLowerCase() ? this.code : this.walletCode; }
  async call(transaction) {
    this.check();
    const name = redemptionInterface.parseTransaction(transaction).name;
    const value = name === 'redemptionPaused' ? this.paused : name === 'RCH_UNITS_PER_AI_TOKEN' ? this.units : this.rate;
    return redemptionInterface.encodeFunctionResult(name, [value]);
  }
  async getTransactionReceipt(txHash) { this.check(); return this.receipts.get(txHash.toLowerCase()) ?? null; }
  async getTransaction(txHash) { this.check(); return this.transactions.get(txHash.toLowerCase()) ?? null; }
  async getBlock(tag) {
    this.check(); this.calls.push(tag);
    if (tag === 'finalized') return this.blocks.get(this.finalizedHeight) ?? null;
    return this.blocks.get(tag) ?? null;
  }
  async getBlockNumber() { this.check(); return this.head; }
}

function fixture(t, options = {}) {
  let now = 1_800_000_000_000;
  const models = [{ id: 'codegpt/test', metered: true }];
  const store = new AccountStore(':memory:', { now: () => now, models });
  t.after(() => store.close());
  const raw = store.ensureAccount(wallet);
  store.grantPlan({ wallet, grantId: 'test-grant-one', planId: 'pro', name: 'Pro', models: ['codegpt/test'], tokens: 50, expiresAt: now + 3_600_000 });
  const config = { origin: 'https://reach.example', chainId: options.chainId ?? 1337, redemption: { enabled: true, tokenAddress, confirmations: options.confirmations ?? 2 } };
  const provider = new FakeProvider(config.chainId);
  const service = createRedemptionService({ store, config, provider });
  return { store, account: store.account(raw.id), provider, service, config, advance: (ms) => { now += ms; } };
}

async function intent(f, amount = '1.25') {
  const started = await f.service.start(f.account, amount);
  const fragment = new URLSearchParams(new URL(started.url).hash.slice(1));
  return { ...started, ticket: fragment.get('ticket') };
}

async function mined(f, i, txHash = hash) {
  const row = f.store.getRedemption(i.redemptionId, i.ticket);
  const data = redemptionInterface.encodeFunctionData('redeem', [row.amount, row.id]);
  const encoded = redemptionInterface.encodeEventLog(redemptionInterface.getEvent('Redeemed'), [row.wallet, row.id, row.amount, row.usage_tokens]);
  const receipt = {
    hash: txHash, from: row.wallet, to: tokenAddress, status: 1, blockNumber: 100, blockHash,
    logs: [{ address: tokenAddress, ...encoded, transactionHash: txHash, blockNumber: 100, blockHash, index: 2, removed: false }],
  };
  const transaction = { hash: txHash, from: row.wallet, to: tokenAddress, data, value: 0n, chainId: BigInt(f.config.chainId), blockHash };
  f.provider.receipts.set(txHash, receipt); f.provider.transactions.set(txHash, transaction);
  return { row, receipt, transaction };
}

test('redemption start enforces active plan, exact decimal conversion, bounds and verified contract availability', async (t) => {
  const f = fixture(t);
  for (const amount of [0, '0', '-1', '1e-6', '0.0000001', '1.000000000000000001', '1000000.000001', ' 1', '01']) {
    await assert.rejects(f.service.start(f.account, amount), rejection('invalid_redemption_amount'));
  }
  const smallest = await intent(f, '0.000001');
  assert.equal(f.store.getRedemption(smallest.redemptionId, smallest.ticket).usage_tokens, 1);
  const largest = await intent(f, '1000000');
  assert.equal(f.store.getRedemption(largest.redemptionId, largest.ticket).usage_tokens, 1_000_000_000_000);
  assert.equal(new URL(largest.url).search, '');
  assert.equal(new URL(largest.url).pathname, '/wallet/redeem');
  f.provider.paused = true;
  await assert.rejects(f.service.start(f.account, '1'), rejection('redemption_paused'));
  f.provider.paused = false; f.provider.code = '0x';
  await assert.rejects(f.service.start(f.account, '1'), rejection('redemption_contract_unavailable'));
  f.provider.code = '0x6000'; f.provider.rate = 1n;
  await assert.rejects(f.service.start(f.account, '1'), rejection('redemption_rate_mismatch'));
  f.provider.rate = 1_000_000n; f.provider.chainId = 1n;
  await assert.rejects(f.service.start(f.account, '1'), rejection('redemption_wrong_chain'));
  f.provider.chainId = 1337n; f.provider.walletCode = '0x6000';
  await assert.rejects(f.service.start(f.account, '1'), rejection('unsupported_redemption_wallet'));
  f.provider.walletCode = '0x'; f.advance(3_600_001);
  await assert.rejects(f.service.start(f.account, '1'), rejection('plan_required'));
});

test('details require the secret ticket and offer transaction data only while signing is available', async (t) => {
  const f = fixture(t), i = await intent(f);
  await assert.rejects(f.service.details(i.redemptionId, 'incorrect'), rejection('redemption_missing'));
  const details = await f.service.details(i.redemptionId, i.ticket);
  assert.equal(details.walletAddress, wallet); assert.equal(details.amountRch, '1.25');
  assert.equal(details.usageTokens, 1_250_000); assert.equal(details.status, 'created');
  assert.equal(details.transaction.to, tokenAddress); assert.equal(details.transaction.value, '0x0');
  assert.equal(details.transaction.chainId, '0x539');
  const decoded = redemptionInterface.parseTransaction(details.transaction);
  assert.equal(decoded.name, 'redeem'); assert.equal(decoded.args.redemptionId, i.redemptionId);
  f.provider.paused = true;
  assert.equal((await f.service.details(i.redemptionId, i.ticket)).signingUnavailableReason, 'redemption_paused');
  f.provider.paused = false; f.provider.unavailable = true;
  const unavailable = await f.service.details(i.redemptionId, i.ticket);
  assert.equal(unavailable.transaction, null); assert.equal(unavailable.signingUnavailableReason, 'redemption_rpc_unavailable');
  assert.equal(JSON.stringify(unavailable).includes('secret-rpc-key'), false);
  f.provider.unavailable = false; f.advance(900_001);
  const expired = await f.service.details(i.redemptionId, i.ticket);
  assert.equal(expired.status, 'expired'); assert.equal(expired.transaction, null);
});

test('confirmed exact burn credits once even after ticket or plan expiry and while redemption is paused', async (t) => {
  const f = fixture(t), i = await intent(f);
  await mined(f, i); f.advance(3_600_001); f.provider.paused = true;
  const result = await f.service.submit(i.redemptionId, i.ticket, hash);
  assert.equal(result.status, 'credited'); assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 1_250_000);
  assert.equal(f.store.getRedemption(i.redemptionId, i.ticket).event_key, `1337:${hash}:2`);
  assert.equal((await f.service.submit(i.redemptionId, i.ticket, hash)).status, 'credited');
  assert.deepEqual(await f.service.reconcile(f.account.id), []);
  assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 1_250_000);
  const details = await f.service.details(i.redemptionId, i.ticket);
  assert.equal(details.status, 'credited'); assert.equal(details.transaction, null); assert.equal(details.txHash, hash);
});

test('pending and unavailable RPC outcomes persist across a new service instance without false credit', async (t) => {
  const f = fixture(t), i = await intent(f);
  assert.equal((await f.service.submit(i.redemptionId, i.ticket, hash)).reason, 'transaction_pending');
  f.provider.unavailable = true;
  const unavailable = await f.service.reconcile(f.account.id);
  assert.equal(unavailable[0].status, 'pending'); assert.equal(unavailable[0].reason, 'redemption_rpc_unavailable');
  assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 0);
  assert.equal(f.store.pendingRedemptions(f.account.id)[0].tx_hash, hash);
  f.provider.unavailable = false; await mined(f, i);
  const restarted = createRedemptionService({ store: f.store, config: f.config, provider: f.provider });
  assert.equal((await restarted.reconcile())[0].status, 'credited');
  assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 1_250_000);
});

test('wrong receipt, transaction envelope, token or redemption event never credits the intent', async (t) => {
  const cases = [
    (r, tx) => { r.status = 0; }, (r, tx) => { r.hash = otherHash; },
    (r, tx) => { tx.from = tokenAddress; }, (r, tx) => { tx.to = wallet; },
    (r, tx) => { tx.data = '0x'; }, (r, tx) => { tx.value = 1n; },
    (r, tx) => { tx.chainId = 1n; }, (r, tx) => { tx.blockHash = otherHash; },
    (r) => { r.logs[0].address = wallet; }, (r) => { r.logs[0].removed = true; },
    (r) => { r.logs[0].transactionHash = otherHash; }, (r) => { r.logs[0].blockHash = otherHash; },
    (r) => { r.logs.push({ ...r.logs[0], index: 3 }); },
    (r, tx, row) => { Object.assign(r.logs[0], redemptionInterface.encodeEventLog(redemptionInterface.getEvent('Redeemed'), [wallet, row.id, row.amount, row.usage_tokens + 1])); },
    (r, tx, row) => { Object.assign(r.logs[0], redemptionInterface.encodeEventLog(redemptionInterface.getEvent('Redeemed'), [tokenAddress, row.id, row.amount, row.usage_tokens])); },
  ];
  for (const modify of cases) {
    const f = fixture(t), i = await intent(f), { receipt, transaction, row } = await mined(f, i);
    modify(receipt, transaction, row);
    assert.equal((await f.service.submit(i.redemptionId, i.ticket, hash)).status, 'pending');
    assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 0);
  }
});

test('test networks require confirmations and a stable canonical receipt block', async (t) => {
  const f = fixture(t, { confirmations: 3 }), i = await intent(f);
  await mined(f, i);
  assert.equal((await f.service.submit(i.redemptionId, i.ticket, hash)).reason, 'awaiting_finality');
  f.provider.head = 103;
  f.provider.blocks.set(100, { number: 100, hash: otherHash });
  assert.equal((await f.service.reconcile())[0].reason, 'awaiting_finality');
  assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 0);
  f.provider.blocks.set(100, { number: 100, hash: blockHash });
  assert.equal((await f.service.reconcile())[0].status, 'credited');
});

test('mainnet requires finalized evidence instead of a high confirmation count', async (t) => {
  const f = fixture(t, { chainId: 1, confirmations: 1 }), i = await intent(f);
  await mined(f, i); f.provider.head = 1_000_000; f.provider.finalizedHeight = 99;
  f.provider.blocks.set(99, { number: 99, hash: otherHash });
  assert.equal((await f.service.submit(i.redemptionId, i.ticket, hash)).reason, 'awaiting_finality');
  assert.ok(f.provider.calls.includes('finalized'));
  assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 0);
  f.provider.finalizedHeight = 100;
  assert.equal((await f.service.reconcile())[0].status, 'credited');
});

test('hash replacement requires the original to be finally failed and preserves the original intent', async (t) => {
  const f = fixture(t), i = await intent(f);
  await f.service.submit(i.redemptionId, i.ticket, hash);
  await assert.rejects(f.service.submit(i.redemptionId, i.ticket, otherHash), rejection('transaction_conflict'));
  const original = await mined(f, i); original.receipt.status = 0;
  f.provider.head = 100;
  await assert.rejects(f.service.submit(i.redemptionId, i.ticket, otherHash), rejection('transaction_conflict'));
  f.provider.head = 101; await mined(f, i, otherHash);
  assert.equal((await f.service.submit(i.redemptionId, i.ticket, otherHash)).status, 'credited');
  assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 1_250_000);
  await assert.rejects(f.service.submit(i.redemptionId, i.ticket, hash), rejection('transaction_conflict'));
});

test('an unrelated finalized successful transaction hash can be corrected without losing the redemption intent', async (t) => {
  const f = fixture(t), i = await intent(f);
  const unrelated = await mined(f, i);
  unrelated.receipt.logs = [];
  unrelated.transaction.data = '0x';
  assert.equal((await f.service.submit(i.redemptionId, i.ticket, hash)).status, 'pending');
  const correct = await mined(f, i, otherHash);
  f.provider.head = 100;
  await assert.rejects(f.service.submit(i.redemptionId, i.ticket, otherHash), rejection('transaction_conflict'));
  assert.equal(f.store.getRedemption(i.redemptionId, i.ticket).tx_hash, hash);
  f.provider.head = 101;
  assert.equal((await f.service.submit(i.redemptionId, i.ticket, otherHash)).status, 'credited');
  assert.equal(f.store.getRedemption(i.redemptionId, i.ticket).tx_hash, correct.transaction.hash);
  assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 1_250_000);
});

test('an expected burn event prevents hash replacement even when its transaction envelope is unsupported', async (t) => {
  const f = fixture(t), i = await intent(f);
  const original = await mined(f, i);
  original.transaction.from = tokenAddress;
  assert.equal((await f.service.submit(i.redemptionId, i.ticket, hash)).reason, 'transaction_mismatch');
  await mined(f, i, otherHash);
  await assert.rejects(f.service.submit(i.redemptionId, i.ticket, otherHash), rejection('transaction_conflict'));
  assert.equal(f.store.getRedemption(i.redemptionId, i.ticket).tx_hash, hash);
  assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 0);
});

test('disabled service cannot produce a burn and invalid confirmation policies fail at configuration', async (t) => {
  const f = fixture(t), disabled = createRedemptionService({ store: f.store, config: { ...f.config, redemption: { enabled: false } } });
  assert.equal(disabled.enabled, false);
  await assert.rejects(disabled.start(f.account, '1'), rejection('redemption_disabled'));
  assert.deepEqual(await disabled.reconcile(), []);
  assert.throws(() => createRedemptionService({ store: f.store, config: { ...f.config, redemption: { ...f.config.redemption, confirmations: 0 } }, provider: f.provider }), rejection('invalid_redemption_config'));
});

test('a real local contract burn settles into the durable account ledger without sending through the service', async (t) => {
  const { chain, send } = await import('./helpers/chain.mjs');
  const { parseEther } = await import('ethers');
  const f = await chain(t);
  const buyer = await f.buyer.getAddress();
  const store = new AccountStore(':memory:', { models: [{ id: 'codegpt/test', metered: true }] });
  t.after(() => store.close());
  store.grantPlan({ wallet: buyer, grantId: 'local-chain-grant', planId: 'pro', name: 'Pro', models: ['codegpt/test'], tokens: 50, expiresAt: Date.now() + 3_600_000 });
  const account = store.account(store.ensureAccount(buyer).id);
  const service = createRedemptionService({ store, config: {
    origin: 'https://reach.example', chainId: 1337,
    redemption: { enabled: true, tokenAddress: await f.token.getAddress(), confirmations: 1 },
  }, provider: f.provider });
  await send(f.sale.unpause());
  await send(f.sale.connect(f.buyer).buy(1n, await f.now() + 600, { value: parseEther('0.01') }));
  await send(f.token.connect(f.admin).setRedemptionPaused(false));
  const i = await service.start(account, '2.5');
  const ticket = new URLSearchParams(new URL(i.url).hash.slice(1)).get('ticket');
  const details = await service.details(i.redemptionId, ticket);
  // Signing is done by the caller's isolated test wallet, never the hosted service.
  const receipt = await send(f.buyer.sendTransaction(details.transaction));
  const result = await service.submit(i.redemptionId, ticket, receipt.hash);
  assert.equal(result.status, 'credited');
  assert.equal(store.account(account.id).allowance.prepaidRemaining, 2_500_000);
  assert.equal(await f.token.totalRedeemed(), 2_500_000_000_000_000_000n);
  assert.equal(await f.token.totalUsageTokensRedeemed(), 2_500_000n);
  assert.equal((await service.submit(i.redemptionId, ticket, receipt.hash)).status, 'credited');
  assert.equal(store.account(account.id).allowance.prepaidRemaining, 2_500_000);
});
