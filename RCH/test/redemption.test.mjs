import assert from 'node:assert/strict';
import test from 'node:test';
import { id, parseEther, parseUnits, ZeroAddress, ZeroHash } from 'ethers';
import { chain, send } from './helpers/chain.mjs';

const units = (amount) => parseUnits(String(amount), 18);
const oneUsageToken = 10n ** 12n;

async function reverts(contract, method, args, name) {
  await assert.rejects(contract[method].staticCall(...args), (error) => {
    assert.equal(error.revert?.name || contract.interface.parseError(error.data)?.name, name);
    return true;
  });
}

async function funded(t) {
  const f = await chain(t);
  await send(f.sale.unpause());
  const payment = parseEther('0.01');
  const [output] = await f.sale.quote(payment);
  await send(f.sale.connect(f.buyer).buy(output, await f.now() + 600, { value: payment }));
  await send(f.token.connect(f.admin).grantRole(await f.token.REWARD_MINTER_ROLE(), await f.rewardMinter.getAddress()));
  await send(f.token.connect(f.admin).setRewardAllowance(await f.rewardMinter.getAddress(), units(5)));
  await send(f.token.connect(f.rewardMinter).mintReward(await f.buyer.getAddress(), units(5), id('initial-reward')));
  await send(f.token.connect(f.admin).setRedemptionPaused(false));
  return f;
}

async function snapshot(f, redemptionId) {
  return {
    supply: await f.token.totalSupply(),
    purchased: await f.token.totalPurchased(),
    rewarded: await f.token.totalRewarded(),
    redeemed: await f.token.totalRedeemed(),
    usage: await f.token.totalUsageTokensRedeemed(),
    buyer: await f.token.balanceOf(await f.buyer.getAddress()),
    other: await f.token.balanceOf(await f.other.getAddress()),
    used: await f.token.usedRedemptionIds(redemptionId),
  };
}

test('redemption starts paused with zero burn counters and only the token administrator can open it', async (t) => {
  const f = await chain(t);
  assert.equal(await f.token.redemptionPaused(), true);
  assert.equal(await f.token.totalRedeemed(), 0n);
  assert.equal(await f.token.totalUsageTokensRedeemed(), 0n);
  assert.equal(await f.token.AI_TOKENS_PER_RCH(), 1_000_000n);
  assert.equal(await f.token.RCH_UNITS_PER_AI_TOKEN(), oneUsageToken);
  await reverts(f.token.connect(f.buyer), 'redeem', [units(1), id('paused')], 'RedemptionPaused');
  for (const signer of [f.deployer, f.buyer, f.rewardMinter]) {
    await reverts(f.token.connect(signer), 'setRedemptionPaused', [false], 'AccessControlUnauthorizedAccount');
  }
  const receipt = await send(f.token.connect(f.admin).setRedemptionPaused(false));
  const event = receipt.logs.map((log) => f.token.interface.parseLog(log)).find((log) => log?.name === 'RedemptionPauseChanged');
  assert.equal(event.args.paused, false);
  assert.equal(await f.token.redemptionPaused(), false);
});

test('holder redemption burns exact RCH, emits auditable wallet-bound usage and preserves issuance accounting', async (t) => {
  const f = await funded(t), buyer = await f.buyer.getAddress();
  const before = await snapshot(f, id('first-redemption'));
  const holder = f.token.connect(f.buyer), amount = units('2.5');
  assert.equal(await holder.redeem.staticCall(amount, id('first-redemption')), 2_500_000n);
  const receipt = await send(holder.redeem(amount, id('first-redemption')));
  const events = receipt.logs.map((log) => f.token.interface.parseLog(log));
  const redeemed = events.find((log) => log?.name === 'Redeemed');
  assert.equal(redeemed.args.wallet, buyer);
  assert.equal(redeemed.args.redemptionId, id('first-redemption'));
  assert.equal(redeemed.args.amount, amount);
  assert.equal(redeemed.args.usageTokens, 2_500_000n);
  assert.equal(receipt.logs.find((log) => log.topics[0] === redeemed.fragment.topicHash).topics.length, 3);
  const burned = events.find((log) => log?.name === 'Transfer');
  assert.equal(burned.args.from, buyer);
  assert.equal(burned.args.to, ZeroAddress);
  assert.equal(burned.args.value, amount);
  assert.equal(await f.token.balanceOf(buyer), before.buyer - amount);
  assert.equal(await f.token.totalSupply(), before.supply - amount);
  assert.equal(await f.token.totalPurchased(), before.purchased);
  assert.equal(await f.token.totalRewarded(), before.rewarded);
  assert.equal(await f.token.totalRedeemed(), amount);
  assert.equal(await f.token.totalUsageTokensRedeemed(), 2_500_000n);
  assert.equal(await f.token.usedRedemptionIds(id('first-redemption')), true);

  // The smallest redeemable fraction is one millionth RCH, worth exactly one usage token.
  await send(holder.redeem(oneUsageToken, id('one-usage-token')));
  assert.equal(await f.token.totalRedeemed(), amount + oneUsageToken);
  assert.equal(await f.token.totalUsageTokensRedeemed(), 2_500_001n);
  assert.equal(await f.token.totalSupply(), before.purchased + before.rewarded - amount - oneUsageToken);
  const supplyAfterBurn = await f.token.totalSupply();
  await send(holder.transfer(await f.other.getAddress(), units(1)));
  assert.equal(await f.token.totalSupply(), supplyAfterBurn);
  assert.equal(await f.token.totalRedeemed(), amount + oneUsageToken);
});

test('zero IDs, zero amounts and fractional usage-token dust cannot be redeemed or lose value', async (t) => {
  const f = await funded(t), holder = f.token.connect(f.buyer), redemptionId = id('invalid-amount');
  const before = await snapshot(f, redemptionId);
  for (const amount of [0n, 1n, oneUsageToken - 1n, oneUsageToken + 1n, units(1) + 1n]) {
    await reverts(holder, 'redeem', [amount, redemptionId], 'InvalidRedemption');
  }
  await reverts(holder, 'redeem', [oneUsageToken, ZeroHash], 'InvalidRedemption');
  await assert.rejects(send(holder.redeem(oneUsageToken + 1n, redemptionId, { gasLimit: 300000 })));
  assert.deepEqual(await snapshot(f, redemptionId), before);
  assert.equal(await f.token.usedRedemptionIds(ZeroHash), false);
});

test('redemption IDs are globally single-use, including reuse by a different funded wallet', async (t) => {
  const f = await funded(t), redemptionId = id('globally-unique');
  await send(f.token.connect(f.buyer).transfer(await f.other.getAddress(), units(2)));
  await send(f.token.connect(f.buyer).redeem(units(1), redemptionId));
  const before = await snapshot(f, redemptionId);
  for (const signer of [f.buyer, f.other]) {
    await reverts(f.token.connect(signer), 'redeem', [units(1), redemptionId], 'RedemptionAlreadyUsed');
  }
  await assert.rejects(send(f.token.connect(f.other).redeem(units(1), redemptionId, { gasLimit: 300000 })));
  assert.deepEqual(await snapshot(f, redemptionId), before);
  await send(f.token.connect(f.other).redeem(units(1), id('another-wallet-own-redemption')));
  assert.equal(await f.token.totalRedeemed(), units(2));
});

test('insufficient balance rolls back burn counters and ID consumption; the same ID succeeds after funding', async (t) => {
  const f = await funded(t), redemptionId = id('retry-after-funding'), holder = f.token.connect(f.other);
  const before = await snapshot(f, redemptionId);
  await reverts(holder, 'redeem', [units(2), redemptionId], 'ERC20InsufficientBalance');
  await assert.rejects(send(holder.redeem(units(2), redemptionId, { gasLimit: 300000 })));
  assert.deepEqual(await snapshot(f, redemptionId), before);
  await send(f.token.connect(f.buyer).transfer(await f.other.getAddress(), units(2)));
  await send(holder.redeem(units(2), redemptionId));
  assert.equal(await f.token.usedRedemptionIds(redemptionId), true);
  assert.equal(await f.token.balanceOf(await f.other.getAddress()), 0n);
  assert.equal(await f.token.totalRedeemed(), units(2));
  assert.equal(await f.token.totalUsageTokensRedeemed(), 2_000_000n);
});

test('redemption pause and issuance pause are independent and preserve ordinary transfers and approvals', async (t) => {
  const f = await funded(t), holder = f.token.connect(f.buyer), admin = f.token.connect(f.admin);
  await send(admin.setIssuancePaused(true));
  await send(holder.redeem(units(1), id('while-issuance-paused')));
  await send(admin.setRedemptionPaused(true));
  await send(admin.setIssuancePaused(false));
  const redemptionId = id('while-redemption-paused'), before = await snapshot(f, redemptionId);
  await reverts(holder, 'redeem', [units(1), redemptionId], 'RedemptionPaused');
  await assert.rejects(send(holder.redeem(units(1), redemptionId, { gasLimit: 300000 })));
  assert.deepEqual(await snapshot(f, redemptionId), before);
  await send(holder.transfer(await f.other.getAddress(), units(1)));
  await send(holder.approve(await f.other.getAddress(), units(1)));
  await send(f.token.connect(f.other).transferFrom(await f.buyer.getAddress(), await f.other.getAddress(), units(1)));
  assert.equal(await f.token.balanceOf(await f.other.getAddress()), units(2));
  const [out] = await f.sale.quote(1n);
  await send(f.sale.connect(f.buyer).buy(out, await f.now() + 600, { value: 1n }));
  await send(admin.setRedemptionPaused(false));
  await send(holder.redeem(units(1), redemptionId));
  assert.equal(await f.token.totalRedeemed(), units(2));
  assert.equal(await f.token.totalSupply(), await f.token.totalPurchased() + await f.token.totalRewarded() - await f.token.totalRedeemed());
});

test('administrator privileges and ERC20 approval do not permit burning someone else\'s RCH', async (t) => {
  const f = await funded(t), holder = f.token.connect(f.buyer);
  await send(holder.approve(await f.other.getAddress(), units(10)));
  const before = await snapshot(f, id('cannot-burn-others'));
  for (const signer of [f.admin, f.other]) {
    await reverts(f.token.connect(signer), 'redeem', [units(1), id('cannot-burn-others')], 'ERC20InsufficientBalance');
  }
  assert.equal(f.token.interface.getFunction('burnFrom'), null);
  assert.deepEqual(await snapshot(f, id('cannot-burn-others')), before);
  assert.equal(await f.token.allowance(await f.buyer.getAddress(), await f.other.getAddress()), units(10));
});
