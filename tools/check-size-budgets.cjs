#!/usr/bin/env node
'use strict';

/*
 * tools/check-size-budgets.cjs — a growth ratchet for the biggest modules.
 *
 * THE FAILURE THIS PREVENTS
 * The PRD names "portfolio sprawl" as a standing risk — four surfaces that
 * duplicate logic and drift — and gives "shared contracts" as the control. But
 * nothing watched the symptom. studio/main.mjs went 3,389 -> 4,404 lines and
 * studio/renderer/app.js 2,665 -> 5,134 in a few weeks, and no check noticed,
 * because docs/IMPROVEMENTS.md records those numbers as FACTS. A fact that is
 * re-generated on every commit reports growth; it cannot object to it.
 *
 * WHAT THIS DOES INSTEAD
 * Each listed file gets a ceiling. Under it, nothing happens. Over it, the
 * build fails and names the file. The point is not to stop files growing —
 * it is to make growing them a decision somebody makes on purpose, in a
 * reviewable one-line diff, instead of something that happens quietly.
 *
 * WHY A CEILING WITH HEADROOM AND NOT "DO NOT GROW"
 * A tripwire set at exactly today's size turns every ordinary feature commit
 * red, which is how the plan-baseline check became a chore. Budgets are set
 * with BUDGET_HEADROOM room to move, so routine work never trips them and
 * only a genuine run of growth does.
 *
 * RAISING A BUDGET
 * Edit tools/size-budgets.json. That is deliberately a manual, reviewable act:
 * --tighten only ever LOWERS a budget, so shrinking a file locks the win in
 * and no command can quietly hand a file more room.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BUDGET_FILE = path.join(ROOT, 'tools', 'size-budgets.json');

/* Ceilings are set at current size + 20%, rounded up to the next 50 lines.
 * Uniform and explainable, rather than a number argued per file. 20% is
 * calibrated against the growth this repo actually sees: studio/main.mjs
 * moved +30% in a few weeks, so a tighter ceiling would trip on ordinary
 * work and become a chore, while a looser one would never object at all.
 * The ratchet is what keeps it honest - --tighten pulls budgets in whenever
 * a file shrinks, so the headroom is lent, not given. */
const BUDGET_HEADROOM = 1.20;
const BUDGET_ROUNDING = 50;

const lines = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length - 1;
const exists = rel => fs.existsSync(path.join(ROOT, rel));
const budgetFor = count =>
  Math.ceil((count * BUDGET_HEADROOM) / BUDGET_ROUNDING) * BUDGET_ROUNDING;
const readBudgets = () => JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
const format = n => Number(n).toLocaleString('en-US');

/*
 * Compare every budgeted file against its ceiling. A file that no longer
 * exists is reported rather than skipped: a budget pointing at nothing is a
 * stale entry, and silently ignoring it is how the retired docs rotted.
 */
function check(budgets = readBudgets()) {
  const over = [];
  const missing = [];
  const rows = [];
  for (const [rel, budget] of Object.entries(budgets)) {
    if (!exists(rel)) { missing.push(rel); continue; }
    const count = lines(rel);
    rows.push({ rel, count, budget, headroom: budget - count });
    if (count > budget) over.push({ rel, count, budget, excess: count - budget });
  }
  rows.sort((a, b) => a.headroom - b.headroom);
  return { ok: !over.length && !missing.length, over, missing, rows };
}

/* Lower any budget whose file has shrunk. Never raises — see the header. */
function tighten(budgets = readBudgets()) {
  const next = { ...budgets };
  const lowered = [];
  for (const [rel, budget] of Object.entries(budgets)) {
    if (!exists(rel)) continue;
    const want = budgetFor(lines(rel));
    if (want < budget) { next[rel] = want; lowered.push({ rel, from: budget, to: want }); }
  }
  return { next, lowered };
}

function report(result) {
  for (const row of result.rows) {
    const pct = Math.round((row.count / row.budget) * 100);
    /* Budgets start life at ~83% used (the 20% headroom), so "near" has to
     * mean most of that room is gone, not merely that a budget exists. */
    const flag = row.count > row.budget ? 'OVER' : pct >= 95 ? 'near' : '    ';
    console.log(`  ${flag}  ${row.rel.padEnd(34)} ${String(format(row.count)).padStart(7)} / ${String(format(row.budget)).padStart(7)}  (${pct}%)`);
  }
}

function main(argv = process.argv.slice(2)) {
  const budgets = readBudgets();

  if (argv.includes('--tighten')) {
    const { next, lowered } = tighten(budgets);
    if (!lowered.length) { console.log('No budget can be tightened; nothing shrank.'); return 0; }
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(next, null, 2) + '\n');
    for (const row of lowered) {
      console.log(`Tightened ${row.rel}: ${format(row.from)} -> ${format(row.to)}`);
    }
    return 0;
  }

  const result = check(budgets);
  if (argv.includes('--report')) report(result);

  if (result.missing.length) {
    console.error('Size budget points at a file that does not exist:');
    for (const rel of result.missing) console.error('  ' + rel);
    console.error('\nRemove the entry from tools/size-budgets.json, or fix the path.');
    return 1;
  }
  if (!result.over.length) {
    const tightest = result.rows[0];
    console.log(`Size budgets OK (${result.rows.length} files; tightest is ${tightest.rel} `
      + `at ${format(tightest.count)}/${format(tightest.budget)}).`);
    return 0;
  }

  console.error('Over size budget:');
  for (const row of result.over) {
    console.error(`  ${row.rel}: ${format(row.count)} lines, budget ${format(row.budget)} `
      + `(+${format(row.excess)})`);
  }
  console.error('\nThese files are the "portfolio sprawl" risk the PRD names. Either split the');
  console.error('module, or raise its ceiling in tools/size-budgets.json as a deliberate,');
  console.error('reviewable change. Run with --report to see every file and its headroom.');
  return 1;
}

module.exports = {
  BUDGET_FILE, BUDGET_HEADROOM, BUDGET_ROUNDING,
  lines, budgetFor, readBudgets, check, tighten, report, main,
};

if (require.main === module) process.exit(main());
