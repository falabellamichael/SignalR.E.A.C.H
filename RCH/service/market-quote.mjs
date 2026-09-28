import { Contract, getAddress } from 'ethers';
import { fail } from './store.mjs';

export const RCH_MARKET = Object.freeze({
  token: '0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  pool: '0x2621d7b87776f9B4e72797D4E41E326916649124',
  factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  usdcUsdFeed: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
  fee: 500,
});
const same = (a, b) => getAddress(a) === getAddress(b);

// The pilot uses executable size-dependent proceeds, not spot price multiplied
// by holdings. Limits bound the operator's liability in this very small market.
export function valueMarketObservation(value, { maxCreditUsdMicros, now = Date.now() }) {
  if (!Number.isSafeInteger(value.blockNumber) || !/^0x[0-9a-f]{64}$/i.test(value.blockHash || '')
      || !Number.isSafeInteger(value.timestamp) || value.timestamp * 1000 > now + 30_000
      || now - value.timestamp * 1000 > 1800_000) fail(503, 'market_quote_stale', 'The verified market block is too old. Try again shortly.');
  if (value.liquidity <= 0n || value.finalizedOutput <= 0n || value.currentOutput <= 0n) fail(503, 'market_liquidity_unavailable', 'The RCH market cannot quote this amount right now.');
  if (value.feedDecimals !== 8n || value.roundId <= 0n || value.answeredInRound < value.roundId
      || value.feedUpdatedAt <= 0n || value.feedUpdatedAt > BigInt(Math.floor(now / 1000) + 30)
      || BigInt(Math.floor(now / 1000)) - value.feedUpdatedAt > 86400n
      || value.usdcUsd < 95_000_000n || value.usdcUsd > 105_000_000n) {
    fail(503, 'market_reference_unavailable', 'The USDC dollar reference is unavailable or outside the supported range.');
  }
  const usdcOutput = value.finalizedOutput < value.currentOutput ? value.finalizedOutput : value.currentOutput;
  const credit = usdcOutput * value.usdcUsd / 100_000_000n;
  if (credit < 1n) fail(400, 'redemption_value_too_small', 'This amount is worth less than one millionth of a US dollar.');
  if (!Number.isSafeInteger(maxCreditUsdMicros) || maxCreditUsdMicros < 1 || credit > BigInt(maxCreditUsdMicros)) {
    fail(400, 'redemption_value_limit', 'This amount exceeds the initial redemption limit. Enter a smaller RCH amount.');
  }
  return {
    creditUsdMicros: Number(credit), source: 'Uniswap v3 exact RCH sell quote; lower of current and finalized quotes',
    observedAt: new Date(value.timestamp * 1000).toISOString(), sourceBlock: value.blockNumber,
    sourceBlockHash: value.blockHash, usdcOutputBaseUnits: usdcOutput.toString(),
    usdcUsdAnswer: value.usdcUsd.toString(), usdcUsdUpdatedAt: value.feedUpdatedAt.toString(),
    poolAddress: RCH_MARKET.pool, policyVersion: 'owner-pilot-executable-v1',
  };
}

export function createMarketQuoteReader({ provider, maxCreditUsdMicros, now = Date.now }) {
  const pool = new Contract(RCH_MARKET.pool, [
    'function token0() view returns(address)', 'function token1() view returns(address)',
    'function fee() view returns(uint24)', 'function liquidity() view returns(uint128)',
  ], provider);
  const factory = new Contract(RCH_MARKET.factory, ['function getPool(address,address,uint24) view returns(address)'], provider);
  const quoter = new Contract(RCH_MARKET.quoter, [
    'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
  ], provider);
  const feed = new Contract(RCH_MARKET.usdcUsdFeed, [
    'function decimals() view returns(uint8)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
  ], provider);
  return async amount => {
    if ((await provider.getNetwork()).chainId !== 1n) fail(503, 'redemption_wrong_chain', 'The market connection is on the wrong network.');
    const block = await provider.getBlock('finalized');
    if (!block) fail(503, 'market_quote_stale', 'A finalized market block is unavailable.');
    const at = { blockTag: block.number };
    const input = { tokenIn: RCH_MARKET.token, tokenOut: RCH_MARKET.usdc, amountIn: amount, fee: RCH_MARKET.fee, sqrtPriceLimitX96: 0n };
    const [token0, token1, fee, liquidity, expectedPool, finalQuote, currentQuote, decimals, round] = await Promise.all([
      pool.token0(at), pool.token1(at), pool.fee(at), pool.liquidity(at),
      factory.getPool(RCH_MARKET.token, RCH_MARKET.usdc, RCH_MARKET.fee, at),
      quoter.quoteExactInputSingle.staticCall(input, at), quoter.quoteExactInputSingle.staticCall(input),
      feed.decimals(at), feed.latestRoundData(at),
    ]);
    if (!same(token0, RCH_MARKET.token) || !same(token1, RCH_MARKET.usdc)
        || fee !== BigInt(RCH_MARKET.fee) || !same(expectedPool, RCH_MARKET.pool)) {
      fail(503, 'market_identity_mismatch', 'The RCH market does not match the configured source.');
    }
    const recheck = await provider.getBlock(block.number);
    if (recheck?.hash !== block.hash) fail(503, 'market_quote_stale', 'The market block changed. Request a fresh quote.');
    return valueMarketObservation({ blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp,
      liquidity, finalizedOutput: finalQuote[0], currentOutput: currentQuote[0], feedDecimals: decimals,
      roundId: round[0], usdcUsd: round[1], feedUpdatedAt: round[3], answeredInRound: round[4],
    }, { maxCreditUsdMicros, now: now() });
  };
}
