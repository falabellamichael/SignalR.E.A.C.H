(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReachAccountView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const format = value => { try { return value == null ? '—' : BigInt(value).toLocaleString(); } catch { return '—'; } };
  function holdings(balance) {
    if (balance?.status !== 'available' || balance.decimals !== 18 || balance.balanceBaseUnits == null) return 'Unavailable';
    try {
      const value = BigInt(balance.balanceBaseUnits), divisor = 10n ** 18n;
      const fraction = (value % divisor).toString().padStart(18, '0').replace(/0+$/, '');
      return (value / divisor).toLocaleString() + (fraction ? '.' + fraction : '') + ' RCH';
    } catch { return 'Unavailable'; }
  }
  function render(document, parent, state, { onAction, drafts, busy, error }) {
    const account = state.account, connected = state.status === 'connected', connecting = state.status === 'connecting';
    const active = connected && account?.plan?.status === 'active';
    const create = (tag, className, text) => {
      const node = document.createElement(tag); if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    };
    const body = create('div', 'account-body'); parent.appendChild(body);
    const paragraph = (text, className) => { const p = create('p', className, text); body.appendChild(p); return p; };
    const button = (parent, id, label, action, disabled = false, value) => {
      const node = create('button', 'account-action', label); node.id = id; node.type = 'button';
      node.disabled = busy || disabled;
      node.addEventListener('click', () => onAction(action, typeof value === 'function' ? value() : value));
      parent.appendChild(node); return node;
    };
    const field = (id, label, draft, saved, placeholder) => {
      const wrap = create('label', 'account-field', label); wrap.htmlFor = id;
      const input = create('input'); input.id = id; input.type = 'text'; input.autocomplete = 'off';
      input.value = drafts[draft] ?? saved ?? ''; input.placeholder = placeholder; input.disabled = busy;
      input.addEventListener('input', () => { drafts[draft] = input.value; });
      wrap.appendChild(input); body.appendChild(wrap); return input;
    };
    const messages = {
      unconfigured: 'Add your REACH account service to sign in.',
      disconnected: 'Sign in with your browser wallet to view your subscription and shared allowance.',
      connecting: 'Waiting for your browser wallet. Return here after signing the login message.',
      connected: 'Your account and allowance are shared across REACH apps.',
      expired: 'Your session expired. Sign in again to continue.',
      locked: 'Secure credential storage could not be unlocked. Disconnect the saved account, then sign in again.',
    };
    const status = paragraph(error || state.error || messages[state.status] || messages.unconfigured,
      error || state.error ? 'account-error' : '');
    status.id = 'account-status'; status.setAttribute('role', 'status');
    paragraph(account?.plan?.name || (connected ? 'No active subscription' : 'REACH account'));
    if (account?.walletAddress) paragraph(account.walletAddress, 'account-wallet');
    if (account?.plan?.expiresAt) {
      const expiry = new Date(account.plan.expiresAt);
      if (Number.isFinite(expiry.getTime())) paragraph('Subscription expires ' + expiry.toLocaleDateString());
    }
    if (connected) {
      const summary = create('dl', 'account-summary');
      for (const [label, value] of [
        ['RCH in wallet', holdings(account?.rchBalance)],
        ['Available AI tokens', format(account?.allowance?.totalRemaining)],
        ['Reserved tokens', format(account?.allowance?.reserved)],
        ['Subscription tokens', format(account?.allowance?.includedRemaining)],
        ['Prepaid tokens', format(account?.allowance?.prepaidRemaining)],
      ]) {
        const item = create('div', label === 'RCH in wallet' ? 'account-holdings' : '');
        item.append(create('dt', '', label), create('dd', '', value)); summary.appendChild(item);
      }
      body.appendChild(summary);
      paragraph('AI tokens measure model usage. Wallet holdings become prepaid usage only after a confirmed redemption.');
      if (account?.allowance?.debt && account.allowance.debt !== '0') paragraph('Usage awaiting coverage: ' + format(account.allowance.debt) + ' AI tokens.', 'account-error');
      if (!active) paragraph('An active subscription is required to use prepaid tokens or redeem RCH.');
      else if (!account?.allowedModels?.length) paragraph('No subscription models are available on this service yet.');
    }
    const actions = create('div', 'account-actions'); body.appendChild(actions);
    if (connecting) button(actions, 'account-cancel', 'Cancel sign-in', 'cancel');
    else if (!connected) {
      const signIn = button(actions, 'account-connect', 'Sign in with wallet', 'connect', !state.baseUrl || state.status === 'locked' || state.secureStorageAvailable === false);
      signIn.classList.add('primary');
    }
    if (connected) button(actions, 'account-use', 'Use subscription', 'use', !active || !account?.allowedModels?.length);
    button(actions, 'account-refresh', 'Refresh', 'refresh', !state.baseUrl || connecting);
    if (connected || state.status === 'locked' || state.status === 'expired') button(actions, 'account-disconnect', 'Disconnect', 'disconnect');
    if (connected) {
      const amount = field('account-amount', 'RCH to redeem', 'amount', '', 'For example, 1.5'); amount.inputMode = 'decimal';
      if (state.config?.redemptionEnabled) paragraph('Review the service conversion rate and network before approving in your wallet.');
      else paragraph('RCH redemption is unavailable until the service can provide a verified market quote.');
      button(body, 'account-redeem', 'Review redemption in wallet', 'redeem', !active || !state.config?.redemptionEnabled, () => amount.value.trim());
    }
    const url = field('account-service', 'Account service URL', 'url', state.baseUrl, 'https://accounts.example.com');
    button(body, 'account-save', 'Save account service', 'configure', connecting, () => url.value.trim());
    if (state.secureStorageAvailable === false) paragraph('VS Code secure credential storage is unavailable.', 'account-error');
  }
  return { render, format, holdings };
});
