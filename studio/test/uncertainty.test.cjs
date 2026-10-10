'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../agent/memory-store.cjs');
const {
  recordUncertainty, resolveUncertainty, openList, renderUncertaintyBlock,
} = require('../agent/uncertainty.cjs');

const args = { assumption: 'The endpoint is 128K', reason: 'compaction trigger depends on it', check: 'read the provider docs page' };

test('record + resolve round-trip through the run state', () => {
  const store = new MemoryStore();
  recordUncertainty(store, 'a1', args);
  const open = openList(store.get('a1').runState);
  assert.equal(open.length, 1);
  assert.equal(open[0].assumption, args.assumption);
  const text = renderUncertaintyBlock(store.get('a1').runState);
  assert.match(text, /OPEN UNCERTAINTIES/);
  assert.ok(text.includes(open[0].id), 'prompt block names the open item id');
  assert.match(text, /planned check: read the provider docs page/);

  resolveUncertainty(store, 'a1', open[0].id, { checkTaken: 'docs say 128K — read docs page' });
  const after = store.get('a1').runState.uncertainties;
  assert.equal(after[0].status, 'resolved');
  assert.equal(after[0].resolution, 'docs say 128K — read docs page');
  assert.equal(renderUncertaintyBlock(store.get('a1').runState), '');
});

test('fields are required and capped', () => {
  const store = new MemoryStore();
  assert.throws(() => recordUncertainty(store, 'a1', { ...args, assumption: '' }), /needs the assumption/);
  assert.throws(() => recordUncertainty(store, 'a1', { ...args, reason: '' }), /reason/);
  assert.throws(() => recordUncertainty(store, 'a1', { ...args, check: '' }), /check/);
  assert.throws(() => recordUncertainty(store, 'a1', { ...args, assumption: 'a'.repeat(301) }), /capped at 300/);
});

test('a new record is refused while an item is still open (one at a time)', () => {
  const store = new MemoryStore();
  recordUncertainty(store, 'a1', args);
  assert.throws(() => recordUncertainty(store, 'a1', { ...args, assumption: 'second' }), /Resolve the 1 open uncertainty first/);
});

test('resolving an unknown id throws and is not re-resolvable', () => {
  const store = new MemoryStore();
  recordUncertainty(store, 'a1', args);
  const id = openList(store.get('a1').runState)[0].id;
  resolveUncertainty(store, 'a1', id);
  assert.throws(() => resolveUncertainty(store, 'a1', id), /already-resolved/);
  assert.throws(() => resolveUncertainty(store, 'a1', 'nope'), /Unknown/);
});

test('the rolling window of resolved items is bounded', () => {
  const store = new MemoryStore();
  for (let i = 0; i < 8; i++) {
    recordUncertainty(store, 'a1', { ...args, assumption: 'assumption ' + i });
    resolveUncertainty(store, 'a1', openList(store.get('a1').runState)[0].id);
  }
  const items = store.get('a1').runState.uncertainties;
  assert.equal(items.length, 5);
  assert.equal(items.every(i => i.status === 'resolved'), true);
});
