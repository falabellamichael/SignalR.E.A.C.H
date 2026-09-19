'use strict';

/* Connections: multi-endpoint settings model (VS Code extension parity).
 *
 * The contract that matters:
 *  - a legacy settings.json (single endpoint/accessKey/model) migrates to one
 *    connection without losing anything, on first read;
 *  - the legacy fields stay a PROJECTION of the active connection, so every
 *    existing consumer of settings.endpoint keeps working;
 *  - normalize is idempotent and never mutates its input;
 *  - activating/adding/removing keeps the projection in step;
 *  - bad ids fall back instead of leaving the app endpoint-less.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../agent/connections.cjs');

const LEGACY = { endpoint: 'https://api.nexus-projects.ai/v1', accessKey: 'sk-legacy', model: 'Qwen/Qwen3.8-27B-FP8', theme: 'dark' };

test('a legacy single-endpoint settings object migrates to one connection', () => {
  const { settings, migrated } = C.normalizeSettings(LEGACY);
  assert.equal(migrated, true);
  assert.equal(settings.connections.length, 1);
  const c = settings.connections[0];
  assert.equal(c.endpoint, LEGACY.endpoint);
  assert.equal(c.accessKey, 'sk-legacy');
  assert.equal(c.model, LEGACY.model);
  assert.ok(c.id, 'gets a stable id');
  // The name falls back to the hostname: legible in the picker, unlike the URL.
  assert.equal(c.name, 'api.nexus-projects.ai');
  assert.equal(settings.activeConnection, c.id);
  // Unrelated settings survive migration untouched.
  assert.equal(settings.theme, 'dark');
});

test('the legacy endpoint/accessKey/model fields project the ACTIVE connection', () => {
  const one = C.addConnection(LEGACY, { endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE-1', model: 'm-b' });
  assert.equal(one.error, undefined);
  // The new connection was activated, so the projection follows it.
  assert.equal(one.settings.endpoint, 'https://b.example.com/v1');
  assert.equal(one.settings.accessKey, 'B-FIXTURE-1');
  assert.equal(one.settings.model, 'm-b');
  // Switching back re-projects the original.
  const legacyId = one.settings.connections.find(c => c.endpoint === LEGACY.endpoint).id;
  const back = C.setActiveConnection(one.settings, legacyId);
  assert.equal(back.settings.endpoint, LEGACY.endpoint);
  assert.equal(back.settings.accessKey, 'sk-legacy');
  assert.equal(back.settings.model, LEGACY.model);
});

test('normalize is idempotent and does not mutate its input', () => {
  const input = JSON.parse(JSON.stringify(LEGACY));
  const first = C.normalizeSettings(input).settings;
  const second = C.normalizeSettings(first).settings;
  assert.deepEqual(second.connections, first.connections, 'ids and order stable across re-normalize');
  assert.equal(second.activeConnection, first.activeConnection);
  // The original object was never touched.
  assert.equal(input.connections, undefined);
  assert.equal(input.endpoint, LEGACY.endpoint);
});

test('a stale activeConnection id falls back to a real connection, never to none', () => {
  const two = C.addConnection(LEGACY, { endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE-1' }).settings;
  const broken = { ...two, activeConnection: 'conn_deleted' };
  const { settings } = C.normalizeSettings(broken);
  assert.ok(settings.connections.some(c => c.id === settings.activeConnection));
  const active = C.activeConnection(settings);
  assert.ok(active, 'always resolves to something when a connection exists');
  assert.equal(settings.endpoint, active.endpoint, 'projection matches the resolved active');
});

test('add rejects duplicates, empty endpoints, and enforces the cap', () => {
  const dup = C.addConnection(LEGACY, { endpoint: 'https://api.nexus-projects.ai/v1/' });
  assert.match(dup.error, /already configured/, 'trailing-slash spelling is still a duplicate');
  const empty = C.addConnection(LEGACY, { endpoint: '   ' });
  assert.match(empty.error, /endpoint URL is required/);
  let s = LEGACY;
  for (let i = 0; i < C.MAX_CONNECTIONS - 1; i++) {
    const r = C.addConnection(s, { endpoint: `https://e${i}.example.com/v1` });
    assert.equal(r.error, undefined, `add #${i}: ${r.error}`);
    s = r.settings;
  }
  const overflow = C.addConnection(s, { endpoint: 'https://overflow.example.com/v1' });
  assert.match(overflow.error, /At most \d+ connections/);
});

test('update changes only the fields given, and keeps the id across an endpoint rename', () => {
  const base = C.normalizeSettings(LEGACY).settings;
  const id = base.connections[0].id;
  // Editing the name must NOT clear the access key (partial update semantics).
  const renamed = C.updateConnection(base, id, { name: 'Nexus' });
  assert.equal(renamed.connection.name, 'Nexus');
  assert.equal(renamed.connection.accessKey, 'sk-legacy', 'key survived a name-only edit');
  assert.equal(renamed.connection.id, id);
  // Renaming the endpoint keeps identity, so the key stays with the connection.
  const moved = C.updateConnection(renamed.settings, id, { endpoint: 'https://api.nexus2.ai/v1' });
  assert.equal(moved.error, undefined);
  assert.equal(moved.connection.id, id, 'id is stable across an endpoint change');
  assert.equal(moved.connection.accessKey, 'sk-legacy');
  assert.equal(moved.settings.endpoint, 'https://api.nexus2.ai/v1', 'active projection followed the rename');
  assert.match(C.updateConnection(base, id, { endpoint: '' }).error, /endpoint URL is required/);
  assert.match(C.updateConnection(base, 'conn_nope', { name: 'x' }).error, /Unknown connection/);
});

test('remove keeps at least one connection and re-activates a survivor', () => {
  const two = C.addConnection(LEGACY, { endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE-1' }).settings;
  const bId = two.connections.find(c => c.endpoint === 'https://b.example.com/v1').id;
  const legacyId = two.connections.find(c => c.endpoint === LEGACY.endpoint).id;
  // Active is b (add activates); removing it must fall to the survivor.
  assert.equal(two.activeConnection, bId);
  const removed = C.removeConnection(two, bId);
  assert.equal(removed.error, undefined);
  assert.equal(removed.settings.connections.length, 1);
  assert.equal(removed.settings.activeConnection, legacyId);
  assert.equal(removed.settings.endpoint, LEGACY.endpoint, 'projection re-pointed at the survivor');
  // The last connection cannot be removed.
  assert.match(C.removeConnection(removed.settings, legacyId).error, /At least one connection/);
  assert.match(C.removeConnection(two, 'conn_nope').error, /Unknown connection/);
});

test('setActive rejects unknown ids instead of silently switching providers', () => {
  const base = C.normalizeSettings(LEGACY).settings;
  assert.match(C.setActiveConnection(base, 'conn_nope').error, /Unknown connection/);
});

test('garbage settings normalize to empty instead of throwing', () => {
  for (const junk of [null, undefined, 42, 'x', [], { connections: 'nope' }, { connections: [null, 7, {}, { endpoint: '' }] }]) {
    const { settings } = C.normalizeSettings(junk);
    assert.ok(Array.isArray(settings.connections));
    assert.equal(C.activeConnection(settings), null);
    assert.equal(settings.endpoint, '');
  }
});

test('duplicate stored ids are re-keyed, not merged', () => {
  const dupe = { id: 'conn_same', endpoint: 'https://a.example.com/v1', accessKey: 'A-FIXTURE-1' };
  const { settings } = C.normalizeSettings({ connections: [dupe, { ...dupe, endpoint: 'https://b.example.com/v1' }] });
  assert.equal(settings.connections.length, 2);
  assert.notEqual(settings.connections[0].id, settings.connections[1].id, 'second entry got a fresh id');
});

test('publicConnections exposes the list plus the resolved active for the UI', () => {
  const pub = C.publicConnections(C.addConnection(LEGACY, { endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE-1', name: 'B' }).settings);
  assert.equal(pub.connections.length, 2);
  assert.equal(pub.activeName, 'B');
  assert.equal(pub.activeEndpoint, 'https://b.example.com/v1');
  assert.ok(pub.connections.every(c => 'accessKey' in c), 'UI needs the key to render its own field');
});

test('findConnection tolerates un-normalized settings', () => {
  // A caller holding a raw legacy object must still resolve the migrated id.
  const found = C.findConnection(LEGACY, C.normalizeSettings(LEGACY).settings.connections[0].id);
  assert.ok(found);
  assert.equal(found.endpoint, LEGACY.endpoint);
  assert.equal(C.findConnection(LEGACY, 'conn_nope'), null);
  assert.equal(C.findConnection(LEGACY, ''), null);
});

/* ------------------------------------------------ legacy write compatibility */

test('applyLegacyWrite folds a single-endpoint save into the ACTIVE connection', () => {
  // The smoke suite and pre-feature code paths call saveSettings({endpoint,
  // accessKey, model}). Without this, normalizeSettings() would derive those
  // fields back from the active connection and the write would vanish.
  const base = C.normalizeSettings(LEGACY).settings;
  const out = C.applyLegacyWrite({ ...base, endpoint: 'http://127.0.0.1:9/v1', accessKey: 'SMOKE-FIXTURE-1', model: 'fixture' });
  const reread = C.normalizeSettings(out).settings;
  assert.equal(reread.endpoint, 'http://127.0.0.1:9/v1', 'the endpoint write survived a re-read');
  assert.equal(reread.accessKey, 'SMOKE-FIXTURE-1');
  assert.equal(reread.model, 'fixture');
  assert.equal(reread.connections.length, 1, 'edited in place, did not add a connection');
  const active = C.activeConnection(reread);
  assert.equal(active.endpoint, 'http://127.0.0.1:9/v1', 'the connection itself changed');
});

test('applyLegacyWrite only edits the active connection, leaving others alone', () => {
  const two = C.addConnection(LEGACY, { endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE-1', model: 'm-b' }).settings;
  // add activates B; write to it and confirm the legacy A connection is untouched.
  assert.equal(two.activeConnection, two.connections.find(c => c.endpoint === 'https://b.example.com/v1').id);
  const out = C.applyLegacyWrite({ ...two, endpoint: 'https://b2.example.com/v1' });
  const after = C.normalizeSettings(out).settings;
  assert.equal(after.connections.length, 2);
  const a = after.connections.find(c => c.endpoint === LEGACY.endpoint);
  assert.ok(a, 'the other connection still exists');
  assert.equal(a.accessKey, 'sk-legacy', 'and kept its own key');
  assert.equal(after.endpoint, 'https://b2.example.com/v1');
});

test('applyLegacyWrite never clears a key when the write omits it', () => {
  const base = C.normalizeSettings(LEGACY).settings;
  // A theme-only or model-only save must not blank the access key.
  const out = C.applyLegacyWrite({ ...base, model: 'only-model' });
  const after = C.normalizeSettings(out).settings;
  assert.equal(after.model, 'only-model');
  assert.equal(after.accessKey, 'sk-legacy', 'key preserved when the write omits it');
  assert.equal(after.endpoint, LEGACY.endpoint);
});

test('applyLegacyWrite seeds the first connection on a fresh install', () => {
  // Brand-new settings file: no connections array, user types an endpoint in the
  // old-style form. This is the migration path for a first save.
  const out = C.applyLegacyWrite({ endpoint: 'https://fresh.example.com/v1', accessKey: 'FRESH-1', model: 'm1', theme: 'dark' });
  const after = C.normalizeSettings(out).settings;
  assert.equal(after.connections.length, 1);
  assert.equal(after.connections[0].endpoint, 'https://fresh.example.com/v1');
  assert.equal(after.connections[0].accessKey, 'FRESH-1');
  assert.equal(after.connections[0].name, 'fresh.example.com');
  assert.equal(after.activeConnection, after.connections[0].id);
  assert.equal(after.theme, 'dark', 'unrelated settings kept');
});

test('applyLegacyWrite is a no-op without legacy fields and never mutates input', () => {
  const input = { theme: 'light', budgets: { maxTokens: 100 } };
  const snapshot = JSON.parse(JSON.stringify(input));
  assert.equal(C.applyLegacyWrite(input), input, 'returned unchanged when nothing to fold');
  assert.deepEqual(input, snapshot);
  for (const junk of [null, undefined, 7, 'x', []]) assert.equal(C.applyLegacyWrite(junk), junk);
});

test('applyLegacyWrite re-derives an auto name but keeps a name the user typed', () => {
  const base = C.normalizeSettings(LEGACY).settings;   // name is auto: hostname
  assert.equal(base.connections[0].name, 'api.nexus-projects.ai');
  const moved = C.normalizeSettings(C.applyLegacyWrite({ ...base, endpoint: 'https://other.example.com/v1' })).settings;
  assert.equal(moved.connections[0].name, 'other.example.com', 'auto name followed the endpoint');

  const named = C.updateConnection(base, base.connections[0].id, { name: 'My Provider' }).settings;
  const moved2 = C.normalizeSettings(C.applyLegacyWrite({ ...named, endpoint: 'https://third.example.com/v1' })).settings;
  assert.equal(moved2.connections[0].name, 'My Provider', 'a hand-typed name survives an endpoint edit');
});

test('applyLegacyWrite refuses to blank out a working connection', () => {
  const base = C.normalizeSettings(LEGACY).settings;
  const out = C.applyLegacyWrite({ ...base, endpoint: '   ' });
  const after = C.normalizeSettings(out).settings;
  assert.equal(after.endpoint, LEGACY.endpoint, 'an empty endpoint write is ignored');
  assert.equal(after.connections[0].endpoint, LEGACY.endpoint);
});

test('a legacy write then a connection write stay consistent (round trip)', () => {
  // Both write styles target the same store; prove they compose.
  let s = C.applyLegacyWrite({ endpoint: LEGACY.endpoint, accessKey: 'A-FIXTURE-1', model: 'm-a' });
  s = C.addConnection(s, { endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE-1', model: 'm-b' }).settings;
  s = C.applyLegacyWrite({ ...s, model: 'm-b2' });          // edits active (B)
  s = C.setActiveConnection(s, s.connections[0].id).settings; // back to A
  const after = C.normalizeSettings(s).settings;
  assert.equal(after.connections.length, 2);
  assert.equal(after.model, 'm-a', 'A kept its own model');
  const b = after.connections.find(c => c.endpoint === 'https://b.example.com/v1');
  assert.equal(b.model, 'm-b2', 'the legacy write landed on B while B was active');
  assert.equal(b.accessKey, 'B-FIXTURE-1');
});

test('connectionsAuthoritative makes the list win over stale legacy fields', () => {
  // The renderer's connection editor sends the whole list; its legacy
  // endpoint/accessKey/model fields are a stale projection from before the user
  // switched the active row. Folding them in would undo the switch.
  const two = C.addConnection(LEGACY, { endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE-1', model: 'm-b' }).settings;
  const bId = two.connections.find(c => c.endpoint === 'https://b.example.com/v1').id;
  // Pretend the user activated B in the list while the top-level fields still
  // describe A.
  const stale = { ...two, activeConnection: bId, endpoint: LEGACY.endpoint, accessKey: 'sk-legacy', model: LEGACY.model };
  const out = C.applyLegacyWrite(stale, { connectionsAuthoritative: true });
  const after = C.normalizeSettings(out).settings;
  assert.equal(after.activeConnection, bId, 'the explicit activation won');
  assert.equal(after.endpoint, 'https://b.example.com/v1', 'projection recomputed from B, not from the stale fields');
  assert.equal(after.accessKey, 'B-FIXTURE-1');
  assert.equal(after.connections.length, 2);
  // Without the flag the same payload is treated as an edit of the active row.
  const folded = C.normalizeSettings(C.applyLegacyWrite(stale)).settings;
  assert.equal(folded.connections.find(c => c.id === bId).endpoint, LEGACY.endpoint,
    'default behaviour folds legacy fields into the active connection');
});

test('a realistic full-object save from the renderer still applies its edits', () => {
  // The renderer reads settings:get (which now includes connections), edits two
  // fields, and saves the WHOLE object back. This is the exact shape that used to
  // be swallowed by the array-presence guard.
  const loaded = C.normalizeSettings(LEGACY).settings;
  const saved = { ...loaded, reachCli: '/usr/local/bin/reach', endpoint: 'https://edited.example.com/v1', model: 'm-edited' };
  assert.ok(Array.isArray(saved.connections), 'precondition: the payload carries a connections array');
  const after = C.normalizeSettings(C.applyLegacyWrite(saved)).settings;
  assert.equal(after.endpoint, 'https://edited.example.com/v1');
  assert.equal(after.model, 'm-edited');
  assert.equal(after.reachCli, '/usr/local/bin/reach', 'non-connection settings pass through');
  assert.equal(after.connections.length, 1);
});

/* --------------------------------------------------------- scopedSettings() */

test('scopedSettings routes a consumer at a NON-active connection', () => {
  // This is what lets playground/refactor pass connectionId without rewriting
  // their endpoint logic: they keep reading settings.endpoint/accessKey, and the
  // scoped view points those at the chosen connection.
  const two = C.addConnection(LEGACY, { endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE-1', model: 'm-b' }).settings;
  const a = two.connections.find(c => c.endpoint === LEGACY.endpoint);
  const b = two.connections.find(c => c.endpoint === 'https://b.example.com/v1');
  assert.equal(two.activeConnection, b.id, 'precondition: B is active after add');

  const scopedA = C.scopedSettings(two, a.id);
  assert.equal(scopedA.endpoint, LEGACY.endpoint, 'scoped to A');
  assert.equal(scopedA.accessKey, 'sk-legacy', "A's own key, not the active one's");
  assert.equal(scopedA.model, LEGACY.model);

  const scopedB = C.scopedSettings(two, b.id);
  assert.equal(scopedB.endpoint, 'https://b.example.com/v1');
  assert.equal(scopedB.accessKey, 'B-FIXTURE-1');
});

test('scopedSettings falls back to the active connection for unknown/absent ids', () => {
  const base = C.normalizeSettings(LEGACY).settings;
  // A stale id (connection deleted elsewhere) must NOT produce an empty view:
  // that would surface as "No endpoint configured" while one plainly is.
  for (const bad of ['conn_deleted', '', null, undefined, 42, {}]) {
    const s = C.scopedSettings(base, bad);
    assert.equal(s.endpoint, LEGACY.endpoint, `fallback for ${JSON.stringify(bad)}`);
    assert.equal(s.accessKey, 'sk-legacy');
  }
});

test('scopedSettings does not mutate the settings it was given', () => {
  const base = C.normalizeSettings(LEGACY).settings;
  const snapshot = JSON.parse(JSON.stringify(base));
  C.scopedSettings(base, base.connections[0].id);
  assert.deepEqual(base, snapshot);
});

test('a scoped view can differ from the globally active connection', () => {
  // The whole point of scoping: the playground may run against A while the
  // globally active connection (what agent chats use) is B. Assert that plainly.
  const two = C.addConnection(LEGACY, { endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE-1' }).settings;
  const a = two.connections.find(c => c.endpoint === LEGACY.endpoint);
  const b = two.connections.find(c => c.endpoint === 'https://b.example.com/v1');
  assert.equal(two.activeConnection, b.id, 'precondition: B is globally active');

  const scopedA = C.scopedSettings(two, a.id);
  assert.equal(scopedA.endpoint, LEGACY.endpoint, 'scoped to A');
  assert.equal(two.endpoint, 'https://b.example.com/v1', 'unscoped settings still project B');
  assert.notEqual(scopedA.endpoint, two.endpoint, 'the scoped view is independent of the active one');

  // And the scoped view still carries the full list + global active, so a caller
  // can render a picker without a second round trip.
  assert.equal(scopedA.connections.length, 2);
  assert.equal(scopedA.activeConnection, b.id, 'scoping does not change which connection is globally active');
});

test('scopedSettings on empty settings yields no endpoint rather than throwing', () => {
  const s = C.scopedSettings({}, 'anything');
  assert.equal(s.endpoint, '');
  assert.equal(s.accessKey, '');
  assert.equal(C.activeConnection(s), null);
});

test('names and endpoints are clipped to sane bounds', () => {
  const long = 'x'.repeat(5000);
  const r = C.addConnection(LEGACY, { endpoint: 'https://c.example.com/v1', name: long, accessKey: long, model: long });
  assert.equal(r.error, undefined);
  const c = r.settings.connections.find(x => x.endpoint === 'https://c.example.com/v1');
  assert.ok(c.name.length <= C.MAX_NAME_CHARS);
  assert.ok(c.accessKey.length <= 4096);
  assert.ok(c.model.length <= 200);
});
