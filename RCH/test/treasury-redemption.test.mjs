import assert from 'node:assert/strict';
import test from 'node:test';
import { id, parseEther, parseUnits, Wallet } from 'ethers';
import { chain, send } from './helpers/chain.mjs';

const units = value => parseUnits(String(value), 18);
const types = { RedemptionQuote: [
  { name: 'wallet', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'creditUsdMicros', type: 'uint256' },
  { name: 'redemptionId', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint64' },
  { name: 'deadline', type: 'uint64' },
] };

async function fixture(t) {
  const f = await chain(t);
  await send(f.sale.unpause());
  const payment = parseEther('0.01');
  const [minimum] = await f.sale.quote(payment);
  await send(f.sale.connect(f.buyer).buy(minimum, await f.now() + 600, { value: payment }));
  const adapter = await f.deploy('ReachTreasuryRedemption', [
    await f.admin.getAddress(), await f.token.getAddress(), f.treasuryTarget, await f.admin.getAddress(),
  ]);
  const domain = { name: 'REACH Treasury Redemption', version: '1',
    chainId: Number((await f.provider.getNetwork()).chainId), verifyingContract: await adapter.getAddress() };
  // Ganache's RPC typed-data method expects an object while ethers sends a JSON
  // string. Sign locally with the ephemeral test account instead.
  const testKey = f.rpc.getInitialAccounts()[(await f.admin.getAddress()).toLowerCase()].secretKey;
  const quoteSigner = new Wallet(testKey);
  const quote = async (changes = {}) => {
    const issuedAt = await f.now();
    const value = { wallet: await f.buyer.getAddress(), amount: units(2), creditUsdMicros: 20_000n,
      redemptionId: id(`quote-${Math.random()}`), issuedAt, deadline: issuedAt + 900, ...changes };
    return { value, signature: await quoteSigner.signTypedData(domain, types, value) };
  };
  const redeem = ({ value, signature }, signer = f.buyer) => adapter.connect(signer).redeem(
    value.amount, value.creditUsdMicros, value.redemptionId, value.issuedAt, value.deadline, signature);
  return { ...f, adapter, quote, redeem };
}

test('a signed redemption transfers exact RCH to treasury and leaves supply unchanged', async t => {
  const f = await fixture(t);
  assert.equal(await f.adapter.paused(), true);
  const signed = await f.quote();
  await send(f.token.connect(f.buyer).approve(await f.adapter.getAddress(), signed.value.amount));
  await assert.rejects(f.redeem(signed));
  await send(f.adapter.connect(f.admin).unpause());
  const before = { buyer: await f.token.balanceOf(await f.buyer.getAddress()),
    treasury: await f.token.balanceOf(f.treasuryTarget), supply: await f.token.totalSupply() };
  const receipt = await send(f.redeem(signed));
  const event = receipt.logs.filter(log => log.address.toLowerCase() === f.adapter.target.toLowerCase())
    .map(log => f.adapter.interface.parseLog(log)).find(log => log?.name === 'RedeemedToTreasury');
  assert.equal(event.args.wallet, await f.buyer.getAddress());
  assert.equal(event.args.redemptionId, signed.value.redemptionId);
  assert.equal(event.args.treasury, f.treasuryTarget);
  assert.equal(event.args.amount, signed.value.amount);
  assert.equal(event.args.creditUsdMicros, signed.value.creditUsdMicros);
  assert.equal(await f.token.balanceOf(await f.buyer.getAddress()), before.buyer - signed.value.amount);
  assert.equal(await f.token.balanceOf(f.treasuryTarget), before.treasury + signed.value.amount);
  assert.equal(await f.token.totalSupply(), before.supply);
  assert.equal(await f.token.totalRedeemed(), 0n);
  assert.equal(await f.adapter.usedRedemptionIds(signed.value.redemptionId), true);
  await assert.rejects(f.redeem(signed));
});

test('a quote cannot be redirected, changed, replayed by another wallet, or used after expiry', async t => {
  const f = await fixture(t);
  await send(f.adapter.connect(f.admin).unpause());
  const signed = await f.quote();
  await send(f.token.connect(f.buyer).approve(await f.adapter.getAddress(), units(10)));
  const before = await f.token.balanceOf(f.treasuryTarget);
  await assert.rejects(f.adapter.connect(f.buyer).redeem(units(3), signed.value.creditUsdMicros,
    signed.value.redemptionId, signed.value.issuedAt, signed.value.deadline, signed.signature));
  await assert.rejects(f.adapter.connect(f.buyer).redeem(signed.value.amount, 30_000n,
    signed.value.redemptionId, signed.value.issuedAt, signed.value.deadline, signed.signature));
  await assert.rejects(f.redeem(signed, f.other));
  assert.equal(await f.token.balanceOf(f.treasuryTarget), before);
  assert.equal(await f.adapter.usedRedemptionIds(signed.value.redemptionId), false);
  await f.rpc.request({ method: 'evm_increaseTime', params: [901] });
  await f.rpc.request({ method: 'evm_mine', params: [] });
  await assert.rejects(f.redeem(signed));
  assert.equal(await f.token.balanceOf(f.treasuryTarget), before);
});

test('a signed quote does not bypass approval or the owner pause', async t => {
  const f = await fixture(t);
  const signed = await f.quote();
  await assert.rejects(f.adapter.connect(f.buyer).unpause());
  await send(f.adapter.connect(f.admin).unpause());
  await assert.rejects(f.redeem(signed));
  assert.equal(await f.adapter.usedRedemptionIds(signed.value.redemptionId), false);
  await send(f.token.connect(f.buyer).approve(await f.adapter.getAddress(), signed.value.amount));
  await send(f.adapter.connect(f.admin).pause());
  await assert.rejects(f.redeem(signed));
  assert.equal(await f.adapter.usedRedemptionIds(signed.value.redemptionId), false);
});
