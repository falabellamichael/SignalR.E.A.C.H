import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, parseEther, parseUnits, Wallet } from 'ethers';
import { AccountStore } from '../service/store.mjs';
import { createTreasuryRedemptionService, treasuryInterface, treasuryTokenInterface } from '../service/treasury-redemption.mjs';
import { chain, send } from './helpers/chain.mjs';

async function fixture(t, options = {}) {
  const f = await chain(t);
  await send(f.sale.unpause());
  const payment = parseEther('0.01'), [minimum] = await f.sale.quote(payment);
  await send(f.sale.connect(f.buyer).buy(minimum, await f.now() + 600, { value: payment }));
  const wallet = await f.buyer.getAddress();
  const quoteSigner = new Wallet(f.rpc.getInitialAccounts()[(await f.admin.getAddress()).toLowerCase()].secretKey);
  const adapter = await f.deploy('ReachTreasuryRedemption', [await f.admin.getAddress(), await f.token.getAddress(), f.treasuryTarget, quoteSigner.address]);
  await send(adapter.connect(f.admin).unpause());
  let now = (await f.now()) * 1000;
  const models = [{ id: 'priced/test', provider: 'test', metered: true,
    pricing: { inputUsdMicrosPerMillion: 150000, outputUsdMicrosPerMillion: 600000 } }];
  const store = new AccountStore(':memory:', { models, now: () => now });
  t.after(() => store.close());
  const rawAccount = store.ensureAccount(wallet), account = store.account(rawAccount.id);
  const config = { origin: 'https://reach.example', chainId: 1337, models,
    redemption: { enabled: true, mode: 'treasury', tokenAddress: await f.token.getAddress(),
      contractAddress: await adapter.getAddress(), contractCodeHash: keccak256(await f.provider.getCode(await adapter.getAddress())),
      treasuryAddress: f.treasuryTarget, allowedWallets: [wallet], confirmations: 1, maxCreditUsdMicros: 1000000, creditBudgetUsdMicros: 1000000 } };
  const provider = options.receiptTransform ? new Proxy(f.provider, { get(target, property) {
    if (property === 'getTransactionReceipt') return async hash => options.receiptTransform(await target.getTransactionReceipt(hash));
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } }) : f.provider;
  const quoteReader = options.quoteReader || (async () => ({ creditUsdMicros: 300,
    source: 'Fixture executable market quote', observedAt: new Date(now).toISOString() }));
  const service = createTreasuryRedemptionService({ store, config, provider, quoteReader, quoteSigner });
  t.after(() => service.close());
  const start = async amount => {
    const created = await service.start(account, amount ?? '2');
    return { ...created, ticket: new URLSearchParams(new URL(created.url).hash.slice(1)).get('ticket') };
  };
  const approve = async intent => {
    const details = await service.details(intent.redemptionId, intent.ticket);
    assert(details.approvalTransaction); assert.equal(details.transaction, null);
    return send(f.buyer.sendTransaction(details.approvalTransaction));
  };
  const redeem = async intent => {
    const details = await service.details(intent.redemptionId, intent.ticket);
    assert.equal(details.approvalTransaction, null); assert(details.transaction);
    return send(f.buyer.sendTransaction(details.transaction));
  };
  return { ...f, adapter, store, account, config, service, start, approve, redeem, advance: value => { now += value; } };
}

test('treasury service quotes, approves exact RCH and credits USD once after an actual transfer', async t => {
  const f = await fixture(t), intent = await f.start();
  const details = await f.service.details(intent.redemptionId, intent.ticket);
  assert.equal(details.mode, 'treasury'); assert.equal(details.creditUsdMicros, 300);
  assert.equal(details.treasuryAddress, f.treasuryTarget);
  const approval = treasuryTokenInterface.parseTransaction(details.approvalTransaction);
  assert.equal(approval.name, 'approve'); assert.equal(approval.args[0], f.config.redemption.contractAddress);
  assert.equal(approval.args[1], parseUnits('2', 18));
  const before = await f.token.balanceOf(f.treasuryTarget), supply = await f.token.totalSupply();
  await f.approve(intent);
  const receipt = await f.redeem(intent);
  const result = await f.service.submit(intent.redemptionId, intent.ticket, receipt.hash);
  assert.equal(result.status, 'credited'); assert.equal(result.creditUsdMicros, 300);
  assert.equal(f.store.account(f.account.id).credit.balanceMicros, 300);
  assert.equal(f.store.account(f.account.id).allowance.prepaidRemaining, 0);
  assert.equal(f.store.account(f.account.id).allowedModels[0].id, 'priced/test');
  assert.equal(await f.token.balanceOf(f.treasuryTarget), before + parseUnits('2', 18));
  assert.equal(await f.token.totalSupply(), supply);
  assert.equal((await f.service.submit(intent.redemptionId, intent.ticket, receipt.hash)).status, 'credited');
  assert.equal(f.store.account(f.account.id).credit.balanceMicros, 300);
  assert.equal((await f.service.details(intent.redemptionId, intent.ticket)).transaction, null);
});

test('an approval alone cannot credit and its hash can be corrected to the actual redemption', async t => {
  const f = await fixture(t), intent = await f.start();
  const approvalReceipt = await f.approve(intent);
  const redemptionReceipt = await f.redeem(intent);
  const wrong = await f.service.submit(intent.redemptionId, intent.ticket, approvalReceipt.hash);
  assert.equal(wrong.status, 'pending'); assert.equal(wrong.reason, 'transaction_mismatch');
  assert.equal(f.store.account(f.account.id).credit.balanceMicros, 0);
  const corrected = await f.service.submit(intent.redemptionId, intent.ticket, redemptionReceipt.hash);
  assert.equal(corrected.status, 'credited');
  assert.equal(f.store.account(f.account.id).credit.balanceMicros, 300);
});

test('expired quotes never offer an approval, but completed transfers still reconcile after expiry and pause', async t => {
  const f = await fixture(t), completed = await f.start();
  await f.approve(completed); const receipt = await f.redeem(completed);
  const unused = await f.start(); f.advance(301000);
  const expired = await f.service.details(unused.redemptionId, unused.ticket);
  assert.equal(expired.signingUnavailableReason, 'intent_expired');
  assert.equal(expired.approvalTransaction, null); assert.equal(expired.transaction, null);
  await send(f.adapter.connect(f.admin).pause());
  assert.equal((await f.service.submit(completed.redemptionId, completed.ticket, receipt.hash)).status, 'credited');
  assert.equal(f.store.account(f.account.id).credit.balanceMicros, 300);
});

test('an event with altered quoted credit never settles even with the correct transaction envelope', async t => {
  const f = await fixture(t, { receiptTransform: receipt => {
    if (!receipt) return receipt;
    return { ...receipt, logs: receipt.logs.map(log => {
      let event; try { event = treasuryInterface.parseLog(log); } catch { return log; }
      if (event?.name !== 'RedeemedToTreasury') return log;
      const changed = treasuryInterface.encodeEventLog('RedeemedToTreasury', [event.args.wallet, event.args.redemptionId,
        event.args.treasury, event.args.amount, event.args.creditUsdMicros + 1n]);
      return { ...log, ...changed };
    }) };
  } });
  const intent = await f.start(); await f.approve(intent); const receipt = await f.redeem(intent);
  const result = await f.service.submit(intent.redemptionId, intent.ticket, receipt.hash);
  assert.equal(result.reason, 'redemption_event_mismatch');
  assert.equal(f.store.account(f.account.id).credit.balanceMicros, 0);
});

test('a changed deployed contract identity blocks quoting before any intent is persisted', async t => {
  const f = await fixture(t); f.config.redemption.contractCodeHash = '0x' + '00'.repeat(32);
  await assert.rejects(f.start(), { code: 'redemption_contract_mismatch' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM redemptions').get().count, 0);
});

test('enabled service against a paused deployment offers no approval or signed transfer and creates no new quote', async t => {
  const f = await fixture(t), existing = await f.start();
  await send(f.adapter.connect(f.admin).pause());
  await assert.rejects(f.start(), { code: 'redemption_paused' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM redemptions').get().count, 1);
  const details = await f.service.details(existing.redemptionId, existing.ticket);
  assert.equal(details.signingUnavailableReason, 'redemption_paused');
  assert.equal(details.approvalTransaction, null);
  assert.equal(details.transaction, null);
  assert.equal(f.store.account(f.account.id).credit.balanceMicros, 0);
});
