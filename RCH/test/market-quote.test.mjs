import test from 'node:test';
import assert from 'node:assert/strict';
import { valueMarketObservation } from '../service/market-quote.mjs';

const now=1_800_000_000_000;
const observation={blockNumber:100,blockHash:'0x'+'11'.repeat(32),timestamp:now/1000-900,
  liquidity:1n,finalizedOutput:200000n,currentOutput:190000n,feedDecimals:8n,
  roundId:10n,answeredInRound:10n,usdcUsd:99990000n,feedUpdatedAt:BigInt(now/1000-3600)};
const price=value=>valueMarketObservation({...observation,...value},{maxCreditUsdMicros:1_000_000,now});

test('exact sell proceeds choose the lower market quote and integer USD conversion',()=>{
  const quote=price({});
  assert.equal(quote.creditUsdMicros,189981);
  assert.equal(quote.usdcOutputBaseUnits,'190000');
  assert.equal(quote.sourceBlock,100);
  assert.equal(price({currentOutput:250000n}).creditUsdMicros,199980);
});
test('unavailable, stale, malformed and out-of-range market data cannot create credit',()=>{
  for(const change of [{timestamp:now/1000-1801},{timestamp:now/1000+31},{blockHash:'bad'},
    {liquidity:0n},{finalizedOutput:0n},{currentOutput:0n},{feedDecimals:6n},
    {roundId:0n},{answeredInRound:9n},{feedUpdatedAt:0n},{feedUpdatedAt:BigInt(now/1000-86401)},
    {feedUpdatedAt:BigInt(now/1000+31)},{usdcUsd:-1n},{usdcUsd:106000000n}])assert.throws(()=>price(change));
});
test('large redemptions are rejected instead of silently reducing credit and sub-micro values are rejected',()=>{
  assert.throws(()=>price({currentOutput:2_000_000n,finalizedOutput:2_000_000n}),{code:'redemption_value_limit'});
  assert.throws(()=>price({currentOutput:1n,finalizedOutput:1n}),{code:'redemption_value_too_small'});
});
