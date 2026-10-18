/* Account sessions stay in this tab. Provider credentials never enter this site. */
(() => {
  'use strict';
  const ORIGIN = 'https://unbent-semicolon-hermit.ngrok-free.dev';
  const SESSION = 'signalreach.account.session';
  const PENDING = 'signalreach.account.pending';
  const $ = selector => document.querySelector(selector);
  const message = text => { const node = $('#account-status'); if (node) node.textContent = text; };
  const read = key => { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } };
  const clearSession = () => sessionStorage.removeItem(SESSION);
  const access = result => result.access || result.account?.access || result.data?.access || {};
  const accountDestination = result => access(result).website === true ? 'profile.html#info' : 'login.html?restricted=1';
  let signIn = null, signInBusy = false;
  function walletDestination(value) {
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.pathname !== '/wallet/connect' || url.username || url.password) throw new Error('The account service returned an unexpected destination.');
    return url;
  }
  async function startCheckout() {
    const token = read(SESSION)?.accessToken;
    if (!token) { location.assign('login.html?subscribe=1'); return; }
    const button = $('#subscription-checkout');
    button.disabled = true;
    message('Preparing your account-linked Stripe checkout...');
    try {
      const result = await request('/v1/billing/checkout', {kind: 'subscription', planId: 'plus'}, token);
      const url = new URL(result.url);
      // Matches the service Stripe adapter's CHECKOUT_ORIGIN; never accept arbitrary redirects.
      if (url.origin !== 'https://checkout.stripe.com' || url.username || url.password) throw new Error('The billing service returned an unexpected checkout destination.');
      location.assign(url.href);
    } catch (error) { message(error.message); button.disabled = false; }
  }
  function showOnboarding() {
    $('#account-onboarding').hidden = false;
    $('#account-signin').hidden = !!read(SESSION)?.accessToken;
    message('Profile access requires an active subscription or a verified wallet. Email verification alone does not unlock your profile.');
  }
  async function linkWallet() {
    if (!read(SESSION)?.accessToken) { await startLogin(); return; }
    const button = $('#account-link-wallet'); button.disabled = true;
    try {
      const result = await request('/v1/account/link-wallet', {}, read(SESSION)?.accessToken);
      // A bound-account flow does not exchange PKCE proof or replace this tab's session.
      await prepareSignIn(result, true);
    } catch (error) { message(error.message); button.disabled = false; }
  }
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
  async function request(path, body, token) {
    const response = await fetch(ORIGIN + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'ngrok-skip-browser-warning': 'true', ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...(token ? {Authorization: `Bearer ${token}`} : {}) },
      ...(body === undefined ? {} : {body: JSON.stringify(body)})
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('The account service did not return a valid response. Please retry.'); }
    if (!response.ok) {
      if (response.status === 401 && token) { clearSession(); location.replace('login.html?expired=1'); }
      const error = new Error(data.error?.message || data.message || 'The account service could not complete this request.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function updateNavigation() {
    if (!read(SESSION)?.accessToken) return;
    document.querySelectorAll('.nav-actions a[href="login.html"]').forEach(link => { link.href = 'profile.html'; link.textContent = 'Profile'; });
  }
  async function prepareSignIn(result, linking = false) {
    const url = walletDestination(result.loginUrl);
    const flowId = new URLSearchParams(url.hash.slice(1)).get('flow');
    if (!/^[a-f0-9]{64}$/.test(flowId || '') || (result.flowId && flowId !== result.flowId)) throw new Error('The account service returned an invalid sign-in flow.');
    const config = await request('/v1/account/config');
    if (!Number.isSafeInteger(config.chainId) || config.chainId < 1) throw new Error('The account service returned an invalid wallet network.');
    signIn = {flowId, chainId: config.chainId, linking, challenge: null, address: null, verified: false};
    $('#account-login-options').hidden = false;
    $('#account-email-form').hidden = linking || config.emailLogin !== true;
    $('#account-code-step').hidden = true;
    $('#account-wallet-message').hidden = true;
    $('#account-wallet-signin').textContent = 'Connect wallet';
    $('#account-email-send').textContent = 'Email me a code';
    $('#account-code').value = '';
    $('#account-signin').hidden = true;
    message(linking ? 'Connect and sign with the wallet to add it to your existing account.' : 'Choose email or connect your wallet. Sign-in stays on this site.');
  }
  async function finishSignIn(current) {
    if (current !== signIn) return;
    if (current.linking) {
      const account = await request('/v1/account', undefined, read(SESSION)?.accessToken);
      location.replace(accountDestination(account));
      return;
    }
    const pending = read(PENDING);
    if (!pending || pending.flowId !== current.flowId || Date.now() - pending.startedAt > 600000 || Date.parse(pending.expiresAt) <= Date.now()) {
      const error = new Error('This sign-in expired. Start a new sign-in.');
      error.status = 410; throw error;
    }
    if (!current.accessToken) {
      const result = await request('/v1/auth/exchange', {flowId: pending.flowId, state: pending.state, codeVerifier: pending.codeVerifier});
      if (!result.accessToken) throw new Error('Sign-in is still pending. Please try again.');
      current.accessToken = result.accessToken;
    }
    sessionStorage.setItem(SESSION, JSON.stringify({accessToken: current.accessToken}));
    const account = await request('/v1/account', undefined, current.accessToken);
    sessionStorage.removeItem(PENDING);
    location.replace(pending.subscribe ? 'subscription.html' : accountDestination(account));
  }
  const signInAction = action => async event => {
    event?.preventDefault();
    if (signInBusy || !signIn) return;
    signInBusy = true;
    const current = signIn;
    const controls = ['#account-wallet-signin', '#account-email-send', '#account-code-verify'];
    controls.forEach(id => { $(id).disabled = true; });
    try {
      if (current.verified) await finishSignIn(current);
      else await action(current);
    } catch (error) {
      if (error.status === 410) {
        signIn = null; sessionStorage.removeItem(PENDING);
        $('#account-login-options').hidden = true; $('#account-signin').hidden = !!read(SESSION)?.accessToken;
        $('#account-signin').disabled = false;
        $('#account-link-wallet').disabled = false;
      }
      message(error.code === 4001 ? 'Wallet request cancelled. You can try again or use email.' : error.message || 'Sign-in could not be completed. Please retry.');
    } finally {
      signInBusy = false;
      controls.forEach(id => { $(id).disabled = false; });
    }
  };
  async function walletSignIn(current) {
    if (!window.ethereum?.request) throw new Error('Use a browser with an Ethereum wallet extension, or sign in with email.');
    const chainId = '0x' + current.chainId.toString(16);
    if ((await window.ethereum.request({method: 'eth_chainId'})).toLowerCase() !== chainId) await window.ethereum.request({method: 'wallet_switchEthereumChain', params: [{chainId}]});
    const accounts = await window.ethereum.request({method: 'eth_requestAccounts'});
    const address = accounts?.[0];
    if (!/^0x[0-9a-f]{40}$/i.test(address || '')) throw new Error('Choose an Ethereum wallet account.');
    if (!current.challenge || current.address.toLowerCase() !== address.toLowerCase()) {
      const challenge = await request('/v1/auth/challenge', {flowId: current.flowId, address});
      // The server binds the message to this allowlisted website origin. Do not
      // ask a wallet to sign a message naming the tunnel or another website.
      const site = new URL(location.href);
      const lines = typeof challenge.message === 'string' ? challenge.message.split('\n') : [];
      if (lines[0] !== site.host + ' wants you to sign in with your Ethereum account:' || lines[1]?.toLowerCase() !== address.toLowerCase() || !lines.includes('URI: ' + site.origin + '/login.html') || !lines.includes('Chain ID: ' + current.chainId)) throw new Error('The account service must be updated to support wallet sign-in on this site. You can still use email.');
      current.challenge = challenge; current.address = address;
      $('#account-wallet-message').textContent = challenge.message;
      $('#account-wallet-message').hidden = false;
      $('#account-wallet-signin').textContent = 'Sign in with wallet';
      message('Review the sign-in message, then choose Sign in with wallet. This does not approve a payment.');
      return;
    }
    const encoded = '0x' + Array.from(new TextEncoder().encode(current.challenge.message), byte => byte.toString(16).padStart(2, '0')).join('');
    const signature = await window.ethereum.request({method: 'personal_sign', params: [encoded, address]});
    await request('/v1/auth/verify', {flowId: current.flowId, challengeId: current.challenge.challengeId, signature});
    current.verified = true;
    await finishSignIn(current);
  }
  async function sendEmail(current) {
    const email = $('#account-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter your email address.');
    const result = await request('/v1/auth/email/start', {flowId: current.flowId, email});
    if (!result.challengeId) throw new Error('The account service did not return an email challenge. Please retry.');
    current.emailChallengeId = result.challengeId;
    $('#account-code-step').hidden = false;
    $('#account-email-send').textContent = 'Send a new code';
    message('Check your email for an 8-digit code. It expires in 10 minutes.');
  }
  async function verifyEmail(current) {
    const code = $('#account-code').value.replace(/\s/g, '');
    if (!current.emailChallengeId) throw new Error('Request an email code first.');
    if (!/^(?:\d{6}|\d{8})$/.test(code)) throw new Error('Enter the code from your email.');
    await request('/v1/auth/email/verify', {flowId: current.flowId, challengeId: current.emailChallengeId, code});
    current.verified = true;
    await finishSignIn(current);
  }
  async function startLogin() {
    const button = $('#account-signin');
    if (button.disabled) return;
    button.disabled = true;
    message('Preparing a secure sign-in...');
    try {
      const state = random(), codeVerifier = random();
      const codeChallenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))));
      const result = await request('/v1/auth/start', {state, codeChallenge});
      if (!result.flowId || !result.loginUrl) throw new Error('The sign-in service returned an incomplete flow. Please retry.');
      walletDestination(result.loginUrl);
      await prepareSignIn(result);
      sessionStorage.setItem(PENDING, JSON.stringify({flowId: result.flowId, state, codeVerifier, expiresAt: result.expiresAt, subscribe: new URLSearchParams(location.search).has('subscribe'), startedAt: Date.now()}));
    } catch (error) {
      signIn = null; sessionStorage.removeItem(PENDING);
      $('#account-login-options').hidden = true; button.hidden = false;
      message(error.message); button.disabled = false;
    }
  }
  async function login() {
    $('#account-signin')?.addEventListener('click', startLogin);
    $('#account-link-wallet')?.addEventListener('click', linkWallet);
    $('#account-check-access')?.addEventListener('click', () => location.reload());
    $('#account-wallet-signin')?.addEventListener('click', signInAction(walletSignIn));
    $('#account-email-form')?.addEventListener('submit', signInAction(sendEmail));
    $('#account-code-form')?.addEventListener('submit', signInAction(verifyEmail));
    if (new URLSearchParams(location.search).has('restricted')) showOnboarding();
    const returning = new URLSearchParams(location.search).get('signed') === '1';
    if (returning) {
      history.replaceState(null, '', location.pathname);
      const pending = read(PENDING);
      if (!pending || Date.now() - pending.startedAt > 600000 || (pending.expiresAt && Date.parse(pending.expiresAt) <= Date.now())) {
        sessionStorage.removeItem(PENDING);
        message('This sign-in has expired or belongs to another tab. Please sign in again.');
        return;
      }
      $('#account-signin').disabled = true;
      message('Checking your approved sign-in...');
      try {
        const result = await request('/v1/auth/exchange', {flowId: pending.flowId, state: pending.state, codeVerifier: pending.codeVerifier});
        if (!result.accessToken) throw new Error('Sign-in has not been approved. Please retry and complete the wallet signature or email code.');
        sessionStorage.setItem(SESSION, JSON.stringify({accessToken: result.accessToken}));
        sessionStorage.removeItem(PENDING);
        const account = await request('/v1/account', undefined, result.accessToken);
        location.replace(pending.subscribe ? 'subscription.html' : accountDestination(account));
      } catch (error) {
        clearSession(); sessionStorage.removeItem(PENDING);
        message(`${error.message} Please start a fresh sign-in.`);
        $('#account-signin').disabled = false;
      }
    } else if (read(SESSION)?.accessToken) {
      try {
        const account = await request('/v1/account', undefined, read(SESSION).accessToken);
        if (new URLSearchParams(location.search).has('subscribe')) location.replace('subscription.html');
        else if (access(account).website === true) location.replace('profile.html#info');
        else showOnboarding();
      }
      catch (error) { message(error.message); }
    } else if (new URLSearchParams(location.search).has('expired')) message('Your session has expired. Please sign in again.');
  }
  const text = (id, value) => { const node = $(id); if (node) node.textContent = value == null || value === '' ? 'Not available' : String(value); };
  const date = value => { const parsed = new Date(value); return value && !Number.isNaN(+parsed) ? parsed.toLocaleString() : 'Not available'; };
  async function profile() {
    const token = read(SESSION)?.accessToken;
    if (!token) { location.replace('login.html'); return; }
    let secret = '', canCreate = false;
    const clearSecret = () => { secret = ''; text('#new-key-value', ''); $('#new-key').hidden = true; };
    function route() {
      const api = location.hash === '#api';
      $('#profile-info').hidden = api; $('#profile-api').hidden = !api;
      document.querySelectorAll('[data-profile-nav]').forEach(link => {
        if (link.hash === (api ? '#api' : '#info')) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      });
      if (!api) clearSecret();
    }
    window.addEventListener('hashchange', route); route();
    window.addEventListener('pagehide', clearSecret);
    $('#account-retry').addEventListener('click', () => location.reload());
    $('#account-signout').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try { await request('/v1/auth/logout', {}, token); clearSession(); sessionStorage.removeItem(PENDING); clearSecret(); location.replace('login.html'); }
      catch (error) { message(`Sign-out failed: ${error.message}`); event.currentTarget.disabled = false; }
    });
    async function loadKeys() {
      const result = await request('/v1/account/api-keys', undefined, token);
      if (!Array.isArray(result.data)) throw new Error('The account service returned an invalid key list.');
      const list = $('#api-key-list'); list.replaceChildren();
      if (!result.data.length) { const empty = document.createElement('p'); empty.textContent = 'No REACH API keys yet. Create one for your application.'; list.append(empty); }
      result.data.forEach(key => {
        const row = document.createElement('article'); row.className = 'account-key-row';
        const details = document.createElement('div');
        const name = document.createElement('strong'); name.textContent = key.name || 'Unnamed key';
        const prefix = document.createElement('code'); prefix.textContent = key.prefix ? `${key.prefix}...` : 'Prefix unavailable';
        const meta = document.createElement('small'); meta.textContent = `Created ${date(key.createdAt)}${key.expiresAt ? ` / Expires ${date(key.expiresAt)}` : ''}${key.revokedAt ? ' / Revoked' : ''}`;
        details.append(name, prefix, meta); row.append(details);
        if (!key.revokedAt) {
          const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'btn btn-secondary btn-sm'; revoke.textContent = 'Revoke';
          revoke.addEventListener('click', async () => {
            if (!window.confirm(`Revoke ${key.name || 'this key'}? Applications using it will lose access.`)) return;
            revoke.disabled = true;
            try { await request('/v1/account/api-keys/revoke', {id: key.id}, token); clearSecret(); await loadKeys(); message('API key revoked.'); }
            catch (error) { message(error.message); revoke.disabled = false; }
          }); row.append(revoke);
        }
        list.append(row);
      });
    }
    $('#api-key-form').addEventListener('submit', async event => {
      event.preventDefault(); const button = $('#create-api-key'); button.disabled = true; clearSecret();
      try {
        const account = await request('/v1/account', undefined, token);
        if (access(account).website !== true) { location.replace('login.html?restricted=1'); return; }
        canCreate = access(account).apiKeyCreation === true;
        $('#api-key-form').hidden = !canCreate; $('#api-access-notice').hidden = canCreate;
        if (!canCreate) throw new Error('API key creation requires an active subscription or remaining redeemed RCH credits. Holding RCH in a wallet is not enough.');
        const result = await request('/v1/account/api-keys', {name: $('#api-key-name').value.trim()}, token);
        const payload = result.data || result;
        secret = typeof payload.key === 'string' ? payload.key : payload.key?.key;
        if (!secret) throw new Error('No key secret was returned. Refresh the list before retrying.');
        text('#new-key-value', secret); $('#new-key').hidden = false; $('#api-key-name').value = '';
        message('Key created. Copy it now; it will not be shown again.');
        await loadKeys();
      } catch (error) { message(error.message); }
      finally { button.disabled = !canCreate; }
    });
    $('#copy-api-key').addEventListener('click', async () => {
      try { if (secret) { await navigator.clipboard.writeText(secret); message('API key copied. Store it securely.'); } }
      catch { message('Clipboard access is unavailable. Select the key and copy it manually.'); }
    });
    $('#dismiss-api-key').addEventListener('click', clearSecret);
    try {
      const result = await request('/v1/account', undefined, token);
      if (access(result).website !== true) { location.replace('login.html?restricted=1'); return; }
      const account = result.account || result.data || result;
      canCreate = access(result).apiKeyCreation === true;
      text('#account-id', account.id || account.accountId);
      text('#account-email', account.email);
      text('#account-wallet', account.walletAddress);
      text('#account-created', date(account.createdAt));
      $('#profile-details').hidden = false; $('#api-key-form').hidden = !canCreate;
      $('#create-api-key').disabled = !canCreate; $('#api-access-notice').hidden = canCreate;
      message('Your REACH account is connected.');
      await loadKeys();
    } catch (error) { message(error.message); $('#account-retry').hidden = false; }
  }
  updateNavigation();
  if (document.body.dataset.page === 'login') login().catch(error => message(error.message));
  if (document.body.dataset.page === 'profile') profile().catch(error => message(error.message));
  if (document.body.dataset.page === 'subscription') $('#subscription-checkout')?.addEventListener('click', startCheckout);
})();
