'use strict';

/* Item 1.2 — the IPC surface is machine-checked in both directions.
 *
 * `main.mjs` registers handlers, `preload.cjs` exposes channels, and
 * `ipc-manifest.json` documents them. Before this test, the three were linked
 * by nothing: a typo on either side failed at *runtime* ("No handler registered
 * for 'agents:typo'") rather than at build time, and the manifest could drift
 * silently because nothing read it. A hand-maintained manifest with no test is
 * a comment, not a contract.
 *
 * Invariant A5: the static handler set equals the manifest key set equals the
 * preload channel set, with `browser:command` whitelisted EXPLICITLY because it
 * is registered dynamically by `browser/host.cjs` on tab creation and removed
 * on `destroyed` (so it is absent from the static registration set but present
 * in the other two). We do NOT loosen the equality to make it pass — that would
 * defeat the point. The whitelist is one named channel, asserted to carry
 * `dynamic: true` in the manifest.
 *
 * On failure each direction prints the offending channel names, so the fix is
 * obvious from the test output alone.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'main.mjs');
const PRELOAD = path.join(ROOT, 'preload.cjs');
const MANIFEST = path.join(ROOT, 'ipc-manifest.json');

/* Channels registered by another module rather than at main.mjs module load. */
const DYNAMIC = ['browser:command'];

/* Pull `ipcMain.handle('<channel>'` occurrences out of a source string. */
function handlersIn(source) {
  const out = new Set();
  for (const m of source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) out.add(m[1]);
  return out;
}

/* Pull `ipcRenderer.invoke('<channel>'` occurrences out of a source string. */
function channelsIn(source) {
  const out = new Set();
  for (const m of source.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)) out.add(m[1]);
  return out;
}

function describe(list) {
  return list.length ? '[' + list.map(n => `'${n}'`).join(', ') + ']' : '[]';
}

/* Report both directions in one place so a failure is actionable. */
function compareSets({ handlers, channels, manifest }) {
  const problems = [];
  const onlyHandlers = [...handlers].filter(c => !manifest.has(c)).sort();
  const onlyManifest = [...manifest].filter(c => !handlers.has(c)).sort();
  const onlyChannels = [...channels].filter(c => !manifest.has(c)).sort();
  const missingChannel = [...manifest].filter(c => !channels.has(c)).sort();

  if (onlyHandlers.length) {
    problems.push(`registered in main.mjs but absent from ipc-manifest.json: ${describe(onlyHandlers)}`);
  }
  if (onlyManifest.length) {
    problems.push(`declared in ipc-manifest.json but never registered: ${describe(onlyManifest)}`);
  }
  if (onlyChannels.length) {
    problems.push(`invoked by preload.cjs but absent from ipc-manifest.json: ${describe(onlyChannels)}`);
  }
  if (missingChannel.length) {
    problems.push(`declared in ipc-manifest.json but never invoked by preload.cjs: ${describe(missingChannel)}`);
  }
  return problems;
}

function load() {
  const handlers = handlersIn(fs.readFileSync(MAIN, 'utf8'));
  const channels = channelsIn(fs.readFileSync(PRELOAD, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  return { handlers, channels, raw, manifest: new Set(Object.keys(raw)) };
}

test('every static handler, preload channel and manifest key agree in both directions (invariant A5)', () => {
  const { handlers, channels, manifest } = load();

  // The dynamic channel is the one legitimate delta. Assert it is actually
  // dynamic in the manifest rather than simply ignoring an unexplained gap.
  for (const name of DYNAMIC) {
    assert.equal(manifest.has(name), true, `${name} must be declared in the manifest`);
    assert.equal(load().raw[name].dynamic, true, `${name} must be marked dynamic: true`);
    assert.equal(handlers.has(name), false, `${name} must NOT be statically registered in main.mjs`);
  }

  // Compare like with like: the static registration set plus the whitelisted
  // dynamic channels must equal the other two sets exactly.
  const expected = new Set([...handlers, ...DYNAMIC]);
  const problems = compareSets({
    handlers: expected,
    channels,
    manifest,
  });

  assert.deepEqual(problems, [], [
    'IPC surface drift detected:',
    ...problems.map(p => `  - ${p}`),
    '',
    `handlers (static): ${handlers.size}`,
    `handlers (+dynamic): ${expected.size}`,
    `preload channels: ${channels.size}`,
    `manifest keys: ${manifest.size}`,
  ].join('\n'));
});

test('the manifest documents every channel with a module, args and returns field', () => {
  const { raw, manifest } = load();
  const incomplete = [];
  for (const name of [...manifest].sort()) {
    const entry = raw[name];
    if (!entry || typeof entry !== 'object') { incomplete.push(`${name}: not an object`); continue; }
    if (typeof entry.module !== 'string' || !entry.module) incomplete.push(`${name}: no module`);
    if (!Array.isArray(entry.args)) incomplete.push(`${name}: args is not an array`);
    if (typeof entry.returns !== 'string' || !entry.returns) incomplete.push(`${name}: no returns`);
  }
  assert.deepEqual(incomplete, [], `manifest entries incomplete:\n  ${incomplete.join('\n  ')}`);
});

test('the manifest records no channel that the preload does not expose', () => {
  // Stated separately from the combined check so a reader can see the direction
  // that actually breaks users: a documented channel the renderer cannot call.
  const { channels, manifest } = load();
  const unreachable = [...manifest].filter(c => !channels.has(c)).sort();
  assert.deepEqual(unreachable, [], `manifest documents channels preload never exposes: ${describe(unreachable)}`);
});

test('deleting a handler while leaving its preload method is a hard failure', () => {
  // This is the regression the test exists to catch, proven by construction:
  // simulate main.mjs losing one registration and assert the comparison flags
  // exactly that channel instead of passing quietly.
  const { handlers, channels, raw } = load();
  const victim = 'agents:list';
  assert.equal(handlers.has(victim), true, `${victim} must be registered in the real tree for this check to mean anything`);

  const mutated = new Set(handlers);
  mutated.delete(victim);
  const problems = compareSets({
    handlers: new Set([...mutated, ...DYNAMIC]),
    channels,
    manifest: new Set(Object.keys(raw)),
  });

  assert.equal(problems.length, 1, `expected exactly one reported problem, got ${problems.length}`);
  assert.match(problems[0], /declared in ipc-manifest\.json but never registered/);
  assert.match(problems[0], new RegExp(victim.replace(':', ':')));
});

test('adding a preload channel without a manifest entry is a hard failure', () => {
  // The other direction: a new renderer method that nobody can find in the
  // contract document.
  const { channels, handlers, raw } = load();
  const invented = 'agents:inventedByTest';
  const mutated = new Set(channels);
  mutated.add(invented);

  const problems = compareSets({
    handlers: new Set([...handlers, ...DYNAMIC]),
    channels: mutated,
    manifest: new Set(Object.keys(raw)),
  });

  assert.equal(problems.length, 1, `expected exactly one reported problem, got ${problems.length}`);
  assert.match(problems[0], /invoked by preload\.cjs but absent from ipc-manifest\.json/);
  assert.ok(problems[0].includes(invented), 'the offending channel is named in the output');
});
