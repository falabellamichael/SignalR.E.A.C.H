// One behavioural suite for email sign-in, run against BOTH account stores
// (email-sqlite.test.mjs and email-supabase.test.mjs), for the same reason as
// the payments suite: the rules exist in JavaScript and in SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { getAddress } from 'ethers';
import { emailCodeHash } from '../../service/email.mjs';
import { SUBSCRIPTION, MODELS, DAY } from './payments-suite.mjs';

const rejects = (call, check) => assert.rejects(async () => call(), check);
const hex = () => randomBytes(32).toString('hex');

export function defineEmailSuite(label, { fresh }) {
  const t = (name, fn) => test(`${label}: ${name}`, fn);

  async function setup() {
    const h = await fresh({ models: MODELS, subscription: SUBSCRIPTION });
    // A sign-in flow as Studio starts it: PKCE state and verifier stay client-side.
    const flow = async () => {
      const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
      const f = await h.store.startFlow(state, createHash('sha256').update(verifier).digest('base64url'));
      return { ...f, state, verifier };
    };
    const send = async (f, email, code = '123456') => {
      const challengeId = hex();
      const created = await h.store.createEmailChallenge(f.flowId, email, challengeId, emailCodeHash(challengeId, code));
      return { ...created, code };
    };
    const verify = (f, challenge, code = challenge.code) => h.store.verifyEmailChallenge(f.flowId, challenge.challengeId, emailCodeHash(challenge.challengeId, code));
    const signIn = async (email, wait = true) => {
      const f = await flow(), c = await send(f, email);
      await verify(f, c);
      if (wait) h.clock.now += 61_000;
      return h.store.exchange(f.flowId, f.state, f.verifier);
    };
    return { ...h, flow, send, verify, signIn };
  }

  t('a code sent to an email signs in through the normal session exchange', async () => {
    const s = await setup();
    const f = await s.flow(), c = await s.send(f, 'Ada@Example.com ');
    assert.match(c.challengeId, /^[a-f0-9]{64}$/);
    assert.equal(Date.parse(c.expiresAt), s.clock.now + 600_000);
    assert.equal(await s.store.exchange(f.flowId, f.state, f.verifier), null, 'nothing to exchange before the code');
    const accountId = await s.verify(f, c);
    const session = await s.store.exchange(f.flowId, f.state, f.verifier);
    assert.match(session.accessToken, /^rch_session_[a-f0-9]{64}$/);
    assert.equal(session.account.id, accountId);
    assert.equal(session.account.email, 'ada@example.com');
    assert.equal(session.account.walletAddress, null);
    assert.equal((await s.store.authenticate(session.accessToken)).email, 'ada@example.com');
  });

  t('the same address always reaches the same account, whatever its case', async () => {
    const s = await setup();
    const first = await s.signIn('ada@example.com');
    const again = await s.signIn('ADA@example.COM');
    assert.equal(again.account.id, first.account.id);
    assert.equal((await s.store.findAccountByEmail('Ada@Example.com')).id, first.account.id);
    assert.equal(await s.store.findAccountByEmail('someone@example.com'), null);
  });

  t('wrong codes are counted, and the fifth retires the code', async () => {
    const s = await setup();
    const f = await s.flow(), c = await s.send(f, 'ada@example.com');
    for (let i = 1; i <= 4; i += 1) await rejects(() => s.verify(f, c, '000000'), { code: 'code_invalid' });
    await rejects(() => s.verify(f, c, '000000'), { code: 'code_retired' });
    // Even the right code no longer works.
    await rejects(() => s.verify(f, c), { code: 'code_expired' });
    assert.equal(await s.store.exchange(f.flowId, f.state, f.verifier), null);
  });

  t('a code works only for its own sign-in and only for ten minutes', async () => {
    const s = await setup();
    const f = await s.flow(), c = await s.send(f, 'ada@example.com');
    const other = await s.flow();
    await rejects(() => s.store.verifyEmailChallenge(other.flowId, c.challengeId, emailCodeHash(c.challengeId, c.code)), { code: 'code_expired' });
    s.clock.now += 600_000;
    await rejects(() => s.verify(f, c), { status: 410 });
  });

  t('a new code replaces the previous one for the same sign-in', async () => {
    const s = await setup();
    const f = await s.flow(), first = await s.send(f, 'ada@example.com', '111111');
    s.clock.now += 61_000;
    const second = await s.send(f, 'ada@example.com', '222222');
    await rejects(() => s.verify(f, first), { code: 'code_expired' });
    assert.match(await s.verify(f, second), /^[a-f0-9]{64}$/);
    // A verified sign-in cannot ask for another code.
    await rejects(() => s.send(f, 'ada@example.com'), { code: 'flow_verified' });
  });

  t('one code a minute and five an hour per address, across sign-ins', async () => {
    const s = await setup();
    await s.send(await s.flow(), 'ada@example.com');
    await rejects(async () => s.send(await s.flow(), 'ada@example.com'), { code: 'email_cooldown' });
    await s.send(await s.flow(), 'someone@example.com');   // other addresses are not held up
    for (let i = 2; i <= 5; i += 1) { s.clock.now += 61_000; await s.send(await s.flow(), 'ada@example.com'); }
    s.clock.now += 61_000;
    await rejects(async () => s.send(await s.flow(), 'ada@example.com'), { code: 'email_rate_limit' });
    // Pruning expired codes and sign-ins must not reset the hourly count.
    s.clock.now += 11 * 60_000;
    await s.store.pruneExpiredAuthentication();
    await rejects(async () => s.send(await s.flow(), 'ada@example.com'), { code: 'email_rate_limit' });
    s.clock.now += 60 * 60_000;
    await s.store.pruneExpiredAuthentication();
    await s.send(await s.flow(), 'ada@example.com');
  });

  t('malformed addresses and challenge IDs are refused before anything is stored', async () => {
    const s = await setup();
    const f = await s.flow();
    for (const email of ['', 'ada', 'ada@', '@example.com', 'ada@example', 'a b@example.com', `${'a'.repeat(65)}@example.com`, 'ada@exa_mple.com', 42])
      await rejects(() => s.store.createEmailChallenge(f.flowId, email, hex(), hex()), { code: 'email_invalid' }, String(email));
    await rejects(() => s.store.createEmailChallenge(f.flowId, 'ada@example.com', 'short', hex()), { code: 'invalid_challenge' });
    await rejects(() => s.store.createEmailChallenge('nope', 'ada@example.com', hex(), hex()), { status: 400 });
  });

  t('an email-only account can subscribe, top up, and be refunded', async () => {
    const s = await setup();
    const { account } = await s.signIn('ada@example.com');
    const periodEnd = s.clock.now + 30 * DAY;
    const paid = await s.store.applyPayment({ provider: 'stripe', eventId: 'evt_e1', objectId: 'in_e1', kind: 'subscription_period',
      accountId: account.id, amountUsdMicros: 15_000_000, periodEnd });
    assert.equal(paid.status, 'applied');
    const view = await s.store.account(account.id);
    assert.deepEqual([view.plan.id, view.plan.status, view.requestAllowance.basicActive], ['basic-wallet', 'active', true]);
    assert.equal((await s.store.applyPayment({ provider: 'stripe', eventId: 'evt_e1b', objectId: 'in_e1', kind: 'subscription_period',
      accountId: account.id, amountUsdMicros: 15_000_000, periodEnd })).duplicate, true);
    await s.store.applyPayment({ provider: 'stripe', eventId: 'evt_e2', objectId: 'cs_e2', kind: 'top_up', accountId: account.id, amountUsdMicros: 5_000_000 });
    assert.equal((await s.store.account(account.id)).credit.balanceMicros, 5_000_000);
    await s.store.applyReversal({ provider: 'stripe', eventId: 'evt_e3', objectId: 're_e3', kind: 'refund',
      originalObjectId: 'in_e1', originalKind: 'subscription_period', amountUsdMicros: 15_000_000 });
    assert.equal((await s.store.account(account.id)).plan.status, 'expired');
  });


  t('email grants use the account ID, replay unchanged, and refuse another account or missing identity', async () => {
    const s = await setup();
    const { account } = await s.signIn('ada@example.com');
    const { account: other } = await s.signIn('grace@example.com');
    const grant = { accountId: account.id, grantId: 'grant-email-1', planId: 'basic-wallet', name: 'Basic',
      models: MODELS.map(m => m.id), tokens: 0, expiresAt: s.clock.now + DAY };
    const granted = await s.store.grantPlan(grant);
    assert.deepEqual([granted.id, granted.email, granted.walletAddress, granted.plan.status], [account.id, 'ada@example.com', null, 'active']);
    assert.equal((await s.store.grantPlan({ ...grant, models: [...grant.models].reverse() })).id, account.id);
    await rejects(() => s.store.grantPlan({ ...grant, accountId: other.id }), { code: 'grant_conflict' });
    await rejects(() => s.store.grantPlan({ ...grant, grantId: 'grant-missing-1', accountId: 'c'.repeat(64) }), { code: 'account_missing' });
    for (const accountId of [undefined, null, '', 'bad id'])
      await rejects(() => s.store.grantPlan({ ...grant, grantId: 'grant-invalid-1', accountId }), { code: 'invalid_grant' });
    assert.equal((await s.store.account(other.id)).plan.status, 'none');
  });

  t('email checkout intents reuse the durable key and block after a successful subscription payment', async () => {
    const s = await setup();
    const { account } = await s.signIn('ada@example.com');
    const first = await s.store.reserveSubscriptionCheckout(account.id, 'a'.repeat(64));
    assert.deepEqual(await s.store.reserveSubscriptionCheckout(account.id, 'a'.repeat(64)), first);
    await s.store.applyPayment({ provider: 'stripe', eventId: 'evt_email_checkout', objectId: 'in_email_checkout', kind: 'subscription_period',
      accountId: account.id, amountUsdMicros: 15_000_000, periodEnd: s.clock.now + 30 * DAY });
    await rejects(() => s.store.reserveSubscriptionCheckout(account.id, 'a'.repeat(64)), { code: 'plan_active' });
  });

  t('wallet and email accounts stay separate, and wallet grants are unchanged', async () => {
    const s = await setup();
    const wallet = getAddress(`0x${'22'.repeat(20)}`);
    const walletAccount = await s.store.ensureAccount(wallet);
    const { account } = await s.signIn('ada@example.com');
    assert.notEqual(account.id, walletAccount.id);
    const grant = { wallet, grantId: 'grant-wallet-1', planId: 'basic-wallet', name: 'Basic',
      models: MODELS.map(m => m.id), tokens: 0, expiresAt: s.clock.now + DAY };
    const granted = await s.store.grantPlan(grant);
    assert.equal((await s.store.grantPlan({ ...grant, accountId: account.id })).id, walletAccount.id, 'wallet grants retain their original replay identity');
    assert.equal(granted.walletAddress, wallet);
    assert.equal(granted.email, null);
    assert.equal((await s.store.account(account.id)).plan.status, 'none');
  });
}
