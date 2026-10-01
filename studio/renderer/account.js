'use strict';
(() => {
  const api = window.reach?.account, view = window.ReachAccountView;
  if (!api || !view || !document.getElementById('home-account-service')) return;
  const defaultServiceOrigin = 'https://unbent-semicolon-hermit.ngrok-free.dev';
  const el = id => document.getElementById('home-' + id);
  let state = {}, busy = false, refreshing = false, serviceDirty = false;
  function render(next) {
    state = next || {}; const model = view.derive(state);
    el('account-badge').textContent = model.badge;
    if (!serviceDirty && document.activeElement !== el('account-service')) el('account-service').value = state.baseUrl || defaultServiceOrigin;
    el('account-service').disabled = busy || model.connecting;
    el('account-configure').disabled = busy || model.connecting;
    el('account-connect').disabled = busy || !model.canConnect;
    el('account-connect').hidden = model.connected || model.connecting;
    el('account-cancel').hidden = !model.connecting;
    el('account-cancel').disabled = false;
    el('account-refresh').disabled = busy || !state.baseUrl || model.connecting;
    el('account-disconnect').disabled = busy || !['connected', 'locked', 'expired'].includes(state.status);
    el('account-status').textContent = model.message;
    el('account-status').dataset.state = state.error || state.status === 'locked' ? 'error' : model.connected ? 'success' : '';
    el('account-wallet').textContent = state.account?.walletAddress || 'Your wallet address will appear after sign-in.';
    el('wallet-balance').textContent = model.walletBalance;
    el('wallet-balance-detail').textContent = model.walletBalanceDetail;
    window.ReachAccountMenu?.update(state, model);
    const menuSummary = document.getElementById('account-menu-summary');
    if (menuSummary && model.connected && model.requestMode) menuSummary.textContent = model.plan + ' · ' + model.usageSummary;
    el('account-plan').textContent = model.plan;
    el('account-plan-status').textContent = model.requestMode ? model.connected ? model.requestAllowance.basicActive ? 'BASIC' : 'PAY AS YOU GO' : '—'
      : model.plan === 'RCH prepaid access' ? 'PREPAID' : String(state.account?.plan?.status || '—').toUpperCase();
    const expiry = new Date(model.requestMode ? model.requestAllowance.periodEndsAt ?? NaN : state.account?.plan?.expiresAt).getTime();
    el('account-plan-detail').textContent = model.connected
      ? (Number.isFinite(expiry) ? 'Current period ends ' + new Date(expiry).toLocaleString() + '. ' : '') +
        (model.requestMode ? model.requestAllowance.basicActive
          ? 'Basic includes ' + model.requestAllowance.includedLimit + ' completed requests this subscription period. ' + model.usageSummary + '.'
          : 'Wallet pay as you go costs ' + model.requestAllowance.overagePrice + ' per completed request. Add credit to use the models below.'
          : model.usable ? 'All models below use the same account allowance.' : 'Add a plan or redeem RCH credit when redemption is available and metered models are configured.')
      : 'Connect your wallet to load your plan and permitted models.';
    el('account-models').replaceChildren();
    const availableModels = state.account?.allowedModels?.length ? state.account.allowedModels : state.config?.redemptionModels || [];
    el('account-models').setAttribute('aria-label', model.usable ? 'Models included with this account' : 'Models available after funding your account');
    for (const entry of availableModels) {
      const chip = document.createElement('span');
      const pricing = view.modelPrice(entry, model.requestAllowance?.basicActive);
      chip.textContent = [entry.name || entry.id, pricing].filter(Boolean).join(' · ');
      chip.title = [entry.id, entry.provider, pricing].filter(Boolean).join(' · ');
      el('account-models').appendChild(chip);
    }
    el('account-use').disabled = busy || !model.usable;
    for (const [id, key] of [['included', 'includedRemaining'], ['prepaid', 'prepaidRemaining'], ['reserved', 'reserved'], ['total', 'totalRemaining']]) el('allowance-' + id).textContent = model.counts[key];
    for (const [id, label, hint] of model.requestMode ? [
      ['included', 'Included requests remaining', model.requestAllowance.basicActive ? 'Completed requests included with Basic' : 'No active Basic allowance'],
      ['prepaid', 'Completed included requests', 'Used in the current subscription period'],
      ['reserved', 'Requests in progress', 'Reserved until each request completes'],
      ['total', 'Overage per completed request', ''],
    ] : [
      ['included', 'Included remaining', 'AI usage tokens'], ['prepaid', 'Prepaid remaining', 'From confirmed RCH redemptions'],
      ['reserved', 'Reserved by requests', 'Pending usage settlement'], ['total', 'Available to use', ''],
    ]) {
      const card = el('allowance-' + id).parentElement;
      if (card?.querySelector('p')) card.querySelector('p').textContent = label;
      if (id !== 'total' && card?.querySelector('span')) card.querySelector('span').textContent = hint;
    }
    el('usd-credit').hidden = !model.usdCredit;
    if (model.usdCredit) {
      el('usd-credit-available').textContent = model.usdCredit.available;
      el('usd-credit-reserved').textContent = model.usdCredit.reserved;
      el('usd-credit-detail').textContent = model.usdCredit.debt !== 'US$0.00'
        ? model.usdCredit.debt + ' awaiting settlement' : model.requestMode
          ? model.requestAllowance.overagePrice + ' per completed request after any included Basic allowance.' : 'Spent at the selected model’s published usage price.';
    }
    el('allowance-debt').textContent = model.requestMode ? model.requestAllowance.basicActive
      ? 'Charged after the included Basic requests are used.' : 'Funded from your available US dollar credit.'
      : state.account?.allowance?.debt && state.account.allowance.debt !== '0'
      ? view.format(state.account.allowance.debt) + ' tokens awaiting reconciliation' : 'Shared across supplied models';
    el('redemption-badge').textContent = model.canRedeem ? 'AVAILABLE' : 'UNAVAILABLE';
    const treasuryMode = state.config?.redemptionMode === 'treasury';
    el('redemption-description').textContent = treasuryMode
      ? 'Redeemed RCH goes to the REACH treasury. Your account receives the quoted US dollar credit after confirmation.'
      : 'After confirmation, the service adds prepaid AI usage credit to your account. Review the redemption terms before signing.';
    el('redemption-rate').textContent = state.config?.redemptionEnabled === true
      ? treasuryMode ? 'Review your RCH amount, verified market quote, US dollar credit, and treasury destination in your browser.'
        : 'Review the service conversion rate and network before approving in your wallet.'
      : state.config?.pricingMessage || 'RCH redemption is unavailable until the service can provide a verified market quote.';
    el('redemption-amount').disabled = busy || !model.canRedeem;
    el('redemption-start').disabled = busy || !model.canRedeem || !el('redemption-amount').value.trim();
    if (!model.canRedeem || el('redemption-status').dataset.unavailable === 'true') el('redemption-status').textContent = model.redemptionMessage;
    el('redemption-status').dataset.unavailable = String(!model.canRedeem);
  }
  async function action(fn) {
    if (busy) return;
    busy = true; render(state);
    try {
      const result = await fn();
      if (result?.state) state = result.state;
      if (result?.ok === false) throw new Error(result.err || 'The account action could not be completed.');
      return result;
    } catch (error) { state = { ...state, error: error.message }; }
    finally { busy = false; render(state); }
  }
  async function refresh() {
    if (refreshing || busy || state.status === 'connecting') return;
    refreshing = true;
    try { const result = await api.refresh(); render(result.state || state); if (!result.ok) el('account-status').textContent = result.err; }
    catch { el('account-status').textContent = 'Could not refresh your account. Check your connection.'; }
    finally { refreshing = false; }
  }
  el('account-service').addEventListener('input', () => { serviceDirty = true; });
  el('account-configure').addEventListener('click', () => { const url = el('account-service').value; void action(async () => {
    const result = await api.configure(url); if (result?.ok !== false) serviceDirty = false; return result;
  }); });
  el('account-connect').addEventListener('click', () => action(() => api.connect()));
  el('account-cancel').addEventListener('click', async () => { const result = await api.cancel(); render(result.state); });
  el('account-refresh').addEventListener('click', refresh);
  el('account-disconnect').addEventListener('click', () => action(() => api.disconnect()));
  el('account-use').addEventListener('click', () => action(async () => {
    const result = await window.reach.connections.save({ action: 'activate', id: state.connectionId });
    if (result.ok) {
      if (typeof loadSettings === 'function') await loadSettings();
      await window.ReachHome?.sync();
      const picker = el('connection');
      if (picker) { picker.value = state.connectionId; picker.dispatchEvent(new Event('change')); }
      state = { ...state, error: '' };
    }
    return result;
  }));
  el('redemption-amount').addEventListener('input', () => render(state));
  el('redemption-start').addEventListener('click', () => action(async () => {
    const result = await api.redeem(el('redemption-amount').value.trim());
    if (result.ok) el('redemption-status').textContent = 'Review the redemption in your browser wallet. Refresh your account after the transaction confirms.';
    else el('redemption-status').textContent = result.err;
    return result;
  }));
  api.onState(next => { render(next); void window.ReachHome?.sync(); });
  window.addEventListener('focus', () => { if (state.baseUrl) void refresh(); });
  const timer = setInterval(() => { if (state.status === 'connected' && document.visibilityState !== 'hidden') void refresh(); }, 30000);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  void api.get().then(next => { render(next); if (next.baseUrl) void refresh(); }).catch(() => render({ status: 'unconfigured', error: 'Account services are unavailable.' }));
})();
