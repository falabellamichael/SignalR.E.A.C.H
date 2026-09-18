'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../agent/test-loop.cjs');

const tmpProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'testloop-'));
const gate = (id, runner = 'generic') => ({ id, command: id, runner });

test('node --test TAP output parses failures and counts', () => {
  const out = 'TAP version 13\nok 1 - adds numbers\nnot ok 2 - subtracts\n  error: Expected values to be strictly equal\n# tests 2\n# pass 1\n# fail 1\n';
  const p = T.parseNodeTestOutput(out, '');
  assert.equal(p.failures.length, 1);
  assert.equal(p.failures[0].name, 'subtracts');
  assert.equal(p.counts.fail, 1);
  assert.equal(p.counts.pass, 1);
});

test('pytest output parses failures, file refs and counts', () => {
  const out = '=== FAILURES ===\nE   assert 1 == 2\nFAILED tests/test_a.py::test_thing - assert 1 == 2\n=== 1 failed, 2 passed in 0.05s ===\n';
  const p = T.parsePytestOutput(out, '');
  assert.equal(p.failures.length, 1);
  assert.equal(p.failures[0].name, 'test_thing');
  assert.equal(p.failures[0].file.path, 'tests/test_a.py');
  assert.equal(p.counts.fail, 1);
  assert.equal(p.counts.pass, 2);
});

test('generic parser never reports success on its own', () => {
  assert.ok(T.parseGenericOutput('BUILD FAILED\nerror: cannot find symbol\n', '').failures.length >= 1);
  assert.equal(T.parseGenericOutput('all good\n', '').failures.length, 0);
});

test('ok comes from the exit code, not from parsing', () => {
  assert.equal(T.interpret({ ok: false, exitCode: 2, stdout: 'everything looks fine' }, 'generic').ok, false,
    'a failing exit code beats clean-looking stdout');
  assert.equal(T.interpret({ ok: true, exitCode: 0, stdout: 'not ok 1 - weird' }, 'node').ok, true);
  const crashed = T.interpret({ ok: false, exitCode: null, error: 'spawn failed' }, 'generic');
  assert.equal(crashed.ok, false);
  assert.equal(crashed.error, 'spawn failed');
});

test('already-passing gates finish with zero attempts', async () => {
  const events = [];
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('test', 'node')],
    runGate: async () => ({ ok: true, exitCode: 0, stdout: '# pass 1\n# fail 0\n' }),
    projectDir: tmpProject(),
    onEvent: e => events.push(e.type),
  });
  assert.equal(r.passed, true);
  assert.equal(r.attempts, 0);
  assert.ok(events.includes('passed'));
});

test('a fix on the second attempt passes and is left applied', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'f.js'), 'module.exports = 1;\n');
  let calls = 0;
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('test', 'node')],
    runGate: async () => (++calls <= 2
      ? { ok: false, exitCode: 1, stdout: 'not ok 1 - broken\n# fail 1\n' }
      : { ok: true, exitCode: 0, stdout: '# pass 1\n# fail 0\n' }),
    proposeFix: async ({ attempt }) => [{ path: 'f.js', content: `module.exports = ${attempt + 1};\n` }],
    projectDir: dir,
  });
  assert.equal(r.passed, true, r.report);
  assert.equal(r.attempts, 2);
  assert.ok(fs.readFileSync(path.join(dir, 'f.js'), 'utf8').includes('= 3'), 'the successful fix stays');
  assert.match(r.report, /succeeded after 2 attempt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exhausted attempts roll the tree back to its original state', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'g.js'), 'ORIGINAL\n');
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('lint')],
    runGate: async () => ({ ok: false, exitCode: 1, stdout: 'lint error ' + Math.random() }),
    proposeFix: async () => [{ path: 'g.js', content: 'CHANGED\n' }],
    projectDir: dir,
    maxAttempts: 3,
  });
  assert.equal(r.passed, false);
  assert.equal(fs.readFileSync(path.join(dir, 'g.js'), 'utf8'), 'ORIGINAL\n', 'rolled back');
  assert.ok(r.restoredFiles.length > 0);
  assert.equal(r.rollbackErrors.length, 0, 'rollback itself succeeded');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unchanged failure set stops the loop before the attempt cap', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'g.js'), 'x\n');
  let runs = 0;
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('test')],
    runGate: async () => { runs++; return { ok: false, exitCode: 1, stdout: 'FAILED: identical' }; },
    proposeFix: async () => [{ path: 'g.js', content: 'changed' + runs + '\n' }],
    projectDir: dir,
    maxAttempts: 10,
  });
  assert.ok(runs < 10, 'stopped early after ' + runs + ' gate runs');
  assert.ok(r.iterations.some(i => i.phase === 'no-progress'));
  assert.match(r.report, /no progress/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fix that changes nothing is labelled no-change, not apply-error', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'nc.js'), 'SAME\n');
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('test')],
    runGate: async () => ({ ok: false, exitCode: 1, stdout: 'FAILED nc' }),
    proposeFix: async () => [{ path: 'nc.js', content: 'SAME\n' }],
    projectDir: dir,
    maxAttempts: 4,
  });
  assert.ok(r.iterations.some(i => i.phase === 'no-change'), r.iterations.map(i => i.phase).join(','));
  assert.ok(!r.iterations.some(i => i.phase === 'apply-error'), 'not mislabelled as an I/O error');
  assert.match(r.report, /would not have changed any file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fixer that proposes nothing stops the loop', async () => {
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('test')],
    runGate: async () => ({ ok: false, exitCode: 1, stdout: 'FAILED x' }),
    proposeFix: async () => [],
    projectDir: tmpProject(),
    maxAttempts: 5,
  });
  assert.equal(r.passed, false);
  assert.ok(r.iterations.some(i => i.phase === 'no-fix'));
  assert.match(r.report, /proposed no further changes/);
});

test('created files are removed when the loop fails', async () => {
  const dir = tmpProject();
  await T.runSelfCorrectionLoop({
    gates: [gate('test')],
    runGate: async () => ({ ok: false, exitCode: 1, stdout: 'FAILED' }),
    proposeFix: async () => [{ path: 'brandnew.js', create: true, content: 'new\n' }],
    projectDir: dir,
    maxAttempts: 2,
  });
  assert.equal(fs.existsSync(path.join(dir, 'brandnew.js')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an invalid plan cannot write outside the project', async () => {
  const dir = tmpProject();
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('test')],
    runGate: async () => ({ ok: false, exitCode: 1, stdout: 'FAILED' }),
    proposeFix: async () => [{ path: '../escape.js', content: 'evil\n' }],
    projectDir: dir,
    maxAttempts: 3,
  });
  assert.equal(r.passed, false);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'escape.js')), false);
  assert.ok(r.iterations.some(i => i.phase === 'plan-error'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keepOnFailure preserves the last attempted fix', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'keep.js'), 'BEFORE\n');
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('test')],
    runGate: async () => ({ ok: false, exitCode: 1, stdout: 'FAILED ' + Math.random() }),
    proposeFix: async () => [{ path: 'keep.js', content: 'AFTER\n' }],
    projectDir: dir,
    maxAttempts: 2,
    keepOnFailure: true,
  });
  assert.equal(fs.readFileSync(path.join(dir, 'keep.js'), 'utf8'), 'AFTER\n');
  assert.match(r.report, /left in place/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an abort signal cancels the loop', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'g.js'), 'x\n');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('test')],
    runGate: async () => { await new Promise(res => setTimeout(res, 40)); return { ok: false, exitCode: 1, stdout: 'FAILED' }; },
    proposeFix: async () => [{ path: 'g.js', content: 'y\n' }],
    projectDir: dir,
    maxAttempts: 5,
    signal: ac.signal,
  });
  assert.equal(r.cancelled, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing configuration is reported, not thrown', async () => {
  const noGates = await T.runSelfCorrectionLoop({ gates: [] });
  assert.equal(noGates.passed, false);
  assert.match(noGates.error, /No quality gates/);
  const noRunner = await T.runSelfCorrectionLoop({ gates: [gate('x')] });
  assert.equal(noRunner.passed, false);
  assert.match(noRunner.error, /runGate is required/);
});

test('a failing gate that later passes reports the gate that was failing', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'f.js'), 'a\n');
  let n = 0;
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('first'), gate('second')],
    runGate: async (g) => {
      n++;
      // first gate fails on run 1, passes after; second gate fails on run 2
      if (g.id === 'first') return n <= 1 ? { ok: false, exitCode: 1, stdout: 'FAILED first' } : { ok: true, exitCode: 0 };
      return n <= 2 ? { ok: false, exitCode: 1, stdout: 'FAILED second' } : { ok: true, exitCode: 0 };
    },
    proposeFix: async () => [{ path: 'f.js', content: 'b' + n + '\n' }],
    projectDir: dir,
    maxAttempts: 4,
  });
  assert.equal(r.passed, true, r.report);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------- quick-fix (PRD AC) */

// ESLint stylish output needs a file header line, otherwise the problems cannot
// be attributed to a file and the parser (correctly) reports none.
const LINT_OUT = 'C:\\proj\\q.js\n  1:12  error  Missing semicolon  semi\n\n\u2716 1 problem (1 error, 0 warnings)\n  1 error and 0 warnings potentially fixable with the `--fix` option.\n';

test('quickFix runs BEFORE the model and its edits are applied', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'q.js'), 'const a = 1\n');   // missing semicolon
  const order = [];
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('lint', 'eslint')],
    runGate: async () => (order.includes('quickfix')
      ? { ok: true, exitCode: 0, stdout: '' }
      : { ok: false, exitCode: 1, stdout: LINT_OUT }),
    quickFix: async ({ gate, interpreted }) => {
      order.push('quickfix');
      assert.equal(gate.runner, 'eslint', 'the quick-fixer is told which gate failed');
      // The parsed diagnostics are what a real `eslint --fix` wrapper needs in
      // order to decide whether anything is mechanically fixable at all.
      assert.ok(interpreted.failures.length >= 1, 'given the parsed diagnostics, got ' + interpreted.failures.length);
      assert.equal(interpreted.failures[0].code, 'semi');
      assert.equal(interpreted.counts.fixable, 1, 'fixable count is available');
      return { edits: [{ path: 'q.js', content: 'const a = 1;\n' }], summary: 'eslint --fix: semi' };
    },
    proposeFix: async () => { order.push('model'); return null; },
    projectDir: dir,
  });
  assert.equal(r.passed, true, r.report);
  assert.deepEqual(order, ['quickfix'], 'the model was never asked: ' + order.join(','));
  assert.equal(fs.readFileSync(path.join(dir, 'q.js'), 'utf8'), 'const a = 1;\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a quickFix that returns nothing falls through to the model fixer', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'q.js'), 'before\n');
  const order = [];
  // keepOnFailure so the applied model fix is inspectable afterwards: without
  // it the loop rolls the tree back on failure, which is correct but would make
  // this test assert on a restored file.
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('lint', 'eslint')],
    runGate: async () => ({ ok: false, exitCode: 1, stdout: LINT_OUT }),
    quickFix: async () => { order.push('quickfix'); return { edits: [] }; },
    proposeFix: async () => { order.push('model'); return [{ path: 'q.js', content: 'after\n' }]; },
    projectDir: dir,
    maxAttempts: 2,
    keepOnFailure: true,
  });
  assert.deepEqual(order.slice(0, 2), ['quickfix', 'model'], 'empty quick-fix defers to the model');
  assert.equal(r.passed, false);
  assert.equal(fs.readFileSync(path.join(dir, 'q.js'), 'utf8'), 'after\n', 'the model fix was applied');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a throwing quickFix is recorded and does not abort the loop', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'q.js'), 'before\n');
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('lint', 'eslint')],
    runGate: async () => ({ ok: false, exitCode: 1, stdout: LINT_OUT }),
    quickFix: async () => { throw new Error('eslint not installed'); },
    proposeFix: async () => [{ path: 'q.js', content: 'after\n' }],
    projectDir: dir,
    maxAttempts: 2,
    keepOnFailure: true,
  });
  // The mechanical fixer being unavailable must not cost the model its chance.
  assert.ok(r.iterations.some(i => i.phase === 'quick-fix-error'), r.iterations.map(i => i.phase).join(','));
  assert.ok(r.iterations.some(i => i.phase === 'applied'), 'the model fix was still attempted');
  assert.equal(fs.readFileSync(path.join(dir, 'q.js'), 'utf8'), 'after\n', 'the model fix still ran');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quickFix edits are rolled back with the rest when the loop fails', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'q.js'), 'ORIGINAL\n');
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('lint', 'eslint')],
    runGate: async () => ({ ok: false, exitCode: 1, stdout: 'still bad ' + Math.random() }),
    quickFix: async () => ({ edits: [{ path: 'q.js', content: 'QUICKFIXED\n' }] }),
    projectDir: dir,
    maxAttempts: 2,
  });
  assert.equal(r.passed, false);
  // Quick-fix writes go through the same plan/apply path, so rollback covers
  // them — a quick-fixer that wrote files directly would leave this dirty.
  assert.equal(fs.readFileSync(path.join(dir, 'q.js'), 'utf8'), 'ORIGINAL\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a quickFix that WRITES to disk stalls the loop (the contract it must not break)', async () => {
  /* Regression for the production eslint path.
   *
   * main.mjs's quickFix ran `eslint --fix`, which rewrites the file, and then
   * returned the already-fixed content as `edits`. The loop builds its plan by
   * reading the CURRENT file as `before` — so before === after, the plan had
   * nothing to apply, and the loop reported a no-change stall and broke WITHOUT
   * re-running the gate that would now have passed. The fix was on disk but the
   * run was reported failed, and that write sat outside the loop's rollback set.
   *
   * Every other quickFix test returns edits without writing, which is why none
   * of them caught this. This one mirrors the broken shape and asserts the
   * symptom, documenting exactly why write-in-place cannot work.
   *
   * NOTE: this uses an inline quickFix, so it would still pass if main.mjs were
   * reverted. The guard against that revert is the source-level assertion in the
   * next test.
   */
  const dir = tmpProject();
  const GOOD = 'const x = {a:1}\n';
  const FIXED = 'const x = { a: 1 };\n';
  fs.writeFileSync(path.join(dir, 'q.js'), GOOD, 'utf8');

  let qfCalls = 0;
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('lint', 'eslint')],
    // Content-driven, not counter-driven: passes once the fix is really on disk.
    runGate: async () => (fs.readFileSync(path.join(dir, 'q.js'), 'utf8') === FIXED
      ? { ok: true, exitCode: 0, stdout: 'ok\n', stderr: '', durationMs: 1 }
      : { ok: false, exitCode: 1, stdout: 'FAIL\n', stderr: 'FAIL\n', durationMs: 1 }),
    // The BROKEN shape: writes in place, then returns the new content.
    quickFix: async () => {
      qfCalls++;
      const abs = path.join(dir, 'q.js');
      fs.writeFileSync(abs, FIXED, 'utf8');
      return { edits: [{ path: 'q.js', content: fs.readFileSync(abs, 'utf8') }] };
    },
    proposeFix: async () => null,
    projectDir: dir,
    maxAttempts: 4,
    keepOnFailure: true,
  });

  assert.equal(qfCalls, 1);
  assert.equal(r.passed, false, 'a write-in-place quickFix cannot make the loop pass');
  assert.ok(r.iterations.some(i => i.phase === 'no-change'),
    'it stalls as no-change: ' + JSON.stringify(r.iterations.map(i => i.phase)));
  // The file IS fixed on disk — which is precisely why the failure is silent.
  assert.equal(fs.readFileSync(path.join(dir, 'q.js'), 'utf8'), FIXED);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('main.mjs quickFix restores the tree after running eslint --fix', () => {
  /* Source-level guard for the fix above. main.mjs cannot be require()d in a node
   * test — importing it fails with "The requested module 'electron' does not
   * provide an export named 'BrowserWindow'" — so the behavioural tests use an
   * inline quickFix and cannot detect a regression in the real one. Assert on
   * the source instead: if someone removes the restore, this fails.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.mjs'), 'utf8');
  const start = src.indexOf('const quickFix = async (');
  assert.ok(start > 0, 'the production quickFix must exist in main.mjs');
  // Slice to the next statement after the function. Searching for the first `};`
  // does not work: the function's own first line ends in `|| {};`.
  const endMarker = src.indexOf('const result = await testLoop.runSelfCorrectionLoop', start);
  assert.ok(endMarker > start, 'quickFix must still be defined immediately before the loop call');
  const body = src.slice(start, endMarker);
  assert.match(body, /eslint --fix/, 'it must actually run the fixer');
  assert.match(body, /finally\s*\{/, 'the fixer write must be undone in a finally block');
  assert.match(body, /writeFileSync\(/, 'and the originals written back');
  assert.match(body, /return \{ edits,/, 'returning EDITS, not writing in place');
  // The blast radius must be the snapshotted set, never a bare `.`.
  assert.ok(!/eslint --fix\s*\$\{lintTargets\}/.test(body),
    'must pass the explicit file list, not a bare `.` that rewrites untracked files');
});

test('a quickFix that returns edits WITHOUT writing lets the loop pass', async () => {
  // The contract main.mjs now follows: snapshot, let the fixer run, harvest the
  // result as edits, restore the originals. The loop applies the edits itself,
  // so they are inside the rollback set and the gate is re-run afterwards.
  const dir = tmpProject();
  const GOOD = 'const x = {a:1}\n';
  const FIXED = 'const x = { a: 1 };\n';
  fs.writeFileSync(path.join(dir, 'q.js'), GOOD, 'utf8');

  const r = await T.runSelfCorrectionLoop({
    gates: [gate('lint', 'eslint')],
    runGate: async () => (fs.readFileSync(path.join(dir, 'q.js'), 'utf8') === FIXED
      ? { ok: true, exitCode: 0, stdout: 'ok\n', stderr: '', durationMs: 1 }
      : { ok: false, exitCode: 1, stdout: 'FAIL\n', stderr: 'FAIL\n', durationMs: 1 }),
    quickFix: async () => ({ edits: [{ path: 'q.js', content: FIXED }], summary: 'eslint --fix' }),
    proposeFix: async () => null,
    projectDir: dir,
    maxAttempts: 4,
    keepOnFailure: true,
  });

  assert.equal(r.passed, true, 'returning edits lets the loop converge: ' + JSON.stringify(r.iterations.map(i => i.phase)));
  assert.ok(r.iterations.some(i => i.phase === 'applied'), 'the loop applied the edits itself');
  assert.ok(!r.iterations.some(i => i.phase === 'no-change'), 'no spurious stall');
  assert.equal(fs.readFileSync(path.join(dir, 'q.js'), 'utf8'), FIXED);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the default attempt cap is the PRD-specified 10', async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'q.js'), 'x\n');
  let runs = 0;
  // noProgressLimit stops this well before 10; assert the CAP via maxAttempts
  // being absent and the reported maxAttempts value on each attempt event.
  let reportedMax = null;
  const r = await T.runSelfCorrectionLoop({
    gates: [gate('lint', 'eslint')],
    runGate: async () => { runs++; return { ok: false, exitCode: 1, stdout: 'bad ' + runs }; },
    proposeFix: async () => [{ path: 'q.js', content: 'v' + runs + '\n' }],
    projectDir: dir,
    noProgressLimit: 10,
    onEvent: e => { if (e.type === 'attempt-start') reportedMax = e.maxAttempts; },
  });
  assert.equal(reportedMax, 10, 'attempts are capped at 10 by default, not 4');
  assert.equal(r.passed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

