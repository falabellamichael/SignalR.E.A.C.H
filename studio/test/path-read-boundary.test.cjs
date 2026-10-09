'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveInProject } = require('../agent/paths.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-path-boundary-'));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'project-outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const links = [];
  t.after(() => {
    for (const link of links.reverse()) {
      try { fs.unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(base));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return {
    base, root, outside,
    link(target, location = path.join(root, 'linked')) {
      fs.symlinkSync(target, location, process.platform === 'win32' ? 'junction' : 'dir');
      links.push(location);
      return location;
    },
  };
}

test('existing project paths and new nested write paths retain their lexical path', t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'note.txt'), 'inside');
  assert.equal(resolveInProject(root, 'note.txt'), path.join(root, 'note.txt'));
  assert.equal(resolveInProject(root, 'new/nested/note.txt'), path.join(root, 'new', 'nested', 'note.txt'));
  assert.equal(resolveInProject(root, '.'), root);
});

test('absolute paths and parent traversal retain the existing refusal messages', t => {
  const { root } = fixture(t);
  assert.throws(() => resolveInProject(root, '/tmp/note.txt'), /Absolute paths are not allowed/);
  assert.throws(() => resolveInProject(root, 'C:\\outside\\note.txt'), /Absolute paths are not allowed/);
  assert.throws(() => resolveInProject(root, '../note.txt'), /Parent-directory traversal/);
  assert.throws(() => resolveInProject(root, 'src/../note.txt'), /Parent-directory traversal/);
});

test('an external junction refuses both existing targets and nonexistent descendants', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.outside, 'note.txt'), 'outside');
  f.link(f.outside);
  for (const requested of ['linked', 'linked/note.txt', 'linked/new/nested/note.txt']) {
    assert.throws(() => resolveInProject(f.root, requested), /escapes the project directory/);
  }
});

test('a link that stays within the project permits reads and new descendants', t => {
  const f = fixture(t);
  const inside = path.join(f.root, 'actual');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'note.txt'), 'inside');
  f.link(inside);
  assert.equal(resolveInProject(f.root, 'linked/note.txt'), path.join(f.root, 'linked', 'note.txt'));
  assert.equal(resolveInProject(f.root, 'linked/new/note.txt'), path.join(f.root, 'linked', 'new', 'note.txt'));
});

test('a project root reached through a junction uses the real project boundary', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'note.txt'), 'inside');
  const alias = f.link(f.root, path.join(f.base, 'project-alias'));
  f.link(f.outside);
  assert.equal(resolveInProject(alias, 'note.txt'), path.join(alias, 'note.txt'));
  assert.equal(resolveInProject(alias, 'new/note.txt'), path.join(alias, 'new', 'note.txt'));
  assert.throws(() => resolveInProject(alias, 'linked/note.txt'), /escapes the project directory/);
});

test('a dangling junction is refused instead of falling back to its safe parent', t => {
  const f = fixture(t);
  f.link(f.outside);
  fs.rmdirSync(f.outside);
  assert.throws(() => resolveInProject(f.root, 'linked/new/note.txt'));
});

test('read and scoped scans reject an external junction through the real dispatch path', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.outside, 'note.txt'), 'outside sentinel');
  f.link(f.outside);
  const context = { projectDir: f.root, getSettings: () => ({ approvals: 'auto-all', reviewEdits: false }) };
  for (const [name, args] of [
    ['read', { path: 'linked/note.txt' }],
    ['glob', { path: 'linked', pattern: '**/*.txt' }],
    ['search', { path: 'linked', pattern: 'outside' }],
    ['list', { path: 'linked' }],
    ['write', { path: 'linked/new/note.txt', content: 'blocked' }],
  ]) {
    const result = await runToolCall('boundary-fixture', name, args, context);
    assert.equal(result.ok, false, name);
    assert.match(result.error, /escapes the project directory/, name);
  }
  assert.equal(fs.existsSync(path.join(f.outside, 'new')), false, 'write must not create outside parents before refusing');
  assert.equal(fs.readFileSync(path.join(f.outside, 'note.txt'), 'utf8'), 'outside sentinel');
});
