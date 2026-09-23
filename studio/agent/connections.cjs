'use strict';

/* Reach Studio — multiple endpoint connections.
 *
 * PRD parity with the REACH VS Code extension: the user can register several
 * endpoints, each with its own access key and default model, and pick which one
 * is active. Every agent conversation, the prompt playground, the refactor
 * workbench and the endpoint ping then run against the ACTIVE connection.
 *
 * Why this lives in its own module rather than in main.mjs: main.mjs cannot be
 * require()d from a node test ("The requested module 'electron' does not provide
 * an export named 'BrowserWindow'"), so logic placed there is untestable. Two
 * real bugs shipped this branch because a capability existed but production
 * never wired it, and neither could be caught by a test. Connection resolution
 * and migration are exactly the kind of thing that must be unit-testable.
 *
 * Shape stored in settings.json:
 *
 *   connections:     [{ id, name, endpoint, accessKey, model }, ...]
 *   activeConnection: '<id>'
 *
 * The legacy single-endpoint fields (`endpoint`, `accessKey`, `model`) are kept
 * as a PROJECTION of the active connection so existing code paths, saved
 * settings files and smoke assertions keep working. `connections` is the single
 * source of truth; the legacy fields are rewritten on every save to match.
 *
 * Identity is a stable `id`, NOT the endpoint URL. Keying access keys by URL —
 * which is what the VS Code extension does — means renaming an endpoint orphans
 * its key; its own source comments call that out as a hazard. An id survives a
 * rename, so the key stays with the connection the user meant.
 */

const crypto = require('node:crypto');
const { normalizeCapabilities } = require('./provider-capabilities.cjs');

/** Hard cap: a connection list is a handful of providers, not a data store. */
const MAX_CONNECTIONS = 20;
const MAX_NAME_CHARS = 60;
const MAX_ENDPOINT_CHARS = 2048;
const MAX_KEY_CHARS = 4096;
const MAX_MODEL_CHARS = 200;

const DEFAULT_NAME = 'Connection';

function newId() {
  return 'conn_' + crypto.randomBytes(6).toString('hex');
}

/**
 * A DETERMINISTIC id for a connection that has no usable stored id.
 *
 * Deriving it from the endpoint is what makes migration stable: normalizing the
 * same legacy settings object twice must yield the same id, otherwise
 * activeConnection() and findConnection() disagree with each other, the ids the
 * UI holds go stale between reads, and "activate by id" cannot work at all.
 *
 * Once settings.json is saved, the stored id wins and this is never consulted
 * again — so renaming an endpoint later keeps the connection's identity.
 */
function derivedId(endpoint) {
  const hash = crypto.createHash('sha256').update(normalizeEndpoint(endpoint), 'utf8').digest('hex');
  return 'conn_' + hash.slice(0, 12);
}

function clip(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Strip trailing slashes so two spellings of one endpoint compare equal.
 * Deliberately does NOT rewrite the path: resolveEndpoint() owns pointer
 * following and /v1 normalisation, and doing it twice invites drift.
 */
function normalizeEndpoint(value) {
  return clip(value, MAX_ENDPOINT_CHARS).trim().replace(/\/+$/, '');
}

/**
 * A display name for a connection. Falls back to the endpoint's hostname, which
 * is far more legible in a dropdown than a raw URL (the published pointer URL is
 * a long gist link). Returns '' when there is nothing to derive from.
 */
function defaultName(endpoint) {
  const text = normalizeEndpoint(endpoint);
  if (!text) return '';
  try {
    const host = new URL(text).hostname;
    return host ? clip(host, MAX_NAME_CHARS) : '';
  } catch {
    // Not a parseable URL yet (half-typed row). Use the raw text so the list
    // still shows something identifiable instead of an empty name.
    return clip(text, MAX_NAME_CHARS);
  }
}

/**
 * Coerce one stored connection into a well-formed record, or null if it carries
 * nothing usable. Never throws: settings.json is user-editable and may be
 * truncated or hand-modified, and a bad entry must not stop the app from
 * starting or make every other connection unreachable.
 */
function sanitizeConnection(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const endpoint = normalizeEndpoint(raw.endpoint);
  const accessKey = clip(raw.accessKey, MAX_KEY_CHARS);
  const model = clip(raw.model, MAX_MODEL_CHARS).trim();
  // A connection with no endpoint cannot be used for anything, so drop it rather
  // than render an empty row the user has to delete.
  if (!endpoint) return null;
  const name = clip(raw.name, MAX_NAME_CHARS).trim() || defaultName(endpoint) || `${DEFAULT_NAME} ${index + 1}`;
  // A stored id wins; otherwise derive one from the endpoint so re-normalizing
  // the same object is stable (see derivedId).
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : derivedId(endpoint);
  // `enabled` membership in the team pool. Absent means enabled: connections
  // written before the pool existed must keep working, and a hand-edited file
  // that omits the field should not silently drop itself out of every team.
  const enabled = raw.enabled === false ? false : true;
  const capabilities = normalizeCapabilities(raw.capabilities);
  return { id, name, endpoint, accessKey, model, enabled,
    ...(capabilities.length ? { capabilities } : {}) };
}

/**
 * Build the legacy single-endpoint projection from the active connection.
 *
 * These fields are what the rest of main.mjs has always read, what existing
 * settings.json files contain, and what the smoke suite asserts on, so they must
 * keep meaning "the connection in use".
 */
function legacyProjection(connection) {
  return {
    endpoint: connection ? connection.endpoint : '',
    accessKey: connection ? connection.accessKey : '',
    model: connection ? connection.model : '',
  };
}

/**
 * Normalize a settings object into the connections shape.
 *
 * Pure and idempotent: returns a NEW object, never mutates its argument, and
 * normalize(normalize(s)) deep-equals normalize(s). Idempotence matters because
 * saveSettings() normalizes on every write — a non-idempotent function would
 * churn ids or reorder the list on each save.
 *
 * Migration: a settings file written before this feature has `endpoint`,
 * `accessKey` and `model` but no `connections`. Those become the first
 * connection so nobody loses their configured provider on upgrade.
 *
 * @param {object} [settings] Raw settings (may be null, {} or hand-edited).
 * @returns {{settings: object, migrated: boolean, dropped: number}}
 *   `migrated` is true when legacy fields were converted, `dropped` counts
 *   entries discarded as unusable (for diagnostics, never for control flow).
 */
function normalizeSettings(settings) {
  const src = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const out = { ...src };

  const rawList = Array.isArray(src.connections) ? src.connections : [];
  const seen = new Set();
  const connections = [];
  let dropped = 0;

  for (let i = 0; i < rawList.length && connections.length < MAX_CONNECTIONS; i++) {
    const entry = sanitizeConnection(rawList[i], i);
    if (!entry) { dropped++; continue; }
    // A duplicated id (hand-edited file, a settings copy, or two entries for the
    // same endpoint) would make "activate by id" ambiguous. Keep the first and
    // re-key the rest DETERMINISTICALLY — a random replacement would reintroduce
    // the churn this whole scheme exists to prevent, and would break the
    // normalize(normalize(s)) === normalize(s) idempotence the tests assert.
    if (seen.has(entry.id)) {
      let suffix = 2;
      entry.id = `${entry.id}-${suffix}`;
      while (seen.has(entry.id)) entry.id = `${derivedId(entry.endpoint)}-${++suffix}`;
    }
    seen.add(entry.id);
    connections.push(entry);
  }

  let migrated = false;

  if (!connections.length) {
    // Nothing usable in `connections`: fall back to the legacy fields.
    const legacy = sanitizeConnection({
      id: typeof src.connectionId === 'string' ? src.connectionId : undefined,
      name: src.connectionName,
      endpoint: src.endpoint,
      accessKey: src.accessKey,
      model: src.model,
    }, 0);
    if (legacy) {
      connections.push(legacy);
      migrated = true;
    }
  }

  // Resolve the active connection. An id that no longer exists (deleted
  // connection, hand-edited file) falls back to the first one rather than
  // leaving the app with no endpoint at all.
  let activeId = typeof src.activeConnection === 'string' ? src.activeConnection : '';
  if (!connections.some(c => c.id === activeId)) {
    // Prefer the legacy endpoint as the identity of "the one in use" when the
    // stored active id is stale, so an upgrade keeps the same provider selected.
    const legacyEndpoint = normalizeEndpoint(src.endpoint);
    const byEndpoint = legacyEndpoint ? connections.find(c => c.endpoint === legacyEndpoint) : null;
    activeId = byEndpoint ? byEndpoint.id : (connections[0] ? connections[0].id : '');
    if (typeof src.activeConnection === 'string' && src.activeConnection && activeId !== src.activeConnection) {
      migrated = true;
    }
  }

  out.connections = connections;
  out.activeConnection = activeId;
  /* Invariant: the ACTIVE connection is always enabled. It doubles as the team
   * fallback, and a fallback that can be switched off is not a fallback — a team
   * with an unpinned member would then have no endpoint to run against. Enforced
   * here (not only in setEnabled) so a hand-edited settings.json cannot put the
   * app into a state where the active connection is disabled. */
  const active = connections.find(c => c.id === activeId);
  if (active) active.enabled = true;
  Object.assign(out, legacyProjection(active || null));
  return { settings: out, migrated, dropped };
}

/**
 * The enabled pool: connections a team may spread its members across.
 *
 * Order is the stored order, which is what round-robin iterates, so reordering
 * the list in Settings changes the spread order. The active connection is always
 * present and always first-class in the pool (normalizeSettings forces it on).
 */
function enabledPool(settings) {
  const { settings: normalized } = normalizeSettings(settings);
  return normalized.connections.filter(c => c.enabled);
}

/**
 * Toggle one connection's pool membership.
 *
 * Refuses to disable the active connection — it is the team fallback, and the
 * last enabled one must stay enabled so `enabledPool()` can never come back empty
 * while any connection exists. Both refusals are errors, not silent no-ops: the
 * UI shows them, and silently ignoring a click would leave the checkbox and the
 * stored state disagreeing.
 */
function setConnectionEnabled(settings, id, enabled) {
  const { settings: normalized } = normalizeSettings(settings);
  const target = normalized.connections.find(c => c.id === id);
  if (!target) return { ok: false, error: 'No connection with that id.', settings: normalized };
  if (target.id === normalized.activeConnection && !enabled) {
    return {
      ok: false,
      error: 'The active connection cannot be disabled: it is the fallback for teams. Activate another connection first.',
      settings: normalized,
    };
  }
  const want = !!enabled;
  if (!want) {
    const wouldRemain = normalized.connections.filter(c => c.enabled && c.id !== target.id).length;
    if (wouldRemain < 1) {
      return { ok: false, error: 'At least one connection must stay enabled.', settings: normalized };
    }
  }
  target.enabled = want;
  // Re-normalize so the projection and the invariant hold after the mutation.
  return { ok: true, ...normalizeSettings(normalized) };
}

/**
 * The connection currently in use, or null when none is configured.
 *
 * Every consumer of settings.endpoint/accessKey should call this instead, so
 * there is one place that decides which provider is active. Tolerates an
 * un-normalized settings object by normalizing on the fly — a caller must never
 * have to remember to normalize first.
 */
function activeConnection(settings) {
  const { settings: normalized } = normalizeSettings(settings);
  const list = normalized.connections;
  if (!list.length) return null;
  return list.find(c => c.id === normalized.activeConnection) || list[0];
}

/**
 * Look a connection up by id, with the same tolerance as activeConnection().
 * Returns null when the id is unknown, so callers can report a stale selection
 * instead of silently running against a different provider.
 */
function findConnection(settings, id) {
  if (!id) return null;
  const { settings: normalized } = normalizeSettings(settings);
  return normalized.connections.find(c => c.id === id) || null;
}

/**
 * Apply a mutation to the connection list and return normalized settings.
 *
 * `mutate(list)` receives a shallow copy of the array and may return a new
 * array, mutate in place, or return nothing (in-place edits are picked up).
 * Centralising writes here is what keeps the legacy projection in step with the
 * list — a caller that edited `settings.connections` directly would leave
 * `settings.endpoint` pointing at the old active connection.
 *
 * @returns {{settings: object, activeConnectionId: string}|{error: string}}
 */
function updateConnections(settings, mutate, options = {}) {
  const { settings: normalized } = normalizeSettings(settings);
  const list = normalized.connections.slice();
  const result = mutate(list);
  const next = Array.isArray(result) ? result : list;
  const cap = Number.isSafeInteger(options.maxConnections) && options.maxConnections > 0
    ? options.maxConnections : MAX_CONNECTIONS;
  if (next.length > cap) {
    return { error: `At most ${cap} connections can be configured.` };
  }
  const candidate = { ...normalized, connections: next };
  // An explicit activation wins; otherwise keep the current one (normalize
  // falls back to the first entry if it was the connection just removed).
  if (options.activeId !== undefined) candidate.activeConnection = options.activeId;
  const done = normalizeSettings(candidate);
  const active = activeConnection(done.settings);
  return { settings: done.settings, activeConnectionId: active ? active.id : '' };
}

/**
 * Add a connection. Rejects a duplicate endpoint: two entries for one URL with
 * different keys is a configuration mistake, and silently keeping both makes the
 * active selection ambiguous to the user.
 *
 * @returns {{settings: object, connection: object}|{error: string}}
 */
function addConnection(settings, fields = {}) {
  const endpoint = normalizeEndpoint(fields.endpoint);
  if (!endpoint) return { error: 'An endpoint URL is required.' };
  const { settings: normalized } = normalizeSettings(settings);
  if (normalized.connections.length >= MAX_CONNECTIONS) {
    return { error: `At most ${MAX_CONNECTIONS} connections can be configured.` };
  }
  if (normalized.connections.some(c => c.endpoint === endpoint)) {
    return { error: 'That endpoint is already configured. Select it instead of adding it again.' };
  }
  const connection = {
    id: newId(),
    name: clip(fields.name, MAX_NAME_CHARS).trim() || defaultName(endpoint) || DEFAULT_NAME,
    endpoint,
    accessKey: clip(fields.accessKey, MAX_KEY_CHARS),
    model: clip(fields.model, MAX_MODEL_CHARS).trim(),
  };
  const updated = updateConnections(settings, list => {
    list.push(connection);
    return list;
  }, { activeId: fields.activate === false ? undefined : connection.id });
  if (updated.error) return updated;
  return { settings: updated.settings, connection };
}

/**
 * Update fields on one connection. Only the keys present in `fields` change, so
 * editing a name cannot clear the access key.
 *
 * Changing the endpoint of an existing connection keeps its id — and therefore
 * its identity — which is the whole point of not keying by URL.
 */
function updateConnection(settings, id, fields = {}) {
  const target = findConnection(settings, id);
  if (!target) return { error: 'Unknown connection.' };
  const patch = {};
  if (fields.name !== undefined) patch.name = clip(fields.name, MAX_NAME_CHARS).trim();
  if (fields.endpoint !== undefined) patch.endpoint = normalizeEndpoint(fields.endpoint);
  if (fields.accessKey !== undefined) patch.accessKey = clip(fields.accessKey, MAX_KEY_CHARS);
  if (fields.model !== undefined) patch.model = clip(fields.model, MAX_MODEL_CHARS).trim();
  if (patch.endpoint !== undefined && !patch.endpoint) return { error: 'An endpoint URL is required.' };
  if (patch.endpoint && patch.endpoint !== target.endpoint) patch.capabilities = [];
  // Re-derive an empty name from the (possibly new) endpoint rather than storing
  // a blank, so the list never shows an unnamed row.
  if (patch.name === '' ) delete patch.name;
  const { settings: normalized } = normalizeSettings(settings);
  const endpoint = patch.endpoint || target.endpoint;
  if (patch.endpoint && patch.endpoint !== target.endpoint
    && normalized.connections.some(c => c.id !== id && c.endpoint === patch.endpoint)) {
    return { error: 'Another connection already uses that endpoint.' };
  }
  const updated = updateConnections(settings, list => list.map(c => (c.id === id
    ? { ...c, ...patch, name: patch.name || c.name || defaultName(endpoint) || DEFAULT_NAME }
    : c)));
  if (updated.error) return updated;
  return { settings: updated.settings, connection: findConnection(updated.settings, id) };
}

/** Remove a connection. Removing the active one activates the first remaining. */
function removeConnection(settings, id) {
  const target = findConnection(settings, id);
  if (!target) return { error: 'Unknown connection.' };
  const { settings: normalized } = normalizeSettings(settings);
  if (normalized.connections.length <= 1) {
    return { error: 'At least one connection must remain. Edit this one instead of removing it.' };
  }
  const updated = updateConnections(settings, list => list.filter(c => c.id !== id));
  if (updated.error) return updated;
  return { settings: updated.settings, removed: target.id };
}

/**
 * Choose the active connection. Returns an error for an unknown id rather than
 * silently activating something else: routing chat to the wrong provider is the
 * one failure here that costs the user tokens and trust.
 */
function setActiveConnection(settings, id) {
  const target = findConnection(settings, id);
  if (!target) return { error: 'Unknown connection.' };
  const updated = updateConnections(settings, list => list, { activeId: id });
  if (updated.error) return updated;
  return { settings: updated.settings, connection: target };
}

/**
 * A settings view scoped to ONE connection.
 *
 * Returns a shallow copy of `settings` whose legacy endpoint/accessKey/model
 * fields describe the requested connection instead of the active one. This is
 * what lets every existing consumer keep working unchanged: playground, the
 * refactor workbench, proposeEditsViaModel and the agent loops all read
 * `settings.endpoint` / `settings.accessKey`, and handing them a scoped view
 * routes them at the connection the user picked without touching their code.
 *
 * An unknown or absent id yields the ACTIVE connection — never an empty view.
 * Failing closed here would break every model call the moment a renderer passed
 * a stale id (e.g. a connection the user deleted in another window), and the
 * user would see "No endpoint configured" while one plainly is.
 *
 * The `connections` list is carried through so a caller can still enumerate.
 */
function scopedSettings(settings, connectionId) {
  const { settings: normalized } = normalizeSettings(settings);
  const connection = (connectionId && findConnection(normalized, connectionId))
    || activeConnection(normalized);
  return { ...normalized, ...legacyProjection(connection || null) };
}

/** A safe view for the renderer: everything the UI needs, keys included. */
function publicConnections(settings) {
  const { settings: normalized } = normalizeSettings(settings);
  const active = activeConnection(normalized);
  const enabled = normalized.connections.filter(c => c.enabled);
  return {
    connections: normalized.connections.map(c => ({ ...c })),
    activeConnection: normalized.activeConnection,
    activeEndpoint: active ? active.endpoint : '',
    activeName: active ? active.name : '',
    /* The team pool. Computed here rather than in the renderer so "N of M
     * enabled" and the spread preview cannot disagree with what a run will
     * actually resolve. */
    enabledCount: enabled.length,
    enabledIds: enabled.map(c => c.id),
    totalCount: normalized.connections.length,
  };
}

const LEGACY_FIELDS = ['endpoint', 'accessKey', 'model'];

/**
 * Fold a legacy single-endpoint write into the ACTIVE connection.
 *
 * This exists because normalizeSettings() derives endpoint/accessKey/model FROM
 * the active connection. A caller that writes those fields directly — pre-feature
 * code paths, a hand-edited settings.json, or the smoke suite's
 * saveSettings({endpoint, accessKey, model}) — would otherwise have its change
 * silently reverted on the next read, which is the worst kind of bug: the save
 * reports success and the value is gone.
 *
 * So a write carrying legacy fields but no explicit `connections` array is
 * interpreted as "edit the connection in use". When there is no connection yet
 * the legacy fields seed the first one (the migration path).
 *
 * Only the fields actually present in `incoming` are applied, so saving a theme
 * or a budget cannot clear the access key.
 *
 * `connectionsAuthoritative` distinguishes the two callers. The renderer saves
 * the WHOLE object it read from settings:get, which always carries a
 * `connections` array, so the array's mere presence cannot mean "the caller is
 * managing connections" — testing for it made every legacy write a silent no-op.
 * The caller must say whether its own PATCH included `connections`: if it did,
 * the list wins and the legacy fields are just its stale projection.
 *
 * @param {object} incoming The merged object about to be persisted.
 * @param {{connectionsAuthoritative?: boolean}} [options]
 * @returns {object} settings with connections reconciled. Input is not mutated.
 */
function applyLegacyWrite(incoming, options = {}) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const touched = LEGACY_FIELDS.filter(f => incoming[f] !== undefined);
  if (!touched.length) return incoming;
  if (options.connectionsAuthoritative) return incoming;

  const { settings: normalized } = normalizeSettings(incoming);
  const list = normalized.connections;

  if (!list.length) {
    // Nothing to edit: seed the first connection from the legacy fields.
    const seeded = sanitizeConnection({
      endpoint: incoming.endpoint,
      accessKey: incoming.accessKey,
      model: incoming.model,
      name: incoming.connectionName,
      id: typeof incoming.connectionId === 'string' ? incoming.connectionId : undefined,
    }, 0);
    if (!seeded) return incoming;
    const out = normalizeSettings({ ...incoming, connections: [seeded], activeConnection: seeded.id });
    return out.settings;
  }

  const activeId = normalized.activeConnection;
  const nextList = list.map(c => {
    if (c.id !== activeId) return c;
    const patch = { ...c };
    for (const f of touched) {
      patch[f] = f === 'endpoint' ? normalizeEndpoint(incoming.endpoint) : clip(incoming[f], f === 'accessKey' ? MAX_KEY_CHARS : MAX_MODEL_CHARS);
    }
    if (!patch.endpoint) return c;   // never blank out a working connection
    // Re-derive the name only if it was auto-generated from the old endpoint, so
    // a name the user typed by hand survives an endpoint edit.
    if (patch.endpoint !== c.endpoint && c.name === defaultName(c.endpoint)) {
      patch.name = defaultName(patch.endpoint) || c.name;
    }
    if (patch.endpoint !== c.endpoint) patch.capabilities = [];
    return patch;
  });
  return normalizeSettings({ ...incoming, connections: nextList, activeConnection: activeId }).settings;
}

// The settings form submits visible fields only. Preserve learned provider
// facts on a matching connection when it saves, and discard them on URL change.
function preserveCapabilities(current, incoming) {
  if (!Array.isArray(incoming?.connections)) return incoming;
  return { ...incoming, connections: incoming.connections.map(connection => {
    const old = current?.connections?.find(c => c.id === connection.id);
    if (!old || old.endpoint !== normalizeEndpoint(connection.endpoint) || connection.capabilities) return connection;
    return { ...connection, capabilities: old.capabilities || [] };
  }) };
}

module.exports = {
  MAX_CONNECTIONS,
  MAX_NAME_CHARS,
  DEFAULT_NAME,
  LEGACY_FIELDS,
  newId,
  derivedId,
  normalizeEndpoint,
  defaultName,
  sanitizeConnection,
  normalizeSettings,
  activeConnection,
  findConnection,
  updateConnections,
  addConnection,
  updateConnection,
  removeConnection,
  setActiveConnection,
  enabledPool,
  setConnectionEnabled,
  publicConnections,
  applyLegacyWrite,
  preserveCapabilities,
  scopedSettings,
};
