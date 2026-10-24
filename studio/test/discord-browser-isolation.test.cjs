const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('Discord browser has separate cookies, tabs, IPC and no Studio focus changes', () => {
  const handlers = [], sessions = [], attached = [], sent = [];
  class View {
    constructor(options) { this.options = options; this.webContents = { on() {}, setWindowOpenHandler() {}, isDestroyed: () => false,
      close() {}, getTitle: () => '', getURL: () => '', isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false } }; }
    setBounds() {}
  }
  const electron = { WebContentsView: View, session: { fromPartition(name) { sessions.push(name); return { name, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }; } },
    ipcMain: { handle(name) { handlers.push(name); } }, Menu: {}, shell: {} };
  const context = { module: { exports: {} }, require: name => name === 'electron' ? electron : require('../browser/agent.cjs'), URL };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../browser/host.cjs'), 'utf8'), context);
  const { StudioBrowser } = context.module.exports;
  const win = { webContents: { once() {}, send(...args) { sent.push(args); } }, contentView: { addChildView(view) { attached.push(view); } } };
  const normal = new StudioBrowser(win);
  const discord = new StudioBrowser(win, { partition: 'persist:reach-discord-browser', background: true });
  const tab = discord.newTab(); discord.emit();
  assert.deepEqual(sessions, ['persist:reach-browser', 'persist:reach-discord-browser']);
  assert.deepEqual(handlers, ['browser:command']);
  assert.equal(attached.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(normal.tabs.size, 0);
  assert.equal(tab.view.options.webPreferences.session.name, 'persist:reach-discord-browser');
});
