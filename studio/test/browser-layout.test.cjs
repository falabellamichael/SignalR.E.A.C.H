'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the native layout method without starting Electron or a user profile.
const exportsModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../browser/host.cjs'), 'utf8'), {
  module: exportsModule,
  require: id => {
    if (id === 'electron' || id === './agent.cjs') return {};
    throw new Error(`Unexpected dependency: ${id}`);
  },
});
const { StudioBrowser } = exportsModule.exports;
function fixture(zoom, bounds, outer = { width: 1200, height: 800 }) {
  const view = {
    webContents: { getURL: () => 'https://example.com', getZoomFactor: () => 2 },
    setBounds: value => { view.bounds = { ...value }; },
    setVisible: value => { view.visible = value; },
  };
  const browser = Object.assign(Object.create(StudioBrowser.prototype), {
    win: { isDestroyed: () => false, getContentBounds: () => outer, webContents: { isDestroyed: () => false, getZoomFactor: () => zoom } },
    bounds, visible: true, active: 'page', tabs: new Map([['page', { id: 'page', view }]]),
  });
  return { browser, view };
}
for (const zoom of [0.75, 1.2 ** -0.5, 1, 1.25, 1.5, 2]) {
  test(`browser bounds convert host CSS coordinates at ${zoom} zoom`, () => {
    const b = { x: 105.25, y: 80.5, width: 360.5, height: 220.25 };
    const { browser, view } = fixture(zoom, b);
    browser.layout();
    assert.deepEqual(view.bounds, {
      x: Math.round(b.x * zoom), y: Math.round(b.y * zoom),
      width: Math.round((b.x + b.width) * zoom) - Math.round(b.x * zoom),
      height: Math.round((b.y + b.height) * zoom) - Math.round(b.y * zoom),
    });
    assert.equal(view.visible, true);
  });
}
test('scaled browser edges are clipped to the window, including negative origins', () => {
  const { browser, view } = fixture(1.25, { x: -80, y: -40, width: 240, height: 120 });
  browser.layout();
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 200, height: 100 });
  browser.bounds = { x: 900, y: 600, width: 400, height: 300 };
  browser.layout();
  assert.deepEqual(view.bounds, { x: 1125, y: 750, width: 75, height: 50 });
  browser.bounds = { x: 1000, y: 700, width: 400, height: 300 };
  browser.layout();
  assert.deepEqual(view.bounds, { x: 1200, y: 800, width: 0, height: 0 });
  assert.equal(view.visible, false);
});
test('zoom conversion preserves native view visibility gates', () => {
  const { browser, view } = fixture(0.9, { x: 10, y: 20, width: 300, height: 200 });
  for (const change of [() => { browser.visible = false; }, () => { browser.active = 'other'; }, () => { browser.tabs.get('page').error = 'failed'; }]) {
    browser.visible = true; browser.active = 'page'; browser.tabs.get('page').error = '';
    change(); browser.layout(); assert.equal(view.visible, false);
  }
});
