'use strict';

/* Reach Studio — cross-IDE / desktop agent state synchronization.
 *
 * The PRD's Phase 2 sync story: agent conversation history, prompt context and
 * pending patch proposals must move between REACH Studio desktop and the VS Code
 * extension in real time, and a disconnected link must queue updates locally and
 * re-sync automatically on reconnect.
 *
 * STATUS (2026-09-18): IMPLEMENTED AND TESTED, BUT NOT WIRED INTO THE APP.
 *   Nothing in main.mjs, preload.cjs, the renderer, or the VS Code extension
 *   constructs a SyncEngine. The only mentions in the repo are its own test file
 *   and the test registration in package.json. The PRD's Phase 2 "Studio & IDE Agent
 *   Synchronization Console" is therefore not yet delivered end to end, and the
 *   `sb-sync` status chip in the renderer stays hidden (workspace-shell.js
 *   defines and exports setSync() but nothing ever calls it, while its siblings
 *   setLatency and setIndex are called). Closing this needs a transport and
 *   a VS Code counterpart, neither of which exists yet; that is a design
 *   decision, not a missing function call. Do not let a passing test suite imply
 *   this feature ships.
 *
 * Design:
 *   - Transport-agnostic. A transport is just {send(record) -> Promise, onReceive(cb)}.
 *     Nothing here knows about Electron. Tests wire it to an in-memory pair; a
 *     real transport (relay IPC/WebSocket) has not been written.
 *   - Lamport-style versioning per (peer, key). Each peer stamps its own updates
 *     with a monotonically increasing counter, so "newest wins" is well defined
 *     across peers without synchronized clocks.
 *   - Last-write-wins with conflict REPORTING. LWW is the only sane automatic
 *     policy for a single user working across two interfaces, but silently
 *     dropping an edit is how work disappears — so a rejected update is recorded
 *     in `conflicts` and surfaced in the UI rather than discarded quietly.
 *   - Durable offline queue. Records are persisted before being acknowledged,
 *     so a crash while disconnected does not lose the queued work. On reconnect
 *     the queue drains in order.
 *   - Idempotent receipt. Every record carries a stable id; a duplicate delivery
 *     (at-least-once transports) is ignored instead of being applied twice.
 *
 * Zero dependencies (node:fs, node:path, node:crypto).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_QUEUE = 500;
const MAX_VALUE_BYTES = 2 * 1024 * 1024;
const MAX_SEEN_IDS = 2000;

function newId(prefix) {
  return (prefix || 'rec') + '_' + crypto.randomBytes(8).toString('hex');
}

/** Syncable state kinds. Anything else is refused — an unbounded key space would
 *  let a buggy peer fill the store. */
const STATE_KINDS = new Set(['conversation', 'context', 'pendingEdit', 'todos', 'runState', 'settings']);

/* ------------------------------------------------------------------- payloads */

/** Byte size of a value once serialized, with a cap to avoid serializing twice. */
function sizeOf(value) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 0 : s.length;
  } catch { return Infinity; }   // circular: treat as too large rather than throw
}

function isSyncableValue(value) {
  if (value === undefined) return false;
  if (typeof value === 'function') return false;
  const size = sizeOf(value);
  return Number.isFinite(size) && size <= MAX_VALUE_BYTES;
}

/* -------------------------------------------------------------------- engine */

/**
 * A SyncEngine owns one peer's view of shared agent state.
 *
 * @param {object} options
 *   peerId       stable id for this peer (default: generated)
 *   transport    {send, onReceive} — optional; can be attached later via connect()
 *   store        {load, persist} — optional durable queue backing
 *   now          clock injection for tests
 *   onState      (key, value, meta) => void  applied-remote-update callback
 *   onConflict   (conflict) => void
 *   onStatus     (status) => void   connection/queue status changes
 */
class SyncEngine {
  constructor(options = {}) {
    this.peerId = String(options.peerId || newId('peer'));
    this.clock = Number(options.clock) && Number(options.clock) > 0 ? Number(options.clock) : 1;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.onState = options.onState || (() => {});
    this.onConflict = options.onConflict || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.maxQueue = Number.isSafeInteger(options.maxQueue) && options.maxQueue > 0 ? options.maxQueue : MAX_QUEUE;

    /** key -> {value, version, peerId, updatedAt} */
    this.state = new Map();
    /** highest version seen per peer, for staleness detection */
    this.peerVersions = new Map();
    /** record ids already applied (dedupe for at-least-once transports) */
    this.seenIds = new Set();
    this.seenOrder = [];
    /** local edits waiting to be delivered */
    this.queue = [];
    this.conflicts = [];
    this.connected = false;
    this.transport = null;
    this.store = options.store || null;
    this.lastError = null;

    if (this.store) this._loadQueue();
  }

  /* ------------------------------------------------------------ connection */

  connect(transport) {
    if (transport) this.transport = transport;
    if (!this.transport || typeof this.transport.send !== 'function') {
      this.lastError = 'A transport with send() is required to connect.';
      this._emitStatus();
      return false;
    }
    this.connected = true;
    if (typeof this.transport.onReceive === 'function') {
      this.transport.onReceive((record) => { this.receive(record); });
    }
    this._emitStatus();
    // Drain anything queued while offline, oldest first.
    this.flush();
    return true;
  }

  disconnect() {
    this.connected = false;
    this._emitStatus();
  }

  /** Send one record; queue it if the transport is down or rejects it. */
  async _deliver(record) {
    if (!this.connected || !this.transport) {
      this._enqueue(record);
      return { delivered: false, queued: true };
    }
    try {
      await this.transport.send(record);
      return { delivered: true, queued: false };
    } catch (error) {
      // A send failure means the link is effectively down: mark it, queue the
      // record, and let the caller see both facts. Auto-resync happens on the
      // next connect().
      this.connected = false;
      this.lastError = String(error && error.message || error);
      this._enqueue(record);
      this._emitStatus();
      return { delivered: false, queued: true, error: this.lastError };
    }
  }

  _enqueue(record) {
    // Never queue the same record twice (a retry of an already-queued local
    // edit must not duplicate it).
    if (this.queue.some(r => r.id === record.id)) return;
    this.queue.push(record);
    if (this.queue.length > this.maxQueue) {
      // Drop the OLDEST undelivered record and say so: silently growing without
      // bound would eventually exhaust memory, and silently dropping the newest
      // would discard the user's most recent action.
      const dropped = this.queue.shift();
      this.conflicts.push(this._conflict('queue-overflow', dropped, 'The offline queue is full; the oldest unsent update was dropped.'));
    }
    this._persist();
    this._emitStatus();
  }

  /** Deliver everything queued, in order. Stops at the first hard failure. */
  async flush() {
    if (!this.connected || !this.queue.length) return { sent: 0, remaining: this.queue.length };
    let sent = 0;
    while (this.queue.length) {
      const record = this.queue[0];
      try {
        await this.transport.send(record);
      } catch (error) {
        this.connected = false;
        this.lastError = String(error && error.message || error);
        this._emitStatus();
        return { sent, remaining: this.queue.length, error: this.lastError };
      }
      this.queue.shift();
      sent++;
      this._persist();
    }
    this.lastError = null;
    this._emitStatus();
    return { sent, remaining: 0 };
  }

  /* -------------------------------------------------------------- local API */

  /**
   * Record a local change to a key. Bumps this peer's version, applies it
   * locally immediately (so the UI never waits on the network), and delivers or
   * queues it.
   */
  async set(key, value, meta = {}) {
    const k = String(key || '');
    if (!k) throw new Error('A sync key is required.');
    const kind = meta.kind || null;
    if (kind !== null && !STATE_KINDS.has(kind)) {
      throw new Error(`Unknown sync kind "${kind}". Allowed: ${[...STATE_KINDS].join(', ')}.`);
    }
    if (!isSyncableValue(value)) {
      throw new Error('Value is not serializable or exceeds the 2 MB sync limit.');
    }
    this.clock += 1;
    const record = {
      id: newId('rec'),
      kind: kind || 'state',
      key: k,
      value,
      version: this.clock,
      peerId: this.peerId,
      updatedAt: this.now(),
      agentId: meta.agentId || null,
      origin: 'local',
    };
    this._applyLocal(record);
    this._rememberId(record.id);
    const res = await this._deliver(record);
    return { ...res, record };
  }

  /** Remove a key (a tombstone, so the deletion propagates instead of sticking). */
  async delete(key, meta = {}) {
    return this.set(String(key), null, { ...meta, kind: meta.kind || 'conversation' });
  }

  get(key) {
    const entry = this.state.get(String(key));
    return entry ? entry.value : undefined;
  }

  /** JSON-safe snapshot of everything held, for the sync console UI. */
  snapshot() {
    return [...this.state.entries()].map(([key, e]) => ({
      key, kind: e.kind, version: e.version, peerId: e.peerId, updatedAt: e.updatedAt,
      agentId: e.agentId || null, deleted: e.value === null,
      bytes: sizeOf(e.value),
    })).sort((a, b) => a.key.localeCompare(b.key));
  }

  status() {
    return {
      peerId: this.peerId,
      connected: this.connected,
      queued: this.queue.length,
      keys: this.state.size,
      peers: [...this.peerVersions.keys()],
      conflicts: this.conflicts.length,
      lastError: this.lastError,
      version: this.clock,
    };
  }

  clearConflicts() { this.conflicts = []; this._persist(); }

  /* ------------------------------------------------------------- remote API */

  /**
   * Apply a record received from another peer. Returns
   * {applied, reason} — `reason` explains a rejection, which the UI shows
   * rather than hiding a dropped update.
   */
  receive(record) {
    if (!record || typeof record !== 'object') return { applied: false, reason: 'Malformed record.' };
    const id = String(record.id || '');
    if (!id) return { applied: false, reason: 'Record has no id.' };
    if (this.seenIds.has(id)) return { applied: false, reason: 'duplicate', duplicate: true };
    if (typeof record.key !== 'string' || !record.key) return { applied: false, reason: 'Record has no key.' };
    if (!Number.isFinite(record.version)) return { applied: false, reason: 'Record has no version.' };
    if (record.peerId === this.peerId) {
      // Our own record echoed back. Remember it so a later replay is ignored.
      this._rememberId(id);
      return { applied: false, reason: 'own-echo' };
    }
    if (!isSyncableValue(record.value) && record.value !== null) {
      this._rememberId(id);
      return { applied: false, reason: 'Value too large or not serializable.' };
    }

    const existing = this.state.get(record.key);
    if (existing) {
      // Version ordering. A tie is broken by peerId so two peers that somehow
      // reach the same version still converge deterministically instead of
      // flip-flopping.
      const newer = record.version > existing.version
        || (record.version === existing.version && String(record.peerId) > String(existing.peerId));
      if (!newer) {
        this._rememberId(id);
        const conflict = this._conflict('stale', record,
          `Ignored an older update for "${record.key}" (remote v${record.version} from ${record.peerId}; local v${existing.version} from ${existing.peerId}).`);
        this.conflicts.push(conflict);
        this.onConflict(conflict);
        this._persist();
        return { applied: false, reason: 'stale', conflict };
      }
    }

    this._rememberId(id);
    const applied = this._applyLocal({ ...record, origin: 'remote' });
    // Track the peer's high-water mark so a peer that reconnects with an old
    // clock is visibly stale rather than silently authoritative.
    const known = this.peerVersions.get(record.peerId) || 0;
    if (record.version > known) this.peerVersions.set(record.peerId, record.version);
    if (applied) this.onState(record.key, record.value, { ...record, origin: 'remote' });
    return { applied: true };
  }

  /**
   * Bulk ingest, e.g. the state a peer hands over on reconnect. Applied in
   * version order so an out-of-order batch still converges.
   */
  receiveBatch(records) {
    const list = Array.isArray(records) ? records.slice() : [];
    list.sort((a, b) => (Number(a.version) || 0) - (Number(b.version) || 0));
    const results = list.map(r => ({ key: r && r.key, ...this.receive(r) }));
    return { received: results.length, applied: results.filter(r => r.applied).length, results };
  }

  /**
   * Reconcile after a reconnect: tell a peer what we hold so it can send
   * anything newer, and ask for what it holds.
   */
  async reconcile(remoteSummary = []) {
    const mine = this.snapshot();
    const byKey = new Map(mine.map(e => [e.key, e]));
    const missing = [];
    for (const entry of Array.isArray(remoteSummary) ? remoteSummary : []) {
      if (!entry || typeof entry.key !== 'string') continue;
      const local = byKey.get(entry.key);
      if (!local || Number(entry.version) > Number(local.version)) missing.push(entry.key);
    }
    const localOnly = mine.filter(e => !(remoteSummary || []).some(r => r && r.key === e.key)).map(e => e.key);
    return { missing, localOnly, summary: mine };
  }

  /* --------------------------------------------------------------- internals */

  _applyLocal(record) {
    this.state.set(record.key, {
      value: record.value === undefined ? null : record.value,
      version: record.version,
      peerId: record.peerId,
      kind: record.kind || 'state',
      agentId: record.agentId || null,
      updatedAt: record.updatedAt || this.now(),
    });
    if (record.version > this.clock && record.peerId !== this.peerId) {
      // Adopt a higher remote clock so our next local edit is strictly newer.
      this.clock = record.version;
    }
    return true;
  }

  _rememberId(id) {
    this.seenIds.add(id);
    this.seenOrder.push(id);
    // Bound the dedupe set: it grows forever otherwise on a long session.
    while (this.seenOrder.length > MAX_SEEN_IDS) {
      const old = this.seenOrder.shift();
      this.seenIds.delete(old);
    }
  }

  _conflict(kind, record, message) {
    return {
      id: newId('conf'),
      kind,
      key: record && record.key ? record.key : null,
      peerId: record && record.peerId ? record.peerId : null,
      version: record && record.version !== undefined ? record.version : null,
      message,
      at: this.now(),
    };
  }

  _emitStatus() {
    try { this.onStatus(this.status()); } catch { /* a UI listener must not break sync */ }
  }

  _persist() {
    if (!this.store || typeof this.store.persist !== 'function') return;
    try {
      this.store.persist({
        peerId: this.peerId,
        clock: this.clock,
        queue: this.queue,
        state: [...this.state.entries()],
        seenOrder: this.seenOrder,
        conflicts: this.conflicts.slice(-50),
      });
    } catch (error) { this.lastError = 'Persist failed: ' + String(error && error.message || error); }
  }

  _loadQueue() {
    if (!this.store || typeof this.store.load !== 'function') return;
    let data = null;
    try { data = this.store.load(); }
    catch (error) { this.lastError = 'Restore failed: ' + String(error && error.message || error); return; }
    if (!data || typeof data !== 'object') return;
    if (data.peerId) this.peerId = String(data.peerId);
    if (Number.isFinite(data.clock)) this.clock = data.clock;
    if (Array.isArray(data.queue)) this.queue = data.queue.filter(r => r && r.id && r.key);
    if (Array.isArray(data.state)) {
      for (const [k, v] of data.state) if (typeof k === 'string' && v) this.state.set(k, v);
    }
    if (Array.isArray(data.seenOrder)) {
      for (const id of data.seenOrder) this._rememberId(String(id));
    }
    if (Array.isArray(data.conflicts)) this.conflicts = data.conflicts;
  }
}

/* ------------------------------------------------------------- file-backed store */

/**
 * Durable queue/state backing, written atomically (tmp + rename) so a crash
 * mid-write cannot truncate the record of unsent work.
 */
function fileStore(filePath) {
  const file = String(filePath);
  return {
    persist(data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, file);
    },
    load() {
      if (!fs.existsSync(file)) return null;
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { return null; }   // a corrupt queue must not stop the app
    },
  };
}

/* ------------------------------------------------------------ in-memory transport */

/**
 * A linked pair of in-memory transports for tests and for same-process peers.
 * Delivery is async (next tick) so ordering and reconnect behaviour are
 * exercised rather than hidden by synchronous calls.
 */
function memoryLink(options = {}) {
  const delay = Number.isFinite(options.delay) ? options.delay : 0;
  const a = { peers: [], onReceive: null, dropped: 0 };
  const b = { peers: [], onReceive: null, dropped: 0 };
  a.peers.push(b); b.peers.push(a);
  const make = (self) => ({
    send(record) {
      if (self.faulty) { self.dropped++; return Promise.reject(new Error('transport down')); }
      for (const peer of self.peers) {
        if (!peer.onReceive) { self.dropped++; continue; }
        const cb = peer.onReceive;
        const deliver = () => { try { cb(JSON.parse(JSON.stringify(record))); } catch { /* peer went away */ } };
        if (delay > 0) setTimeout(deliver, delay); else setImmediate(deliver);
      }
      return Promise.resolve();
    },
    onReceive(cb) { self.onReceive = cb; },
    get faulty() { return !!self.faulty; },
    setFaulty(v) { self.faulty = !!v; },
    get dropped() { return self.dropped; },
  });
  return { a: make(a), b: make(b), raw: { a, b } };
}

module.exports = {
  SyncEngine,
  fileStore,
  memoryLink,
  newId,
  sizeOf,
  isSyncableValue,
  STATE_KINDS,
  MAX_QUEUE,
  MAX_VALUE_BYTES,
};
