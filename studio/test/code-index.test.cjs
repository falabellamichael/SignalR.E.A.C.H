'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildIndex, extractSymbols, maskLiterals, findCycles, contextForQuery,
  formatContext, scoreSymbol, resolveSpecifier, extractImports, indexProject,
  summarize } = require('../agent/code-index.cjs');

test('regex literals do not start a phantom string that swallows the rest of the file', () => {
  // A pattern containing a quote used to blank every symbol after it.
  const source = 'const re = /id="([^"]+)"/;\nfunction first() { return 1; }\nfunction second() { return 2; }\n';
  const { symbols } = extractSymbols('a.js', source);
  const names = symbols.map(s => s.name);
  assert.ok(names.includes('first'), 'first() survived the regex: ' + names.join(','));
  assert.ok(names.includes('second'), 'second() survived the regex: ' + names.join(','));
  assert.ok(names.includes('re'), 'the regex constant itself is indexed');
});

test('masking keeps line numbering and hides string and comment contents', () => {
  const source = 'const a = 1; // trailing\n/* block\ncomment */\nfunction f() { return "secret"; }\n';
  const masked = maskLiterals(source, 'js');
  assert.equal(masked.split('\n').length, source.split('\n').length, 'line count preserved');
  assert.ok(!masked.includes('trailing'), 'line comment hidden');
  assert.ok(!masked.includes('secret'), 'string literal hidden');
  assert.ok(!masked.includes('block'), 'block comment hidden');
  assert.ok(masked.includes('function f()'), 'code survives');
});

test('division is not mistaken for a regex literal', () => {
  const { symbols } = extractSymbols('a.js', 'const total = count / size;\nfunction after() { return total / 2; }\n');
  assert.ok(symbols.some(s => s.name === 'after'), 'symbol after a division expression is found');
});

test('python methods are attributed to their class and module functions are not', () => {
  const source = 'MAX = 3\n\nclass Service:\n    def start(self):\n        return 1\n\n    async def stop(self):\n        pass\n\ndef module_fn():\n    local = 1\n    return local\n';
  const { symbols } = extractSymbols('svc.py', source);
  const byName = Object.fromEntries(symbols.map(s => [s.qualified, s]));
  assert.ok(byName['Service'], 'class found (was dropped when the indent group was read as the name)');
  assert.equal(byName['Service.start']?.scope, 'Service');
  assert.equal(byName['Service.start']?.kind, 'method');
  assert.equal(byName['Service.stop']?.kind, 'method');
  assert.equal(byName['module_fn']?.kind, 'function', 'column-0 def is a module function');
  assert.equal(byName['module_fn']?.scope, null);
  assert.ok(byName['MAX'], 'module constant found');
  assert.ok(!symbols.some(s => s.name === 'local'), 'a function local is not a module symbol');
});

test('locals inside a function body are not indexed as module variables', () => {
  const source = 'const KEEP = 1;\nfunction outer() {\n  const inner = 2;\n  return inner;\n}\n';
  const { symbols } = extractSymbols('a.js', source);
  assert.ok(symbols.some(s => s.name === 'KEEP' && s.kind === 'variable'));
  assert.ok(!symbols.some(s => s.name === 'inner'), 'function-local const excluded');
});

test('IIFE-wrapped module constants are still module scope, not function scope', () => {
  // Every renderer file in this repo is wrapped in an IIFE, so an indent-based
  // scope test discarded all of their constants.
  const source = "(() => {\n  const CONFIG = { a: 1 };\n  function helper() { return CONFIG; }\n})();\n";
  const { symbols } = extractSymbols('w.js', source);
  assert.ok(symbols.some(s => s.name === 'CONFIG'), 'constant inside an IIFE is indexed');
  assert.ok(symbols.some(s => s.name === 'helper'));
});

test('imports resolve to project-relative paths and ignore bare packages', () => {
  const files = new Set(['a.js', 'b.js', 'lib/c.js', 'lib/index.js', 'x.py']);
  assert.equal(resolveSpecifier('a.js', './b.js', files), 'b.js');
  assert.equal(resolveSpecifier('a.js', './lib/c', files), 'lib/c.js');
  assert.equal(resolveSpecifier('a.js', './lib', files), 'lib/index.js');
  assert.equal(resolveSpecifier('lib/c.js', './index', files), 'lib/index.js');
  assert.equal(resolveSpecifier('a.js', 'express', files), null, 'bare package import is external');
  assert.equal(resolveSpecifier('a.js', '../escape', files), null, 'traversal above the root is rejected');
  assert.ok(extractImports("const x = require('./b.js');\nimport y from './lib/c.js';\n").includes('./b.js'));
  assert.ok(extractImports('from .util import helper\n').includes('.util'));
});

test('cycle detection is iterative and survives repository-scale graphs', () => {
  const mk = e => new Map(Object.entries(e));
  assert.deepEqual(findCycles(new Set(['a', 'b']), mk({ a: ['b'], b: ['a'] })), [['a', 'b']]);
  assert.deepEqual(findCycles(new Set(['a', 'b', 'c']), mk({ a: ['b'], b: ['c'], c: ['a'] })), [['a', 'b', 'c']]);
  assert.deepEqual(findCycles(new Set(['a']), mk({ a: ['a'] })), [['a']], 'self-loop');
  assert.deepEqual(findCycles(new Set(['a', 'b']), mk({ a: ['b'] })), [], 'acyclic');
  assert.deepEqual(findCycles(new Set(['a', 'b']), mk({ a: new Set(['b']), b: new Set(['a']) })), [['a', 'b']], 'Set adjacency');
  // 50k-node chain: a recursive Tarjan would overflow the stack here.
  const nodes = new Set(), adj = new Map();
  for (let i = 0; i < 50000; i++) { nodes.add('n' + i); adj.set('n' + i, ['n' + (i + 1)]); }
  assert.deepEqual(findCycles(nodes, adj), []);
});

test('a symbol named only inside a string literal is not a call-graph edge', () => {
  const index = buildIndex([
    { path: 'a.js', content: "const msg = 'indexProject appears only in a string';\nfunction real() { return msg; }\n" },
    { path: 'b.js', content: 'function indexProject() { return real(); }\n' },
  ]);
  // A real reference still resolves: real() genuinely returns msg.
  assert.equal(index.callGraph.get('indexProject')?.has('real'), true, 'a genuine call is an edge');
  assert.equal(index.callGraph.get('real')?.has('msg'), true, 'a genuine reference is an edge');
  // The string mention must not create a reference to indexProject. Scanning
  // raw text used to produce msg -> indexProject, which could manufacture a
  // dependency cycle and halt a valid refactor.
  const referencingIndexProject = [...index.callGraph.entries()]
    .filter(([, refs]) => refs.has('indexProject'))
    .map(([k]) => k);
  assert.deepEqual(referencingIndexProject, [], 'no edge to indexProject from a string literal');
});

test('comments do not create call-graph edges either', () => {
  const index = buildIndex([
    { path: 'a.js', content: 'function target() { return 1; }\n// caller uses target() all the time\nfunction other() { return 2; }\n' },
  ]);
  const fromOther = index.callGraph.get('other');
  assert.ok(!fromOther || !fromOther.has('target'), 'a comment mention is not a reference');
});

test('context retrieval ranks exact name matches above incidental hits', () => {
  const index = buildIndex([
    { path: 'a.js', content: 'function runCommand() { return 1; }\nconst runner = 2;\nfunction unrelated() { return 3; }\n' },
  ]);
  const ctx = contextForQuery(index, 'runCommand', { maxSymbols: 5 });
  assert.equal(ctx.symbols[0].name, 'runCommand', 'exact match ranks first');
  assert.ok(scoreSymbol('runCommand', ctx.symbols[0]) > scoreSymbol('runCommand', { name: 'unrelated', qualified: 'unrelated', signature: '', path: 'a.js' }));
  assert.ok(formatContext(ctx).includes('runCommand'));
  assert.equal(formatContext(contextForQuery(index, 'zzz-nothing')), '', 'no matches yields no block');
});

test('malformed, binary and oversize files are skipped with a reason, never fatal', () => {
  const index = buildIndex([
    { path: 'ok.py', content: 'class Foo:\n    def bar(self):\n        return 1\n' },
    { path: 'broken.js', content: 'function (((( {}{}{ ' },
    { path: 'empty.ts', content: '' },
    { path: 'notes.txt', content: 'not a source file' },
  ]);
  assert.ok(index.symbols.some(s => s.qualified === 'Foo.bar'), 'good file indexed despite bad neighbours');
  assert.ok(index.files >= 3, 'files counted');
  assert.ok(Array.isArray(index.warnings));
});

test('indexProject bounds the walk and reports truncation', () => {
  const index = indexProject(__dirname + '/..', { maxFiles: 3 });
  assert.ok(index.files <= 3, 'maxFiles respected, got ' + index.files);
  assert.equal(index.truncated, true);
  assert.match(index.warnings[0].message, /truncated/i);
  const summary = summarize(index);
  assert.ok(summary.files <= 3 && typeof summary.symbols === 'number');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(summary)), 'summary is JSON-safe');
});

test('indexProject on a missing directory reports an error instead of throwing', () => {
  const index = indexProject(__dirname + '/does-not-exist-anywhere');
  assert.equal(index.files, 0);
  assert.match(index.warnings[0].message, /does not exist/i);
});
