'use strict';
(() => {
  const el = id => document.getElementById(id);
  const menu = el('account-menu'), button = el('account-menu-button');
  if (!menu || !button) return;
  const settings = el('page-settings');
  const tabs = [...menu.querySelectorAll('[data-account-panel]')];
  let selected = 'account';

  // Move the original forms once. IDs, listeners, unsaved values, and account
  // subscriptions retain their identity when the dropdown is hidden/reopened.
  const account = el('home-subscription-title')?.closest('.home-section');
  const funding = el('home-topup-title')?.closest('.home-section');
  if (account) el('account-menu-panel-account').append(account);
  if (funding) el('account-menu-panel-usage').append(funding);
  if (settings) {
    settings.classList.remove('page', 'active');
    settings.classList.add('account-settings');
    el('account-menu-panel-settings').append(settings);
  }

  function position() {
    const edge = button.getBoundingClientRect();
    menu.style.top = Math.min(edge.bottom + 9, window.innerHeight - 120) + 'px';
    menu.style.maxHeight = Math.max(100, window.innerHeight - edge.bottom - 21) + 'px';
  }
  function activate(section) {
    selected = tabs.some(tab => tab.dataset.accountPanel === section) ? section : 'account';
    menu.dataset.panel = selected;
    for (const tab of tabs) {
      const active = tab.dataset.accountPanel === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      el(tab.getAttribute('aria-controls')).hidden = !active;
    }
    settings?.classList.toggle('active', !menu.hidden && selected === 'settings');
  }
  function open(section = selected, { focus = false } = {}) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    activate(section);
    position();
    if (focus || !menu.contains(document.activeElement)) el('account-menu-tab-' + selected).focus();
  }
  function close({ returnFocus = true } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    settings?.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  }
  async function select(section) {
    open(section);
    if (section === 'settings') {
      const panel = document.querySelector('.settings-nav button.active')?.dataset.settingsPanel || 'connection';
      await openSettingsPanel(panel);
    }
  }
  function update(state, model) {
    const wallet = model.connected ? state.account?.walletAddress : '';
    el('account-menu-title').textContent = wallet ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : 'Welcome to REACH';
    el('account-menu-summary').textContent = model.connected
      ? model.plan + ' · ' + model.counts.totalRemaining + ' usage tokens available'
      : model.connecting ? 'Waiting for wallet sign-in' : 'Sign in to see your shared usage.';
    el('account-menu-dot').dataset.state = model.connected ? 'connected' : model.connecting ? 'connecting' : 'disconnected';
    el('account-menu-avatar').textContent = wallet ? wallet.slice(2, 4).toUpperCase() : 'R';
    button.setAttribute('aria-label', model.connected ? 'Open REACH account ' + wallet + ', usage and settings' : 'Open account, sign in and settings');
  }
  button.addEventListener('click', () => { if (menu.hidden) { open(selected, { focus: true }); if (selected === 'settings') void select('settings').catch(error => showNotice(error.message)); } else close(); });
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault(); open(selected, { focus: true });
      if (selected === 'settings') void select('settings').catch(error => showNotice(error.message));
    }
  });
  el('account-menu-close').addEventListener('click', () => close());
  for (const tab of tabs) {
    tab.addEventListener('click', () => { void select(tab.dataset.accountPanel).catch(error => showNotice(error.message)); });
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].focus();
      void select(tabs[index].dataset.accountPanel).catch(error => showNotice(error.message));
    });
  }
  function inModelPicker(target) {
    const picker = el('model-modal');
    return picker && !picker.classList.contains('hidden') && picker.contains(target);
  }
  document.addEventListener('pointerdown', event => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target) && !inModelPicker(event.target)) close({ returnFocus: false });
  });
  document.addEventListener('focusin', event => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target) && !inModelPicker(event.target)) close({ returnFocus: false });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden && !event.defaultPrevented) {
      event.preventDefault();
      if (!el('model-modal')?.classList.contains('hidden')) el('btn-model-cancel').click();
      else close();
    }
  });
  window.addEventListener('resize', () => { if (!menu.hidden) position(); });
  window.ReachAccountMenu = { open, close, update };
})();
