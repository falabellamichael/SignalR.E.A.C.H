'use strict';

/*
 * Live check for "browser overlaps menu".
 *
 * Boots the REAL Studio renderer with the REAL browser-overlay.js, opens the
 * browser drawer and the real account menu, and reports the `visible` verdict
 * the renderer hands the native view. Run with Electron:
 *
 *   npx electron test/browser-overlay-ui.cjs
 *
 * Geometry is never mocked: if the real account menu does not reach the browser
 * pane, this reports that instead of passing.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-overlay-ui-'));
app.setPath('userData', dir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [], connections: [] }));

let win;
const errors = [];
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
const timeout = setTimeout(() => { console.error('Browser overlay UI timed out'); app.exit(1); }, 120000);

// The last layout payload the renderer computed for the native view.
async function lastLayout() {
  const raw = await run('typeof browserLastLayout === "string" ? browserLastLayout : ""');
  return raw ? JSON.parse(raw) : null;
}

(async () => {
  console.log('Overlay UI: loading isolated Studio');
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(50);
  // The layout pass coalesces through requestAnimationFrame, which Chromium
  // pauses for a hidden window. Show it or every verdict below reads stale.
  win.show();
  win.focus();
  await delay(200);

  // The module must be reachable in the renderer and expose the rule.
  assert.equal(await run('typeof window.ReachBrowserOverlay?.browserOverlayOpen'), 'function');
  assert.equal(await run('typeof window.ReachBrowserOverlay?.browserFloatingOpen'), 'function');

  await run("showTab('home'); selectDrawerPanel('browser', { focus: false })");
  await delay(500);
  const paneRect = await run(`(() => { const r = document.querySelector('#browser-viewport').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, onScreen: r.width > 0 && r.height > 0 }; })()`);
  console.log('pane', JSON.stringify(paneRect));
  assert.equal(paneRect.onScreen, true, 'the browser pane must be laid out for this check to mean anything');
  const baseline = await lastLayout();
  console.log('layout with no overlay', JSON.stringify(baseline));
  assert.equal(baseline?.visible, true, 'with no floating surface the native view must be visible');

  // rAF coalesces the observer; give it a couple of frames.
  await delay(120);
  const before = await lastLayout();
  assert.equal(before?.visible, true, 'the native view must stay visible while nothing floats over it');

  // Open the real account menu the way a user does.
  await run("document.querySelector('#account-menu-button').click()");
  await delay(160);
  const geometry = await run(`(() => {
    const menu = document.querySelector('#account-menu').getBoundingClientRect();
    const pane = document.querySelector('#browser-viewport').getBoundingClientRect();
    return {
      menu: { left: menu.left, top: menu.top, right: menu.right, bottom: menu.bottom },
      pane: { left: pane.left, top: pane.top, right: pane.right, bottom: pane.bottom },
      overlaps: menu.left < pane.right && menu.right > pane.left && menu.top < pane.bottom && menu.bottom > pane.top,
      floating: window.ReachBrowserOverlay.browserFloatingOpen(document),
      rule: window.ReachBrowserOverlay.browserOverlayOpen(document),
    };
  })()`);
  console.log('account menu', JSON.stringify(geometry.menu));
  console.log('browser pane', JSON.stringify(geometry.pane));
  console.log('overlap', geometry.overlaps, '· floating', geometry.floating, '· rule', geometry.rule);
  assert.equal(geometry.overlaps, true, 'the real account menu must actually cover the browser pane for this regression to be real');
  assert.equal(geometry.floating, true, 'the overlay rule must see the account menu as open');
  assert.equal(geometry.rule, true, 'the overlay rule must see the account menu as blocking');

  const blocked = await lastLayout();
  console.log('layout with account menu open', JSON.stringify(blocked));
  assert.equal(blocked?.visible, false, 'the native view must hide so the account menu is clickable');

  // Closing it must restore the page rather than leave the pane wedged hidden.
  await run("document.querySelector('#account-menu-close').click()");
  await delay(160);
  const restored = await lastLayout();
  console.log('layout after closing', JSON.stringify(restored));
  assert.equal(restored?.visible, true, 'closing the menu must bring the native view back');

  assert.deepEqual(errors, []);
  console.log('BROWSER OVERLAY UI PASS', dir);
  clearTimeout(timeout);
  app.exit(0);
})().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });