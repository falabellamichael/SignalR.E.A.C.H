'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPatch, replaceLines } = require('../vscode/edits');

test('applyPatch applies multi-hunk search and replace correctly', () => {
  const original = [
    'function alpha() {',
    '  console.log("old alpha");',
    '}',
    '',
    'function beta() {',
    '  console.log("old beta");',
    '}',
  ].join('\n');

  const hunks = [
    { search: '  console.log("old alpha");', replace: '  console.log("new alpha");' },
    { search: '  console.log("old beta");', replace: '  console.log("new beta");' },
  ];

  const result = applyPatch(original, hunks);
  assert.ok(result.includes('console.log("new alpha");'));
  assert.ok(result.includes('console.log("new beta");'));
  assert.ok(!result.includes('old alpha'));
  assert.ok(!result.includes('old beta'));
});

test('applyPatch preserves CRLF line endings', () => {
  const original = 'first line\r\nsecond line\r\nthird line\r\n';
  const hunks = [
    { search: 'second line', replace: 'modified line' },
  ];

  const result = applyPatch(original, hunks);
  assert.equal(result, 'first line\r\nmodified line\r\nthird line\r\n');
});

test('applyPatch throws when search pattern is not found', () => {
  const original = 'alpha\nbeta\ngamma\n';
  const hunks = [
    { search: 'delta', replace: 'epsilon' },
  ];

  assert.throws(() => {
    applyPatch(original, hunks);
  }, /(?:no longer matches|not found)/i);
});
