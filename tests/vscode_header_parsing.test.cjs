const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../vscode/extension.js'), 'utf8');

// Extract parseHeaderLines without loading the whole extension module (it
// requires 'vscode', which is only available inside the extension host).
const start = source.indexOf('function parseHeaderLines(');
const bodyStart = source.indexOf('{', start);
let depth = 0, i = bodyStart;
for (; i < source.length; i++) {
  if (source[i] === '{') depth++;
  else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
}
const fn = source.slice(start, i);
// Run the parser AND the expected-object literals in one realm so
// deepStrictEqual compares like with like (a vm object has a different
// prototype than one built in this file's realm).
const ctx = { assert };
vm.runInNewContext(fn + '\nthis.parseHeaderLines=parseHeaderLines;', ctx);
const parseHeaderLines = ctx.parseHeaderLines;
// check() evaluates the literal inside the parser's own realm.
function check(input, literal) {
  return vm.runInNewContext('assert.deepEqual(parseHeaderLines(' + JSON.stringify(input) + '),(' + literal + '))', ctx);
}

test('parses Name: value lines into an object', () => {
  check('X-Api-Key: secret\nX-Org: acme', "{'X-Api-Key':'secret','X-Org':'acme'}");
});

test('first colon separates name from value, so the value may contain colons', () => {
  check('Authorization: Bearer a:b:c', "{Authorization:'Bearer a:b:c'}");
  check('X-Url: https://example.com/v1', "{'X-Url':'https://example.com/v1'}");
});

test('trims surrounding whitespace around names and values', () => {
  check('  X-A  :   spaced   ', "{'X-A':'spaced'}");
});

test('blank lines and comments are ignored', () => {
  check('\n  \n# a comment\nX-Ok: yes\n', "{'X-Ok':'yes'}");
});

test('lines without a colon are ignored rather than throwing', () => {
  check('garbage\nX-Ok: yes', "{'X-Ok':'yes'}");
});

test('empty names or values are skipped', () => {
  check(': nope\nX-Empty:\nX-Ok: yes', "{'X-Ok':'yes'}");
});

test('a colon at position 0 yields no header', () => {
  check(':value', '{}');
});

test('blocked framing headers (content-length, host) are refused', () => {
  check('Content-Length: 5\nHost: evil\nhost: evil\nX-Ok: yes', "{'X-Ok':'yes'}");
});

test('header names with invalid characters are skipped', () => {
  check('Bad Name: x\nGood-Name_1: y', "{'Good-Name_1':'y'}");
});

test('accepts CRLF line endings', () => {
  check('X-A: 1\r\nX-B: 2', "{'X-A':'1','X-B':'2'}");
});

test('null / undefined / empty input yields an empty object', () => {
  check(null, '{}');
  check(undefined, '{}');
  check('', '{}');
});

test('a later duplicate name overrides the earlier one', () => {
  check('X-Dup: one\nX-Dup: two', "{'X-Dup':'two'}");
});

