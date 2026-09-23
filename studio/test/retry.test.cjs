'use strict';

/* Reach Studio — plan item E1 done-check: Retry-After is honoured, and a
 * 429 no longer reads as a permanent provider failure.
 *
 * The leaf retry.cjs owns the timing policy that agent-loop._retryDelay
 * consumes (base/cap from the budgets fields retryBaseMs / retryMaxMs /
 * retryAfterCapMs), and team-nurse's classifier decides whether a stalled
 * member pauses (recoverable) or is quarantined. These tests pin both sides:
 *   - a 429 with Retry-After: 5 waits exactly the header delay (not the old
 *     fixed 1500 ms), and an hour-long window is clamped to the cap;
 *   - with no header, backoff is exponential and bounded;
 *   - the nurse stages recovery (a finite score) for rate-limit evidence,
 *     while a bare 503 without rate-limit evidence still quarantines — the
 *     locked contract agent.test.cjs proves for a dead provider route.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRetryAfter,
  retryAfterMs,
  backoffMs,
  retryDelayMs,
  isRetryableStatus,
  isRateLimitEvidence,
} = require('../agent/retry.cjs');
const { classifyFailure, recoveryScore } = require('../agent/team-nurse.cjs');

test('parseRetryAfter: delay-seconds form', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('"5"'), 5000);
  assert.equal(parseRetryAfter('0'), 0);
});

test('parseRetryAfter: HTTP-date form; a past date is a zero wait, not a miss', () => {
  const now = Date.parse('Wed, 22 Sep 2026 12:00:00 GMT');
  assert.equal(parseRetryAfter('Wed, 22 Sep 2026 12:05:00 GMT', now), 5 * 60000);
  assert.equal(parseRetryAfter('Wed, 22 Sep 2026 11:00:00 GMT', now), 0);
});

test('parseRetryAfter: absent or unparseable values are null, never an error', () => {
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
});

test('retryAfterMs reads Response-like headers', () => {
  const response = { headers: { get: name => (name === 'retry-after' ? '5' : null) } };
  assert.equal(retryAfterMs(response), 5000);
  assert.equal(retryAfterMs({ headers: { get: () => null } }), null);
  assert.equal(retryAfterMs(null), null);
});

test('E1: a 429 with Retry-After 5 waits the header delay, clamped by the cap', () => {
  // The second request is not issued before the header's delay:
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: 5000 }), 5000);
  // …and not after the cap, when the provider sends an hour-long window:
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: 3600000, retryAfterCapMs: 300000 }), 300000);
  // A cap of 0 means "no cap" (budgets convention).
  assert.equal(retryDelayMs({ attempt: 1, retryAfter: 3600000, retryAfterCapMs: 0 }), 3600000);
  // The header wins over the backoff schedule on every attempt:
  assert.equal(retryDelayMs({ attempt: 7, retryAfter: 5000 }), 5000);
});

test('E1: without a header, backoff is exponential, jittered and bounded', () => {
  // Attempt 1 reproduces the old fixed 1500 ms default (jitter spans [750, 1500]).
  assert.equal(backoffMs(1, { baseMs: 1500, maxMs: 60000, rand: () => 0 }), 750);
  assert.equal(backoffMs(1, { baseMs: 1500, maxMs: 60000, rand: () => 1 }), 1500);
  // Attempt 2: step 3000, jitter over [1500, 3000].
  assert.equal(backoffMs(2, { baseMs: 1500, maxMs: 60000, rand: () => 0 }), 1500);
  assert.equal(backoffMs(2, { baseMs: 1500, maxMs: 60000, rand: () => 1 }), 3000);
  // The step is capped at maxMs.
  assert.equal(backoffMs(30, { baseMs: 1500, maxMs: 60000, rand: () => 1 }), 60000);
});

test('E1: which statuses are worth another attempt', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [400, 401, 403, 404, 422, 501, 505]) assert.equal(isRetryableStatus(s), false, String(s));
  assert.equal(isRateLimitEvidence({ status: 429 }), true);
  assert.equal(isRateLimitEvidence({ message: 'Endpoint returned HTTP 429: Too Many Requests' }), true);
  assert.equal(isRateLimitEvidence({ retryAfter: 5000 }), true);
  assert.equal(isRateLimitEvidence({ message: 'service unavailable' }), false);
  assert.equal(isRateLimitEvidence({ message: 'Endpoint returned HTTP 503: service down' }), false);
});

test('E1 nurse: a 429 with Retry-After stages a recovery, not a quarantine', () => {
  const text = 'Endpoint returned HTTP 429: Too Many Requests';
  assert.equal(classifyFailure(text), 'rate-limited');
  const score = recoveryScore({ failureKind: 'rate-limited', hasNewEvidence: true });
  assert.ok(Number.isFinite(score), 'rate-limited must be recoverable (finite score)');
  assert.ok(score >= 7, 'stalled + new evidence is the floor for a rate-limited member');
});

test('E1 nurse: a bare 503 with no rate-limit evidence still quarantines', () => {
  // Locked contract (agent.test.cjs): a dead provider route is not retried forever.
  assert.equal(classifyFailure('Endpoint returned HTTP 503: service down'), 'hard-provider');
  assert.equal(recoveryScore({ failureKind: 'hard-provider', hasNewEvidence: true }), Number.NEGATIVE_INFINITY);
  assert.equal(classifyFailure('Endpoint returned HTTP 401: invalid api key'), 'hard-provider');
});

test('a live retryable provider error honours Retry-After within the configured cap', async t => {
  const { AgentLoop } = require('../agent/agent-loop.cjs');
  const { MemoryStore } = require('../agent/memory-store.cjs');
  const { resolveBudgets } = require('../agent/budgets.cjs');
  const originalFetch = global.fetch;
  const times = [];
  global.fetch = async () => {
    times.push(Date.now());
    if (times.length === 1) return new Response('upstream busy', { status: 500, headers: { 'Retry-After': '5' } });
    const content = 'Done.\n```agent_status\n{"status":"complete","summary":"Done."}\n```';
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  t.after(() => { global.fetch = originalFetch; });
  const store = new MemoryStore();
  const loop = new AgentLoop({ agentId: 'retry-agent', store, endpoint: 'http://retry-cap.invalid/v1', model: 'mock',
    budgets: { ...resolveBudgets(), retryLimit: 1, retryAfterCapMs: 250 } });
  await loop.sendUserMessage('Finish the task.');
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 200, `retried too early: ${times[1] - times[0]} ms`);
  assert.ok(times[1] - times[0] < 3000, `retry did not obey the 250 ms cap: ${times[1] - times[0]} ms`);
});
