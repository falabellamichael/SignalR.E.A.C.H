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
 *                   added, removed, lines:[{type,text,orig,next}]}]
 * buildReview() adds the `sideBySide` rows for the viewer on top of this.
 */
function buildChunks(before, after, context = DEFAULT_CONTEXT) {
  const entries = diffEntries(before, after);
  const chunks = [];
  let current = null;
  let run = [];   // pending context entries

  const flushContext = () => { run = []; };

  const closeChunk = () => {
    if (!current) return;
    /* Keep up to `context` trailing context lines, dropping any beyond that.
     *
     * This used to pop EVERY trailing context line, on the theory that it
     * belongs to the next chunk's leading margin. Two problems: the final chunk
     * has no successor, so its trailing context was simply lost; and a hunk with
     * no lines below the change cannot be read in context, which defeats the
     * point of showing context at all.
     *
     * Keeping `context` on both sides cannot duplicate lines, because chunks only
     * split once an unchanged run exceeds context*2 — so the trailing margin of
     * one chunk and the leading margin of the next are always separated by at
     * least one line that belongs to neither.
     *
     * Safety: applySelection keys chunk ownership on non-ctx lines only, so the
     * context carried here is display metadata and cannot change what a
     * selection applies. */
    {
      let trailing = 0;
      while (trailing < current.lines.length && current.lines[current.lines.length - 1 - trailing].type === 'ctx') trailing++;
      while (trailing > context) { current.lines.pop(); trailing--; }
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
      //
      // The threshold stays at `context` rather than git's 2*context on purpose:
      // two independent changes separated by a smallish gap stay separately
      // acceptable, which is what the granular accept/reject story needs. Git
      // merges them because it stages hunks; this splits them because a reviewer
      // may want to take one insertion and refuse the other. The overlap that
      // keeping trailing context would otherwise create is removed by a
      // post-pass below, not by merging chunks.
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

  /* Remove context lines shown by two adjacent chunks.
   *
   * Splitting at `> context` (see above) keeps independent changes separately
   * acceptable, but it also means an unchanged run of context+1 .. 2*context
   * lines can end up in one chunk's trailing margin AND the next chunk's leading
   * margin, so the same source line renders in two hunks.
   *
   * The later chunk's LEADING context is kept and the earlier chunk's TRAILING
   * margin is trimmed: leading context sits directly above the change it
   * explains, so it is the more useful of the two for a reviewer. Either side
   * would be consistent, but dropping the leading margin would leave a hunk
   * starting at its change with nothing above it.
   *
   * Display-only. applySelection keys chunk ownership on non-ctx lines, so
   * trimming context here cannot change what a selection applies — but the
   * position fields are recomputed so they stay truthful about what is shown. */
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1], next = chunks[i];
    const nextLeading = new Set();
    for (const line of next.lines) {
      if (line.type !== 'ctx') break;
      if (line.orig !== null) nextLeading.add(line.orig);
    }
    if (!nextLeading.size) continue;

    // Trim from the END of the previous chunk, stopping at its first non-ctx line
    // so the change itself is never touched.
    let trimmed = 0;
    while (prev.lines.length) {
      const last = prev.lines[prev.lines.length - 1];
      if (last.type !== 'ctx') break;
      if (last.orig === null || !nextLeading.has(last.orig)) break;
      prev.lines.pop();
      trimmed++;
    }
    if (trimmed) finalize(prev);
  }

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
 * Render one chunk as side-by-side rows IN SOURCE ORDER.
 *
 * Walks chunk.lines as they occur. Consecutive del/add lines form one change
 * block and are paired positionally (del i with add i) so a replaced line shows
 * as 'modify' rather than as a remove above an add. Context rows are emitted
 * where they appear, not collected separately.
 *
 * An earlier revision filtered the lines into three lists and emitted all the
 * context rows first, then all the change rows. That reordered the diff: for a
 * chunk containing change, context, change it rendered the trailing context ABOVE
 * the changes it followed, so the preview could not be read as the file. The
 * unit tests did not catch it because every fixture had at most one change per
 * chunk, where grouping and ordering coincide.
 */
function sideBySide(chunk) {
  const lines = Array.isArray(chunk && chunk.lines) ? chunk.lines : [];
  const rows = [];
  let dels = [], adds = [];

  // Emit the accumulated change block, pairing deletions with additions.
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i], a = adds[i];
      rows.push({
        left: d ? { text: d.text, line: d.orig } : null,
        right: a ? { text: a.text, line: a.next } : null,
        kind: d && a ? 'modify' : d ? 'remove' : 'add',
      });
    }
    dels = []; adds = [];
  };

  for (const line of lines) {
    if (!line) continue;
    if (line.type === 'ctx') {
      flush();
      rows.push({ left: { text: line.text, line: line.orig }, right: { text: line.text, line: line.next }, kind: 'ctx' });
    } else if (line.type === 'del') {
      dels.push(line);
    } else if (line.type === 'add') {
      adds.push(line);
    }
  }
  flush();
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
/* `context` selects the chunk width, and it MUST be the same value used to build
 * the preview the accepted ids came from. Chunk ids (c0, c1, ...) are positional
 * in that chunking, so re-deriving with a different width would silently apply a
 * neighbouring chunk. Defaults to DEFAULT_CONTEXT for callers that never showed
 * a preview at all. */
function resolveContext(context) {
  return Number.isSafeInteger(context) && context >= 0 ? Math.min(context, 40) : DEFAULT_CONTEXT;
}

function applySelection(before, after, acceptedIds, options = {}) {
  const a = String(before == null ? '' : before);
  const b = String(after == null ? '' : after);
  const chunks = buildChunks(a, b, resolveContext(options.context));
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
function applySelections(files, selections = {}, options = {}) {
  const edits = [];
  const skipped = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file !== 'object' || !file.path) continue;
    const ids = Object.hasOwn(selections, file.path) ? selections[file.path] : null;
    const res = applySelection(file.before, file.after, ids, options);
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
