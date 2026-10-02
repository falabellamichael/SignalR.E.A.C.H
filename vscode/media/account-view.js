(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReachAccountView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const format = value => { try { return value == null ? '—' : BigInt(value).toLocaleString(); } catch { return '—'; } };
  const count = value => /^(0|[1-9]\d{0,29})$/.test(String(value)) ? BigInt(value) : 0n;
  const formatUsd = value => {
    if (!/^(0|[1-9]\d{0,29})$/.test(String(value))) return '—';
    const micros = BigInt(value), fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
    return 'US$' + (micros / 1_000_000n).toLocaleString() + '.' + fraction;
  };
  const requestModel = model => model?.access === 'requests' || model?.pricing?.unit === 'request';
  function modelPrice(model, basicActive = false) {
    if (requestModel(model)) return formatUsd(model.pricing?.usdMicrosPerRequest ?? 10000) + ' per completed request'
      + (basicActive ? ' after ' + format(model.pricing?.includedRequests ?? 1500) + ' included Basic requests' : '');
    return model.pricing ? 'Input ' + formatUsd(model.pricing.inputUsdMicrosPerMillion)
      + ' / output ' + formatUsd(model.pricing.outputUsdMicrosPerMillion) + ' per 1M tokens'
      + (model.pricing.cachedInputUsdMicrosPerMillion != null ? ' / cached input ' + formatUsd(model.pricing.cachedInputUsdMicrosPerMillion) : '') : '';
  }
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
    const allowed = account?.allowedModels || [], requests = account?.requestAllowance;
    const models = allowed.length ? allowed : state.config?.redemptionModels || [];
    const requestMode = !!requests || models.some(requestModel), basicActive = connected && requests?.basicActive === true;
    const remaining = basicActive ? count(requests.remaining) : 0n;
    const overage = count(requests?.overageUsdMicrosPerRequest) || 10000n;
    const credit = account?.credit?.currency === 'USD' ? account.credit : null;
    const available = credit && Number(credit.debtMicros || 0) === 0 ? count(credit.balanceMicros) : 0n;
    const active = connected && state.secureStorageAvailable !== false && allowed.some(entry => requestModel(entry)
      ? remaining > 0n || available >= overage : Number(account?.allowance?.totalRemaining) > 0 || available > 0n);
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
    paragraph(requestMode ? connected ? basicActive ? 'Basic' : 'Wallet pay as you go' : 'REACH account'
      : account?.plan?.status === 'active' ? account.plan.name
      : connected && (Number(account?.allowance?.prepaidRemaining) > 0 || available > 0n) ? 'RCH prepaid access'
        : connected ? 'No active subscription' : 'REACH account');
    if (account?.walletAddress || account?.email) paragraph(account.walletAddress || account.email, 'account-wallet');
    const periodEnd = requestMode ? basicActive ? requests.periodEndsAt : null : account?.plan?.expiresAt;
    if (periodEnd) {
      const expiry = new Date(periodEnd);
      if (Number.isFinite(expiry.getTime())) paragraph('Subscription expires ' + expiry.toLocaleDateString());
    }
    if (connected) {
      const summary = create('dl', 'account-summary');
      const allowanceRows = requestMode ? [
        ['Included requests remaining', format(remaining)],
        ['Completed included requests', format(requests?.completed ?? 0)],
        ['Requests in progress', format(requests?.reserved ?? 0)],
        ['Overage per completed request', formatUsd(overage)],
      ] : [
        ['Available AI tokens', format(account?.allowance?.totalRemaining)], ['Reserved tokens', format(account?.allowance?.reserved)],
        ['Subscription tokens', format(account?.allowance?.includedRemaining)], ['Prepaid tokens', format(account?.allowance?.prepaidRemaining)],
      ];
      for (const [label, value] of [
        ['RCH in wallet', holdings(account?.rchBalance)],
        ...allowanceRows,
        ...(credit ? [['US dollar credit available', formatUsd(available)], ['Credit reserved', formatUsd(credit.reservedMicros)]] : []),
      ]) {
        const item = create('div', label === 'RCH in wallet' ? 'account-holdings' : '');
        item.append(create('dt', '', label), create('dd', '', value)); summary.appendChild(item);
      }
      body.appendChild(summary);
      paragraph(requestMode ? basicActive ? 'Basic includes ' + format(requests.includedLimit) + ' completed requests per subscription period. '
        + 'Additional completed requests cost ' + formatUsd(overage) + ' each.'
        : 'Wallet pay as you go costs ' + formatUsd(overage) + ' per completed request. Wallet holdings become usage credit only after a confirmed redemption.'
        : 'AI tokens measure model usage. Wallet holdings become prepaid usage only after a confirmed redemption.');
      if (credit && count(credit.debtMicros) > 0n) paragraph('Usage awaiting coverage: ' + formatUsd(credit.debtMicros) + '.', 'account-error');
      if (!requestMode && account?.allowance?.debt && account.allowance.debt !== '0') paragraph('Usage awaiting coverage: ' + format(account.allowance.debt) + ' AI tokens.', 'account-error');
      if (!active && !account?.allowedModels?.length) paragraph('No metered models are available on this service yet.');
    }
    for (const entry of models) {
      const pricing = modelPrice(entry, basicActive);
      if (pricing) paragraph((entry.name || entry.id) + ' · ' + pricing);
    }
    const actions = create('div', 'account-actions'); body.appendChild(actions);
    if (connecting) button(actions, 'account-cancel', 'Cancel sign-in', 'cancel');
    else if (!connected) {
      const signIn = button(actions, 'account-connect', state.config?.emailLogin ? 'Sign in with wallet or email' : 'Sign in with wallet', 'connect', !state.baseUrl || state.status === 'locked' || state.secureStorageAvailable === false);
      signIn.classList.add('primary');
    }
    if (connected) button(actions, 'account-use', 'Use REACH models', 'use', !active);
    button(actions, 'account-refresh', 'Refresh', 'refresh', !state.baseUrl || connecting);
    if (connected || state.status === 'locked' || state.status === 'expired') button(actions, 'account-disconnect', 'Disconnect', 'disconnect');
    if (connected) {
      const amount = field('account-amount', 'RCH to redeem', 'amount', '', 'For example, 1.5'); amount.inputMode = 'decimal';
      if (state.config?.redemptionEnabled) paragraph('Review the service conversion rate and network before approving in your wallet.');
      else paragraph('RCH redemption is unavailable until the service can provide a verified market quote.');
      button(body, 'account-redeem', 'Review redemption in wallet', 'redeem', !state.config?.redemptionEnabled, () => amount.value.trim());
      const card = state.config?.cardPayments === true, paypal = state.config?.paypalPayments === true;
      if (card || paypal) {
        const planActive = basicActive || account?.plan?.status === 'active';
        const price = formatUsd(state.config.subscription?.basic?.priceUsdMicros ?? 15000000) + ' a month';
        paragraph(card ? 'Pay by card on the Stripe checkout page' + (paypal ? ' or with PayPal' : '') + '. Your card details never reach REACH.'
          : 'Pay with PayPal. Your PayPal details never reach REACH.');
        if (card) button(body, 'account-subscribe', planActive ? 'Basic is active' : 'Subscribe to Basic · ' + price, 'subscribe', planActive);
        if (paypal) button(body, 'account-subscribe-paypal', planActive ? 'Basic is active' : 'Subscribe with PayPal · ' + price, 'paypalSubscribe', planActive);
        if (planActive && card) button(body, 'account-billing', 'Manage or cancel subscription', 'billing');
        if (planActive && paypal) paragraph('A PayPal subscription is cancelled in your PayPal account, under Automatic payments.');
        const topUp = field('account-topup', 'US dollar credit to add', 'topup', '', 'Between 1 and 500, for example 20'); topUp.inputMode = 'decimal';
        if (card) button(body, 'account-topup-card', 'Add credit by card', 'topup', false, () => topUp.value.trim());
        if (paypal) button(body, 'account-topup-paypal', 'Add credit with PayPal', 'paypalTopup', false, () => topUp.value.trim());
      }
    }
    const url = field('account-service', 'Account service URL', 'url', state.baseUrl, 'https://accounts.example.com');
    button(body, 'account-save', 'Save account service', 'configure', connecting, () => url.value.trim());
    if (state.secureStorageAvailable === false) paragraph('VS Code secure credential storage is unavailable.', 'account-error');
  }
  return { render, format, holdings, formatUsd, modelPrice };
});
