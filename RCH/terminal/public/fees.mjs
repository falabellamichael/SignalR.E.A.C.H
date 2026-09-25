export function recentPriorityFee(history) {
  if (!Array.isArray(history?.reward) || history.reward.length < 3) throw new Error('Recent network fee data is unavailable. Refresh the estimate before deploying.');
  const samples = history.reward.map(row => {
    if (!Array.isArray(row) || !/^0x[0-9a-f]+$/i.test(row[0] || '')) throw new Error('Recent network fee data is malformed.');
    return BigInt(row[0]);
  }).sort((a,b)=>a<b?-1:a>b?1:0);
  const median = samples[Math.floor(samples.length / 2)];
  return median > 10000000n ? median : 10000000n;
}
