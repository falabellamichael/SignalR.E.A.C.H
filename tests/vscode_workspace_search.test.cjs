'use strict';

/* _workspaceSearch / _workspaceGlob execution, sliced straight from
 * extension.js and run against a stub workspace: substring/case/regex search,
 * the include filter, binary skips, glob listing, scoping and no-match text. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../vscode/extension.js'), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, 'missing marker: ' + from);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, 'missing end marker: ' + to);
  return source.slice(start, end);
}

function fixture(files) {
  const calls = [];
  const sandbox = {
    Buffer,
    TREE_EXCLUDES: ['**/node_modules/**'],
    relativePath: (f) => f.fsPath.replace('/ws/', ''),
    vscode: {
      workspace: {
        workspaceFolders: [{ name: 'ws', uri: { fsPath: '/ws' } }],
        findFiles: async (rp, exclude, limit) => {
          calls.push({ pattern: rp.pattern, base: (rp.folder && rp.folder.fsPath) || null, exclude, limit });
          const suffix = String(rp.pattern || '').replace(/^\*\*\//, '').replace(/^\*/, '');
          return Object.keys(files)
            .filter((rel) => !suffix || rel.endsWith(suffix))
            .map((rel) => ({ fsPath: '/ws/' + rel }));
        },
        fs: {
          readFile: async (uri) => Buffer.from(files[uri.fsPath.replace('/ws/', '')] || ''),
        },
      },
      Uri: {
        joinPath: (root, rel) => ({ fsPath: root.fsPath + '/' + rel }),
      },
      RelativePattern: class {
        constructor(folder, pattern) { this.folder = folder; this.pattern = pattern; }
      },
    },
  };
  vm.createContext(sandbox);
  const globSrc = slice('  /* Files matching a glob', '  /* Content search across the workspace')
    .replace('  async _workspaceGlob(', '  async function _workspaceGlob(');
  const searchSrc = slice('  /* Content search across the workspace', '  async _workspaceList(subPath) {')
    .replace('  async _workspaceSearch(', '  async function _workspaceSearch(');
  vm.runInContext(globSrc + '\n' + searchSrc + '\nexported = { _workspaceGlob, _workspaceSearch };', sandbox);
  return { glob: sandbox.exported._workspaceGlob, search: sandbox.exported._workspaceSearch, calls };
}

const FILES = {
  'a.js': 'const Foo = 1;\nlet bar = 2;\nconst FOO2 = 3;\n',
  'b.py': 'print("foo")\n',
  'bin.dat': 'x\u0000y\n',
};

test('search matches case-insensitively and reports path:line: text', async () => {
  const f = fixture(FILES);
  const out = await f.search('foo');
  assert.equal(out, [
    'a.js:1: const Foo = 1;',
    'a.js:3: const FOO2 = 3;',
    'b.py:1: print("foo")',
  ].join('\n'));
});

test('search honours caseSensitive and regex options', async () => {
  const f = fixture(FILES);
  assert.equal(await f.search('Foo', { caseSensitive: true }), 'a.js:1: const Foo = 1;');
  assert.equal(await f.search('const\\s+FOO\\w*', { regex: true, caseSensitive: true }),
    'a.js:3: const FOO2 = 3;');
  await assert.rejects(f.search('(', { regex: true }), /invalid regular expression/);
});

test('search passes the include glob to findFiles and skips binary files', async () => {
  const f = fixture(FILES);
  await f.search('foo', { include: 'src/**/*.js' });
  assert.equal(f.calls.at(-1).pattern, 'src/**/*.js');
  // bin.dat contains the needle ("x") but the NUL byte marks it binary.
  assert.match(await f.search('x'), /No matches for "x"/);
});

test('search reports how many files it scanned when nothing matched', async () => {
  const f = fixture({ 'only.js': 'nothing here\n' });
  assert.match(await f.search('zzz'), /No matches for "zzz" \(scanned 1 files\)\./);
});

test('glob lists matching files sorted with a count', async () => {
  const f = fixture({ 'z.js': '', 'a.js': '', 'b.py': '' });
  assert.equal(await f.glob('**/*.js'), 'a.js\nz.js\n(2 files)');
  assert.equal(await f.glob('**/*.py'), 'b.py\n(1 file)');
  assert.equal(await f.glob('**/*.rs'), 'No files match "**/*.rs".');
});

test('glob scopes to a subdirectory when a path is given', async () => {
  const f = fixture({ 'src/one.js': '' });
  await f.glob('**/*.js', 'src');
  assert.equal(f.calls.at(-1).base, '/ws/src');
});
