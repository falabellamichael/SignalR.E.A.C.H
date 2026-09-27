import { Contract, FetchRequest, JsonRpcProvider, getAddress, ZeroAddress } from 'ethers';

// Holdings are informational. Reading them never grants usage credit or burns RCH.
export function createTokenBalanceReader({ config, provider: suppliedProvider, timeoutMs = 4000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw new Error('Invalid wallet balance lookup timeout.');
  const chainId = config.chainId;
  const settings = config.redemption || {};
  const configured = Boolean(settings.tokenAddress && (settings.rpcUrl || suppliedProvider));
  const tokenAddress = configured ? getAddress(settings.tokenAddress) : null;
  if (tokenAddress === ZeroAddress) throw new Error('Configure a deployed RCH token for wallet balances.');
  let provider = suppliedProvider;
  if (configured && !provider) {
    const request = new FetchRequest(settings.rpcUrl);
    request.timeout = 8000;
    provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 3, cacheTimeout: -1 });
  }
  const token = configured ? new Contract(tokenAddress, [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ], provider) : null;
  return {
    async read(wallet) {
      const result = { status: 'unconfigured', chainId, tokenAddress, decimals: 18, balanceBaseUnits: null, blockNumber: null };
      if (!configured) return result;
      const unavailable = { ...result, status: 'unavailable' };
      let expired = false, timer;
      // Wallet holdings are optional. Bound the entire sequence below the client
      // sign-in deadline, in addition to each RPC transport's existing timeout.
      const deadline = new Promise(resolve => {
        timer = setTimeout(() => { expired = true; resolve(unavailable); }, timeoutMs);
      });
      const lookup = async () => {
        try {
          if ((await provider.getNetwork()).chainId !== BigInt(chainId)) throw new Error('Wrong chain');
          if (expired) return unavailable;
          const blockNumber = await provider.getBlockNumber();
          if (expired) return unavailable;
          const [decimals, balance] = await Promise.all([
            token.decimals({ blockTag: blockNumber }), token.balanceOf(getAddress(wallet), { blockTag: blockNumber }),
          ]);
          if (decimals !== 18n) throw new Error('Unexpected RCH decimals');
          return { ...result, status: 'available', balanceBaseUnits: balance.toString(), blockNumber };
        } catch {
          // Also consume late rejections after the deadline without exposing RPC
          // details, reporting a false zero, or starting further lookup stages.
          return unavailable;
        }
      };
      try {
        return await Promise.race([lookup(), deadline]);
      } finally { clearTimeout(timer); }
    },
    close() { if (configured && !suppliedProvider) provider.destroy(); },
  };
}
