'use strict';

/* The tray injects its page helpers as a template literal; an escaping slip
 * compiles locally but only breaks inside the page. That happened on
 * 2026-09-11: one `\\+` lost a backslash on the way through the template and
 * "show fewer|+ add" became "nothing to repeat" in the page, killing every
 * model switch. These tests compile the injected code exactly the way the
 * tray does, so the mistake fails here instead of in CodeGPT. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function injectedHelpers(wanted) {
  const src = fs.readFileSync(path.resolve(__dirname, '../copilot/tray/main.js'), 'utf8');
  const marker = 'const helpers = `';
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, 'missing helpers template in copilot/tray/main.js');
  const bodyStart = start + marker.length;
  let end = -1;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '`') { end = i; break; }
  }
  assert.notEqual(end, -1, 'missing closing backtick of the helpers template');
  const template = src.slice(bodyStart, end);
  // Same evaluation the tray performs: template literal with (wanted) injected.
  return eval('`' + template + '`');
}

test('the injected page helpers compile exactly as the tray runs them', () => {
  const helpers = injectedHelpers(['minimax m3', 'minimax-m3']);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(helpers + '\nexported = { press: typeof press, pressTrigger: typeof pressTrigger, '
    + 'dismissMenu: typeof dismissMenu, rows: typeof rows, expandAll: typeof expandAll, '
    + 'menuEl: typeof menuEl, trigger: typeof trigger, localApp: typeof localApp };', sandbox);
  // Spread into a plain host object: vm contexts have their own prototypes.
  assert.deepEqual({ ...sandbox.exported }, {
    press: 'function', pressTrigger: 'function', dismissMenu: 'function',
    rows: 'function', expandAll: 'function', menuEl: 'function', trigger: 'function', localApp: 'function',
  });
});

test('menu interaction goes through synthesized pointer events, not bare clicks', () => {
  const helpers = injectedHelpers(['x']);
  assert.match(helpers, /new PointerEvent\('pointerdown'/, 'pressTrigger must dispatch pointerdown');
  assert.match(helpers, /new PointerEvent\('pointerup'/, 'pressTrigger must dispatch pointerup');
  assert.match(helpers, /new MouseEvent\('click'/, 'press adds the click for menu rows/buttons');
  assert.equal(/\.click\(\)/.test(helpers), false, 'no bare el.click() left in the helpers');
});

test('row scans stay inside the menu for the local app', () => {
  const helpers = injectedHelpers(['x']);
  assert.match(helpers, /localApp\(\) \? null : document/, 'document-wide fallback must be hosted-app only');
  assert.match(helpers, /if \(!scope\) return \[\];/, 'no menu means no rows');
});
