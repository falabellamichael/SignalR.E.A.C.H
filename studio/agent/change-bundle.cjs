'use strict';

/* Reach Studio — proof-carrying change bundles.
 *
 * Every proposed change carries its proof with it: the rationale, the files
 * it touches, the tests that were run and what they showed, the known risks,
 * and the rollback path. A bundle that is MISSING any of those sections says
 * so — readiness is a property of the bundle, not of the agent's confidence,
 * so the user can see at a glance whether a proposal is ready to review.
 *
 * Pure leaf module: build + validate + render. The evidence comes from the
 * same journal records the completion report reads (tool results + edit
 * verdicts); this module assembles the bundle that the edit-review card can
 * show instead of a bare diff.
 */

const MAX_FIELD = 1000;
const MAX_FILES = 50;
const str = (value, max = MAX_FIELD) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = (value, max = MAX_FILES) => {
  if (!Array.isArray(value)) return [];
  return value.map(item => str(item, 500)).filter(Boolean).slice(0, max);
};

/** The required sections of a bundle, and what "present" means for each. */
const SECTIONS = {
  rationale:    v => !!str(v.rationale),
  files:        v => Array.isArray(v.files) && v.files.length > 0,
  tests:        v => Array.isArray(v.tests) && v.tests.length > 0
    && v.tests.every(t => typeof t === 'object' && t !== null && typeof t.command === 'string' && t.command.trim()),
  risks:        v => !!str(v.risks) || (Array.isArray(v.risks) && v.risks.length > 0),
  rollback:     v => !!str(v.rollback),
};

function normalizeBundle(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const risks = Array.isArray(input.risks) ? list(input.risks, 20) : str(input.risks);
  return {
    title: str(input.title, 300),
    rationale: str(input.rationale),
    files: list(input.files),
    tests: Array.isArray(input.tests)
      ? input.tests.map(t => ({
          command: str(t?.command, 500),
          passed: t?.passed === undefined ? null : !!t.passed,
          result: str(t?.result, 500),
        })).filter(t => t.command)
      : [],
    risks,
    rollback: str(input.rollback),
  };
}

/**
 * Audit a bundle: which sections are present, which are missing, and the
 * single readiness verdict. `ready` is true only when every section is
 * present AND no recorded test failed. A failed test does not make the
 * bundle "unreviewable" — it makes it NOT ready to ship, which is a
 * different and more honest statement.
 */
function auditBundle(bundle) {
  const b = normalizeBundle(bundle);
  const present = {};
  const missing = [];
  for (const [name, check] of Object.entries(SECTIONS)) {
    present[name] = check(b);
    if (!present[name]) missing.push(name);
  }
  const failedTests = b.tests.filter(t => t.passed === false);
  const unknownTests = b.tests.filter(t => t.passed === null);
  return {
    present,
    missing,
    ready: missing.length === 0 && failedTests.length === 0,
    blockers: [
      ...missing.map(name => `missing ${name}`),
      ...failedTests.map(t => `test failed: ${t.command}`),
    ],
  };
}

/**
 * Assemble a bundle from the pieces the run already has. Evidence records
 * come from the journal (agent-tool-runner.cjs → crew-journal.cjs): any
 * `tests.run` / `shell` record with a test-ish command becomes a test line;
 * accepted edits (or the proposed edit itself) become the files section.
 * Anything not derivable is left empty — auditBundle then reports it
 * missing, which is the point: the bundle must not invent proof.
 */
function assembleBundle({ title, rationale, risks, rollback, evidence = [], files = [] } = {}) {
  const tests = [];
  const seen = new Set();
  for (const record of Array.isArray(evidence) ? evidence : []) {
    const cmd = String(record.command || record.path || '');
    const looksLikeTest = /(^|\/|\\|\s)(npm\s+test|pytest|vitest|jest|node\s+--test)/i.test(cmd)
      || record.tool === 'tests.run';
    if (!looksLikeTest) continue;
    const key = cmd.toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    tests.push({
      command: cmd.slice(0, 500) || String(record.tool || 'test'),
      passed: record.ok === false ? false : record.ok === true ? true : null,
      result: record.error ? String(record.error).slice(0, 500) : (record.ok ? 'reported ok' : ''),
    });
  }
  const fileSet = new Set(list(files));
  for (const record of Array.isArray(evidence) ? evidence : []) {
    const p = String(record.path || '');
    if (p) fileSet.add(p.slice(0, 500));
  }
  return normalizeBundle({
    title,
    rationale,
    files: [...fileSet],
    tests,
    risks,
    rollback,
  });
}

/** Render the bundle as the card the edit review shows above the diff. */
function renderBundle(bundle, audit = null) {
  const b = normalizeBundle(bundle);
  const a = audit || auditBundle(bundle);
  const riskText = Array.isArray(b.risks) ? b.risks : [b.risks].filter(Boolean);
  const lines = [
    'CHANGE BUNDLE',
    b.title ? `Title: ${b.title}` : null,
    `Rationale: ${b.rationale || '(missing)'}`,
    b.files.length ? `Files: ${b.files.join(', ')}` : 'Files: (missing)',
    b.tests.length
      ? 'Tests: ' + b.tests.map(t => `${t.command} → ${t.passed === true ? 'pass' : t.passed === false ? 'FAIL' : 'not recorded'}`).join('; ')
      : 'Tests: (none recorded)',
    riskText.length ? 'Risks: ' + riskText.join('; ') : 'Risks: (missing)',
    `Rollback: ${b.rollback || '(missing)'}`,
    '',
    a.ready
      ? 'Readiness: READY — every section present, no recorded test failure.'
      : 'Readiness: NOT READY — ' + a.blockers.join(', '),
  ].filter(x => x !== null);
  return lines.join('\n');
}

/** Prompt block: what the model must attach to a consequential change. */
function bundlePromptBlock() {
  return 'PROOF-CARRYING CHANGES (required for consequential edits):'
    + ' Every change you propose carries its proof: rationale, the exact files it touches, '
    + 'the tests you ran and their real outcome, the known risks, and how to roll it back. '
    + 'If you have not run a test, say "tests not recorded" instead of implying coverage. '
    + 'A missing section is shown to the user as missing — never fill it with a guess.';
}

module.exports = {
  normalizeBundle, auditBundle, assembleBundle, renderBundle, bundlePromptBlock,
  SECTIONS,
};
