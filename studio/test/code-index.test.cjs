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

/* ------------------------------------------------------------------ tsconfig */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripJsonComments, parseTsConfig, buildTsConfigTables, nearestTsConfig,
  resolveAlias } = require('../agent/code-index.cjs');

test('tsconfig is parsed as JSONC: comments and trailing commas, strings intact', () => {
  const jsonc = `{
    // line comment
    "compilerOptions": {
      "baseUrl": ".", /* block
         comment */
      "paths": { "@utils/*": ["src/utils/*"] },  // trailing
      "url": "http://x/a//b",
    },
  }`;
  // parseTsConfig strips JSONC syntax itself; stripJsonComments is asserted
  // separately below so this stays readable.
  const parsed = parseTsConfig(jsonc);
  assert.equal(parsed.compilerOptions.baseUrl, '.');
  assert.equal(parsed.compilerOptions.url, 'http://x/a//b', '// inside a string must survive');
  assert.equal(parsed.compilerOptions.paths['@utils/*'][0], 'src/utils/*');
  // stripJsonComments must not mangle a comment-like sequence inside a string.
  const stripped = stripJsonComments(jsonc);
  assert.ok(!stripped.includes('line comment'));
  assert.ok(stripped.includes('http://x/a//b'));
  assert.doesNotThrow(() => JSON.parse(stripped), 'stripped output is valid JSON');
});

test('unparseable tsconfig yields null and reports, never throws', () => {
  assert.equal(parseTsConfig(''), null);
  assert.equal(parseTsConfig('not json {{{'), null);
  let warned = null;
  parseTsConfig('{bad}', { onError: m => { warned = m; } });
  assert.match(String(warned), /could not be parsed/);
});

test('alias resolution: wildcard, exact, extensions, index, cross-package', () => {
  const knownFiles = new Set(['src/utils/math.ts', 'src/utils/index.ts', 'src/config.ts',
    'src/deep/nested/thing.tsx', 'packages/ui/button.tsx']);
  const [t] = buildTsConfigTables([{ path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: {
    baseUrl: '.',
    paths: { '@utils/*': ['src/utils/*'], '@config': ['src/config.ts'],
      '@deep/*': ['src/deep/nested/*'], '@ui/*': ['packages/ui/*'] },
  } }) }], knownFiles, []);
  assert.equal(resolveAlias('@utils/math', t), 'src/utils/math.ts');
  assert.equal(resolveAlias('@config', t), 'src/config.ts');
  assert.equal(resolveAlias('@deep/thing', t), 'src/deep/nested/thing.tsx');
  assert.equal(resolveAlias('@ui/button', t), 'packages/ui/button.tsx');
  // `@utils` without the slash does NOT match `@utils/*`; TypeScript requires
  // the literal prefix and `*` may then capture the empty string for `@utils/`.
  assert.equal(resolveAlias('@utils', t), null);
  assert.equal(resolveAlias('@utils/', t), 'src/utils/index.ts');
  assert.equal(resolveAlias('@nope/x', t), null);
  assert.equal(resolveAlias('express', t), null, 'a real bare package stays external');
});

test('resolveSpecifier threads aliases while leaving relatives and externals alone', () => {
  const knownFiles = new Set(['src/a.ts', 'src/utils/math.ts']);
  const [t] = buildTsConfigTables([{ path: 'tsconfig.json', content: JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@utils/*': ['src/utils/*'] } } }) }], knownFiles, []);
  assert.equal(resolveSpecifier('src/a.ts', '@utils/math', knownFiles, t), 'src/utils/math.ts');
  assert.equal(resolveSpecifier('src/a.ts', '@utils/math', knownFiles), null, 'no tsconfig => bare is external');
  assert.equal(resolveSpecifier('src/a.ts', './utils/math', knownFiles, t), 'src/utils/math.ts');
});

test('baseUrl is honoured as a relative root', () => {
  const knownFiles = new Set(['src/lib/x.ts', 'src/main.ts']);
  const [t] = buildTsConfigTables([{ path: 'tsconfig.json', content: JSON.stringify({
    compilerOptions: { baseUrl: 'src', paths: { '@lib/*': ['lib/*'] } } }) }], knownFiles, []);
  assert.equal(t.baseUrl, 'src');
  assert.equal(resolveAlias('@lib/x', t), 'src/lib/x.ts');
});

test('nearest tsconfig governs each file in a monorepo', () => {
  const knownFiles = new Set(['apps/web/src/a.ts', 'packages/lib/src/b.ts']);
  const tables = buildTsConfigTables([
    { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@root/*': ['*'] } } }) },
    { path: 'apps/web/tsconfig.json', content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }) },
    { path: 'packages/lib/tsconfig.json', content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/*'] } } }) },
  ], knownFiles, []);
  assert.equal(tables.length, 3);
  assert.equal(nearestTsConfig('apps/web/src/a.ts', tables).dir, 'apps/web');
  assert.equal(nearestTsConfig('packages/lib/src/b.ts', tables).dir, 'packages/lib');
  assert.equal(nearestTsConfig('other/x.ts', tables).dir, '', 'falls back to the root config');
});

test('extends inherits paths from a base config', () => {
  const knownFiles = new Set(['src/util.ts']);
  const tables = buildTsConfigTables([
    { path: 'tsconfig.base.json', content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@u/*': ['src/*'] } } }) },
    { path: 'tsconfig.json', content: JSON.stringify({ extends: './tsconfig.base.json' }) },
  ], knownFiles, []);
  const leaf = tables.find(x => x.path === 'tsconfig.json');
  assert.equal(leaf.aliasRules.length, 1);
  assert.equal(resolveAlias('@u/util', leaf), 'src/util.ts');
});

test('an aliased import becomes a real dependency edge', () => {
  const index = buildIndex([
    { path: 'src/app.ts', content: "import { add } from '@utils/math';\nexport function main() { return add(1, 2); }\n" },
    { path: 'src/utils/math.ts', content: 'export function add(a: number, b: number): number { return a + b; }\n' },
  ], { tsConfigs: [{ path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: {
    baseUrl: '.', paths: { '@utils/*': ['src/utils/*'] } } }) }] });
  const edges = index.fileGraph.get('src/app.ts');
  assert.ok(edges && edges.includes('src/utils/math.ts'), 'edge: ' + JSON.stringify(edges));
  assert.ok(index.symbols.some(s => s.name === 'add' && s.kind === 'function'));
  assert.ok(index.symbols.some(s => s.name === 'main'));
});

test('indexProject reads tsconfig.json from disk (JSONC with comments)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsidx-'));
  fs.mkdirSync(path.join(dir, 'src/utils'), { recursive: true });
  // A comment and a trailing comma: real-world configs are JSONC, and a plain
  // JSON.parse would throw and silently disable alias resolution.
  fs.writeFileSync(path.join(dir, 'tsconfig.json'),
    '{\n  // path aliases\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@utils/*": ["src/utils/*"] },\n  },\n}\n');
  fs.writeFileSync(path.join(dir, 'src/app.ts'), "import { add } from '@utils/math';\nexport const r = add(1,2);\n");
  fs.writeFileSync(path.join(dir, 'src/utils/math.ts'), 'export function add(a,b){return a+b;}\n');
  const idx = indexProject(dir);
  const edges = idx.fileGraph.get('src/app.ts');
  assert.ok(edges && edges.includes('src/utils/math.ts'), 'resolved from disk: ' + JSON.stringify(edges));
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------- TypeScript declarations */

const TS_SOURCE = `
export interface User {
  id: string;
  name: string;
}
export type ID = string | number;
export type Handler<T> = (value: T) => Promise<void>;
export enum Status { Idle, Running, Done }
export const enum Mode { Fast, Slow }
export abstract class Base<T> {
  protected value: T;
  constructor(v: T) { this.value = v; }
  abstract render(): string;
  async load(): Promise<void> { }
  static create<U>(u: U): Base<U> { return null as any; }
  get size(): number { return 1; }
}
export class Service extends Base<string> implements User {
  readonly id = 'a';
  async fetch(url: string, opts?: RequestInit): Promise<Response> { return null as any; }
}
export function plain(a: number, b = 2): number { return a + b; }
export const arrow = (x: number): number => x * 2;
export const typed: (s: string) => boolean = (s) => !!s;
export default function defaultFn() { return 1; }
declare function ambient(x: number): void;
export namespace Outer {
  export function inner(): void {}
}
export interface Nested {
  child: { deep: string };
  method(x: number): void;
}
`;

function tsSymbols() {
  const { symbols } = extractSymbols('probe.ts', TS_SOURCE);
  return new Map(symbols.map(s => [s.qualified, s]));
}

test('TypeScript type declarations are indexed: interface, type, enum, namespace', () => {
  const byQ = tsSymbols();
  // The PRD requires "type definitions, interface contracts, and exported
  // function signatures" in the symbol index.
  for (const q of ['User', 'ID', 'Handler', 'Status', 'Mode', 'Outer', 'Nested']) {
    assert.ok(byQ.has(q), q + ' indexed');
  }
  assert.equal(byQ.get('Status').kind, 'enum');
  assert.equal(byQ.get('Mode').kind, 'enum', 'const enum is still an enum');
  assert.equal(byQ.get('Outer').kind, 'namespace');
  assert.equal(byQ.get('User').kind, 'interface');
  assert.equal(byQ.get('Handler').kind, 'interface');
  assert.ok(byQ.get('User').exported);
});

test('an abstract class is indexed (the old class rule required a bare "class")', () => {
  const byQ = tsSymbols();
  assert.ok(byQ.has('Base'), 'abstract class Base indexed');
  assert.equal(byQ.get('Base').kind, 'class');
  assert.match(byQ.get('Base').signature, /abstract class Base<T>/, 'generics kept in signature');
});

test('methods with TypeScript return types are indexed and scoped to their class', () => {
  const byQ = tsSymbols();
  // The old rule required `{` immediately after `)`, so any annotated method
  // was dropped — most of a typed codebase.
  for (const q of ['Base.render', 'Base.load', 'Base.create', 'Base.size', 'Base.constructor',
    'Service.fetch', 'Nested.method', 'Outer.inner']) {
    assert.ok(byQ.has(q), q + ' indexed and scoped');
  }
  assert.equal(byQ.get('Base.render').scope, 'Base');
  assert.equal(byQ.get('Service.fetch').scope, 'Service');
  assert.match(byQ.get('Base.render').signature, /abstract render\(\): string;/,
    'a signature-only abstract method keeps its return type');
  assert.match(byQ.get('Service.fetch').signature, /Promise<Response>/);
  assert.match(byQ.get('Base.create').signature, /static create<U>/, 'generic method params kept');
});

test('members of an exported type inherit its exported flag', () => {
  const byQ = tsSymbols();
  // A member line carries no `export` keyword, but Service is exported, so
  // Service.fetch is part of the module's public surface.
  assert.equal(byQ.get('Service.fetch').exported, true);
  assert.equal(byQ.get('Base.load').exported, true);
});

test('a type annotation between name and = does not defeat const rules', () => {
  const byQ = tsSymbols();
  assert.ok(byQ.has('typed'), 'const typed: (s: string) => boolean = ... indexed');
  assert.ok(byQ.has('arrow'), 'const arrow = (x: number): number => ... indexed');
  assert.ok(byQ.has('defaultFn'), 'export default function indexed');
  assert.ok(byQ.has('ambient'), 'declare function indexed');
  assert.ok(byQ.has('plain'), 'export function indexed');
});

test('a plain call statement is never indexed as a method', () => {
  // The signature-only method rule requires an explicit modifier, and the
  // interface-member rule requires an enclosing type body. Without both guards
  // every `foo();` line in a JS file would become a phantom symbol.
  const src = [
    'function setup() {',
    '  doThing();',
    '  other.thing(a, b);',
    '  awaitSomething();',
    '}',
    'doThing();',
    'const cfg = { method(x) { return x; } };',
  ].join('\n');
  const { symbols } = extractSymbols('calls.js', src);
  const names = symbols.map(s => s.qualified);
  assert.ok(names.includes('setup'), 'the real function is indexed');
  assert.ok(names.includes('cfg'), 'the real const is indexed');
  assert.ok(!names.includes('doThing'), 'a call statement is not a declaration');
  assert.ok(!names.includes('thing'), 'a member call is not a declaration');
  assert.ok(!names.includes('awaitSomething'), 'a top-level call is not a declaration');
  assert.equal(symbols.filter(s => s.kind === 'method' && s.scope === null).length, 0,
    'no unscoped method symbols in plain JS');
});

test('enum and namespace kinds never appear in plain JavaScript files', () => {
  const src = 'const enumLike = 1;\nfunction namespace() { return 1; }\nexport { enumLike };\n';
  const { symbols } = extractSymbols('plain.js', src);
  assert.equal(symbols.filter(s => s.kind === 'enum' || s.kind === 'namespace').length, 0,
    'TS-only kinds stayed out of JS');
  assert.ok(symbols.some(s => s.name === 'namespace' && s.kind === 'function'),
    'a JS function named namespace is still a function');
});

test('indexing the real Studio tree produces no phantom symbols', () => {
  // Regression guard for the TypeScript rules against this repo's own JS/CSS.
  const idx = indexProject(path.join(__dirname, '..'), { maxFiles: 4000 });
  assert.ok(idx.symbols.length > 500, 'indexed a meaningful tree: ' + idx.symbols.length);
  const js = idx.symbols.filter(s => /\.c?js$/.test(s.path));
  assert.equal(js.filter(s => (s.kind === 'enum' || s.kind === 'namespace')).length, 0,
    'no TS-only kinds leaked into JS');
  for (const s of js) {
    if (s.kind === 'variable') assert.match(s.signature, /(?:^|\s)(?:const|let|var)\s/,
      'variable symbol is a real declaration: ' + s.path + ':' + s.line);
    if (s.kind === 'method') {
      // An unscoped method is legitimate — object-literal shorthand such as
      // `async execute(args, ctx) {` belongs to an anonymous object, so it has
      // no type scope. What must never happen is a CALL STATEMENT being
      // indexed. The discriminator is the body brace: every method definition
      // opens one (`{`), while a call such as `doThing();` or
      // `other.thing(a, b);` never does. Checking only for a trailing `{`
      // would wrongly reject one-liners like `add(text) { n++; },`.
      const sig = (s.signature || '').trim();
      assert.ok(sig.includes('{'),
        'method symbol is a definition, not a call: ' + s.path + ':' + s.line + ' ' + JSON.stringify(sig.slice(0, 70)));
      assert.ok(!/^\s*[A-Za-z_$][\w$.]*\([^)]*\)\s*;/.test(sig),
        'method symbol is not a bare call statement: ' + s.path + ':' + s.line + ' ' + JSON.stringify(sig.slice(0, 70)));
    }
  }
});
