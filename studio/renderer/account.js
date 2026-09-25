'use strict';
(() => {
  const api = window.reach?.account, view = window.ReachAccountView;
  if (!api || !view || !document.getElementById('home-account-service')) return;
  const defaultServiceOrigin = 'https://unbent-semicolon-hermit.ngrok-free.dev';
  const el = id => document.getElementById('home-' + id);
  let state = {}, busy = false, refreshing = false;
  function render(next) {
    state = next || {}; const model = view.derive(state);
    el('account-badge').textContent = model.badge;
    if (document.activeElement !== el('account-service')) el('account-service').value = state.baseUrl || defaultServiceOrigin;
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
    el('account-plan').textContent = model.plan;
    el('account-plan-status').textContent = String(state.account?.plan?.status || '—').toUpperCase();
    const expiry = Date.parse(state.account?.plan?.expiresAt);
    el('account-plan-detail').textContent = model.connected
      ? (Number.isFinite(expiry) ? 'Current period ends ' + new Date(expiry).toLocaleString() + '. ' : '') +
        (model.usable ? 'All models below use the same account allowance.' : 'A service administrator must enable a plan and model access for this account.')
      : 'Connect your wallet to load your plan and permitted models.';
    el('account-models').replaceChildren();
    for (const entry of state.account?.allowedModels || []) {
      const chip = document.createElement('span'); chip.textContent = entry.name || entry.id; chip.title = [entry.id, entry.provider].filter(Boolean).join(' · ');
      el('account-models').appendChild(chip);
    }
    el('account-use').disabled = busy || !model.usable;
    for (const [id, key] of [['included', 'includedRemaining'], ['prepaid', 'prepaidRemaining'], ['reserved', 'reserved'], ['total', 'totalRemaining']]) el('allowance-' + id).textContent = model.counts[key];
    el('allowance-debt').textContent = state.account?.allowance?.debt && state.account.allowance.debt !== '0'
      ? view.format(state.account.allowance.debt) + ' tokens awaiting reconciliation' : 'Shared across supplied models';
    el('redemption-badge').textContent = model.canRedeem ? 'AVAILABLE' : 'UNAVAILABLE';
    el('redemption-rate').textContent = state.config?.tokensPerRch && state.config.tokensPerRch !== '0'
      ? '1 RCH = ' + view.format(state.config.tokensPerRch) + ' AI usage tokens. Network chain ID: ' + state.config.chainId + '.'
      : 'The hosted service supplies the confirmed conversion rate and network.';
    el('redemption-amount').disabled = busy || !model.canRedeem;
    el('redemption-start').disabled = busy || !model.canRedeem || !el('redemption-amount').value.trim();
    if (!model.canRedeem) el('redemption-status').textContent = model.connected ? 'RCH redemption is not enabled on this service.' : 'Connect your wallet to check whether redemption is enabled.';
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
  el('account-configure').addEventListener('click', () => { const url = el('account-service').value; void action(() => api.configure(url)); });
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
