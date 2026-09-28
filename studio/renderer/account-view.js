(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReachAccountView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const format = value => {
    try { return BigInt(value).toLocaleString(); } catch { return '—'; }
  };
  const formatRch = value => {
    try {
      if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value)) return '—';
      const units = BigInt(value), scale = 10n ** 18n;
      const fraction = (units % scale).toString().padStart(18, '0').replace(/0+$/, '');
      return (units / scale).toLocaleString() + (fraction ? '.' + fraction : '') + ' RCH';
    } catch { return '—'; }
  };
  const formatUsd = value => {
    try {
      if (!/^(0|[1-9]\d{0,29})$/.test(String(value))) return '—';
      const micros = BigInt(value), fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
      return 'US$' + (micros / 1_000_000n).toLocaleString() + '.' + fraction;
    } catch { return '—'; }
  };
  function derive(state = {}) {
    const connected = state.status === 'connected';
    const connecting = state.status === 'connecting';
    const account = state.account;
    const credit = account?.credit?.currency === 'USD' ? account.credit : null;
    // The service deducts reservations before publishing balanceMicros.
    const availableMicros = credit && Number(credit.debtMicros || 0) === 0
      ? BigInt(/^(0|[1-9]\d*)$/.test(String(credit.balanceMicros)) ? credit.balanceMicros : 0) : 0n;
    const usable = connected && account?.allowedModels?.length > 0 && (Number(account?.allowance?.totalRemaining) > 0 || availableMicros > 0n);
    const holdings = connected ? account?.rchBalance : null;
    const balanceKnown = holdings?.status === 'available' && holdings.decimals === 18;
    const messages = {
      unconfigured: 'Configure the hosted service to connect your wallet.',
      disconnected: 'Ready to connect. Sign a login message in your browser wallet.',
      connecting: 'Waiting for your browser wallet. Return here after signing in.',
      connected: 'Wallet connected. Your allowance is enforced by the REACH service.',
      expired: 'Your session expired. Connect your wallet again.',
      locked: 'Unlock your system credential vault and restart Studio, or disconnect to remove the saved session.',
    };
    return { connected, connecting, usable,
      badge: String(state.status || 'unconfigured').replace('unconfigured', 'not configured').toUpperCase(),
      message: state.error || (state.baseUrl && !connected && state.secureStorageAvailable === false
        ? 'Unlock your system credential vault to connect. Studio requires secure account storage.'
        : messages[state.status] || messages.unconfigured),
      canConnect: !!state.baseUrl && !connected && !connecting && state.status !== 'locked' && state.secureStorageAvailable !== false,
      canRedeem: connected && state.config?.redemptionEnabled === true,
      redemptionMessage: !connected ? 'Connect your wallet to check whether redemption is enabled.'
        : state.config?.redemptionEnabled !== true ? 'RCH redemption is not enabled on this service.' : '',
      plan: account?.plan?.status === 'active' ? account.plan.name
        : connected && (Number(account?.allowance?.prepaidRemaining) > 0 || availableMicros > 0n) ? 'RCH prepaid access'
          : connected ? 'No active subscription' : 'No account connected',
      walletBalance: balanceKnown ? formatRch(holdings.balanceBaseUnits) : '—',
      walletBalanceDetail: !connected ? 'Connect your wallet to see your RCH balance.'
        : balanceKnown ? 'Held in your wallet on ' + (holdings.chainId === 1 ? 'Ethereum Mainnet' : 'chain ' + holdings.chainId) + '. Redeem RCH separately to add AI usage credit.'
          : holdings?.status === 'unavailable' ? 'RCH balance is temporarily unavailable. Refresh to try again.'
            : 'RCH balance is not configured on this service.',
      counts: Object.fromEntries(['includedRemaining', 'prepaidRemaining', 'reserved', 'totalRemaining'].map(key => [key, account ? format(account.allowance?.[key]) : '—'])),
      usdCredit: credit ? { available: formatUsd(availableMicros < 0n ? 0 : availableMicros), balance: formatUsd(credit.balanceMicros),
        reserved: formatUsd(credit.reservedMicros), debt: formatUsd(credit.debtMicros) } : null,
    };
  }
  return { derive, format, formatRch, formatUsd };
});
