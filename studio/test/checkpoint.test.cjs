'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCheckpoint, listCheckpoints, MAX_CHECKPOINTS } = require('../agent/checkpoint.cjs');

test('checkpoints are created, listed newest-first, and survive a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-ckpt-'));
  try {
    const first = createCheckpoint(dir, { agentId: 'a1', label: 'before-refactor', description: 'green baseline', files: ['a.cjs', 'b.cjs'] });
    assert.equal(first.seq, 1);
    assert.equal(first.label, 'before-refactor');
    createCheckpoint(dir, { agentId: 'a1', label: 'after-tests', description: 'all green' });
    const list = listCheckpoints(dir, { agentId: 'a1' });
    assert.equal(list.length, 2);
    assert.equal(list[0].label, 'after-tests');
    assert.equal(list[1].label, 'before-refactor');
    assert.deepEqual(list[1].files, ['a.cjs', 'b.cjs']);
    // A fresh read from disk sees the same records.
    assert.equal(listCheckpoints(dir, { agentId: 'a1' }).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents are isolated from each other', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-ckpt-'));
  try {
    createCheckpoint(dir, { agentId: 'a1', label: 'one' });
    assert.equal(listCheckpoints(dir, { agentId: 'a2' }).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('labels are validated, files deduped, descriptions capped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-ckpt-'));
  try {
    assert.throws(() => createCheckpoint(dir, { agentId: 'a', label: '../evil' }), /Invalid checkpoint label/);
    assert.throws(() => createCheckpoint(dir, { agentId: 'a', label: '' }), /Invalid checkpoint label/);
    const rec = createCheckpoint(dir, {
      agentId: 'a', label: 'x',
      description: '  a   b\n'.repeat(200),
      files: ['a.cjs', 'a.cjs', 'b.cjs', ''],
    });
    assert.deepEqual(rec.files, ['a.cjs', 'b.cjs']);
    assert.match(rec.description, /^a b a b/);
    assert.equal(rec.description.length <= 500, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the per-agent file is bounded to the newest checkpoints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-ckpt-'));
  try {
    for (let i = 1; i <= MAX_CHECKPOINTS + 5; i++) {
      createCheckpoint(dir, { agentId: 'a', label: 'c' + i });
    }
    const list = listCheckpoints(dir, { agentId: 'a' });
    assert.equal(list.length, MAX_CHECKPOINTS);
    assert.equal(list[0].label, 'c' + (MAX_CHECKPOINTS + 5));
    assert.equal(list[MAX_CHECKPOINTS - 1].label, 'c6');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
