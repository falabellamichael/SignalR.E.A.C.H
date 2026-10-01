'use strict';

/* Provider pages pick the URLs their window.open calls hand the tray. Only
 * http(s) may reach shell.openExternal: a file:, smb: or ms-* URL there runs
 * an OS protocol handler on the user's machine. main.js needs Electron, so the
 * helper is compiled from source with a stand-in shell, the way the other tray
 * tests read main.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.resolve(__dirname, '../copilot/tray/main.js'), 'utf8');

function functionSource(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing ' + name + ' in copilot/tray/main.js');
  const end = SRC.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'unterminated ' + name);
  return SRC.slice(start, end + 2);
}

function loadHelper() {
  const opened = [];
  const sandbox = {
    URL,
    shell: { openExternal: (url) => { opened.push(url); return Promise.resolve(); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(functionSource('openExternalWeb') + '\nexported = openExternalWeb;', sandbox);
  return { openExternalWeb: sandbox.exported, opened };
}

test('web links are opened in the real browser', () => {
  const { openExternalWeb, opened } = loadHelper();
  assert.equal(openExternalWeb('https://learn.microsoft.com/terms'), true);
  assert.equal(openExternalWeb('HTTP://example.com/docs'), true);
  assert.deepEqual(opened, ['https://learn.microsoft.com/terms', 'http://example.com/docs']);
});

test('non-web schemes and junk never reach shell.openExternal', () => {
  const { openExternalWeb, opened } = loadHelper();
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'smb://attacker.example/share',
    'ms-msdt:/id PCWDiagnostic', 'javascript:alert(1)', 'data:text/html,hi',
    'vscode://file/etc/passwd', '  file:///etc/passwd', 'not a url', '', null, undefined]) {
    assert.equal(openExternalWeb(url), false, String(url));
  }
  assert.deepEqual(opened, []);
});

test('a rejected openExternal promise is swallowed', async () => {
  const sandbox = { URL, shell: { openExternal: () => Promise.reject(new Error('no handler')) } };
  vm.createContext(sandbox);
  vm.runInContext(functionSource('openExternalWeb') + '\nexported = openExternalWeb;', sandbox);
  assert.equal(sandbox.exported('https://example.com'), true);
  await new Promise((resolve) => setImmediate(resolve));
});

test('every window-open handler and the IPC route go through the helper', () => {
  const handlers = SRC.match(/(\w+)\.webContents\.setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?\n    \}\);/g) || [];
  const names = handlers.map((block) => block.split('.')[0]);
  for (const win of ['browserWin', 'chatgptWin', 'codegptWin']) {
    assert.ok(names.includes(win), win + ' window-open handler not found');
  }
  for (const block of handlers) {
    assert.match(block, /openExternalWeb\(url\)/);
    assert.doesNotMatch(block, /shell\.openExternal/);
  }
  assert.match(SRC, /listen\('open-external', \(_e, url\) => \{ openExternalWeb\(url\); \}\);/);
  // The helper is the only caller left in main.js.
  assert.equal((SRC.match(/shell\.openExternal\(/g) || []).length, 1);
});
