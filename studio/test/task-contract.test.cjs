'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeContract, validateContract, renderContract, contractPromptBlock,
  budgetUsage, budgetStatusLine,
} = require('../agent/task-contract.cjs');

test('normalizeContract fills empty fields and caps lengths', () => {
  const c = normalizeContract({ goal: 'x'.repeat(5000), constraints: ['a', 'b', 'c'] });
  assert.equal(c.goal.length, 2000);
  assert.deepEqual(c.constraints, ['a', 'b', 'c']);
  assert.equal(c.budget.maxRounds, null);
  assert.equal(c.allowedPaths.length, 0);
});

test('normalizeContract coerces budget numbers and drops invalid ones', () => {
  const c = normalizeContract({ goal: 'g', budget: { maxRounds: 12.9, maxEdits: -3 } });
  assert.equal(c.budget.maxRounds, 12);
  assert.equal(c.budget.maxEdits, null);
});

test('normalizeContract survives non-object and array input', () => {
  assert.equal(normalizeContract(null).goal, '');
  assert.equal(normalizeContract(['goal']).goal, '');
  assert.equal(normalizeContract('goal').goal, '');
});

test('validateContract requires a goal and a definition of done', () => {
  const missing = validateContract({ constraints: ['be careful'] });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(' '), /goal/);
  assert.match(missing.errors.join(' '), /definition of done/i);

  const good = validateContract({ goal: 'Ship the fix', definitionOfDone: ['tests green'] });
  assert.equal(good.ok, true);
  assert.deepEqual(good.errors, []);
  assert.equal(good.contract.goal, 'Ship the fix');
});

test('renderContract shows every section and marks empty ones', () => {
  const text = renderContract({ goal: 'Fix login', definitionOfDone: ['login test passes'], budget: { maxRounds: 5 } });
  assert.match(text, /TASK CONTRACT/);
  assert.match(text, /Goal: Fix login/);
  assert.match(text, /- login test passes/);
  assert.match(text, /at most 5 rounds/);
  assert.match(text, /Allowed paths: \(none stated\)/);
});

test('contractPromptBlock is empty without a goal and carries the contract with one', () => {
  assert.equal(contractPromptBlock({}), '');
  const block = contractPromptBlock({ goal: 'Refactor the runner', definitionOfDone: ['npm test green'] });
  assert.match(block, /ACTIVE TASK CONTRACT/);
  assert.match(block, /Refactor the runner/);
  assert.match(block, /stop and ask first/);
});

test('budgetUsage reports per-dimension ratios and a nearing flag', () => {
  const usage = budgetUsage({ budget: { maxRounds: 10, maxEdits: 4 } }, { rounds: 9, edits: 1 });
  assert.equal(usage.rounds.ratio, 0.9);
  assert.equal(usage.nearing, true);
  assert.equal(budgetUsage({ budget: { maxRounds: 10 } }, { rounds: 1 }).nearing, false);
  // Unbounded dimensions are null and never trigger nearing.
  assert.equal(budgetUsage({}, { rounds: 99 }).rounds, null);
});

test('budgetStatusLine is silent while under the threshold', () => {
  assert.equal(budgetStatusLine({ budget: { maxRounds: 10 } }, { rounds: 3 }), '');
  const line = budgetStatusLine({ budget: { maxRounds: 10, maxEdits: 5 } }, { rounds: 8, edits: 4 });
  assert.match(line, /8\/10 rounds/);
  assert.match(line, /4\/5 edits/);
});
