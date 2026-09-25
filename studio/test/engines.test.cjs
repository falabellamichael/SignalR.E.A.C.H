'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engines = require('../agent/engines.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { writeTextFile } = require('../agent/text-files.cjs');
const refactor = require('../agent/refactor.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-engines-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  engines.configure(path.join(root, 'evidence.jsonl'));
  return root;
}
test('real tool dispatch records evidence and pending review cannot claim a write', async t => {
  const root = fixture(t), proposals = [], messages = [];
  const result = await runToolCall('agent', 'write', { path: 'a.js', content: 'module.exports = 1;' }, {
    projectDir: root, agentId: 'agent', agentStore: { get: () => ({ settings: {} }), appendMessage: (_id, m) => messages.push(m) },
    requestEditReview: edit => proposals.push(edit),
  });
  assert.equal(result.pending, true);
  assert.equal(fs.existsSync(path.join(root, 'a.js')), false);
  assert.equal(proposals[0].expectedHash, null);
  assert.ok(proposals[0].engineReview.risk > 0);
  assert.equal(engines.getLedger().report().observations, 1);
  assert.equal(engines.getLedger().records[0].success, false);
  assert.ok(messages[0]._reachMeta.observationId);
  writeTextFile(proposals[0].absPath, proposals[0].proposed, { root, expectedHash: null });
  assert.equal(engines.getLedger().report().receipts, 1);
});
test('acceptance refuses stale proposals without losing newer contents', t => {
  const root = fixture(t), file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'original'); const expectedHash = engines.hash(fs.readFileSync(file));
  fs.writeFileSync(file, 'human change');
  assert.throws(() => writeTextFile(file, 'agent change', { root, expectedHash }), /changed since/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'human change');
  assert.equal(engines.getLedger().report().receipts, 0);
});
test('direct write tools refuse protected paths and symlink escapes', async t => {
  const root = fixture(t);
  for (const file of ['.env', 'nested/../a.txt', 'migrations/001.sql', 'credentials/auth.json']) {
    const result = await runToolCall('a', 'write', { path: file, content: 'x' }, { projectDir: root });
    assert.equal(result.ok, false, file);
  }
  const inner = path.join(root, 'inner'); fs.mkdirSync(inner);
  fs.symlinkSync(os.tmpdir(), path.join(inner, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => engines.assertWritePath(inner, 'escape/engine-secret.txt'), /escapes/);
});
test('text writes preserve BOM and exact receipt hashes', t => {
  const root = fixture(t), file = path.join(root, 'utf16.txt');
  const before = Buffer.concat([Buffer.from([255, 254]), Buffer.from('old', 'utf16le')]); fs.writeFileSync(file, before);
  writeTextFile(file, 'new', { root, expectedHash: engines.hash(before) });
  const after = fs.readFileSync(file), receipt = engines.getLedger().records.at(-1);
  assert.deepEqual([...after.subarray(0, 2)], [255, 254]);
  assert.equal(receipt.afterHash, engines.hash(after));
  assert.equal(receipt.beforeHash, engines.hash(before));
});
test('refactor transaction validates every path before writing any file', t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'ok.txt'), 'old');
  const plan = refactor.planFromEdits([{ path: 'ok.txt', content: 'new' }, { path: '.env', create: true, content: 'bad' }], { projectDir: root });
  const result = refactor.applyPlan(plan);
  assert.equal(result.ok, false); assert.match(result.error, /protected/);
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(root, '.env')), false);
});
test('persisted records redact whole keys and credentials and never infer truth from tool success', t => {
  const root = fixture(t), ledger = engines.getLedger();
  const a = ledger.observe('read', { password: 'fake-password-1234' }, { ok: true }, 'task');
  const b = ledger.observe('test', {}, { ok: true }, 'task');
  const claim = ledger.claim('password=another-fake-1234', [a.id, b.id], 'task');
  assert.equal(ledger.report().unverified, 1);
  assert.throws(() => ledger.corroborate(claim.id, [a.id, a.id]), /distinct/);
  ledger.corroborate(claim.id, [a.id, b.id]); assert.equal(ledger.report().unverified, 0);
  ledger.append({ text: '-----BEGIN PRIVATE KEY-----\nFAKE_KEY_MATERIAL\n-----END PRIVATE KEY-----' });
  const stored = fs.readFileSync(path.join(root, 'evidence.jsonl'), 'utf8');
  assert.doesNotMatch(stored, /fake-password|another-fake|FAKE_KEY_MATERIAL/);
  assert.equal(new engines.EngineLedger(path.join(root, 'evidence.jsonl')).report().observations, 2);
});
