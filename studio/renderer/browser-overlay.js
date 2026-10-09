'use strict';

/* Reach Studio native-browser occlusion rules.
 *
 * The Browser drawer hosts a native `WebContentsView` (see browser/host.cjs),
 * which the compositor paints ABOVE the renderer's DOM. Any HTML surface that
 * floats over that region is therefore unreachable: the reported bug was the
 * account menu opening behind the page with no way to click it.
 *
 * The renderer hides the native view whenever one of these surfaces is up.
 * Deciding that is this module's whole job, so it is deliberately pure and
 * dual-loaded (browser + CommonJS): the renderer and its Node tests share one
 * predicate and cannot drift apart.
 *
 * The rule is deliberately blunt — an open surface wins, wherever it sits —
 * because that is the behaviour the browser smoke already asserts ("a native
 * page view must yield to Studio dialogs and menus"). Two traps to avoid:
 *
 *   1. Never key a modal selector on `aria-modal`. None of the Studio modals
 *      declare it, so matching it silently drops the model picker, persona,
 *      team and approval dialogs.
 *   2. Never add a "native picker" pass for `select`/`input[type=date]`. Their
 *      *popups* do outrank the native view, but a CLOSED control is ordinary
 *      DOM that paints below it, and no DOM signal distinguishes the two. A
 *      geometry guess on the control itself once blanked the browser pane for
 *      the status-bar telemetry `<select>` on every render.
 */

(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ReachBrowserOverlay = api;
})(function buildBrowserOverlay() {
  // Surfaces that block the page while open. Every Studio modal carries a
  // full-viewport scrim, so they block wherever they sit. `.modal` and
  // `.rf-modal` authorize differently: the former toggles the `.hidden` class,
  // the latter the `hidden` attribute.
  const MODAL_SELECTORS = Object.freeze([
    'dialog[open]',
    '.modal:not(.hidden)',
    '.rf-modal:not([hidden])',
  ]);

  // Surfaces that float over the page without blocking it. `.hidden` is the
  // Studio-wide "not open" marker, so `:not(.hidden)` is the authorization.
  const FLOATING_SELECTORS = Object.freeze([
    '.account-menu',
    '.team-chat-menu',
    '.project-run-menu',
    '.home-run-menu',
    '.settings-dropdown',
    '.sb-popover',
    '.composer-suggestions',
    '.msg-translate-pop',
  ]);

  const MODAL_SELECTOR = MODAL_SELECTORS.join(',');
  const FLOATING_SELECTOR = FLOATING_SELECTORS.map(selector => selector + ':not(.hidden)').join(',');
  const OVERLAY_SELECTOR = [MODAL_SELECTOR, FLOATING_SELECTOR].join(',');

  // `hidden` (the property) covers `hidden="until-found"` too, where the
  // attribute alone would read as open.
  function isOpen(element) {
    return !!element && element.hidden !== true;
  }

  // Is `element`, or any ancestor, marked hidden? Checked before the layout
  // test so a closed menu inside a hidden panel never keeps the view hidden.
  function isHiddenTree(element) {
    for (let node = element; node; node = node.parentElement) if (!isOpen(node)) return true;
    return false;
  }

  // An element with no layout still matches a selector: a `.project-run-menu`
  // parked inside a `display: none` page is "not hidden" by class yet paints
  // nothing. Require a real box before calling a surface on screen.
  function isRendered(element) {
    if (!isOpen(element) || isHiddenTree(element)) return false;
    if (typeof element.getClientRects === 'function') return element.getClientRects().length > 0;
    return true;
  }

  function matches(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    try { return [...root.querySelectorAll(selector)]; } catch { return []; }
  }

  function rendered(root, selector) {
    return matches(root, selector).filter(isRendered);
  }

  /* Is a page-blocking surface open? */
  function browserModalOpen(root) {
    return rendered(root, MODAL_SELECTOR).length > 0;
  }

  /* Is a floating Studio surface open? */
  function browserFloatingOpen(root) {
    return rendered(root, FLOATING_SELECTOR).length > 0;
  }

  /* True when the native view must be hidden. */
  function browserOverlayOpen(root) {
    return browserModalOpen(root) || browserFloatingOpen(root);
  }

  return Object.freeze({
    MODAL_SELECTORS,
    FLOATING_SELECTORS,
    MODAL_SELECTOR,
    FLOATING_SELECTOR,
    OVERLAY_SELECTOR,
    isOpen,
    isRendered,
    browserModalOpen,
    browserFloatingOpen,
    browserOverlayOpen,
  });
});