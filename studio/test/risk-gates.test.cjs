'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyToolCall, needsApprovalForLevel, summarizeRisk, riskPromptBlock,
} = require('../agent/risk-gates.cjs');

test('read-only tools classify as low risk', () => {
  for (const tool of ['read', 'list', 'glob', 'search', 'code.search', 'code.context', 'todo_read', 'agent.status', 'agent.list', 'tool_help']) {
    const { level } = classifyToolCall({ tool, class: 'read' });
    assert.equal(level, 'low', `${tool} should be low risk`);
  }
});

test('destructive command patterns force high risk even for exec-class', () => {
  const { level, reasons } = classifyToolCall({ tool: 'shell', class: 'exec', args: { command: 'rm -rf /tmp/build' } });
  assert.equal(level, 'high');
  assert.deepEqual(reasons, ['destructive command pattern']);
});

test('non-destructive shell is still high (arbitrary execution)', () => {
  assert.equal(classifyToolCall({ tool: 'shell', class: 'exec', args: { command: 'npm test' } }).level, 'high');
});

test('write/patch edits are medium, broad-impact paths and bulk refactors are high', () => {
  assert.equal(classifyToolCall({ tool: 'write', class: 'write', args: { path: 'src/app.js' } }).level, 'medium');
  assert.equal(classifyToolCall({ tool: 'write', class: 'write', args: { path: '.git/config' } }).level, 'high');
  assert.equal(classifyToolCall({ tool: 'write', class: 'write', args: { path: 'node_modules/x/y.js' } }).level, 'high');
  assert.equal(classifyToolCall({ tool: 'edit_patch', class: 'write', args: { path: 'src/a.js' } }).level, 'medium');
  assert.equal(classifyToolCall({ tool: 'refactor.apply', class: 'write', args: {} }).level, 'high');
});

test('external tools are medium risk', () => {
  assert.equal(classifyToolCall({ tool: 'websearch', class: 'exec', args: { query: 'x' } }).level, 'medium');
  assert.equal(classifyToolCall({ tool: 'browse', class: 'exec', args: { url: 'https://x' } }).level, 'medium');
});

test('needsApprovalForLevel honours the policy threshold', () => {
  assert.equal(needsApprovalForLevel('low', { approveAt: 'high' }), false);
  assert.equal(needsApprovalForLevel('medium', { approveAt: 'high' }), false);
  assert.equal(needsApprovalForLevel('high', { approveAt: 'high' }), true);
  // Default is medium when no policy is given.
  assert.equal(needsApprovalForLevel('low'), false);
  assert.equal(needsApprovalForLevel('medium'), true);
  assert.equal(needsApprovalForLevel('low', { approveAt: 'low' }), true);
});

test('summariseRisk counts levels and approvals for a batch', () => {
  const calls = [
    { tool: 'read', class: 'read', args: { path: 'a.js' } },
    { tool: 'write', class: 'write', args: { path: 'a.js' } },
    { tool: 'shell', class: 'exec', args: { command: 'rm -rf dist' } },
  ];
  const summary = summarizeRisk(calls, { approveAt: 'medium' });
  assert.equal(summary.low, 1);
  assert.equal(summary.medium, 1);
  assert.equal(summary.high, 1);
  assert.equal(summary.approvals, 2);
  assert.equal(summary.highRisk.length, 1);
  assert.equal(summary.highRisk[0].tool, 'shell');
});

test('riskPromptBlock names the configured threshold', () => {
  assert.match(riskPromptBlock(), /"medium"/);
  assert.match(riskPromptBlock({ approveAt: 'high' }), /"high"/);
});
