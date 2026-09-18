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
