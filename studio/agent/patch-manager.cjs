'use strict';

/* Reach Studio — interactive diff & patch manager.
 *
 * The PRD's patch story needs more than "show a diff and write it": the
 * developer must be able to accept or reject INDIVIDUAL hunks, and the approved
 * subset must be applied atomically. This module owns that logic; the renderer
 * only draws what buildReview() returns and reports back a set of chunk ids.
 *
 *   buildReview(before, after, opts) -> {chunks[], sideBySide[], stats}
 *   applySelection(before, after, acceptedIds) -> text      (pure)
 *   applySelections(files, acceptedIdsByFile) -> edits[]    (refactor shape)
 *
 * Selective acceptance is a real merge problem, not a filter: taking hunk 2 but
 * rejecting hunk 1 changes where hunk 2's lines land. The implementation here
 * rebuilds the result from the ORIGINAL file, walking the positioned diff and
 * emitting either the original line or the proposed line for each region,
 * depending on whether the chunk that region belongs to was accepted. That is
 * correct for any subset, including an empty one (returns the original) and a
 * full one (returns the proposed text).
 *
 * Zero dependencies beyond the repo's own diff.cjs.
 */

const { diffEntries, stats: diffStats } = require('./diff.cjs');

const DEFAULT_CONTEXT = 3;
/** Reject absurd inputs early: an LCS table is (n+1) x (m+1) Uint32s. */
const MAX_DIFF_LINES = 20000;

/* --------------------------------------------------------------------- chunks */

/**
 * Group a positioned diff into reviewable chunks. Adjacent add/del entries
 * merge into one chunk; runs of context longer than `context` lines split
 * chunks and keep `context` lines of margin on each side (the same collapsing
 * reviewDiff does, but retaining positions so selection can be inverted).
 *
 * Returns chunks: [{id, index, type, origStart, origEnd, nextStart, nextEnd,
 *                   added, removed, lines:[{type,text,orig,next}], contextBefore, contextAfter}]
 */
function buildChunks(before, after, context = DEFAULT_CONTEXT) {
  const entries = diffEntries(before, after);
  const chunks = [];
  let current = null;
  let run = [];   // pending context entries

  const flushContext = () => { run = []; };

  const closeChunk = () => {
    if (!current) return;
    // Trim trailing context that belongs to the NEXT chunk's margin.
    while (current.lines.length && current.lines[current.lines.length - 1].type === 'ctx') {
      current.lines.pop();
    }
    if (current.lines.some(l => l.type !== 'ctx')) {
      finalize(current);
      chunks.push(current);
    }
    current = null;
  };

  const finalize = (chunk) => {
    const changed = chunk.lines.filter(l => l.type !== 'ctx');
    chunk.added = changed.filter(l => l.type === 'add').length;
    chunk.removed = changed.filter(l => l.type === 'del').length;
    const origs = chunk.lines.filter(l => l.orig !== null).map(l => l.orig);
    const nexts = chunk.lines.filter(l => l.next !== null).map(l => l.next);
    chunk.origStart = origs.length ? Math.min(...origs) : null;
    chunk.origEnd = origs.length ? Math.max(...origs) : null;
    chunk.nextStart = nexts.length ? Math.min(...nexts) : null;
    chunk.nextEnd = nexts.length ? Math.max(...nexts) : null;
  };

  for (const entry of entries) {
    if (entry.type === 'ctx') {
      run.push(entry);
      // A long unchanged run ends the current chunk.
      if (current && run.length > context) closeChunk();
      if (run.length > context * 2) run = run.slice(-context);
      if (current) current.lines.push(entry);
      continue;
    }
    if (!current) {
      current = { index: chunks.length, lines: [] };
      // Carry up to `context` preceding context lines into the new chunk.
      for (const c of run.slice(-context)) current.lines.push(c);
    }
    run = [];
    current.lines.push(entry);
  }
  closeChunk();
  flushContext();

  // Attach stable ids and trailing context for display.
  const withIds = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    withIds.push({ id: 'c' + i, ...c, type: c.added && c.removed ? 'modify' : c.added ? 'add' : 'remove' });
  }
  return withIds;
}

/* -------------------------------------------------------------- side-by-side */

/**
 * Render a chunk as aligned left/right rows for a side-by-side viewer. A
 * modify chunk pairs deletions with additions positionally; extra lines on
 * either side get a null counterpart so the two columns stay aligned.
 */
function sideBySide(chunk) {
  const dels = chunk.lines.filter(l => l.type === 'del');
  const adds = chunk.lines.filter(l => l.type === 'add');
  const ctx = chunk.lines.filter(l => l.type === 'ctx');
  const rows = [];
  for (const c of ctx) rows.push({ left: { text: c.text, line: c.orig }, right: { text: c.text, line: c.next }, kind: 'ctx' });
  const n = Math.max(dels.length, adds.length);
  for (let i = 0; i < n; i++) {
    const d = dels[i], a = adds[i];
    rows.push({
      left: d ? { text: d.text, line: d.orig } : null,
      right: a ? { text: a.text, line: a.next } : null,
      kind: d && a ? 'modify' : d ? 'remove' : 'add',
    });
  }
  return rows;
}

/* -------------------------------------------------------------------- review */

/**
 * Full review payload for one file. The renderer draws this directly.
 */
function buildReview(before, after, options = {}) {
  const context = Number.isSafeInteger(options.context) && options.context >= 0
    ? Math.min(options.context, 40) : DEFAULT_CONTEXT;
  const a = String(before == null ? '' : before);
  const b = String(after == null ? '' : after);
  const guard = { ok: true };
  const aLines = a.split('\n').length, bLines = b.split('\n').length;
  if (Math.max(aLines, bLines) > MAX_DIFF_LINES) {
    return {
      ok: false,
      error: `File is too large to diff (${Math.max(aLines, bLines)} lines, limit ${MAX_DIFF_LINES}).`,
      chunks: [], sideBySide: [], stats: { added: 0, removed: 0 },
    };
  }
  const chunks = buildChunks(a, b, context);
  const all = diffEntries(a, b);
  const s = diffStats(all);
  return {
    ok: guard.ok,
    path: options.path || null,
    chunks: chunks.map(c => ({ ...c, sideBySide: sideBySide(c) })),
    stats: { added: s.added, removed: s.removed, chunks: chunks.length },
    identical: a === b,
    created: before === null || before === undefined,
  };
}

/* --------------------------------------------------------- selective apply */

/**
 * Rebuild the file text from `before`, applying only the accepted chunks.
 *
 * Walks the positioned diff and decides, for each contiguous run of changed
 * lines, whether that run belongs to an accepted chunk. Context lines are
 * always emitted from the original (they are identical in both). Because the
 * walk is driven by the ORIGINAL file's line positions, rejecting an earlier
 * chunk cannot shift a later accepted chunk into the wrong place — each region
 * is resolved independently against its own original line numbers.
 *
 * @param {string} before  original file text
 * @param {string} after   proposed file text
 * @param {string[]|Set<string>|null} acceptedIds  chunk ids to keep.
 *        null/undefined means "accept everything" (equivalent to writing `after`).
 * @returns {{text:string, applied:number, skipped:number, warnings:string[]}}
 */
function applySelection(before, after, acceptedIds) {
  const a = String(before == null ? '' : before);
  const b = String(after == null ? '' : after);
  const chunks = buildChunks(a, b, DEFAULT_CONTEXT);
  if (!chunks.length) return { text: a, applied: 0, skipped: 0, warnings: ['No changes to apply.'] };

  const acceptAll = acceptedIds === null || acceptedIds === undefined;
  const accepted = acceptAll ? new Set(chunks.map(c => c.id)) : new Set(acceptedIds);

  const unknown = [...accepted].filter(id => !chunks.some(c => c.id === id));
  const warnings = unknown.length
    ? [`Ignored unknown chunk id(s): ${unknown.join(', ')}.`]
    : [];

  // Map each original line number to whether an accepted chunk changes it, and
  // collect the inserted text for accepted add-only regions.
  const entries = diffEntries(a, b);

  // Determine, for every entry, the chunk that owns it (if any).
  const ownerOf = new Map();
  for (const chunk of chunks) {
    for (const line of chunk.lines) {
      if (line.type === 'ctx') continue;
      // Key on identity: entries are objects created once by diffEntries, but we
      // re-derived them above, so key by position+type instead.
      const key = line.type + ':' + (line.orig === null ? 'n' + line.next : 'o' + line.orig);
      ownerOf.set(key, chunk.id);
    }
  }

  const aLines = a.split('\n');
  const out = [];
  let applied = 0, skipped = 0;
  const countedChunks = new Set();

  // Walk the diff: emit original lines for unchanged regions, and for changed
  // regions emit the proposed lines only when their chunk is accepted.
  let i = 0;   // index into entries
  let origLine = 0;   // 0-based cursor into aLines
  while (i < entries.length) {
    const e = entries[i];
    if (e.type === 'ctx') {
      out.push(aLines[origLine] !== undefined ? aLines[origLine] : e.text);
      origLine++;
      i++;
      continue;
    }
    // Start of a changed run: consume consecutive del/add entries.
    const run = [];
    while (i < entries.length && entries[i].type !== 'ctx') { run.push(entries[i]); i++; }
    // A run may span more than one chunk (chunks split on long context only, so
    // in practice one run == one chunk), but resolve per entry to be safe.
    const runChunkIds = new Set(run.map(x => ownerOf.get(x.type + ':' + (x.orig === null ? 'n' + x.next : 'o' + x.orig))).filter(Boolean));
    // Accept the run only if every chunk touching it is accepted: a partially
    // accepted run cannot be expressed as coherent text.
    const acceptedRun = runChunkIds.size > 0 && [...runChunkIds].every(id => accepted.has(id));
    if (acceptedRun) {
      for (const x of run) {
        if (x.type === 'del') { origLine++; }
        else { out.push(x.text); countedChunks.add([...runChunkIds][0]); }
      }
      for (const id of runChunkIds) countedChunks.add(id);
      applied++;
    } else {
      // Rejected: keep the original lines, discard the additions.
      for (const x of run) if (x.type === 'del') { out.push(aLines[origLine] !== undefined ? aLines[origLine] : x.text); origLine++; }
      for (const id of runChunkIds) if (!countedChunks.has(id)) skipped++;
    }
  }
  // Trailing original lines not consumed by the diff (should not happen, but a
  // truncated walk must not silently drop the end of the file).
  while (origLine < aLines.length) { out.push(aLines[origLine]); origLine++; }

  return { text: out.join('\n'), applied, skipped, warnings };
}

/**
 * Turn per-file selections into refactor-engine edits, dropping files whose
 * selection results in no change so the plan stays honest.
 *
 * @param files [{path, before, after}]
 * @param selections { [path]: string[] | null }
 */
function applySelections(files, selections = {}) {
  const edits = [];
  const skipped = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file !== 'object' || !file.path) continue;
    const ids = Object.hasOwn(selections, file.path) ? selections[file.path] : null;
    const res = applySelection(file.before, file.after, ids);
    if (res.text === String(file.before == null ? '' : file.before)) {
      skipped.push({ path: file.path, reason: 'No chunks accepted; file unchanged.' });
      continue;
    }
    edits.push({ path: file.path, content: res.text, creating: file.before === null || file.before === undefined });
  }
  return { edits, skipped };
}

module.exports = {
  DEFAULT_CONTEXT,
  MAX_DIFF_LINES,
  buildChunks,
  sideBySide,
  buildReview,
  applySelection,
  applySelections,
};
