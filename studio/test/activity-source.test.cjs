'use strict';

/* Reach Studio — plan item E9: the activity reducer is engine-owned.
 *
 * The reducer used to live in renderer/activity-state.js, so agent-loop.cjs and
 * agent-store.cjs imported a UI file. It now lives in agent/activity.cjs (the
 * single source of truth) and the renderer file is GENERATED from it by
 * scripts/build-activity.cjs, because the renderer loads plain <script src>
 * tags under CSP 'self' and therefore cannot require().
 *
 * These tests are what make the duplication safe:
 *   1. no engine module may import ../renderer again,
 *   2. the generated renderer file must be byte-current with the engine source,
 *   3. both copies must expose the same API and reduce identically.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENT_DIR = path.join(ROOT, 'agent');
const build = require('../scripts/build-activity.cjs');
const engine = require('../agent/activity.cjs');
const renderer = require('../renderer/activity-state.js');

test('no engine module imports the renderer (E9 done-check)', () => {
  const offenders = [];
  for (const name of fs.readdirSync(AGENT_DIR).filter(n => n.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(AGENT_DIR, name), 'utf8');
    // Strip comments first: prose may legitimately mention the old path (this
    // very test's subject), and only a real require is a coupling.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^(?:[^'"`\n]*?)\/\/.*$/gm, '');
    if (/require\(['"]\.\.\/renderer\//.test(code)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `engine modules still requiring ../renderer: ${offenders.join(', ')}`);
});

test('the generated renderer copy is byte-current with agent/activity.cjs', () => {
  const { text, digest } = build.render();
  const onDisk = fs.readFileSync(build.TARGET, 'utf8');
  assert.equal(build.recordedDigest(onDisk), digest,
    'renderer/activity-state.js is stale — run: npm run build:activity');
  assert.equal(onDisk, text, 'the generated file must be a verbatim copy of the engine module');
});

test('both copies expose the same API and reduce a real event sequence identically', () => {
  const events = [
    { type: 'run-state', status: 'running' },
    { type: 'round', round: 1 },
    { type: 'request-start' },
    { type: 'message-start' },
    { type: 'reasoning', chars: 120 },
    { type: 'delta', text: 'Hello' },
    { type: 'message-end', content: 'Hello' },
    { type: 'tool-call', tool: 'read', arguments: { path: 'index.rsh' } },
    { type: 'approval-wait' },
    { type: 'approval-end' },
    { type: 'tool-result', ok: true, result: { ok: true } },
    { type: 'run-state', status: 'completed' },
  ];
  assert.deepEqual(Object.keys(engine).sort(), Object.keys(renderer).sort());
  let fromEngine = null, fromRenderer = null;
  let at = 1000;
  for (const event of events) {
    at += 1000;
    fromEngine = engine.reduce(fromEngine, event, at);
    fromRenderer = renderer.reduce(fromRenderer, event, at);
  }
  assert.deepEqual(fromEngine, fromRenderer);
  assert.equal(engine.summary(fromEngine, at).title, 'Completed');
});

test('the engine copy is what main.mjs and the loop actually use', () => {
  // A one-line re-export in the renderer is impossible (CSP, no require), so the
  // guard is the other way round: the engine must not name the renderer path.
  const loop = fs.readFileSync(path.join(AGENT_DIR, 'agent-loop.cjs'), 'utf8');
  const store = fs.readFileSync(path.join(AGENT_DIR, 'agent-store.cjs'), 'utf8');
  assert.match(loop, /require\('\.\/activity\.cjs'\)/);
  assert.match(store, /require\('\.\/activity\.cjs'\)/);
});
