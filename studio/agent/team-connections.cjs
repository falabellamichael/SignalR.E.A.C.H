'use strict';

/* Reach Studio — per-member connection resolution for Teams.
 *
 * Teams are the special case that uses MULTIPLE endpoints. Everything else in
 * the app (chats, playground, refactor) runs against the single ACTIVE
 * connection; a team spreads its members across the enabled pool instead.
 *
 * Precedence, per member (user decision 2026-09-18 — "C and D ... one needs to
 * be the fallback"):
 *
 *   1. PINNED   — the persona names a connection (persona.connectionId) and that
 *                 connection still exists AND is enabled. Explicit beats
 *                 automatic: this is how a user guarantees a member never lands
 *                 on an endpoint that lacks its model.
 *   2. SPREAD   — the team has spreadConnections on, so unpinned members are
 *                 round-robined across the enabled pool by roster index.
 *   3. FALLBACK — the ACTIVE connection. Reached when spread is off, the pool is
 *                 empty, or a pin went stale (its connection was deleted or
 *                 disabled). One connection must always be able to serve as the
 *                 fallback, which is why connections.cjs refuses to let the
 *                 active one be disabled.
 *
 * A stale pin degrades to "unpinned" rather than to the fallback directly, so it
 * still benefits from spread when spread is on. Every resolution carries a
 * `reason` so the UI can explain why a member ended up where it did — a team
 * silently running three members against one endpoint when the user expected a
 * spread is the failure this makes visible.
 *
 * Model resolution is separate from connection resolution and matters because
 * model ids are per-endpoint: persona.model wins (an explicit user choice),
 * otherwise the RESOLVED connection's own default model, otherwise the app
 * default. Using the resolved connection's default rather than the global one is
 * the point — after a spread, the global default may not exist on that endpoint.
 */

const connections = require('./connections.cjs');

/** Why a member landed on the connection it did. Surfaced in the UI. */
const REASON = {
  PINNED: 'pinned',
  SPREAD: 'spread',
  FALLBACK: 'fallback',
  /** The persona's connection no longer exists, so the pin was ignored. */
  STALE_PIN: 'stale-pin',
  /** The persona's connection exists but is switched out of the pool. */
  DISABLED_PIN: 'disabled-pin',
  /** No connections configured at all — the caller must fail the run. */
  NONE: 'none',
};

/**
 * Resolve every member of a roster to a concrete endpoint + key + model.
 *
 * Pure: never mutates its arguments and depends on no I/O, so the precedence
 * rules are testable without Electron or a relay.
 *
 * @param {object}   opts
 * @param {object}   opts.settings      App settings (need not be normalized).
 * @param {object[]} opts.personas      Roster in member order. Order matters:
 *                                      round-robin indexes into it.
 * @param {boolean}  [opts.spread]      Team-level toggle. When false, only pins
 *                                      and the fallback are used.
 * @param {string}   [opts.defaultModel] App-level default model.
 * @returns {Array<{
 *   index: number,
 *   personaId: string,
 *   connectionId: string,
 *   connectionName: string,
 *   endpoint: string,
 *   accessKey: string,
 *   model: string,
 *   reason: string,
 *   pinnedConnectionId: string,
 * }>} One entry per persona, in roster order.
 */
function resolveTeamConnections({ settings, personas, spread = false, defaultModel = '' } = {}) {
  const { settings: normalized } = connections.normalizeSettings(settings);
  const list = normalized.connections;
  const activeId = normalized.activeConnection;
  const active = list.find(c => c.id === activeId) || null;
  // The pool round-robin walks. Stored order, which is what Settings shows, so
  // reordering there changes the spread order.
  const pool = list.filter(c => c.enabled);

  const roster = Array.isArray(personas) ? personas : [];
  const wantSpread = !!spread && pool.length > 0;
  /* Round-robin advances only for members that ACTUALLY consume a pool slot.
   * Using the raw roster index instead would let a pinned member punch a hole in
   * the spread: pin member 0 to C in a pool of [A,B,C] and unpinned members 1,2
   * would land on B and C — A never used, C twice. */
  let spreadCursor = 0;

  const modelFor = (persona, connection) => {
    const pinnedModel = String((persona && persona.model) || '').trim();
    if (pinnedModel) return pinnedModel;
    const connModel = String((connection && connection.model) || '').trim();
    if (connModel) return connModel;
    return String(defaultModel || '').trim() || 'gpt-4o-mini';
  };

  const describe = (index, persona, connection, reason) => ({
    index,
    personaId: String((persona && persona.id) || ''),
    connectionId: connection ? connection.id : '',
    connectionName: connection ? connection.name : '',
    endpoint: connection ? connection.endpoint : '',
    // Never echoed to logs or the UI by callers — see the note in main.mjs.
    accessKey: connection ? connection.accessKey : '',
    model: modelFor(persona, connection),
    reason,
    pinnedConnectionId: String((persona && persona.connectionId) || ''),
  });

  return roster.map((persona, index) => {
    const pinId = String((persona && persona.connectionId) || '').trim();

    // 1. An explicit, still-valid pin wins over everything.
    if (pinId) {
      const pinned = list.find(c => c.id === pinId);
      if (pinned && pinned.enabled) return describe(index, persona, pinned, REASON.PINNED);
      // Stale pin: fall through, but remember WHY so the UI can say so instead
      // of the user wondering whether their pin was ignored by a bug.
      const staleReason = pinned ? REASON.DISABLED_PIN : REASON.STALE_PIN;
      if (wantSpread) {
        // map() runs in order, so the cursor advances deterministically.
        const slot = pool[spreadCursor % pool.length];
        spreadCursor++;
        return { ...describe(index, persona, slot, REASON.SPREAD), stalePin: staleReason };
      }
      const fallback = active || pool[0] || null;
      if (!fallback) return { ...describe(index, persona, null, REASON.NONE), stalePin: staleReason };
      // Report the STALE reason, not FALLBACK: the member is using the fallback,
      // but the interesting fact for the user is that their pin was ignored.
      return { ...describe(index, persona, fallback, staleReason), stalePin: staleReason };
    }

    // 2. Spread across the enabled pool. Only unpinned members advance the
    //    cursor, so pins do not leave gaps in the rotation.
    if (wantSpread) {
      const slot = pool[spreadCursor % pool.length];
      spreadCursor++;
      return describe(index, persona, slot, REASON.SPREAD);
    }

    // 3. The active connection is the fallback for everything else.
    const fallback = active || pool[0] || null;
    if (!fallback) return describe(index, persona, null, REASON.NONE);
    return describe(index, persona, fallback, REASON.FALLBACK);
  });
}

/**
 * A human-readable summary of a resolution, for logs and the team header.
 *
 * Deliberately names connections and models but NEVER access keys.
 */
function summarizeResolutions(resolutions) {
  if (!Array.isArray(resolutions) || !resolutions.length) return 'no members';
  const byConnection = new Map();
  for (const r of resolutions) {
    const label = r.connectionName || r.endpoint || '(no connection)';
    const entry = byConnection.get(label) || { count: 0, models: new Set(), reasons: new Set() };
    entry.count++;
    if (r.model) entry.models.add(r.model);
    if (r.reason) entry.reasons.add(r.reason);
    byConnection.set(label, entry);
  }
  const parts = [];
  for (const [label, entry] of byConnection) {
    const models = [...entry.models].join(', ');
    parts.push(`${label} x${entry.count}${models ? ` [${models}]` : ''} (${[...entry.reasons].join('/')})`);
  }
  return parts.join('; ');
}

/**
 * True when a roster cannot run at all: some member resolved to no endpoint.
 * Checked before spending any tokens, so a misconfigured pool fails fast with a
 * useful message instead of three members erroring mid-run.
 */
function hasUnresolvableMember(resolutions) {
  return Array.isArray(resolutions) && resolutions.some(r => !r || !r.endpoint);
}

/**
 * Compare resolved member models with successful `GET /models` catalogs.
 * Missing catalogs are deliberately ignored: some otherwise-compatible
 * providers do not implement model listing, so only positive evidence of a
 * mismatch may block a run.
 */
function unsupportedTeamModels(resolutions, catalogsByEndpoint) {
  if (!Array.isArray(resolutions) || !(catalogsByEndpoint instanceof Map)) return [];
  return resolutions.filter(r => {
    if (!r || !r.endpoint || !r.model) return false;
    const advertised = catalogsByEndpoint.get(r.endpoint);
    return advertised instanceof Set && advertised.size > 0 && !advertised.has(r.model);
  });
}

module.exports = {
  REASON,
  resolveTeamConnections,
  summarizeResolutions,
  hasUnresolvableMember,
  unsupportedTeamModels,
};
