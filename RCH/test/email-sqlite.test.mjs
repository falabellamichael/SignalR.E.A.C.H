import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAddress } from 'ethers';
import { AccountStore } from '../service/store.mjs';
import { emailCodeHash } from '../service/email.mjs';
import { defineEmailSuite } from './helpers/email-suite.mjs';
import { SUBSCRIPTION, MODELS } from './helpers/payments-suite.mjs';

defineEmailSuite('sqlite', {
  async fresh({ models, subscription }) {
    const clock = { now: 1_800_000_000_000 };
    return { store: new AccountStore(':memory:', { now: () => clock.now, models, subscription }), clock };
  },
});

test('sqlite: a database from before email sign-in is migrated in place without losing anything', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reach-email-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'accounts.sqlite');
  const wallet = getAddress(`0x${'33'.repeat(20)}`), accountId = 'a'.repeat(64);
  // The pre-email schema: every account must have a wallet, and later tables
  // hold foreign keys to it.
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,wallet TEXT UNIQUE NOT NULL,plan_id TEXT,plan_name TEXT,plan_expires INTEGER NOT NULL DEFAULT 0,plan_version TEXT,models TEXT NOT NULL DEFAULT '[]',included INTEGER NOT NULL DEFAULT 0,prepaid INTEGER NOT NULL DEFAULT 0,debt INTEGER NOT NULL DEFAULT 0,usd_prepaid INTEGER NOT NULL DEFAULT 0,usd_debt INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE request_periods(account_id TEXT NOT NULL REFERENCES accounts(id),period_key TEXT NOT NULL,plan_version TEXT NOT NULL,period_ends INTEGER NOT NULL,included_limit INTEGER NOT NULL CHECK(included_limit=1500),completed INTEGER NOT NULL DEFAULT 0 CHECK(completed BETWEEN 0 AND included_limit),PRIMARY KEY(account_id,period_key));
    CREATE TABLE subscription_checkouts(account_id TEXT PRIMARY KEY REFERENCES accounts(id),id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,expires INTEGER NOT NULL);`);
  old.prepare("INSERT INTO accounts(id,wallet,plan_id,plan_expires,plan_version,usd_prepaid) VALUES(?,?,'basic-wallet',?,'grant-1',4200000)").run(accountId, wallet, 1_900_000_000_000);
  old.prepare("INSERT INTO request_periods(account_id,period_key,plan_version,period_ends,included_limit,completed) VALUES(?,'grant-1:1',?,1,1500,7)").run(accountId, 'grant-1');
  old.prepare('INSERT INTO subscription_checkouts VALUES(?,?,?,?)').run(accountId, 'c'.repeat(64), 'd'.repeat(64), 1_800_003_600_000);
  old.close();

  const store = new AccountStore(path, { models: MODELS, subscription: SUBSCRIPTION, now: () => 1_800_000_000_000 });
  const columns = store.db.prepare('PRAGMA table_info(accounts)').all();
  assert.equal(columns.find(c => c.name === 'wallet').notnull, 0);
  assert.ok(columns.some(c => c.name === 'email'));
  const kept = store.db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  assert.deepEqual([kept.wallet, kept.plan_id, kept.usd_prepaid, kept.email], [wallet, 'basic-wallet', 4_200_000, null]);
  assert.equal(store.db.prepare('SELECT completed FROM request_periods WHERE account_id=?').get(accountId).completed, 7);
  assert.equal(store.db.prepare('SELECT id FROM subscription_checkouts WHERE account_id=?').get(accountId).id, 'c'.repeat(64));
  assert.throws(() => store.db.prepare('INSERT INTO subscription_checkouts VALUES(?,?,?,?)').run('missing', 'e'.repeat(64), 'f'.repeat(64), 1));
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  // The references still bite: a period for a missing account is refused.
  assert.throws(() => store.db.prepare("INSERT INTO request_periods(account_id,period_key,plan_version,period_ends,included_limit) VALUES('missing','k','v',1,1500)").run());
  assert.equal(store.ensureEmailAccount('ada@example.com').wallet, null);
  assert.throws(() => store.db.prepare('INSERT INTO accounts(id) VALUES(?)').run('b'.repeat(64)), /CHECK/, 'an account needs a wallet or an email');
  store.close();
  // Opening again is a no-op.
  const reopened = new AccountStore(path, { models: MODELS, subscription: SUBSCRIPTION });
  assert.equal(reopened.findAccountByWallet(wallet).id, accountId);
  reopened.close();
});

test('sqlite: the service-wide hourly email limit holds', () => {
  let now = 1_800_000_000_000;
  const store = new AccountStore(':memory:', { now: () => now });
  const send = email => {
    const f = store.startFlow(randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url').slice(0, 43));
    const challengeId = randomBytes(32).toString('hex');
    return store.createEmailChallenge(f.flowId, email, challengeId, emailCodeHash(challengeId, '123456'));
  };
  for (let i = 0; i < 500; i += 1) send(`user${i}@example.com`);
  assert.throws(() => send('late@example.com'), { code: 'email_busy' });
  now += 60 * 60_000 + 1;
  assert.match(send('late@example.com').challengeId, /^[a-f0-9]{64}$/);
  store.close();
});
