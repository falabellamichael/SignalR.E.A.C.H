'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTextFile, onFileWrite } = require('../agent/text-files.cjs');
const { liveEventFor } = require('../agent/live-change.cjs');
const { rememberPayload, lookupRemoved, clearRemembered, formatRemovedContext } = require('../agent/live-context.cjs');
const { TOOLS } = require('../agent/tool-registry.cjs');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reach-live-'));
}

test('write observers receive the before and after text', (t) => {
  const dir = scratch();
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'one');
  const seen = [];
  const stop = onFileWrite((abs, info) => { if (abs === file || abs === path.join(dir, 'fresh.txt')) seen.push({ abs, info }); });
  t.after(() => { stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  writeTextFile(file, 'two', { root: dir });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].info.before, 'one');
  assert.equal(seen[0].info.after, 'two');
  assert.equal(seen[0].info.created, false);
  assert.equal(seen[0].info.live, true);
  assert.equal(seen[0].info.root, dir);

  const created = path.join(dir, 'fresh.txt');
  writeTextFile(created, 'new\n', { root: dir, live: false });
  const made = seen.find(entry => entry.abs === created);
  assert.equal(made.info.before, '');
  assert.equal(made.info.created, true);
  assert.equal(made.info.live, false);
});

test('a listener that only takes the path still runs', (t) => {
  const dir = scratch();
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'one');
  let got = null;
  const stop = onFileWrite((abs) => { if (abs === file) got = abs; });
  t.after(() => { stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  writeTextFile(file, 'two', { root: dir });
  assert.equal(got, file);
});

test('a live event anchors a replacement in front of the new line', () => {
  const dir = scratch();
  try {
    const event = liveEventFor({
      root: dir,
      file: path.join(dir, 'src', 'app.js'),
      before: 'alpha\nbeta\ngamma\n',
      after: 'alpha\nBETA\ngamma\n',
      live: true,
    });
    assert.equal(event.path, 'src/app.js');
    assert.equal(event.created, false);
    assert.equal(event.added, 1);
    assert.equal(event.removed, 1);
    assert.equal(event.truncated, false);
    assert.deepEqual(event.changes, [
      { type: 'del', text: 'beta', at: 2 },
      { type: 'add', next: 2 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting the last line anchors at the end of the new file', () => {
  const dir = scratch();
  try {
    const event = liveEventFor({
      root: dir,
      file: path.join(dir, 'app.js'),
      before: 'alpha\nbeta',
      after: 'alpha',
      live: true,
    });
    assert.deepEqual(event.changes, [
      { type: 'del', text: 'beta', at: null },
    ]);
    assert.equal(event.removed, 1);
    assert.equal(event.added, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new file is only additions and a cleared file is only deletions', () => {
  const dir = scratch();
  try {
    const created = liveEventFor({
      root: dir,
      file: path.join(dir, 'new.js'),
      before: '',
      after: 'one\ntwo\n',
      created: true,
      live: true,
    });
    assert.equal(created.created, true);
    assert.equal(created.added, 2);
    assert.equal(created.removed, 0);
    assert.deepEqual(created.changes, [
      { type: 'add', next: 1 },
      { type: 'add', next: 2 },
    ]);

    const cleared = liveEventFor({
      root: dir,
      file: path.join(dir, 'new.js'),
      before: 'one\ntwo',
      after: '',
      live: true,
    });
    assert.equal(cleared.created, false);
    assert.deepEqual(cleared.changes, [
      { type: 'del', text: 'one', at: null },
      { type: 'del', text: 'two', at: null },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('identical text, a user save, and a path outside the project publish nothing', () => {
  const dir = scratch();
  const other = scratch();
  try {
    const same = liveEventFor({ root: dir, file: path.join(dir, 'a.js'), before: 'same', after: 'same', live: true });
    assert.equal(same, null);
    const saved = liveEventFor({ root: dir, file: path.join(dir, 'a.js'), before: 'old', after: 'new', live: false });
    assert.equal(saved, null);
    const escaped = liveEventFor({ root: dir, file: path.join(other, 'secret.js'), before: 'old', after: 'new', live: true });
    assert.equal(escaped, null);
    const parent = liveEventFor({ root: dir, path: '../secret.js', before: 'old', after: 'new', live: true });
    assert.equal(parent, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('a huge write is marked truncated without building a line diff', () => {
  const dir = scratch();
  try {
    const big = 'x'.repeat(200001);
    const started = Date.now();
    const event = liveEventFor({
      root: dir,
      file: path.join(dir, 'big.txt'),
      before: big,
      after: big + 'y',
      live: true,
    });
    assert.ok(Date.now() - started < 500);
    assert.equal(event.truncated, true);
    assert.equal(event.added, null);
    assert.equal(event.removed, null);
    assert.deepEqual(event.changes, []);

    const many = Array.from({ length: 1500 }, () => 'line').join('\n');
    const wide = liveEventFor({
      root: dir,
      file: path.join(dir, 'wide.txt'),
      before: many,
      after: many + '\nmore',
      live: true,
    });
    assert.equal(wide.truncated, true);
    assert.deepEqual(wide.changes, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('red lines stay available to a read until a refresh clears them', async (t) => {
  const dir = scratch();
  const file = path.join(dir, 'src', 'app.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'alpha\nBETA\ngamma\n');
  t.after(() => {
    clearRemembered(dir, 'src/app.js');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const event = liveEventFor({
    root: dir,
    file,
    before: 'alpha\nbeta\ngamma\n',
    after: 'alpha\nBETA\ngamma\n',
    live: true,
  });
  rememberPayload(event);
  assert.deepEqual(lookupRemoved(dir, 'src/app.js').lines, [{ at: 2, text: 'beta' }]);
  const block = formatRemovedContext(dir);
  assert.match(block, /REMOVED LINES ON SCREEN/);
  assert.match(block, /src\/app\.js/);
  assert.match(block, /before line 2: beta/);

  const first = await TOOLS.read.execute({ path: 'src/app.js' }, { projectDir: dir });
  assert.equal(first.ok, true);
  assert.match(first.content, /BETA/);
  assert.equal(first.content.includes('beta'), false);
  assert.deepEqual(first.removedLines, [{ at: 2, text: 'beta' }]);

  assert.equal(clearRemembered(dir, 'src/app.js').abs.endsWith(path.join('src', 'app.js')), true);
  const second = await TOOLS.read.execute({ path: 'src/app.js' }, { projectDir: dir });
  assert.equal(second.removedLines, undefined);
  assert.equal(formatRemovedContext(dir), '');
  assert.equal(lookupRemoved(dir, 'src/app.js'), null);
});

test('clearing red lines drops a cached read of that file', async (t) => {
  const dir = scratch();
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, 'alpha\nBETA\n');
  const { ReadMemo } = require('../agent/read-memo.cjs');
  const memo = new ReadMemo(dir);
  t.after(() => {
    memo.close();
    clearRemembered(dir, 'app.js');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  rememberPayload(liveEventFor({
    root: dir,
    file,
    before: 'alpha\nbeta\n',
    after: 'alpha\nBETA\n',
    live: true,
  }));
  const args = { path: 'app.js' };
  const first = await TOOLS.read.execute(args, { projectDir: dir });
  memo.set('read', args, first);
  assert.deepEqual(memo.get('read', args).removedLines, [{ at: 2, text: 'beta' }]);
  const cleared = clearRemembered(dir, 'app.js');
  memo.invalidate(cleared.abs);
  assert.equal(memo.get('read', args), null);
});

test('a live addition with no deletion does not invent removed lines', () => {
  const dir = scratch();
  try {
    const event = liveEventFor({
      root: dir,
      file: path.join(dir, 'new.js'),
      before: '',
      after: 'one\n',
      created: true,
      live: true,
    });
    rememberPayload(event);
    assert.equal(lookupRemoved(dir, 'new.js'), null);
    rememberPayload(null);
    assert.equal(lookupRemoved(dir, 'new.js'), null);
  } finally {
    clearRemembered(dir, 'new.js');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
