'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  TOOLS,
  CORE_TOOLS,
  IDE_TOOLS,
  BROWSER_TOOLS,
  allowedNames,
  browserNames,
  namesByTier,
  toolHelp,
  needsApproval,
  budgetFor,
} = require('../vscode/tools');

const { applyPatch, replaceLines } = require('../vscode/edits');

test('tools registry exports all defined tools and categories', () => {
  const allowed = allowedNames();
  assert.ok(allowed.includes('read'));
  assert.ok(allowed.includes('search'));
  assert.ok(allowed.includes('list'));
  assert.ok(allowed.includes('shell'));
  assert.ok(allowed.includes('browse'));
  assert.ok(allowed.includes('websearch'));
  assert.ok(allowed.includes('browser_open'));
  assert.ok(allowed.includes('browser_click'));
  assert.ok(allowed.includes('browser_type'));
  assert.ok(allowed.includes('browser_snapshot'));
  assert.ok(allowed.includes('browser_console'));
  assert.ok(allowed.includes('browser_network'));

  assert.equal(needsApproval('shell'), true);
  assert.equal(needsApproval('runTask'), true);
  assert.equal(needsApproval('vscodeCommand'), true);
  assert.equal(needsApproval('read'), false);
  assert.equal(needsApproval('browse'), false);
  assert.equal(needsApproval('browser_click'), false);

  assert.equal(budgetFor('read'), 40000); // Infinity clamped to fallback
  assert.equal(budgetFor('browser_click'), 8000);
  assert.equal(budgetFor('browser_open'), 12000);
});

test('toolHelp outputs core help and conditionally browser help', () => {
  const coreHelp = toolHelp('core');
  assert.ok(coreHelp.includes('read'));
  assert.ok(coreHelp.includes('tool_help'));
  assert.ok(!coreHelp.includes('Browser tools (drive the shared REACH browser'));

  const browserHelp = toolHelp(['core', 'browser']);
  assert.ok(browserHelp.includes('Browser tools (drive the shared REACH browser'));
  assert.ok(browserHelp.includes('browser_open'));
  assert.ok(browserHelp.includes('browser_click'));
});

test('edits applyPatch supports multi-hunk search and replace', () => {
  const initial = 'line 1\nline 2\nline 3\nline 4\n';
  const hunks = [
    { search: 'line 2', replace: 'line two' },
    { search: 'line 4', replace: 'line four' },
  ];
  const patched = applyPatch(initial, hunks);
  assert.equal(patched, 'line 1\nline two\nline 3\nline four\n');
});

test('edits replaceLines replaces exact line ranges', () => {
  const initial = 'one\ntwo\nthree\nfour\n';
  const res = replaceLines(initial, 2, 3, 'NEW_TWO\nNEW_THREE');
  assert.equal(res, 'one\nNEW_TWO\nNEW_THREE\nfour\n');
});
