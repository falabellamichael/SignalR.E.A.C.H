'use strict';

/* Syntax guard for refactor plans.
 *
 * PRD, Multi-File Refactoring Engine: "If dependency cycles or syntax errors are
 * detected, the agent halts refactoring and displays an error trace highlighting
 * affected modules." Cycles were already enforced; this covers syntax errors,
 * which nothing validated — model-proposed content with an unbalanced brace would
 * have been written over the user's file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require('../agent/refactor.cjs');

const GOOD = 'function computeTotal(a, b) {\n  return a + b;\n}\nmodule.exports = { computeTotal };\n';
const BROKEN = 'function computeTotal(a, b) {\n  return a + b;\n';   // unbalanced brace
const ESM = "import { x } from './y.mjs';\nexport const z = x + 1;\n";
const TOPAWAIT = "const a = await Promise.resolve(1);\nexport default a;\n";

function planOf(files) {
  return { files: files.map(([p, after]) => ({ path: p, before: null, after, creating: false })) };
}

/* ------------------------------------------------- injected checker (fast) */

test('a syntax error in proposed content is reported against the user file', async () => {
  const res = await R.validateSyntax(planOf([['src/a.js', BROKEN], ['src/b.js', GOOD]]));
  assert.equal(res.ok, false, 'broken content must not pass');
  assert.equal(res.errors.length, 1, 'exactly the broken file is an error');
  assert.match(res.errors[0], /src\/a\.js/, 'the error names the affected module');
  assert.match(res.errors[0], /Syntax error/i);
  assert.ok(!res.errors[0].includes('candidate'), 'temp file name must not leak into the trace');
});

test('valid CommonJS and ESM both pass (no false rejections)', async () => {
  for (const [label, src] of [['cjs', GOOD], ['esm', ESM], ['top-level-await', TOPAWAIT]]) {
    const res = await R.validateSyntax(planOf([['src/m.js', src]]));
    assert.equal(res.ok, true, `${label} must be accepted`);
    assert.deepEqual(res.errors, [], `${label} produced errors: ${res.errors.join('; ')}`);
  }
});

test('the default checker really rejects broken code and accepts valid code', async () => {
  const broken = R.defaultCheckSyntax(BROKEN);
  assert.equal(broken.ok, false, 'unbalanced brace must be rejected');
  assert.match(String(broken.error), /SyntaxError/);

  assert.equal(R.defaultCheckSyntax(GOOD).ok, true, 'valid CJS');
  assert.equal(R.defaultCheckSyntax(ESM).ok, true, 'valid ESM in a .js file');
  assert.equal(R.defaultCheckSyntax(TOPAWAIT).ok, true, 'top-level await');
});

test('files node cannot parse are skipped, never blocked', async () => {
  // Studio bundles no TypeScript compiler. Refusing to refactor a TS project
  // would be worse than not checking it.
  const res = await R.validateSyntax(planOf([
    ['src/a.ts', BROKEN], ['src/b.tsx', BROKEN], ['src/c.jsx', BROKEN],
    ['styles.css', 'not js at all'], ['data.json', '{'], ['readme.md', '# hi'],
  ]));
  assert.equal(res.ok, true, 'unparseable extensions must not block a plan');
  assert.equal(res.errors.length, 0);
  assert.equal(res.checked, 0, 'nothing was validated');
  assert.ok(res.skipped >= 6, 'every file was skipped: ' + res.skipped);
});

test('a checker that throws cannot turn into a syntax error', async () => {
  const res = await R.validateSyntax(planOf([['src/a.js', GOOD]]), {
    checkSyntax: () => { throw new Error('tmp dir full'); },
  });
  assert.equal(res.ok, true, 'an infrastructure failure must not blame the user code');
  assert.equal(res.errors.length, 0);
  assert.ok(res.warnings.some(w => /not syntax-checked/.test(w)), 'the skip is surfaced as a warning');
});

test('an oversized plan checks a bounded prefix and warns', async () => {
  const many = Array.from({ length: R.SYNTAX_MAX_FILES + 25 }, (_, i) => [`src/f${i}.js`, GOOD]);
  let calls = 0;
  const res = await R.validateSyntax(planOf(many), {
    checkSyntax: () => { calls++; return { ok: true }; },
  });
  assert.equal(calls, R.SYNTAX_MAX_FILES, 'bounded to SYNTAX_MAX_FILES checks');
  assert.ok(res.warnings.some(w => /not verified/.test(w)), 'warns about the unverified remainder');
});

test('checks run concurrently, bounded by SYNTAX_CHECK_CONCURRENCY', async () => {
  let live = 0, peak = 0;
  const files = Array.from({ length: 40 }, (_, i) => [`src/f${i}.js`, GOOD]);
  await R.validateSyntax(planOf(files), {
    checkSyntax: async () => {
      live++; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 8));
      live--;
      return { ok: true };
    },
  });
  assert.ok(peak > 1, 'checks overlap rather than running serially (peak ' + peak + ')');
  assert.ok(peak <= R.SYNTAX_CHECK_CONCURRENCY, 'concurrency capped at ' + R.SYNTAX_CHECK_CONCURRENCY + ', saw ' + peak);
});

test('every broken file in a multi-file plan is reported, not just the first', async () => {
  const res = await R.validateSyntax(planOf([
    ['src/a.js', BROKEN], ['src/b.js', GOOD], ['src/c.js', 'const x = ;'], ['src/d.js', BROKEN],
  ]));
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 3, 'a, c and d are all broken');
  const named = res.errors.map(e => e.match(/"([^"]+)"/)[1]).sort();
  assert.deepEqual(named, ['src/a.js', 'src/c.js', 'src/d.js']);
});

/* ------------------------------------------- integration with planFromEdits */

test('a plan whose proposed code is broken is refused end to end before any write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synguard-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/app.js'), GOOD);

  // Stage a plan that would break the file.
  const plan = R.planFromEdits(
    [{ path: 'src/app.js', hunks: [{ search: 'return a + b;', replace: 'return a + b; ((( ' }] }],
    { projectDir: dir }
  );
  assert.equal(plan.errors.length, 0, 'the plan itself stages fine; syntax is a separate gate');

  const verdict = await R.validateSyntax(plan, { tmpDir: dir });
  assert.equal(verdict.ok, false, 'broken proposed content must be caught');
  assert.match(verdict.errors[0], /src\/app\.js/);

  // And crucially: nothing was written, because the guard runs BEFORE applyPlan.
  assert.equal(fs.readFileSync(path.join(dir, 'src/app.js'), 'utf8'), GOOD,
    'the file on disk must be untouched by planning + validation');
  fs.rmSync(dir, { recursive: true, force: true });
});
