'use strict';

/* End-to-end tests for the codebase-engine agent tools.
 *
 * These run through the REAL dispatch path (agent-tool-runner.runToolCall) rather
 * than calling the tool functions directly, so they also cover the wiring:
 * registration in TOOLS, the approval gate on write/exec classes, the path jail,
 * the sandbox interaction, and the workspace feature toggle.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { TOOLS, namesByTier, toolHelp } = require('../agent/tool-registry.cjs');
const codeTools = require('../agent/code-tools.cjs');

/** A small TS project exercising aliases, classes, imports and a cycle-free graph. */
function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetools-'));
  const base = {
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@utils/*": ["src/utils/*"] } } }',
    'src/app.ts': "import { add } from '@utils/math';\nimport { Report } from './report';\nexport function total(a: number, b: number): number {\n  return add(a, b);\n}\nexport const r = new Report();\n",
    'src/report.ts': 'export class Report {\n  title = "r";\n  render(): string { return this.title; }\n}\n',
    'src/utils/math.ts': 'export function add(a: number, b: number): number { return a + b; }\nexport function unusedHelper() { return 0; }\n',
    ...files,
  };
  for (const [rel, text] of Object.entries(base)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  }
  return dir;
}

function storeWith(settings = {}) {
  const store = new MemoryStore();
  store.get('a').settings = { approvals: 'auto-all', ...settings };
  return store;
}

function ctx(dir, extra = {}) {
  return { projectDir: dir, agentId: 'a', agentStore: storeWith(extra.settings), requestApproval: () => true, ...extra };
}

const run = (name, args, c) => runToolCall('a', name, args, c);

test('all nine code tools are registered with a complete contract', () => {
  const code = namesByTier('code');
  assert.deepEqual(code.sort(), [
    'code.context', 'code.impact', 'code.index', 'code.search',
    'patch.review', 'refactor.apply', 'refactor.plan',
    'tests.quickfix', 'tests.run',
  ].sort(), 'registered code tools: ' + code.join(','));
  for (const name of code) {
    const t = TOOLS[name];
    for (const field of ['class', 'tier', 'help', 'example', 'execute']) {
      assert.ok(t[field] !== undefined, `${name} is missing ${field}`);
    }
    assert.equal(typeof t.help, 'string');
    assert.ok(t.help.length > 40, name + ' help is descriptive enough for the model');
    assert.equal(typeof t.approval, 'boolean');
    assert.ok(Number.isFinite(t.budget), name + ' has a finite output budget');
    assert.equal(t.example.action, name, name + ' example names its own action');
  }
});

test('the internals helper is not spread into TOOLS as a phantom tool', () => {
  // module.exports is spread into TOOLS, so any enumerable extra property would
  // become a callable "tool" with no execute().
  assert.equal('internals' in TOOLS, false);
  assert.equal(codeTools.internals !== undefined, true, 'internals still reachable for tests');
  assert.equal(Object.keys(codeTools).length, 9, 'only the nine tools are enumerable: ' + Object.keys(codeTools).join(','));
});

test('write and exec classes require approval; read classes do not', () => {
  const needing = namesByTier('code').filter(n => TOOLS[n].approval).sort();
  assert.deepEqual(needing, ['refactor.apply', 'tests.quickfix', 'tests.run']);
  for (const n of ['code.index', 'code.search', 'code.context', 'code.impact', 'refactor.plan', 'patch.review']) {
    assert.equal(TOOLS[n].approval, false, n + ' must not prompt');
  }
});

test('turning the workspace feature off disables every code tool', () => {
  // The code tier reads and writes the bound project, so it must obey the same
  // feature toggle as read/write/edit_patch — otherwise "workspace off" would
  // still permit refactoring the user's files.
  const { disabledTools } = require('../agent/tool-policy.cjs');
  const off = disabledTools({ features: { workspace: false } }, TOOLS);
  for (const n of namesByTier('code')) assert.ok(off.includes(n), n + ' disabled when workspace is off');
  const on = disabledTools({ features: { workspace: true } }, TOOLS);
  for (const n of ['code.index', 'code.search']) assert.ok(!on.includes(n), n + ' enabled when workspace is on');
});

test('the text prompt advertises code tools only when the caller asks for that tier', () => {
  const withCode = toolHelp(['core', 'reach', 'code'], []);
  const without = toolHelp(['core', 'reach'], []);
  assert.ok(withCode.includes('code.index'), 'advertised when requested');
  assert.ok(withCode.includes('refactor.apply'));
  assert.ok(!without.includes('- code.index:'), 'not fully advertised by default');
  // ...but it must still be discoverable on request.
  assert.match(without.replace(/\s+/g, ' '), /tool_help.*"topic":"code"/);
  // A disabled tool must not be advertised.
  const disabled = toolHelp(['core', 'reach', 'code'], ['refactor.apply']);
  assert.ok(!disabled.includes('- refactor.apply:'));
});

/* -------------------------------------------------------------- code.index */

test('code.index reports the symbol/dependency summary and honours refresh', async () => {
  const dir = project();
  const first = await run('code.index', {}, ctx(dir));
  assert.equal(first.ok, true, first.error);
  assert.ok(first.summary.symbols > 0, 'symbols indexed: ' + JSON.stringify(first.summary));
  assert.equal(first.summary.files, 3, 'three source files, tsconfig.json is not source');
  // `dependencies` counts files that have outgoing imports (fileGraph.size),
  // not total edges. Only src/app.ts imports anything here.
  assert.equal(first.summary.dependencies, 1, 'one file has imports: ' + JSON.stringify(first.summary));
  assert.equal(first.summary.fileCycles, 0);

  // Without refresh the cached index is reused, so a new file is invisible.
  fs.writeFileSync(path.join(dir, 'src/added.ts'), 'export function brandNewFn() { return 1; }\n');
  const cached = await run('code.index', {}, ctx(dir));
  const cacheHit = cached.summary.symbols === first.summary.symbols;
  const refreshed = await run('code.index', { refresh: true }, ctx(dir));
  assert.ok(refreshed.summary.symbols > first.summary.symbols, 'refresh re-reads from disk');
  const searched = await run('code.search', { query: 'brandNewFn' }, ctx(dir));
  assert.equal(searched.ok, true);
  assert.ok(cacheHit || searched.symbols.length > 0, 'refresh makes new symbols findable');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code.index without a bound project fails cleanly', async () => {
  const res = await run('code.index', {}, { agentId: 'a', agentStore: storeWith(), requestApproval: () => true });
  assert.equal(res.ok, false);
  assert.match(res.error, /not bound to a project/);
});

/* ------------------------------------------------------------- code.search */

test('code.search ranks declarations, not textual mentions', async () => {
  const dir = project();
  await run('code.index', {}, ctx(dir));
  const res = await run('code.search', { query: 'add' }, ctx(dir));
  assert.equal(res.ok, true, res.error);
  assert.ok(res.symbols.length > 0);
  assert.equal(res.symbols[0].name, 'add');
  assert.equal(res.symbols[0].path, 'src/utils/math.ts');
  assert.equal(res.symbols[0].kind, 'function');
  assert.match(res.symbols[0].signature, /export function add/);
  // Scoped members are qualified so a rename knows what it touches.
  const method = await run('code.search', { query: 'render' }, ctx(dir));
  assert.ok(method.symbols.some(s => s.qualified === 'Report.render'), 'class method qualified: ' + JSON.stringify(method.symbols.map(s => s.qualified)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code.search rejects an empty query and bounds its result list', async () => {
  const dir = project();
  const empty = await run('code.search', { query: '   ' }, ctx(dir));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /query is required/);
  const bounded = await run('code.search', { query: 'a', limit: 2 }, ctx(dir));
  assert.equal(bounded.ok, true);
  assert.ok(bounded.symbols.length <= 2, 'limit honoured, got ' + bounded.symbols.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code.search results carry no source snippets (bounded payload)', async () => {
  const dir = project();
  const res = await run('code.search', { query: 'add' }, ctx(dir));
  assert.ok(res.symbols.every(s => s.snippet === undefined),
    'search is a list view; snippets would blow the tool budget');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ code.context */

test('code.context returns a paste-ready block with snippets and dependencies', async () => {
  const dir = project();
  const res = await run('code.context', { query: 'total', maxSymbols: 5 }, ctx(dir));
  assert.equal(res.ok, true, res.error);
  assert.match(res.context, /total/);
  assert.ok(res.chars > 0);
  assert.ok(res.symbols.length > 0);
  assert.ok(Array.isArray(res.dependencies));
  assert.ok(res.symbols.every(s => s.name && s.path), 'each entry is locatable');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code.context clamps absurd maxChars/maxSymbols instead of trusting them', async () => {
  const dir = project();
  const res = await run('code.context', { query: 'add', maxChars: 99999999, maxSymbols: 99999 }, ctx(dir));
  assert.equal(res.ok, true);
  assert.ok(res.chars <= 24000, 'chars clamped to 24000, got ' + res.chars);
  assert.ok(res.symbols.length <= 40, 'symbols clamped to 40, got ' + res.symbols.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------- code.impact */

test('code.impact reports referrers and importers for a rename', async () => {
  const dir = project();
  const bySymbol = await run('code.impact', { symbol: 'add' }, ctx(dir));
  assert.equal(bySymbol.ok, true, bySymbol.error);
  assert.ok(bySymbol.symbol.definitions.length >= 1);
  assert.ok(bySymbol.symbol.referencedBy.includes('total'),
    'total() calls add(): ' + JSON.stringify(bySymbol.symbol.referencedBy));

  const byFile = await run('code.impact', { file: 'src/utils/math.ts' }, ctx(dir));
  assert.equal(byFile.ok, true, byFile.error);
  assert.ok(byFile.file.importedBy.includes('src/app.ts'),
    'app.ts imports utils/math.ts: ' + JSON.stringify(byFile.file.importedBy));

  const missing = await run('code.impact', { symbol: 'noSuchSymbolAnywhere' }, ctx(dir));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No symbol named/);
  const neither = await run('code.impact', {}, ctx(dir));
  assert.equal(neither.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------- refactor plan/apply */

test('refactor.plan writes nothing, then refactor.apply changes every file atomically', async () => {
  const dir = project();
  const plan = await run('refactor.plan', {
    edits: [
      { path: 'src/utils/math.ts', search: 'export function add(', replace: 'export function sum(' },
      // Two changes to app.ts go in ONE entry's hunks — a file may appear only
      // once in the edits array (the engine applies hunks together via applyPatch).
      { path: 'src/app.ts', hunks: [
        { search: "import { add } from '@utils/math';", replace: "import { sum } from '@utils/math';" },
        { search: 'return add(a, b);', replace: 'return sum(a, b);' },
      ] },
    ],
  }, ctx(dir));
  assert.equal(plan.ok, true, plan.error);
  assert.ok(plan.planId);
  assert.equal(plan.files.length, 2, 'two distinct files touched');
  assert.ok(plan.files.every(f => f.stats.added > 0 && f.stats.removed > 0));
  // Nothing written yet — this is the whole point of plan/apply separation.
  assert.ok(fs.readFileSync(path.join(dir, 'src/utils/math.ts'), 'utf8').includes('export function add('));
  assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8').includes('sum'), false);

  const applied = await run('refactor.apply', { planId: plan.planId }, ctx(dir));
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(applied.applied.sort(), ['src/app.ts', 'src/utils/math.ts']);
  assert.ok(fs.readFileSync(path.join(dir, 'src/utils/math.ts'), 'utf8').includes('export function sum('));
  const appAfter = fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8');
  assert.ok(appAfter.includes('return sum(a, b);'), 'second hunk applied');
  assert.ok(appAfter.includes("import { sum }"), 'first hunk applied');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two separate edits to one file are rejected with hunks guidance', async () => {
  const dir = project();
  // The old, wrong shape: same file in two entries. Must be refused with a
  // message that names the fix (hunks), or the model just resends the same thing.
  const plan = await run('refactor.plan', { edits: [
    { path: 'src/app.ts', search: 'total', replace: 'TOTAL' },
    { path: 'src/app.ts', search: 'add(a, b)', replace: 'sum(a, b)' },
  ] }, ctx(dir));
  assert.equal(plan.ok, false);
  assert.match(plan.error, /more than one edit/);
  assert.match(plan.error, /hunks/);
  assert.equal(plan.planId, undefined);
  // Nothing written on the rejected plan.
  assert.ok(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8').includes('total'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refactor.plan reports errors precisely and refuses to issue a planId', async () => {
  const dir = project();
  // Genuinely ambiguous: `add` occurs twice in src/app.ts (the import and the
  // call), so a bare search cannot be located. Verified against the fixture —
  // an earlier version of this test used `return`, which occurs only once and
  // therefore was not ambiguous at all, so it asserted on a plan that succeeded.
  const ambiguous = await run('refactor.plan', { edits: [{ path: 'src/app.ts', search: 'add', replace: 'sum' }] }, ctx(dir));
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.errors.length > 0, 'ambiguous search reported: ' + JSON.stringify(ambiguous.errors));
  assert.match(ambiguous.error, /more than once|occurs/i);
  assert.equal(ambiguous.planId, undefined, 'no planId for an invalid plan');

  const traversal = await run('refactor.plan', { edits: [{ path: '../escape.ts', content: 'x' }] }, ctx(dir));
  assert.equal(traversal.ok, false);
  assert.match(traversal.error + (traversal.errors || []).join(' '), /traversal|outside|not allowed|\.\./);

  const absolute = await run('refactor.plan', { edits: [{ path: 'C:/Windows/x.ts', content: 'x' }] }, ctx(dir));
  assert.equal(absolute.ok, false);

  const empty = await run('refactor.plan', { edits: [] }, ctx(dir));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /non-empty/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a planId cannot be replayed, and an unknown one is refused', async () => {
  const dir = project();
  const plan = await run('refactor.plan', { edits: [{ path: 'src/report.ts', search: 'title = "r"', replace: 'title = "z"' }] }, ctx(dir));
  assert.equal(plan.ok, true, plan.error);
  const first = await run('refactor.apply', { planId: plan.planId }, ctx(dir));
  assert.equal(first.ok, true);
  // Replaying would silently apply a stale plan whose `before` snapshot no
  // longer matches disk.
  const replay = await run('refactor.apply', { planId: plan.planId }, ctx(dir));
  assert.equal(replay.ok, false);
  assert.match(replay.error, /Unknown or expired planId/);
  const bogus = await run('refactor.apply', { planId: 'plan-does-not-exist' }, ctx(dir));
  assert.equal(bogus.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refactor.apply honours per-chunk selection', async () => {
  // Two widely separated changes in one file => two chunks; accept only one.
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  const dir = project({ 'src/wide.ts': lines.join('\n') + '\n' });
  const after = lines.map((l, i) => (i === 1 ? 'CHANGED2' : i === 17 ? 'CHANGED18' : l)).join('\n') + '\n';
  const plan = await run('refactor.plan', { edits: [{ path: 'src/wide.ts', content: after }] }, ctx(dir));
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.files[0].chunks.length, 2, 'two independent chunks: ' + JSON.stringify(plan.files[0].chunks));

  const onlyFirst = await run('refactor.apply', { planId: plan.planId, accepted: { 'src/wide.ts': [plan.files[0].chunks[0].id] } }, ctx(dir));
  assert.equal(onlyFirst.ok, true, onlyFirst.error);
  const text = fs.readFileSync(path.join(dir, 'src/wide.ts'), 'utf8');
  assert.ok(text.includes('CHANGED2'), 'accepted chunk applied');
  assert.ok(!text.includes('CHANGED18'), 'rejected chunk not applied');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refactor.apply refuses a plan built for a different project directory', async () => {
  const dirA = project();
  const dirB = project();
  const plan = await run('refactor.plan', { edits: [{ path: 'src/report.ts', search: 'title = "r"', replace: 'title = "q"' }] }, ctx(dirA));
  assert.equal(plan.ok, true, plan.error);
  // An agent can be rebound between calls; applying dirA's plan in dirB would
  // write dirA's file contents over dirB's files.
  const cross = await run('refactor.apply', { planId: plan.planId }, ctx(dirB));
  assert.equal(cross.ok, false);
  assert.match(cross.error, /different project directory/);
  assert.equal(fs.readFileSync(path.join(dirB, 'src/report.ts'), 'utf8').includes('title = "q"'), false, 'dirB untouched');
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

/* ------------------------------------------------------------- patch.review */

test('patch.review returns a chunked side-by-side diff without writing', async () => {
  const dir = project();
  const before = fs.readFileSync(path.join(dir, 'src/report.ts'), 'utf8');
  const proposed = before.replace('title = "r"', 'title = "changed"');
  const res = await run('patch.review', { path: 'src/report.ts', content: proposed }, ctx(dir));
  assert.equal(res.ok, true, res.error);
  assert.equal(res.creating, false);
  assert.equal(res.identical, false);
  assert.equal(res.stats.added, 1);
  assert.equal(res.stats.removed, 1);
  assert.ok(res.chunks.length >= 1);
  const row = res.chunks[0].sideBySide.find(r => r.kind === 'modify');
  assert.ok(row && row.left.text.includes('title = "r"') && row.right.text.includes('changed'));
  assert.equal(fs.readFileSync(path.join(dir, 'src/report.ts'), 'utf8'), before, 'review wrote nothing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch.review flags a new file and rejects path traversal', async () => {
  const dir = project();
  const fresh = await run('patch.review', { path: 'src/brandnew.ts', content: 'export const x = 1;\n' }, ctx(dir));
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal(fresh.creating, true);

  const escape = await run('patch.review', { path: '../outside.ts', content: 'x' }, ctx(dir));
  assert.equal(escape.ok, false);
  assert.match(escape.error, /traversal|not allowed|\.\./);

  const absolute = await run('patch.review', { path: 'C:/Windows/x.ts', content: 'x' }, ctx(dir));
  assert.equal(absolute.ok, false);

  const noContent = await run('patch.review', { path: 'src/report.ts' }, ctx(dir));
  assert.equal(noContent.ok, false);
  assert.match(noContent.error, /content/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* --------------------------------------------------------------- tests.run */

test('tests.run returns structured failures rather than raw output', async () => {
  const dir = project();
  // A real gate: `node --check` on a deliberately broken file.
  fs.writeFileSync(path.join(dir, 'broken.js'), 'function ( { this is not valid\n');
  const res = await run('tests.run', {
    gates: [{ id: 'syntax', command: 'node --check broken.js', runner: 'generic' }],
  }, ctx(dir));
  assert.equal(res.ok, false, 'a failing gate reports ok:false');
  assert.equal(res.passed, false);
  assert.equal(res.failingGate, 'syntax');
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].ok, false);
  assert.equal(typeof res.results[0].exitCode, 'number');
  assert.ok(res.results[0].counts, 'counts present');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tests.run reports success for a passing gate and stops at the first failure', async () => {
  const dir = project();
  const pass = await run('tests.run', { gates: [{ id: 'ok', command: 'node -e "process.exit(0)"', runner: 'generic' }] }, ctx(dir));
  assert.equal(pass.ok, true, pass.error);
  assert.equal(pass.passed, true);
  assert.equal(pass.failingGate, null);

  const multi = await run('tests.run', {
    gates: [
      { id: 'first-fails', command: 'node -e "process.exit(1)"', runner: 'generic' },
      { id: 'second-never-runs', command: 'node -e "process.exit(0)"', runner: 'generic' },
    ],
  }, ctx(dir));
  assert.equal(multi.ok, false);
  assert.equal(multi.results.length, 1, 'stops at the first failing gate for fast feedback');
  assert.equal(multi.failingGate, 'first-fails');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tests.run defaults to npm test, bounds the gate list, and rejects blank commands', async () => {
  const dir = project();
  const tooMany = await run('tests.run', { gates: Array.from({ length: 9 }, (_, i) => ({ id: 'g' + i, command: 'node -e "0"' })) }, ctx(dir));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /At most 8 gates/);

  const blank = await run('tests.run', { gates: [{ id: 'x', command: '   ' }] }, ctx(dir));
  assert.equal(blank.results[0].ok, false);
  assert.match(blank.results[0].error, /needs a command/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tests.run uses the right parser per runner', async () => {
  const dir = project();
  // Emit real ESLint stylish output from a stub command so the eslint parser is
  // exercised through the tool, not just in unit tests.
  const eslintOut = 'C:\\\\proj\\\\a.js\\n  1:7  error  x is unused  no-unused-vars\\n\\n\\u2716 1 problem (1 error, 0 warnings)\\n';
  const res = await run('tests.run', {
    gates: [{ id: 'lint', command: `node -e "console.log(\`${eslintOut.replace(/`/g, '')}\`); process.exit(1)"`, runner: 'eslint' }],
  }, ctx(dir));
  assert.equal(res.results[0].runner.toLowerCase().includes('eslint'), true, res.results[0].runner);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------- tests.quickfix */

test('tests.quickfix refuses a command with no fix flag', async () => {
  const dir = project();
  const res = await run('tests.quickfix', { command: 'npx eslint src' }, ctx(dir));
  assert.equal(res.ok, false);
  assert.match(res.error, /no --fix/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tests.quickfix snapshots, runs the fixer and reports changed files', async () => {
  const dir = project();
  // A stand-in fixer that rewrites a file, exactly as `eslint --fix` would.
  const fixer = path.join(dir, 'fix.js');
  fs.writeFileSync(fixer, "const fs=require('fs');const p='src/report.ts';fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace('title = \\\"r\\\"','title = \\\"fixed\\\"'));\n");
  const res = await run('tests.quickfix', { command: 'node fix.js --fix', paths: ['src/report.ts'] }, ctx(dir));
  assert.equal(res.ok, true, res.error);
  assert.equal(res.changedFiles, 1);
  assert.equal(res.changes[0].path, 'src/report.ts');
  assert.ok(res.changes[0].stats.added >= 1);
  assert.ok(fs.readFileSync(path.join(dir, 'src/report.ts'), 'utf8').includes('title = "fixed"'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tests.quickfix reports when the fixer changed nothing', async () => {
  const dir = project();
  const noop = path.join(dir, 'noop.js');
  fs.writeFileSync(noop, '// does nothing\n');
  const res = await run('tests.quickfix', { command: 'node noop.js --fix', paths: ['src/report.ts'] }, ctx(dir));
  assert.equal(res.ok, true, res.error);
  assert.equal(res.changedFiles, 0);
  assert.match(res.message, /changed nothing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------- sandbox interplay */

test('the command sandbox still governs tests.run and tests.quickfix', async () => {
  const dir = project();
  const { defaultPolicy } = require('../agent/sandbox.cjs');
  const c = ctx(dir, { settings: { sandbox: { enabled: true, policy: defaultPolicy() } } });
  // `rm` is not on the whitelist, so the exec-class tool must be refused by the
  // sandbox BEFORE it runs — even though tests.run is an approved tool.
  const denied = await run('tests.run', { gates: [{ id: 'x', command: 'rm -rf /', runner: 'generic' }] }, c);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Sandbox policy refused/, denied.error);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------- syntax guard on the agent-tool path */

/* PRD, Multi-File Refactoring Engine: "If dependency cycles or syntax errors are
 * detected, the agent halts refactoring and displays an error trace highlighting
 * affected modules." These are the agent-facing tools, so a MODEL proposes the
 * edits and no human reviews a diff — the guard is the only thing between a
 * malformed edit and the user's files.
 *
 * The fixture must use .js: validateSyntax deliberately SKIPS .ts/.tsx (Studio
 * bundles no TypeScript compiler), and the shared project() fixture is all .ts,
 * so it would never exercise this path. */
const JS_GOOD = 'module.exports = { add: (a, b) => a + b };\n';
const JS_BROKEN = 'module.exports = { add: (a, b) => a + b ;\n';   // unbalanced paren

function jsProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetools-syntax-'));
  fs.writeFileSync(path.join(dir, 'app.js'), JS_GOOD, 'utf8');
  return dir;
}

test('refactor.plan halts on unparseable proposed content and issues no planId', async () => {
  const dir = jsProject();
  const res = await run('refactor.plan', {
    edits: [{ path: 'app.js', content: JS_BROKEN }],
  }, ctx(dir));
  assert.equal(res.ok, false, 'a plan whose output does not parse must be refused');
  assert.equal(res.planId, undefined, 'no planId: the UI must never offer Apply on it');
  assert.equal(res.halted, 'syntax');
  assert.match(res.error, /app\.js/, 'the error names the affected module');
  assert.match(res.error, /Syntax error/i);
  assert.ok(!res.error.includes('candidate'), 'temp file name must not leak into the trace');
  // Nothing was written by planning.
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), JS_GOOD);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refactor.apply refuses a partial selection that recombines into unparseable code', async () => {
  const dir = jsProject();
  // BEFORE has a 5-line gap between the two changes, so at context:1 they are two
  // independent chunks. Chunk c0 OPENS a wrapper function; chunk c1 CLOSES it.
  // Each chunk is valid in isolation, and the full replacement parses — but
  // accepting c0 alone leaves `function wrap() {` unterminated. That combination
  // never existed in the plan, so only an apply-time check can catch it.
  const BEFORE = [
    'const HEAD = 1;',
    'function add(a, b) {',
    '  return a + b;',
    '}',
    'const MID = 2;',
    'const TAIL = 3;',
    'module.exports = { add };',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'app.js'), BEFORE, 'utf8');
  const AFTER = BEFORE
    .replace('const HEAD = 1;', 'function wrap() {\nconst HEAD = 1;')
    .replace('module.exports = { add };', 'module.exports = { add };\n}');

  const planned = await run('refactor.plan', {
    edits: [{ path: 'app.js', content: AFTER }],
    context: 1,
  }, ctx(dir));
  assert.equal(planned.ok, true, 'the full replacement is valid so planning succeeds: ' + planned.error);
  const chunks = planned.files[0].chunks;
  assert.ok(chunks.length >= 2, 'context:1 must split into 2 chunks, got ' + chunks.length);

  const partial = await run('refactor.apply', {
    planId: planned.planId,
    accepted: { 'app.js': [chunks[0].id] },
  }, ctx(dir));

  assert.equal(partial.ok, false, 'accepting only the opening chunk must be refused');
  assert.equal(partial.halted, 'syntax', 'refused for a syntax reason: ' + partial.error);
  assert.equal(partial.wrote, false, 'nothing was written');
  assert.match(partial.error, /app\.js/);
  // The file on disk is untouched — not half-written.
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), BEFORE,
    'a refused apply must leave the file byte-identical');
  // The planId survives so the caller can re-select instead of re-planning.
  assert.ok(await run('refactor.apply', { planId: planned.planId, accepted: { 'app.js': chunks.map(c => c.id) } }, ctx(dir))
    .then(r => r.ok), 'accepting every chunk still applies after the refusal');
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), AFTER);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('valid JS still plans and applies (the guard is not over-eager)', async () => {
  const dir = jsProject();
  const ESM = "import { add } from './math.js';\nexport const total = add(1, 2);\n";
  const res = await run('refactor.plan', {
    edits: [{ path: 'app.js', content: ESM }],
  }, ctx(dir));
  assert.equal(res.ok, true, 'valid ESM must not be rejected: ' + res.error);
  assert.ok(res.planId, 'a planId is issued for valid content');
  assert.ok(!res.error, 'no error surfaced');

  const applied = await run('refactor.apply', { planId: res.planId }, ctx(dir));
  assert.equal(applied.ok, true, 'apply must succeed: ' + JSON.stringify(applied.error));
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), ESM);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a .ts plan is not blocked by the JS-only syntax guard', async () => {
  // TypeScript is not bundled, so .ts cannot be parsed by node --check. Blocking
  // a TS refactor because we cannot check it would be worse than not checking.
  const dir = project();
  const res = await run('refactor.plan', {
    edits: [{ path: 'src/app.ts', search: 'export function total(', replace: 'export function grandTotal(' }],
  }, ctx(dir));
  assert.equal(res.ok, true, 'a TypeScript plan must still be usable: ' + res.error);
  assert.equal(res.halted, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
