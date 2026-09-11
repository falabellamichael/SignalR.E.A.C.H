'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  assert.ok(allowed.includes('glob'));
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
  assert.ok(allowed.includes('browser_navigate'));
  assert.ok(allowed.includes('browser_find'));
  assert.ok(allowed.includes('browser_forward'));
  assert.ok(allowed.includes('browser_reload'));
  for (const name of ['browser_navigate', 'browser_find', 'browser_forward', 'browser_reload']) {
    assert.equal(TOOLS[name].class, 'browse', name + ' must be browse-class');
    assert.equal(TOOLS[name].approval, false, name + ' must not require approval');
    assert.equal(TOOLS[name].tier, 'browser');
  }

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

/* The registry only earns its keep if the executor and the client parser
 * actually agree with it. These two tests read the real source and fail on any
 * drift, which is the invariant tools.js was created to guarantee. */
const EXTENSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'extension.js'), 'utf8');
const CHAT_SRC = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'media', 'chat.js'), 'utf8');

test('every registered tool has an executor branch in extension.js', () => {
  // Literal branches: `action === 'name'`, excluding the browser_* family,
  // which is dispatched by a single startsWith() arm (asserted below).
  const literal = new Set(
    [...EXTENSION_SRC.matchAll(/action === '([a-zA-Z_]+)'/g)].map((m) => m[1]),
  );
  assert.ok(EXTENSION_SRC.includes("action.startsWith('browser_')"),
    'the browser_* executor arm is missing from extension.js');

  const missing = [];
  for (const name of allowedNames()) {
    if (name.startsWith('browser_')) continue;      // covered by startsWith arm
    if (IDE_TOOLS[name]) continue;                  // executed by agent-bridge.js
    if (!literal.has(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], 'registered tools with no executor branch: ' + missing.join(', '));
});

test('the client parser hardcoded fallback list matches the registry', () => {
  // chat.js keeps a fallback copy for the case where the host has not yet
  // injected REACH_TOOL_NAMES. It must not name a tool the registry lacks.
  const block = CHAT_SRC.match(/\[\s*'read',[\s\S]*?\];/);
  assert.ok(block, 'could not locate the fallback tool list in chat.js');
  const listed = [...block[0].matchAll(/'([a-zA-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(listed.length > 0, 'the fallback tool list parsed as empty');

  const allowed = new Set(allowedNames());
  const unknown = listed.filter((n) => !allowed.has(n));
  assert.deepEqual(unknown, [], 'parser accepts unregistered tools: ' + unknown.join(', '));
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
