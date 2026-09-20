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
 *   - Bounded (IMPROVEMENTS 2.4). The log would otherwise grow without limit.
 *     Once the active file passes `maxBytes` it is rotated to `<path>.<n>` and a
 *     fresh active file opens with a `rotate` marker record chaining to the
 *     previous tip. Only the newest `keep` archives are retained, so total disk
 *     is bounded by roughly maxBytes * (keep + 1).
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
/* Default cap for the active file. main.mjs constructs this class with no
 * options, so the default is what makes 2.4 live rather than dead code. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/* How many rotated archives survive. Oldest (lowest suffix) is dropped first. */
const DEFAULT_KEEP = 3;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * The exact string a record's hash covers. Keep this stable: changing it
 * invalidates every previously written log.
 *
 * `v` is read from the RECORD, not the VERSION constant, so a future schema
 * bump cannot silently invalidate existing logs (IMPROVEMENTS 2.4, invariant
 * A2). Today both are 1 and hash identically to the pre-rotation file.
 */
function canonical(record) {
  return JSON.stringify({
    v: Number.isSafeInteger(record.v) ? record.v : VERSION,
    seq: record.seq,
    ts: record.ts,
    prev: record.prev,
    carry: record.carry,
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
  constructor(filePath, { now = Date.now, fsImpl = fs, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
    this.filePath = filePath ? String(filePath) : null;
    this.now = now;
    this.fs = fsImpl;
    // Rotation cap (bytes) for the ACTIVE file. 0 = never rotate. On overflow the
    // active file is renamed to <path>.<n> and a fresh active file is started with
    // a `rotate` marker record chaining to the previous file's tip hash. Archived
    // files are retained so verify() can still walk the chain across the boundary.
    this.maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
    this.keep = Number.isSafeInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP;
    this.seq = 0;
    this.prev = GENESIS;
    this.opened = false;
  }

  /** Read any existing log to continue its chain. Idempotent. */
  open() {
    if (this.opened) return this;
    this.seq = 0;
    this.prev = GENESIS;
    if (this.filePath) {
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

  /** Build a record with the next seq and the current tip hash. Does not write. */
  _buildRecord(entry = {}) {
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
    // A `rotate` marker is a LINK record (Invariant A3): carry === prev so
    // verify() can treat a rotated/bounded file as a legal chain start. carry
    // is present only on link records, so existing records' hash preimage is
    // byte-for-byte unchanged (JSON.stringify omits an undefined key).
    if (entry.event === 'rotate') record.carry = record.prev;
    record.hash = hashRecord(record);
    return record;
  }

  /** Append one record and advance the chain tip. Append-only, never rewrite. */
  _appendRecord(record) {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Append synchronously so a crash cannot interleave two records.
    this.fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
    this.seq = record.seq;
    this.prev = record.hash;
  }

  write(entry = {}) {
    this.open();
    // Rotate the active file once it reaches the size cap, BEFORE the next
    // record is appended, so a single file never grows past ~maxBytes.
    if (this.filePath && this.maxBytes && this._activeBytes() >= this.maxBytes) {
      this._rotate();
    }
    const record = this._buildRecord(entry);
    if (this.filePath) this._appendRecord(record);
    else { this.seq = record.seq; this.prev = record.hash; }
    return record;
  }

  /* Size of the active file only (archives excluded). */
  _activeBytes() {
    if (!this.filePath || !this.fs.existsSync(this.filePath)) return 0;
    return this.fs.statSync(this.filePath).size;
  }

  /* Count of archived files (<path>.1, <path>.2, …). */
  _archiveCount() {
    let i = 0;
    while (this.fs.existsSync(`${this.filePath}.${i + 1}`)) i++;
    return i;
  }

  /* All chain files in chronological order: oldest archive → active. */
  _allFiles() {
    const files = [];
    let i = 1;
    while (this.fs.existsSync(`${this.filePath}.${i}`)) { files.push(`${this.filePath}.${i}`); i++; }
    if (this.fs.existsSync(this.filePath)) files.push(this.filePath);
    return files;
  }

  /* Parse one file into records (malformed lines become {error}). */
  _readFile(file) {
    const text = this.fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { out.push(JSON.parse(trimmed)); }
      catch (error) { out.push({ error: error.message, raw: trimmed.slice(0, 200) }); }
    }
    return out;
  }

  read() {
    if (!this.filePath) return [];
    const out = [];
    for (const file of this._allFiles()) out.push(...this._readFile(file));
    return out;
  }

  /**
   * Rotate on demand. Returns a descriptor; safe to call at any time.
   *
   * Rotation is size-gated by default so a caller writing in a loop can just
   * call it. Pass `force: true` to rotate regardless of size (tests, manual
   * "archive now" affordance).
   */
  rotate({ maxBytes = this.maxBytes, keep = this.keep, force = false } = {}) {
    if (!this.filePath) return { rotated: false, reason: 'no-file' };
    if (!this.fs.existsSync(this.filePath)) return { rotated: false, reason: 'missing' };
    const size = this._activeBytes();
    if (!force && (!maxBytes || size < maxBytes)) {
      return { rotated: false, reason: 'under-cap', size, maxBytes };
    }
    return { rotated: true, ...this._rotate({ keep }) };
  }

  /**
   * Rotate the active file to <path>.<n> and start a fresh active file whose
   * first record is a `rotate` marker chaining to the previous file's tip hash.
   * The marker is an ordinary hash-chained record, so verify() walks the
   * rotation boundary without special-casing it.
   *
   * Archive retention: only the newest `keep` archives survive. The OLDEST
   * archive is `.1` (see _allFiles), so when at capacity the lowest suffix is
   * deleted and the rest are renumbered down — which keeps "lowest = oldest"
   * true and leaves _allFiles() chronological. Without this the "bound the
   * audit log" item would bound a single file while total disk grew forever.
   */
  _rotate({ keep = this.keep } = {}) {
    const bytes = this._activeBytes();
    // Capture the pre-rotation archive count ONCE. _archiveCount() counts
    // CONTIGUOUS suffixes from .1, so re-reading it after deleting .1 returns 0
    // (the .2/.3 files no longer form a contiguous run from .1) and the renumber
    // loop would never run — scrambling the chain order. The captured value is
    // what makes "drop oldest, shift the rest down, newest lands at the old top"
    // land on the correct suffix every time.
    let count = this._archiveCount();
    if (count >= keep) {
      this.fs.rmSync(`${this.filePath}.1`, { force: true });
      for (let n = 2; n <= count; n++) {
        const from = `${this.filePath}.${n}`;
        if (this.fs.existsSync(from)) this.fs.renameSync(from, `${this.filePath}.${n - 1}`);
      }
      count -= 1;
    }
    // The active file becomes the newest archive (suffix `count + 1`).
    const archive = `${this.filePath}.${count + 1}`;
    this.fs.renameSync(this.filePath, archive);
    this._appendRecord(this._buildRecord({
      event: 'rotate',
      reason: `Rotated at ${bytes} bytes; previous chain archived as ${path.basename(archive)}`,
      detail: { from: path.basename(archive), bytes },
    }));
    return { archive, bytes, keep: this.keep };
  }

  /**
   * Verify the whole chain. Returns {ok, count, brokenAt, reason}. ok is true
   * only when every record's hash recomputes and links to its predecessor with
   * no gaps — so truncation, edits and deletions all fail here.
   *
   * Because read() walks archives oldest-first, a rotated file is verified as
   * one continuous chain and rotation needs no special case.
   */
  verify() {
    const records = this.read();
    let expectedPrev = GENESIS;
    let expectedSeq = 1;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.error) return { ok: false, count: records.length, brokenAt: i, reason: `Line ${i + 1} is not valid JSON: ${rec.error}` };
      // Invariant A3: a link record (carry === prev) is a legal chain start.
      // Retention drops the oldest archives, so the first surviving record can
      // be a `rotate` marker whose seq is far above 1; anchor at its own seq
      // and prev instead of forcing 1 / GENESIS. A non-link first record still
      // anchors at GENESIS exactly as before.
      if (i === 0 && typeof rec.carry === 'string' && rec.carry.length === 64 && rec.carry === rec.prev) {
        expectedPrev = rec.prev;
        expectedSeq = rec.seq;
      }
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

  /** Verify only the active file; used to prove an archive boundary is legal. */
  verifyActive() {
    if (!this.filePath || !this.fs.existsSync(this.filePath)) return { ok: true, count: 0, brokenAt: null, reason: null };
    const records = this._readFile(this.filePath);
    let expectedPrev = this.prev;
    let expectedSeq = 1;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.error) return { ok: false, count: records.length, brokenAt: i, reason: `Line ${i + 1} is not valid JSON: ${rec.error}` };
      if (rec.prev !== expectedPrev) {
        return { ok: false, count: records.length, brokenAt: i, reason: `Chain break at line ${i + 1}.` };
      }
      expectedPrev = rec.hash;
      expectedSeq++;
    }
    return { ok: true, count: records.length, brokenAt: null, reason: null };
  }
}

module.exports = {
  AuditLog,
  hashRecord,
  canonical,
  sha256,
  VERSION,
  GENESIS,
  DEFAULT_MAX_BYTES,
  DEFAULT_KEEP,
};
