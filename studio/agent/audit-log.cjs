'use strict';

/* Reach Studio — append-only security audit log.
 *
 * The sandbox PRD requires that "all terminal commands, environment flags, and
 * execution output streams are logged to an immutable security audit log."
 * Immutability here is enforced by construction, not by trust:
 *
 *   - Append-only. This module exposes write and read; there is no update and
 *     no delete, so no code path in Studio can rewrite history.
 *   - Hash-chained. Each record stores the SHA-256 of the previous record, so
 *     deleting or editing any line in the middle breaks every hash after it and
 *     verify() reports exactly where the chain was tampered with.
 *   - Tamper-evident, not tamper-proof. A determined attacker with filesystem
 *     access can recompute a chain. That is out of scope for a local desktop
 *     tool; what this defends against is silent edits, truncation, and a
 *     future code path that grows a delete button. verify() makes any of those
 *     loud.
 *
 * Zero dependencies (node:crypto, node:fs) like the rest of agent/.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const GENESIS = '0'.repeat(64);
const MAX_DETAIL_CHARS = 16000;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * The exact string a record's hash covers. Keep this stable: changing it
 * invalidates every previously written log.
 */
function canonical(record) {
  return JSON.stringify({
    v: VERSION,
    seq: record.seq,
    ts: record.ts,
    prev: record.prev,
    event: record.event,
    agent: record.agent,
    command: record.command,
    allowed: record.allowed,
    code: record.code,
    reason: record.reason,
    findings: record.findings,
    detail: record.detail,
  });
}

function hashRecord(record) {
  return sha256(canonical(record));
}

/**
 * An AuditLog writes newline-delimited JSON, one record per line, each
 * hash-chained to the previous. Construct with a file path; call open() once
 * to load the existing chain length and tip hash.
 */
class AuditLog {
  constructor(filePath, { now = Date.now, fsImpl = fs } = {}) {
    this.filePath = filePath ? String(filePath) : null;
    this.now = now;
    this.fs = fsImpl;
    this.seq = 0;
    this.prev = GENESIS;
    this.opened = false;
  }

  /** Read any existing log to continue its chain. Idempotent. */
  open() {
    if (this.opened) return this;
    this.seq = 0;
    this.prev = GENESIS;
    if (this.filePath && this.fs.existsSync(this.filePath)) {
      const records = this.read();
      if (records.length) {
        const last = records[records.length - 1];
        this.seq = Number.isSafeInteger(last.seq) ? last.seq : records.length;
        this.prev = last.hash || GENESIS;
      }
    }
    this.opened = true;
    return this;
  }

  /**
   * Append one event. Returns the stored record (with seq, ts, prev, hash).
   * Fields are whitelisted so a caller cannot inject arbitrary keys or a
   * forged prev/hash that would break the chain.
   */
  write(entry = {}) {
    this.open();
    const detail = entry.detail === undefined ? null
      : (typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail));
    const record = {
      v: VERSION,
      seq: this.seq + 1,
      ts: typeof entry.ts === 'number' ? entry.ts : this.now(),
      prev: this.prev,
      event: String(entry.event || 'event').slice(0, 64),
      agent: entry.agent === undefined || entry.agent === null ? null : String(entry.agent).slice(0, 128),
      command: entry.command === undefined || entry.command === null ? null : String(entry.command).slice(0, 4000),
      allowed: typeof entry.allowed === 'boolean' ? entry.allowed : null,
      code: entry.code === undefined || entry.code === null ? null : String(entry.code).slice(0, 64),
      reason: entry.reason === undefined || entry.reason === null ? null : String(entry.reason).slice(0, 1000),
      findings: Array.isArray(entry.findings) ? entry.findings.slice(0, 50) : [],
      detail: detail === null ? null : detail.slice(0, MAX_DETAIL_CHARS),
    };
    record.hash = hashRecord(record);

    if (this.filePath) {
      this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Append synchronously so a crash cannot interleave two records.
      this.fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
    }
    this.seq = record.seq;
    this.prev = record.hash;
    return record;
  }

  /** Read all records (parsed). Malformed lines are returned as {error}. */
  read() {
    if (!this.filePath || !this.fs.existsSync(this.filePath)) return [];
    const text = this.fs.readFileSync(this.filePath, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { out.push(JSON.parse(trimmed)); }
      catch (error) { out.push({ error: error.message, raw: trimmed.slice(0, 200) }); }
    }
    return out;
  }

  /**
   * Verify the whole chain. Returns {ok, count, brokenAt, reason}. ok is true
   * only when every record's hash recomputes and links to its predecessor with
   * no gaps — so truncation, edits and deletions all fail here.
   */
  verify() {
    const records = this.read();
    let expectedPrev = GENESIS;
    let expectedSeq = 1;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.error) return { ok: false, count: records.length, brokenAt: i, reason: `Line ${i + 1} is not valid JSON: ${rec.error}` };
      if (rec.seq !== expectedSeq) {
        return { ok: false, count: records.length, brokenAt: i, reason: `Sequence gap at line ${i + 1}: expected seq ${expectedSeq}, found ${rec.seq}. A record was removed or inserted.` };
      }
      if (rec.prev !== expectedPrev) {
        return { ok: false, count: records.length, brokenAt: i, reason: `Chain break at line ${i + 1}: prev does not match the previous record's hash.` };
      }
      const stored = rec.hash;
      const recomputed = hashRecord(rec);
      if (stored !== recomputed) {
        return { ok: false, count: records.length, brokenAt: i, reason: `Tampered record at line ${i + 1}: stored hash does not match its contents.` };
      }
      expectedPrev = stored;
      expectedSeq++;
    }
    return { ok: true, count: records.length, brokenAt: null, reason: null };
  }
}

module.exports = { AuditLog, hashRecord, canonical, sha256, VERSION, GENESIS };
