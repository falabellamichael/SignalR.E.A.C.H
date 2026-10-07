'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toolHeadline } = require('../agent/agent-tool-runner.cjs');

test('tool headlines name the file, pattern, or command', () => {
  assert.equal(toolHeadline('read', { path: 'studio/renderer/app.js', startLine: 12, endLine: 40 }, {
    path: 'studio/renderer/app.js', startLine: 12, endLine: 40, totalLines: 400,
  }), 'renderer/app.js · L12–40 · 400 lines');
  assert.equal(toolHeadline('glob', { pattern: '**/*.js' }, {
    pattern: '**/*.js', matches: ['a.js', 'b.js'],
  }), '**/*.js · 2 files');
  assert.equal(toolHeadline('search', { pattern: 'toolHeadline' }, {
    matches: ['app.js:1: toolHeadline'],
  }), 'toolHeadline · 1 hit');
  assert.equal(toolHeadline('shell', { command: 'npm test' }, { exitCode: 0 }), 'npm test · exit 0');
  assert.equal(toolHeadline('list', { path: '' }, {}), '.');
});
