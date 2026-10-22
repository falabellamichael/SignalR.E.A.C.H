const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activityLine } = require('../agent/discord-activity.cjs');
test('Discord reports generation without inventing tool use and omits private reasoning', () => {
  assert.match(activityLine({ type: 'request-start' }), /Generating/);
  assert.equal(activityLine({ type: 'reasoning', text: 'private reasoning' }), 'Thinking through the request...');
  assert.match(activityLine({ type: 'jev-policy', severity: 'error' }), /flagged/);
  assert.match(activityLine({ type: 'tool-call', tool: 'shell', arguments: { command: 'python task.py' } }), /Python/);
  assert.equal(activityLine({ type: 'delta', text: 'private text' }), '');
});
