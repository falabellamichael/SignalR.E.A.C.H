import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'ethers';

// The operator's hand-run path. Everything here goes through the real command
// line, a real config file and a real SQLite database, so it proves the
// commands are wired to the same ledger the automatic providers will use.
const script = fileURLToPath(new URL('../scripts/accounts.mjs', import.meta.url));
const example = JSON.parse(readFileSync(new URL('../config/subscription-bridges.example.json', import.meta.url), 'utf8'));
const wallet = getAddress(`0x${'ab'.repeat(20)}`);
const DAY = 86_400_000;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'reach-payments-cli-'));
  const config = { origin: 'http://127.0.0.1:20978', listenHost: '127.0.0.1', port: 20978, database: join(dir, 'accounts.sqlite'),
    chainId: 1, upstreamUrl: 'http://127.0.0.1:20777/v1', upstreamKeyEnv: 'REACH_TEST_UPSTREAM_KEY',
    models: [example.models[0]], redemption: { enabled: false }, subscription: example.subscription };
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify(config));
  const run = (command, ...args) => {
    const result = spawnSync(process.execPath, [script, command, '--config', join(dir, 'accounts.json'), ...args],
      { encoding: 'utf8', env: { ...process.env, REACH_TEST_UPSTREAM_KEY: 'host-only-test-credential-0000' } });
    return { code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) };
  };
  const file = (name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return ['--file', path]; };
  return { dir, run, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a hand-confirmed subscription payment grants Basic and is recorded', t => {
  const w = workspace(); t.after(w.cleanup);
  const periodEnd = new Date(Date.now() + 30 * DAY).toISOString();
  const applied = w.run('payment', ...w.file('p.json', { wallet, objectId: 'bank-ref-0001', kind: 'subscription_period', amountUsdMicros: 15_000_000, periodEnd }));
  assert.equal(applied.code, 0, applied.err);
  assert.equal(applied.json().status, 'applied');
  const status = w.run('status', '--wallet', wallet).json();
  assert.equal(status.plan.id, 'basic-wallet');
  assert.equal(status.plan.expiresAt, periodEnd);
  const listed = w.run('payments', '--wallet', wallet).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].provider, 'manual');
  assert.equal(listed[0].amountUsdMicros, 15_000_000);
});

test('running the same payment twice does not apply it twice', t => {
  const w = workspace(); t.after(w.cleanup);
  const entry = { wallet, objectId: 'bank-ref-0002', kind: 'top_up', amountUsdMicros: 5_000_000 };
  const first = w.run('payment', ...w.file('p.json', entry)).json();
  const second = w.run('payment', ...w.file('p.json', entry)).json();
  assert.equal(second.duplicate, true);
  assert.equal(second.paymentId, first.paymentId);
  assert.equal(w.run('status', '--wallet', wallet).json().credit.balanceMicros, 5_000_000);
});

test('the Basic price is enforced, and a short payment is left for review', t => {
  const w = workspace(); t.after(w.cleanup);
  const periodEnd = new Date(Date.now() + 30 * DAY).toISOString();
  const result = w.run('payment', ...w.file('p.json', { wallet, objectId: 'bank-ref-0003', kind: 'subscription_period', amountUsdMicros: 10_000_000, periodEnd })).json();
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'amount_mismatch');
  assert.equal(w.run('status', '--wallet', wallet).json().plan.status, 'none');
  const review = w.run('payments').json();
  assert.equal(review.length, 1);
  assert.equal(review[0].objectId, 'bank-ref-0003');
});

test('the file cannot claim to be a different provider', t => {
  const w = workspace(); t.after(w.cleanup);
  const result = w.run('payment', ...w.file('p.json', { wallet, objectId: 'bank-ref-0004', provider: 'stripe', kind: 'top_up', amountUsdMicros: 2_000_000 }));
  assert.equal(result.code, 0, result.err);
  assert.equal(w.run('payments', '--wallet', wallet).json()[0].provider, 'manual');
});

test('an invalid record fails clearly and writes nothing', t => {
  const w = workspace(); t.after(w.cleanup);
  const bad = w.run('payment', ...w.file('p.json', { wallet, objectId: 'bank-ref-0005', kind: 'top_up', amountUsdMicros: 'five dollars' }));
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /Invalid payment record/);
  assert.equal(w.run('payments').json().length, 0);
});

test('the help text documents both commands', t => {
  const w = workspace(); t.after(w.cleanup);
  const help = spawnSync(process.execPath, [script, 'help'], { encoding: 'utf8' }).stdout;
  assert.match(help, /accounts -- payment --config/);
  assert.match(help, /accounts -- payments --config/);
  assert.match(help, /excludes tax and processor fees/);
});
