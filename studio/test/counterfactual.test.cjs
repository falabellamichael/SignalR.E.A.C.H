'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reviewerPrompt, parseReview, surfaceDisagreements, renderReview,
} = require('../agent/counterfactual.cjs');

test('reviewerPrompt frames independence and the three questions', () => {
  const prompt = reviewerPrompt({ goal: 'Add risk gates', change: 'new module risk-gates.cjs', tests: 'npm test green' });
  assert.match(prompt, /independent reviewer/);
  assert.match(prompt, /must not defend it/);
  assert.match(prompt, /Task: Add risk gates/);
  assert.match(prompt, /failure_mode/);
  assert.match(prompt, /simpler_alternative/);
  assert.match(prompt, /disproof_test/);
});

test('parseReview extracts all three fields from a fenced reply', () => {
  const text = [
    'Here is my review of the change:',
    '```review',
    'failure_mode: the gate trusts args.command, which a nested tool can bypass',
    'simpler_alternative: none',
    'disproof_test: run the sandbox with a tests.run gate command and assert it is evaluated',
    '```',
    'I hope that helps.',
  ].join('\n');
  const review = parseReview(text);
  assert.match(review.failureMode, /args\.command/);
  assert.equal(review.simplerAlternative, 'none');
  assert.match(review.disproofTest, /tests\.run/);
  assert.equal(review.complete, true);
});

test('parseReview handles multi-line fields and missing prose fence', () => {
  const text = '```review\nfailure_mode: line one\nline two of the same mode\nsimpler_alternative: use a deny list\ndisproof_test: assert refusal\n```';
  const review = parseReview(text);
  assert.equal(review.failureMode, 'line one line two of the same mode');
  assert.equal(review.simplerAlternative, 'use a deny list');
  assert.equal(review.complete, true);
});

test('parseReview is incomplete when a required field is missing', () => {
  const review = parseReview('```review\nfailure_mode: only one field\n```');
  assert.equal(review.failureMode, 'only one field');
  assert.equal(review.disproofTest, '');
  assert.equal(review.complete, false);
});

test('surfaceDisagreements lists findings the implementer did not acknowledge', () => {
  const report = 'The gate was tested with npm test and covers the bypass case for nested commands.';
  const review = parseReview('```review\nfailure_mode: nested commands bypass the gate\nsimpler_alternative: none\ndisproof_test: assert tests.run is evaluated\n```');
  const disagreements = surfaceDisagreements(report, review);
  // The implementer DID mention the bypass for nested commands → acknowledged.
  assert.ok(!disagreements.some(d => d.kind === 'failure_mode'));
});

test('an unacknowledged reviewer finding is always surfaced', () => {
  const report = 'Everything looks fine, tests pass.';
  const review = parseReview('```review\nfailure_mode: race condition on concurrent saves\nsimpler_alternative: a single writer queue\ndisproof_test: save from two workers simultaneously\n```');
  const disagreements = surfaceDisagreements(report, review);
  const kinds = disagreements.map(d => d.kind);
  assert.ok(kinds.includes('failure_mode'));
  assert.ok(kinds.includes('disproof_test'));
});

test('renderReview puts disagreements first and states each finding', () => {
  const review = parseReview('```review\nfailure_mode: X fails\ndisproof_test: test X\nsimpler_alternative: none\n```');
  const text = renderReview(review, [{ kind: 'failure_mode', text: 'X fails' }]);
  assert.match(text, /COUNTERFACTUAL REVIEW/);
  assert.match(text, /DISAGREEMENTS/);
  assert.match(text, /Failure mode: X fails/);
  // Disagreement header must come before the findings.
  assert.ok(text.indexOf('DISAGREEMENTS') < text.indexOf('Failure mode:'));
});
