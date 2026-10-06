'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCompletionReport, renderCompletionReport, completionPromptBlock, normalizeEvidence,
} = require('../agent/completion-report.cjs');

const journalEvidence = [
  { tool: 'read', path: 'src/app.js', ok: true, pending: false },
  { tool: 'shell', path: '', ok: true, pending: false, error: undefined },
  { tool: 'tests.run', path: '', ok: true, pending: false },
  { tool: 'write', path: 'src/app.js', ok: true, pending: false },
  { tool: 'write', path: 'src/other.js', ok: true, pending: true, decision: 'declined' },
];

test('normalizeEvidence maps journal shapes into report kinds', () => {
  assert.equal(normalizeEvidence({ tool: 'read', ok: true }).kind, 'read');
  assert.equal(normalizeEvidence({ tool: 'write', ok: true }).kind, 'edit');
  assert.equal(normalizeEvidence({ tool: 'tests.run', ok: true }).kind, 'test');
  assert.equal(normalizeEvidence({ tool: 'shell', command: 'npm test', ok: true }).kind, 'test');
  assert.equal(normalizeEvidence({ tool: 'shell', ok: true }).kind, 'shell');
});

test('a claim citing a real, successful tool result is verified', () => {
  const report = buildCompletionReport(
    ['Edited src/app.js to fix the bug'],
    journalEvidence,
  );
  assert.equal(report.ready, true);
  assert.equal(report.verified.length, 1);
  assert.ok(report.verified[0].evidence.length > 0);
  assert.equal(report.unverified.length, 0);
});

test('a claim with no matching evidence lands in unverified and blocks readiness', () => {
  const report = buildCompletionReport(
    ['Deployed the service to production'],
    journalEvidence,
  );
  assert.equal(report.ready, false);
  assert.equal(report.unverified.length, 1);
  assert.match(report.unverified[0].text, /Deployed/);
});

test('a declined edit is never counted as evidence for a claim', () => {
  const report = buildCompletionReport(
    ['Updated src/other.js'],
    journalEvidence,
  );
  // The only edit for src/other.js was declined → the claim must not verify.
  assert.equal(report.verified.some(v => /other\.js/.test(v.text)), false);
  assert.equal(report.summary.editsDeclined, 1);
});

test('a failing test blocks readiness even when claims verify', () => {
  const evidence = [
    { tool: 'write', path: 'a.js', ok: true, pending: false },
    { tool: 'tests.run', path: '', ok: false, pending: false, error: '1 failing test' },
  ];
  const report = buildCompletionReport(['Added a.js'], evidence);
  assert.equal(report.ready, false);
  assert.equal(report.summary.testsFailed, 1);
});

test('a claim contradicted by a failed matching record is listed under failed', () => {
  const evidence = [
    { tool: 'write', path: 'src/app.js', ok: false, pending: false, error: 'refused' },
  ];
  const report = buildCompletionReport(['Edited src/app.js'], evidence);
  assert.equal(report.ready, false);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].contradictedBy, 'e1');
});

test('empty input produces an honest empty report, not readiness', () => {
  const report = buildCompletionReport([], []);
  assert.equal(report.ready, false);
  assert.equal(report.summary.evidenceCount, 0);
});

test('renderCompletionReport separates verified, unverified, and the verdict', () => {
  const report = buildCompletionReport(
    ['Fixed parser.js', 'Also fixed the renderer'],
    [{ tool: 'read', path: 'parser.js', ok: true }],
  );
  const text = renderCompletionReport(report);
  assert.match(text, /COMPLETION REPORT/);
  assert.match(text, /Verified claims:/);
  assert.match(text, /NOT verified/);
  assert.match(text, /do not treat this run as done/);
});

test('completionPromptBlock demands claims with citations', () => {
  const block = completionPromptBlock();
  assert.match(block, /EVIDENCE-BASED COMPLETION/);
  assert.match(block, /Separate .*verified.* from .*assumed/i);
});
