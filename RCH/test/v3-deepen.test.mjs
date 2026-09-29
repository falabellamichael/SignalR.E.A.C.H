// Tests for the V3 deepening math and the gas watcher.
//
// These are pure-math and profile tests: no network, no Ganache, no chain writes. The V3
// values below are captured from the LIVE mainnet pool and position so a regression in the
// sizing math is caught against real numbers rather than invented ones.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MaxUint256 } from 'ethers';
import {
  amountsForLiquidity, liquidityForAmounts, priceUsdcPerRch, sqrtRatioAtTickForTests,
  bandTicks, freshDeadline, planBandFunding, DEADLINE_SECONDS,
  RCH, USDC, NPM, POOL, POSITION_ID, FEE, TICK_SPACING,
  MIN_USABLE_TICK, MAX_USABLE_TICK,
} from '../scripts/v3-deepen.mjs';
import {
  GAS_PROFILES, costFor, maxGweiForBudget, CAD_PER_USD,
} from '../scripts/gas-watch.mjs';

const Q96 = 2n ** 96n;

// --- live mainnet values (captured 2026-09-28) ------------------------------
const LIVE_SQRT_P = 93063275762248790155800n;      // pool slot0.sqrtPriceX96
const LIVE_LIQUIDITY = 14199999999999n;            // position 1374664 liquidity
const LIVE_TICK = -273105;
const LIVE_TICK_LOWER = -887270;                   // full range
const LIVE_TICK_UPPER = 887270;
const LIVE_PRICE_USDC = 1.3797407881;              // USDC per RCH
const LIVE_POOL_USDC = 16694709n;                  // 16.694709 USDC in the pool

test('config pins the live pool, position, and fee tier', () => {
  assert.equal(RCH, '0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792');
  assert.equal(USDC, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  assert.equal(NPM, '0xC36442b4a4522E871399CD717aBDD847Ab11FE88');
  assert.equal(POOL, '0x2621d7b87776f9b4e72797d4e41e326916649124');
  assert.equal(POSITION_ID, 1375302n, 'the treasury position is the live +/-20% band, not the withdrawn full-range one');
  assert.equal(FEE, 500, 'the reviewed pool is the 0.05% tier');
});

test('sqrtRatioAtTick represents the full-range lower bound without rounding to zero', () => {
  const sqrtA = sqrtRatioAtTickForTests(LIVE_TICK_LOWER);
  const sqrtB = sqrtRatioAtTickForTests(LIVE_TICK_UPPER);
  // The lower bound is ~5.42e-20; at 2^96 scale that is ~4.295e9. A 1e18 scale would have
  // collapsed it to zero, which is the bug this pins.
  assert.ok(sqrtA > 0n, 'the lower bound must not round to zero');
  assert.equal(sqrtA.toString(), '4295558250');
  assert.ok(sqrtB > sqrtA, 'the upper bound must exceed the lower bound');
  assert.ok(sqrtB > Q96, 'the upper bound must exceed the current price scale');
});

test('sqrtRatioAtTick rejects ticks outside the V3 range', () => {
  assert.throws(() => sqrtRatioAtTickForTests(887273), /outside the V3 range/);
  assert.throws(() => sqrtRatioAtTickForTests(-887273), /outside the V3 range/);
});

test('priceUsdcPerRch reproduces the live pool price exactly', () => {
  const price = priceUsdcPerRch(LIVE_SQRT_P, true);
  // Tolerance is 1e-9 outside the printed digits; the value matches to 10 decimals.
  assert.ok(Math.abs(price - LIVE_PRICE_USDC) < 5e-10, `expected ${LIVE_PRICE_USDC}, got ${price}`);
  assert.equal(price.toFixed(10), LIVE_PRICE_USDC.toFixed(10));
});

test('amountsForLiquidity reproduces the pool USDC reserve from the position liquidity', () => {
  const sqrtA = sqrtRatioAtTickForTests(LIVE_TICK_LOWER);
  const sqrtB = sqrtRatioAtTickForTests(LIVE_TICK_UPPER);
  const { amount1 } = amountsForLiquidity(LIVE_SQRT_P, sqrtA, sqrtB, LIVE_LIQUIDITY);
  // The pool's USDC balance is what this position supplies, so it must land within 0.2%.
  const drift = Math.abs(Number(amount1 - LIVE_POOL_USDC) / Number(LIVE_POOL_USDC)) * 100;
  assert.ok(drift < 0.2, `USDC drift ${drift.toFixed(4)}% should be under 0.2% (got ${amount1})`);
});

test('liquidityForAmounts inverts amountsForLiquidity', () => {
  const sqrtA = sqrtRatioAtTickForTests(LIVE_TICK_LOWER);
  const sqrtB = sqrtRatioAtTickForTests(LIVE_TICK_UPPER);
  const amounts = amountsForLiquidity(LIVE_SQRT_P, sqrtA, sqrtB, LIVE_LIQUIDITY);
  const roundTrip = liquidityForAmounts(LIVE_SQRT_P, sqrtA, sqrtB, amounts.amount0, amounts.amount1);
  const drift = Math.abs(Number(roundTrip - LIVE_LIQUIDITY) / Number(LIVE_LIQUIDITY)) * 100;
  assert.ok(drift < 0.001, `round-trip drift ${drift.toFixed(8)}% should be under 0.001%`);
});

test('a USDC-led deposit sizes RCH at the pool price, not an invented one', () => {
  const sqrtA = sqrtRatioAtTickForTests(LIVE_TICK_LOWER);
  const sqrtB = sqrtRatioAtTickForTests(LIVE_TICK_UPPER);
  const usdcIn = 11_794_184n; // all 11.794184 USDC
  // The unconstrained side must be MaxUint256. Passing 0 would make liquidityForAmounts
  // return the minimum of the two sides, i.e. zero — the bug this pins.
  const liquidity = liquidityForAmounts(LIVE_SQRT_P, sqrtA, sqrtB, MaxUint256, usdcIn);
  assert.ok(liquidity > 0n, 'a funded deposit must imply non-zero liquidity');
  const { amount0, amount1 } = amountsForLiquidity(LIVE_SQRT_P, sqrtA, sqrtB, liquidity);
  assert.ok(amount0 > 0n, 'a real deposit must require RCH');
  assert.ok(amount1 > 0n, 'a real deposit must use USDC');
  assert.ok(amount1 <= usdcIn, 'the deposit must not exceed the requested USDC');
  const implied = Number(amount1) / 1e6 / (Number(amount0) / 1e18);
  const drift = Math.abs(implied - LIVE_PRICE_USDC) / LIVE_PRICE_USDC;
  assert.ok(drift < 0.01, `implied price $${implied.toFixed(6)} should track $${LIVE_PRICE_USDC}`);
  // Sanity: ~11.79 USDC at ~$1.38/RCH is roughly 8.5 RCH.
  assert.ok(Math.abs(Number(amount0) / 1e18 - 8.55) < 0.1, `expected ~8.55 RCH, got ${Number(amount0) / 1e18}`);
  // And passing 0 must still collapse to zero, proving the MaxUint256 convention matters.
  assert.equal(liquidityForAmounts(LIVE_SQRT_P, sqrtA, sqrtB, 0n, usdcIn), 0n,
    'passing 0 for the unconstrained side must yield zero liquidity');
});

test('an out-of-range price yields a single-sided amount, as V3 requires', () => {
  const sqrtA = sqrtRatioAtTickForTests(LIVE_TICK_LOWER);
  const sqrtB = sqrtRatioAtTickForTests(LIVE_TICK_UPPER);
  // Above the range: only token1 (USDC) is required.
  const above = amountsForLiquidity(sqrtB + 1n, sqrtA, sqrtB, LIVE_LIQUIDITY);
  assert.equal(above.amount0, 0n, 'above the range no RCH is needed');
  assert.ok(above.amount1 > 0n);
  // Below the range: only token0 (RCH) is required.
  const below = amountsForLiquidity(sqrtA - 1n, sqrtA, sqrtB, LIVE_LIQUIDITY);
  assert.ok(below.amount0 > 0n);
  assert.equal(below.amount1, 0n, 'below the range no USDC is needed');
});

// --- gas watcher -----------------------------------------------------------

test('gas profiles reflect measured mainnet costs, with pair creation far larger', () => {
  assert.ok(GAS_PROFILES.deepen > 300_000n && GAS_PROFILES.deepen < 400_000n,
    'deepening an existing V3 position is approvals plus one call');
  assert.ok(GAS_PROFILES.pair > 3_500_000n,
    'creating a pair deploys the pair contract and must stay in the measured 2.77M-3.96M band');
  assert.ok(GAS_PROFILES.pair > GAS_PROFILES.deepen * 8n,
    'pair creation must be an order of magnitude dearer than deepening');
  assert.ok(GAS_PROFILES.topUpPair < GAS_PROFILES.pair,
    'topping up an existing pair must not pay for a deployment');
});

test('costFor converts gas to ETH and CAD from the live fee and price', () => {
  const maxFee = 10n ** 10n;     // 10 gwei
  const ethUsd = 2673.64;
  const c = costFor('deepen', maxFee, ethUsd, null);
  assert.equal(c.gas, GAS_PROFILES.deepen.toString());
  assert.equal(c.eth, Number(GAS_PROFILES.deepen * maxFee) / 1e18);
  assert.ok(Math.abs(c.usd - c.eth * ethUsd) < 1e-9);
  assert.ok(Math.abs(c.cad - c.usd * CAD_PER_USD) < 1e-9);
  assert.equal(c.affordable, null, 'no balance means affordability is unknown, not assumed');
});

test('costFor reports affordability against a real balance', () => {
  const maxFee = 10n ** 10n;
  const cost = GAS_PROFILES.deepen * maxFee;
  assert.equal(costFor('deepen', maxFee, 2673.64, cost).affordable, true, 'exact balance is enough');
  assert.equal(costFor('deepen', maxFee, 2673.64, cost - 1n).affordable, false, 'one wei short is not');
});

test('maxGweiForBudget finds the gwei ceiling for a CAD budget', () => {
  const ethUsd = 2673.64;
  const budget = 20;
  const threshold = maxGweiForBudget('deepen', budget, ethUsd);
  // At exactly the threshold the cost must equal the budget.
  const atThreshold = costFor('deepen', BigInt(Math.round(threshold * 1e9)), ethUsd, null);
  assert.ok(Math.abs(atThreshold.cad - budget) / budget < 0.02,
    `at ${threshold.toFixed(2)} gwei the cost should be ~$${budget}, got $${atThreshold.cad.toFixed(2)}`);
  // The pair profile needs a far lower gwei to fit the same budget.
  const pairThreshold = maxGweiForBudget('pair', budget, ethUsd);
  assert.ok(pairThreshold < threshold, 'the dearer profile must require cheaper gas');
});

test('maxGweiForBudget rejects nonsense input', () => {
  assert.throws(() => maxGweiForBudget('deepen', 0, 2673.64), /positive/);
  assert.throws(() => maxGweiForBudget('nope', 20, 2673.64), /Unknown gas profile/);
  assert.throws(() => costFor('nope', 10n ** 10n, 2673.64, null), /Unknown gas profile/);
});

// --- band reposition math ---------------------------------------------------
// A band must straddle the live tick, be snapped to the fee tier's tick spacing, and
// yield MORE liquidity than the full-range position for the same capital.

test('bandTicks straddles the live price and snaps to the tick spacing', () => {
  for (const widthPct of [2, 5, 10, 20, 50]) {
    const { tickLower, tickUpper } = bandTicks({ sqrtPriceX96: LIVE_SQRT_P, widthPct });
    // Use ===, not assert.equal: JS yields -0 for negative multiples of the spacing and
    // strict equality (Object.is) treats -0 and 0 as different.
    assert.ok(tickLower % TICK_SPACING === 0, `lower edge must be a multiple of ${TICK_SPACING}, got ${tickLower}`);
    assert.ok(tickUpper % TICK_SPACING === 0, `upper edge must be a multiple of ${TICK_SPACING}, got ${tickUpper}`);
    assert.ok(tickLower < LIVE_TICK && LIVE_TICK < tickUpper,
      `a +/-${widthPct}% band must contain the live tick ${LIVE_TICK}, got [${tickLower}, ${tickUpper}]`);
    assert.ok(tickLower >= MIN_USABLE_TICK && tickUpper <= MAX_USABLE_TICK, 'band must stay usable');
  }
});

test('bandTicks widens monotonically and is centred on the live price', () => {
  const widths = [2, 5, 10, 20, 50].map((w) => bandTicks({ sqrtPriceX96: LIVE_SQRT_P, widthPct: w }));
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i].tickLower <= widths[i - 1].tickLower, 'wider band must not lift the lower edge');
    assert.ok(widths[i].tickUpper >= widths[i - 1].tickUpper, 'wider band must not lower the upper edge');
  }
  // The +/-2% band should sit close to the live tick, not hundreds of ticks away.
  const { tickLower, tickUpper } = widths[0];
  assert.ok(Math.abs(tickLower - LIVE_TICK) < 400, `lower edge should hug the price, got ${tickLower}`);
  assert.ok(Math.abs(tickUpper - LIVE_TICK) < 400, `upper edge should hug the price, got ${tickUpper}`);
});

test('bandTicks rejects widths that cannot form a position', () => {
  assert.throws(() => bandTicks({ sqrtPriceX96: LIVE_SQRT_P, widthPct: 0 }), /between 0 and 100/);
  assert.throws(() => bandTicks({ sqrtPriceX96: LIVE_SQRT_P, widthPct: 100 }), /between 0 and 100/);
  assert.throws(() => bandTicks({ sqrtPriceX96: LIVE_SQRT_P, widthPct: -5 }), /between 0 and 100/);
  assert.throws(() => bandTicks({ sqrtPriceX96: 0n, widthPct: 10 }), /could not be derived/);
});

// --- deadline handling ------------------------------------------------------
// The NonfungiblePositionManager reverts "Transaction too old" once block.timestamp passes the
// deadline, so a plan reviewed and left on screen must be re-stampable.

test('freshDeadline lands on a whole minute and sits DEADLINE_SECONDS ahead', () => {
  const before = Math.floor(Date.now() / 1000);
  const deadline = freshDeadline();
  const after = Math.floor(Date.now() / 1000);
  assert.equal(deadline % 60n, 0n, 'the deadline must snap to a minute boundary');
  assert.ok(deadline >= BigInt(before) + DEADLINE_SECONDS - 60n, 'must be far enough ahead');
  assert.ok(deadline <= BigInt(after) + DEADLINE_SECONDS + 60n, 'must not drift too far ahead');
});

test('freshDeadline is stable within a minute so re-stamping does not churn calldata', () => {
  assert.equal(freshDeadline(), freshDeadline());
});

test('freshDeadline gives a far longer window than the 20 minutes that expired in practice', () => {
  assert.ok(DEADLINE_SECONDS >= 1800, 'a review window under 30 minutes is too short to be useful');
});

// --- resume path ------------------------------------------------------------
// A band plan withdraws before it mints, so a failure mid-sequence leaves the position empty and
// the tokens in the wallet. That state must be completable, not a dead end.

test('a withdrawn position is fundable from the wallet balance alone', () => {
  // Balances observed on mainnet AFTER the real withdrawal landed.
  const holdings = { amount0: 372287780000000000000n, amount1: 28101265n }; // token0=RCH, token1=USDC
  const { tickLower, tickUpper } = bandTicks({ sqrtPriceX96: LIVE_SQRT_P, widthPct: 20 });
  const { liquidity, need } = planBandFunding({
    sqrtPriceX96: LIVE_SQRT_P,
    tickLower,
    tickUpper,
    source: holdings,
    alreadyWithdrawn: true,
    previousLiquidity: 0n,
  });
  assert.ok(liquidity > 0n, 'the held balances must fund a band position');
  assert.ok(need.amount0 <= holdings.amount0, 'the band must be fundable from the held RCH');
  assert.ok(need.amount1 <= holdings.amount1, 'the band must be fundable from the held USDC');
  // Almost all the USDC goes back to work...
  assert.ok(need.amount1 * 100n / holdings.amount1 > 95n, 'almost all of the USDC should be redeployed');
  // ...but RCH is in large surplus at this price, so the band is USDC-limited and only a fraction
  // of the RCH is needed. Asserting "most RCH is used" would be asserting something false.
  assert.ok(need.amount0 < holdings.amount0 / 2n,
    'RCH is the surplus side here, so most of it should remain un-deployed');
});

test('the resume path is not required to beat a previous liquidity of zero', () => {
  const holdings = { amount0: 372287780000000000000n, amount1: 28101265n };
  const { tickLower, tickUpper } = bandTicks({ sqrtPriceX96: LIVE_SQRT_P, widthPct: 20 });
  // alreadyWithdrawn must bypass the "must be deeper than before" check; with previousLiquidity 0
  // the guard would be vacuous, so also confirm it holds for a non-zero previous value.
  assert.doesNotThrow(() => planBandFunding({
    sqrtPriceX96: LIVE_SQRT_P, tickLower, tickUpper, source: holdings,
    alreadyWithdrawn: true, previousLiquidity: 999999999999999n,
  }));
});

test('planBandFunding refuses a band that cannot contain the current price', () => {
  const holdings = { amount0: 372287780000000000000n, amount1: 28101265n };
  assert.throws(() => planBandFunding({
    sqrtPriceX96: LIVE_SQRT_P, tickLower: 100, tickUpper: 200, source: holdings, alreadyWithdrawn: true,
  }), /does not contain the current price/);
});

test('concentrating the same capital multiplies liquidity, matching the earlier estimate', () => {
  const sqrtP = LIVE_SQRT_P;
  const sqrtA0 = sqrtRatioAtTickForTests(LIVE_TICK_LOWER);
  const sqrtB0 = sqrtRatioAtTickForTests(LIVE_TICK_UPPER);
  const exit = amountsForLiquidity(sqrtP, sqrtA0, sqrtB0, LIVE_LIQUIDITY);

  // Re-deposit exactly what the withdrawal frees: no new capital is added.
  const ratios = {};
  for (const widthPct of [2, 5, 10, 20, 50]) {
    const { tickLower, tickUpper } = bandTicks({ sqrtPriceX96: sqrtP, widthPct });
    const sqrtA = sqrtRatioAtTickForTests(tickLower);
    const sqrtB = sqrtRatioAtTickForTests(tickUpper);
    const liquidity = liquidityForAmounts(sqrtP, sqrtA, sqrtB, exit.amount0, exit.amount1);
    ratios[widthPct] = Number(liquidity) / Number(LIVE_LIQUIDITY);
    assert.ok(liquidity > LIVE_LIQUIDITY,
      `a +/-${widthPct}% band must hold more liquidity than the full range`);
    // The band must be fundable by the withdrawal alone.
    const need = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
    assert.ok(need.amount0 <= exit.amount0 && need.amount1 <= exit.amount1,
      `a +/-${widthPct}% band must be fundable from the withdrawal`);
  }

  // Narrower must always mean deeper, and the gains must be substantial not cosmetic.
  assert.ok(ratios[2] > ratios[10] && ratios[10] > ratios[20] && ratios[20] > ratios[50],
    `narrower bands must be deeper, got ${JSON.stringify(ratios)}`);
  assert.ok(ratios[20] > 5, `the +/-20% band should be several times deeper, got ${ratios[20].toFixed(2)}x`);
  assert.ok(ratios[50] > 2, `even +/-50% should beat full range, got ${ratios[50].toFixed(2)}x`);
});