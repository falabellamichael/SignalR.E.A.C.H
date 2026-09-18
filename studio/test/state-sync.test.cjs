'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SyncEngine, fileStore, memoryLink, STATE_KINDS } = require('../agent/state-sync.cjs');

const tick = (n = 8) => new Promise(resolve => {
  let i = 0;
  const step = () => (i++ >= n ? resolve() : setImmediate(step));
  step();
});

test('two connected peers sync in both directions', async () => {
  const link = memoryLink();
  const received = [];
  const a = new SyncEngine({ peerId: 'studio', transport: link.a, onState: (k, v) => received.push([k, v]) });
  const b = new SyncEngine({ peerId: 'vscode', transport: link.b });
  a.connect(link.a); b.connect(link.b);
  await a.set('agent:1:conversation', [{ role: 'user', content: 'hi' }], { kind: 'conversation', agentId: '1' });
  await tick();
  assert.equal(b.get('agent:1:conversation')[0].content, 'hi');
  await b.set('agent:1:todos', [{ id: '1', status: 'pending' }], { kind: 'todos' });
  await tick();
  assert.equal(a.get('agent:1:todos')[0].status, 'pending');
  assert.equal(a.status().keys, 2);
  assert.equal(b.status().keys, 2);
});

test('offline updates queue locally and drain on reconnect', async () => {
  const link = memoryLink();
  const b = new SyncEngine({ peerId: 'vscode', transport: link.b });
  b.connect(link.b);
  const a = new SyncEngine({ peerId: 'studio', transport: link.a });   // never connected yet
  const first = await a.set('k1', 'v1', { kind: 'context' });
  assert.equal(first.delivered, false);
  assert.equal(first.queued, true);
  await a.set('k2', 'v2', { kind: 'context' });
  await a.set('k3', 'v3', { kind: 'context' });
  assert.equal(a.status().queued, 3);
  assert.equal(b.get('k1'), undefined, 'nothing arrived while offline');
  a.connect(link.a);
  await tick(12);
  assert.equal(a.status().queued, 0, 'queue drained');
  assert.equal(b.get('k1'), 'v1');
  assert.equal(b.get('k2'), 'v2');
  assert.equal(b.get('k3'), 'v3');
});

test('a send failure mid-session marks disconnected, queues, and auto-resyncs', async () => {
  const link = memoryLink();
  const a = new SyncEngine({ peerId: 'studio', transport: link.a });
  const b = new SyncEngine({ peerId: 'vscode', transport: link.b });
  a.connect(link.a); b.connect(link.b);
  await a.set('x', 1, { kind: 'context' }); await tick();
  assert.equal(b.get('x'), 1);
  link.raw.a.faulty = true;
  const res = await a.set('y', 2, { kind: 'context' });
  assert.equal(res.delivered, false);
  assert.equal(res.queued, true);
  assert.equal(a.status().connected, false);
  assert.equal(typeof res.error, 'string');
  link.raw.a.faulty = false;
  a.connect(link.a);
  await tick(12);
  assert.equal(b.get('y'), 2, 'queued record delivered after reconnect');
  assert.equal(a.status().queued, 0);
});

test('duplicate delivery is idempotent', () => {
  const b = new SyncEngine({ peerId: 'vscode' });
  const rec = { id: 'rec_fixed', kind: 'context', key: 'k', value: 'V', version: 5, peerId: 'studio', updatedAt: 1 };
  assert.equal(b.receive(rec).applied, true);
  assert.equal(b.receive(rec).duplicate, true);
  assert.equal(b.receive(rec).applied, false);
  assert.equal(b.status().keys, 1);
});

test('a stale remote update is rejected and the conflict is reported', () => {
  const conflicts = [];
  const b = new SyncEngine({ peerId: 'vscode', onConflict: c => conflicts.push(c) });
  b.receive({ id: 'r9', kind: 'context', key: 'shared', value: 'v9', version: 9, peerId: 'studio', updatedAt: 1 });
  b.receive({ id: 'r11', kind: 'context', key: 'shared', value: 'v11', version: 11, peerId: 'studio', updatedAt: 1 });
  b.receive({ id: 'r5', kind: 'context', key: 'shared', value: 'v5', version: 5, peerId: 'studio', updatedAt: 1 });
  assert.equal(b.get('shared'), 'v11', 'newest wins');
  assert.equal(b.conflicts.length, 1, 'the stale update was recorded, not dropped silently');
  assert.match(b.conflicts[0].message, /older update/i);
  assert.equal(conflicts.length, 1, 'onConflict fired');
});

test('same-version edits from two peers converge deterministically', () => {
  const recX = { id: 'cx', kind: 'context', key: 'k', value: 'fromX', version: 3, peerId: 'peerX', updatedAt: 1 };
  const recY = { id: 'cy', kind: 'context', key: 'k', value: 'fromY', version: 3, peerId: 'peerY', updatedAt: 1 };
  const a = new SyncEngine({ peerId: 'studio' });
  const b = new SyncEngine({ peerId: 'vscode' });
  a.receive(recX); a.receive(recY);
  b.receive(recY); b.receive(recX);
  assert.equal(a.get('k'), b.get('k'), 'both peers agree');
  assert.equal(a.get('k'), 'fromY', 'tie broken by the higher peerId');
  const c = new SyncEngine({ peerId: 'third' });
  c.receive(recY); c.receive(recX);
  assert.equal(c.get('k'), 'fromY');
});

test('malformed and self-originated records are refused', () => {
  const b = new SyncEngine({ peerId: 'vscode' });
  const bad = [null, undefined, {}, { key: 'k' }, { id: 'x' }, { id: 'x', key: 'k' },
    { id: 'x', key: 'k', version: NaN }, { id: 'x', key: 'k', version: 1, value: 'v', peerId: 'vscode' }];
  for (const rec of bad) assert.equal(b.receive(rec).applied, false, 'refused: ' + JSON.stringify(rec));
  assert.equal(b.status().keys, 0);
});

test('an echo of our own peerId is never applied', async () => {
  const link = memoryLink();
  const a = new SyncEngine({ peerId: 'same', transport: link.a });
  const b = new SyncEngine({ peerId: 'same', transport: link.b });
  a.connect(link.a); b.connect(link.b);
  await a.set('e', 1, { kind: 'context' });
  await tick(10);
  assert.equal(b.status().keys, 0);
});

test('state kinds are validated and non-serializable values refused', async () => {
  const a = new SyncEngine({ peerId: 'studio' });
  await assert.rejects(() => a.set('k', 'v', { kind: 'not-a-real-kind' }));
  await assert.rejects(() => a.set('k', () => {}));
  const circular = {}; circular.self = circular;
  await assert.rejects(() => a.set('k', circular));
  await assert.rejects(() => a.set('', 'v', { kind: 'context' }));
  for (const kind of STATE_KINDS) await a.set('ok:' + kind, { kind }, { kind });
  assert.equal(a.status().keys, STATE_KINDS.size);
});

test('a full queue drops the oldest record and reports it', async () => {
  const a = new SyncEngine({ peerId: 'studio', maxQueue: 3 });
  for (let i = 1; i <= 6; i++) await a.set('k' + i, i, { kind: 'context' });
  assert.equal(a.status().queued, 3);
  assert.deepEqual(a.queue.map(r => r.key), ['k4', 'k5', 'k6'], 'newest kept');
  assert.equal(a.conflicts.length, 3);
  assert.ok(a.conflicts.every(c => c.kind === 'queue-overflow'));
});

test('a delete propagates as a tombstone', async () => {
  const link = memoryLink();
  const a = new SyncEngine({ peerId: 'studio', transport: link.a });
  const b = new SyncEngine({ peerId: 'vscode', transport: link.b });
  a.connect(link.a); b.connect(link.b);
  await a.set('gone', 'here', { kind: 'conversation' }); await tick();
  assert.equal(b.get('gone'), 'here');
  await a.delete('gone', { kind: 'conversation' }); await tick();
  assert.equal(b.get('gone'), null, 'tombstone, not the stale value');
  assert.equal(b.snapshot().find(e => e.key === 'gone').deleted, true);
});

test('reconcile identifies stale, missing and local-only keys', async () => {
  const a = new SyncEngine({ peerId: 'studio' });
  await a.set('k1', 'v1', { kind: 'context' });
  await a.set('k2', 'v2', { kind: 'context' });
  const rec = await a.reconcile([{ key: 'k1', version: 99 }, { key: 'k3', version: 1 }]);
  assert.ok(rec.missing.includes('k1'), 'remote v99 beats our v1');
  assert.ok(rec.missing.includes('k3'), 'we do not have k3');
  assert.ok(rec.localOnly.includes('k2'), 'the peer has no k2');
});

test('an out-of-order batch still converges on the highest version', () => {
  const b = new SyncEngine({ peerId: 'vscode' });
  const res = b.receiveBatch([
    { id: 'b3', kind: 'context', key: 'k', value: 'v3', version: 3, peerId: 'studio' },
    { id: 'b1', kind: 'context', key: 'k', value: 'v1', version: 1, peerId: 'studio' },
    { id: 'b2', kind: 'context', key: 'k', value: 'v2', version: 2, peerId: 'studio' },
  ]);
  assert.equal(res.received, 3);
  assert.equal(b.get('k'), 'v3');
});

test('queued work survives a restart via the durable store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  const file = path.join(dir, 'sync.json');
  const link = memoryLink();
  link.raw.a.faulty = true;
  const a = new SyncEngine({ peerId: 'studio', transport: link.a, store: fileStore(file) });
  a.connect(link.a);
  await a.set('persisted', { msg: 'hello' }, { kind: 'context' });
  assert.equal(a.status().queued, 1);
  assert.equal(fs.existsSync(file), true);

  const link2 = memoryLink();
  const b = new SyncEngine({ peerId: 'vscode', transport: link2.b });
  b.connect(link2.b);
  const a2 = new SyncEngine({ transport: link2.a, store: fileStore(file) });
  assert.equal(a2.peerId, 'studio', 'peerId restored');
  assert.equal(a2.queue.length, 1, 'queue restored');
  assert.equal(a2.get('persisted').msg, 'hello', 'state restored');
  a2.connect(link2.a);
  await tick(12);
  assert.equal(a2.status().queued, 0);
  assert.equal(b.get('persisted').msg, 'hello', 'queued work reached the peer after restart');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt store degrades to empty instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync2-'));
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  const engine = new SyncEngine({ store: fileStore(file) });
  assert.equal(engine.status().queued, 0);
  assert.equal(engine.status().keys, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomic persist leaves no temp files behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync3-'));
  const file = path.join(dir, 's.json');
  const store = fileStore(file);
  store.persist({ queue: [], state: [] });
  store.persist({ queue: [{ id: 'x' }], state: [] });
  assert.deepEqual(fs.readdirSync(dir), ['s.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status and snapshot are JSON-safe for IPC', async () => {
  const a = new SyncEngine({ peerId: 'studio' });
  await a.set('a', { deep: { nest: [1, 2, 3] } }, { kind: 'context', agentId: 'ag1' });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(a.status())));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(a.snapshot())));
  const snap = a.snapshot();
  assert.equal(snap[0].key, 'a');
  assert.equal(snap[0].agentId, 'ag1');
  assert.ok(snap[0].bytes > 0);
});
