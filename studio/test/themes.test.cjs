'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { themes, paint } = require('../renderer/theme-data.js');

test('ten themes keep Reach light and dark plus the Tokyo Night set', () => {
  assert.deepEqual(themes.map(theme => theme.id), [
    'dark', 'light', 'tokyo-night', 'tokyo-storm', 'tokyo-day',
    'nord', 'catppuccin', 'rose-pine', 'gruvbox', 'solarized',
  ]);
  assert.equal(paint('light').vars.bg, '#fdf6e3');
  assert.equal(paint('light').vars.gold, '#946b12');
  assert.equal(paint('dark').vars.bg, '#0a0a0a');
  assert.equal(paint('dark').vars.gold, '#b6f04a');
  assert.equal(paint('tokyo-night').vars.bg, '#1a1b26');
  assert.equal(paint('tokyo-night').vars.gold, '#7aa2f7');
  assert.equal(paint('tokyo-storm').vars.bg, '#24283b');
  assert.equal(paint('tokyo-day').scheme, 'light');
  assert.equal(paint('tokyo-day').vars.bg, '#e6e7ed');
  assert.equal(paint('nope').theme, 'dark');
  assert.equal(paint('dark').tint, 0);
  assert.equal(paint('dark').vars.panel, '#111111');
});

test('accent recolors gold and tint washes panels without replacing the page background', () => {
  const tinted = paint({ theme: 'dark', accent: '#ff00aa', tint: 100 });
  assert.equal(tinted.vars.gold, '#ff00aa');
  assert.equal(tinted.vars.bg, '#0a0a0a');
  assert.notEqual(tinted.vars.panel, '#111111');
  assert.notEqual(tinted.vars.line, '#2c3328');
  const plain = paint({ theme: 'nord', tint: 0 });
  assert.equal(plain.vars.panel, '#3b4252');
  assert.equal(plain.accent, '');
});
