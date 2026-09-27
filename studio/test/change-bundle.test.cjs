'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBundle, auditBundle, assembleBundle, renderBundle, bundlePromptBlock,
} = require('../agent/change-bundle.cjs');

const complete = {
  title: 'Add risk gates',
  rationale: 'consequential actions must be gated',
  files: ['studio/agent/risk-gates.cjs', 'studio/agent/agent-tool-runner.cjs'],
  tests: [{ command: 'npm test', passed: true, result: '621 pass' }],
  risks: ['approval prompts may feel slow at first'],
  rollback: 'git revert the single commit',
};

test('a complete bundle audits ready with no blockers', () => {
  const audit = auditBundle(complete);
  assert.deepEqual(audit.missing, []);
  assert.equal(audit.ready, true);
  assert.deepEqual(audit.blockers, []);
});

test('each missing section is named in the audit', () => {
  const audit = auditBundle({ title: 't' });
  assert.equal(audit.ready, false);
  for (const name of ['rationale', 'files', 'tests', 'risks', 'rollback']) {
    assert.ok(audit.missing.includes(name), `${name} must be reported missing`);
  }
  assert.match(audit.blockers.join(' '), /missing rationale/);
});

test('a failed test blocks readiness even when all sections exist', () => {
  const audit = auditBundle({ ...complete, tests: [{ command: 'npm test', passed: false, result: '1 fail' }] });
  assert.equal(audit.ready, false);
  assert.match(audit.blockers.join(' '), /test failed: npm test/);
});

test('normalizeBundle accepts risks as string or array and caps files', () => {
  const b = normalizeBundle({ risks: 'some risk', files: Array.from({ length: 80 }, (_, i) => `f${i}.js`) });
  assert.equal(b.files.length, 50);
  assert.equal(typeof b.risks, 'string');
  const b2 = normalizeBundle({ risks: ['a', 'b'] });
  assert.deepEqual(b2.risks, ['a', 'b']);
});

test('assembleBundle derives tests and files from journal evidence', () => {
  const evidence = [
    { tool: 'tests.run', command: 'npm test', ok: true, path: '' },
    { tool: 'shell', command: 'npm test --watch', ok: false, path: '', error: '1 failing test' },
    { tool: 'write', command: '', ok: true, path: 'studio/agent/risk-gates.cjs' },
    { tool: 'read', command: '', ok: true, path: 'studio/main.mjs' },
  ];
  const bundle = assembleBundle({
    title: 'Add risk gates',
    rationale: 'gate consequential actions',
    rollback: 'revert',
    risks: 'prompt fatigue',
    evidence,
  });
  assert.ok(bundle.files.includes('studio/agent/risk-gates.cjs'));
  assert.ok(bundle.files.includes('studio/main.mjs'));
  // Both test commands are captured; the failing one records passed:false.
  assert.equal(bundle.tests.length, 2);
  const failing = bundle.tests.find(t => t.result === '1 failing test');
  assert.equal(failing.passed, false);
  assert.equal(auditBundle(bundle).ready, false, 'a recorded failing test must block readiness');
});

test('assembleBundle with no evidence yields an honest NOT READY bundle', () => {
  const bundle = assembleBundle({ title: 't', rationale: 'r', rollback: 'revert', risks: 'none known' });
  const audit = auditBundle(bundle);
  assert.equal(audit.ready, false);
  assert.ok(audit.missing.includes('tests'));
  const text = renderBundle(bundle, audit);
  assert.match(text, /Tests: \(none recorded\)/);
  assert.match(text, /NOT READY/);
});

test('renderBundle shows pass/fail per test and a ready verdict', () => {
  const text = renderBundle(complete);
  assert.match(text, /CHANGE BUNDLE/);
  assert.match(text, /npm test → pass/);
  assert.match(text, /READY/);
  const bad = renderBundle({ ...complete, tests: [{ command: 'npm test', passed: false }] });
  assert.match(bad, /npm test → FAIL/);
  assert.match(bad, /NOT READY/);
});

test('bundlePromptBlock forbids implied coverage', () => {
  assert.match(bundlePromptBlock(), /tests not recorded/);
  assert.match(bundlePromptBlock(), /never fill it with a guess/);
});
