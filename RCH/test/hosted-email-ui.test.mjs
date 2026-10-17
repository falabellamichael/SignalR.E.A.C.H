import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL(`../service/public/${name}`, import.meta.url), 'utf8');
const flowId = 'a'.repeat(64);

function harness({ returnUrl = 'https://www.signalreach.ca/login.html?next=profile.html#discard', pending = null,
  invalidCode = false, finish = 'wallet', verifyGate = null } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: ['email-login', 'email-code-step'].includes(id),
      disabled: false, value: '', textContent: '', listeners: {},
      addEventListener(event, handler) { this.listeners[event] = handler; } });
    return elements.get(id);
  };
  const calls = [], redirects = [], storage = new Map();
  if (pending) storage.set('reach-login', JSON.stringify(pending));
  const hash = new URLSearchParams({ flow: flowId, return: returnUrl });
  const context = vm.createContext({
    document: { getElementById: element }, URL, URLSearchParams, TextEncoder, Uint8Array,
    location: { pathname: '/wallet/connect', origin: 'https://accounts.frontend.test', hash: '#' + hash,
      assign: url => redirects.push(url) },
    sessionStorage: { getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key) },
    fetch: async (path, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path, body, options });
      if (path === '/v1/auth/email/verify' && verifyGate) await verifyGate;
      const responses = {
        '/v1/account/config': { emailLogin: true, chainId: 1 },
        '/v1/auth/email/start': { challengeId: 'mock-email-challenge' },
        '/v1/auth/email/verify': invalidCode ? { error: { message: 'Invalid or expired code.' } } : { verified: true },
        '/v1/auth/exchange': { account: { email: 'mock@example.test' } },
      };
      assert.ok(Object.hasOwn(responses, path), `Unexpected API request: ${path}`);
      return { ok: !(path === '/v1/auth/email/verify' && invalidCode), json: async () => responses[path] };
    },
  });
  vm.runInContext(source('wallet.js'), context, { filename: 'wallet.js' });
  if (finish === 'missing') vm.runInContext('delete globalThis.reachFinishLogin', context);
  if (finish === 'throws') vm.runInContext('globalThis.reachFinishLogin = async () => { throw new Error("mock failure"); }', context);
  vm.runInContext(source('email.js'), context, { filename: 'email.js' });
  const click = id => element(id).listeners.click();
  const start = async () => { element('email').value = 'mock@example.test'; await click('email-send'); };
  const verify = async (code = '12345678') => { element('email-code').value = code; await click('email-verify'); };
  return { element, calls, redirects, storage, start, verify, click };
}

test('wallet and email scripts coexist and website email success returns to the .ca login callback', async () => {
  const ui = harness();
  await ui.start();
  assert.equal(ui.element('email-login').hidden, false);
  assert.equal(ui.element('email-code-step').hidden, false);
  await ui.verify();
  assert.deepEqual(ui.redirects, ['https://www.signalreach.ca/login.html?next=profile.html&signed=1']);
  assert.equal(ui.element('email-code-step').hidden, true);
  assert.equal(ui.element('email-send').hidden, true);
  assert.equal(ui.element('primary').hidden, true);
  assert.equal(ui.calls.some(call => call.path === '/v1/auth/exchange'), false);
  assert.deepEqual(ui.calls.find(call => call.path === '/v1/auth/email/verify').body,
    { flowId, challengeId: 'mock-email-challenge', code: '12345678' });
});

test('invalid code remains visible and retryable without redirect or exchange', async () => {
  const ui = harness({ invalidCode: true });
  await ui.start();
  await ui.verify();
  assert.equal(ui.element('email-status').textContent, 'Invalid or expired code.');
  assert.equal(ui.element('email-code-step').hidden, false);
  assert.equal(ui.element('email-send').hidden, false);
  assert.equal(ui.element('primary').hidden, false);
  assert.equal(ui.element('email-verify').disabled, false);
  assert.equal(ui.element('email-send').disabled, false);
  assert.deepEqual(ui.redirects, []);
  assert.equal(ui.calls.some(call => call.path === '/v1/auth/exchange'), false);
});

test('email verification disables both actions and ignores duplicate clicks while pending', async () => {
  let release;
  const ui = harness({ verifyGate: new Promise(resolve => { release = resolve; }) });
  await ui.start();
  const verifying = ui.verify();
  assert.equal(ui.element('email-send').disabled, true);
  assert.equal(ui.element('email-verify').disabled, true);
  await ui.click('email-verify');
  await ui.click('email-send');
  assert.equal(ui.calls.filter(call => call.path === '/v1/auth/email/verify').length, 1);
  assert.equal(ui.calls.filter(call => call.path === '/v1/auth/email/start').length, 1);
  release();
  await verifying;
  assert.equal(ui.element('email-verify').disabled, false);
});

test('matching hosted login exchanges locally rather than redirecting to a website', async () => {
  const ui = harness({ pending: { flowId, state: 'mock-state', verifier: 'mock-verifier' } });
  await ui.start();
  await ui.verify();
  assert.deepEqual(ui.redirects, []);
  assert.equal(ui.storage.has('reach-login'), false);
  assert.match(ui.element('status').textContent, /Signed in as mock@example\.test/);
  assert.deepEqual(ui.calls.find(call => call.path === '/v1/auth/exchange').body,
    { flowId, state: 'mock-state', codeVerifier: 'mock-verifier' });
});

for (const finish of ['missing', 'throws']) {
  test(`website callback remains available when hosted completion is ${finish}`, async () => {
    const ui = harness({ finish });
    await ui.start();
    await ui.verify();
    assert.equal(ui.redirects.length, 1);
  });
}

for (const returnUrl of ['https://signalreach.ca/login.html', 'https://www.signalreach.ca/login.html']) {
  test(`email return allowlist preserves ${returnUrl}`, async () => {
    const ui = harness({ returnUrl });
    await ui.start();
    await ui.verify();
    assert.deepEqual(ui.redirects, [returnUrl + '?signed=1']);
  });
}

for (const returnUrl of ['https://untrusted.example/login.html', 'https://www.signalreach.ca/profile.html',
  'javascript:alert(1)', 'https://www.signalreach.ca.evil.example/login.html']) {
  test(`email success rejects unsafe callback ${returnUrl}`, async () => {
    const ui = harness({ returnUrl });
    await ui.start();
    await ui.verify();
    assert.deepEqual(ui.redirects, []);
  });
}
