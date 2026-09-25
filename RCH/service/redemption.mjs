import { FetchRequest, Interface, JsonRpcProvider, ZeroAddress, formatUnits, getAddress, parseUnits } from 'ethers';
import { AccountError, fail } from './store.mjs';

export const redemptionInterface = new Interface([
  'function redeem(uint256 amount, bytes32 redemptionId) returns (uint256 usageTokens)',
  'function redemptionPaused() view returns (bool)',
  'function RCH_UNITS_PER_AI_TOKEN() view returns (uint256)',
  'function AI_TOKENS_PER_RCH() view returns (uint256)',
  'event Redeemed(address indexed wallet, bytes32 indexed redemptionId, uint256 amount, uint256 usageTokens)',
]);
const unitsPerUsageToken = 10n ** 12n;
const maxUsageTokens = 1_000_000_000_000n;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const transactionFor = (row, tokenAddress, chainId) => ({
  to: tokenAddress,
  data: redemptionInterface.encodeFunctionData('redeem', [BigInt(row.amount), row.id]),
  value: '0x0',
  chainId: `0x${chainId.toString(16)}`,
});

/** Verifies configured-chain evidence; it never holds a wallet key or sends a transaction. */
export function createRedemptionService({ store, config, provider: suppliedProvider }) {
  const enabled = config.redemption?.enabled === true;
  const chainId = config.chainId;
  const confirmations = config.redemption?.confirmations ?? 1;
  let tokenAddress, provider;
  if (enabled) {
    if (!Number.isSafeInteger(chainId) || chainId < 1 || !Number.isSafeInteger(confirmations) || confirmations < 1) {
      fail(500, 'invalid_redemption_config', 'Redemption chain and confirmation policy are invalid.');
    }
    try { tokenAddress = getAddress(config.redemption.tokenAddress); }
    catch { fail(500, 'invalid_redemption_config', 'A verified RCH contract address is required.'); }
    if (tokenAddress === ZeroAddress) fail(500, 'invalid_redemption_config', 'A verified RCH contract address is required.');
    if (!suppliedProvider && !config.redemption.rpcUrl) fail(500, 'invalid_redemption_config', 'A redemption RPC connection is required.');
    if (suppliedProvider) provider = suppliedProvider;
    else {
      const request = new FetchRequest(config.redemption.rpcUrl);
      request.timeout = 15_000;
      provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
    }
  }

  const requireEnabled = () => { if (!enabled) fail(503, 'redemption_disabled', 'RCH redemption is not enabled on this service.'); };
  const readIntent = (redemptionId, ticket) => {
    if (!hashPattern.test(redemptionId || '') || typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) {
      fail(404, 'redemption_missing', 'Redemption is unavailable.');
    }
    return store.getRedemption(redemptionId, ticket);
  };
  const safely = async (fn) => {
    try { return await fn(); }
    catch (error) {
      if (error instanceof AccountError) throw error;
      fail(503, 'redemption_rpc_unavailable', 'The Ethereum connection is unavailable. Your redemption remains recoverable.');
    }
  };
  const checkChain = async () => {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(chainId)) fail(503, 'redemption_wrong_chain', 'The redemption RPC is connected to a different chain.');
  };
  const readToken = async (method) => {
    const data = redemptionInterface.encodeFunctionData(method);
    const result = await provider.call({ to: tokenAddress, data });
    return redemptionInterface.decodeFunctionResult(method, result)[0];
  };
  const checkToken = async ({ requireOpen = false, wallet } = {}) => safely(async () => {
    await checkChain();
    const code = await provider.getCode(tokenAddress);
    if (typeof code !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(code)) {
      fail(503, 'redemption_contract_unavailable', 'The configured RCH contract is not deployed on this chain.');
    }
    const [units, rate] = await Promise.all([readToken('RCH_UNITS_PER_AI_TOKEN'), readToken('AI_TOKENS_PER_RCH')]);
    if (units !== unitsPerUsageToken || rate !== 1_000_000n) fail(503, 'redemption_rate_mismatch', 'The RCH contract conversion does not match this service.');
    if (requireOpen && await readToken('redemptionPaused')) fail(503, 'redemption_paused', 'RCH redemption is currently paused.');
    // The browser currently submits direct wallet-to-token calls. Do not offer a burn that
    // the verifier cannot settle from a smart-account or multisig transaction envelope.
    if (wallet && await provider.getCode(wallet) !== '0x') {
      fail(400, 'unsupported_redemption_wallet', 'Redemption currently supports direct Ethereum wallet transactions. Smart-account and multisig redemption is not enabled.');
    }
  });
  const statusFor = (row, reason) => ({
    redemptionId: row.id,
    status: row.status === 'credited' ? 'credited' : row.tx_hash ? 'pending' : row.expires <= store.now() ? 'expired' : 'created',
    txHash: row.tx_hash || null,
    usageTokens: row.usage_tokens,
    ...(reason ? { reason } : {}),
  });

  async function start(account, amountRch) {
    requireEnabled();
    const current = store.account(account?.id);
    if (current.plan.status !== 'active') fail(403, 'plan_required', 'An active REACH plan is required to redeem usage credit.');
    if (typeof amountRch !== 'string' || !/^(0|[1-9][0-9]{0,12})(?:\.[0-9]{1,18})?$/.test(amountRch)) {
      fail(400, 'invalid_redemption_amount', 'Enter a positive RCH amount using decimal digits.');
    }
    const amount = parseUnits(amountRch, 18);
    const usageTokens = amount / unitsPerUsageToken;
    if (amount === 0n || amount % unitsPerUsageToken !== 0n || usageTokens > maxUsageTokens) {
      fail(400, 'invalid_redemption_amount', 'Redeem a whole number of usage tokens, from 0.000001 RCH up to 1000000 RCH.');
    }
    await checkToken({ requireOpen: true, wallet: current.walletAddress });
    const created = store.createRedemption(current.id, amount.toString(), Number(usageTokens));
    const fragment = new URLSearchParams({ id: created.redemptionId, ticket: created.ticket });
    return { redemptionId: created.redemptionId, url: `${config.origin}/wallet/redeem#${fragment}`, expiresAt: created.expiresAt };
  }

  async function details(redemptionId, ticket) {
    requireEnabled();
    const row = readIntent(redemptionId, ticket);
    const result = {
      ...statusFor(row), walletAddress: row.wallet, amountRch: formatUnits(row.amount, 18),
      chainId, expiresAt: new Date(row.expires).toISOString(), transaction: null,
    };
    if (row.tx_hash || row.status === 'credited') return { ...result, signingUnavailableReason: 'already_submitted' };
    if (row.expires <= store.now()) return { ...result, signingUnavailableReason: 'intent_expired' };
    if (store.account(row.account_id).plan.status !== 'active') return { ...result, signingUnavailableReason: 'plan_required' };
    try { await checkToken({ requireOpen: true, wallet: row.wallet }); }
    catch (error) {
      if (error instanceof AccountError) return { ...result, signingUnavailableReason: error.code, message: error.message };
      throw error;
    }
    // RPC checks may take long enough for expiry, logout-related plan changes, or a
    // concurrent submission. Never return another signing request after that point.
    const refreshed = readIntent(redemptionId, ticket);
    if (refreshed.tx_hash || refreshed.status === 'credited') return { ...result, ...statusFor(refreshed), signingUnavailableReason: 'already_submitted' };
    if (refreshed.expires <= store.now()) return { ...result, status: 'expired', signingUnavailableReason: 'intent_expired' };
    if (store.account(refreshed.account_id).plan.status !== 'active') return { ...result, signingUnavailableReason: 'plan_required' };
    return { ...result, transaction: transactionFor(refreshed, tokenAddress, chainId) };
  }

  // Recheck the receipt's block by height. Fetching only by its own hash would accept
  // an orphaned block that some RPCs retain after a reorganization.
  async function finalBlock(receipt) {
    if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || !hashPattern.test(receipt.blockHash || '')) return false;
    const canonical = await provider.getBlock(receipt.blockNumber);
    if (!canonical || !same(canonical.hash, receipt.blockHash)) return false;
    if (chainId === 1) {
      const finalized = await provider.getBlock('finalized');
      if (!finalized || !Number.isSafeInteger(finalized.number) || finalized.number < receipt.blockNumber || !hashPattern.test(finalized.hash || '')) return false;
      const finalizedCanonical = await provider.getBlock(finalized.number);
      if (!finalizedCanonical || !same(finalizedCanonical.hash, finalized.hash)) return false;
    } else {
      const head = await provider.getBlockNumber();
      if (!Number.isSafeInteger(head) || head - receipt.blockNumber + 1 < confirmations) return false;
    }
    const recheck = await provider.getBlock(receipt.blockNumber);
    return !!recheck && same(recheck.hash, receipt.blockHash);
  }

  async function verify(row) {
    await checkToken();
    const receipt = await provider.getTransactionReceipt(row.tx_hash);
    if (!receipt) return 'transaction_pending';
    if (!same(receipt.hash ?? receipt.transactionHash, row.tx_hash)) return 'transaction_mismatch';
    if (receipt.status !== 1) return 'transaction_failed';
    const transaction = await provider.getTransaction(row.tx_hash);
    const expected = transactionFor(row, tokenAddress, chainId);
    if (!transaction || !same(transaction.hash, row.tx_hash) || !same(transaction.from, row.wallet)
      || !same(transaction.to, tokenAddress) || !same(transaction.data, expected.data)
      || transaction.value !== 0n || transaction.chainId !== BigInt(chainId)
      || !same(receipt.from, row.wallet) || !same(receipt.to, tokenAddress)) return 'transaction_mismatch';
    if (transaction.blockHash && !same(transaction.blockHash, receipt.blockHash)) return 'transaction_mismatch';
    const matches = [];
    for (const log of receipt.logs ?? []) {
      if (!same(log.address, tokenAddress) || log.removed === true) continue;
      let parsed;
      try { parsed = redemptionInterface.parseLog(log); } catch { continue; }
      if (!parsed || parsed.name !== 'Redeemed' || !same(parsed.args.redemptionId, row.id)) continue;
      const logIndex = log.index ?? log.logIndex;
      if (!same(parsed.args.wallet, row.wallet) || parsed.args.amount !== BigInt(row.amount)
        || parsed.args.usageTokens !== BigInt(row.usage_tokens) || !Number.isSafeInteger(logIndex) || logIndex < 0
        || !same(log.transactionHash, row.tx_hash) || !same(log.blockHash, receipt.blockHash)
        || log.blockNumber !== receipt.blockNumber) return 'redemption_event_mismatch';
      matches.push(logIndex);
    }
    if (matches.length !== 1) return 'redemption_event_mismatch';
    if (!await finalBlock(receipt)) return 'awaiting_finality';
    store.creditRedemption(row.id, `${chainId}:${row.tx_hash.toLowerCase()}:${matches[0]}`);
    return null;
  }

  async function reconcileRow(row) {
    if (row.status === 'credited') return statusFor(row);
    let reason;
    try { reason = await safely(() => verify(row)); }
    catch (error) { reason = error instanceof AccountError ? error.code : 'redemption_verification_unavailable'; }
    return { ...statusFor(row, reason), status: reason ? 'pending' : 'credited' };
  }

  async function submit(redemptionId, ticket, txHash) {
    requireEnabled();
    if (!hashPattern.test(txHash || '')) fail(400, 'invalid_transaction', 'Enter a valid Ethereum transaction hash.');
    const previous = readIntent(redemptionId, ticket);
    if (previous.tx_hash && !same(previous.tx_hash, txHash)) {
      if (previous.status === 'credited') fail(409, 'transaction_conflict', 'This redemption has already been credited.');
      await safely(async () => {
        await checkChain();
        const receipt = await provider.getTransactionReceipt(previous.tx_hash);
        let definitivelyNotThisBurn = receipt?.status === 0;
        if (receipt?.status === 1 && Array.isArray(receipt.logs)) {
          // A mistakenly pasted successful transaction may be corrected. A real burn
          // must keep its original record, even when its envelope needs reconciliation.
          definitivelyNotThisBurn = !receipt.logs.some(log => {
            if (!same(log.address, tokenAddress)) return false;
            let parsed;
            try { parsed = redemptionInterface.parseLog(log); } catch { return false; }
            return parsed?.name === 'Redeemed' && same(parsed.args.wallet, previous.wallet)
              && same(parsed.args.redemptionId, previous.id) && parsed.args.amount === BigInt(previous.amount)
              && parsed.args.usageTokens === BigInt(previous.usage_tokens);
          });
        }
        if (!receipt || !same(receipt.hash ?? receipt.transactionHash, previous.tx_hash)
          || !definitivelyNotThisBurn || !await finalBlock(receipt)) {
          fail(409, 'transaction_conflict', 'The previous transaction must be finalized and confirmed not to contain this redemption before replacing its hash.');
        }
        store.replaceFailedRedemption(redemptionId, ticket, previous.tx_hash, txHash);
      });
    }
    // An expired signing ticket still authorizes reconciliation of its original intent.
    // Expiry prevents presenting a new transaction; it must never discard an existing burn.
    const row = store.submitRedemption(redemptionId, ticket, txHash);
    return reconcileRow(row);
  }

  async function reconcile(accountId) {
    if (!enabled) return [];
    const results = [];
    for (const row of store.pendingRedemptions(accountId)) results.push(await reconcileRow(row));
    return results;
  }

  const close = () => { if (!suppliedProvider) provider?.destroy(); };
  return { enabled, start, details, submit, reconcile, close };
}
