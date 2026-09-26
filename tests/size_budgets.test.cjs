'use strict';
/*
 * Size budgets are a ratchet, not a tripwire.
 *
 * The plan baseline records module sizes as FACTS, regenerated on every commit,
 * so it reports growth but cannot object to it — studio/renderer/app.js nearly
 * doubled while every check stayed green. These tests pin the three properties
 * that make a budget different from a fact:
 *
 *   1. going over the ceiling fails, and says which file and by how much
 *   2. --tighten only ever LOWERS a budget, so headroom is lent, not given
 *   3. a budget pointing at a deleted file is an error, not a silent skip
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const budgets = require('../tools/check-size-budgets.cjs');
const {
  BUDGET_FILE, BUDGET_HEADROOM, BUDGET_ROUNDING,
  budgetFor, readBudgets, check, tighten,
} = budgets;

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. The rule that sets a ceiling
// ---------------------------------------------------------------------------

test('a ceiling is the current size plus headroom, rounded up', () => {
  assert.equal(budgetFor(1000), 1200);
  assert.equal(budgetFor(4404), 5300);
  assert.equal(budgetFor(1), BUDGET_ROUNDING);
});

test('a ceiling always leaves room, never lands exactly on the current size', () => {
  for (const size of [1, 37, 200, 999, 2893, 5134]) {
    assert.ok(budgetFor(size) > size, `${size} -> ${budgetFor(size)} must leave room`);
  }
});

test('the headroom is a real allowance, not a rounding artifact', () => {
  assert.ok(BUDGET_HEADROOM > 1, 'headroom multiplies above 1');
  // Enough room for ordinary work: a file may grow by a sixth before failing.
  assert.ok(budgetFor(3000) - 3000 >= 3000 / 6);
});

// ---------------------------------------------------------------------------
// 2. Checking
// ---------------------------------------------------------------------------

test('a file under its ceiling passes and reports headroom', () => {
  const result = check({ 'tools/check-size-budgets.cjs': 100000 });
  assert.equal(result.ok, true);
  assert.equal(result.over.length, 0);
  assert.ok(result.rows[0].headroom > 0);
});

test('a file over its ceiling fails and names the overage', () => {
  const result = check({ 'tools/check-size-budgets.cjs': 1 });
  assert.equal(result.ok, false);
  assert.equal(result.over.length, 1);
  assert.equal(result.over[0].rel, 'tools/check-size-budgets.cjs');
  assert.ok(result.over[0].excess > 0, 'the report says by how much');
  assert.equal(result.over[0].excess, result.over[0].count - 1);
});

test('a budget pointing at a deleted file is an error, not a silent skip', () => {
  // A stale entry is exactly how the retired improvement docs rotted: it looks
  // like coverage and checks nothing.
  const result = check({ 'studio/agent/this-was-deleted.cjs': 500 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['studio/agent/this-was-deleted.cjs']);
});

test('rows are ordered by how little room is left', () => {
  const result = check({
    'tools/check-size-budgets.cjs': 100000,
    'tools/size-budgets.json': 20,
  });
  const headrooms = result.rows.map(r => r.headroom);
  assert.deepEqual(headrooms, [...headrooms].sort((a, b) => a - b));
});

// ---------------------------------------------------------------------------
// 3. The ratchet
// ---------------------------------------------------------------------------

test('tighten lowers a budget when the file has shrunk', () => {
  const { next, lowered } = tighten({ 'tools/size-budgets.json': 99999 });
  assert.equal(lowered.length, 1);
  assert.ok(next['tools/size-budgets.json'] < 99999);
  assert.equal(next['tools/size-budgets.json'],
    budgetFor(budgets.lines('tools/size-budgets.json')));
});

test('tighten NEVER raises a budget', () => {
  // The whole point: a command may lock a win in, but only a human editing
  // size-budgets.json may hand a file more room.
  const current = readBudgets();
  const squeezed = Object.fromEntries(Object.keys(current).map(k => [k, 1]));
  const { next, lowered } = tighten(squeezed);
  assert.deepEqual(lowered, [], 'nothing is lowered when every budget is already 1');
  for (const [rel, value] of Object.entries(next)) {
    assert.equal(value, 1, `${rel} was raised to ${value}`);
  }
});

test('tighten leaves a missing file alone rather than inventing a budget', () => {
  const { next } = tighten({ 'studio/agent/this-was-deleted.cjs': 500 });
  assert.equal(next['studio/agent/this-was-deleted.cjs'], 500);
});

// ---------------------------------------------------------------------------
// 4. The committed budgets in this repository
// ---------------------------------------------------------------------------

test('the committed budget file is valid JSON with positive whole ceilings', () => {
  const committed = readBudgets();
  assert.ok(Object.keys(committed).length > 0, 'at least one file is budgeted');
  for (const [rel, value] of Object.entries(committed)) {
    assert.ok(Number.isInteger(value) && value > 0, `${rel} has a real ceiling`);
    assert.ok(!path.isAbsolute(rel) && !rel.includes('..'),
      `${rel} is a repo-relative path`);
  }
});

test('every budgeted file exists and is inside its ceiling right now', () => {
  const result = check();
  assert.deepEqual(result.missing, [], 'no budget points at a deleted file');
  assert.deepEqual(result.over.map(r => `${r.rel} ${r.count}/${r.budget}`), [],
    'the tree is within budget');
});

test('the budgets cover every surface the PRD names, not just Studio', () => {
  const rels = Object.keys(readBudgets());
  for (const surface of ['studio/', 'vscode/', 'server/reachd/', 'src/', 'copilot/']) {
    assert.ok(rels.some(r => r.startsWith(surface)),
      `${surface} has no budgeted module; portfolio sprawl is a four-surface risk`);
  }
});

test('the biggest source files are the ones being watched', () => {
  /* A budget list that quietly omits the largest module would be decoration.
   * Walk the tree and assert the top few by size are all budgeted. */
  const skip = new Set(['node_modules', '.git', 'dist', 'out']);
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(c|m)?js$|\.py$/.test(entry.name)) continue;
      if (entry.name === 'editor.bundle.js') continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (rel.startsWith('tests/') || rel.includes('/test/')) continue;
      found.push({ rel, count: fs.readFileSync(full, 'utf8').split('\n').length - 1 });
    }
  })(ROOT);
  found.sort((a, b) => b.count - a.count);
  const budgeted = new Set(Object.keys(readBudgets()));
  const unwatched = found.slice(0, 5).filter(f => !budgeted.has(f.rel));
  assert.deepEqual(unwatched.map(f => `${f.rel} (${f.count})`), [],
    'the largest modules must carry a ceiling');
});
