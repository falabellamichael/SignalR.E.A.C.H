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

test('read memo refuses a junction retargeted outside the project before returning cached content', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-memo-boundary-'));
  const root = path.join(base, 'project');
  const inside = path.join(root, 'inside');
  const outside = path.join(base, 'outside');
  const link = path.join(root, 'linked');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside);
  const insideFile = path.join(inside, 'note.txt');
  const outsideFile = path.join(outside, 'note.txt');
  fs.writeFileSync(insideFile, 'inside');
  fs.writeFileSync(outsideFile, 'secret');
  const stamp = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(insideFile, stamp, stamp);
  fs.utimesSync(outsideFile, stamp, stamp);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(inside, link, linkType);
  const memo = new ReadMemo(root);
  t.after(() => {
    memo.close();
    fs.unlinkSync(link);
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(base));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const args = { path: 'linked/note.txt' };
  memo.set('read', args, { ok: true, content: 'inside' });
  assert.equal(memo.get('read', args).content, 'inside');
  fs.unlinkSync(link);
  fs.symlinkSync(outside, link, linkType);
  assert.equal(memo.get('read', args), null);
  assert.equal(memo.descriptor('list', { path: 'linked' }), null);
  memo.set('read', args, { ok: true, content: 'secret' });
  assert.equal(memo.entries.size, 1, 'the external result must not be added');
});

test('truncated, incomplete and bounded reads are not memoized', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-memo-partial-'));
  const memo = new ReadMemo(dir);
  t.after(() => {
    memo.close();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const marker of [{ truncated: true }, { incomplete: true }, { _bounded: 'partial output' }]) {
    const args = { pattern: JSON.stringify(marker) };
    memo.set('glob', args, { ok: true, matches: [], ...marker });
    assert.equal(memo.get('glob', args), null);
  }
  const args = { pattern: '*' };
  memo.set('glob', args, { ok: true, matches: [], truncated: false });
  assert.deepEqual(memo.get('glob', args), { ok: true, matches: [], truncated: false });
});

test('a result cut by the dispatcher budget is executed again instead of cached', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-memo-bounded-'));
  fs.writeFileSync(path.join(dir, 'large.txt'), 'x'.repeat(90000));
  const memo = new ReadMemo(dir);
  t.after(() => {
    memo.close();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cached = [];
  const context = { projectDir: dir, readMemo: memo, onCache: name => cached.push(name), getSettings: () => ({}) };
  for (let i = 0; i < 2; i++) {
    const result = await runToolCall('memo-fixture', 'read', { path: 'large.txt' }, context);
    assert.equal(result.ok, true);
    assert.ok(result.record.bounded, 'the fixture must exceed the result budget');
    assert.equal(result.record.cached, undefined);
  }
  assert.equal(memo.entries.size, 0);
  assert.deepEqual(cached, []);
});
