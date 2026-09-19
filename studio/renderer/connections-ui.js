// Connection pickers shared by the Prompt console and the Refactor workbench.
//
// Both pages need the same three things: a <select> listing every configured
// connection, a remembered choice, and a re-populate when Settings changes. With
// one endpoint this is trivial; with several it is the difference between the
// user knowing which provider they are about to spend tokens on and finding out
// from an error. Duplicating it in two files guarantees they drift.
//
// Loaded before playground.js and refactor.js (see index.html script order).
(function () {
  'use strict';

  /** Per-page state, keyed by a caller-chosen name. */
  const state = new Map();

  function labelFor(c) {
    // Name first: it is what the user typed to tell these apart. The host is the
    // fallback, and the model is appended so a picker row answers "will this run
    // the model I expect?" without opening Settings. Never include the key.
    const host = (() => {
      try { return new URL(String(c.endpoint || '')).host; } catch { return String(c.endpoint || '').slice(0, 32); }
    })();
    const base = String(c.name || '').trim() || host || 'Connection';
    return c.model ? `${base} · ${c.model}` : base;
  }

  /**
   * Bind a <select> to the connection list.
   *
   * @param {string} key    State key for this page ('playground', 'refactor').
   * @param {HTMLSelectElement|null} select
   * @param {{onChange?: function(string):void}} [options]
   */
  function bind(key, select, options = {}) {
    const entry = { select, connectionId: '', connections: [], onChange: options.onChange || null };
    state.set(key, entry);
    if (!select) return entry;
    select.addEventListener('change', () => {
      entry.connectionId = select.value || '';
      if (entry.onChange) entry.onChange(entry.connectionId);
    });
    return entry;
  }

  /**
   * (Re)populate a bound select from the current settings.
   *
   * Preserves the user's choice when that connection still exists, and falls
   * back to the ACTIVE connection otherwise — the alternative (keeping a deleted
   * id selected) would silently route requests somewhere the user cannot see.
   *
   * @returns {string} the connection id now selected ('' when none exist)
   */
  async function refresh(key) {
    const entry = state.get(key);
    if (!entry || !entry.select) return '';
    let data;
    try { data = await window.reach.connections.list(); } catch { return entry.connectionId || ''; }
    const list = Array.isArray(data.connections) ? data.connections : [];
    entry.connections = list;

    const previous = entry.connectionId;
    const stillExists = previous && list.some(c => c.id === previous);
    const chosen = stillExists ? previous : (data.activeConnection || (list[0] ? list[0].id : ''));

    entry.select.replaceChildren();
    for (const c of list) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = labelFor(c) + (c.id === data.activeConnection ? '  (default)' : '');
      entry.select.appendChild(opt);
    }
    entry.connectionId = list.length ? chosen : '';
    entry.select.value = entry.connectionId;
    // With one connection there is nothing to choose, so hide the control rather
    // than show a dropdown that cannot do anything.
    entry.select.disabled = list.length < 2;
    entry.select.title = list.length
      ? (entry.select.disabled ? 'Only one connection configured — add more in Settings' : 'Which endpoint this page uses')
      : 'No connections configured — add one in Settings';
    return entry.connectionId;
  }

  /** The connection id this page should send with its requests. */
  function connectionId(key) {
    const entry = state.get(key);
    return entry ? (entry.connectionId || '') : '';
  }

  /** The connection record currently selected, or null. */
  function current(key) {
    const entry = state.get(key);
    if (!entry) return null;
    return entry.connections.find(c => c.id === entry.connectionId) || null;
  }

  /** Display name of the selected connection, for "models from X" captions. */
  function currentLabel(key) {
    const c = current(key);
    if (!c) return '';
    const host = (() => { try { return new URL(String(c.endpoint || '')).host; } catch { return ''; } })();
    return String(c.name || '').trim() || host || 'the selected connection';
  }

  window.ReachConnections = { bind, refresh, connectionId, current, currentLabel, labelFor };
})();
