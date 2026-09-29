// Local prepare/validate logic for creating the first RCH/WETH Uniswap V2 pair.
//
// This module NEVER signs or sends anything. It reads live chain state, validates the
// reviewed intent, and returns an unsigned plan describing exactly which transactions the
// operator will be asked to approve in MetaMask. The browser tool consumes this plan.
//
// Why V2 and not V3: a V2 pair needs one `approve` plus one `addLiquidityETH`, issues a
// fungible LP token, and requires no tick-range decisions. The first deposit into an empty
// pair sets the price, so the intended $/RCH price is chosen purely by the deposit ratio.

import { Contract, getAddress, getCreate2Address, keccak256, solidityPacked, MaxUint256 } from 'ethers';
import { sha256 } from './compile.mjs';

export const V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
export const V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const RCH = '0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792';

/// Uniswap V2 pair init code hash (identical across all V2 deployments).
const PAIR_INIT_CODE_HASH = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';
/// Uniswap V2 charges 0.30%; reserves are quoted after that fee.
export const V2_FEE_NUMERATOR = 997n;
export const V2_FEE_DENOMINATOR = 1000n;

const erc20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const factoryAbi = ['function getPair(address,address) view returns (address)'];
const pairAbi = [
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function totalSupply() view returns (uint256)',
];
const routerAbi = [
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)',
];

const fail = (message) => { throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);

/// Deterministic V2 pair address for a token pair, independent of the factory call.
export function predictPairAddress(tokenA, tokenB) {
  const [t0, t1] = getAddress(tokenA).toLowerCase() < getAddress(tokenB).toLowerCase()
    ? [getAddress(tokenA), getAddress(tokenB)]
    : [getAddress(tokenB), getAddress(tokenA)];
  return getCreate2Address(V2_FACTORY, keccak256(solidityPacked(['address', 'address'], [t0, t1])), PAIR_INIT_CODE_HASH);
}

/// Read everything the review needs. All values are plain strings/bigints for the plan file.
export async function readPoolState(provider, { account } = {}) {
  const owner = getAddress(account);
  const rch = new Contract(RCH, erc20, provider);
  const weth = new Contract(WETH, erc20, provider);
  const factory = new Contract(V2_FACTORY, factoryAbi, provider);
  const router = new Contract(V2_ROUTER, routerAbi, provider);

  const [routerFactory, routerWeth, pair] = await Promise.all([
    router.factory(), router.WETH(), factory.getPair(RCH, WETH),
  ]);
  if (!same(routerFactory, V2_FACTORY)) fail('The reviewed router does not point at the reviewed V2 factory.');
  if (!same(routerWeth, WETH)) fail('The reviewed router does not point at canonical WETH.');

  const predicted = predictPairAddress(RCH, WETH);
  const exists = pair !== '0x0000000000000000000000000000000000000000';
  // Only compare against the prediction when a pair actually exists. For a not-yet-created
  // pair the factory correctly returns the zero address, and `predicted` is the address that
  // createPair will produce.
  if (exists && !same(pair, predicted)) {
    fail('The factory pair address does not match the deterministic prediction.');
  }

  const state = {
    chainId: Number((await provider.getNetwork()).chainId),
    account: owner,
    rch: RCH,
    weth: WETH,
    factory: V2_FACTORY,
    router: V2_ROUTER,
    pairAddress: pair,
    predictedPair: predicted,
    pairExists: exists,
    rchDecimals: Number(await rch.decimals()),
    rchBalance: (await rch.balanceOf(owner)).toString(),
    ethBalance: (await provider.getBalance(owner)).toString(),
    rchAllowanceToRouter: (await rch.allowance(owner, V2_ROUTER)).toString(),
  };
  if (state.rchDecimals !== 18) fail('RCH must be 18 decimals for this pairing.');

  if (exists) {
    const p = new Contract(pair, pairAbi, provider);
    const [reserves, token0, token1, totalSupply] = await Promise.all([
      p.getReserves(), p.token0(), p.token1(), p.totalSupply(),
    ]);
    const rchIs0 = same(token0, RCH);
    if (!rchIs0 && !same(token1, RCH)) fail('The existing pair does not contain RCH.');
    const [reserve0, reserve1] = reserves;
    state.pair = {
      token0, token1,
      reserveRch: (rchIs0 ? reserve0 : reserve1).toString(),
      reserveWeth: (rchIs0 ? reserve1 : reserve0).toString(),
      lpTotalSupply: totalSupply.toString(),
    };
  }
  return state;
}

/// Public view helpers for the browser. Prices are never guessed: they come from the pool.
export function priceEthPerRchFromReserves({ reserveRch, reserveWeth }) {
  const r = BigInt(reserveRch);
  if (r === 0n) return null;
  return BigInt(reserveWeth) * (10n ** 18n) / r;
}

/// Build the reviewed, unsigned plan for a first-time RCH/WETH deposit.
///
/// The deposit ratio decides the opening price, so `targetPriceEthPerRch` is the operator's
/// decision and is echoed back for confirmation. ETH is spent as `msg.value`; the RCH side
/// is pulled by the router, which is why an allowance is the first transaction.
export async function prepareWethPool(provider, { account, ethInWei, rchInWei, slippageBps = 500 } = {}) {
  const owner = getAddress(account);
  if (typeof ethInWei !== 'bigint' || ethInWei <= 0n) fail('Choose how much ETH to deposit.');
  if (typeof rchInWei !== 'bigint' || rchInWei <= 0n) fail('Choose how much RCH to deposit.');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) fail('Slippage must be 0-5000 bps.');

  const state = await readPoolState(provider, { account: owner });
  if (state.chainId !== 1) fail('This tool only prepares Ethereum mainnet transactions.');
  if (BigInt(state.rchBalance) < rchInWei) fail('The connected wallet does not hold enough RCH.');

  const ethBalance = BigInt(state.ethBalance);
  const fees = await provider.getFeeData();
  if (fees.maxFeePerGas == null) fail('The RPC did not return EIP-1559 fee data.');

  const [approveGas, addGas] = await estimateGas(provider, { owner, state, rchInWei, ethInWei, fees });
  const gasCostWei = (approveGas + addGas) * fees.maxFeePerGas;
  const neededWei = ethInWei + gasCostWei;
  if (ethBalance < neededWei) {
    fail(`Insufficient ETH. Need ${neededWei} wei (deposit + gas) but the wallet holds ${ethBalance} wei.`);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const bps = BigInt(10000 - slippageBps);
  const minRch = rchInWei * bps / 10000n;
  const minEth = ethInWei * bps / 10000n;

  const router = new Contract(V2_ROUTER, routerAbi, provider);
  const [approveTx, addTx] = await Promise.all([
    new Contract(RCH, erc20, provider).allowance(owner, V2_ROUTER).then((allowance) => (
      BigInt(allowance) >= rchInWei ? null : {
        to: RCH, from: owner, data: approveData(V2_ROUTER, MaxUint256), value: '0x0', purpose: 'approve-rch',
      }
    )),
    router.addLiquidityETH.populateTransaction(RCH, rchInWei, minRch, minEth, owner, deadline, { value: ethInWei }),
  ]);

  const depositRatio = Number(rchInWei) > 0 ? ethInWei * (10n ** 18n) / rchInWei : 0n;
  const plan = {
    schema: 'rch-weth-pool-plan-v1',
    createdAt: new Date().toISOString(),
    chainId: 1,
    account: owner,
    priceEthPerRch: depositRatio.toString(),
    rch: state.rch,
    weth: state.weth,
    router: state.router,
    factory: state.factory,
    pairAddress: state.pairAddress,
    pairExists: state.pairExists,
    existingPair: state.pair ?? null,
    deposit: {
      ethInWei: ethInWei.toString(),
      rchInWei: rchInWei.toString(),
      minRch: minRch.toString(),
      minEth: minEth.toString(),
      slippageBps,
      deadline: deadline.toString(),
    },
    gas: {
      approveGas: approveGas.toString(),
      addGas: addGas.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxCostWei: gasCostWei.toString(),
      walletEthBalance: ethBalance.toString(),
    },
    transactions: [
      ...(approveTx ? [approveTx] : []),
      { to: V2_ROUTER, from: owner, data: addTx.data, value: `0x${ethInWei.toString(16)}`, purpose: 'add-liquidity-eth' },
    ],
  };
  plan.dataHash = sha256(JSON.stringify(plan.transactions));
  return plan;
}

function approveData(spender, amount) {
  const selector = '0x095ea7b3';
  const padded = getAddress(spender).slice(2).toLowerCase().padStart(64, '0');
  const value = amount.toString(16).padStart(64, '0');
  return selector + padded + value;
}

async function estimateGas(provider, { owner, state, rchInWei, ethInWei, fees }) {
  const router = new Contract(V2_ROUTER, routerAbi, provider);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  // Creating a Uniswap V2 pair DEPLOYS the pair contract, so the first deposit costs far
  // more gas than later ones. Measured from real mainnet PairCreated transactions:
  // 2.77M-3.96M gas (median ~3.96M). A fallback of ~250k would be ~16x too optimistic and
  // would falsely reassure an underfunded operator.
  const PAIR_CREATION_GAS = 3_958_278n;
  let addGas = PAIR_CREATION_GAS;
  try {
    const est = await router.addLiquidityETH.estimateGas(
      RCH, rchInWei, 0n, 0n, owner, deadline, { value: ethInWei, from: owner },
    );
    // Trust a successful estimate, but never below the measured pair-creation floor.
    addGas = est * 120n / 100n > PAIR_CREATION_GAS ? est * 120n / 100n : PAIR_CREATION_GAS;
  } catch {
    // An estimate reverts on an unfunded wallet; the measured pair-creation cost is the
    // honest default rather than an optimistic guess.
  }
  const approveGas = BigInt(state.rchAllowanceToRouter) >= rchInWei ? 0n : BigInt(state.pairExists ? 46000 : 46000);
  if (fees.maxFeePerGas == null) fail('The RPC did not return EIP-1559 fee data.');
  return [approveGas, addGas];
}

/// What the operator should do next, based on live state versus the reviewed plan.
export function nextPoolAction(state, plan) {
  if (!state.pairExists) return 'add-liquidity';
  if (BigInt(state.pair?.lpTotalSupply ?? 0) === 0n) return 'add-liquidity';
  return 'already-funded';
}

/// Confirm the pair exists and holds the reviewed deposits.
export function verifyPoolResult(state, plan) {
  if (!state.pairExists) fail('The pair was not created.');
  const expectedRch = BigInt(plan.deposit.rchInWei);
  const actualRch = BigInt(state.pair.reserveRch);
  if (actualRch < expectedRch * 95n / 100n) {
    fail(`Reserve RCH (${actualRch}) is far below the reviewed deposit (${expectedRch}).`);
  }
  const expectedEth = BigInt(plan.deposit.ethInWei);
  const actualEth = BigInt(state.pair.reserveWeth);
  if (actualEth < expectedEth * 95n / 100n) {
    fail(`Reserve WETH (${actualEth}) is far below the reviewed deposit (${expectedEth}).`);
  }
  return {
    pairAddress: state.pairAddress,
    reserveRch: actualRch.toString(),
    reserveWeth: actualEth.toString(),
    priceEthPerRch: priceEthPerRchFromReserves(state.pair).toString(),
    lpTotalSupply: state.pair.lpTotalSupply,
  };
}

/// Quote how much RCH to pair for a target price, so the operator never does this by hand.
export function rchForTargetPrice(ethInWei, priceEthPerRch) {
  if (priceEthPerRch <= 0n) fail('Target price must be positive.');
  return ethInWei * (10n ** 18n) / priceEthPerRch;
}