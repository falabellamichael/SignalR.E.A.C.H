import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source = readFileSync(new URL('../assets/account.js', import.meta.url), 'utf8');
const pendingKey = 'signalreach.account.pending';
const sessionKey = 'signalreach.account.session';
const origin = 'https://unbent-semicolon-hermit.ngrok-free.dev';
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
function harness({search = '', stored = {}, responses = [], page = 'login'} = {}) {
  const storage = new Map(Object.entries(stored));
  const calls = [], redirects = [], handlers = {};
  const nodes = new Map(['#account-signin', '#account-status', '#account-onboarding', '#account-link-wallet', '#account-check-access', '#subscription-checkout', '#account-retry', '#account-signout', '#profile-info', '#profile-api', '#profile-details', '#api-key-form', '#create-api-key', '#api-access-notice', '#new-key', '#new-key-value', '#copy-api-key', '#dismiss-api-key', '#api-key-list', '#account-id', '#account-email', '#account-wallet', '#account-created', '#api-key-name'].map(id => [id, {disabled: false, hidden: true, value: '', replaceChildren() {}, append() {}, textContent: '', addEventListener: (event, fn) => { handlers[id + event] = fn; }}]));
  const context = {
    document: {body: {dataset: {page}}, createElement: () => ({append() {}}), querySelector: id => nodes.get(id), querySelectorAll: () => []},
    window: {addEventListener() {}},
    sessionStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    location: {href: `http://127.0.0.1:4173/login.html${search}`, pathname: '/login.html', search, assign: url => redirects.push(url), replace: url => redirects.push(url)},
    history: {replaceState() {}}, crypto: webcrypto, TextEncoder, Uint8Array, URL, URLSearchParams,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: async (url, options) => { calls.push({url, ...options}); const next = responses.shift(); if (!next) throw new Error('Unexpected request'); return {ok: next.status !== 410 && next.status !== 401, status: next.status || 200, json: async () => next.body}; }
  };
  vm.runInNewContext(source, context);
  return {storage, calls, redirects, nodes, click: id => handlers[id + 'click'](), submit: () => handlers['#api-key-formsubmit']({preventDefault() {}}), start: () => handlers['#account-signinclick']()};
}
test('fresh PKCE flow stores proof only in tab and hands off in the same tab', async () => {
  const h = harness({responses: [{body: {flowId: 'fresh-flow', loginUrl: `${origin}/wallet/connect#flow=fresh-flow`}}]});
  await h.start();
  const body = JSON.parse(h.calls[0].body), pending = JSON.parse(h.storage.get(pendingKey));
  assert.equal(h.calls[0].url, `${origin}/v1/auth/start`);
  assert.match(body.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(body.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.state, pending.state);
  assert.equal(Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.codeVerifier))).toString('base64url'), body.codeChallenge);
  const url = new URL(h.redirects[0]), hash = new URLSearchParams(url.hash.slice(1));
  assert.equal(hash.get('flow'), 'fresh-flow');
  assert.equal(hash.get('return'), 'http://127.0.0.1:4173/login.html');
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
  const h = harness({stored: {[sessionKey]: JSON.stringify({accessToken: 'session'})}, responses: [{body: {access: {website: false}}}, {body: {loginUrl: `${origin}/wallet/connect#flow=bound`}}]});
  await settle(); await h.click('#account-link-wallet');
  assert.equal(h.calls[1].url, `${origin}/v1/account/link-wallet`);
  assert.equal(JSON.parse(h.storage.get(sessionKey)).accessToken, 'session');
  assert.equal(h.storage.has(pendingKey), false);
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
