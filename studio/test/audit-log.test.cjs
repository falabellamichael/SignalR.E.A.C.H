'use strict';

/* Reach Studio — audit-log rotation + chain integrity (IMPROVEMENTS 2.4).
 *
 * The audit log is the one file in Studio that must never be quietly
 * rewritten. These tests pin the properties the design freezes as invariants
 * A2/A3; if any regresses, history is being lost silently and the suite should
 * say so loudly.
 *
 * The rotation mechanism under test (adopted from the concurrent implementation
 * and amended): the active file is renamed to `<path>.<n>`, a fresh active file
 * opens with a `rotate` marker record chaining to the previous tip, `read()`
 * concatenates archives oldest-first, and only the newest `keep` archives
 * survive. `.1` is always the OLDEST archive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AuditLog, hashRecord, canonical, GENESIS, DEFAULT_MAX_BYTES, VERSION } = require('../agent/audit-log.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-'));
}

test('the default constructor bounds the log, so 2.4 is live and not dead code', () => {
  // main.mjs does `new AuditLog(path)` with no options; if maxBytes defaulted to
  // 0 the whole item would be inert in production.
  const log = new AuditLog(path.join(tmpDir(), 'security-audit.jsonl'));
  assert.equal(log.maxBytes, DEFAULT_MAX_BYTES);
  assert.ok(DEFAULT_MAX_BYTES > 0);
});

test('rotation passes verify and the marker chains to the archived tip', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'security-audit.jsonl');
  const log = new AuditLog(file);
  for (let i = 0; i < 5; i++) log.write({ event: 'exec', command: `cmd-${i}` });

  const before = log.verify();
  assert.equal(before.ok, true, 'pre-rotation chain verifies');
  assert.equal(before.count, 5);
  const tip = log.prev;

  const rotated = log.rotate({ force: true });
  assert.equal(rotated.rotated, true, 'force rotates regardless of size');
  assert.ok(fs.existsSync(`${file}.1`), 'the archive is written');

  // The archived file is byte-identical to what it was — rotation never edits.
  const archived = new AuditLog(`${file}.1`);
  assert.equal(archived.verify().ok, true, 'the archived file still verifies standalone');

  // The whole chain (archive + active) still verifies as one.
  const after = log.verify();
  assert.equal(after.ok, true, 'chain verifies across the rotation boundary');
  assert.equal(after.count, 6, '5 archived + 1 marker');

  const live = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(live.length, 1, 'the active file restarts empty apart from the marker');
  assert.equal(live[0].event, 'rotate');
  assert.equal(live[0].prev, tip, 'the marker chains to the archived tip hash');
  assert.equal(live[0].seq, 6, 'the sequence continues rather than restarting');
});

test('rotation is a no-op below the cap', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'security-audit.jsonl');
  const log = new AuditLog(file);
  log.write({ event: 'exec', command: 'small' });

  const result = log.rotate();
  assert.equal(result.rotated, false);
  assert.equal(result.reason, 'under-cap');
  assert.ok(!fs.existsSync(`${file}.1`), 'no archive is created below the cap');

  log.write({ event: 'exec', command: 'still the same file' });
  const records = log.read();
  assert.equal(records.length, 2, 'both records live in one file');
  assert.equal(log.verify().ok, true);
});

test('an explicit write-time cap rotates automatically', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'security-audit.jsonl');
  // keep is set high enough that none of the 10 records' archives are dropped,
  // so "no records are lost" is asserted against a retention bound the caller
  // actually asked for. With keep: 2 the oldest archives are deliberately
  // deleted and read() returns fewer than 10 — that is bounded retention, not
  // data loss.
  const log = new AuditLog(file, { maxBytes: 64, keep: 20 });
  for (let i = 0; i < 10; i++) log.write({ event: 'exec', command: `cmd-${i}` });

  assert.ok(fs.existsSync(`${file}.1`), 'a file past the cap rotates on write');
  assert.equal(log.verify().ok, true, 'auto-rotation keeps the chain intact');
  assert.ok(log.read().length >= 10, 'no records are lost by rotation');
});

test('a hand-edited line fails verify at the correct index', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'security-audit.jsonl');
  const log = new AuditLog(file);
  for (let i = 0; i < 4; i++) log.write({ event: 'exec', command: `cmd-${i}` });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[2]);
  tampered.command = 'rm -rf /';
  lines[2] = JSON.stringify(tampered);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const result = new AuditLog(file).verify();
  assert.equal(result.ok, false, 'tampering is detected');
  assert.equal(result.brokenAt, 2, 'the exact 0-based index is reported');
  assert.match(result.reason, /Tampered/);
});

test('deleting a record is detected as a sequence gap', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'security-audit.jsonl');
  const log = new AuditLog(file);
  for (let i = 0; i < 4; i++) log.write({ event: 'exec', command: `cmd-${i}` });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  lines.splice(1, 1); // drop the second record
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const result = new AuditLog(file).verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
  assert.match(result.reason, /Sequence gap|Chain break/);
});

test('a forged prev does not survive the hash check', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'security-audit.jsonl');
  const log = new AuditLog(file);
  log.write({ event: 'exec', command: 'first' });
  log.write({ event: 'exec', command: 'second' });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const second = JSON.parse(lines[1]);
  second.prev = GENESIS; // pretend it is the first record
  lines[1] = JSON.stringify(second);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const result = new AuditLog(file).verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
});

test('a legacy v:1 record still verifies and the chain continues from it (invariant A2)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'security-audit.jsonl');

  // Hand-build a record exactly as the pre-rotation module would have, using
  // the OLD canonical form (constant version, no extra keys).
  const legacy = {
    v: 1,
    seq: 1,
    ts: 1700000000000,
    prev: GENESIS,
    event: 'exec',
    agent: null,
    command: 'echo legacy',
    allowed: true,
    code: null,
    reason: null,
    findings: [],
    detail: null,
  };
  const legacyHash = (() => {
    const crypto = require('node:crypto');
    const text = JSON.stringify({
      v: 1,
      seq: legacy.seq,
      ts: legacy.ts,
      prev: legacy.prev,
      event: legacy.event,
      agent: legacy.agent,
      command: legacy.command,
      allowed: legacy.allowed,
      code: legacy.code,
      reason: legacy.reason,
      findings: legacy.findings,
      detail: legacy.detail,
    });
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  })();
  legacy.hash = legacyHash;
  fs.writeFileSync(file, JSON.stringify(legacy) + '\n', 'utf8');

  // The current canonical() must reproduce that hash byte for byte.
  assert.equal(hashRecord(legacy), legacyHash, 'hashing keeps record.v, not a forced constant');
  assert.equal(canonical(legacy).includes('carry'), false, 'no stray fields enter the preimage');

  const result = new AuditLog(file).verify();
  assert.equal(result.ok, true, 'a pre-upgrade log still verifies');
  assert.equal(result.count, 1);

  // And the chain continues from it without rewriting it.
  const log = new AuditLog(file);
  const next = log.write({ event: 'exec', command: 'echo new' });
  assert.equal(next.v, VERSION);
  assert.equal(next.seq, 2);
  assert.equal(next.prev, legacyHash);
  assert.equal(log.verify().ok, true, 'mixed chain verifies');
});

test('archives stay contiguous, chronological and bounded by keep', () => {
  // This is the test that catches the retention-ordering bug: deleting the
  // oldest archive must renumber the rest, or _allFiles() stops being
  // oldest-first and verify() breaks at the boundary.
  const dir = tmpDir();
  const file = path.join(dir, 'security-audit.jsonl');
  const keep = 2;
  const log = new AuditLog(file, { maxBytes: 1, keep });

  for (let round = 0; round < 6; round++) {
    log.write({ event: 'exec', command: `round-${round}` });
    log.rotate({ force: true });
  }

  assert.ok(fs.existsSync(`${file}.1`), 'oldest archive exists');
  assert.ok(fs.existsSync(`${file}.2`), 'newest archive exists');
  assert.ok(!fs.existsSync(`${file}.3`), 'archives beyond keep are dropped');

  // Suffixes are contiguous from 1, which is what _allFiles() relies on.
  let contiguous = true;
  for (let n = 1; n <= keep; n++) if (!fs.existsSync(`${file}.${n}`)) contiguous = false;
  assert.equal(contiguous, true, 'archive suffixes have no gaps');

  const result = log.verify();
  assert.equal(result.ok, true, `chain verifies after ${6} rotations: ${result.reason}`);

  // The active file's first record is the newest marker, and it is the tip.
  const active = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(active[0].event, 'rotate');
  assert.equal(active[0].seq, log.seq);
});
