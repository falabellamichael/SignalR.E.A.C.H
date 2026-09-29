// Gas watcher for the RCH pool operations.
//
// Tells the operator when mainnet gas is cheap enough to run a known operation, instead of
// watching a gwei number and guessing. Costs are computed from MEASURED gas profiles:
//   - "deepen": increaseLiquidity on the existing V3 RCH/USDC position
//   - "pair":   create the RCH/WETH V2 pair (deploys a pair contract, ~4x more expensive)
//
// Read-only. Never sends anything.

import { JsonRpcProvider } from 'ethers';

/// Measured gas profiles. Kept here so a change is visible in review rather than guessed.
export const GAS_PROFILES = Object.freeze({
  /// Two approvals + one increaseLiquidity against an already-deployed pool.
  deepen: 46_000n * 2n + 260_000n,
  /// Approve + addLiquidityETH where the pair does NOT yet exist, so the pair contract is
  /// deployed inside the call. Measured from real mainnet PairCreated transactions:
  /// 2.77M-3.96M gas; use the upper bound so we never under-estimate.
  pair: 46_000n + 3_958_278n,
  /// Approve + addLiquidityETH into an existing pair (no deployment).
  topUpPair: 46_000n * 2n + 260_000n,
});

const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const feedAbi = ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'];

export const CAD_PER_USD = 1.42;

/// Read the live ETH/USD price from Chainlink. Returns a number in USD.
export async function readEthUsd(provider) {
  const { Contract } = await import('ethers');
  const answer = (await new Contract(CHAINLINK_ETH_USD, feedAbi, provider).latestRoundData())[1];
  const ethUsd = Number(answer) / 1e8;
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) throw new Error('The ETH/USD feed returned an unusable price.');
  return ethUsd;
}

/// Convert a gas profile into an ETH and CAD cost at the given fee data.
export function costFor(profileName, maxFeePerGasWei, ethUsd, ethBalanceWei = null) {
  const gas = GAS_PROFILES[profileName];
  if (gas === undefined) throw new Error(`Unknown gas profile: ${profileName}`);
  const wei = gas * maxFeePerGasWei;
  const eth = Number(wei) / 1e18;
  return {
    profile: profileName,
    gas: gas.toString(),
    wei: wei.toString(),
    eth,
    usd: eth * ethUsd,
    cad: eth * ethUsd * CAD_PER_USD,
    affordable: ethBalanceWei === null ? null : BigInt(ethBalanceWei) >= wei,
  };
}

/// Read live gas and evaluate every profile. Read-only.
export async function readGasReport(provider, { ethBalanceWei = null } = {}) {
  const [fees, ethUsd] = await Promise.all([provider.getFeeData(), readEthUsd(provider)]);
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  if (maxFeePerGas == null) throw new Error('The RPC did not return fee data.');
  const report = {
    maxFeePerGasWei: maxFeePerGas.toString(),
    gwei: Number(maxFeePerGas) / 1e9,
    baseFeeGwei: null,
    ethUsd,
    costs: {},
    checkedAt: new Date().toISOString(),
  };
  for (const name of Object.keys(GAS_PROFILES)) {
    report.costs[name] = costFor(name, maxFeePerGas, ethUsd, ethBalanceWei);
  }
  return report;
}

/// A gwei threshold that makes `profileName` fit inside `budgetCad`.
export function maxGweiForBudget(profileName, budgetCad, ethUsd) {
  const gas = GAS_PROFILES[profileName];
  if (gas === undefined) throw new Error(`Unknown gas profile: ${profileName}`);
  if (!(budgetCad > 0)) throw new Error('Budget must be positive.');
  const budgetEth = budgetCad / CAD_PER_USD / ethUsd;
  const maxFee = (budgetEth * 1e18) / Number(gas);
  return maxFee / 1e9;
}

export function formatReport(report, budgetCad = null) {
  const lines = [];
  lines.push(`gas        ${report.gwei.toFixed(2)} gwei   (ETH/USD $${report.ethUsd.toFixed(2)})`);
  lines.push('');
  for (const [name, c] of Object.entries(report.costs)) {
    const fit = c.affordable === null ? '' : c.affordable ? '  affordable' : '  NOT affordable';
    lines.push(`  ${name.padEnd(10)} ${c.gas.padStart(9)} gas  ${c.eth.toFixed(8)} ETH  $${c.cad.toFixed(2)} CAD${fit}`);
  }
  if (budgetCad !== null) {
    lines.push('');
    for (const name of Object.keys(GAS_PROFILES)) {
      const threshold = maxGweiForBudget(name, budgetCad, report.ethUsd);
      const ready = report.gwei <= threshold;
      lines.push(`  ${name.padEnd(10)} needs <= ${threshold.toFixed(2)} gwei for $${budgetCad} CAD  ${ready ? '<-- READY NOW' : 'waiting'}`);
    }
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && process.argv[1].endsWith('gas-watch.mjs');
if (isMain) {
  const rpcUrl = process.env.RCH_RPC_URL;
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl)) {
    process.stderr.write('Set RCH_RPC_URL to an Ethereum mainnet HTTPS endpoint.\n');
    process.exit(2);
  }
  const { JsonRpcProvider: Provider } = await import('ethers');
  const provider = new Provider(rpcUrl);
  const wallet = process.argv[2];
  const budget = process.argv[3] ? Number(process.argv[3]) : null;
  const balance = wallet ? await provider.getBalance(wallet) : null;
  const report = await readGasReport(provider, { ethBalanceWei: balance });
  if (wallet) process.stdout.write(`wallet     ${wallet}\nbalance    ${(Number(balance) / 1e18).toFixed(8)} ETH\n\n`);
  process.stdout.write(formatReport(report, budget) + '\n');
}