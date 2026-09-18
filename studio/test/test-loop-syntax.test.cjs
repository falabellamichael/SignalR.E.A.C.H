'use strict';

/* The syntax guard inside the self-correction loop.
 *
 * PRD, Multi-File Refactoring Engine: "If dependency cycles or syntax errors are
 * detected, the agent halts refactoring and displays an error trace highlighting
 * affected modules." The loop is the one code path where a model's edits reach
 * disk with NO human reviewing a diff, so this is where the guard matters most.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runSelfCorrectionLoop } = require('../agent/test-loop.cjs');

const GOOD = 'module.exports = { add: (a, b) => a + b };\n';
const BROKEN = 'module.exports = { add: (a, b) => a + b ;\n';   // unbalanced

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-syntax-'));
  fs.writeFileSync(path.join(dir, 'app.js'), GOOD);
  fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
  // A gate that always fails, so the loop always asks the fixer for edits.
  fs.writeFileSync(path.join(dir, 'gate.cjs'), 'process.exit(1);\n');
  return dir;
}

// A runner that fails with one structured diagnostic, so readScope has a file.
// The runResult contract is {ok, exitCode, stdout, stderr, durationMs} and `ok`
// is read STRICTLY (interpret() does `res.ok === true`), so it must be set
// explicitly in both directions — omitting it silently reads as failure.
function failingGate() {
  return async () => ({
    ok: false,
    exitCode: 1,
    stdout: 'FAIL app.js\n  ✖ add is wrong\n',
    stderr: 'FAIL app.js\n  ✖ add is wrong\n',
    durationMs: 1,
  });
}

const GATES = [{ id: 'tests', command: 'node', args: ['gate.cjs'], runner: 'node' }];

test('an unparseable proposed edit is rejected and never written to disk', async () => {
  const dir = project();
  const res = await runSelfCorrectionLoop({
    gates: GATES,
    runGate: failingGate(),
    proposeFix: async () => [{ path: 'app.js', content: BROKEN }],
    projectDir: dir,
    maxAttempts: 1,
    noProgressLimit: 5,
    keepOnFailure: true,
  });
  assert.equal(res.passed, false, 'a rejected edit must not count as passing');
  // The whole point: the file on disk is still the original good code.
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), GOOD,
    'broken code must never reach disk');

  const phases = res.iterations.map(i => i.phase);
  assert.ok(phases.includes('syntax-error'), 'the rejection is recorded: ' + phases.join(','));
  const entry = res.iterations.find(i => i.phase === 'syntax-error');
  assert.ok(entry.errors.length >= 1, 'the error trace names the problem');
  assert.match(entry.errors[0], /app\.js/, 'the trace highlights the affected module');
  assert.match(entry.detail, /not written to disk/i, 'the user is told nothing was written');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the parse error is fed back to the fixer on the next attempt', async () => {
  const dir = project();
  const seen = [];
  let n = 0;
  const res = await runSelfCorrectionLoop({
    gates: GATES,
    runGate: failingGate(),
    // First proposal is broken, second is valid — the loop should recover.
    proposeFix: async (ctx) => {
      seen.push(ctx.syntaxErrors);
      n++;
      return [{ path: 'app.js', content: n === 1 ? BROKEN : GOOD.replace('a + b', 'a + b + 0') }];
    },
    projectDir: dir,
    maxAttempts: 4,
    noProgressLimit: 5,
    keepOnFailure: true,
  });
  assert.equal(seen[0], null, 'no syntax feedback on the first attempt');
  assert.ok(Array.isArray(seen[1]) && seen[1].length, 'the second attempt receives the parse error');
  assert.match(seen[1][0], /app\.js/);
  assert.ok(n >= 2, 'the loop continued after the rejection instead of breaking');
  // The corrected edit parsed, so it was allowed to apply.
  assert.notEqual(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), BROKEN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a loop that can only produce unparseable edits ends via noProgressLimit', async () => {
  const dir = project();
  let calls = 0;
  const res = await runSelfCorrectionLoop({
    gates: GATES,
    runGate: failingGate(),
    proposeFix: async () => { calls++; return [{ path: 'app.js', content: BROKEN }]; },
    projectDir: dir,
    maxAttempts: 10,
    noProgressLimit: 2,
    keepOnFailure: true,
  });
  assert.equal(res.passed, false);
  assert.equal(calls, 2, 'stops at noProgressLimit rather than burning all 10 attempts, got ' + calls);
  assert.ok(res.iterations.some(i => i.phase === 'no-progress'), 'reported as no-progress');
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), GOOD, 'file untouched throughout');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('valid edits still apply normally (the guard is not over-eager)', async () => {
  const dir = project();
  const FIXED = GOOD.replace('a + b', 'a + b + 0');
  // Drive the gate off the ACTUAL file content rather than a call counter. A
  // counter is fragile: the loop may call the gate a different number of times
  // than the test assumes, and then the fake disagrees with the tree. Reading the
  // file means "passes once the fix lands", which is what a real gate does.
  const contentGate = async () => {
    const cur = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
    return cur === FIXED
      ? { ok: true, exitCode: 0, stdout: 'ok\n', stderr: '', durationMs: 1 }
      : { ok: false, exitCode: 1, stdout: 'FAIL app.js\n', stderr: 'FAIL app.js\n', durationMs: 1 };
  };
  const res = await runSelfCorrectionLoop({
    gates: GATES,
    runGate: contentGate,
    proposeFix: async () => [{ path: 'app.js', content: FIXED }],
    projectDir: dir,
    maxAttempts: 3,
    keepOnFailure: true,
  });
  assert.equal(res.passed, true, 'a valid fix must still succeed: ' + JSON.stringify(res.iterations.map(i => i.phase)));
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), FIXED);
  assert.ok(!res.iterations.some(i => i.phase === 'syntax-error'), 'no spurious syntax rejection');
  assert.ok(res.iterations.some(i => i.phase === 'applied'), 'the edit was applied');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a non-JavaScript project is not blocked by the guard', async () => {
  // A Python/TS project has no parseable-by-node content; the loop must still run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-syntax-py-'));
  fs.writeFileSync(path.join(dir, 'app.py'), 'def add(a, b):\n    return a + b\n');
  const res = await runSelfCorrectionLoop({
    gates: GATES,
    runGate: failingGate(),
    proposeFix: async () => [{ path: 'app.py', content: 'def add(a, b):\n    return a + b + 0\n' }],
    projectDir: dir,
    maxAttempts: 2,
    keepOnFailure: true,
  });
  assert.ok(!res.iterations.some(i => i.phase === 'syntax-error'), 'python files are skipped, not rejected');
  assert.equal(fs.readFileSync(path.join(dir, 'app.py'), 'utf8'), 'def add(a, b):\n    return a + b + 0\n',
    'the python edit was applied');
  fs.rmSync(dir, { recursive: true, force: true });
});
