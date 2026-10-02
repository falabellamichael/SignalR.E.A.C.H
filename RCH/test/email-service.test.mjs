import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { AccountStore } from '../service/store.mjs';
import { createAccountService } from '../service/server.mjs';
import { validateConfig } from '../service/config.mjs';
import { createResendMailer, normalizeEmail } from '../service/email.mjs';
const example = JSON.parse(readFileSync(new URL('../config/subscription-bridges.example.json', import.meta.url), 'utf8'));
const SUBSCRIPTION = example.subscription, MODELS = example.models;

const NOW = 1_800_000_000_000;
const RESEND_KEY = 're_' + 'k'.repeat(30);

function service(t, { mailer = 'fake', clientIp } = {}) {
  let time = NOW;
  const store = new AccountStore(':memory:', { models: MODELS, subscription: SUBSCRIPTION, now: () => time });
  const sent = [];
  const fake = { async sendSignInCode(message) { sent.push(message); } };
  const config = { origin: 'https://reach.example', chainId: 1, models: MODELS, subscription: SUBSCRIPTION,
    upstreamUrl: 'http://127.0.0.1:20777/v1', upstreamKey: 'host-only-test-credential', redemption: { enabled: false } };
  const { server } = createAccountService({ config, store, ...(mailer === 'fake' ? { mailer: fake } : {}), now: () => time });
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => store.close());
  const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = async (path, body, headers = {}) => {
    await ready;
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(clientIp ? { 'X-Reach-Client-IP': clientIp } : {}), ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const get = async (path, token) => {
    await ready;
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, body: await r.json() };
  };
  const flow = async () => {
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    const started = (await post('/v1/auth/start', { state, codeChallenge: createHash('sha256').update(verifier).digest('base64url') })).body;
    return { ...started, state, verifier };
  };
  return { store, sent, post, get, flow, advance: ms => { time += ms; } };
}

test('a customer signs in with an email code end to end, and the code never appears in a response', async t => {
  const s = service(t);
  assert.equal((await s.get('/v1/account/config')).body.emailLogin, true);
  const f = await s.flow();
  const started = await s.post('/v1/auth/email/start', { flowId: f.flowId, email: ' Ada@Example.com' });
  assert.equal(started.status, 200);
  assert.deepEqual(Object.keys(started.body).sort(), ['challengeId', 'expiresAt']);
  const [message] = s.sent;
  assert.equal(message.to, 'ada@example.com');
  assert.equal(message.host, 'reach.example');
  assert.match(message.code, /^\d{6}$/);
  assert.equal(message.challengeId, started.body.challengeId);
  assert.doesNotMatch(JSON.stringify(started.body), new RegExp(message.code));

  const wrong = message.code === '000000' ? '000001' : '000000';
  assert.equal((await s.post('/v1/auth/email/verify', { flowId: f.flowId, challengeId: started.body.challengeId, code: wrong })).body.error.code, 'code_invalid');
  assert.equal((await s.post('/v1/auth/email/verify', { flowId: f.flowId, challengeId: started.body.challengeId, code: '12345' })).status, 400);
  assert.deepEqual((await s.post('/v1/auth/email/verify', { flowId: f.flowId, challengeId: started.body.challengeId, code: message.code })).body, { status: 'verified' });
  const session = await s.post('/v1/auth/exchange', { flowId: f.flowId, state: f.state, codeVerifier: f.verifier });
  assert.equal(session.status, 200);
  assert.equal(session.body.account.email, 'ada@example.com');
  assert.equal(session.body.account.walletAddress, null);
  assert.equal(session.body.account.rchBalance.status, 'unconfigured');
  const account = await s.get('/v1/account', session.body.accessToken);
  assert.equal(account.body.email, 'ada@example.com');
  // RCH redemption needs a wallet; an email account is told so plainly.
  const redeem = await s.post('/v1/redemptions/start', { amountRch: '1' }, { Authorization: `Bearer ${session.body.accessToken}` });
  assert.deepEqual([redeem.status, redeem.body.error.code], [409, 'wallet_required']);
});

test('rate limits stop a second code within a minute, and a flooding client after ten', async t => {
  const s = service(t, { clientIp: '203.0.113.7' });
  const first = await s.flow();
  await s.post('/v1/auth/email/start', { flowId: first.flowId, email: 'ada@example.com' });
  const again = await s.post('/v1/auth/email/start', { flowId: (await s.flow()).flowId, email: 'ada@example.com' });
  assert.deepEqual([again.status, again.body.error.code], [429, 'email_cooldown']);
  assert.equal(s.sent.length, 1, 'a refused request sends nothing');
  for (let i = 2; i <= 9; i += 1) assert.equal((await s.post('/v1/auth/email/start', { flowId: (await s.flow()).flowId, email: `user${i}@example.com` })).status, 200);
  const flood = await s.post('/v1/auth/email/start', { flowId: (await s.flow()).flowId, email: 'user11@example.com' });
  assert.deepEqual([flood.status, flood.body.error.code], [429, 'email_rate_limit']);
  assert.equal(s.sent.length, 9);
});

test('without an email sender the email routes do not exist', async t => {
  const s = service(t, { mailer: null });
  assert.equal((await s.get('/v1/account/config')).body.emailLogin, false);
  assert.equal((await s.post('/v1/auth/email/start', { flowId: 'f'.repeat(64), email: 'ada@example.com' })).status, 404);
  assert.equal((await s.post('/v1/auth/email/verify', { flowId: 'f'.repeat(64), challengeId: 'c'.repeat(64), code: '123456' })).status, 404);
});

test('the Resend sender posts one idempotent email and hides provider errors', async () => {
  const calls = [];
  let status = 200;
  const mailer = createResendMailer({ apiKey: RESEND_KEY, from: 'REACH <login@reach.example>', fetchImpl: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(status === 200 ? { id: 'email-1' } : { message: `bad key ${RESEND_KEY}` }), { status });
  } });
  await mailer.sendSignInCode({ to: 'ada@example.com', code: '424242', challengeId: 'c'.repeat(64), host: 'reach.example' });
  const [call] = calls;
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.init.headers.Authorization, `Bearer ${RESEND_KEY}`);
  assert.equal(call.init.headers['Idempotency-Key'], `reach-signin-${'c'.repeat(64)}`);
  assert.deepEqual(call.body.to, ['ada@example.com']);
  assert.equal(call.body.from, 'REACH <login@reach.example>');
  assert.match(call.body.text, /424242/);
  assert.doesNotMatch(call.body.subject, /424242/, 'the code stays off lock screens');
  status = 401;
  await assert.rejects(mailer.sendSignInCode({ to: 'ada@example.com', code: '1', challengeId: 'd'.repeat(64), host: 'x' }),
    error => error.code === 'email_unavailable' && !error.message.includes(RESEND_KEY));
});

test('email addresses are folded to one canonical form and junk is refused', () => {
  assert.equal(normalizeEmail('  Ada.Lovelace+reach@Example.CO.uk '), 'ada.lovelace+reach@example.co.uk');
  for (const bad of ['ada', 'ada@localhost', 'ada@@example.com', 'a da@example.com', 'ada@-example.com', `${'a'.repeat(250)}@example.com`, null])
    assert.throws(() => normalizeEmail(bad), { code: 'email_invalid' }, String(bad));
});

test('Resend configuration keeps the key in the environment', () => {
  const raw = { origin: 'https://reach.example', port: 20978, database: 'accounts.sqlite', chainId: 1, upstreamUrl: 'http://127.0.0.1:20777/v1',
    upstreamKeyEnv: 'REACH_UPSTREAM_KEY', models: [], email: { resend: { apiKeyEnv: 'RESEND_API_KEY', from: 'REACH <login@reach.example>' } } };
  const env = { REACH_UPSTREAM_KEY: 'host-only-test-credential', RESEND_API_KEY: RESEND_KEY };
  assert.deepEqual(validateConfig(raw, process.cwd(), env).email, { resend: { apiKey: RESEND_KEY, from: 'REACH <login@reach.example>' } });
  assert.equal(validateConfig({ ...raw, email: { resend: { ...raw.email.resend, from: 'login@reach.example' } } }, process.cwd(), env).email.resend.from, 'login@reach.example');
  const resend = change => ({ ...raw, email: { resend: { ...raw.email.resend, ...change } } });
  for (const [config, environment, message] of [
    [raw, { ...env, RESEND_API_KEY: 'sk_test_' + 'x'.repeat(30) }, /Resend API key/],
    [resend({ apiKeyEnv: 'REACH_UPSTREAM_KEY' }), env, /separate host-only/],
    [resend({ from: 'not an address' }), env, /verified domain/],
    [resend({ from: 'REACH <login@reach.example>\r\nBcc: x@evil.example' }), env, /verified domain/],
    [resend({ apiKey: RESEND_KEY }), env, /Invalid Resend configuration/],
  ]) assert.throws(() => validateConfig(config, process.cwd(), environment), message);
});

test('the sign-in page offers email only when the service enables it, and completes the flow', async () => {
  const source = await readFile(new URL('../service/public/email.js', import.meta.url), 'utf8');
  const run = async ({ emailLogin, pathname = '/wallet/connect', hash = '#flow=' + 'f'.repeat(64) }) => {
    const elements = new Map(), requests = [];
    const element = id => {
      if (!elements.has(id)) elements.set(id, { hidden: id === 'email-login' || id === 'email-code-step', disabled: false, value: '', textContent: '',
        events: {}, addEventListener(name, callback) { this.events[name] = callback; } });
      return elements.get(id);
    };
    const context = vm.createContext({ document: { getElementById: element }, location: { pathname, hash }, URLSearchParams,
      fetch: async (path, options) => {
        requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
        if (path === '/v1/account/config') return { ok: true, json: async () => ({ emailLogin }) };
        if (path === '/v1/auth/email/start') return { ok: true, json: async () => ({ challengeId: 'c'.repeat(64), expiresAt: 'later' }) };
        if (path === '/v1/auth/email/verify') return { ok: true, json: async () => ({ status: 'verified' }) };
        return { ok: false, json: async () => ({ error: { message: 'unexpected' } }) };
      } });
    vm.runInContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    const click = async id => { await element(id).events.click(); };
    return { element, requests, click };
  };
  const off = await run({ emailLogin: false });
  assert.equal(off.element('email-login').hidden, true);
  const redeem = await run({ emailLogin: true, pathname: '/wallet/redeem' });
  assert.equal(redeem.requests.length, 0, 'nothing happens on the redemption page');

  const page = await run({ emailLogin: true });
  assert.equal(page.element('email-login').hidden, false);
  page.element('email').value = 'nonsense';
  await page.click('email-send');
  assert.match(page.element('email-status').textContent, /Enter your email/);
  page.element('email').value = 'ada@example.com';
  await page.click('email-send');
  assert.deepEqual(page.requests.at(-1), { path: '/v1/auth/email/start', body: { flowId: 'f'.repeat(64), email: 'ada@example.com' } });
  assert.equal(page.element('email-code-step').hidden, false);
  page.element('email-code').value = '12 34 56';
  await page.click('email-verify');
  assert.deepEqual(page.requests.at(-1).body, { flowId: 'f'.repeat(64), challengeId: 'c'.repeat(64), code: '123456' });
  assert.match(page.element('email-status').textContent, /Return to REACH Studio/);
  assert.equal(page.element('primary').hidden, true);
});
