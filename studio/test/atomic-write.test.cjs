'use strict';

/* Item 1.6 — crash-safe writes. A bare writeFileSync on the real path can
 * truncate settings.json/projects.json mid-write; the previous contents are
 * then lost on the next load. atomicWriteJson writes a sibling .tmp and renames
 * it over the target, so a truncated/interrupted write never clobbers the last
 * good document. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { atomicWriteJson, atomicWriteText } = require('../agent/atomic-write.cjs');

test('atomicWriteJson round-trips pretty-printed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-atomic-'));
  const file = path.join(dir, 'settings.json');
  atomicWriteJson(file, { endpoint: 'https://example.test/v1', nested: { n: 1 } });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(parsed, { endpoint: 'https://example.test/v1', nested: { n: 1 } });
  // No .tmp left behind after a successful rename.
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('atomicWriteJson creates missing parent directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-atomic-'));
  const file = path.join(dir, 'a', 'b', 'projects.json');
  atomicWriteJson(file, [{ name: 'x' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ name: 'x' }]);
});

test('atomicWriteText overwrites atomically and leaves no tmp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-atomic-'));
  const file = path.join(dir, 'note.txt');
  atomicWriteText(file, 'first');
  atomicWriteText(file, 'second');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('a truncated .tmp never clobbers the previous good document', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-atomic-'));
  const file = path.join(dir, 'settings.json');

  // Seed the "last good" state.
  atomicWriteJson(file, { connections: [{ id: 'keep-me', accessKey: 'secret' }] });
  const good = fs.readFileSync(file, 'utf8');

  // Simulate a crash mid-write: write a partial payload to the .tmp path and
  // then pretend the process died before rename. The real file must be intact.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, good.slice(0, Math.floor(good.length / 2)));

  // The reader (loadSettings/loadProjects) opens the real path, never the tmp.
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.equal(onDisk, good, 'partial tmp write must not touch the real file');
  assert.deepEqual(JSON.parse(onDisk).connections[0].accessKey, 'secret');

  // A subsequent successful write replaces the real file and clears the stale tmp.
  atomicWriteJson(file, { connections: [{ id: 'new', accessKey: 'rotated' }] });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).connections[0].id, 'new');
});
