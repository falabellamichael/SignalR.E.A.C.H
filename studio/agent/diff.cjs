'use strict';

/* Reach Studio — line-based diff (LCS) used to render proposed edits.
 *
 * Pure functions, no I/O. The edit-review flow diffs the current file text
 * against the proposed text and shows the result as an inline review card.
 */

/* Walk the LCS table once and emit ctx/add/del entries. */
function walkLcs(a, b, dp) {
  const out = [];
  let i = 0, j = 0;
  const n = a.length, m = b.length;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i++] }); }
    else { out.push({ type: 'add', text: b[j++] }); }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

function buildLcs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function diffLines(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  return walkLcs(a, b, buildLcs(a, b)).filter(e => e.type !== 'ctx');
}

/* Collapse long unchanged runs: keep `context` lines around each change and
 * insert a {type:'gap'} marker carrying the hidden line count. */
function compactHunks(hunks, context = 3) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length <= context * 2 + 1) {
      for (const l of run) out.push({ type: 'ctx', text: l });
    } else {
      for (let k = 0; k < context; k++) out.push({ type: 'ctx', text: run[k] });
      out.push({ type: 'gap', text: String(run.length - context * 2) });
      for (let k = run.length - context; k < run.length; k++) out.push({ type: 'ctx', text: run[k] });
    }
    run = [];
  };
  for (const h of hunks) {
    if (h.type === 'ctx') { run.push(h.text); }
    else { flush(); out.push(h); }
  }
  flush();
  return out;
}

/* Full review diff: ctx/add/del stream with long unchanged runs collapsed. */
function reviewDiff(oldText, newText, context = 3) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  return compactHunks(walkLcs(a, b, buildLcs(a, b)), context);
}

function stats(hunks) {
  let added = 0, removed = 0;
  for (const h of hunks) {
    if (h.type === 'add') added++;
    else if (h.type === 'del') removed++;
  }
  return { added, removed };
}

module.exports = { diffLines, reviewDiff, compactHunks, stats };
