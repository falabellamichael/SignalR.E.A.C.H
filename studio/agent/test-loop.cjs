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
const { planFromEdits, applyPlan, summarizePlan, validateSyntax } = require('./refactor.cjs');

/**
 * The PRD's self-correction story specifies "up to 10 attempts" against the
 * project's test/lint/type gates before pausing for the user, so 10 is the
 * default. `noProgressLimit` still stops the loop early when repeated fixes
 * change nothing — the cap is a ceiling, not a target.
 */
const DEFAULT_MAX_ATTEMPTS = 10;
/*
 * E14: the three constants below are now the DEFAULTS of budgets fields
 * (maxAttempts, noProgressLimit, gateOutputChars), so a run can tune the
 * self-correction loop without editing engine source. Each stays exported and
 * each keeps its old value when no budgets are supplied, so a caller that does
 * not pass them — every existing test, and main.mjs before its call site is
 * updated — behaves byte-identically.
 */
function loopLimits(budgets) {
  const positive = (key, fallback) => {
    const value = budgets?.[key];
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    maxAttempts: positive('maxAttempts', DEFAULT_MAX_ATTEMPTS),
    noProgressLimit: positive('noProgressLimit', DEFAULT_NO_PROGRESS_LIMIT),
    gateOutputChars: positive('gateOutputChars', MAX_OUTPUT_CHARS),
  };
}
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
  jest: {
    label: 'Jest',
    parse: parseJestOutput,
  },
  vitest: {
    label: 'Vitest',
    parse: parseVitestOutput,
  },
  tsc: {
    label: 'TypeScript compiler',
    parse: parseTscOutput,
  },
  eslint: {
    label: 'ESLint',
    parse: parseEslintOutput,
  },
  generic: {
    label: 'Generic (exit code + failing lines)',
    parse: parseGenericOutput,
  },
};

/** node --test / node:test TAP-ish output. */
function parseNodeTestOutput(stdout, stderr) {
  const text = scanText(stdout, stderr);
  const failures = [];
  const lines = splitLines(text);
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
  const text = scanText(stdout, stderr);
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
  const counts = {};
  // pytest's summary is `=== N failed, M passed in 0.05s ===`; count the words
  // rather than assuming a particular banner width.
  const failedMatch = /(\d+)\s+failed/.exec(text);
  const passedMatch = /(\d+)\s+passed/.exec(text);
  if (failedMatch) counts.fail = Number(failedMatch[1]);
  if (passedMatch) counts.pass = Number(passedMatch[1]);
  // Same shape guarantee as the other parsers: a clean run has no "failed" token,
  // which used to leave counts.fail undefined instead of 0.
  counts.fail = Number(counts.fail) || 0;
  counts.pass = Number(counts.pass) || 0;
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
  const text = scanText(stdout, stderr);
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

/**
 * Strip ANSI/VT escape sequences (colours, cursor moves, reverse video).
 *
 * Every tool in this table colourises when it thinks it has a TTY, and tsc does
 * so even when piped in some environments — verified against real output, where
 * `src/bad.ts:4:7 - error TS2322: …` arrived as
 * `\x1b[96msrc/bad.ts\x1b[0m:\x1b[93m4\x1b[0m:\x1b[93m7\x1b[0m - …`.
 *
 * This matters far beyond cosmetics: a parser that matches nothing returns an
 * EMPTY failure list, and the loop reads that as "nothing failed". Combined
 * with a non-zero exit code the run is still red, but with no diagnostics to
 * act on — and any tool that exits 0 while printing errors would look green.
 * Stripping once here protects every parser instead of each regex having to
 * anticipate escape codes inside its own pattern.
 */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
function stripAnsi(text) {
  return String(text == null ? '' : text).replace(ANSI_RE, '');
}

/**
 * Split captured tool output into lines, tolerating CRLF.
 *
 * Tools on Windows emit \r\n. Splitting on '\n' alone leaves a trailing '\r'
 * on every line, which silently breaks any regex anchored with `$` and no
 * trailing `\s*` — that is exactly how an ESLint file-header line stopped
 * matching and every one of its diagnostics was dropped. Splitting on
 * /\r?\n/ removes the hazard for all parsers at once.
 */
function splitLines(text) {
  return String(text == null ? '' : text).split(/\r?\n/);
}

/**
 * Combine a tool's stdout and stderr into one plain-text scan buffer: ANSI
 * escapes removed and line endings normalised to '\n'.
 *
 * Parsers that scan the WHOLE buffer with /gm regexes (pytest, generic) cannot
 * rely on splitLines(), because in multiline mode `$` matches before the '\n'
 * and a trailing '\r' is still inside the capture group. Normalising here makes
 * every anchored pattern behave identically regardless of host OS.
 */
function scanText(stdout, stderr) {
  return (stripAnsi(stdout) + '\n' + stripAnsi(stderr)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Is this line noise that must never join a failure message?
 *
 * Jest and Vitest print the offending SOURCE with a line-number gutter and a
 * caret, plus a `- Expected / + Received` diff block, inside each failure.
 * Those are context for a human, but folded into `message` they bury the actual
 * assertion (verified against real jest 29 / vitest 1 output, where the message
 * became "expect(received).toBe(expected) … 1 | const { sum } = require…" and
 * the diff lines).
 *
 *   `      4 |   test('handles zero', …)`   gutter + source echo
 *   `        |              ^`             caret / underline
 *   `    - Expected` / `    + Received`    diff header
 *   `    - 4` / `    + 3`                  diff value
 *   `⎯⎯ Failed Tests 2 ⎯⎯`                 vitest divider
 */
function isNoiseLine(line) {
  const t = String(line == null ? '' : line).trim();
  if (!t) return true;
  if (/^\d+\s*\|/.test(t)) return true;          // `4 | source…`
  if (/^>\s*\d+\s*\|/.test(t)) return true;      // `> 4 | source…`
  if (/^[|^~^\s]+$/.test(t)) return true;         // caret / gutter-only lines
  if (/^[-+]\s/.test(t)) return true;             // diff line
  if (/^[-+](Expected|Received)$/.test(t)) return true;
  if (/^[⎯─━=_]{3,}/.test(t)) return true;        // dividers
  if (/^\[\d+\/\d+\]$/.test(t)) return true;
  return false;
}

/** Append a content line to a failure message, skipping noise, bounded. */
function appendMessage(failure, line, limit = 400) {
  if (isNoiseLine(line)) return;
  const t = line.trim();
  if (failure.message.length >= limit) return;
  failure.message = (failure.message ? failure.message + ' ' : '') + t.slice(0, 200);
}

/* ------------------------------------------------ TypeScript toolchain parsers */

/**
 * Jest output. Jest writes results to STDERR (not stdout) and prefixes file
 * names with FAIL/PASS. The per-test block looks like:
 *
 *   ● suite › test name
 *
 *     expect(received).toBe(expected)
 *
 *       at Object.<anonymous> (src/a.test.ts:12:5)
 *
 * Summary lines: `Tests: 1 failed, 2 passed, 3 total`.
 */
function parseJestOutput(stdout, stderr) {
  const text = scanText(stdout, stderr);
  const lines = splitLines(text);
  const failures = [];
  let current = null;

  for (const line of lines) {
    // `● suite › name` — Jest uses U+25CF. A nested `›` chain is the test path.
    const head = /^\s*●\s+(?!Console)(.+?)\s*$/.exec(line);
    if (head) {
      const name = head[1].replace(/\s*›\s*/g, ' › ').trim();
      current = { name: name.slice(0, 200), file: null, message: '', stack: [] };
      failures.push(current);
      continue;
    }
    // A new file header ends the current failure's message accumulation.
    if (/^\s*(?:FAIL|PASS)\s+\S/.test(line)) { current = null; continue; }
    if (!current) continue;

    const at = /^\s*at\s+(.+)$/.exec(line);
    if (at) {
      current.stack.push(at[1].trim());
      // `at Object.<anonymous> (src/a.test.ts:12:5)`
      const ref = /\(([^()]*?\.[cm]?[jt]sx?):(\d+):(\d+)\)/.exec(at[1])
        || /(?:^|\s)([^()\s]*?\.[cm]?[jt]sx?):(\d+):(\d+)/.exec(at[1]);
      if (ref && !current.file) current.file = { path: ref[1], line: Number(ref[2]), column: Number(ref[3]) };
      continue;
    }
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    if (current.stack.length) continue;   // do not fold stack frames into the message
    // Jest prints the source gutter + caret + diff block inside each failure;
    // none of that belongs in the message the fixer reads.
    appendMessage(current, trimmedLine);
  }

  // `Tests:       1 failed, 2 passed, 3 total`
  const counts = {};
  const testsLine = /^\s*Tests:\s*(.+)$/m.exec(text);
  if (testsLine) {
    let m;
    const re = /(\d+)\s+(failed|passed|skipped|todo)/gi;
    while ((m = re.exec(testsLine[1])) !== null) {
      const key = m[2].toLowerCase();
      // Normalise to the keys every other parser emits (fail/pass), so a
      // caller does not need a per-runner translation table.
      const norm = key === 'failed' ? 'fail' : key === 'passed' ? 'pass' : key;
      counts[norm] = Number(m[1]);
    }
    const total = /(\d+)\s+total/i.exec(testsLine[1]);
    if (total) counts.tests = Number(total[1]);
  }
  if (!counts.fail && failures.length) counts.fail = failures.length;
  // Normalise the shape: `counts.fail` is always a number, so a caller (or the
  // UI) never has to distinguish "0 failures" from "field absent". A passing
  // run has no `failed` token in the summary, which previously left this
  // undefined.
  counts.fail = Number(counts.fail) || 0;
  counts.pass = Number(counts.pass) || 0;

  // Jest also emits a machine-readable summary line; prefer it when present.
  const jsonSummary = /^\s*{\s*"numFailedTests":\s*(\d+),\s*"numPassedTests":\s*(\d+)/m.exec(text);
  if (jsonSummary) { counts.fail = Number(jsonSummary[1]); counts.pass = Number(jsonSummary[2]); }

  return { failures, counts, parser: 'jest' };
}

/**
 * Vitest output.
 *
 * Verified against real vitest 1.6 output rather than assumed shape. Two
 * layouts appear in one run: a compact list AND a detail block per failure, so
 * the same test is printed twice and a naive parser doubles the count.
 *
 *   compact list                       detail block
 *   ❯ vsum.test.js > sum > adds…       FAIL  vsum.test.js > sum > adds…
 *     → expected 3 to be 4             AssertionError: expected 3 to be 4
 *                                      - Expected / + Received / - 4 / + 3
 *                                      ❯ vsum.test.js:4:54
 *                                      4|   test('adds two numbers', …)
 *
 * Failures are keyed on (file, name) so the two layouts merge into one entry
 * carrying both the file reference and the best message.
 *
 * Three other `❯`-prefixed lines are NOT failures and are skipped explicitly:
 * the per-file header (`❯ vsum.test.js  (2 tests | 2 failed) 8ms`) and the file
 * reference (`❯ vsum.test.js:4:54`). Matching those as tests was the bug that
 * turned 2 real failures into 7 phantom ones.
 */
function parseVitestOutput(stdout, stderr) {
  const text = scanText(stdout, stderr);
  const lines = splitLines(text);
  const byKey = new Map();
  const failures = [];
  let current = null;

  const addFailure = (name, filePath) => {
    const key = (filePath || '') + '::' + name;
    let f = byKey.get(key);
    if (!f) {
      f = { name, file: filePath ? { path: filePath, line: null } : null, message: '', stack: [] };
      byKey.set(key, f);
      failures.push(f);
    } else if (filePath && !f.file) {
      f.file = { path: filePath, line: null };
    }
    return f;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Run banner, summary footer and dividers end the current failure.
    if (/^(?:Test Files|Tests|Duration|Start at|RUN)\b/.test(line) || /^[⎯─━]{3,}/.test(line)) {
      current = null;
      continue;
    }

    // `FAIL  path > suite > test` — the authoritative detail block.
    const fail = /^FAIL\s+(.+?)\s+>\s+(.+?)\s*$/.exec(line);
    if (fail) {
      current = addFailure(fail[2].replace(/\s*>\s*/g, ' › ').trim().slice(0, 200), fail[1].trim());
      continue;
    }

    // `❯ path:line:col` — a file reference for the current failure, not a test.
    const ref = /^[❯✗×]\s+([^\s>]+?\.[cm]?[jt]sx?):(\d+):(\d+)\s*$/.exec(line);
    if (ref) {
      if (current) {
        if (!current.file) current.file = { path: ref[1], line: Number(ref[2]), column: Number(ref[3]) };
        else { current.file.line = Number(ref[2]); current.file.column = Number(ref[3]); }
        current.stack.push(line);
      }
      continue;
    }

    // `❯ path  (N tests | M failed) Nms` — a per-file header, not a failure.
    if (/^[❯✗×]\s+\S+\s+\(\d+\s+tests?\s*\|/.test(line)) continue;

    // `❯ path > suite > test` — the compact list entry.
    const entry = /^[❯✗×]\s+(.+?)\s+>\s+(.+?)\s*$/.exec(line);
    if (entry) {
      current = addFailure(entry[2].replace(/\s*>\s*/g, ' › ').trim().slice(0, 200), entry[1].trim());
      continue;
    }

    if (!current) continue;
    if (/^at\s/.test(line)) { current.stack.push(line); continue; }

    // Message lines. An explicit error class (`AssertionError: …`) is more
    // informative than the compact `→ …` summary, so it replaces it.
    const msg = line.replace(/^→\s*/, '');
    if (/^[A-Z][\w]*(?:Error|Exception):/.test(msg)) { current.message = msg.slice(0, 400); continue; }
    appendMessage(current, msg);
  }

  const counts = {};
  // `      Tests  2 failed (2)` — note vitest uses `|` as a separator only in
  // some reporters, so match each `<n> <state>` token independently.
  const testsLine = /^\s*Tests\s+(.+)$/m.exec(text);
  if (testsLine) {
    let m;
    const re = /(\d+)\s+(failed|passed|skipped)/gi;
    while ((m = re.exec(testsLine[1])) !== null) {
      const key = m[2].toLowerCase();
      counts[key === 'failed' ? 'fail' : key === 'passed' ? 'pass' : key] = Number(m[1]);
    }
  }
  if (!counts.fail && failures.length) counts.fail = failures.length;
  // Same shape guarantee as the Jest parser: `fail` is always a number.
  counts.fail = Number(counts.fail) || 0;
  counts.pass = Number(counts.pass) || 0;
  return { failures, counts, parser: 'vitest' };
}

/**
 * tsc output. Diagnostics are file-oriented, not test-oriented:
 *
 *   src/a.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.
 *
 * Also handles the `--pretty false` form (`src/a.ts(12,5): error TS2322: ...`)
 * and project-wide errors with no file (`error TS5057: ...`).
 */
function parseTscOutput(stdout, stderr) {
  const text = scanText(stdout, stderr);
  const failures = [];
  // Pretty form: `path:line:col - error TSxxxx: message`
  const pretty = /^([^\s(][^:]*?\.[cm]?[jt]sx?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s*(.*)$/;
  // Classic form: `path(line,col): error TSxxxx: message`
  const classic = /^([^\s(][^(]*?\.[cm]?[jt]sx?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;
  // No-file form: `error TS5057: ...`
  const global = /^error\s+(TS\d+):\s*(.*)$/;

  for (const line of splitLines(text)) {
    const t = line.trim();
    if (!t) continue;
    let m = pretty.exec(t) || classic.exec(t);
    if (m) {
      const [, path_, lineNo, col, severity, code, message] = m;
      failures.push({
        name: `${code}: ${message.trim().slice(0, 160)}`,
        file: { path: path_.trim(), line: Number(lineNo), column: Number(col) },
        message: message.trim().slice(0, 400),
        severity: severity.toLowerCase(),
        code,
        stack: [],
        fixable: false,
      });
      continue;
    }
    const g = global.exec(t);
    if (g) {
      failures.push({ name: `${g[1]}: ${g[2].trim().slice(0, 160)}`, file: null, message: g[2].trim().slice(0, 400), severity: 'error', code: g[1], stack: [], fixable: false });
      continue;
    }
    // Continuation lines of a multi-line diagnostic get appended to the last one.
    const last = failures[failures.length - 1];
    if (last && last.message.length < 400 && !/^\s*\d+\s+/.test(t) && !/^~+$/.test(t) && !/^\s*$/.test(t)) {
      // Skip the source-echo and caret lines tsc prints under a diagnostic.
      if (!/^[\s~^]+$/.test(line)) last.message = (last.message + ' ' + t).slice(0, 400);
    }
  }

  const counts = {};
  const errorCount = /(\d+)\s+errors?\b/i.exec(text);
  if (errorCount) counts.fail = Number(errorCount[1]);
  else counts.fail = failures.filter(f => f.severity !== 'warning').length;
  counts.warnings = failures.filter(f => f.severity === 'warning').length;
  return { failures, counts, parser: 'tsc' };
}

/**
 * ESLint default (stylish) output:
 *
 *   /abs/src/a.ts
 *     12:5  error  'x' is defined but never used  no-unused-vars
 *
 * Also parses the `--format compact` form:
 *   /abs/src/a.ts: line 12, col 5, Error - 'x' is ... (no-unused-vars)
 *
 * `fixable` is set from ESLint's own summary line ("N problems (M errors,
 * K warnings) ... X fixable with the `--fix` option"), which is how the loop
 * decides whether a quick-fix pass can help.
 */
function parseEslintOutput(stdout, stderr) {
  const text = scanText(stdout, stderr);
  const lines = splitLines(text);
  const failures = [];
  let currentFile = null;

  const stylish = /^(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}([\w@./-]+)\s*$/;
  const stylishNoRule = /^(\d+):(\d+)\s+(error|warning)\s+(.+?)\s*$/;
  // Compact form: `path: line 1, col 7, Error - message. (rule-id)`.
  // The rule id is matched by its own pattern rather than an optional trailing
  // group: `(.+?)\s*(?:\((rule)\))?$` lets the lazy message swallow the rule id
  // and skip the optional group entirely, which is how compact output lost its
  // rule ids while stylish output kept them.
  const compactRule = /^(.*?\.[cm]?[jt]sx?):\s*line\s+(\d+),\s*col\s+(\d+),\s*(Error|Warning)\s*-\s*(.+?)\s+\(([\w@./-]+)\)\s*$/;
  const compactNoRule = /^(.*?\.[cm]?[jt]sx?):\s*line\s+(\d+),\s*col\s+(\d+),\s*(Error|Warning)\s*-\s*(.+?)\s*$/;

  for (const rawLine of lines) {
    // ESLint indents every problem line under its file header, and the summary
    // lines are indented too. All the patterns below are anchored at ^, so they
    // must be matched against the TRIMMED line — running them against the raw
    // line silently matched nothing and dropped every diagnostic while the
    // summary count still reported 7 problems.
    const line = rawLine.trim();
    if (!line) { continue; }

    // A file header in stylish output is a bare path ending in a known source
    // extension. Absolute (C:\... or /...) and relative (./ or ../) both occur.
    if (/^(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/)[^\s]+?\.[cm]?[jt]sx?$/.test(line)) {
      currentFile = line;
      continue;
    }

    const cm = compactRule.exec(line) || compactNoRule.exec(line);
    if (cm) {
      // Capture groups: 1=path 2=line 3=col 4=severity 5=message 6=rule.
      // compactRule has all six; compactNoRule stops at 5, so cm[6] is undefined
      // there rather than a wrong-index read. (An earlier off-by-one read the
      // message from cm[6] and the rule from cm[7], which is why compact output
      // reported `rule id null` for every diagnostic.)
      const rule = cm[6] || null;
      const message = cm[5];
      failures.push({
        name: `${rule || 'eslint'}: ${String(message).trim().slice(0, 160)}`,
        file: { path: cm[1], line: Number(cm[2]), column: Number(cm[3]) },
        message: String(message).trim().slice(0, 400),
        severity: cm[4].toLowerCase(),
        code: rule,
        stack: [],
      });
      continue;
    }

    let sm = stylish.exec(line);
    let rule = null, message = null, lineNo = null, col = null, severity = null;
    if (sm) { lineNo = sm[1]; col = sm[2]; severity = sm[3]; message = sm[4]; rule = sm[5]; }
    else {
      sm = stylishNoRule.exec(line);
      if (sm) { lineNo = sm[1]; col = sm[2]; severity = sm[3]; message = sm[4]; }
    }
    if (sm && currentFile) {
      failures.push({
        name: `${rule || 'eslint'}: ${String(message).trim().slice(0, 160)}`,
        file: { path: currentFile, line: Number(lineNo), column: Number(col) },
        message: String(message).trim().slice(0, 400),
        severity: severity.toLowerCase(),
        code: rule,
        stack: [],
      });
    }
  }

  const counts = {};
  // `✖ 12 problems (10 errors, 2 warnings)`
  const problems = /(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/i.exec(text);
  if (problems) {
    counts.tests = Number(problems[1]);
    counts.fail = Number(problems[2]);
    counts.warnings = Number(problems[3]);
  } else {
    counts.fail = failures.filter(f => f.severity === 'error').length;
    counts.warnings = failures.filter(f => f.severity === 'warning').length;
  }
  // `10 errors and 0 warnings potentially fixable with the \`--fix\` option.`
  const fixable = /(\d+)\s+errors?\s+and\s+(\d+)\s+warnings?\s+potentially fixable/i.exec(text);
  if (fixable) counts.fixable = Number(fixable[1]) + Number(fixable[2]);
  else if (/potentially fixable with the/i.test(text)) counts.fixable = counts.fail;
  else counts.fixable = 0;
  return { failures, counts, parser: 'eslint' };
}

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
function interpret(result, runner, { maxOutputChars = MAX_OUTPUT_CHARS } = {}) {
  const res = result || {};
  // Strip escape codes before slicing: a colour sequence can split across the
  // cut point and leave a stray escape in the UI, and every parser below needs
  // plain text to match at all.
  const stdout = stripAnsi(res.stdout).slice(0, maxOutputChars);
  const stderr = stripAnsi(res.stderr).slice(0, maxOutputChars);
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
 *   quickFix     ({attempt, gate, interpreted, projectDir}) => Promise<{edits[], summary?}|null>
 *                Optional deterministic auto-fixer consulted BEFORE the model
 *                (PRD: "Automatically applies suggested quick-fixes for ESLint
 *                and tsc diagnostics before re-running tests"). This is where
 *                `eslint --fix` output belongs: formatting and import rules are
 *                cheaper to fix mechanically than to spend a model attempt on.
 *
 *                It must RETURN edits, never write files. Every byte of change
 *                goes through planFromEdits/applyPlan so the loop stays the only
 *                writer and rollback can still restore the pre-loop tree; a
 *                quick-fixer that rewrites in place would leave changes outside
 *                `appliedPlans` that a later failure cannot undo. To wrap a tool
 *                like `eslint --fix`, run it in a scratch copy and hand back the
 *                resulting diff. Returning null/[] falls through to proposeFix.
 *   projectDir   project root for refactor plans
 *   maxAttempts  iteration cap (default 10, per the PRD's self-correction story)
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
    quickFix,
    projectDir = null,
    maxAttempts = null,
    budgets = null,
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
  // E14: budgets supply the defaults; an explicit option still wins, so the
  // existing callers and tests keep today's numbers exactly.
  const limits = loopLimits(budgets);
  const attempts = Number.isSafeInteger(maxAttempts) && maxAttempts > 0
    ? Math.min(maxAttempts, 50) : limits.maxAttempts;
  const noProgressLimit = Number.isSafeInteger(options.noProgressLimit) && options.noProgressLimit > 0
    ? Math.min(options.noProgressLimit, 10) : limits.noProgressLimit;
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
      const interpreted = interpret({ ...raw, durationMs: raw && raw.durationMs !== undefined ? raw.durationMs : Date.now() - started }, gate.runner, { maxOutputChars: limits.gateOutputChars });
      emit('gate-result', { gate: gate.id || gate.command, ok: interpreted.ok, failures: interpreted.failures.length, durationMs: interpreted.durationMs });
      if (!interpreted.ok) return { ok: false, gate, interpreted };
    }
    return { ok: true };
  };

  const iterations = [];
  const appliedPlans = [];   // {plan, applied[]} for rollback on final failure
  let lastSignature = null;
  let stalled = 0;           // consecutive attempts with an unchanged failure set
  // Parse errors from the previous attempt's rejected edit, fed back to the fixer.
  // Cleared whenever an edit parses.
  let lastSyntaxErrors = null;
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
  // The diagnostics of the gate that is failing NOW, not the baseline's. Kept
  // alongside failingGate so the quick-fixer and the model fixer both receive
  // the failure set that the previous attempt actually produced — the baseline
  // snapshot goes stale as soon as anything is fixed.
  let failingInterpreted = baseline.interpreted;
  iterations.push({ attempt: 0, phase: 'baseline', gate: failingGate.id || failingGate.command, interpreted: baseline.interpreted, edits: null });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      emit('cancelled', { attempt });
      const restoredFiles = await rollbackAll(appliedPlans, planCtx, keepOnFailure);
      return { passed: false, attempts: attemptsUsed, iterations, report: 'Cancelled.', cancelled: true, restoredFiles };
    }
    attemptsUsed = attempt;
    emit('attempt-start', { attempt, maxAttempts: attempts });

    // Deterministic quick-fix first (PRD: "Automatically applies suggested
    // quick-fixes for ESLint and tsc diagnostics before re-running tests").
    //
    // quickFix returns EDITS rather than writing files itself. Keeping every
    // byte of change on the planFromEdits/applyPlan path preserves the loop's
    // two invariants: the loop is the only writer, and rollback can restore the
    // pre-loop tree. A quick-fixer that rewrote files in place (the obvious way
    // to wrap `eslint --fix`) would leave changes outside `appliedPlans`, so a
    // later failure could not undo them — the caller should run such a tool in a
    // scratch copy and hand back the diff.
    let quickEdits = null;
    if (typeof quickFix === 'function' && failingGate) {
      try {
        const qf = await quickFix({
          attempt,
          gate: failingGate,
          interpreted: failingInterpreted,
          projectDir,
        });
        if (qf && Array.isArray(qf.edits) && qf.edits.length) {
          quickEdits = qf.edits;
          emit('quick-fix', { attempt, gate: failingGate.id || failingGate.command, files: qf.edits.map(e => e.path), summary: qf.summary || null });
        }
      } catch (error) {
        // A quick-fixer that throws must not abort the loop — the model fixer
        // can still succeed where the mechanical one could not. Recorded and
        // continued past, never swallowed silently.
        iterations.push({ attempt, phase: 'quick-fix-error', error: String(error && error.message || error) });
        emit('quick-fix-error', { attempt, error: String(error && error.message || error) });
      }
    }

    // Ask the fixer for edits, unless a quick-fix already produced some.
    let edits = quickEdits;
    if (!edits && typeof proposeFix === 'function') {
      try {
        edits = await proposeFix({
          attempt,
          maxAttempts: attempts,
          gate: failingGate,
          interpreted: baseline.interpreted,
          lastFailure: failingInterpreted,
          previousEdits: iterations.map(i => i.edits).filter(Boolean),
          // Set only when the previous attempt's edit was rejected for not parsing.
          // Without this the fixer gets no signal about its own mistake and would
          // regenerate the same unparseable edit, so the loop would stall until
          // noProgressLimit rather than actually correcting anything.
          syntaxErrors: lastSyntaxErrors,
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
    // Reject a fix that would not parse BEFORE it touches disk. This path has no
    // human reviewing a diff — the loop is the only thing standing between a model
    // and the user's files — so it is the one place a syntax guard is mandatory
    // rather than merely useful.
    //
    // The tree is unchanged, so simply retrying would regenerate the same broken
    // edit. The parse error is therefore carried into the NEXT attempt's fixer
    // prompt (lastSyntaxErrors below) so the model can correct what it actually
    // got wrong. Counted as a stall so noProgressLimit still ends a loop that
    // cannot produce parseable code, instead of burning all 10 attempts.
    const syntax = await validateSyntax(plan);
    if (!syntax.ok) {
      lastSyntaxErrors = syntax.errors.slice(0, 8);
      iterations.push({
        attempt, phase: 'syntax-error', edits,
        errors: syntax.errors, warnings: syntax.warnings,
        detail: 'The proposed fix does not parse; it was not written to disk.',
        summary: summarizePlan(plan),
      });
      emit('syntax-error', { attempt, errors: syntax.errors.slice(0, 8) });
      stalled++;
      if (stalled >= noProgressLimit) {
        iterations.push({ attempt, phase: 'no-progress', detail: 'Repeated fixes failed to parse.' });
        emit('no-progress', { attempt, stalled });
        break;
      }
      continue;
    }
    lastSyntaxErrors = null;
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
    failingInterpreted = after.interpreted;
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
  parseJestOutput,
  parseVitestOutput,
  parseTscOutput,
  parseEslintOutput,
  parserFor,
  interpret,
  failureSignature,
  runSelfCorrectionLoop,
  rollbackAll,
  buildReport,
};
