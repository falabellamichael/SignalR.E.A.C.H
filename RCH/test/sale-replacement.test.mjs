import assert from 'node:assert/strict';
import test from 'node:test';
import { Contract, ContractFactory, getAddress, keccak256 } from 'ethers';
import { chain, send } from './helpers/chain.mjs';
import { build, saleUsdPriceE8 } from './helpers/chain.mjs';
import { nextReplacementAction, prepareSaleReplacement, readReplacementState, resumeSaleReplacement } from '../scripts/sale-replacement.mjs';

test('replacement plan targets a new treasury and safe state machine preserves the old sale until cutover', async (t) => {
  const f = await chain(t);
  await send(f.sale.unpause());
  const tokenAddress = await f.token.getAddress();
  const oldSaleAddress = await f.sale.getAddress();
  const admin = getAddress(await f.admin.getAddress());
  const oldCode = await f.provider.getCode(oldSaleAddress);
  const deployment = {
    chainId: 1337,
    token: tokenAddress,
    sale: oldSaleAddress,
    treasury: f.treasuryTarget,
    account: admin,
    tokenAbi: build.artifacts.ReachCreditsLaunch.abi,
    saleAbi: build.artifacts.ReachCreditsSale.abi,
    tokenCodeHash: keccak256(await f.provider.getCode(tokenAddress)),
    saleCodeHash: keccak256(oldCode),
  };
  const newTreasury = getAddress(await f.other.getAddress());
  const plan = await prepareSaleReplacement(f.provider, deployment, newTreasury, build, { allowTestChains: true });
  assert.equal(plan.admin, admin);
  assert.equal(plan.oldSale, oldSaleAddress);
  assert.equal(plan.treasury, newTreasury);
  assert.notEqual(plan.expectedSale, oldSaleAddress);
  assert.equal(plan.usdPriceE8PerRch, (await f.sale.usdPriceE8PerRch()).toString());
  assert.equal(plan.usdPriceE8PerRch, saleUsdPriceE8.toString());

  let state = await readReplacementState(f.provider, plan, build);
  assert.equal(nextReplacementAction(state), 'deploy');
  const artifact = build.artifacts.ReachCreditsSale;
  const replacement = await new ContractFactory(artifact.abi, artifact.bytecode, f.admin).deploy(
    tokenAddress, await f.feed.getAddress(), newTreasury, admin, saleUsdPriceE8, 3600, 100n * 10n ** 8n, 100000n * 10n ** 8n,
  );
  await replacement.waitForDeployment();
  assert.equal(getAddress(await replacement.getAddress()), plan.expectedSale);
  assert.equal(await resumeSaleReplacement(f.provider, deployment, plan, build, { admin, treasury: newTreasury }), plan);

  state = await readReplacementState(f.provider, plan, build);
  assert.equal(nextReplacementAction(state), 'pause-old-sale');
  await send(f.sale.pause());
  state = await readReplacementState(f.provider, plan, build);
  assert.equal(nextReplacementAction(state), 'grant-new-sale-role');
  await send(f.token.connect(f.admin).grantRole(await f.token.SALE_MINTER_ROLE(), plan.expectedSale));
  state = await readReplacementState(f.provider, plan, build);
  assert.equal(nextReplacementAction(state), 'open-new-sale');
  await send(replacement.unpause());
  state = await readReplacementState(f.provider, plan, build);
  assert.equal(nextReplacementAction(state), 'revoke-old-sale-role');
  await send(f.token.connect(f.admin).revokeRole(await f.token.SALE_MINTER_ROLE(), oldSaleAddress));
  state = await readReplacementState(f.provider, plan, build);
  assert.equal(nextReplacementAction(state), 'close-old-sale');
  await send(f.sale.closeSale());
  state = await readReplacementState(f.provider, plan, build);
  assert.equal(nextReplacementAction(state), 'complete');
  assert.equal(state.complete, true);
  assert.equal(await f.token.initialSale(), oldSaleAddress);
  assert.equal(await replacement.treasury(), newTreasury);
  const activated = { ...deployment, initialSale: oldSaleAddress, sale: plan.expectedSale,
    treasury: newTreasury, saleCodeHash: keccak256(await f.provider.getCode(plan.expectedSale)) };
  // Deployment expiry does not invalidate a mined contract or require redeployment.
  const expiredPlan = { ...plan, expiresAt: '2020-01-01T00:00:00.000Z' };
  assert.equal(await resumeSaleReplacement(f.provider, activated, expiredPlan, build, { admin, treasury: newTreasury }), expiredPlan);
  for (const invalid of [
    { ...plan, dataHash: '00'.repeat(32) }, { ...plan, treasury: admin },
    { ...plan, sourceHash: '00'.repeat(32) }, { ...plan, expectedSale: oldSaleAddress },
    { ...plan, oracle: { ...plan.oracle, maxAgeSeconds: '1' } },
  ]) {
    await assert.rejects(resumeSaleReplacement(f.provider, activated, invalid, build, { admin, treasury: newTreasury }));
  }
  await assert.rejects(resumeSaleReplacement(f.provider, { ...activated, saleCodeHash: '0x' + '00'.repeat(32) }, plan,
    build, { admin, treasury: newTreasury }), /bytecode does not match/);
});

test('replacement planning rejects a mismatched pinned sale and cannot target the current treasury', async (t) => {
  const f = await chain(t);
  const tokenAddress = await f.token.getAddress();
  const oldSaleAddress = await f.sale.getAddress();
  const deployment = {
    chainId: 1337,
    token: tokenAddress,
    sale: oldSaleAddress,
    treasury: f.treasuryTarget,
    account: await f.admin.getAddress(),
    tokenAbi: build.artifacts.ReachCreditsLaunch.abi,
    saleAbi: build.artifacts.ReachCreditsSale.abi,
    tokenCodeHash: keccak256(await f.provider.getCode(tokenAddress)),
    saleCodeHash: keccak256(await f.provider.getCode(oldSaleAddress)),
  };
  await assert.rejects(
    prepareSaleReplacement(f.provider, { ...deployment, saleCodeHash: '0x' + '00'.repeat(32) }, await f.other.getAddress(), build, { allowTestChains: true }),
    /bytecode does not match/,
  );
  await assert.rejects(
    prepareSaleReplacement(f.provider, deployment, f.treasuryTarget, build, { allowTestChains: true }),
    /already active/,
  );
});
