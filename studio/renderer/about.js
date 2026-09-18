'use strict';

/* Reach Studio — About page (PRD: "About REACH Studio (/about) - Application
 * version details, reachd daemon connection info, build status, and license").
 *
 * Relay management is out of scope, so instead of reachd daemon connection
 * info this reports the configured OpenAI-compatible endpoint and the Reach CLI
 * version Studio can find — the same connection facts, honestly labelled.
 */
(() => {
  const $ = sel => document.querySelector(sel);

  const els = { list: $('#ab-list'), build: $('#ab-build'), tagline: $('#ab-tagline') };
  let loaded = false;

  function row(dl, key, value) {
    if (!dl) return;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    dl.append(dt, dd);
  }

  function clear(dl) { if (dl) dl.textContent = ''; }

  async function sync() {
    if (!els.list) return;
    clear(els.list);
    clear(els.build);

    let info = null;
    try { info = await window.reach.about.info(); }
    catch (e) { row(els.list, 'App info', 'unavailable: ' + e.message); }

    if (info) {
      row(els.list, 'Version', info.version);
      row(els.list, 'Application', info.name);
      row(els.list, 'Platform', `${info.platform} ${info.arch}`);
      row(els.list, 'Electron', info.electron);
      row(els.list, 'Chromium', info.chromium);
      row(els.list, 'Node', info.node);
      row(els.list, 'V8', info.v8);
      row(els.build, 'Packaged', info.packaged ? 'yes (production build)' : 'no (running from source)');
      row(els.build, 'User data', info.userData);
    }

    // Connection facts, labelled as what they actually are.
    try {
      const s = await window.reach.getSettings();
      let host = 'not configured';
      try { host = s.endpoint ? new URL(s.endpoint).host : 'not configured'; }
      catch { host = (s.endpoint || '').slice(0, 48); }
      row(els.list, 'Endpoint', host);
      row(els.list, 'Default model', s.model || 'none');
      row(els.list, 'Access key', s.accessKey ? 'set (hidden)' : 'none');
    } catch { row(els.list, 'Endpoint', 'settings unavailable'); }

    // Reach CLI version, best effort: it may not be installed at all.
    try {
      const v = await window.reach.getVersion();
      row(els.build, 'Reach CLI', (v && (v.version || v.stdout || v.err)) || 'not found');
    } catch { row(els.build, 'Reach CLI', 'not found'); }

    if (!loaded) {
      loaded = true;
      if (els.tagline) els.tagline.textContent =
        'Desktop workspace for local AI agents, prompt engineering, and project telemetry.';
    }
  }

  window.ReachAbout = { sync };
})();
