'use strict';

// The Browser drawer hosts a native Electron WebContentsView, which is
// composited above the renderer's DOM. This suite pins the rule that decides
// when that view must be hidden so a floating Studio surface stays reachable,
// plus the wiring that makes the layout pass consult it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const overlay = require('../renderer/browser-overlay.js');
const {
  FLOATING_SELECTORS, MODAL_SELECTORS, FLOATING_SELECTOR, MODAL_SELECTOR,
  isOpen, isRendered, browserOverlayOpen, browserModalOpen, browserFloatingOpen,
} = overlay;

const readRenderer = () => fs.readFileSync(path.join(__dirname, '../renderer/browser.js'), 'utf8');
const readModule = () => fs.readFileSync(path.join(__dirname, '../renderer/browser-overlay.js'), 'utf8');

function element({ hidden = false, painted = true, parentElement = null } = {}) {
  return {
    hidden,
    parentElement,
    getClientRects: () => (painted ? [{}] : []),
  };
}

// A root keyed by the exact selectors the module builds, so the stub never
// re-implements CSS matching.
function root({ floating = [], modal = [] } = {}) {
  return { querySelectorAll: selector => ({ [FLOATING_SELECTOR]: floating, [MODAL_SELECTOR]: modal })[selector] || [] };
}

test('the surface lists cover every overlay that can sit above the browser pane', () => {
  // The reported bug: the account menu was missing from the guard entirely.
  assert.ok(FLOATING_SELECTORS.includes('.account-menu'));
  for (const selector of ['.team-chat-menu', '.project-run-menu', '.home-run-menu', '.settings-dropdown', '.sb-popover', '.composer-suggestions']) {
    assert.ok(FLOATING_SELECTORS.includes(selector), `${selector} must be guarded`);
  }
  // None of the Studio modals declare aria-modal, so matching on that
  // attribute would drop the model picker, persona, team and approval dialogs.
  assert.deepEqual(MODAL_SELECTORS, ['dialog[open]', '.modal:not(.hidden)', '.rf-modal:not([hidden])']);
});

test('every modal in the markup is covered by the modal selectors', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  // `id` and `class` appear in both orders across this file, so collect from
  // either and key the result by id.
  const attribute = /(id|class)="([^"]+)"/g;
  const tags = [...html.matchAll(/<(?:div|section)([^>]*)>/g)].map(match => match[1]);
  const found = new Map();
  for (const tag of tags) {
    const attrs = {};
    for (const match of tag.matchAll(attribute)) attrs[match[1]] = match[2];
    if (attrs.id && attrs.class && /(?:^|\s)(?:rf-)?modal(?:\s|$)/.test(attrs.class)) found.set(attrs.id, attrs.class);
  }
  // Sanity: the real surfaces this rule exists to protect.
  for (const id of ['modal', 'approval-modal', 'persona-modal', 'team-modal', 'team-run-modal', 'model-modal', 'rf-modal']) {
    assert.ok(found.has(id), `${id} must be a modal in index.html`);
  }
  // And a matching selector: `.modal` closes via `.hidden`, `.rf-modal` via `hidden`.
  for (const [id, classes] of found) {
    const covered = classes.split(/\s+/).includes('modal') || classes.split(/\s+/).includes('rf-modal');
    assert.ok(covered, `${id} (class="${classes}") must match a MODAL_SELECTORS entry`);
  }
});

test('an open Translate popover stays reachable above the native browser', () => {
  const popover = element();
  const document = {
    querySelectorAll: selector => selector.split(',').includes('.msg-translate-pop:not(.hidden)') ? [popover] : [],
  };
  assert.equal(browserFloatingOpen(document), true);
  assert.equal(browserOverlayOpen(document), true);
  popover.hidden = true;
  assert.equal(browserOverlayOpen(document), false, 'A closed popover restores the native view');
});

test('an open account menu hides the native view', () => {
  assert.equal(browserOverlayOpen(root({ floating: [element()] })), true);
});

test('any open floating surface hides the view, wherever it sits', () => {
  // Deliberately blunt, and deliberately not geometric: the browser smoke
  // asserts that a native page view yields to Studio menus, and the drawer
  // menu is a `.settings-dropdown` that sits above the drawer it belongs to.
  // A geometry-only rule missed it (measured no overlap while open) and failed
  // the smoke, so an open surface wins.
  assert.equal(browserFloatingOpen(root({ floating: [element()] })), true);
  assert.equal(browserOverlayOpen(root({ floating: [element(), element()] })), true);
});

test('a modal is page-blocking', () => {
  assert.equal(browserModalOpen(root({ modal: [element()] })), true);
  assert.equal(browserOverlayOpen(root({ modal: [element()] })), true);
});

test('closed, hidden and unpainted surfaces never hide the view', () => {
  assert.equal(browserOverlayOpen(root()), false, 'no surfaces at all');
  // `hidden` covers hidden="until-found", where the attribute alone reads open.
  assert.equal(browserOverlayOpen(root({ floating: [element({ hidden: true })] })), false);
  assert.equal(browserOverlayOpen(root({ modal: [element({ hidden: true })] })), false);
  // A menu parked inside a hidden panel matches `:not(.hidden)` yet paints nothing.
  const hiddenPanel = element({ hidden: true });
  assert.equal(browserOverlayOpen(root({ floating: [element({ parentElement: hiddenPanel })] })), false);
  // display: none still matches the selector, so an empty rect list must veto it.
  assert.equal(browserOverlayOpen(root({ floating: [element({ painted: false })] })), false);
  assert.equal(isOpen(element()), true);
  assert.equal(isOpen(element({ hidden: true })), false);
  assert.equal(isRendered(element({ painted: false })), false);
  assert.equal(isRendered(element({ parentElement: hiddenPanel })), false);
});

test('there is no native-picker pass', () => {
  // A plain `select` paints below the native view; only its popup outranks it,
  // and no DOM signal reports that. Blanking the pane for any overlapping
  // control broke the browser smoke (the status-bar telemetry select), and
  // guessing "focused means open" latched the pane hidden for a stray focus.
  assert.equal(typeof overlay.browserNativePickerOpen, 'undefined');
  assert.doesNotMatch(readModule(), /browserNativePickerOpen|NATIVE_CONTROL_SELECTOR|input\[type="date"\]/);
  assert.doesNotMatch(readRenderer(), /isBrowserPickerOpen|browserNativePickerOpen/);
});

test('the layout pass consults these rules before it reaches the host', () => {
  const browser = readRenderer();
  assert.match(browser, /isBrowserOverlayOpen\(\)/, 'browser.js must consult the overlay rule');
  assert.match(browser, /window\.ReachBrowserOverlay/, 'browser.js must consume the shared module');
  // The module takes the document as its root. Passing a rect instead would
  // hand the object to `root.querySelectorAll` and silently report nothing open.
  assert.match(browser, /browserOverlayOpen\(document\)/, 'the module must be called with the document');
  // `hidden` must invalidate the pass, or opening a panel around a menu would
  // not recompute occlusion.
  assert.match(browser, /attributeFilter: \[[^\]]*'hidden'/);

  // The module must be on disk and loaded before its consumer.
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const module = html.indexOf('browser-overlay.js');
  const consumer = html.indexOf('src="browser.js"');
  assert.notEqual(module, -1, 'index.html must load browser-overlay.js');
  assert.notEqual(consumer, -1, 'index.html must load browser.js');
  assert.ok(module < consumer, 'browser-overlay.js must load before browser.js');
});

test('no overlay lookup ignores the account menu', () => {
  // The defect this suite exists to prevent: the previous guard listed only
  // `dialog[open]`, `.modal` and `.settings-dropdown`, so the account menu was
  // never considered and stayed stranded behind the page. Every overlay lookup
  // in the file must consider it, module path or inline fallback.
  const lookups = [...readRenderer().matchAll(/querySelector\('([^']*dialog\[open\][^']*)'\)/g)].map(match => match[1]);
  assert.ok(lookups.length > 0, 'browser.js must keep an overlay lookup as a fallback');
  for (const lookup of lookups) {
    assert.match(lookup, /\.account-menu/, `overlay lookup must include .account-menu: ${lookup}`);
  }
});