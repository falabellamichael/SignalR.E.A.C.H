'use strict';

/* Reach Studio — autonomous test & lint self-correction loop.
 *
 * Runs the project's test/lint/type commands, parses failures, asks a fixer
 * (the agent's model) for patches, applies them through the refactor engine so
 * every iteration is atomic and rollbackable, and re-runs — until the gates
 * pass or the retry budget is exhausted. On exhaustion it produces a failure
 * report rather than leaving the project in a half-fixed state.
 *
 * Everything side-effecting is injected:
 *   runTests(command) -> {ok, exitCode, stdout, stderr, durationMs}
 *   proposeFix({failures, attempt, files}) -> edits[] (refactor edit shape)
 * so the loop is deterministic in tests and the real wiring lives in main.mjs.
 *
 * Convergence guards (the PRD calls out "prevent infinite execution loops"):
 *   - maxAttempts caps iterations.
 *   - a proposed fix that changes nothing is treated as convergence failure
 *     and stops immediately instead of burning attempts on identical output.
 *   - an iteration whose failure set is identical to the previous one is
 *     detected as no-progress and reported as such.
 *   - every applied iteration is reverted on final failure unless
 *     keepOnFailure is set, so "tests still fail" leaves the tree as found.
 */

const path = require('node:path');
const { planFromEdits, applyPlan, summarizePlan } = require('./refactor.cjs');

const DEFAULT_MAX_ATTEMPTS = 4;
/**
 * How many consecutive attempts may produce an IDENTICAL failure set before the
 * loop gives up. One repeat is not proof of stalling: a multi-file fix often
 * leaves output unchanged until a later file is also corrected (fix A, then fix
 * B, and only then does the failure move). Two identical results in a row is a
 * genuine stall.
 */
const DEFAULT_NO_PROGRESS_LIMIT = 2;
const MAX_OUTPUT_CHARS = 24000;

/* -------------------------------------------------------------- test runners */

/**
 * Known runner fingerprints. A project picks one by name in settings; the loop
 * uses it to parse output. Unknown runners fall back to a generic parser that
 * still extracts failing lines, so a bespoke script is not silently treated as
 * passing.
 */
const RUNNERS = {
  node: {
    label: 'Node test runner',
    parse: parseNodeTestOutput,
  },
  pytest: {
    label: 'pytest',
    parse: parsePytestOutput,
  },
  generic: {
    label: 'Generic (exit code + failing lines)',
    parse: parseGenericOutput,
  },
};

/** node --test / node:test TAP-ish output. */
function parseNodeTestOutput(stdout, stderr) {
  const text = String(stdout || '') + '\n' + String(stderr || '');
  const failures = [];
  const lines = text.split('\n');
  let current = null;
  for (const line of lines) {
    // `not ok 3 - test name` and the ✖ marker both appear across versions.
    const notOk = /^\s*not ok(?:\s+\d+)?\s*-?\s*(.*)$/.exec(line);
    const cross = /^\s*(?:✖|x|X)\s+(.+?)\s*\(([\d.]+)\s*m?s\)/.exec(line);
    if (notOk) {
      current = { name: notOk[1].trim() || 'unnamed test', file: null, message: '', stack: [] };
      failures.push(current);
      continue;
    }
    if (cross) {
      failures.push({ name: cross[1].trim(), file: null, message: '', stack: [] });
      current = failures[failures.length - 1];
      continue;
    }
    if (current) {
      const msg = /^\s*(?:error|failure)\s*:\s*(.*)$/i.exec(line);
      if (msg) current.message = msg[1].trim();
      const at = /^\s*at\s+(.+)$/.exec(line);
      if (at) current.stack.push(at[1].trim());
      const fileRef = /\(([^()]*?\.[cm]?js|[^()]*?\.mjs):(\d+):(\d+)\)/.exec(line);
      if (fileRef && !current.file) current.file = { path: fileRef[1], line: Number(fileRef[2]) };
      if (/^\s*(?:ok|#|\.\.\.)/.test(line)) current = null;
    }
  }
  const summary = /^#\s*(tests|pass|fail|cancelled|skipped)\s+(\d+)/gim;
  const counts = {};
  let m;
  while ((m = summary.exec(text)) !== null) counts[m[1].toLowerCase()] = Number(m[2]);
  // AssertionError detail blocks
  for (const block of text.split(/\n\s*\n/)) {
    const assert = /AssertionError(?:\s*\[([^\]]+)\])?:\s*([\s\S]*?)(?:\n\s*at |\n\s*$)/.exec(block);
    if (assert && failures.length) {
      const target = failures.find(f => !f.message) || failures[failures.length - 1];
      if (target && !target.message) target.message = (assert[2] || assert[1] || '').trim().slice(0, 400);
    }
  }
  return { failures, counts, parser: 'node' };
}

/** pytest short/long output. */
function parsePytestOutput(stdout, stderr) {
  const text = String(stdout || '') + '\n' + String(stderr || '');
  const failures = [];
  // `FAILED tests/test_x.py::test_name - AssertionError: ...`
  for (const m of text.matchAll(/^FAILED\s+([^\s:]+)::([^\s-]+)\s*-?\s*(.*)$/gm)) {
    failures.push({ name: m[2].trim(), file: { path: m[1].trim(), line: null }, message: (m[3] || '').trim(), stack: [] });
  }
  // `_______ test_name _______` sections with assertion text
  for (const m of text.matchAll(/^_{3,}\s*(\S+)\s*_{3,}\s*$/gm)) {
    const name = m[1].trim();
    if (!failures.some(f => f.name === name)) {
      failures.push({ name, file: null, message: '', stack: [] });
    }
  }
  // `E   AssertionError: ...` lines attach to the most recent failure
  const eLines = [...text.matchAll(/^\s*E\s+(.*)$/gm)].map(m => m[1].trim());
  if (eLines.length && failures.length) {
    const target = failures.find(f => !f.message) || failures[failures.length - 1];
    if (target) target.message = eLines[0].slice(0, 400);
  }
  const tail = /=+\s*(\d+)\s+failed[^=]*=+|=+\s*(\d+)\s+passed[^=]*=+/.exec(text);
  const counts = {};
  const failedMatch = /(\d+)\s+failed/.exec(text);
  const passedMatch = /(\d+)\s+passed/.exec(text);
  if (failedMatch) counts.fail = Number(failedMatch[1]);
  if (passedMatch) counts.pass = Number(passedMatch[1]);
  void tail;
  // file:line for tracebacks
  for (const f of failures) {
    if (f.file) continue;
    const ref = new RegExp(`(?:^|\\s)(${escapeRe(f.name)})\\b[^\\n]*?([\\w./\\\\-]+\\.py):(\\d+)`).exec(text);
    if (ref) f.file = { path: ref[2], line: Number(ref[3]) };
  }
  return { failures, counts, parser: 'pytest' };
}

/** Exit-code plus any line that looks like a failure. Never assumes success. */
function parseGenericOutput(stdout, stderr, result = {}) {
  const text = String(stdout || '') + '\n' + String(stderr || '');
  const failures = [];
  const patterns = [
    /^.*\b(?:FAIL|FAILED|ERROR|Error:|error:|AssertionError|panic:)\b.*$/gm,
    /^\s*(?:✖|×|not ok)\s+.*$/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = m[0].trim();
      if (!line || failures.some(f => f.message === line)) continue;
      failures.push({ name: line.slice(0, 120), file: null, message: line.slice(0, 400), stack: [] });
      if (failures.length >= 60) break;
    }
  }
  return {
    failures,
    counts: { fail: result.ok === false ? Math.max(1, failures.length) : 0 },
    parser: 'generic',
  };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Pick a parser by name, defaulting to generic. */
function parserFor(runner) {
  const key = String(runner || 'generic').toLowerCase();
  return RUNNERS[key] || RUNNERS.generic;
}

/**
 * Interpret one test run into a normalized result. `ok` comes from the exit
 * code, not from parsing: a runner that fails to produce parseable output must
 * never be reported as green.
 */
function interpret(result, runner) {
  const res = result || {};
  const stdout = String(res.stdout || '').slice(0, MAX_OUTPUT_CHARS);
  const stderr = String(res.stderr || '').slice(0, MAX_OUTPUT_CHARS);
  const spec = parserFor(runner);
  const parsed = spec.parse(stdout, stderr, res);
  const ok = res.ok === true;
  return {
    ok,
    exitCode: typeof res.exitCode === 'number' ? res.exitCode : (ok ? 0 : 1),
    runner: spec.label,
    parser: parsed.parser,
    failures: parsed.failures,
    counts: parsed.counts,
    durationMs: Number.isFinite(res.durationMs) ? res.durationMs : null,
    stdoutTail: stdout.slice(-4000),
    stderrTail: stderr.slice(-4000),
    cancelled: !!res.cancelled,
    error: res.error || null,
  };
}

/* ------------------------------------------------------------------ the loop */

/** Signature of a failure set, for no-progress detection. */
function failureSignature(interpreted) {
  return JSON.stringify((interpreted.failures || [])
    .map(f => [f.name, f.file && f.file.path, f.file && f.file.line, (f.message || '').slice(0, 120)])
    .sort());
}

/**
 * Run the self-correction loop.
 *
 * @param {object} options
 *   gates        array of {id, command, args, runner, cwd} — each must pass
 *   runGate      (gate) => Promise<runResult>  (injected; uses platform.runCommand in prod)
 *   proposeFix   ({attempt, gate, interpreted, previousEdits}) => Promise<edits[]|null>
 *   projectDir   project root for refactor plans
 *   maxAttempts  iteration cap (default 4)
 *   keepOnFailure  keep the last attempted fix even if gates still fail
 *   onEvent      (event) => void  progress reporting for the UI
 *   signal       AbortSignal
 * @returns {Promise<{passed, attempts, iterations[], report, restoredFiles}>}
 */
async function runSelfCorrectionLoop(options = {}) {
  const {
    gates = [],
    runGate,
    proposeFix,
    projectDir = null,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    keepOnFailure = false,
    onEvent = () => {},
    signal = null,
    planOptions = {},
  } = options;

  const emit = (type, payload = {}) => { try { onEvent({ type, at: Date.now(), ...payload }); } catch { /* UI must not break the loop */ } };

  // Validate configuration before doing any work. Gates are checked first: a
  // caller that supplies neither is misconfigured, and "no gates" is the more
  // specific diagnosis than "no runner".
  if (!Array.isArray(gates) || !gates.length) {
    return { passed: false, attempts: 0, iterations: [], restoredFiles: [], report: 'No quality gates configured.', error: 'No quality gates configured.' };
  }
  if (typeof runGate !== 'function') {
    return { passed: false, attempts: 0, iterations: [], restoredFiles: [], report: 'runGate is required.', error: 'runGate is required.' };
  }
  const attempts = Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? Math.min(maxAttempts, 50) : DEFAULT_MAX_ATTEMPTS;
  const noProgressLimit = Number.isSafeInteger(options.noProgressLimit) && options.noProgressLimit > 0
    ? Math.min(options.noProgressLimit, 10) : DEFAULT_NO_PROGRESS_LIMIT;
  // The rollback and fix plans MUST be built with the same projectDir the loop
  // was given. An earlier version passed the caller's bare `planOptions` here,
  // so planFromEdits resolved relative to the process cwd, failed to find the
  // files, and the rollback quietly restored nothing — the tree was left
  // half-fixed while the result still claimed to have rolled back.
  const planCtx = { ...planOptions, projectDir };

  /** Run every gate in order; stop at the first failure (fast feedback). */
  const runAllGates = async (label) => {
    for (const gate of gates) {
      if (signal?.aborted) return { aborted: true };
      emit('gate-start', { gate: gate.id || gate.command, label });
      const started = Date.now();
      let raw;
      try {
        raw = await runGate(gate);
      } catch (error) {
        raw = { ok: false, exitCode: null, stdout: '', stderr: String(error && error.message || error) };
      }
      const interpreted = interpret({ ...raw, durationMs: raw && raw.durationMs !== undefined ? raw.durationMs : Date.now() - started }, gate.runner);
      emit('gate-result', { gate: gate.id || gate.command, ok: interpreted.ok, failures: interpreted.failures.length, durationMs: interpreted.durationMs });
      if (!interpreted.ok) return { ok: false, gate, interpreted };
    }
    return { ok: true };
  };

  const iterations = [];
  const appliedPlans = [];   // {plan, applied[]} for rollback on final failure
  let lastSignature = null;
  let stalled = 0;           // consecutive attempts with an unchanged failure set
  let attemptsUsed = 0;
  let passed = false;

  // Iteration 0 is the baseline: report the state we were handed.
  const baseline = await runAllGates('baseline');
  if (baseline.aborted) return { passed: false, attempts: 0, iterations, report: 'Cancelled.', cancelled: true, restoredFiles: [] };
  if (baseline.ok) {
    emit('passed', { attempts: 0 });
    return { passed: true, attempts: 0, iterations, report: 'All quality gates already pass.', restoredFiles: [] };
  }
  lastSignature = failureSignature(baseline.interpreted);
  // The gate that is failing NOW, not the one that failed at baseline: a later
  // attempt can fail a different gate once the first one is fixed.
  let failingGate = baseline.gate;
  iterations.push({ attempt: 0, phase: 'baseline', gate: failingGate.id || failingGate.command, interpreted: baseline.interpreted, edits: null });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      emit('cancelled', { attempt });
      const restoredFiles = await rollbackAll(appliedPlans, planCtx, keepOnFailure);
      return { passed: false, attempts: attemptsUsed, iterations, report: 'Cancelled.', cancelled: true, restoredFiles };
    }
    attemptsUsed = attempt;
    emit('attempt-start', { attempt, maxAttempts: attempts });

    // Ask the fixer for edits.
    let edits = null;
    if (typeof proposeFix === 'function') {
      try {
        edits = await proposeFix({
          attempt,
          maxAttempts: attempts,
          gate: failingGate,
          interpreted: baseline.interpreted,
          lastFailure: [...iterations].reverse().find(i => i.interpreted)?.interpreted || baseline.interpreted,
          previousEdits: iterations.map(i => i.edits).filter(Boolean),
        });
      } catch (error) {
        iterations.push({ attempt, phase: 'propose-error', error: String(error && error.message || error) });
        emit('attempt-error', { attempt, error: String(error && error.message || error) });
        break;
      }
    }
    if (!Array.isArray(edits) || !edits.length) {
      iterations.push({ attempt, phase: 'no-fix', error: 'The model proposed no changes.' });
      emit('no-fix', { attempt });
      break;   // nothing to try: stop rather than re-run identical code
    }

    // Plan + apply atomically through the refactor engine.
    const plan = planFromEdits(edits, planCtx);
    if (plan.errors.length) {
      iterations.push({ attempt, phase: 'plan-error', edits, errors: plan.errors, summary: summarizePlan(plan) });
      emit('plan-error', { attempt, errors: plan.errors });
      break;   // an invalid plan is a fixer bug; retrying blindly wastes attempts
    }
    if (!plan.files.length) {
      // The edits were valid but changed nothing (identical content, or every
      // target was a no-op). applyPlan would return "Nothing to apply", which
      // reads like an I/O failure and hides the real cause, so label it here.
      // Treat it as a stall: re-running the gates would produce identical
      // output and burn the attempt budget.
      iterations.push({
        attempt, phase: 'no-change', edits,
        detail: 'The proposed fix would not change any file.',
        warnings: plan.warnings, summary: summarizePlan(plan),
      });
      emit('no-change', { attempt, warnings: plan.warnings });
      stalled++;
      if (stalled >= noProgressLimit) {
        iterations.push({ attempt, phase: 'no-progress', detail: 'Repeated fixes changed nothing.' });
        emit('no-progress', { attempt, stalled });
      }
      break;
    }
    const apply = applyPlan(plan, { ...planCtx, signal });
    if (!apply.ok) {
      iterations.push({ attempt, phase: 'apply-error', edits, error: apply.error, summary: summarizePlan(plan) });
      emit('apply-error', { attempt, error: apply.error });
      break;
    }
    appliedPlans.push({ plan, applied: apply.applied });
    iterations.push({ attempt, phase: 'applied', edits, summary: summarizePlan(plan), applied: apply.applied });
    emit('applied', { attempt, files: apply.applied });

    // Re-run the gates.
    const after = await runAllGates('attempt ' + attempt);
    if (after.aborted) {
      emit('cancelled', { attempt });
      const restoredFiles = await rollbackAll(appliedPlans, planCtx, keepOnFailure);
      return { passed: false, attempts: attemptsUsed, iterations, report: 'Cancelled.', cancelled: true, restoredFiles };
    }
    if (after.ok) {
      passed = true;
      iterations.push({ attempt, phase: 'passed', interpreted: null });
      emit('passed', { attempt });
      break;
    }
    failingGate = after.gate;
    iterations.push({ attempt, phase: 'still-failing', gate: after.gate.id || after.gate.command, interpreted: after.interpreted });

    // No-progress detection: an identical failure set means the fix changed
    // nothing observable. Allow a couple of repeats (a multi-file repair often
    // only moves the needle once a later file is also fixed), then stop instead
    // of burning the whole attempt budget on identical output.
    const sig = failureSignature(after.interpreted);
    if (sig === lastSignature) {
      stalled++;
      if (stalled >= noProgressLimit) {
        emit('no-progress', { attempt, stalled });
        iterations.push({ attempt, phase: 'no-progress', detail: `The failure set was unchanged for ${stalled} consecutive attempt(s).` });
        break;
      }
    } else {
      stalled = 0;
    }
    lastSignature = sig;
  }

  // Final failure: roll back the attempted fixes unless the caller wants them
  // kept for inspection. Rolling back is the default because the PRD's contract
  // is "passes all repository checks before commit" — a tree left half-fixed
  // and failing is worse than the tree we started with.
  let restoredFiles = [];
  const rollbackErrors = [];
  if (!passed && !keepOnFailure) {
    const rb = await rollbackAll(appliedPlans, planCtx, false);
    restoredFiles = rb.restored;
    rollbackErrors.push(...rb.errors);
  }

  const report = buildReport({ passed, iterations, gates, restoredFiles, keepOnFailure, rollbackErrors });
  emit('finished', { passed, attempts: attemptsUsed });
  return {
    passed,
    attempts: attemptsUsed,
    iterations,
    report,
    restoredFiles,
    rollbackErrors,
    ...(passed ? {} : { failed: true }),
  };
}

/**
 * Undo applied plans newest-first by re-planning their inverse. The refactor
 * engine has no in-place undo across separate applies, so the rollback is
 * itself a plan: {path, content: before} for every file that was written.
 *
 * Errors are RETURNED, never swallowed. A rollback that silently did nothing
 * is worse than no rollback: the caller believes the tree is clean when it is
 * actually half-fixed.
 */
async function rollbackAll(appliedPlans, planCtx, skip) {
  const restored = [];
  const errors = [];
  if (skip || !appliedPlans.length) return { restored, errors };
  for (const entry of appliedPlans.slice().reverse()) {
    const edits = entry.plan.files.map(f => ({ path: f.path, content: f.before === null ? null : f.before }))
      .filter(e => e.content !== null);
    const deletions = entry.plan.files.filter(f => f.before === null).map(f => f.path);
    if (edits.length) {
      const plan = planFromEdits(edits, planCtx);
      if (plan.errors.length) {
        errors.push(...plan.errors.map(e => `rollback plan: ${e}`));
      } else {
        const res = applyPlan(plan, planCtx);
        if (res.ok) restored.push(...res.applied);
        else errors.push(`rollback apply: ${res.error}`);
      }
    }
    // Files the plan CREATED have no `before`; remove them so the tree matches
    // its pre-loop state.
    for (const rel of deletions) {
      try {
        const abs = planCtx.projectDir ? path.resolve(String(planCtx.projectDir), rel) : rel;
        const fs = require('node:fs');
        if (fs.existsSync(abs)) { fs.unlinkSync(abs); restored.push(rel); }
      } catch (error) { errors.push(`rollback delete ${rel}: ${error.message}`); }
    }
  }
  return { restored, errors };
}

/** Human-readable failure report, per the PRD's "detailed failure report". */
function buildReport({ passed, iterations, gates, restoredFiles, keepOnFailure, rollbackErrors = [] }) {
  const attemptsUsed = iterations.filter(i => i.attempt > 0 && i.phase !== 'baseline').length;
  if (passed) {
    const reached = [...iterations].reverse().find(i => i.phase === 'passed');
    const n = reached ? reached.attempt : attemptsUsed;
    return `Self-correction succeeded after ${n} attempt(s). Gates: ${gates.map(g => g.id || g.command).join(', ')}.`;
  }
  const lines = ['Self-correction did not reach a passing state.'];
  lines.push(`Gates: ${gates.map(g => `${g.id || g.command} (${g.runner || 'generic'})`).join(', ')}`);
  const last = [...iterations].reverse().find(i => i.interpreted);
  if (last && last.interpreted) {
    lines.push(`Last failing gate: ${last.gate} (exit ${last.interpreted.exitCode}, ${last.interpreted.failures.length} failure(s))`);
    for (const f of last.interpreted.failures.slice(0, 12)) {
      const where = f.file ? ` @ ${f.file.path}${f.file.line ? ':' + f.file.line : ''}` : '';
      lines.push(`  - ${f.name}${where}${f.message ? ': ' + f.message.slice(0, 160) : ''}`);
    }
    if (last.interpreted.stderrTail && last.interpreted.failures.length === 0) {
      lines.push('  stderr tail: ' + last.interpreted.stderrTail.slice(-600).replace(/\n/g, '\n  '));
    }
  }
  const phases = iterations.filter(i => i.attempt > 0).map(i => `attempt ${i.attempt}: ${i.phase}`).join('; ');
  if (phases) lines.push('Iterations: ' + phases);
  const noProgress = iterations.some(i => i.phase === 'no-progress');
  if (noProgress) lines.push('Stopped early: fixes produced an identical failure set (no progress).');
  const noFix = iterations.some(i => i.phase === 'no-fix');
  if (noFix) lines.push('Stopped early: the model proposed no further changes.');
  const noChange = iterations.some(i => i.phase === 'no-change');
  if (noChange) lines.push('Stopped early: a proposed fix would not have changed any file.');
  if (keepOnFailure) lines.push('The last attempted fix was left in place (keepOnFailure).');
  else if (restoredFiles.length) lines.push(`Rolled back ${restoredFiles.length} file(s): ${restoredFiles.join(', ')}`);
  // Surface rollback failures loudly: a half-restored tree is a real problem.
  if (rollbackErrors.length) {
    lines.push('ROLLBACK INCOMPLETE — the tree may be inconsistent: ' + rollbackErrors.join('; '));
  }
  return lines.join('\n');
}

module.exports = {
  RUNNERS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_NO_PROGRESS_LIMIT,
  MAX_OUTPUT_CHARS,
  parseNodeTestOutput,
  parsePytestOutput,
  parseGenericOutput,
  parserFor,
  interpret,
  failureSignature,
  runSelfCorrectionLoop,
  rollbackAll,
  buildReport,
};
