#!/usr/bin/env node
'use strict';

/*
 * Generate renderer/activity-state.js from agent/activity.cjs (plan item E9).
 *
 * WHY THIS EXISTS
 * The activity reducer belongs to the engine: agent-loop.cjs and agent-store.cjs
 * both fold run events into it. It used to live in renderer/, which made the
 * engine import a UI file. The obvious fix — a one-line re-export shim in the
 * renderer — is impossible here: renderer/index.html loads its scripts as plain
 * <script src="..."> tags under CSP `script-src 'self'`, so a browser file has
 * no `require`.
 *
 * So the engine file is the single source of truth and this script copies it
 * verbatim into the renderer, prepending a header carrying the sha256 of the
 * engine source. activity.test.cjs regenerates and compares, so the two can
 * never silently diverge: editing the renderer copy fails the gate.
 *
 * The reducer is a UMD factory (`module.exports` in Node, `globalThis.
 * ReachActivityState` in a browser), so the exact same bytes run in both.
 *
 * Usage: node scripts/build-activity.cjs [--check]
 *   --check  exit 1 if the generated file is stale, without writing.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'agent', 'activity.cjs');
const TARGET = path.join(ROOT, 'renderer', 'activity-state.js');

const SOURCE_LABEL = 'agent/activity.cjs';
const HEADER_MARK = 'GENERATED FILE — DO NOT EDIT.';

function render() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const digest = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  const header = [
    '/* ' + HEADER_MARK,
    ' *',
    ' * Generated from ' + SOURCE_LABEL + ' by scripts/build-activity.cjs (npm run build:activity).',
    ' * Every line below is a byte-for-byte copy of that engine module, which is the',
    ' * single source of truth for the activity reducer. Edit the engine file and',
    ' * re-run the build; activity.test.cjs fails the gate if this file is stale.',
    ' *',
    ' * source: ' + SOURCE_LABEL,
    ' * sha256: ' + digest,
    ' */',
    '',
  ].join('\n');
  return { text: header + source, digest };
}

/** The sha256 recorded in an already-generated file, or null. */
function recordedDigest(text) {
  const match = /^ \* sha256: ([0-9a-f]{64})$/m.exec(text);
  return match ? match[1] : null;
}

function main() {
  const check = process.argv.includes('--check');
  const { text, digest } = render();
  const existing = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : null;
  if (check) {
    if (existing === text) {
      console.log(`${path.relative(ROOT, TARGET)} is current (sha256 ${digest.slice(0, 12)}…)`);
      return 0;
    }
    const recorded = existing && recordedDigest(existing);
    console.error(`STALE: ${path.relative(ROOT, TARGET)} does not match ${SOURCE_LABEL}.`);
    console.error(recorded
      ? `  recorded sha256 ${recorded.slice(0, 12)}…  expected ${digest.slice(0, 12)}…`
      : '  no sha256 header found (file predates the generator)');
    console.error('  fix: npm run build:activity');
    return 1;
  }
  fs.writeFileSync(TARGET, text, 'utf8');
  console.log(`wrote ${path.relative(ROOT, TARGET)} from ${SOURCE_LABEL} (sha256 ${digest.slice(0, 12)}…)`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { render, recordedDigest, SOURCE, TARGET, SOURCE_LABEL, HEADER_MARK };
