const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = value => /^0x[0-9a-f]{64}$/i.test(value || '');

export async function finalizedReceipt(provider, chainId, confirmations, receipt) {
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || !hash(receipt.blockHash)) return false;
  const canonical = await provider.getBlock(receipt.blockNumber);
  if (!canonical || !same(canonical.hash, receipt.blockHash)) return false;
  if (chainId === 1) {
    const finalized = await provider.getBlock('finalized');
    if (!finalized || !Number.isSafeInteger(finalized.number) || finalized.number < receipt.blockNumber || !hash(finalized.hash)) return false;
    const anchor = await provider.getBlock(finalized.number);
    if (!anchor || !same(anchor.hash, finalized.hash)) return false;
  } else {
    const head = await provider.getBlockNumber();
    if (!Number.isSafeInteger(head) || head - receipt.blockNumber + 1 < confirmations) return false;
  }
  const recheck = await provider.getBlock(receipt.blockNumber);
  return !!recheck && same(recheck.hash, receipt.blockHash);
}
