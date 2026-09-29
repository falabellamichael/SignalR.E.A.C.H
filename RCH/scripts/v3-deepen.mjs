// Local prepare/validate logic for deepening the existing RCH/USDC Uniswap V3 pool.
//
// This module NEVER signs or sends anything. It reads the live position, computes the exact
// RCH/USDC split required for the current tick range, and returns an unsigned plan the
// browser tool turns into MetaMask approvals.
//
// Why not V2: the RCH/USDC pool is Uniswap V3, so the pair contract already exists and no
// deployment is needed. Adding liquidity therefore costs roughly a tenth of creating a new
// RCH/WETH V2 pair. Concentrated liquidity also needs an exact token split for the range,
// which `amountsForDeposit` computes rather than leaving to the caller.

import {
  Contract, getAddress, MaxUint256, parseUnits,
} from 'ethers';
import { sha256 } from './compile.mjs';

export const RCH = '0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792';
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
/// Uniswap V3 NonfungiblePositionManager (canonical mainnet).
export const NPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
/// The live RCH/USDC 0.05% pool.
export const POOL = '0x2621d7b87776f9b4e72797d4e41e326916649124';
/// The treasury's live position: the +/-20% band minted by the 2026-09-28 reposition
/// (ticks -275340..-271280). It replaced the original full-range position 1374664, whose
/// liquidity was withdrawn to fund this one and now sits at zero. Every prepare function
/// accepts a `positionId` override so the next rotation does not strand this default.
export const POSITION_ID = 1375302n;
/// 0.05% fee tier, in hundredths of a bip.
export const FEE = 500;
/// The 0.05% fee tier's tick spacing. Band edges must be multiples of this.
export const TICK_SPACING = 10;
/// Ticks at or beyond these are unusable for any fee tier.
export const MIN_USABLE_TICK = -887270;
export const MAX_USABLE_TICK = 887270;
/// The deadline is NOT frozen at prepare time. The NonfungiblePositionManager reverts with
/// "Transaction too old" once block.timestamp exceeds it, and a reviewed plan can sit on
/// screen far longer than any fixed window, so the page re-stamps this at signing time.
/// This value is only the fallback for callers that do not override it.
/// Kept as a BigInt because it is added directly to a BigInt timestamp below.
export const DEADLINE_SECONDS = 3600n;

/// One minute of slack, so a deadline that is valid on the local clock cannot be rejected as
/// already-expired by a node whose clock runs slightly ahead.
const CLOCK_SLACK_SECONDS = 60n;

const Q96 = 2n ** 96n;
const MAX_TICK = 887272n;
/// uint128 maximum, used for the unbounded `collect` parameters.
const MAX_UINT128 = (1n << 128n) - 1n;

const erc20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const npmAbi = [
  'function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
  'function ownerOf(uint256) view returns (address)',
  'function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0,uint256 amount1)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)',
];
const poolAbi = ['function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)'];

const fail = (message) => { throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);

/// sqrt(1.0001)^tick scaled by 2^96, as a BigInt.
///
/// SIZING ONLY. This is deliberately computed in double precision with a documented bound:
/// error stays far below 1e-9 relative over the ±887272 tick range relevant here, and the
/// on-chain `amount0Min`/`amount1Min` slippage guards (default 2%) are the real protection.
/// The NonfungiblePositionManager recomputes the true amounts, so a slightly-off estimate
/// can never over-spend; it can only under-fill, which the caller sees immediately.
function sqrtRatioAtTick(tick) {
  if (tick < -MAX_TICK || tick > MAX_TICK) fail(`Tick ${tick} is outside the V3 range.`);
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  if (!Number.isFinite(sqrtPrice) || sqrtPrice <= 0) fail(`Tick ${tick} produced an unusable price.`);
  // A full-range lower bound is ~5.42e-20. Scaling by 1e18 would round that to ZERO, so use
  // 1e30 scale: the smallest relevant sqrt ratio is then ~5.4e10, still an exact BigInt.
  const SCALE = 10n ** 30n;
  const scaled = BigInt(Math.round(sqrtPrice * Number(SCALE)));
  if (scaled === 0n) fail(`Tick ${tick} is too small to represent at 1e30 scale.`);
  return (scaled * Q96) / SCALE;
}

/// Exported so tests exercise the SAME implementation production uses.
export const sqrtRatioAtTickForTests = sqrtRatioAtTick;

/// The current wall-clock time in seconds, rounded DOWN to the whole minute.
///
/// Rounding down to a minute boundary matters: if the browser re-stamps a deadline that the
/// server computed moments earlier, both land on the SAME value, so the calldata stops showing
/// as "modified" in the wallet for a change that is purely a timestamp refresh.
///
/// It does not remove the need to re-stamp, because the server derives its deadline from the
/// chain's block timestamp while the browser uses the local clock, and those can differ.
export function freshDeadline() {
  return BigInt(Math.floor(Date.now() / 1000 / 60) * 60) + DEADLINE_SECONDS;
}

/// Mirrors Uniswap V3's LiquidityAmounts.getAmountsForLiquidity.
export function amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) { const t = sqrtA; sqrtA = sqrtB; sqrtB = t; }
  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtP <= sqrtA) {
    amount0 = (liquidity * (sqrtB - sqrtA) * Q96) / (sqrtB * sqrtA);
  } else if (sqrtP < sqrtB) {
    amount0 = (liquidity * (sqrtB - sqrtP) * Q96) / (sqrtB * sqrtP);
    amount1 = (liquidity * (sqrtP - sqrtA)) / Q96;
  } else {
    amount1 = (liquidity * (sqrtB - sqrtA)) / Q96;
  }
  return { amount0, amount1 };
}

/// Largest liquidity such that both desired amounts are not exceeded.
export function liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0Desired, amount1Desired) {
  if (sqrtA > sqrtB) { const t = sqrtA; sqrtA = sqrtB; sqrtB = t; }
  if (sqrtP <= sqrtA) {
    return (amount0Desired * sqrtB * sqrtA) / (sqrtB - sqrtA) / Q96;
  }
  if (sqrtP < sqrtB) {
    const l0 = (amount0Desired * sqrtB * sqrtP) / (sqrtB - sqrtP) / Q96;
    const l1 = (amount1Desired * Q96) / (sqrtP - sqrtA);
    return l0 < l1 ? l0 : l1;
  }
  return (amount1Desired * Q96) / (sqrtB - sqrtA);
}

/// The price band spanning +/- `widthPct` around the live price, snapped OUTWARD to the tick
/// spacing so the live tick always sits strictly inside the resulting position.
///
/// Snapping outward rather than to the nearest tick is deliberate: a band that rounded inward
/// could leave the current price outside its own range, which would make the deposit
/// single-sided and strand half the capital as an idle token balance.
///
/// SIZING ONLY, same precision contract as sqrtRatioAtTick: the on-chain `mint` clamps the
/// result, and the caller sees the real ticks in the reviewed plan before signing.
export function bandTicks({ sqrtPriceX96, widthPct, spacing = TICK_SPACING }) {
  if (!Number.isFinite(widthPct) || widthPct <= 0 || widthPct >= 100) {
    fail('The band width must be a number between 0 and 100, exclusive.');
  }
  if (!Number.isInteger(spacing) || spacing <= 0) fail('Tick spacing must be a positive integer.');
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const price = sp * sp;
  if (!Number.isFinite(price) || price <= 0) fail('The pool price could not be derived from slot0.');
  const perTick = Math.log(1.0001);
  const lower = Math.floor(Math.log(price * (1 - widthPct / 100)) / perTick / spacing) * spacing;
  const upper = Math.ceil(Math.log(price * (1 + widthPct / 100)) / perTick / spacing) * spacing;
  const tickLower = Math.max(MIN_USABLE_TICK, lower);
  const tickUpper = Math.min(MAX_USABLE_TICK, upper);
  if (tickLower >= tickUpper) fail(`A +/-${widthPct}% band is narrower than one ${spacing}-tick step.`);
  return { tickLower, tickUpper };
}

/// Decide which balances fund a band position, and how much liquidity they support.
///
/// Extracted so the RESUME case is directly testable. A band plan withdraws before it mints, so a
/// failure mid-sequence leaves the position empty and the tokens in the wallet. That state has to
/// be completable, which means the mint must be fundable from the wallet balances rather than from
/// a fresh withdrawal.
///
/// `source` is `{ amount0, amount1 }` already denominated in token0/token1 order, plus an
/// `alreadyWithdrawn` flag. Returns the liquidity the balance supports and the exact amounts the
/// mint needs, so callers never have to re-derive either and cannot get the ordering wrong.
export function planBandFunding({
  sqrtPriceX96, tickLower, tickUpper, source, alreadyWithdrawn, previousLiquidity = 0n,
}) {
  const sqrtP = BigInt(sqrtPriceX96);
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  if (!(sqrtP > sqrtA && sqrtP < sqrtB)) fail('The band does not contain the current price.');
  const liquidity = liquidityForAmounts(sqrtP, sqrtA, sqrtB, source.amount0, source.amount1);
  if (liquidity <= 0n) fail('The available balance funds no liquidity in this band.');
  // On a fresh reposition the point is to INCREASE depth; on a resume there is nothing to beat.
  if (!alreadyWithdrawn && BigInt(previousLiquidity) > 0n && liquidity <= BigInt(previousLiquidity)) {
    fail('The narrower band would not increase liquidity; widen the band.');
  }
  const need = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
  if (need.amount0 > source.amount0 || need.amount1 > source.amount1) {
    fail('The band needs more than the available balance; widen the band or add funds.');
  }
  return { liquidity, need, alreadyWithdrawn };
}

export async function readPositionState(provider, { account, positionId = POSITION_ID } = {}) {
  const owner = account ? getAddress(account) : null;
  const tokenId = BigInt(positionId);
  const npm = new Contract(NPM, npmAbi, provider);
  const pool = new Contract(POOL, poolAbi, provider);

  const [position, ownerOf, slot0] = await Promise.all([
    npm.positions(tokenId), npm.ownerOf(tokenId), pool.slot0(),
  ]);
  const sqrtP = slot0[0];
  const tick = Number(slot0[1]);
  const token0 = getAddress(position.token0);
  const token1 = getAddress(position.token1);
  if (!(same(token0, RCH) || same(token1, RCH)) || !(same(token0, USDC) || same(token1, USDC))) {
    fail('The reviewed position is not an RCH/USDC position.');
  }
  if (Number(position.fee) !== FEE) fail(`The position fee tier is ${Number(position.fee)}, expected ${FEE}.`);

  const rchIsToken0 = same(token0, RCH);
  const rch = new Contract(RCH, erc20, provider);
  const usdc = new Contract(USDC, erc20, provider);

  const state = {
    chainId: Number((await provider.getNetwork()).chainId),
    positionId: tokenId.toString(),
    positionOwner: getAddress(ownerOf),
    token0, token1, rchIsToken0,
    fee: Number(position.fee),
    tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper),
    liquidity: position.liquidity.toString(),
    sqrtPriceX96: sqrtP.toString(),
    tick,
    tokensOwedRch: (rchIsToken0 ? position.tokensOwed0 : position.tokensOwed1).toString(),
    tokensOwedUsdc: (rchIsToken0 ? position.tokensOwed1 : position.tokensOwed0).toString(),
  };
  if (owner) {
    state.account = owner;
    state.rchBalance = (await rch.balanceOf(owner)).toString();
    state.usdcBalance = (await usdc.balanceOf(owner)).toString();
    state.rchAllowanceToNpm = (await rch.allowance(owner, NPM)).toString();
    state.usdcAllowanceToNpm = (await usdc.allowance(owner, NPM)).toString();
  }
  return state;
}

/// The live price implied by the pool's sqrtPriceX96, in USDC per RCH.
export function priceUsdcPerRch(sqrtPriceX96, rchIsToken0) {
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  // token1 per token0 from sqrt price, then scale 18dp RCH against 6dp USDC.
  let usdcPerRch = sp * sp * 1e12;
  if (!rchIsToken0) usdcPerRch = 1 / usdcPerRch;
  return usdcPerRch;
}

/// Build the reviewed, unsigned plan for adding liquidity to the treasury's position.
///
/// The operator's decision is how much USDC to commit; the RCH side is derived from the
/// position's tick range so the deposit is exactly balanced and the price does not move.
export async function prepareDeepen(provider, {
  account, usdcInRaw, slippageBps = 200, createNewPosition = false, positionId = POSITION_ID,
} = {}) {
  const owner = getAddress(account);
  const tokenId = BigInt(positionId);
  if (typeof usdcInRaw !== 'bigint' || usdcInRaw <= 0n) fail('Choose how much USDC to add.');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) fail('Slippage must be 0-5000 bps.');

  const state = await readPositionState(provider, { account: owner, positionId: tokenId });
  if (state.chainId !== 1) fail('This tool only prepares Ethereum mainnet transactions.');
  if (BigInt(state.usdcBalance) < usdcInRaw) fail('The connected wallet does not hold enough USDC.');
  if (!createNewPosition && state.positionOwner !== owner) {
    fail(`Position ${tokenId} is owned by ${state.positionOwner}, not the connected wallet. Use --new-position to mint a separate position instead.`);
  }

  const sqrtP = BigInt(state.sqrtPriceX96);
  const sqrtA = sqrtRatioAtTick(state.tickLower);
  const sqrtB = sqrtRatioAtTick(state.tickUpper);
  const rchIsToken0 = state.rchIsToken0;

  const usdcDesired = usdcInRaw;
  // The RCH amount is whatever balances this USDC for the range at the live price.
  //
  // CRITICAL: the unconstrained side must be MaxUint256, not 0. `liquidityForAmounts` returns
  // the MINIMUM of the two implied liquidities, so passing 0 for the other token would force
  // the result to 0 and the deposit would silently size to nothing.
  let rchDesired;
  // Hoisted out of the branches so the plan can report the resulting liquidity and the
  // review page can show the true "after" figure instead of a guess.
  let liquidityToAdd;
  if (rchIsToken0) {
    liquidityToAdd = liquidityForAmounts(sqrtP, sqrtA, sqrtB, MaxUint256, usdcDesired);
    rchDesired = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidityToAdd).amount0;
  } else {
    liquidityToAdd = liquidityForAmounts(sqrtP, sqrtA, sqrtB, usdcDesired, MaxUint256);
    rchDesired = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidityToAdd).amount1;
  }
  if (rchDesired <= 0n) fail('The computed RCH amount is zero; the deposit is too small for this range.');
  if (usdcDesired <= 0n) fail('The computed USDC amount is zero; the deposit is too small for this range.');
  // A deposit far below the pool's scale produces an unusable position; reject it early with a
  // clear reason rather than building a plan that cannot be filled.
  if (rchDesired < 10n ** 12n) fail(`The computed RCH amount (${rchDesired}) is dust; increase the deposit.`);
  if (usdcDesired < 100n) fail(`The computed USDC amount (${usdcDesired}) is dust; increase the deposit.`);
  if (BigInt(state.rchBalance) < rchDesired) {
    fail(`This deposit needs ${rchDesired} RCH base units but the wallet holds ${state.rchBalance}. Move RCH to this wallet first.`);
  }

  const fees = await provider.getFeeData();
  if (fees.maxFeePerGas == null) fail('The RPC did not return EIP-1559 fee data.');
  const approveGas = BigInt(46_000);
  const addGas = BigInt(260_000);
  const needsRchApprove = BigInt(state.rchAllowanceToNpm) < rchDesired;
  const needsUsdcApprove = BigInt(state.usdcAllowanceToNpm) < usdcDesired;
  const approvals = (needsRchApprove ? 1 : 0) + (needsUsdcApprove ? 1 : 0);
  const gasCostWei = (approveGas * BigInt(approvals) + addGas) * fees.maxFeePerGas;
  const ethBalance = await provider.getBalance(owner);
  if (ethBalance < gasCostWei) {
    fail(`Insufficient ETH for gas. Need ${gasCostWei} wei but the wallet holds ${ethBalance} wei. Wait for gas to fall.`);
  }

  const deadline = freshDeadline();
  const bps = BigInt(10000 - slippageBps);
  const amount0Desired = rchIsToken0 ? rchDesired : usdcDesired;
  const amount1Desired = rchIsToken0 ? usdcDesired : rchDesired;
  const amount0Min = amount0Desired * bps / 10000n;
  const amount1Min = amount1Desired * bps / 10000n;

  const npm = new Contract(NPM, npmAbi, provider);
  const addTx = createNewPosition
    ? await npm.mint.populateTransaction({
      token0: state.token0, token1: state.token1, fee: FEE,
      tickLower: state.tickLower, tickUpper: state.tickUpper,
      amount0Desired, amount1Desired, amount0Min, amount1Min,
      recipient: owner, deadline,
    })
    : await npm.increaseLiquidity.populateTransaction({
      tokenId, amount0Desired, amount1Desired, amount0Min, amount1Min, deadline,
    });

  const transactions = [];
  if (needsRchApprove) {
    transactions.push({ to: RCH, from: owner, data: approveData(NPM, MaxUint256), value: '0x0', purpose: 'approve-rch' });
  }
  if (needsUsdcApprove) {
    transactions.push({ to: USDC, from: owner, data: approveData(NPM, MaxUint256), value: '0x0', purpose: 'approve-usdc' });
  }
  transactions.push({
    to: NPM, from: owner, data: addTx.data, value: '0x0',
    purpose: createNewPosition ? 'mint-v3-position' : 'increase-liquidity',
  });

  const plan = {
    schema: 'rch-v3-deepen-plan-v1',
    createdAt: new Date().toISOString(),
    chainId: 1,
    account: owner,
    pool: POOL,
    npm: NPM,
    positionId: tokenId.toString(),
    createNewPosition,
    rch: RCH,
    usdc: USDC,
    rchIsToken0,
    tickLower: state.tickLower,
    tickUpper: state.tickUpper,
    priceUsdcPerRch: priceUsdcPerRch(state.sqrtPriceX96, rchIsToken0),
    deposit: {
      usdcInRaw: usdcDesired.toString(),
      rchInRaw: rchDesired.toString(),
      // Uniswap liquidity units this deposit represents, so callers do not have to
      // re-derive it (and cannot get the token ordering wrong when they try).
      liquidity: liquidityToAdd.toString(),
      amount0Desired: amount0Desired.toString(),
      amount1Desired: amount1Desired.toString(),
      amount0Min: amount0Min.toString(),
      amount1Min: amount1Min.toString(),
      slippageBps,
      deadline: deadline.toString(),
    },
    gas: {
      approvals,
      addGas: addGas.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxCostWei: gasCostWei.toString(),
      walletEthBalance: ethBalance.toString(),
    },
    transactions,
  };
  plan.dataHash = sha256(JSON.stringify(plan.transactions));
  return plan;
}

/// Withdraw the treasury's whole position and re-mint the same capital over a +/- `widthPct`
/// band. This multiplies depth WITHOUT adding any money; gas is the only cost.
///
/// Kept separate from `prepareDeepen` on purpose: that path only ever ADDS liquidity, while
/// this one withdraws first, so the reviewed steps and their risks are genuinely different.
/// Nothing here is signed; the operator signs every step in their own wallet.
export async function prepareBandReposition(provider, {
  account, widthPct, slippageBps = 200, createNewPosition = false, positionId = POSITION_ID,
} = {}) {
  const owner = getAddress(account);
  const tokenId = BigInt(positionId);
  if (typeof widthPct !== 'number' || !Number.isFinite(widthPct)) fail('Choose a band width in percent.');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) fail('Slippage must be 0-5000 bps.');

  const state = await readPositionState(provider, { account: owner, positionId: tokenId });
  if (state.chainId !== 1) fail('This tool only prepares Ethereum mainnet transactions.');
  if (!createNewPosition && state.positionOwner !== owner) {
    fail(`Position ${tokenId} is owned by ${state.positionOwner}, not the connected wallet.`);
  }
  const oldLiquidity = BigInt(state.liquidity);

  // RESUME PATH. An earlier run may have already withdrawn the position, leaving its liquidity at
  // zero and the tokens in the wallet. That is recoverable, not broken: mint the band straight from
  // the wallet. Failing here would strand the balance with no way to finish through this tool,
  // which is worse than a slightly different plan.
  const resuming = oldLiquidity <= 0n;

  const { tickLower, tickUpper } = bandTicks({ sqrtPriceX96: state.sqrtPriceX96, widthPct });
  if (!(state.tick > tickLower && state.tick < tickUpper)) {
    fail(`The live tick ${state.tick} would sit outside [${tickLower}, ${tickUpper}]; widen the band.`);
  }

  const sqrtP = BigInt(state.sqrtPriceX96);
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);

  // Funding available for the band, from whichever source is real.
  let fundingSource;
  let exitingRch = 0n;
  let exitingUsdc = 0n;
  if (resuming) {
    fundingSource = {
      amount0: state.rchIsToken0 ? BigInt(state.rchBalance) : BigInt(state.usdcBalance),
      amount1: state.rchIsToken0 ? BigInt(state.usdcBalance) : BigInt(state.rchBalance),
    };
  } else {
    // Exactly what the wallet receives when the whole position is withdrawn.
    const exit = amountsForLiquidity(
      sqrtP, sqrtRatioAtTick(state.tickLower), sqrtRatioAtTick(state.tickUpper), oldLiquidity,
    );
    fundingSource = exit;
    exitingRch = state.rchIsToken0 ? exit.amount0 : exit.amount1;
    exitingUsdc = state.rchIsToken0 ? exit.amount1 : exit.amount0;
  }

  const { liquidity, need: target } = planBandFunding({
    sqrtPriceX96: state.sqrtPriceX96,
    tickLower,
    tickUpper,
    source: fundingSource,
    alreadyWithdrawn: resuming,
    previousLiquidity: oldLiquidity,
  });

  const rchDesired = state.rchIsToken0 ? target.amount0 : target.amount1;
  const usdcDesired = state.rchIsToken0 ? target.amount1 : target.amount0;
  if (rchDesired <= 0n || usdcDesired <= 0n) fail('The band deposit computed a zero amount.');
  if (rchDesired > BigInt(state.rchBalance) || usdcDesired > BigInt(state.usdcBalance)) {
    fail('The band deposit needs more than this wallet holds; widen the band or add funds.');
  }
  if (!resuming && (rchDesired > exitingRch || usdcDesired > exitingUsdc)) {
    fail('The band deposit exceeds what the withdrawal frees; widen the band.');
  }

  const fees = await provider.getFeeData();
  if (fees.maxFeePerGas == null) fail('The RPC did not return EIP-1559 fee data.');
  const approveGas = BigInt(46_000);
  // Measured on mainnet with eth_estimateGas: decrease 150,048 and collect 163,148. The mint is
  // the large one - it creates a new position and initialises its ticks - so it is budgeted at a
  // deliberately generous 350,000 rather than guessed tight.
  const decreaseGas = BigInt(150_000);
  const collectGas = BigInt(164_000);
  const mintGas = BigInt(350_000);
  const needsRchApprove = BigInt(state.rchAllowanceToNpm) < rchDesired;
  const needsUsdcApprove = BigInt(state.usdcAllowanceToNpm) < usdcDesired;
  const approvals = (needsRchApprove ? 1 : 0) + (needsUsdcApprove ? 1 : 0);
  // Resuming needs no withdrawal, so do not reserve gas for steps that will not be sent.
  const totalGas = approveGas * BigInt(approvals) + mintGas
    + (resuming ? 0n : decreaseGas + collectGas);
  const gasCostWei = totalGas * fees.maxFeePerGas;
  const ethBalance = await provider.getBalance(owner);
  if (ethBalance < gasCostWei) {
    // Say exactly what is wrong and what would fix it, rather than a bare "insufficient funds":
    // the operator needs to know whether to wait for gas or to top the wallet up.
    const maxFeeGwei = Number(fees.maxFeePerGas) / 1e9;
    const ceilingGwei = Number(ethBalance) / Number(totalGas) / 1e9;
    const shortfall = gasCostWei - ethBalance;
    fail(
      `Insufficient ETH for gas. The plan reserves ${totalGas} gas at a maxFeePerGas of `
      + `${maxFeeGwei.toFixed(2)} gwei = ${Number(gasCostWei) / 1e18} ETH, but the wallet holds `
      + `${Number(ethBalance) / 1e18} ETH (short ${Number(shortfall) / 1e18} ETH). `
      + `This wallet can afford a maxFeePerGas of about ${ceilingGwei.toFixed(2)} gwei; the base `
      + `fee needs to fall to roughly ${(ceilingGwei / 2).toFixed(2)} gwei, or top the wallet up.`,
    );
  }

  const deadline = freshDeadline();
  const bps = BigInt(10000 - slippageBps);
  const amount0Desired = state.rchIsToken0 ? rchDesired : usdcDesired;
  const amount1Desired = state.rchIsToken0 ? usdcDesired : rchDesired;
  const amount0Min = amount0Desired * bps / 10000n;
  const amount1Min = amount1Desired * bps / 10000n;

  const npm = new Contract(NPM, npmAbi, provider);
  const mintTx = await npm.mint.populateTransaction({
    token0: state.token0, token1: state.token1, fee: FEE,
    tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min,
    recipient: owner, deadline,
  });

  const transactions = [];
  if (!resuming) {
    // Withdrawing is bounded by nothing (you are removing your own liquidity), so both minimums
    // are zero; the slippage guard that matters is on the re-mint below.
    const decreaseTx = await npm.decreaseLiquidity.populateTransaction({
      tokenId, liquidity: oldLiquidity, amount0Min: 0n, amount1Min: 0n, deadline,
    });
    const collectTx = await npm.collect.populateTransaction({
      tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128,
    });
    transactions.push({ to: NPM, from: owner, data: decreaseTx.data, value: '0x0', purpose: 'decrease-liquidity' });
    transactions.push({ to: NPM, from: owner, data: collectTx.data, value: '0x0', purpose: 'collect-principal' });
  }
  if (needsRchApprove) transactions.push({ to: RCH, from: owner, data: approveData(NPM, MaxUint256), value: '0x0', purpose: 'approve-rch' });
  if (needsUsdcApprove) transactions.push({ to: USDC, from: owner, data: approveData(NPM, MaxUint256), value: '0x0', purpose: 'approve-usdc' });
  transactions.push({ to: NPM, from: owner, data: mintTx.data, value: '0x0', purpose: 'mint-v3-position' });

  const plan = {
    schema: 'rch-v3-band-plan-v1',
    mode: 'band',
    createdAt: new Date().toISOString(),
    chainId: 1,
    account: owner,
    pool: POOL,
    npm: NPM,
    positionId: tokenId.toString(),
    sourcePositionId: tokenId.toString(),
    // A band reposition always mints a NEW position; the old one is emptied.
    createNewPosition: true,
    rch: RCH,
    usdc: USDC,
    rchIsToken0: state.rchIsToken0,
    bandWidthPct: widthPct,
    // True when an earlier run already withdrew the position and this plan only re-mints.
    resuming,
    previousRange: { tickLower: state.tickLower, tickUpper: state.tickUpper },
    tickLower,
    tickUpper,
    priceUsdcPerRch: priceUsdcPerRch(state.sqrtPriceX96, state.rchIsToken0),
    liquidityBefore: oldLiquidity.toString(),
    liquidityAfter: liquidity.toString(),
    depthMultiple: resuming ? null : Number(liquidity) / Number(oldLiquidity),
    withdrawal: {
      liquidity: oldLiquidity.toString(),
      rchOutRaw: exitingRch.toString(),
      usdcOutRaw: exitingUsdc.toString(),
    },
    deposit: {
      usdcInRaw: usdcDesired.toString(),
      rchInRaw: rchDesired.toString(),
      liquidity: liquidity.toString(),
      amount0Desired: amount0Desired.toString(),
      amount1Desired: amount1Desired.toString(),
      amount0Min: amount0Min.toString(),
      amount1Min: amount1Min.toString(),
      slippageBps,
      deadline: deadline.toString(),
    },
    gas: {
      approvals,
      addGas: (mintGas + (resuming ? 0n : decreaseGas + collectGas)).toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxCostWei: gasCostWei.toString(),
      walletEthBalance: ethBalance.toString(),
    },
    transactions,
  };
  plan.dataHash = sha256(JSON.stringify(plan.transactions));
  return plan;
}

function approveData(spender, amount) {
  const selector = '0x095ea7b3';
  const padded = getAddress(spender).slice(2).toLowerCase().padStart(64, '0');
  return selector + padded + amount.toString(16).padStart(64, '0');
}

/// Pool depth before and after, so the operator can see the effect rather than assume it.
export function depthSummary(before, plan) {
  const rch = BigInt(before.reserveRch ?? 0) + BigInt(plan.deposit.rchInRaw);
  const usdc = BigInt(before.reserveUsdc ?? 0) + BigInt(plan.deposit.usdcInRaw);
  const beforeUsdc = BigInt(before.reserveUsdc ?? 0);
  return {
    rchAfter: rch.toString(),
    usdcAfter: usdc.toString(),
    multiplier: beforeUsdc === 0n ? null : Number(usdc) / Number(beforeUsdc),
  };
}

/// Confirm the position grew by at least the reviewed amount.
export function verifyDeepenResult(before, after, plan) {
  const grew = BigInt(after.liquidity) > BigInt(before.liquidity);
  if (!grew) fail('The position liquidity did not increase.');
  const expected = BigInt(plan.deposit.rchInRaw) * 95n / 100n;
  const spent = BigInt(before.rchBalance) - BigInt(after.rchBalance);
  if (spent < expected) fail(`Only ${spent} RCH left the wallet, expected about ${plan.deposit.rchInRaw}.`);
  return {
    liquidityBefore: before.liquidity,
    liquidityAfter: after.liquidity,
    rchSpent: spent.toString(),
  };
}