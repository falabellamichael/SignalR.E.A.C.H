#!/usr/bin/env node
'use strict';

/*
 * tools/check-plan-baseline.cjs — item 6.10 of docs/IMPROVEMENTS.md.
 *
 * THE FAILURE THIS PREVENTS
 * docs/README.md lists six improvement documents that were retired because they
 * stated numbers that were wrong when written and wrong when deleted: three
 * different line counts for studio/main.mjs, three different IPC channel counts.
 * The consolidation made docs/IMPROVEMENTS.md the single canonical plan, and
 * item 6.10 is the admission that the same rot will happen again — because the
 * baseline is still COPIED by hand from docs/verify-improvements.sh into prose.
 * A hand-copied number is wrong the moment anyone edits a measured file.
 *
 * WHAT THIS DOES INSTEAD
 * The baseline is GENERATED. `docs/IMPROVEMENTS.md` carries a delimited table
 * between the BASELINE markers below, and this script both writes it (--write)
 * and verifies it (default). CI runs the verify mode, so the plan cannot drift
 * one line behind the tree: editing studio/main.mjs by a single line without
 * re-running --write fails the check. That is exactly the done-check item 6.10
 * asks for.
 *
 * WHY A NODE SCRIPT AND NOT verify-improvements.sh
 * verify-improvements.sh is a bash heredoc: it cannot run on the Windows runner
 * and it only PRINTS numbers for a human to copy. This is the same measurement
 * expressed as a module, so the comparison is mechanical and testable — the
 * suite in studio/test/plan-baseline.test.cjs exercises it directly.
 *
 * LINE-COUNT CONVENTION
 * `lines` counts newline-terminated lines (wc -l semantics). The retired
 * documents disagreed partly because nobody stated which convention they used,
 * so this block names it.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLAN_FILE = path.join(ROOT, 'docs', 'IMPROVEMENTS.md');
const START = '<!-- BASELINE:START -->';
const END = '<!-- BASELINE:END -->';
/* The generated block is inserted here when the plan has no block yet. */
const INSERT_BEFORE = '## Verification';

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const countFiles = (dir, suffix, exclude = []) =>
  fs.readdirSync(path.join(ROOT, dir)).filter(name => name.endsWith(suffix) && !exclude.includes(name)).length;
/* Newline count, so this agrees with `wc -l` and with verify-improvements.sh. */
const lines = rel => read(rel).split('\n').length - 1;
const uniqueMatches = (rel, pattern) => new Set([...read(rel).matchAll(pattern)].map(m => m[1])).size;

/*
 * Every measured number in the baseline. `measure` is the single source of
 * truth: the table and the check both read it, so they cannot disagree with
 * each other — only with the tree, which is the point.
 */
const METRICS = [
  { id: 'studio/main.mjs lines', measure: () => lines('studio/main.mjs') },
  { id: 'studio/renderer/app.js lines', measure: () => lines('studio/renderer/app.js') },
  { id: 'studio/preload.cjs lines', measure: () => lines('studio/preload.cjs') },
  { id: 'studio/agent modules', measure: () => countFiles('studio/agent', '.cjs') },
  // Exclude the build output so a prior `build:editor` cannot change the
  // measurement based on whether the checkout has been built yet.
  { id: 'studio/renderer scripts', measure: () => countFiles('studio/renderer', '.js', ['editor.bundle.js']) },
  { id: 'studio/test files', measure: () => countFiles('studio/test', '.test.cjs') },
  { id: 'static IPC handlers', measure: () => uniqueMatches('studio/main.mjs', /^\s*ipcMain\.handle\('([^']+)'/gm) },
  { id: 'preload invoke channels', measure: () => uniqueMatches('studio/preload.cjs', /ipcRenderer\.invoke\('([^']+)'/g) },
  { id: 'IPC manifest entries', measure: () => Object.keys(JSON.parse(read('studio/ipc-manifest.json'))).length },
  { id: 'SimpleRAG plugin files', measure: () => countFiles('src', '.js') + countFiles('src', '.css') },
];

function measure() {
  const out = new Map();
  for (const metric of METRICS) out.set(metric.id, metric.measure());
  return out;
}

const formatNumber = value => Number(value).toLocaleString('en-US');
const parseNumber = text => Number(String(text).replace(/[,\s]/g, ''));

function renderTable(values = measure()) {
  const rows = [
    '| Metric | Value |',
    '| --- | --- |',
    ...[...values.entries()].map(([id, value]) => `| \`${id}\` | ${formatNumber(value)} |`),
  ];
  return [START, ...rows, END].join('\n');
}

/* Extract the table as a Map. Returns null when the block or a row is missing. */
function parseTable(text) {
  const source = String(text || '');
  const from = source.indexOf(START);
  const to = source.indexOf(END);
  if (from < 0 || to < from) return null;
  const body = source.slice(from + START.length, to);
  const values = new Map();
  for (const line of body.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([0-9][0-9,]*)\s*\|$/.exec(line.trim());
    if (match) values.set(match[1], parseNumber(match[2]));
  }
  return values.size ? values : null;
}

/*
 * Diff a measured set against a parsed set. Reports all three ways a table can
 * be wrong — a stale value, a metric nothing measures any more, and a metric
 * that is not in the table at all — because a table that silently drops a row
 * is as misleading as one holding a stale number.
 */
function compareTables(measured, documented) {
  const stale = [];
  const unknown = [];
  const missing = [];
  for (const [id, value] of measured) {
    if (!documented.has(id)) { missing.push({ id, value }); continue; }
    const shown = documented.get(id);
    if (shown !== value) stale.push({ id, documented: shown, measured: value });
  }
  for (const [id, value] of documented) if (!measured.has(id)) unknown.push({ id, value });
  return { ok: !stale.length && !unknown.length && !missing.length, stale, unknown, missing };
}

function describe(diff) {
  const parts = [];
  for (const row of diff.stale) {
    parts.push(`  ${row.id}: plan says ${formatNumber(row.documented)}, tree has ${formatNumber(row.measured)}`);
  }
  for (const row of diff.missing) parts.push(`  ${row.id}: missing from the table (tree has ${formatNumber(row.value)})`);
  for (const row of diff.unknown) parts.push(`  ${row.id}: listed in the table but nothing measures it any more`);
  return parts.join('\n');
}

function check({ planText } = {}) {
  const text = planText ?? fs.readFileSync(PLAN_FILE, 'utf8');
  const documented = parseTable(text);
  if (!documented) {
    return { ok: false, reason: 'missing-baseline', message:
      `${path.relative(ROOT, PLAN_FILE)} has no generated baseline table between ${START} and ${END}. Run \`node tools/check-plan-baseline.cjs --write\`.` };
  }
  const diff = compareTables(measure(), documented);
  return { ...diff, reason: diff.ok ? 'current' : 'stale' };
}

/* Insert or replace the block, leaving every other byte of the plan alone. */
function applyTable(text, table = renderTable()) {
  const source = String(text);
  const from = source.indexOf(START);
  const to = source.indexOf(END);
  if (from >= 0 && to > from) return source.slice(0, from) + table + source.slice(to + END.length);
  const anchor = source.indexOf(INSERT_BEFORE);
  if (anchor < 0) throw new Error(`Cannot insert the baseline: ${INSERT_BEFORE} not found in the plan.`);
  return source.slice(0, anchor) + table + '\n\n' + source.slice(anchor);
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  if (write) {
    const before = fs.readFileSync(PLAN_FILE, 'utf8');
    const after = applyTable(before);
    if (after === before) console.log('Plan baseline already current.');
    else {
      fs.writeFileSync(PLAN_FILE, after);
      console.log(`Updated the plan baseline in ${path.relative(ROOT, PLAN_FILE)}.`);
    }
    return 0;
  }
  const result = check();
  if (result.ok) {
    console.log(`Plan baseline current (${METRICS.length} metrics match the tree).`);
    return 0;
  }
  console.error(`Plan baseline is ${result.reason}:`);
  console.error(result.message || describe(result));
  console.error('\nThe plan is the single source of truth for numbers. Regenerate it with:');
  console.error('  node tools/check-plan-baseline.cjs --write');
  return 1;
}

module.exports = {
  METRICS, START, END, PLAN_FILE, ROOT,
  measure, renderTable, parseTable, compareTables, describe, check, applyTable, main,
};

if (require.main === module) process.exit(main());
