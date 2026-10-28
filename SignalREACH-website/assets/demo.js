/* This page mounts only the live workspace, without landing-page effects. */
(() => {
  'use strict';
  const unmount = globalThis.SignalREACHWorkspaceUI.mount();
  window.addEventListener('pagehide', event => { if (!event.persisted) unmount(); });
})();
