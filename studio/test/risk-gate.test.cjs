'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { riskLevel, gateRequired, riskLabel, LEVELS } = require('../agent/risk-gate.cjs');

test('the class maps to a risk level', () => {
  assert.equal(riskLevel({ class: 'read' }), 'low');
  assert.equal(riskLevel({ class: 'exec' }), 'high');
  assert.equal(riskLevel({ class: 'write' }), 'medium');
  assert.equal(riskLevel({ class: 'browse' }), 'medium');
});

test('an approval-required tool can never be low', () => {
  assert.equal(riskLevel({ class: 'read', approval: true }), 'medium');
});

test('an unknown or malformed tool fails closed to high', () => {
  assert.equal(riskLevel(null), 'high');
  assert.equal(riskLevel({}), 'high');
  assert.equal(riskLevel('nope'), 'high');
  assert.equal(riskLevel({ class: 'weird' }), 'high');
});

test('the gate only prompts for high-impact calls when enabled', () => {
  assert.equal(gateRequired('high', { riskGates: true }), true);
  assert.equal(gateRequired('medium', { riskGates: true }), false);
  assert.equal(gateRequired('low', { riskGates: true }), false);
  // Off by default: the gate never narrows behaviour unless opted in.
  assert.equal(gateRequired('high', { riskGates: false }), false);
  assert.equal(gateRequired('high', {}), false);
  assert.equal(gateRequired('high', null), false);
});

test('riskLabel names each level and ignores unknowns gracefully', () => {
  assert.match(riskLabel('low'), /low-impact/);
  assert.match(riskLabel('medium'), /moderate/);
  assert.match(riskLabel('high'), /high-impact/);
  assert.deepEqual(LEVELS, ['low', 'medium', 'high']);
});
