'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeHandoff, validateHandoff, renderHandoff, parseHandoff,
} = require('../agent/crew-handoff.cjs');

test('normalizeHandoff fills empty sections and caps lengths', () => {
  const h = normalizeHandoff({ goal: 'x'.repeat(5000), findings: ['a', 'b'] });
  assert.equal(h.goal.length, 2000);
  assert.deepEqual(h.findings, ['a', 'b']);
  assert.equal(h.filesTouched.length, 0);
});

test('normalizeHandoff accepts file objects with a path field', () => {
  const h = normalizeHandoff({ goal: 'g', filesTouched: [{ path: 'a.js' }, { file: 'b.js' }, 'c.js', 42] });
  assert.deepEqual(h.filesTouched, ['a.js', 'b.js', 'c.js']);
});

test('validateHandoff requires a goal and a next step', () => {
  const missing = validateHandoff({ findings: ['found something'] });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(' '), /goal/i);
  assert.match(missing.errors.join(' '), /next step/i);

  const good = validateHandoff({ goal: 'Implement the gate', nextStep: 'Review the diff' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.errors, []);
});

test('renderHandoff emits a fenced JSON block the parser can round-trip', () => {
  const handoff = {
    from: 'Luna1', to: 'Luna2', goal: 'Split the runner',
    findings: ['the runner owns 3 concerns'], evidence: ['test/crew-journal.test.cjs green'],
    filesTouched: ['studio/agent/team-runner.cjs'], unresolved: ['who owns the journal?'],
    nextStep: 'Read team-runner.cjs and propose the split.',
  };
  const text = renderHandoff(handoff);
  assert.match(text, /```handoff/);
  assert.match(text, /Goal: Split the runner/);
  assert.match(text, /- the runner owns 3 concerns/);

  const parsed = parseHandoff(text);
  assert.equal(parsed.goal, 'Split the runner');
  assert.equal(parsed.from, 'Luna1');
  assert.equal(parsed.to, 'Luna2');
  assert.deepEqual(parsed.findings, ['the runner owns 3 concerns']);
  assert.deepEqual(parsed.filesTouched, ['studio/agent/team-runner.cjs']);
  assert.equal(parsed.nextStep, 'Read team-runner.cjs and propose the split.');
});

test('parseHandoff recovers the prose form without a JSON fence', () => {
  const text = [
    'HANDOFF from Luna1 to Luna2',
    'Goal: Finish the syntax gate',
    'Findings',
    '- the gate skips non-js files',
    '- it is recursive',
    'Unresolved',
    '- should it check .mjs in dist?',
    'Next step: Add the .mjs exclusion and re-run.',
  ].join('\n');
  const parsed = parseHandoff(text);
  assert.equal(parsed.goal, 'Finish the syntax gate');
  assert.deepEqual(parsed.findings, ['the gate skips non-js files', 'it is recursive']);
  assert.deepEqual(parsed.unresolved, ['should it check .mjs in dist?']);
  assert.equal(parsed.nextStep, 'Add the .mjs exclusion and re-run.');
});

test('parseHandoff returns null for ordinary chat text', () => {
  assert.equal(parseHandoff('The suite is green, moving on.'), null);
  assert.equal(parseHandoff(''), null);
});

test('parseHandoff ignores a corrupted fence and falls back to prose', () => {
  const text = '```handoff\n{not json\n```\nGoal: Still recoverable\nNext step: Continue.';
  const parsed = parseHandoff(text);
  assert.ok(parsed, 'prose fallback must work after a bad fence');
  assert.equal(parsed.goal, 'Still recoverable');
});
