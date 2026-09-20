'use strict';

/* Per-member team connection resolution + the enabled pool.
 *
 * The precedence rules are the whole feature: pin > spread > fallback, with a
 * stale pin degrading to unpinned. Getting it wrong sends model ids to endpoints
 * that do not have them, which costs the user tokens and produces confusing
 * failures mid-run — so each rule gets its own test rather than one happy path.
 *
 * Access keys in these fixtures are deliberately NOT credential-shaped: the
 * write_file secret-mask rewrites anything that looks like a real key.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../agent/connections.cjs');
const T = require('../agent/team-connections.cjs');

const { resolveTeamConnections, summarizeResolutions, hasUnresolvableMember, unsupportedTeamModels, REASON } = T;

/** Build settings with N connections; connection 1 is active unless told. */
function settingsWith(specs, { active = 0, enabled } = {}) {
  let s = {};
  specs.forEach((spec, i) => {
    const r = i === 0
      ? C.normalizeSettings({ endpoint: spec.endpoint, accessKey: spec.key || '', model: spec.model || '' })
      : C.addConnection(s, { endpoint: spec.endpoint, accessKey: spec.key || '', model: spec.model || '' });
    s = r.settings;
  });
  if (specs.length > 1) s = C.setActiveConnection(s, s.connections[active].id).settings;
  if (Array.isArray(enabled)) {
    for (const [i, on] of enabled.entries()) {
      const id = s.connections[i].id;
      if (id === s.activeConnection && !on) continue; // invariant would refuse
      s = C.setConnectionEnabled(s, id, on).settings;
    }
  }
  return s;
}

const persona = (id, extra = {}) => ({ id, name: id, model: '', ...extra });

/* ------------------------------------------------------- the enabled pool --- */

test('connections default to enabled, so existing settings keep working', () => {
  const { settings } = C.normalizeSettings({ endpoint: 'https://a.example.com/v1', accessKey: 'A-FIXTURE' });
  assert.equal(settings.connections.length, 1);
  assert.equal(settings.connections[0].enabled, true, 'absent enabled must mean enabled');
  assert.deepEqual(C.enabledPool(settings).map(c => c.id), [settings.activeConnection]);
});

test('enabledPool returns only enabled connections, in stored order', () => {
  const s = settingsWith([
    { endpoint: 'https://a.example.com/v1', model: 'm-a' },
    { endpoint: 'https://b.example.com/v1', model: 'm-b' },
    { endpoint: 'https://c.example.com/v1', model: 'm-c' },
  ], { active: 0, enabled: [true, false, true] });
  assert.deepEqual(
    C.enabledPool(s).map(c => c.endpoint),
    ['https://a.example.com/v1', 'https://c.example.com/v1'],
    'disabled B is excluded and C keeps its stored position',
  );
});

test('the ACTIVE connection cannot be disabled — it is the team fallback', () => {
  const s = settingsWith([
    { endpoint: 'https://a.example.com/v1' },
    { endpoint: 'https://b.example.com/v1' },
  ], { active: 0 });
  const res = C.setConnectionEnabled(s, s.activeConnection, false);
  assert.equal(res.ok, false);
  assert.match(res.error, /active connection cannot be disabled/i);
  assert.equal(res.settings.connections[0].enabled, true, 'state unchanged after refusal');
});

test('the last enabled connection cannot be disabled', () => {
  const s2 = settingsWith([
    { endpoint: 'https://a.example.com/v1' },
    { endpoint: 'https://b.example.com/v1' },
    { endpoint: 'https://c.example.com/v1' },
  ], { active: 0 });
  const offB = C.setConnectionEnabled(s2, s2.connections[1].id, false);
  assert.equal(offB.ok, true);
  const offC = C.setConnectionEnabled(offB.settings, offB.settings.connections[2].id, false);
  assert.equal(offC.ok, true, 'A is still enabled so disabling C is allowed');
  assert.equal(C.enabledPool(offC.settings).length, 1);
  // Now only A (active) is enabled; disabling it hits the active rule, which is
  // the stronger guard — either way the pool can never reach zero.
  const offA = C.setConnectionEnabled(offC.settings, offC.settings.activeConnection, false);
  assert.equal(offA.ok, false);
  assert.ok(C.enabledPool(offA.settings).length >= 1, 'the pool must never empty out');
});

test('normalizeSettings forces the active connection enabled even if hand-edited', () => {
  const s = settingsWith([
    { endpoint: 'https://a.example.com/v1' },
    { endpoint: 'https://b.example.com/v1' },
  ], { active: 1 });
  // Hand-edit: mark the active one disabled on disk.
  const handEdited = { ...s, connections: s.connections.map(c => ({ ...c, enabled: c.id === s.activeConnection ? false : true })) };
  const { settings: fixed } = C.normalizeSettings(handEdited);
  const active = fixed.connections.find(c => c.id === fixed.activeConnection);
  assert.equal(active.enabled, true, 'the invariant must be repaired on read');
});

test('toggling is idempotent and does not churn ids', () => {
  const s = settingsWith([
    { endpoint: 'https://a.example.com/v1' },
    { endpoint: 'https://b.example.com/v1' },
  ], { active: 0 });
  const id = s.connections[1].id;
  const off = C.setConnectionEnabled(s, id, false);
  const offAgain = C.setConnectionEnabled(off.settings, id, false);
  assert.equal(offAgain.ok, true);
  assert.equal(offAgain.settings.connections[1].id, id);
  assert.equal(offAgain.settings.connections[1].enabled, false);
  const on = C.setConnectionEnabled(offAgain.settings, id, true);
  assert.equal(on.settings.connections[1].enabled, true);
  assert.equal(on.settings.connections[1].id, id);
});

test('enabling/disabling an unknown id is refused', () => {
  const s = settingsWith([{ endpoint: 'https://a.example.com/v1' }]);
  const res = C.setConnectionEnabled(s, 'conn_nope', true);
  assert.equal(res.ok, false);
  assert.match(res.error, /no connection/i);
});

/* ------------------------------------------------- resolution: the basics --- */

const THREE = [
  { endpoint: 'https://a.example.com/v1', model: 'm-a' },
  { endpoint: 'https://b.example.com/v1', model: 'm-b' },
  { endpoint: 'https://c.example.com/v1', model: 'm-c' },
];

test('spread off: every member uses the active connection (fallback)', () => {
  const s = settingsWith(THREE, { active: 1 });
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1'), persona('p2'), persona('p3')] });
  assert.equal(res.length, 3);
  for (const r of res) {
    assert.equal(r.endpoint, 'https://b.example.com/v1', 'all on the active connection');
    assert.equal(r.reason, REASON.FALLBACK);
  }
});

test('spread on: unpinned members round-robin across the enabled pool by index', () => {
  const s = settingsWith(THREE, { active: 0 });
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1'), persona('p2'), persona('p3'), persona('p4')], spread: true });
  assert.deepEqual(res.map(r => r.endpoint), [
    'https://a.example.com/v1',
    'https://b.example.com/v1',
    'https://c.example.com/v1',
    'https://a.example.com/v1',
  ], 'wraps around at the pool length');
  assert.ok(res.every(r => r.reason === REASON.SPREAD));
});

test('spread skips disabled connections entirely', () => {
  const s = settingsWith(THREE, { active: 0, enabled: [true, false, true] });
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1'), persona('p2'), persona('p3')], spread: true });
  assert.deepEqual(res.map(r => r.endpoint), [
    'https://a.example.com/v1',
    'https://c.example.com/v1',
    'https://a.example.com/v1',
  ], 'B is out of the pool so the roster wraps over it');
  assert.ok(!res.some(r => r.endpoint === 'https://b.example.com/v1'));
});

/* ---------------------------------------------------- resolution: pinning --- */

test('a pin beats spread, and pinned members do not punch holes in the rotation', () => {
  const s = settingsWith(THREE, { active: 0 });
  const pin = s.connections[2].id; // C
  const res = resolveTeamConnections({
    settings: s,
    // member 0 pinned to C; members 1..3 unpinned.
    personas: [persona('p1', { connectionId: pin }), persona('p2'), persona('p3'), persona('p4')],
    spread: true,
  });
  assert.equal(res[0].endpoint, 'https://c.example.com/v1', 'pinned member goes to C');
  assert.equal(res[0].reason, REASON.PINNED);
  // The unpinned members must rotate from the START of the pool, not from index
  // 1 — otherwise A would never be used and the spread would be lopsided.
  assert.deepEqual(res.slice(1).map(r => r.endpoint), [
    'https://a.example.com/v1',
    'https://b.example.com/v1',
    'https://c.example.com/v1',
  ], 'unpinned members still get a full gap-free rotation');
  assert.ok(res.slice(1).every(r => r.reason === REASON.SPREAD));
});

test('a pin beats the fallback when spread is off', () => {
  const s = settingsWith(THREE, { active: 1 }); // active = B
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1', { connectionId: s.connections[2].id })] });
  assert.equal(res[0].endpoint, 'https://c.example.com/v1');
  assert.equal(res[0].reason, REASON.PINNED);
});

test('a pin to a DISABLED connection is ignored and reported', () => {
  const s = settingsWith(THREE, { active: 0, enabled: [true, false, true] });
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1', { connectionId: s.connections[1].id })], spread: false });
  assert.notEqual(res[0].endpoint, 'https://b.example.com/v1', 'must not use a disabled connection');
  assert.equal(res[0].reason, REASON.DISABLED_PIN);
  assert.equal(res[0].endpoint, 'https://a.example.com/v1', 'falls back to the active connection');
});

test('a pin to a DELETED connection is ignored and reported', () => {
  const s = settingsWith(THREE, { active: 0 });
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1', { connectionId: 'conn_gone' })], spread: false });
  assert.equal(res[0].reason, REASON.STALE_PIN);
  assert.equal(res[0].endpoint, 'https://a.example.com/v1');
});

test('a stale pin still benefits from spread when spread is on', () => {
  const s = settingsWith(THREE, { active: 0 });
  const res = resolveTeamConnections({
    settings: s,
    personas: [persona('p1', { connectionId: 'conn_gone' }), persona('p2', { connectionId: 'conn_gone2' })],
    spread: true,
  });
  assert.deepEqual(res.map(r => r.endpoint), ['https://a.example.com/v1', 'https://b.example.com/v1'], 'treated as unpinned, so it spreads');
  assert.equal(res[0].stalePin, REASON.STALE_PIN, 'but the UI can still explain the ignored pin');
});

/* ------------------------------------------ resolution: model + key wiring --- */

test('a persona model overrides the connection default', () => {
  const s = settingsWith(THREE, { active: 0 });
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1', { model: 'pinned-model' })] });
  assert.equal(res[0].model, 'pinned-model');
  assert.equal(res[0].endpoint, 'https://a.example.com/v1');
});

test('without a persona model, the RESOLVED connection default is used', () => {
  // This is the point of per-member resolution: after a spread, the global
  // default model may not exist on the endpoint the member landed on.
  const s = settingsWith(THREE, { active: 0 });
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1'), persona('p2')], spread: true, defaultModel: 'global-default' });
  assert.deepEqual(res.map(r => r.model), ['m-a', 'm-b'], 'each member gets its own endpoint default');
  assert.ok(!res.some(r => r.model === 'global-default'), 'the global default is not used when the connection has one');
});

test('the app default is used only when neither persona nor connection has a model', () => {
  const s = settingsWith([{ endpoint: 'https://a.example.com/v1', model: '' }]);
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1')], defaultModel: 'global-default' });
  assert.equal(res[0].model, 'global-default');
});

test('each member carries its OWN connection access key', () => {
  const s = settingsWith([
    { endpoint: 'https://a.example.com/v1', key: 'A-FIXTURE', model: 'm-a' },
    { endpoint: 'https://b.example.com/v1', key: 'B-FIXTURE', model: 'm-b' },
  ], { active: 0 });
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1'), persona('p2')], spread: true });
  assert.equal(res[0].accessKey, 'A-FIXTURE');
  assert.equal(res[1].accessKey, 'B-FIXTURE', 'member 2 must not inherit member 1 key');
});

test('advertised model catalogs catch cross-provider persona routing before launch', () => {
  const s = settingsWith([
    { endpoint: 'https://a.example.com/v1', model: 'm-a' },
    { endpoint: 'https://b.example.com/v1', model: 'm-b' },
  ], { active: 1 });
  const res = resolveTeamConnections({
    settings: s,
    personas: [persona('wrong-provider', { model: 'm-a' }), persona('valid', { model: 'm-b' })],
    spread: false,
  });
  const catalogs = new Map([
    ['https://b.example.com/v1', new Set(['m-b', 'm-b-pro'])],
  ]);
  assert.deepEqual(unsupportedTeamModels(res, catalogs).map(r => r.personaId), ['wrong-provider']);
  assert.deepEqual(unsupportedTeamModels(res, new Map()), [], 'an unavailable /models catalog is not treated as proof of incompatibility');
});

/* --------------------------------------------------- resolution: edge cases --- */

test('an empty roster resolves to an empty list', () => {
  const s = settingsWith(THREE, { active: 0 });
  assert.deepEqual(resolveTeamConnections({ settings: s, personas: [], spread: true }), []);
  assert.deepEqual(resolveTeamConnections({ settings: s, spread: true }), [], 'missing personas is not a crash');
});

test('no connections at all yields reason NONE and is flagged unresolvable', () => {
  const res = resolveTeamConnections({ settings: {}, personas: [persona('p1')], spread: true });
  assert.equal(res.length, 1);
  assert.equal(res[0].reason, REASON.NONE);
  assert.equal(res[0].endpoint, '');
  assert.equal(hasUnresolvableMember(res), true, 'the caller must fail the run rather than call an empty endpoint');
});

test('spread on with an empty pool degrades to the fallback, not to nothing', () => {
  // Only the active connection exists and it is always enabled, so the pool can
  // never truly be empty while a connection exists — but spread with one member
  // of the pool must still work.
  const s = settingsWith([{ endpoint: 'https://a.example.com/v1', model: 'm-a' }]);
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1'), persona('p2')], spread: true });
  assert.deepEqual(res.map(r => r.endpoint), ['https://a.example.com/v1', 'https://a.example.com/v1']);
  assert.equal(res[0].reason, REASON.SPREAD, 'a one-connection pool is still a pool');
});

test('resolution is pure: settings and personas are not mutated', () => {
  const s = settingsWith(THREE, { active: 0 });
  const personas = [persona('p1', { connectionId: s.connections[2].id }), persona('p2')];
  const sBefore = JSON.parse(JSON.stringify(s));
  const pBefore = JSON.parse(JSON.stringify(personas));
  resolveTeamConnections({ settings: s, personas, spread: true });
  assert.deepEqual(s, sBefore);
  assert.deepEqual(personas, pBefore);
});

test('unnormalized settings are accepted', () => {
  // A caller should never have to remember to normalize first.
  const res = resolveTeamConnections({ settings: { endpoint: 'https://raw.example.com/v1', accessKey: 'RAW-FIXTURE', model: 'm-raw' }, personas: [persona('p1')] });
  assert.equal(res[0].endpoint, 'https://raw.example.com/v1');
  assert.equal(res[0].model, 'm-raw');
  assert.equal(res[0].reason, REASON.FALLBACK);
});

/* --------------------------------------------------------- the summary UI --- */

test('summarizeResolutions names connections and models but never keys', () => {
  const s = settingsWith([
    { endpoint: 'https://a.example.com/v1', key: 'SECRET-A-FIXTURE', model: 'm-a' },
    { endpoint: 'https://b.example.com/v1', key: 'SECRET-B-FIXTURE', model: 'm-b' },
  ], { active: 0 });
  const res = resolveTeamConnections({ settings: s, personas: [persona('p1'), persona('p2'), persona('p3')], spread: true });
  const text = summarizeResolutions(res);
  assert.match(text, /a\.example\.com/);
  assert.match(text, /b\.example\.com/);
  assert.match(text, /x2/, 'the doubled-up connection reports its count');
  assert.ok(!text.includes('SECRET-A-FIXTURE'), 'access keys must never appear in a summary');
  assert.ok(!text.includes('SECRET-B-FIXTURE'));
  assert.equal(summarizeResolutions([]), 'no members');
});
