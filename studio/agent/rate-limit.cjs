'use strict';

/* Reach Studio — outbound request pacing. This file IS item 2.8 of
 * docs/IMPROVEMENTS.md: "Rate-limit outbound agent requests — per-connection
 * gate needed; the relay already has RateLimiter, client-side missing."
 *
 * WHY THIS EXISTS
 * Studio can run a crew: up to `maxAgents` agents (default 12), several of them
 * issuing a request every round, all against one provider. A provider that
 * answered "429 Too Many Requests" (or, on some gateways, "503 Service
 * Unavailable") was previously a HARD failure. `agent-loop.cjs` threw
 * `Endpoint returned HTTP 429`, and `isTransientTransportError()` said no —
 * that predicate only knows transport codes (ECONNRESET, UND_ERR_SOCKET, ...)
 * and deliberately does not look at HTTP statuses. So a rate limit ended the
 * conversation, or in Links mode marked the member `stalled`, while the rest of
 * the crew kept hammering the same provider.
 *
 * A 429 is not a failure. It is the provider asking for a slower pace, and it
 * usually comes with a `Retry-After` that states exactly how slow. Failing on
 * it is both the wrong reading and the worst reaction: the remaining agents
 * retry in lockstep, which is the maximum-rate burst that produced the 429.
 *
 * WHAT THIS FILE PROVIDES
 *   isRateLimitStatus(status)   which HTTP statuses mean "slow down"
 *   retryAfterMsFrom(headers)   parse the provider's back-off instruction
 *   gateKeyFor(endpoint)        one pace per provider ORIGIN, not per agent
 *   gateFor(key)                the shared gate for that origin
 *   createRateGate()/RateGate   adaptive pacing:
 *
 *     Happy path — nothing to pay. Before an endpoint has ever pushed back the
 *     gate is un-paced, so acquire() resolves on the spot: no timer, no delay,
 *     no observable difference from not having this feature. A crew that never
 *     sees a 429 pays zero.
 *
 *     After a 429/503 — two things happen at once:
 *       1. The provider's Retry-After becomes an ABSOLUTE deadline that every
 *          waiter on that endpoint shares. Ten workers that all hit the limit
 *          wait out ONE window together (their sleeps overlap in wall-clock
 *          time) instead of ten windows stacked end to end.
 *       2. A conservative per-minute pace is engaged, so the crew cannot
 *          immediately re-burst the instant the penalty expires.
 *
 *     After quiet successes — the pace is released and the gate returns to the
 *     free happy path, so a one-off limit does not tax the rest of the session.
 *
 * WHY THE GATE IS SHARED PER ENDPOINT
 * The rate limit belongs to the provider, not to an agent. Every AgentLoop — a
 * single chat, each team member, every spawned worker — resolves the same gate
 * for the same origin through the module-level registry below. That is what
 * makes this a *crew* control: twelve workers share one pace, instead of each
 * one independently rediscovering the limit and re-triggering it. It also means
 * no TeamRunner change was needed; members are AgentLoops and inherit it.
 *
 * Pacing off (`requestPacing: false`) removes only the APP-IMPOSED rate. A
 * provider's Retry-After is still honored once, because that instruction comes
 * from the server rather than from Studio — the same distinction the rest of
 * the budget schema draws between an application cap and a provider limit.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * It never cancels or shortens an in-flight request. Pacing applies only before
 * a request starts; a request already streaming is left alone. And it never
 * hard-blocks: Stop aborts the wait, because every wait is passed the run's
 * AbortSignal.
 */

/* A 429 with no Retry-After is still a rate limit; assume a short pause rather
 * than retrying into the same wall. Also the floor for a Retry-After that asks
 * for less: retrying a rate-limited provider instantly is never right. */
const DEFAULT_PENALTY_MS = 2000;
/* We never sleep longer than this on a provider's word alone: a wrong or
 * hostile Retry-After must not park a run for an hour. */
const MAX_RETRY_AFTER_MS = 60000;
/* The pace engaged after the first limit (4× the floor), and the slowest we
 * will pace an endpoint down to. */
const DEFAULT_MIN_RPM = 6;
/* How long after the LAST 429 the endpoint must stay clean before we release
 * the pace. Without this, a crew releases the brake mid-storm. */
const DEFAULT_RECOVER_MS = 15000;
/* Successful requests required AFTER that quiet window, before the pace is
 * released. A success inside the window is not evidence of recovery: the
 * crew's first requests after a limit can succeed on a partially-refilled
 * bucket, and counting those is how a brake gets released mid-storm. */
const RECOVER_SUCCESSES = 3;
/* The gate doubles as a registry; bound it so a long session with many
 * endpoints cannot grow the table without limit. */
const MAX_GATES = 32;
/* Safety valve: each pass of acquire() performs a real, monotonic wait, so this
 * should never be reached. It exists so a pathological clock cannot spin. */
const MAX_ACQUIRE_PASSES = 100;

/*
 * Which responses mean "you are going too fast"?
 *
 * 429 is definitionally a rate limit, so it always qualifies.
 *
 * 503 is NOT, and the distinction is load-bearing. "Service Unavailable" is the
 * generic upstream-busy/overloaded answer, and an existing contract depends on a
 * bare 503 staying a HARD, non-retryable failure: the team Nurse quarantines a
 * dead provider route instead of waking a stalled member against it (see
 * `HARD_FAILURE_RE` in team-nurse.cjs and the "links hard-provider quarantine"
 * case in test/agent.test.cjs). Treating every 503 as retryable would turn a
 * genuinely dead route into a retry storm — precisely the failure the Nurse
 * exists to prevent.
 *
 * The exception is a 503 that carries Retry-After. That header is the server
 * stating when it will be ready again, so the response is an instruction to come
 * back later — a load shedder doing its job, not a dead route. So: 429 always,
 * 503 only when the server names a time.
 *
 * Returns { status, retryAfterMs } when the response is a rate limit, else null.
 */
function rateLimitInfoFrom(status, headers, options = {}) {
  if (status === 429) return { status, retryAfterMs: retryAfterMsFrom(headers, options) };
  if (status === 503) {
    const retryAfterMs = retryAfterMsFrom(headers, options);
    return retryAfterMs === null ? null : { status, retryAfterMs };
  }
  return null;
}

/* Convenience for a caller holding only a status code. With no headers to read,
 * only the unambiguous 429 qualifies. */
function isRateLimitStatus(status) {
  return status === 429;
}

/*
 * Read Retry-After off a response.
 *
 * The header has two legal spellings — delta-seconds ("120") and an HTTP-date
 * ("Wed, 21 Oct 2015 07:28:00 GMT") — and providers use both, so both are
 * parsed. Returns milliseconds, or null when the header is absent or unusable;
 * callers distinguish "no instruction" from "wait zero". Always clamped to
 * MAX_RETRY_AFTER_MS so a bad header cannot stall a run.
 */
function retryAfterMsFrom(headers, { now = Date.now(), maxMs = MAX_RETRY_AFTER_MS } = {}) {
  let raw;
  try {
    raw = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
  } catch {
    return null;
  }
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.min(Math.round(ms), maxMs));
}

/* The pace belongs to the provider, so the key is its origin — scheme, host
 * and port. Two providers get two paces; one provider behind two paths does
 * not. An unparseable endpoint shares the 'default' gate, which is the safe
 * direction (over-share a pace, never over-share a burst). */
function gateKeyFor(endpoint) {
  try {
    return new URL(String(endpoint || '')).origin || 'default';
  } catch {
    return 'default';
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : fallback;
}

function formatMs(ms) {
  const total = Math.max(0, Number(ms) || 0);
  if (total < 1000) return `${Math.round(total)}ms`;
  const s = Math.round(total / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function providerLabel(endpoint) {
  try {
    return new URL(String(endpoint || '')).host || 'The endpoint';
  } catch {
    return 'The endpoint';
  }
}

/* Abortable sleep. Every wait in this module goes through it, so Stop during a
 * rate-limit pause unwinds immediately instead of after the pause. */
function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('Aborted')); };
    timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

class RateGate {
  constructor({
    now = Date.now,
    sleep = defaultSleep,
    minRpm = DEFAULT_MIN_RPM,
    minPenaltyMs = DEFAULT_PENALTY_MS,
    recoverMs = DEFAULT_RECOVER_MS,
    enabled = true,
  } = {}) {
    this._now = now;
    this._sleep = sleep;
    this.minRpm = clampInt(minRpm, 1, 100000, DEFAULT_MIN_RPM);
    this.minPenaltyMs = clampInt(minPenaltyMs, 0, MAX_RETRY_AFTER_MS, DEFAULT_PENALTY_MS);
    this.recoverMs = clampInt(recoverMs, 1000, 600000, DEFAULT_RECOVER_MS);
    this.enabled = enabled !== false;
    /* 0 means "not paced" — the happy path. Anything above 0 is a pace this
     * gate engaged in response to a real 429. */
    this.rpm = 0;
    this.tokens = 0;
    this.tokensAt = 0;
    this.penaltyUntil = 0;
    this.lastLimitedAt = 0;
    this.okStreak = 0;
    /* Observability only: never used for decisions. */
    this.stats = { limits: 0, waits: 0, engaged: 0, released: 0, waitedMs: 0 };
  }

  /* Applied on every request by the caller, so a budget change takes effect on
   * the next request rather than at the next loop construction. */
  configure({ enabled, minRpm } = {}) {
    if (enabled !== undefined) this.enabled = enabled !== false;
    if (minRpm !== undefined) this.minRpm = clampInt(minRpm, 1, 100000, this.minRpm);
    return this;
  }

  /* Burst allowance: 15 seconds of the current pace, at least one token so a
   * very slow pace still lets a request through. */
  _burst() {
    return Math.max(1, Math.ceil(this.rpm / 4));
  }

  /*
   * How long the caller must wait before the next request, consuming a token
   * when it may proceed. One function decides, so a caller cannot check twice
   * and take two tokens for one request.
   *
   * The provider-imposed penalty is consulted FIRST, and independently of
   * `enabled`: turning off app pacing must not turn off the server's own
   * instruction to come back later.
   */
  _reserve() {
    const now = this._now();
    const penalty = this.penaltyUntil - now;
    if (penalty > 0) return penalty;
    if (!this.enabled || this.rpm <= 0) return 0;
    const capacity = this._burst();
    if (this.tokensAt === 0) {
      this.tokens = capacity;
      this.tokensAt = now;
    } else {
      this.tokens = Math.min(capacity, this.tokens + Math.max(0, now - this.tokensAt) * (this.rpm / 60000));
      this.tokensAt = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.tokens) * 60000 / this.rpm);
  }

  /*
   * Wait for this endpoint to be willing to take the next request.
   * Resolves immediately whenever the endpoint is healthy — which, for a crew
   * that never sees a 429, is always.
   */
  async acquire({ signal } = {}) {
    let waited = false;
    for (let pass = 0; pass < MAX_ACQUIRE_PASSES; pass++) {
      const wait = this._reserve();
      if (wait <= 0) return { waited };
      waited = true;
      this.stats.waits++;
      this.stats.waitedMs += wait;
      await this._sleep(wait, signal);
    }
    /* Unreachable in practice: each pass waits on a monotonic deadline/token
     * refill. Proceed rather than hang the run on a clock anomaly. */
    return { waited: true, exhausted: true };
  }

  /*
   * Record a rate-limit response. Returns the penalty actually applied.
   *
   * The penalty is an ABSOLUTE deadline, not a per-caller timer: ten workers
   * that hit the same 429 all wait out one window and resume together, instead
   * of ten windows stacked end to end.
   */
  note429(retryAfterMs = null) {
    const now = this._now();
    const asked = Number.isFinite(Number(retryAfterMs)) && retryAfterMs !== null
      ? Math.max(0, Math.min(Number(retryAfterMs), MAX_RETRY_AFTER_MS))
      : this.minPenaltyMs;
    const wait = Math.max(this.minPenaltyMs, asked);
    this.penaltyUntil = Math.max(this.penaltyUntil, now + wait);
    this.lastLimitedAt = now;
    this.okStreak = 0;
    this.stats.limits++;
    /* Refill from the new pace on the next reserve, not from the old bucket. */
    this.tokensAt = 0;
    if (!this.enabled) return { penaltyMs: Math.max(0, this.penaltyUntil - now), rpm: 0, disabled: true };
    /* Engage on the first limit; tighten on every further one. Halving (rather
     * than jumping to the floor) keeps a single stray 429 from crippling an
     * otherwise healthy endpoint. */
    if (this.rpm <= 0) {
      this.rpm = Math.max(this.minRpm, this.minRpm * 4);
      this.stats.engaged++;
    } else {
      this.rpm = Math.max(this.minRpm, Math.floor(this.rpm / 2));
    }
    return { penaltyMs: Math.max(0, this.penaltyUntil - now), rpm: this.rpm };
  }

  /*
   * Record a successful response. Returns true when this call RELEASED the
   * pace, so a caller can report the recovery once instead of on every request.
   *
   * The pace is released only after the endpoint has been quiet for recoverMs
   * AND answered RECOVER_SUCCESSES requests in that window — otherwise a crew
   * releases the brake in the middle of a storm and re-triggers it.
   */
  noteSuccess() {
    if (this.rpm <= 0) return false;
    const now = this._now();
    /* A success INSIDE the quiet window is not yet evidence, so it neither
     * advances the streak nor releases the pace. The window exists precisely
     * because a crew's first requests after a limit can succeed on a
     * partially-refilled bucket; counting those would release the brake and
     * re-trigger the limit. This makes the contract exactly what the comment
     * above claims: RECOVER_SUCCESSES successes, all after the quiet window. */
    if (now - this.lastLimitedAt < this.recoverMs) return false;
    this.okStreak++;
    if (this.okStreak < RECOVER_SUCCESSES) return false;
    this.rpm = 0;
    this.tokens = 0;
    this.tokensAt = 0;
    this.okStreak = 0;
    this.stats.released++;
    return true;
  }

  /* Is a request allowed through right now, with no waiting? Pure inspection:
   * does not consume a token, so it is safe to call for a status line. */
  available() {
    /* The provider's penalty is checked FIRST and independently of `enabled`.
     * Returning `true` for a paused gate merely because app pacing is off would
     * make every status readout claim the endpoint is ready while the gate is
     * still serving the server's Retry-After — the exact lie this predicate
     * exists to prevent. */
    const now = this._now();
    if (this.penaltyUntil > now) return false;
    if (!this.enabled) return true;
    return this.rpm <= 0;
  }

  reset() {
    this.rpm = 0;
    this.tokens = 0;
    this.tokensAt = 0;
    this.penaltyUntil = 0;
    this.lastLimitedAt = 0;
    this.okStreak = 0;
    return this;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      rpm: this.rpm,
      limited: !this.available(),
      penaltyMs: Math.max(0, this.penaltyUntil - this._now()),
      ...this.stats,
    };
  }
}

/* The registry. One gate per endpoint origin, shared by every AgentLoop that
 * talks to it — this is the mechanism that turns a per-agent control into a
 * per-crew one. */
const GATES = new Map();

/*
 * The shared gate for `key`.
 *
 * Options apply only when the gate is CREATED, so a caller that owns a gate's
 * construction (a test, or a future per-endpoint policy) is not overwritten on
 * every request; the loop only ever calls configure(), which touches the
 * pacing knobs and nothing else.
 */
function gateFor(key, options = {}) {
  const name = String(key || '').trim() || 'default';
  let gate = GATES.get(name);
  if (!gate) {
    gate = new RateGate(options);
    GATES.set(name, gate);
    if (GATES.size > MAX_GATES) {
      /* Evict the oldest insertion; a stale endpoint's pace is worth less than
       * a bounded table. Evicting a pace can only make requests faster, never
       * data-corrupting. */
      GATES.delete(GATES.keys().next().value);
    }
  }
  return gate;
}

function resetGates() {
  GATES.clear();
}

function createRateGate(options = {}) {
  return new RateGate(options);
}

/* The one message a user sees when a provider pushes back. It always names the
 * provider and always says what Studio is doing about it, so a paused run is
 * never mistaken for a hung one. */
function rateLimitDiagnostic(endpoint, waitMs, status = 429) {
  const base = `${providerLabel(endpoint)} is rate limiting (HTTP ${status}).`;
  if (Number(waitMs) > 0) {
    return `${base} Pausing this crew's requests for ${formatMs(waitMs)} before retrying at a slower pace.`;
  }
  return `${base} Outbound pacing is off, so this retries immediately.`;
}

module.exports = {
  RateGate,
  createRateGate,
  gateFor,
  gateKeyFor,
  resetGates,
  isRateLimitStatus,
  rateLimitInfoFrom,
  retryAfterMsFrom,
  rateLimitDiagnostic,
  DEFAULT_MIN_RPM,
  DEFAULT_PENALTY_MS,
  DEFAULT_RECOVER_MS,
  MAX_GATES,
  MAX_RETRY_AFTER_MS,
};
