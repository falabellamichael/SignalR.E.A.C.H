'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../agent/patch-manager.cjs');
const { diffEntries } = require('../agent/diff.cjs');

const WIDE_BEFORE = Array.from({ length: 14 }, (_, i) => `line${i + 1}`).join('\n');
const WIDE_AFTER = WIDE_BEFORE.replace('line2', 'CHANGED2').replace('line10', 'CHANGED10');

test('two widely-separated changes form two chunks with side-by-side rows', () => {
  const rev = P.buildReview(WIDE_BEFORE, WIDE_AFTER, { path: 'x.txt' });
  assert.equal(rev.ok, true);
  assert.equal(rev.chunks.length, 2, 'changes >2*context apart split into two chunks');
  assert.equal(rev.stats.added, 2);
  assert.equal(rev.stats.removed, 2);
  assert.ok(rev.chunks[0].sideBySide.length > 0);
  const modRows = rev.chunks[0].sideBySide.filter(r => r.kind === 'modify');
  assert.ok(modRows.length >= 1);
  assert.equal(modRows[0].left.text, 'line2');
  assert.equal(modRows[0].right.text, 'CHANGED2');
});

test('side-by-side rows keep SOURCE order when a chunk interleaves changes and context', () => {
  // Regression: sideBySide used to bucket lines into context/deletions/additions
  // and emit all the context rows first, then the change rows. For a chunk with
  // change-context-change that rendered the trailing context ABOVE the changes it
  // followed, so the preview could not be read as the file. Every earlier fixture
  // had one change per chunk, where grouping and ordering coincide, so it passed.
  //
  // Context 4 puts both changes in ONE chunk, which is what exposes the ordering.
  const before = ['a', 'OLD1', 'c', 'd', 'OLD2', 'e'].join('\n');
  const after = ['a', 'NEW1', 'c', 'd', 'NEW2', 'e'].join('\n');
  const rev = P.buildReview(before, after, { path: 'x.txt', context: 4 });
  assert.equal(rev.chunks.length, 1, 'both changes must share one chunk');

  const rows = rev.chunks[0].sideBySide;
  assert.deepEqual(rows.map(r => r.kind), ['ctx', 'modify', 'ctx', 'ctx', 'modify', 'ctx'],
    'rows follow source order: ' + rows.map(r => r.kind).join(','));

  // The left column alone must read as the original file, top to bottom.
  assert.deepEqual(rows.filter(r => r.left).map(r => r.left.text), ['a', 'OLD1', 'c', 'd', 'OLD2', 'e']);
  // ...and the right column as the proposed file.
  assert.deepEqual(rows.filter(r => r.right).map(r => r.right.text), ['a', 'NEW1', 'c', 'd', 'NEW2', 'e']);
  // Line numbers stay monotonic per side, which is what a viewer scrolls against.
  const leftLines = rows.filter(r => r.left).map(r => r.left.line);
  assert.deepEqual(leftLines, [...leftLines].sort((x, y) => x - y), 'left line numbers ascend');
});

test('side-by-side pairs a multi-line replacement positionally within one block', () => {
  const before = ['keep', 'one', 'two', 'keep2'].join('\n');
  const after = ['keep', 'ONE', 'TWO', 'THREE', 'keep2'].join('\n');
  const rev = P.buildReview(before, after, { path: 'x.txt', context: 2 });
  assert.equal(rev.chunks.length, 1);
  const rows = rev.chunks[0].sideBySide;
  // 2 deletions against 3 additions: the first two pair as modify, the extra add
  // gets a null left so the columns stay aligned instead of shifting.
  assert.deepEqual(rows.map(r => r.kind), ['ctx', 'modify', 'modify', 'add', 'ctx'],
    rows.map(r => r.kind).join(','));
  assert.equal(rows[3].left, null, 'unpaired addition has no left side');
  assert.equal(rows[3].right.text, 'THREE');
});

test('side-by-side handles a pure deletion and a pure insertion', () => {
  const removed = P.buildReview(['a', 'gone', 'b'].join('\n'), ['a', 'b'].join('\n'), { path: 'x.txt', context: 1 });
  assert.deepEqual(removed.chunks[0].sideBySide.map(r => r.kind), ['ctx', 'remove', 'ctx']);
  assert.equal(removed.chunks[0].sideBySide[1].right, null);

  const inserted = P.buildReview(['a', 'b'].join('\n'), ['a', 'new', 'b'].join('\n'), { path: 'x.txt', context: 1 });
  assert.deepEqual(inserted.chunks[0].sideBySide.map(r => r.kind), ['ctx', 'add', 'ctx']);
  assert.equal(inserted.chunks[0].sideBySide[1].left, null);
});

test('accepted chunk ids are interpreted at the PREVIEW context, not the default', () => {
  // Regression: applySelection() used to rebuild chunks with DEFAULT_CONTEXT (3)
  // regardless of the width the preview was shown at. Chunk ids are positional in
  // that chunking, so a plan previewed at a narrower width could apply chunks the
  // user never ticked — the worst possible failure for a "review before writing"
  // feature, because it is silent.
  //
  // A 3-line gap between two changes splits at context=2 (run 3 > 2) but NOT at
  // context=3 (run 3 > 3 is false), so the two widths genuinely disagree and the
  // bug is observable rather than hypothetical.
  const before = [
    'const a = 1;',
    'const SCALE = 2;',
    'const OFFSET = 10;',
    "const NOTE = 'x';",
    'const b = 2;',
    '',
  ].join('\n');
  const after = before.replace('const a = 1;', 'const A = 1;').replace('const b = 2;', 'const B = 2;');

  const narrow = P.buildChunks(before, after, 2);
  const wide = P.buildChunks(before, after, 3);
  assert.equal(narrow.length, 2, 'context=2 splits into two chunks');
  assert.equal(wide.length, 1, 'context=3 keeps them as one chunk');

  // Accepting only the first chunk the user was shown must apply only that change.
  const partial = P.applySelection(before, after, [narrow[0].id], { context: 2 });
  assert.equal(partial.applied, 1, 'exactly one chunk applied');
  assert.ok(partial.text.includes('const A = 1;'), 'the accepted change landed');
  assert.ok(partial.text.includes('const b = 2;'), 'the UNACCEPTED change did not land');
  assert.ok(!partial.text.includes('const B = 2;'), 'no unaccepted text on disk');

  // Without the context the same ids over-apply — that is the old, broken path.
  const drifted = P.applySelection(before, after, [narrow[0].id]);
  assert.equal(drifted.applied, 2, 'default context merges the chunks and applies both');

  // The list form used by main.mjs threads context through too.
  const viaList = P.applySelections([{ path: 'f.js', before, after }], { 'f.js': [narrow[0].id] }, { context: 2 });
  assert.equal(viaList.edits.length, 1);
  assert.ok(!viaList.edits[0].content.includes('const B = 2;'), 'applySelections honours the preview context');

  // A context value is still bounded and junk falls back to the default.
  const huge = P.applySelection(before, after, null, { context: 999 });
  assert.equal(huge.text, after, 'accept-all is unaffected by context width');
});

test('no context line is shown by two adjacent chunks', () => {
  // Regression: keeping a trailing context margin while splitting chunks at
  // `> context` made an unchanged run of context+1 .. 2*context lines appear in
  // one chunk's trailing margin AND the next chunk's leading margin, so the same
  // source line rendered twice in the preview. Verified empirically with
  // context 3: gaps of 4 and 5 duplicated 2 and 1 lines respectively.
  //
  // The split threshold stays low so independent changes remain separately
  // acceptable (see the insertion test above); the overlap is removed instead.
  for (const context of [1, 2, 3]) {
    for (const gap of [context + 1, context + 2, context * 2 + 1]) {
      const beforeLines = ['HEAD', 'OLD1'];
      for (let i = 0; i < gap; i++) beforeLines.push(`gap${i + 1}`);
      beforeLines.push('OLD2', 'TAIL');
      const afterLines = beforeLines.map(l => (l === 'OLD1' ? 'NEW1' : l === 'OLD2' ? 'NEW2' : l));
      const rev = P.buildReview(beforeLines.join('\n'), afterLines.join('\n'), { path: 'x.txt', context });
      assert.ok(rev.chunks.length >= 1);

      // A context line shown in more than one chunk is the bug.
      const seen = new Map();
      for (const c of rev.chunks) {
        for (const r of c.sideBySide) {
          if (r.kind !== 'ctx') continue;
          const key = r.left.line;
          assert.equal(seen.has(key), false,
            `ctx line ${key} ("${r.left.text}") shown in chunks ${seen.get(key)} and ${c.id} (context ${context}, gap ${gap})`);
          seen.set(key, c.id);
        }
      }

      // Trimming must not eat the change or leave a chunk empty of context above
      // its own change when the source has lines there.
      for (const c of rev.chunks) {
        assert.ok(c.sideBySide.some(r => r.kind !== 'ctx'), `chunk ${c.id} still shows its change`);
        assert.ok(c.sideBySide.some(r => r.kind === 'ctx'), `chunk ${c.id} still has context`);
      }

      // Display-only trimming must not change what selections apply.
      assert.equal(P.applySelection(beforeLines.join('\n'), afterLines.join('\n'), null).text, afterLines.join('\n'),
        'accept-all still reproduces the proposed text');
    }
  }
});

test('trimming overlapping context recomputes chunk positions', () => {
  // origEnd/nextEnd describe what the viewer scrolls to, so they must match the
  // lines actually retained after trimming.
  const before = ['a', 'OLD1', 'b', 'c', 'd', 'e', 'OLD2', 'f'].join('\n');
  const after = ['a', 'NEW1', 'b', 'c', 'd', 'e', 'NEW2', 'f'].join('\n');
  const rev = P.buildReview(before, after, { path: 'x.txt', context: 2 });
  for (const c of rev.chunks) {
    const origs = c.lines.filter(l => l.orig !== null).map(l => l.orig);
    if (origs.length) {
      assert.equal(c.origStart, Math.min(...origs), 'origStart matches retained lines');
      assert.equal(c.origEnd, Math.max(...origs), 'origEnd matches retained lines');
    }
  }
});

test('accept-all reproduces the proposed text exactly', () => {
  assert.equal(P.applySelection(WIDE_BEFORE, WIDE_AFTER, null).text, WIDE_AFTER);
  assert.equal(P.applySelection(WIDE_BEFORE, WIDE_AFTER, ['c0', 'c1']).text, WIDE_AFTER);
});

test('accept-none reproduces the original exactly', () => {
  assert.equal(P.applySelection(WIDE_BEFORE, WIDE_AFTER, []).text, WIDE_BEFORE);
});

test('a single chunk can be accepted without the other, with no line shift', () => {
  const onlyFirst = WIDE_BEFORE.replace('line2', 'CHANGED2');
  assert.equal(P.applySelection(WIDE_BEFORE, WIDE_AFTER, ['c0']).text, onlyFirst);
  const onlySecond = WIDE_BEFORE.replace('line10', 'CHANGED10');
  // Rejecting the earlier chunk must not shift where the later one lands.
  assert.equal(P.applySelection(WIDE_BEFORE, WIDE_AFTER, ['c1']).text, onlySecond);
});

test('unknown chunk ids warn and are ignored', () => {
  const res = P.applySelection(WIDE_BEFORE, WIDE_AFTER, ['c99']);
  assert.equal(res.text, WIDE_BEFORE, 'unknown id applies nothing');
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /unknown chunk/i);
});

test('pure insertions split into independent chunks', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
  const after = ['a', 'NEW1', 'b', 'c', 'd', 'e', 'f', 'g', 'NEW2', 'h', 'i', 'j'].join('\n');
  const rev = P.buildReview(before, after);
  assert.equal(rev.chunks.length, 2);
  assert.equal(P.applySelection(before, after, ['c0']).text,
    ['a', 'NEW1', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n'));
  assert.equal(P.applySelection(before, after, ['c1']).text,
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'NEW2', 'h', 'i', 'j'].join('\n'));
});

test('new file, identical file and oversize file are handled', () => {
  assert.equal(P.applySelection(null, 'brand\nnew', null).text, 'brand\nnew');
  assert.equal(P.applySelection(null, 'brand\nnew', []).text, '', 'no chunks accepted => empty');
  const id = P.buildReview('same\n', 'same\n');
  assert.equal(id.identical, true);
  assert.equal(id.chunks.length, 0);
  const huge = P.buildReview(new Array(30000).fill('x').join('\n'), new Array(30000).fill('x').join('\n') + '\ny');
  assert.equal(huge.ok, false);
  assert.match(huge.error, /too large/);
});

test('CRLF line endings survive a round-trip', () => {
  const before = 'a\r\nb\r\nc';
  const after = 'a\r\nB\r\nc';
  assert.ok(P.applySelection(before, after, null).text.includes('\r\n'));
});

test('applySelections drops unchanged files and flags created ones', () => {
  const out = P.applySelections([
    { path: 'a.js', before: WIDE_BEFORE, after: WIDE_AFTER },
    { path: 'b.js', before: 'x', after: 'y' },
  ], { 'a.js': [], 'b.js': null });
  assert.deepEqual(out.edits.map(e => e.path), ['b.js']);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].path, 'a.js');
  assert.equal(typeof out.edits[0].content, 'string');

  const created = P.applySelections([{ path: 'n.js', before: null, after: 'new\n' }], {});
  assert.equal(created.edits[0].creating, true);
});

test('diffEntries carries 1-based original and proposed line numbers', () => {
  const entries = diffEntries('a\nb\nc', 'a\nB\nc');
  const del = entries.find(e => e.type === 'del');
  const add = entries.find(e => e.type === 'add');
  assert.equal(del.orig, 2);
  assert.equal(del.next, null);
  assert.equal(add.orig, null);
  assert.equal(add.next, 2);
});

test('a middle chunk of three can be applied alone', () => {
  const before = Array.from({ length: 25 }, (_, i) => `l${i + 1}`).join('\n');
  const after = before.split('\n').map((l, i) => (i === 2 || i === 12 || i === 22) ? `CHANGED${i + 1}` : l).join('\n');
  const rev = P.buildReview(before, after);
  assert.equal(rev.chunks.length, 3);
  const expectMid = before.split('\n').map((l, i) => i === 12 ? 'CHANGED13' : l).join('\n');
  assert.equal(P.applySelection(before, after, ['c1']).text, expectMid);
  const expectOuter = before.split('\n').map((l, i) => (i === 2 || i === 22) ? `CHANGED${i + 1}` : l).join('\n');
  assert.equal(P.applySelection(before, after, ['c0', 'c2']).text, expectOuter);
});
