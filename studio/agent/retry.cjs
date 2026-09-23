'use strict';

/* Reach Studio — retry timing for provider requests (plan item E1).
 *
 * The engine used to retry on a hardcoded 1500 ms wait and ignored the
 * provider's own Retry-After instruction entirely. A rate-limited provider
 * therefore got hammered at a fixed cadence it had explicitly asked us not to
 * use, and a `429` was classified by team-nurse.cjs as a permanent provider
 * failure — so a rate limit quarantined a crew member for the rest of the run.
 *
 * This module is a leaf: no engine imports, no I/O, no timers. It only computes
 * how long to wait and whether a failure is worth retrying, which keeps the
 * policy testable without a fake clock.
 *
 * Precedence of the wait, highest first:
 *   1. a `Retry-After` from the provider, clamped to `retryAfterCapMs`
 *   2. exponential backoff from `retryBaseMs`, capped at `retryMaxMs`
 * Jitter is applied ONLY to the backoff branch: a provider that told us exactly
 * when to come back should not be answered at a random time.
 */

/* Status codes that mean "ask again later", not "you are broken". 501/505 are
 * deliberately absent — they are a wrong endpoint or a wrong protocol, which
 * retrying cannot fix. NOTE: 503 stays retryable for the transport path while
 * team-nurse keeps classifying a bare 503 as hard-provider unless the response
 * actually carried rate-limit evidence (see team-nurse.cjs classifyFailure). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/* Match the real header names an OpenAI-compatible provider may send. */
const HEADER_NAMES = ['retry-after', 'x-ratelimit-reset-after', 'x-ratelimit-reset'];

function headerValue(headers, name) {
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') return headers.get(name);
    const direct = headers[name] ?? headers[name.toLowerCase()];
    return direct === undefined ? null : direct;
  } catch {
    return null;
  }
}

/**
 * Milliseconds to wait per a Retry-After-style header.
 *
 * Accepts the two forms RFC 9110 allows — delay-seconds and an HTTP-date — and
 * returns null when the value is absent, unparseable, or already in the past.
 * A past date means the provider's window already elapsed, which is a zero wait
 * rather than a missing instruction, so the caller retries immediately.
 */
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  // delay-seconds (an integer, optionally quoted by a sloppy proxy)
  const seconds = /^"?(\d+)"?$/.exec(text);
  if (seconds) return Math.max(0, Number(seconds[1]) * 1000);
  // HTTP-date
  const at = Date.parse(text);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return null;
}

/** Milliseconds from any Retry-After-style header on a Response, or null. */
function retryAfterMs(response, now = Date.now()) {
  for (const name of HEADER_NAMES) {
    const parsed = parseRetryAfter(headerValue(response?.headers, name), now);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * The delay before retry `attempt` (1-based).
 *
 * `baseMs` is the first backoff step, so attempt 1 reproduces the old fixed
 * 1500 ms default exactly; later attempts double, capped at `maxMs`. `attempt`
 * is clamped to 30 so a misconfigured cap cannot overflow the shift operand
 * (2 ** 31 is already years of waiting, well past any useful timeout).
 *
 * `rand` is injectable so a test can assert both bounds of the jitter without
 * sleeping or stubbing globals.
 */
function backoffMs(attempt, { baseMs = 1500, maxMs = 60000, rand = Math.random } = {}) {
  const step = Math.min(30, Math.max(1, Math.floor(attempt) || 1));
  const base = Math.max(1, Number(baseMs) || 1);
  const ceiling = Math.max(base, Number(maxMs) || base);
  const raw = Math.min(ceiling, base * 2 ** (step - 1));
  // Full jitter over the lower half: respects the ceiling while spreading a
  // fleet of retries out instead of synchronizing them on the same instant.
  const floor = Math.ceil(raw / 2);
  const spread = raw - floor;
  if (spread <= 0) return raw;
  const r = Math.min(0.999999, Math.max(0, Number(rand()) || 0));
  return floor + Math.floor(r * (spread + 1));
}

/**
 * The wait before a retry, honouring the provider's instruction first.
 *
 * `retryAfterMs` is clamped by `retryAfterCapMs` (0 = no cap) because a
 * provider may answer with an hour-long reset window and a crew run must not
 * silently stall for it — the cap converts "wait an hour" into "give up".
 */
function retryDelayMs({ attempt = 1, retryAfter = null, baseMs = 1500, maxMs = 60000, retryAfterCapMs = 300000, rand = Math.random } = {}) {
  if (Number.isFinite(retryAfter) && retryAfter !== null && retryAfter >= 0) {
    return retryAfterCapMs > 0 ? Math.min(retryAfter, retryAfterCapMs) : retryAfter;
  }
  return backoffMs(attempt, { baseMs, maxMs, rand });
}

/** True when a failed request is worth another attempt. */
function isRetryableStatus(status) {
  return Number.isInteger(status) && RETRYABLE_STATUS.has(status);
}

/** An ngrok-generated 503 means its tunnel cannot currently reach the origin. */
function isNgrokTunnelUnavailable(status, body) {
  const text = String(body || '');
  return status === 503
    && /(?:<!doctype\s+html|<html[\s>])/i.test(text)
    && /(?:assets\.ngrok\.com|ERR_NGROK_[A-Z0-9_]+)/i.test(text);
}

/**
 * True when the failure is the provider telling us to slow down.
 *
 * Reads the status when the caller has it and falls back to the message, since
 * AgentLoop re-throws as `Endpoint returned HTTP <status>: <body>` and the
 * team-nurse classifier only ever sees text.
 */
function isRateLimitEvidence({ status = null, message = '', retryAfter = null } = {}) {
  if (retryAfter !== null && retryAfter !== undefined) return true;
  if (status === 429) return true;
  const text = String(message || '');
  if (/\b429\b/.test(text)) return true;
  if (/retry[- ]after/i.test(text)) return true;
  return /too many requests|rate[ _-]?limit/i.test(text);
}

module.exports = {
  RETRYABLE_STATUS,
  parseRetryAfter,
  retryAfterMs,
  backoffMs,
  retryDelayMs,
  isRetryableStatus,
  isNgrokTunnelUnavailable,
  isRateLimitEvidence,
};
