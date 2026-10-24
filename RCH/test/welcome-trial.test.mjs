import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pgliteStores } from './helpers/pglite-store.mjs';

const example = JSON.parse(readFileSync(new URL('../config/subscription-bridges.example.json', import.meta.url)));
const models = [example.models.find(model => model.metered)];
const pg = pgliteStores({ requiredMigration: '_rch_welcome_trial.sql' });

test('welcome trial grants one day, preserves balances and expires without being reset by sign-in', async () => {
  const f = await pg.fresh({ models, subscription: example.subscription, welcomeTrial: true });
  const account = await f.store.ensureEmailAccount('trial@example.test');
  const initial = await f.store.accountById(account.id);
  assert.ok(Number(initial.trial_ends_at) > Date.now());
  assert.ok(Number(initial.trial_ends_at) <= Date.now() + 86400000);
  assert.equal((await f.store.requestAllowance(account.id)).trialActive, true);
  const request = await f.store.reserveRequest(account.id, 'trial-request', models[0].id, 'fp');
  await f.store.settleRequest(request.id, { contentType: 'application/json; charset=utf-8', body: '{"answer":"ok"}' });
  assert.equal((await f.store.accountById(account.id)).usd_prepaid, initial.usd_prepaid);
  await f.store.ensureEmailAccount('trial@example.test');
  assert.equal((await f.store.accountById(account.id)).trial_ends_at, initial.trial_ends_at);
  await pg.query('UPDATE reach_accounts.accounts SET trial_ends_at=1 WHERE id=$1', [account.id]);
  await f.store.ensureEmailAccount('trial@example.test');
  assert.equal((await f.store.requestAllowance(account.id)).unlimited, undefined);
  await assert.rejects(f.store.reserveRequest(account.id, 'after-trial', models[0].id, 'fp'), { code: 'allowance_exhausted' });
});
