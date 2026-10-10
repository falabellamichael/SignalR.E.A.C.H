export function recentPriorityFee(history) {
  if (!Array.isArray(history?.reward) || history.reward.length < 3) throw new Error('Recent network fee data is unavailable. Refresh the estimate before deploying.');
  const samples = history.reward.map(row => {
    if (!Array.isArray(row) || !/^0x[0-9a-f]+$/i.test(row[0] || '')) throw new Error('Recent network fee data is malformed.');
    return BigInt(row[0]);
  }).sort((a,b)=>a<b?-1:a>b?1:0);
  const median = samples[Math.floor(samples.length / 2)];
  return median > 10000000n ? median : 10000000n;
}

const MIN_PRIORITY_FEE = 10000000n;

// EIP-1559 fees for the next transaction: the median recent priority fee
// (eth_feeHistory, 5 blocks, 50th percentile) on top of twice the latest base
// fee. Wallet RPCs without fee history fall back to eth_gasPrice minus the base
// fee as the tip. Never consults eth_maxPriorityFeePerGas.
export async function currentEip1559Fees(provider) {
  const block = await provider.getBlock('latest');
  const baseFeePerGas = block?.baseFeePerGas;
  if (typeof baseFeePerGas !== 'bigint') throw new Error('The latest block has no EIP-1559 base fee.');
  let maxPriorityFeePerGas;
  let history;
  try {
    history = await provider.send('eth_feeHistory', ['0x5', 'latest', [50]]);
  } catch {
    history = null;
  }
  if (history) {
    maxPriorityFeePerGas = recentPriorityFee(history);
  } else {
    let gasPrice;
    try {
      gasPrice = BigInt(await provider.send('eth_gasPrice', []));
    } catch {
      throw new Error('The wallet RPC supports neither eth_feeHistory nor eth_gasPrice; cannot price the transaction.');
    }
    const tip = gasPrice - baseFeePerGas;
    maxPriorityFeePerGas = tip > MIN_PRIORITY_FEE ? tip : MIN_PRIORITY_FEE;
  }
  return { baseFeePerGas, maxPriorityFeePerGas, maxFeePerGas: 2n * baseFeePerGas + maxPriorityFeePerGas };
}
