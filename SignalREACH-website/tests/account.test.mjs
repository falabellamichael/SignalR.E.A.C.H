import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source = readFileSync(new URL('../assets/account.js', import.meta.url), 'utf8');
const pendingKey = 'signalreach.account.pending';
const sessionKey = 'signalreach.account.session';
const origin = 'https://unbent-semicolon-hermit.ngrok-free.dev';
const flowId = 'a'.repeat(64);
const started = () => ({body: {flowId, expiresAt: new Date(Date.now() + 600000).toISOString(), loginUrl: `${origin}/wallet/connect#flow=${flowId}`}});
const configured = () => ({body: {chainId: 1, emailLogin: true}});
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
function harness({search = '', hash = '', stored = {}, responses = [], page = 'login', ethereum} = {}) {
  const storage = new Map(Object.entries(stored));
  const calls = [], redirects = [], handlers = {};
  const nodes = new Map(['#account-signin', '#account-status', '#account-onboarding', '#account-link-wallet', '#account-check-access', '#subscription-checkout', '#account-retry', '#account-signout', '#profile-info', '#profile-api', '#profile-details', '#api-key-form', '#create-api-key', '#api-access-notice', '#new-key', '#new-key-value', '#copy-api-key', '#dismiss-api-key', '#api-key-list', '#account-id', '#account-email', '#account-wallet', '#account-created', '#api-key-name'].map(id => [id, {disabled: false, hidden: true, value: '', replaceChildren() {}, append() {}, textContent: '', addEventListener: (event, fn) => { handlers[id + event] = fn; }}]));
  for (const id of ['#account-login-options', '#account-email-form', '#account-code-step', '#account-code-form', '#account-email', '#account-code', '#account-wallet-message', '#account-wallet-signin', '#account-email-send', '#account-code-verify']) nodes.set(id, {disabled: false, hidden: true, value: '', textContent: '', addEventListener: (event, fn) => { handlers[id + event] = fn; }});
  const context = {
    document: {body: {dataset: {page}}, createElement: () => ({append() {}}), querySelector: id => nodes.get(id), querySelectorAll: () => []},
    window: {addEventListener() {}, ethereum},
    sessionStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    location: {href: `http://127.0.0.1:4173/login.html${search}${hash}`, pathname: '/login.html', search, hash, assign: url => redirects.push(url), replace: url => redirects.push(url)},
    history: {replaceState() {}}, crypto: webcrypto, TextEncoder, Uint8Array, URL, URLSearchParams,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: async (url, options) => { calls.push({url, ...options}); const next = responses.shift(); if (!next) throw new Error('Unexpected request'); if (next.gate) await next.gate; if (next.error) throw next.error; return {ok: !next.status || next.status >= 200 && next.status < 300, status: next.status || 200, json: async () => next.body}; }
  };
  vm.runInNewContext(source, context);
  return {storage, calls, redirects, nodes, click: id => handlers[id + 'click'](), submit: (id = '#api-key-form') => handlers[id + 'submit']({preventDefault() {}}), start: () => handlers['#account-signinclick']()};
}
test('fresh PKCE flow stays on the website and every account request skips the ngrok warning', async () => {
  const h = harness({responses: [started(), configured()]});
  await h.start();
  const body = JSON.parse(h.calls[0].body), pending = JSON.parse(h.storage.get(pendingKey));
  assert.equal(h.calls[0].url, `${origin}/v1/auth/start`);
  assert.match(body.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(body.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.state, pending.state);
  assert.equal(Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.codeVerifier))).toString('base64url'), body.codeChallenge);
  assert.equal(pending.flowId, flowId);
  assert.deepEqual(h.redirects, []);
  assert.equal(h.nodes.get('#account-login-options').hidden, false);
  assert.equal(h.nodes.get('#account-email-form').hidden, false);
  for (const call of h.calls) {
    assert.equal(call.headers['ngrok-skip-browser-warning'], 'true');
    assert.equal(call.redirect, 'error');
    assert.equal(call.credentials, 'omit');
  }
  assert.equal(h.storage.has(sessionKey), false);
});
test('return exchanges tab proof, validates account, and redirects to Profile', async () => {
  const pending = {flowId: 'new-flow', state: 'state', codeVerifier: 'verifier', startedAt: Date.now()};
  const h = harness({search: '?signed=1', stored: {[pendingKey]: JSON.stringify(pending)}, responses: [{body: {accessToken: 'tab-session'}}, {body: {id: 'account', access: {website: true}}}]});
  await settle();
  assert.deepEqual(JSON.parse(h.calls[0].body), {flowId: 'new-flow', state: 'state', codeVerifier: 'verifier'});
  assert.equal(h.calls[1].headers.Authorization, 'Bearer tab-session');
  assert.equal(h.calls[1].url, `${origin}/v1/account`);
  assert.equal(h.storage.has(pendingKey), false);
  assert.equal(JSON.parse(h.storage.get(sessionKey)).accessToken, 'tab-session');
  assert.deepEqual(h.redirects, ['profile.html#info']);
});
test('expired or missing return proof offers fresh sign-in without exchanging', async () => {
  for (const stored of [{}, {[pendingKey]: JSON.stringify({startedAt: Date.now() - 700000})}]) {
    const h = harness({search: '?signed=1', stored}); await settle();
    assert.equal(h.calls.length, 0); assert.match(h.nodes.get('#account-status').textContent, /expired/);
    assert.equal(h.nodes.get('#account-signin').disabled, false);
  }
});
test('pending and failed exchanges never create a fake session', async () => {
  for (const response of [{body: {status: 'pending'}}, {status: 410, body: {error: {message: 'Expired'}}}]) {
    const h = harness({search: '?signed=1', stored: {[pendingKey]: JSON.stringify({flowId: 'flow', state: 'state', codeVerifier: 'proof', startedAt: Date.now()})}, responses: [response]});
    await settle(); assert.equal(h.storage.has(sessionKey), false); assert.equal(h.storage.has(pendingKey), false);
    assert.match(h.nodes.get('#account-status').textContent, /fresh sign-in/); assert.deepEqual(h.redirects, []);
  }
});
test('handoff rejects a service response pointing to another origin', async () => {
  const h = harness({responses: [{body: {flowId: 'flow', loginUrl: 'https://example.com/wallet/connect'}}]});
  await h.start(); assert.deepEqual(h.redirects, []); assert.equal(h.storage.has(pendingKey), false);
  assert.match(h.nodes.get('#account-status').textContent, /unexpected destination/);
});
test('email-only and missing access flags fail closed into onboarding', async () => {
  for (const account of [{id: 'email'}, {access: {website: false, apiKeyCreation: true}}, {walletAddress: '0x123', balance: '1000000'}]) {
    const h = harness({stored: {[sessionKey]: JSON.stringify({accessToken: 'session'})}, responses: [{body: account}]});
    await settle();
    assert.equal(h.nodes.get('#account-onboarding').hidden, false);
    assert.deepEqual(h.redirects, []);
    assert.match(h.nodes.get('#account-status').textContent, /active subscription or a verified wallet/);
  }
});
test('restricted account never loads profile details or keys', async () => {
  const h = harness({page: 'profile', stored: {[sessionKey]: JSON.stringify({accessToken: 'session'})}, responses: [{body: {access: {website: false}}}]});
  await settle();
  assert.deepEqual(h.redirects, ['login.html?restricted=1']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.nodes.get('#profile-details').hidden, true);
});
test('verified wallet profile can manage keys but cannot create without server eligibility', async () => {
  const h = harness({page: 'profile', stored: {[sessionKey]: JSON.stringify({accessToken: 'session'})}, responses: [{body: {access: {website: true, apiKeyCreation: false}}}, {body: {data: []}}, {body: {access: {website: true, apiKeyCreation: false}}}]});
  await settle();
  assert.equal(h.nodes.get('#profile-details').hidden, false);
  assert.equal(h.nodes.get('#api-key-form').hidden, true);
  assert.equal(h.nodes.get('#api-access-notice').hidden, false);
  await h.submit();
  assert.equal(h.calls.some(call => call.method === 'POST'), false);
});
test('eligible account creates a key only after refreshing server access', async () => {
  const h = harness({page: 'profile', stored: {[sessionKey]: JSON.stringify({accessToken: 'session'})}, responses: [{body: {access: {website: true, apiKeyCreation: true}}}, {body: {data: []}}, {body: {access: {website: true, apiKeyCreation: true}}}, {body: {key: 'rch_secret'}}, {body: {data: []}}]});
  await settle();
  assert.equal(h.nodes.get('#api-key-form').hidden, false);
  h.nodes.get('#api-key-name').value = 'App';
  await h.submit();
  assert.equal(h.calls[2].url, `${origin}/v1/account`);
  assert.equal(h.calls[3].method, 'POST');
  assert.equal(h.nodes.get('#new-key-value').textContent, 'rch_secret');
});
test('subscription checkout uses authenticated Plus endpoint and rejects untrusted destinations', async () => {
  for (const url of ['https://checkout.stripe.com/c/pay/cs_test', 'https://checkout.stripe.com.evil.test/pay', 'http://checkout.stripe.com/pay']) {
    const h = harness({page: 'subscription', stored: {[sessionKey]: JSON.stringify({accessToken: 'session'})}, responses: [{body: {url}}]});
    await h.click('#subscription-checkout');
    assert.equal(h.calls[0].url, `${origin}/v1/billing/checkout`);
    assert.equal(h.calls[0].headers.Authorization, 'Bearer session');
    assert.deepEqual(JSON.parse(h.calls[0].body), {kind: 'subscription', planId: 'plus'});
    assert.equal(h.redirects.length, url === 'https://checkout.stripe.com/c/pay/cs_test' ? 1 : 0);
  }
});
test('subscription checkout without session starts sign-in and bound wallet linking keeps session', async () => {
  const guest = harness({page: 'subscription'});
  await guest.click('#subscription-checkout');
  assert.deepEqual(guest.redirects, ['login.html?subscribe=1']);
  assert.equal(guest.calls.length, 0);
  const h = harness({stored: {[sessionKey]: JSON.stringify({accessToken: 'session'})}, responses: [{body: {access: {website: false}}}, {body: {loginUrl: `${origin}/wallet/connect#flow=${flowId}`}}, configured()]});
  await settle(); await h.click('#account-link-wallet');
  assert.equal(h.calls[1].url, `${origin}/v1/account/link-wallet`);
  assert.equal(JSON.parse(h.storage.get(sessionKey)).accessToken, 'session');
  assert.equal(h.storage.has(pendingKey), false);
  assert.deepEqual(h.redirects, []);
  assert.equal(h.nodes.get('#account-email-form').hidden, true);
});
test('email login verifies and exchanges proof with the warning header, then returns to subscription', async () => {
  const h = harness({search: '?subscribe=1', responses: [started(), configured(), {body: {challengeId: 'email-challenge'}}, {body: {verified: true}}, {body: {accessToken: 'email-session'}}, {body: {access: {website: true}}}]});
  await h.start();
  h.nodes.get('#account-email').value = 'reader@example.test';
  await h.submit('#account-email-form');
  assert.equal(h.nodes.get('#account-code-step').hidden, false);
  h.nodes.get('#account-code').value = '1234 5678';
  await h.submit('#account-code-form');
  assert.deepEqual(JSON.parse(h.calls[2].body), {flowId, email: 'reader@example.test'});
  assert.deepEqual(JSON.parse(h.calls[3].body), {flowId, challengeId: 'email-challenge', code: '12345678'});
  assert.equal(h.storage.has(pendingKey), false);
  assert.equal(JSON.parse(h.storage.get(sessionKey)).accessToken, 'email-session');
  assert.deepEqual(h.redirects, ['subscription.html']);
  assert.ok(h.calls.every(call => call.headers['ngrok-skip-browser-warning'] === 'true'));
});

test('invalid email code stays retryable, and duplicate submissions do not send another code', async () => {
  let release;
  const h = harness({responses: [started(), configured(), {body: {challengeId: 'email-challenge'}, gate: new Promise(resolve => { release = resolve; })}, {status: 400, body: {error: {message: 'Invalid code'}}}, {body: {verified: true}}, {body: {accessToken: 'email-session'}}, {body: {access: {website: false}}}]});
  await h.start(); h.nodes.get('#account-email').value = 'reader@example.test';
  const sending = h.submit('#account-email-form');
  await h.submit('#account-email-form');
  assert.equal(h.calls.length, 3);
  assert.equal(h.nodes.get('#account-code-verify').disabled, true);
  release(); await sending;
  h.nodes.get('#account-code').value = '12345678';
  await h.submit('#account-code-form');
  assert.match(h.nodes.get('#account-status').textContent, /Invalid code/);
  assert.equal(h.nodes.get('#account-code-verify').disabled, false);
  assert.equal(h.storage.has(sessionKey), false);
  await h.submit('#account-code-form');
  assert.deepEqual(h.redirects, ['login.html?restricted=1']);
});

test('approved sign-in retries a failed account read without reusing one-use proof or verifying again', async () => {
  const h = harness({responses: [started(), configured(), {body: {challengeId: 'email'}}, {body: {}}, {body: {accessToken: 'session'}}, {error: new Error('Connection lost')}, {body: {access: {website: true}}}]});
  await h.start(); h.nodes.get('#account-email').value = 'reader@example.test'; await h.submit('#account-email-form');
  h.nodes.get('#account-code').value = '12345678'; await h.submit('#account-code-form');
  assert.deepEqual(h.redirects, []);
  await h.submit('#account-code-form');
  assert.deepEqual(h.redirects, ['profile.html#info']);
  assert.equal(h.calls.filter(call => call.url.endsWith('/v1/auth/exchange')).length, 1);
  assert.equal(h.calls.filter(call => call.url.endsWith('/v1/auth/email/verify')).length, 1);
});

const address = '0x' + 'ab'.repeat(20);
function walletFixture() {
  const calls = [];
  return {calls, request: async request => {
    calls.push(request);
    if (request.method === 'eth_chainId') return '0x1';
    if (request.method === 'eth_requestAccounts') return [address];
    if (request.method === 'personal_sign') return '0x1234';
    throw new Error('Unexpected wallet method: ' + request.method);
  }};
}
const messageFor = site => `${new URL(site).host} wants you to sign in with your Ethereum account:\n${address}\n\nURI: ${site}/login.html\nVersion: 1\nChain ID: 1\nNonce: fixture`;

test('wallet reviews this website domain, signs only a login message, and exchanges without a tunnel navigation', async () => {
  const ethereum = walletFixture();
  const h = harness({ethereum, responses: [started(), configured(), {body: {challengeId: 'wallet-challenge', message: messageFor('http://127.0.0.1:4173')}}, {body: {}}, {body: {accessToken: 'wallet-session'}}, {body: {access: {website: true}}}]});
  await h.start(); await h.click('#account-wallet-signin');
  assert.equal(h.nodes.get('#account-wallet-message').hidden, false);
  assert.equal(ethereum.calls.some(call => call.method === 'personal_sign'), false);
  await h.click('#account-wallet-signin');
  assert.equal(ethereum.calls.filter(call => call.method === 'personal_sign').length, 1);
  assert.deepEqual(JSON.parse(h.calls[3].body), {flowId, challengeId: 'wallet-challenge', signature: '0x1234'});
  assert.deepEqual(h.redirects, ['profile.html#info']);
  assert.ok(ethereum.calls.every(call => ['eth_chainId', 'eth_requestAccounts', 'personal_sign'].includes(call.method)));
});

test('wallet rejects a message for the tunnel or a different website before asking for a signature', async () => {
  for (const site of [origin, 'https://untrusted.example']) {
    const ethereum = walletFixture();
    const h = harness({ethereum, responses: [started(), configured(), {body: {challengeId: 'wallet-challenge', message: messageFor(site)}}]});
    await h.start(); await h.click('#account-wallet-signin');
    assert.equal(ethereum.calls.some(call => call.method === 'personal_sign'), false);
    assert.deepEqual(h.redirects, []);
    assert.match(h.nodes.get('#account-status').textContent, /account service must be updated/);
  }
});

test('expired flow offers a fresh start and never exchanges or stores a session', async () => {
  const h = harness({responses: [started(), configured(), {status: 410, body: {error: {message: 'Sign-in expired'}}}]});
  await h.start(); h.nodes.get('#account-email').value = 'reader@example.test'; await h.submit('#account-email-form');
  assert.equal(h.nodes.get('#account-signin').hidden, false);
  assert.equal(h.nodes.get('#account-signin').disabled, false);
  assert.equal(h.storage.has(sessionKey), false); assert.equal(h.storage.has(pendingKey), false);
});

test('profile and login permit only the explicit hosted account origin', () => {
  for (const name of ['login', 'profile']) {
    const html = readFileSync(new URL(`../${name}.html`, import.meta.url), 'utf8');
    assert.ok(html.includes(`connect-src 'self' ${origin};`));
    assert.ok(html.includes('assets/account.js'));
    assert.doesNotMatch(html, /<iframe/i);
  }
  const profile = readFileSync(new URL('../profile.html', import.meta.url), 'utf8');
  assert.equal((profile.match(/data-profile-nav/g) || []).length, 2);
  assert.match(profile, /These are not OpenAI/);
});

test('Studio email approval preserves website state and leaves the PKCE exchange to Studio', async () => {
  const stored = {[sessionKey]: JSON.stringify({accessToken: 'existing-website-session'}), [pendingKey]: JSON.stringify({flowId: 'website-pending'})};
  const h = harness({hash: `#client=studio&flow=${flowId}`, stored, responses: [configured(), {body: {challengeId: 'email'}}, {body: {verified: true}}]});
  await settle();
  assert.equal(h.nodes.get('#account-email-form').hidden, false);
  assert.match(h.nodes.get('#account-status').textContent, /REACH Studio/);
  h.nodes.get('#account-email').value = 'reader@example.test';
  await h.submit('#account-email-form');
  h.nodes.get('#account-code').value = '12345678';
  await h.submit('#account-code-form');
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ['/v1/account/config', '/v1/auth/email/start', '/v1/auth/email/verify']);
  assert.deepEqual(Object.fromEntries(h.storage), stored);
  assert.deepEqual(h.redirects, []);
  assert.equal(h.nodes.get('#account-login-options').hidden, true);
  assert.match(h.nodes.get('#account-status').textContent, /Return to REACH Studio/);
  assert.ok(h.calls.every(call => call.headers['ngrok-skip-browser-warning'] === 'true'));
});

test('Studio wallet sign-in and wallet linking approve the supplied flow without a website session', async () => {
  for (const mode of ['', '&mode=wallet']) {
    const ethereum = walletFixture();
    const h = harness({hash: `#client=studio&flow=${flowId}${mode}`, ethereum, responses: [configured(), {body: {challengeId: 'wallet-challenge', message: messageFor('http://127.0.0.1:4173')}}, {body: {verified: true}}]});
    await settle();
    assert.equal(h.nodes.get('#account-email-form').hidden, !!mode);
    await h.click('#account-wallet-signin');
    await h.click('#account-wallet-signin');
    assert.deepEqual(JSON.parse(h.calls[2].body), {flowId, challengeId: 'wallet-challenge', signature: '0x1234'});
    assert.equal(h.storage.size, 0);
    assert.deepEqual(h.redirects, []);
    assert.match(h.nodes.get('#account-status').textContent, /Return to REACH Studio/);
    assert.equal(h.calls.some(call => call.url.endsWith('/exchange')), false);
  }
});

test('malformed Studio handoffs fail closed and expired flows return the user to Studio', async () => {
  for (const hash of ['#client=studio', '#client=studio&flow=bad', `#client=other&flow=${flowId}`, `#client=studio&flow=${flowId}&mode=other`]) {
    const h = harness({hash}); await settle();
    assert.equal(h.calls.length, 0);
    assert.equal(h.nodes.get('#account-signin').hidden, true);
    assert.match(h.nodes.get('#account-status').textContent, /Invalid Studio/);
  }
  const stored = {[pendingKey]: JSON.stringify({flowId: 'website-pending'})};
  const h = harness({hash: `#client=studio&flow=${flowId}`, stored, responses: [configured(), {status: 410, body: {error: {message: 'Expired'}}}]});
  await settle(); h.nodes.get('#account-email').value = 'reader@example.test'; await h.submit('#account-email-form');
  assert.deepEqual(Object.fromEntries(h.storage), stored);
  assert.equal(h.nodes.get('#account-signin').hidden, true);
  assert.match(h.nodes.get('#account-status').textContent, /Start sign-in again from REACH Studio/);
});
