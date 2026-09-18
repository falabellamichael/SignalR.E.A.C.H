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
