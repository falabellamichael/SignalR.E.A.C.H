'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('browser commands return actionable errors before registration and preserve successful replies', async () => {
  let bridge, failure = new Error("No handler registered for 'browser:command'");
  const result = { ok: true, tabs: [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    process: { platform: process.platform },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } },
      ipcRenderer: { sendSync: () => 'dark', on: () => {}, invoke: async () => { if (failure) throw failure; return result; } } }),
  });
  assert.match((await bridge.browser.command('state')).err, /Open a browser tab/);
  failure = new Error('Navigation refused');
  assert.equal((await bridge.browser.command('navigate')).err, 'Navigation refused');
  failure = null;
  assert.equal(await bridge.browser.command('state'), result);
});
