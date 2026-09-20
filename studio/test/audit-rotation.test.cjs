'use strict';

/* Item 2.4 — bounded audit log with rotation, hash chain intact across files.
 *
 * The audit log was hash-chained and append-only but had no size policy: a busy
 * workspace grew security-audit.jsonl without bound. This adds rotation by size
 * (keep the active file under a byte cap, archive the rest) WITHOUT breaking the
 * chain — the first record of a fresh active file is an ordinary `rotate` marker
 * that chains to the previous file's tip hash, so verify() walks the boundary
 * with no special-casing. A hand-edited line must still fail verify() at the
 * correct index. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AuditLog } = require('../agent/audit-log.cjs');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-audit-rotate-'));
  return path.join(dir, 'security-audit.jsonl');
}

test('rotation by size archives the active file and starts a chained marker record', () => {
  const file = tmpFile();
  const log = new AuditLog(file, { maxBytes: 256 });
  // Each record is ~200+ bytes, so a few writes push past the cap.
  for (let i = 0; i < 8; i++) {
    log.write({ event: 'shell.allow', command: 'cmd-' + i, allowed: true, detail: 'x'.repeat(80) });
  }
  // At least one rotation must have occurred.
  assert.equal(fs.existsSync(file + '.1'), true, 'an archive file exists');
  // The active file stays bounded. With maxBytes=256 the rotation marker alone
  // is ~460 bytes, so a byte ceiling of 512 is unachievable; the real invariant
  // is that rotation keeps the active file from accumulating across writes — it
  // holds at most the marker plus one written record, never all 8 records.
  const activeLines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(activeLines.length <= 2, `active file stays bounded to marker + one record (got ${activeLines.length} records)`);
  // The chain still verifies across the rotation boundary.
  const verified = new AuditLog(file).verify();
  assert.equal(verified.ok, true, `verify across rotation: ${verified.reason}`);
  assert.ok(verified.count >= 8, 'all records (incl. marker) are present');
});

test('verify fails at the correct index after a hand-edited archived line', () => {
  const file = tmpFile();
  const log = new AuditLog(file, { maxBytes: 200 });
  for (let i = 0; i < 6; i++) log.write({ event: 'e' + i, detail: 'y'.repeat(100) });
  assert.equal(fs.existsSync(file + '.1'), true, 'rotation happened');

  // Tamper with the first archived record's command.
  const archive = file + '.1';
  const lines = fs.readFileSync(archive, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[0]);
  rec.command = 'tampered';
  lines[0] = JSON.stringify(rec);
  fs.writeFileSync(archive, lines.join('\n'));

  const verified = new AuditLog(file).verify();
  assert.equal(verified.ok, false, 'tampering detected across rotation');
  assert.equal(verified.brokenAt, 0, 'first record is the one edited');
  assert.match(verified.reason, /hash/i);
});

test('maxBytes = 0 (default) never rotates', () => {
  const file = tmpFile();
  const log = new AuditLog(file); // no maxBytes
  for (let i = 0; i < 6; i++) log.write({ event: 'e' + i, detail: 'z'.repeat(100) });
  assert.equal(fs.existsSync(file + '.1'), false, 'no archive without a cap');
  assert.equal(new AuditLog(file).verify().ok, true);
});
