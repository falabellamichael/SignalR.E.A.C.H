'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SCENARIOS,
  buildReport,
  stableReportJson,
} = require('../bench/team-nurse-benchmark.cjs');
const { DEFAULT_NURSE_POLICY } = require('../agent/team-nurse.cjs');

test('Team Nurse virtual benchmark is deterministic and correctness-gated', () => {
  const first = stableReportJson();
  const second = stableReportJson();
  assert.equal(first, second, 'two complete searches must produce byte-identical output');

  const report = JSON.parse(first);
  assert.equal(report.deterministic, true);
  assert.equal(report.corpus.length, SCENARIOS.length);
  assert.equal(report.chosen.metrics.correctnessFailures, 0);
  assert.equal(report.chosen.metrics.safetyViolations, 0);
  assert.deepEqual(report.chosen.policy, {
    minRecoveryScore: 8,
    priorWakePenalty: 3,
    maxAutoWakesPerMember: 2,
    concurrent: true,
    coalesced: true,
    directSynthesisHandoff: true,
  });
  assert.equal(DEFAULT_NURSE_POLICY.minRecoveryScore, report.chosen.policy.minRecoveryScore);
  assert.equal(DEFAULT_NURSE_POLICY.priorWakePenalty, report.chosen.policy.priorWakePenalty);
  assert.equal(DEFAULT_NURSE_POLICY.maxAutoWakesPerMember, report.chosen.policy.maxAutoWakesPerMember);
});

test('chosen corpus policy beats the sequential baseline without extra calls or retries', () => {
  const report = buildReport();
  assert.equal(report.baseline.metrics.correctnessFailures, 0);
  assert.ok(report.chosen.metrics.totalLatencyMs < report.baseline.metrics.totalLatencyMs);
  assert.ok(report.chosen.metrics.providerCalls < report.baseline.metrics.providerCalls);
  assert.ok(report.chosen.metrics.wakeCalls < report.baseline.metrics.wakeCalls);
  assert.ok(report.chosen.metrics.failedRetries < report.baseline.metrics.failedRetries);
  assert.ok(report.chosen.metrics.idleCapacityMs < report.baseline.metrics.idleCapacityMs);

  const guards = report.scenarios.find(scenario => scenario.id === 'hard-and-user-gates');
  assert.ok(guards);
  assert.equal(guards.chosen.wakeCalls, 0);
  assert.equal(guards.baseline.wakeCalls, 0);

  const transport = report.scenarios.find(scenario => scenario.id === 'transport-exhaustion-guard');
  assert.ok(transport);
  assert.equal(transport.chosen.wakeCalls, 0);
  assert.equal(transport.baseline.wakeCalls, 0);

  const coalesced = report.scenarios.find(scenario => scenario.id === 'coalesced-dual-evidence');
  assert.equal(coalesced.chosen.wakeCalls, 1);
  assert.equal(coalesced.baseline.wakeCalls, 2);

  const duplicate = report.scenarios.find(scenario => scenario.id === 'duplicate-evidence');
  assert.equal(duplicate.chosen.wakeCalls, 1);
  assert.equal(report.chosen.metrics.duplicateEvidenceSuppressed, 1);
});
