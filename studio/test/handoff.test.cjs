'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHandoff, renderHandoff, parseHandoff, FIELDS } = require('../agent/handoff.cjs');

const args = {
  from: 'Luna1', to: 'Luna2',
  goal: 'Map the ten capabilities to existing code',
  findings: 'pause/resume and crew journals already exist',
  evidence: 'read agent/pause-resume.cjs and agent/crew-journal.cjs',
  filesTouched: 'agent/handoff.cjs',
  unresolved: 'whether to gate high-risk tools by default',
  nextStep: 'Implement the risk gate in agent-tool-runner.cjs',
};

test('a handoff needs its goal and next step', () => {
  assert.throws(() => buildHandoff({ ...args, goal: '' }), /goal/);
  assert.throws(() => buildHandoff({ ...args, nextStep: '' }), /next step/);
  assert.throws(() => buildHandoff(null), /must be an object/);
});

test('optional sections may be empty', () => {
  const h = buildHandoff({ from: 'a', to: 'b', goal: 'G', nextStep: 'N' });
  assert.equal(h.findings, '');
  assert.equal(h.evidence, '');
  assert.equal(h.filesTouched, '');
  assert.equal(h.unresolved, '');
});

test('render → parse is a lossless round-trip', () => {
  const text = renderHandoff(buildHandoff(args));
  assert.match(text, /^HANDOFF — from Luna1 to Luna2/);
  const parsed = parseHandoff(text);
  assert.equal(parsed.structured, true);
  for (const field of FIELDS) assert.equal(parsed.handoff[field], buildHandoff(args)[field]);
});

test('parseHandoff passes unstructured text through', () => {
  assert.deepEqual(parseHandoff('I did the thing. All done.'), { structured: false });
  assert.equal(parseHandoff('').structured, false);
});

test('empty optional sections survive a Windows-newline round-trip', () => {
  const expected = buildHandoff({ from: 'a', to: 'b', goal: 'G', nextStep: 'N' });
  const result = parseHandoff(renderHandoff(expected).replace(/\n/g, '\r\n'));
  assert.equal(result.structured, true);
  assert.deepEqual(result.handoff, expected);
});

test('a partial match (header but no next step) is not structured', () => {
  const text = renderHandoff(buildHandoff(args));
  const partial = text.replace(/^Suggested next step: .+$/m, 'Suggested next step: ');
  assert.equal(parseHandoff(partial).structured, false);
});

test('a header-like line in prose is not a handoff', () => {
  assert.equal(parseHandoff('Note: HANDOFF — from a to b\nI also finished other work.').structured, false);
});

test('fields are capped at the documented length', () => {
  assert.throws(
    () => buildHandoff({ from: 'a', to: 'b', goal: 'a'.repeat(2001), nextStep: 'N' }),
    /too long/);
});
