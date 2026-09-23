'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadMemo } = require('../agent/read-memo.cjs');
const { writeTextFile } = require('../agent/text-files.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { resolveBudgets } = require('../agent/budgets.cjs');

test('a second identical read avoids disk and a project write invalidates it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-read-memo-'));
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'one');
  const memo = new ReadMemo(dir);
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (...args) {
    if (args[0] === file) reads++;
    return original.apply(this, args);
  };
  t.after(() => { fs.readFileSync = original; memo.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const cached = [];
  const context = { projectDir: dir, readMemo: memo, onCache: name => cached.push(name),
    getSettings: () => ({}), agentStore: { get: () => ({ settings: {} }), appendMessage: () => {} } };
  const first = await runToolCall('agent-1', 'read', { path: 'note.txt' }, context);
  const second = await runToolCall('agent-1', 'read', { path: 'note.txt' }, context);
  assert.equal(first.content, 'one');
  assert.equal(second.content, 'one');
  assert.equal(reads, 1);
  assert.deepEqual(cached, ['read']);

  writeTextFile(file, 'two');
  const readsAfterWrite = reads; // writeTextFile reads the old encoding first
  const third = await runToolCall('agent-1', 'read', { path: 'note.txt' }, context);
  assert.equal(third.content, 'two');
  assert.equal(reads, readsAfterWrite + 1);
});

test('read memo can be disabled through the budgets schema', () => {
  assert.equal(resolveBudgets({ budgets: { memoizeReads: false } }).memoizeReads, false);
});
