'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TOOLS, globMatch } = require('../agent/tool-registry.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-file-scans-'));
  const realRoot = fs.realpathSync(root);
  t.after(() => {
    assert.equal(fs.realpathSync(root), realRoot);
    assert.ok(path.relative(fs.realpathSync(os.tmpdir()), realRoot).startsWith('reach-file-scans-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const dir of ['build', 'src', 'src/nested', 'app', '.hidden', 'node_modules']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const [name, content] of Object.entries({
    'pyproject.toml': '[project]\nname = "fixture"',
    'root.txt': 'alpha', 'src/nested/note.txt': 'alpha',
    'app/package.json': '{}', 'build/generated.txt': 'alpha',
    '.hidden/secret.txt': 'alpha', 'node_modules/ignored.txt': 'alpha',
  })) fs.writeFileSync(path.join(root, name), content);
  return root;
}

test('recursive globs include zero-directory matches without accepting partial basenames', () => {
  for (const candidate of ['package.json', 'app/package.json', 'a/b/package.json']) {
    assert.equal(globMatch('**/package.json', candidate), true, candidate);
  }
  for (const candidate of ['xpackage.json', 'app/xpackage.json', 'package.json.bak']) {
    assert.equal(globMatch('**/package.json', candidate), false, candidate);
  }
  assert.equal(globMatch('src/**/note.txt', 'src/note.txt'), true);
  assert.equal(globMatch('src/**/note.txt', 'src/nested/note.txt'), true);
  assert.equal(globMatch('*.txt', 'src/note.txt'), false);
  assert.equal(globMatch('a?b', 'a/b'), false);
});

test('worker scans find root manifests and support directory patterns', async t => {
  const projectDir = fixture(t);
  const manifest = await TOOLS.glob.execute({ pattern: '**/pyproject.toml' }, { projectDir });
  assert.deepEqual(manifest.matches, ['pyproject.toml']);
  assert.equal(manifest.truncated, false);
  const folders = await TOOLS.glob.execute({ pattern: '*/' }, { projectDir });
  assert.deepEqual(folders.matches, ['app/', 'build/', 'src/']);
  assert.equal(folders.truncated, false);
  const nested = await TOOLS.glob.execute({ pattern: '**/' }, { projectDir });
  assert.ok(nested.matches.includes('src/nested/'));
});

test('shallow and literal-prefix globs do not scan unrelated directories', async t => {
  const projectDir = fixture(t);
  const original = fs.readdirSync;
  const scanned = [];
  t.mock.method(fs, 'readdirSync', function (dir, ...args) {
    scanned.push(path.relative(projectDir, dir));
    return original.call(this, dir, ...args);
  });
  const context = { projectDir, inScanWorker: true };
  const root = await TOOLS.glob.execute({ pattern: 'pyproject.toml' }, context);
  assert.deepEqual(root.matches, ['pyproject.toml']);
  assert.deepEqual(scanned, ['']);
  scanned.length = 0;
  const scoped = await TOOLS.glob.execute({ pattern: 'app/*.json' }, context);
  assert.deepEqual(scoped.matches, ['app/package.json']);
  assert.deepEqual(scanned, ['', 'app']);
  scanned.length = 0;
  const generated = await TOOLS.glob.execute({ pattern: 'build/**' }, context);
  assert.deepEqual(generated.matches, ['build/generated.txt']);
  assert.deepEqual(scanned, ['', 'build']);
});

test('generated trees cannot hide root and source manifests under the entry budget', async t => {
  const projectDir = fixture(t);
  const original = fs.readdirSync;
  const generated = Array.from({ length: 21000 }, (_, i) => ({
    name: `generated-${i}.bin`, isDirectory: () => false, isSymbolicLink: () => false,
  }));
  t.mock.method(fs, 'readdirSync', function (dir, ...args) {
    if (dir === path.join(projectDir, 'build')) return generated;
    return original.call(this, dir, ...args);
  });
  const context = { projectDir, inScanWorker: true };
  const root = await TOOLS.glob.execute({ pattern: '**/pyproject.toml' }, context);
  assert.deepEqual(root.matches, ['pyproject.toml']);
  assert.equal(root.truncated, true);
  assert.equal(root.truncationReason, 'entry-limit');
  const app = await TOOLS.glob.execute({ pattern: '**/package.json' }, context);
  assert.deepEqual(app.matches, ['app/package.json']);
  const listing = await TOOLS.list.execute({}, context);
  assert.match(listing.tree, /📄 pyproject\.toml/);
  assert.match(listing.tree, /📁 app\n  📄 package\.json/);
  assert.equal(listing.truncated, true);
});

test('search recursive includes cover both root files and descendants', async t => {
  const projectDir = fixture(t);
  const result = await TOOLS.search.execute({ pattern: 'alpha', include: '**/*.txt' }, { projectDir });
  assert.ok(result.matches.includes('root.txt:1: alpha'));
  assert.ok(result.matches.includes('src/nested/note.txt:1: alpha'));
  assert.ok(result.matches.includes('build/generated.txt:1: alpha'));
  assert.ok(result.matches.every(hit => !hit.includes('secret.txt') && !hit.includes('ignored.txt')));
});

test('invalid scan scopes fail instead of reporting a successful empty result', async t => {
  const projectDir = fixture(t);
  for (const tool of ['glob', 'search', 'list']) {
    for (const requested of ['missing', 'root.txt']) {
      const result = await runToolCall(null, tool, { path: requested, pattern: 'alpha' }, { projectDir });
      assert.equal(result.ok, false, `${tool}: ${requested}`);
      assert.match(result.error, /ENOENT|must be a directory/);
    }
  }
});

test('unreadable descendants mark the scan incomplete and retain useful results', async t => {
  const projectDir = fixture(t);
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', function (dir, ...args) {
    if (dir === path.join(projectDir, 'build')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original.call(this, dir, ...args);
  });
  const result = await TOOLS.glob.execute({ pattern: '**/package.json' }, { projectDir, inScanWorker: true });
  assert.deepEqual(result.matches, ['app/package.json']);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.warnings, ['Cannot scan build: EACCES']);
});
