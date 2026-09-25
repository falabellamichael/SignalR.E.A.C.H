(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReachAccountView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const format = value => {
    try { return BigInt(value).toLocaleString(); } catch { return '—'; }
  };
  function derive(state = {}) {
    const connected = state.status === 'connected';
    const connecting = state.status === 'connecting';
    const account = state.account;
    const usable = connected && account?.plan?.status === 'active' && account.allowedModels?.length > 0;
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
      plan: account?.plan?.name || (connected ? 'No active subscription' : 'No account connected'),
      counts: Object.fromEntries(['includedRemaining', 'prepaidRemaining', 'reserved', 'totalRemaining'].map(key => [key, account ? format(account.allowance?.[key]) : '—'])),
    };
  }
  return { derive, format };
});
