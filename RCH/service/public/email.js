'use strict';
// Email sign-in on the same page as wallet sign-in. It completes the same
// PKCE flow, so Studio and VS Code finish exactly as they do for a wallet.
(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.hash.slice(1));
  const flowId = params.get('flow');
  const RETURN_ORIGINS = new Set(['http://127.0.0.1:4173','http://localhost:4173','https://signalreach.com','https://www.signalreach.com','https://signalreach.ca','https://www.signalreach.ca','https://falabellamichael.github.io']);
  function returnToCaller() {
    let url;
    try { url = new URL(params.get('return') || ''); } catch { url = null; }
    if (!url || !RETURN_ORIGINS.has(url.origin) || !url.pathname.endsWith('/login.html')) return;
    url.searchParams.set('signed', '1');
    url.hash = '';
    location.assign(url.href);
  }
  if (location.pathname !== '/wallet/connect' || !flowId) return;
  let challengeId = null, busy = false;
  const status = message => { $('email-status').textContent = message; };
  async function api(path, body) {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error',
      headers: { 'ngrok-skip-browser-warning': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'REACH could not complete this request.');
    return data;
  }
  const run = action => async () => {
    if (busy) return;
    busy = true; $('email-send').disabled = true; $('email-verify').disabled = true;
    try { await action(); }
    catch (error) { status(error.message || 'REACH could not complete this request.'); }
    finally { busy = false; $('email-send').disabled = false; $('email-verify').disabled = false; }
  };
  $('email-send').addEventListener('click', run(async () => {
    const email = $('email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter your email address.');
    challengeId = (await api('/v1/auth/email/start', { flowId, email })).challengeId;
    $('email-code-step').hidden = false; $('email-send').textContent = 'Send a new code';
    status('We sent an 8-digit code to ' + email + '. It expires in 10 minutes.');
  }));
  $('email-verify').addEventListener('click', run(async () => {
    const code = $('email-code').value.replace(/\s/g, '');
    if (!challengeId) throw new Error('Request a code first.');
    if (!/^(?:\d{6}|\d{8})$/.test(code)) throw new Error('Enter the 8-digit code from the email.');
    await api('/v1/auth/email/verify', { flowId, challengeId, code });
    status('Email verified. Return to REACH Studio to finish connecting.');
    $('email-code-step').hidden = true; $('email-send').hidden = true; $('primary').hidden = true;
    let finished = false;
    try { if (typeof globalThis.reachFinishLogin === 'function') finished = await globalThis.reachFinishLogin(); } catch { finished = false; }
    if (!finished) returnToCaller();
  }));
  api('/v1/account/config').then(config => { if (config.emailLogin === true) $('email-login').hidden = false; }).catch(() => {});
})();
