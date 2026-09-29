// Dry-run the band reposition against MAINNET (read-only, builds nothing that is sent).
// Shows the real ticks, the withdrawn amounts, and the liquidity multiple per width.
import { JsonRpcProvider, formatUnits } from 'ethers';
import { prepareBandReposition } from '../scripts/v3-deepen.mjs';

const p = new JsonRpcProvider('https://ethereum-rpc.publicnode.com');
const TREASURY = '0x5b7a910cDF232543aCB7653D71d6B92f01d342C7';

console.log('Band reposition dry-run (READ-ONLY, nothing is sent)');
console.log('account:', TREASURY);
console.log('');
console.log('width  | tick range                  | withdraw RCH     | withdraw USDC   | liquidity          | depth');
console.log('-------+-----------------------------+------------------+-----------------+--------------------+-------');

for (const widthPct of [5, 10, 20, 30, 50]) {
  try {
    const plan = await prepareBandReposition(p, { account: TREASURY, widthPct, slippageBps: 200 });
    const rng = `[${plan.tickLower}, ${plan.tickUpper}]`;
    console.log(
      String('+-' + widthPct + '%').padEnd(7) + '| ' + rng.padEnd(28) + '| ' +
      Number(formatUnits(BigInt(plan.withdrawal.rchOutRaw), 18)).toFixed(6).padEnd(17) + '| ' +
      Number(formatUnits(BigInt(plan.withdrawal.usdcOutRaw), 6)).toFixed(6).padEnd(16) + '| ' +
      plan.liquidityAfter.padEnd(19) + '| ' +
      plan.depthMultiple.toFixed(2) + 'x',
    );
  } catch (e) {
    console.log(String('+-' + widthPct + '%').padEnd(7) + '| FAILED: ' + (e.shortMessage || e.message).slice(0, 80));
  }
}

console.log('');
console.log('Full plan for +/-20% (the recommended width):');
const plan = await prepareBandReposition(p, { account: TREASURY, widthPct: 20 });
console.log(JSON.stringify({
  mode: plan.mode,
  previousRange: plan.previousRange,
  newRange: { tickLower: plan.tickLower, tickUpper: plan.tickUpper },
  priceUsdcPerRch: plan.priceUsdcPerRch,
  liquidityBefore: plan.liquidityBefore,
  liquidityAfter: plan.liquidityAfter,
  depthMultiple: plan.depthMultiple,
  withdrawal: plan.withdrawal,
  deposit: plan.deposit,
  gas: plan.gas,
  steps: plan.transactions.map((t) => t.purpose),
}, null, 2));