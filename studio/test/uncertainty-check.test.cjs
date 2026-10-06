'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUncertainty, chooseCheck, uncertaintyPromptBlock, uncertaintyPrompt,
  CHECK_COST,
} = require('../agent/uncertainty-check.cjs');

test('normalizeUncertainty caps the assumption and normalises stakes', () => {
  const u = normalizeUncertainty({ assumption: 'x'.repeat(2000), stakes: 'HIGH', candidates: [] });
  assert.equal(u.assumption.length, 600);
  assert.equal(u.stakes, 'high');
  const def = normalizeUncertainty({ assumption: 'a' });
  assert.equal(def.stakes, 'medium', 'unknown stakes default to medium');
});

test('normalizeUncertainty drops candidates with unknown kinds or no target', () => {
  const u = normalizeUncertainty({
    assumption: 'a',
    candidates: [
      { kind: 'read_file', target: 'src/app.js', why: 'the source answers it' },
      { kind: 'teleport', target: 'x', why: 'nope' },
      { kind: 'search', why: 'missing target' },
    ],
  });
  assert.equal(u.candidates.length, 1);
  assert.equal(u.candidates[0].kind, 'read_file');
});

test('chooseCheck fails without an assumption', () => {
  assert.equal(chooseCheck({ candidates: [{ kind: 'read_file', target: 'a' }] }).ok, false);
});

test('chooseCheck picks the cheapest eligible candidate', () => {
  const u = {
    assumption: 'the endpoint normalizes trailing slashes',
    candidates: [
      { kind: 'targeted_test', target: 'test/endpoint.test.cjs', why: 'proves it' },
      { kind: 'read_file', target: 'agent/endpoint.cjs', why: 'the code answers it' },
      { kind: 'search', target: 'normalize', why: 'fast grep' },
    ],
  };
  const chosen = chooseCheck(u);
  assert.equal(chosen.ok, true);
  assert.equal(chosen.check.kind, 'read_file', 'read (cost 1) beats search (2) and test (3)');
  assert.equal(chosen.ranked.length, 3);
  assert.deepEqual(chosen.ranked.map(c => c.kind), ['read_file', 'search', 'targeted_test']);
});

test('equal-cost checks keep the model\'s stated preference (order)', () => {
  const u = {
    assumption: 'a',
    candidates: [
      { kind: 'search', target: 'A', why: 'preferred' },
      { kind: 'search', target: 'B', why: 'fallback' },
    ],
  };
  assert.equal(chooseCheck(u).check.target, 'A');
});

test('with no candidates the cheapest safe default is to read the source', () => {
  const chosen = chooseCheck({ assumption: 'the flag exists in settings' });
  assert.equal(chosen.ok, true);
  assert.equal(chosen.check.kind, 'read_file');
});

test('uncertaintyPromptBlock names the assumption, the stakes, and the chosen check', () => {
  const u = { assumption: 'the store is atomic', stakes: 'high', candidates: [{ kind: 'read_file', target: 'agent/atomic-write.cjs', why: 'it lives there' }] };
  const chosen = chooseCheck(u);
  const block = uncertaintyPromptBlock(u, chosen);
  assert.match(block, /UNCERTAINTY CHECK/);
  assert.match(block, /the store is atomic/);
  assert.match(block, /high impact/);
  assert.match(block, /agent\/atomic-write\.cjs/);
  assert.match(block, /before acting/);
});

test('the generic nudge makes the model volunteer uncertainty', () => {
  assert.match(uncertaintyPrompt(), /do not guess/);
  assert.match(uncertaintyPrompt(), /cheapest low-risk check/);
});

test('CHECK_COST orders the check kinds from safest to riskiest', () => {
  assert.ok(CHECK_COST.read_file < CHECK_COST.search);
  assert.ok(CHECK_COST.search < CHECK_COST.targeted_test);
  assert.ok(CHECK_COST.targeted_test < CHECK_COST.shell_probe);
});
