'use strict';

/* Reach Studio — recursive byte-budget for tool results (plan item E3).
 *
 * The previous bound in agent-tool-runner.cjs truncated only TOP-LEVEL STRING
 * fields, each to half the tool's budget. Three measured consequences:
 *
 *   1. a top-level array or object was never touched, so `list` on a large
 *      directory, `search` with many matches, `code.index` output and the
 *      `tests.run` gate array could be arbitrarily large;
 *   2. a result with ten string fields could occupy ~5x its stated budget,
 *      because every field got its own half-budget allowance;
 *   3. truncation was applied to the copy handed back, not to the message, so
 *      the persisted transcript could hold the full shape.
 *
 * This module bounds the WHOLE structure against ONE total budget, so the
 * value a caller returns and the message written to the conversation are
 * bounded by the same number.
 *
 * Design rules, each of which a test pins:
 *   - Fixed key order: primitives first (insertion order), then arrays, then
 *     nested objects. Small informative fields therefore survive a budget cut
 *     even when a big nested collection is elided.
 *   - Elision is explicit: a dropped collection is replaced by an item-count
 *     marker (`[+N more items elided]`) rather than silently shrinking, so the
 *     model can tell "there were 3" from "there were 30,000".
 *   - Errors are never elided: any `error` / `errors` / `errorReason` field
 *     survives at full length, and that protection is inherited by the items of
 *     an `errors` array. A bounded result that hides WHY it failed is worse
 *     than a large one.
 *   - Deterministic: no randomness, no clock, no I/O. The same input always
 *     produces the same bytes.
 */

/* Keys whose values must never be elided. */
const NEVER_ELIDE = new Set(['error', 'errors', 'errorReason']);

/* Marker used when a collection is cut. */
const ELISION = '+N more items elided';

function isPlain(value) {
  return value !== null && typeof value === 'object';
}

/**
 * Deterministic key order: primitives, then arrays, then nested objects.
 * Within each class, insertion order is preserved.
 */
function orderedKeys(object) {
  const keys = Object.keys(object);
  const primitives = [], arrays = [], objects = [];
  for (const key of keys) {
    const value = object[key];
    if (Array.isArray(value)) arrays.push(key);
    else if (isPlain(value)) objects.push(key);
    else primitives.push(key);
  }
  return [...primitives, ...arrays, ...objects];
}

function truncateString(text, cap, neverElide) {
  const s = String(text);
  if (neverElide || s.length <= cap) return s;
  const cut = s.slice(0, cap);
  return `${cut}\n… [truncated, ${(s.length - cap).toLocaleString()} characters dropped]`;
}

/**
 * Build a copy of `value` with every string capped at `stringCap` and every
 * collection capped at `itemCap` items.
 *
 * `protected` marks a subtree whose strings must survive in full — it is set
 * for an error-bearing key and INHERITED by that node's children, which is what
 * keeps the entries of an `errors` array intact rather than just the array.
 *
 * `elided` accumulates the loss so the caller can report it precisely; the
 * caller owns the object and must pass a FRESH one per attempt, because the
 * ladder in boundResult calls this repeatedly.
 */
function clamp(value, { stringCap, itemCap, depth = 0, maxDepth = 8, key = '', protected: inherited = false, elided = null } = {}) {
  const neverElide = inherited || NEVER_ELIDE.has(key);
  if (typeof value === 'string') return truncateString(value, stringCap, neverElide);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= maxDepth) return `[nested ${Array.isArray(value) ? 'array' : 'object'} elided at depth ${maxDepth}]`;

  if (Array.isArray(value)) {
    const kept = value.slice(0, itemCap).map(item =>
      clamp(item, { stringCap, itemCap, depth: depth + 1, maxDepth, key: '', protected: neverElide, elided }));
    const dropped = value.length - kept.length;
    if (dropped > 0) {
      kept.push(`[+${dropped.toLocaleString()} more items elided]`);
      if (elided) {
        elided.total += dropped;
        elided.paths.push({ key: key || '(root)', dropped });
      }
    }
    return kept;
  }

  const out = {};
  for (const childKey of orderedKeys(value)) {
    out[childKey] = clamp(value[childKey], {
      stringCap, itemCap, depth: depth + 1, maxDepth, key: childKey, protected: neverElide, elided,
    });
  }
  return out;
}

function sizeOf(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER; // circular or otherwise unserializable
  }
}

/**
 * Bound a tool result to one total byte budget.
 *
 * Tries geometrically shrinking string and item caps until the serialized form
 * fits. The first attempt is generous (cap = budget) so a result that is only
 * slightly over is trimmed by the smallest amount that works, rather than being
 * flattened to the floor. Errors are exempt from every cap.
 *
 * Returns `{ value, bytes, elided, truncated }`. `value` is always JSON-safe and
 * is what both the caller and the transcript should use.
 */
function boundResult(result, { budget = 8000, maxDepth = 8 } = {}) {
  const limit = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 8000;
  const original = sizeOf(result);
  if (original <= limit) return { value: result, bytes: original, elided: { total: 0, paths: [] }, truncated: false };

  let best = null;
  // A geometric ladder rather than a search: deterministic, and at most ~20
  // attempts for any realistic budget. Each attempt gets a FRESH accumulator so
  // the reported elision describes the value actually returned.
  for (let cap = limit; cap >= 8; cap = Math.floor(cap / 2)) {
    const elided = { total: 0, paths: [] };
    const value = clamp(result, { stringCap: cap, itemCap: Math.max(1, Math.floor(cap / 256)), maxDepth, elided });
    const bytes = sizeOf(value);
    best = { value, bytes, elided };
    if (bytes <= limit) break;
  }

  if (best && best.bytes <= limit) {
    return { value: best.value, bytes: best.bytes, elided: best.elided, truncated: true };
  }

  // Extreme fallback: even the floor did not fit — which in practice means an
  // error-bearing result whose protected text is itself over budget. Keep the
  // error information (the ONE thing worth more than the budget) plus the
  // top-level shape, so the model learns what happened instead of getting an
  // empty object. `protected: true` is what stops the error text being cut
  // here; without it this branch would elide the very field it exists to save.
  const minimal = {};
  if (isPlain(result) && !Array.isArray(result)) {
    for (const key of orderedKeys(result)) {
      if (!NEVER_ELIDE.has(key)) continue;
      minimal[key] = clamp(result[key], { stringCap: limit, itemCap: 8, maxDepth: 4, key, protected: true });
    }
    if (result.ok !== undefined) minimal.ok = result.ok;
  }
  minimal._bounded = `Tool result exceeded its ${limit.toLocaleString()}-character budget and was reduced to its error information.`;
  if (Array.isArray(result)) minimal._shape = `array of ${result.length.toLocaleString()} items`;
  return { value: minimal, bytes: sizeOf(minimal), elided: best ? best.elided : { total: 0, paths: [] }, truncated: true };
}

module.exports = { boundResult, clamp, orderedKeys, sizeOf, ELISION, NEVER_ELIDE };
