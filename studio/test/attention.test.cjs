'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAttention } = require('../agent/attention.cjs');

test('background approvals notify, focus on click, coalesce bursts, and clear badges on resolution', () => {
  let focused = false, clock = 0, beeps = 0, badge = '', restored = false;
  const shown = [];
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on(_event, callback) { this.click = callback; }
    show() { shown.push(this); }
    close() { this.closed = true; }
  }
  const win = { isDestroyed: () => false, isFocused: () => focused, isMinimized: () => !restored,
    restore: () => { restored = true; }, show() {}, focus: () => { focused = true; } };
  const attention = createAttention({ Notification, app: { dock: { setBadge: value => { badge = value; } } },
    shell: { beep: () => { beeps++; } }, getWindow: () => win, now: () => clock });
  attention.request('one', 'approval');
  attention.request('one', 'approval');
  attention.request('two', 'edit');
  assert.equal(shown.length, 1);
  assert.equal(beeps, 1);
  assert.equal(badge, '2');
  shown[0].click();
  assert.ok(focused && restored);
  clock = 3000;
  attention.request('three', 'edit');
  assert.equal(shown.length, 1, 'foreground work does not interrupt the user');
  attention.resolve('one'); attention.resolve('two'); attention.resolve('three');
  assert.equal(badge, '');
  assert.equal(shown[0].closed, true);
});

test('unsupported notification platforms still beep and do not block review', () => {
  let beeps = 0;
  const attention = createAttention({ Notification: { isSupported: () => false }, app: {}, shell: { beep: () => beeps++ },
    getWindow: () => ({ isDestroyed: () => false, isFocused: () => false }) });
  attention.request('edit', 'edit');
  attention.resolve('edit');
  assert.equal(beeps, 1);
});
