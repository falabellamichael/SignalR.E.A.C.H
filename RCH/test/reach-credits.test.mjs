import assert from 'node:assert/strict';
import test from 'node:test';
import { id, parseEther, parseUnits, ZeroAddress, ZeroHash } from 'ethers';
import { chain, send, price, floor, ceiling } from './helpers/chain.mjs';

const units = (n) => parseUnits(String(n), 18);
async function revert(contract, method, args, name, errorInterface = contract.interface) {
  await assert.rejects(contract[method].staticCall(...args), (error) => {
    assert.equal(error.revert?.name || errorInterface.parseError(error.data)?.name, name, error.shortMessage || error.message);
    return true;
  });
}
async function rewardSetup(f, allowance = units(10)) {
  const operator = await f.rewardMinter.getAddress();
  const role = await f.token.REWARD_MINTER_ROLE();
  await send(f.token.connect(f.admin).grantRole(role, operator));
  await send(f.token.connect(f.admin).setRewardAllowance(operator, allowance));
  return { operator, role };
}
async function open(f) { await send(f.sale.unpause()); }
async function buy(f, payment = parseEther('0.01')) {
  const [out] = await f.sale.quote(payment);
  return send(f.sale.connect(f.buyer).buy(out, await f.now() + 600, { value: payment }));
}

test('atomic launch grants authority directly to administrator and sale, with purchases initially paused', async (t) => {
  const f = await chain(t);
  assert.equal(await f.token.name(), 'REACH Credits');
  assert.equal(await f.token.symbol(), 'RCH');
  assert.equal(await f.token.decimals(), 18n);
  assert.equal(await f.token.totalSupply(), 0n);
  assert.equal(await f.token.defaultAdmin(), await f.admin.getAddress());
  assert.equal(await f.sale.owner(), await f.admin.getAddress());
  assert.equal(await f.token.hasRole(await f.token.DEFAULT_ADMIN_ROLE(), await f.deployer.getAddress()), false);
  assert.equal(await f.token.hasRole(await f.token.SALE_MINTER_ROLE(), await f.sale.getAddress()), true);
  assert.equal(await f.sale.paused(), true);
  await revert(f.sale.connect(f.buyer), 'buy', [1, await f.now() + 600, { value: 1n }], 'EnforcedPause');
  await revert(f.token.connect(f.buyer), 'mintPurchased', [await f.buyer.getAddress(), 1], 'AccessControlUnauthorizedAccount');
  await revert(f.token.connect(f.deployer), 'mintReward', [await f.buyer.getAddress(), 1, id('unauthorized')], 'AccessControlUnauthorizedAccount');
});

test('USD pricing moves with ETH; purchases mint exact integer output and preserve payment accounting', async (t) => {
  const f = await chain(t); await open(f);
  assert.equal((await f.sale.quote(parseEther('1')))[0], units(264964));
  const paid = parseEther('0.01');
  await buy(f, paid);
  assert.equal(await f.token.balanceOf(await f.buyer.getAddress()), units('2649.64'));
  assert.equal(await f.token.totalPurchased(), units('2649.64'));
  assert.equal(await f.provider.getBalance(await f.sale.getAddress()), paid);
  await send(f.feed.setAnswer(price * 2n, await f.now()));
  assert.equal((await f.sale.quote(parseEther('1')))[0], units(529928));
  for (const wei of [1n, 99n, 123456789n, parseEther('2.175')]) {
    assert.equal((await f.sale.quote(wei))[0], wei * price * 2n / 1000000n);
  }
});

test('purchase rejects expired, zero, and below-minimum requests before issuing tokens', async (t) => {
  const f = await chain(t); await open(f);
  const sale = f.sale.connect(f.buyer), now = await f.now(), paid = parseEther('0.01');
  const [out] = await sale.quote(paid);
  await revert(sale, 'buy', [out, now - 1, { value: paid }], 'PurchaseExpired');
  await revert(sale, 'buy', [out + 1n, now + 60, { value: paid }], 'OutputBelowMinimum');
  await revert(sale, 'buy', [0, now + 60, { value: paid }], 'EmptyPurchase');
  await revert(sale, 'buy', [1, now + 60, { value: 0 }], 'EmptyPurchase');
  // Execute a reverting transaction too, so rollback is tested beyond eth_call.
  await assert.rejects(send(sale.buy(out + 1n, now + 60, { value: paid, gasLimit: 300000 })));
  assert.equal(await f.token.totalSupply(), 0n);
  assert.equal(await f.provider.getBalance(await sale.getAddress()), 0n);
});

test('invalid, stale, incomplete, and out-of-range oracle rounds block quotes and opening', async (t) => {
  const f = await chain(t), now = await f.now();
  for (const [answer, updatedAt, error] of [
    [price, 0, 'InvalidOraclePrice'], [-1, now, 'InvalidOraclePrice'], [0, now, 'InvalidOraclePrice'],
    [price, now + 600, 'InvalidOraclePrice'], [price, now - 3601, 'StaleOraclePrice'],
    [floor - 1n, now, 'PriceOutsideBounds'], [ceiling + 1n, now, 'PriceOutsideBounds'],
  ]) {
    await send(f.feed.setAnswer(answer, updatedAt));
    await revert(f.sale, 'quote', [1], error);
    await revert(f.sale, 'unpause', [], error);
  }
  await send(f.feed.setAnswer(price, await f.now()));
  await send(f.feed.setRound(2, 1));
  await revert(f.sale, 'quote', [1], 'InvalidOraclePrice');
  await send(f.feed.setRound(0, 0));
  await revert(f.sale, 'quote', [1], 'InvalidOraclePrice');
});

test('reward operators need a finite budget; duplicate rewards and overspending revert', async (t) => {
  const f = await chain(t), recipient = await f.buyer.getAddress();
  const { operator, role } = await rewardSetup(f);
  const issuer = f.token.connect(f.rewardMinter);
  await send(issuer.mintReward(recipient, units(7), id('reward-1')));
  assert.equal(await f.token.rewardAllowance(operator), units(3));
  assert.equal(await f.token.totalRewarded(), units(7));
  await revert(issuer, 'mintReward', [recipient, units(1), id('reward-1')], 'RewardAlreadyIssued');
  await revert(issuer, 'mintReward', [recipient, units(4), id('reward-2')], 'RewardBudgetExceeded');
  await revert(issuer, 'mintReward', [recipient, 0, id('reward-2')], 'InvalidIssuance');
  await revert(issuer, 'mintReward', [recipient, 1, ZeroHash], 'InvalidIssuance');
  await revert(issuer, 'mintReward', [ZeroAddress, 1, id('reward-2')], 'ERC20InvalidReceiver');
  assert.equal(await f.token.usedRewardIds(id('reward-2')), false);
  await send(f.token.connect(f.admin).revokeRole(role, operator));
  assert.equal(await f.token.rewardAllowance(operator), 0n);
  await send(f.token.connect(f.admin).grantRole(role, operator));
  await revert(issuer, 'mintReward', [recipient, 1, id('reward-2')], 'RewardBudgetExceeded');
});

test('issuance pause blocks paid and reward minting while ERC20 transfers and approvals still work', async (t) => {
  const f = await chain(t); await open(f); await rewardSetup(f); await buy(f);
  await send(f.token.connect(f.admin).setIssuancePaused(true));
  await revert(f.token.connect(f.rewardMinter), 'mintReward', [await f.buyer.getAddress(), 1, id('pause')], 'IssuancePaused');
  await revert(f.sale.connect(f.buyer), 'buy', [1, await f.now() + 60, { value: 1n }], 'IssuancePaused', f.token.interface);
  await send(f.token.connect(f.buyer).transfer(await f.other.getAddress(), units(2)));
  await send(f.token.connect(f.buyer).approve(await f.other.getAddress(), units(1)));
  await send(f.token.connect(f.other).transferFrom(await f.buyer.getAddress(), await f.other.getAddress(), units(1)));
  assert.equal(await f.token.balanceOf(await f.other.getAddress()), units(3));
  await send(f.token.connect(f.admin).setIssuancePaused(false));
  await buy(f);
  assert.equal(await f.token.totalSupply(), await f.token.totalPurchased() + await f.token.totalRewarded());
});

test('mint-role revocation atomically rolls back a purchase', async (t) => {
  const f = await chain(t); await open(f);
  await send(f.token.connect(f.admin).revokeRole(await f.token.SALE_MINTER_ROLE(), await f.sale.getAddress()));
  await assert.rejects(send(f.sale.connect(f.buyer).buy(1, await f.now() + 60, { value: parseEther('0.01'), gasLimit: 300000 })));
  assert.equal(await f.token.totalPurchased(), 0n);
  assert.equal(await f.provider.getBalance(await f.sale.getAddress()), 0n);
});

test('any caller may deliver proceeds, but only to the immutable treasury', async (t) => {
  const f = await chain(t); await open(f); await buy(f);
  const before = await f.provider.getBalance(await f.treasury.getAddress());
  await send(f.sale.connect(f.other).withdrawProceeds());
  assert.equal(await f.provider.getBalance(await f.treasury.getAddress()), before + parseEther('0.01'));
  assert.equal(await f.provider.getBalance(await f.sale.getAddress()), 0n);
  await revert(f.sale, 'withdrawProceeds', [], 'EmptyPurchase');
});

test('sale ownership transfer requires acceptance and closure cannot be reversed', async (t) => {
  const f = await chain(t);
  await revert(f.sale.connect(f.buyer), 'unpause', [], 'OwnableUnauthorizedAccount');
  await revert(f.sale, 'renounceOwnership', [], 'OwnershipRenunciationDisabled');
  await send(f.sale.transferOwnership(await f.other.getAddress()));
  assert.equal(await f.sale.owner(), await f.admin.getAddress());
  await send(f.sale.connect(f.other).acceptOwnership());
  await revert(f.sale, 'unpause', [], 'OwnableUnauthorizedAccount');
  const owned = f.sale.connect(f.other);
  await send(owned.unpause()); await send(owned.closeSale());
  await revert(owned, 'unpause', [], 'SaleClosed');
  await revert(owned.connect(f.buyer), 'buy', [1, await f.now() + 60, { value: 1n }], 'SaleClosed');
});

test('token administrator transfer observes its two-day delay', async (t) => {
  const f = await chain(t);
  await send(f.token.connect(f.admin).beginDefaultAdminTransfer(await f.other.getAddress()));
  await revert(f.token.connect(f.other), 'acceptDefaultAdminTransfer', [], 'AccessControlEnforcedDefaultAdminDelay');
  await f.rpc.request({ method: 'evm_increaseTime', params: [2 * 86400 + 1] });
  await f.rpc.request({ method: 'evm_mine', params: [] });
  await send(f.token.connect(f.other).acceptDefaultAdminTransfer());
  assert.equal(await f.token.defaultAdmin(), await f.other.getAddress());
  await revert(f.token.connect(f.admin), 'setIssuancePaused', [true], 'AccessControlUnauthorizedAccount');
});

test('deployment rejects wrong oracle identity, decimals, addresses, and bounds', async (t) => {
  const f = await chain(t);
  const args = [await f.admin.getAddress(), await f.treasury.getAddress(), await f.feed.getAddress(), 3600, floor, ceiling];
  for (const [index, value] of [[0, ZeroAddress], [1, ZeroAddress], [2, await f.buyer.getAddress()], [3, 0], [4, 0], [5, floor]]) {
    const bad = [...args]; bad[index] = value;
    await assert.rejects(f.deploy('ReachCreditsLaunch', bad));
  }
  await send(f.feed.setDescription('BTC / USD'));
  await assert.rejects(f.deploy('ReachCreditsLaunch', args));
  const feed = await f.deploy('MockEthUsdFeed', [18, price, await f.now()]);
  args[2] = await feed.getAddress();
  await assert.rejects(f.deploy('ReachCreditsLaunch', args));
});

test('failed treasury delivery preserves ETH and callback reentry cannot withdraw twice', async (t) => {
  const f = await chain(t);
  const treasury = await f.deploy('TreasuryHarness');
  const launch = await f.deploy('ReachCreditsLaunch', [await f.admin.getAddress(), await treasury.getAddress(), await f.feed.getAddress(), 3600, floor, ceiling]);
  const sale = f.sale.attach(await launch.initialSale());
  await send(treasury.configure(await sale.getAddress(), true, false));
  await send(sale.unpause());
  await send(sale.connect(f.buyer).buy(1, await f.now() + 60, { value: parseEther('0.01') }));
  await revert(sale, 'withdrawProceeds', [], 'TreasuryTransferFailed');
  assert.equal(await f.provider.getBalance(await sale.getAddress()), parseEther('0.01'));
  await send(treasury.configure(await sale.getAddress(), false, true));
  await send(sale.withdrawProceeds());
  assert.equal(await treasury.reentrySucceeded(), false);
  assert.equal(await f.provider.getBalance(await treasury.getAddress()), parseEther('0.01'));
  assert.equal(await f.provider.getBalance(await sale.getAddress()), 0n);
});
