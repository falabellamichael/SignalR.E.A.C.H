#!/usr/bin/env node
'use strict';

/*
 * tools/count-plan-status.cjs — the Status-at-a-Glance counter for
 * docs/IMPROVEMENTS.md.
 *
 * WHY THIS IS A SEPARATE, COMMITTED SCRIPT
 * The plan opens with a "Status at a Glance" table (DONE / PARTIAL / TODO counts)
 * and a "Top 10 Highest-Impact Remaining Items" list. Both were hand-counted, and
 * item 6.10 exists because hand-copied numbers rot. Counting them by hand again in
 * a shell one-liner is how the last five documents died — so the count lives in a
 * file that can be run, tested and re-run, exactly like check-plan-baseline.cjs.
 *
 * WHAT IT COUNTS
 * Only the item ROWS of the phased tables — a line that starts with `| N.M |`.
 * Headings, prose, the exec summary's own table and the ID crosswalk are ignored,
 * because they are not items. A row whose status cell reads DONE / PARTIAL / TODO
 * (with or without bold) is counted once, in that bucket.
 *
 * OUTPUT
 * A stable, diffable block. `--json` for machine use.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLAN_FILE = path.join(ROOT, 'docs', 'IMPROVEMENTS.md');

/* An item row: `| 2.8 | ... |`. Requires the numeric ID so nothing else matches. */
const ITEM_ROW = /^\|\s*(\d+)\.(\d+)\s*\|/;
const STATUSES = ['DONE', 'PARTIAL', 'TODO'];

/* Cells are pipe-delimited; the status cell is matched anywhere as a whole word so
 * both `| DONE |` and `| **DONE** |` and `| DONE (this change) |` count. */
function statusOf(row) {
  const cells = row.split('|').map(cell => cell.trim().replace(/\*/g, ''));
  for (const cell of cells) {
    const head = cell.split(/\s+/)[0];
    if (STATUSES.includes(head)) return head;
  }
  /* `TODO (needs ...)` -> cells keep the parenthetical in the same cell, so the
   * first-token match above already covers it. Anything else is unclassified. */
  return null;
}

function countStatuses(planText = fs.readFileSync(PLAN_FILE, 'utf8')) {
  const counts = { DONE: 0, PARTIAL: 0, TODO: 0 };
  const byPhase = {};
  const unclassified = [];
  let items = 0;
  for (const line of String(planText).split('\n')) {
    const match = ITEM_ROW.exec(line);
    if (!match) continue;
    items++;
    const phase = match[1];
    const status = statusOf(line);
    byPhase[phase] = byPhase[phase] || { DONE: 0, PARTIAL: 0, TODO: 0 };
    if (!status) { unclassified.push(`${phase}.${match[2]}`); continue; }
    counts[status]++;
    byPhase[phase][status]++;
  }
  return { items, counts, byPhase, unclassified };
}

function render(result = countStatuses()) {
  const lines = [
    `items: ${result.items}`,
    `DONE: ${result.counts.DONE}`,
    `PARTIAL: ${result.counts.PARTIAL}`,
    `TODO: ${result.counts.TODO}`,
  ];
  for (const phase of Object.keys(result.byPhase).sort((a, b) => Number(a) - Number(b))) {
    const p = result.byPhase[phase];
    lines.push(`phase ${phase}: done ${p.DONE}, partial ${p.PARTIAL}, todo ${p.TODO}`);
  }
  if (result.unclassified.length) lines.push(`unclassified: ${result.unclassified.join(', ')}`);
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const result = countStatuses();
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(render(result));
  return result.unclassified.length ? 1 : 0;
}

module.exports = { PLAN_FILE, ITEM_ROW, STATUSES, statusOf, countStatuses, render, main };

if (require.main === module) process.exit(main());
