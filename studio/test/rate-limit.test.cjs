'use strict';

/* Item 2.8 — outbound request pacing.
 *
 * Before this, `agent-loop.cjs` threw on a non-OK response, and
 * `isTransientTransportError()` deliberately does not classify HTTP statuses —
 * so `HTTP 429` ended the conversation, or in Links mode marked the member
 * `stalled`, while the rest of the crew kept bursting the same provider. These
 * tests pin the two halves of the fix:
 *
 *   1. the gate's own arithmetic (unit, injectable clock — no real sleeping)
 *   2. the loop's behaviour against a real HTTP server that returns 429 and 503
 *
 * The 503 cases are the load-bearing ones: 429 is always a rate limit, but a
 * bare 503 must stay a HARD failure, because team-nurse.cjs quarantines a dead
 * provider route on it and test/agent.test.cjs asserts that contract.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

const {
  RateGate, createRateGate, gateFor, gateKeyFor, resetGates,
  isRateLimitStatus, rateLimitInfoFrom, retryAfterMsFrom,
  rateLimitDiagnostic, DEFAULT_MIN_RPM, DEFAULT_PENALTY_MS, MAX_RETRY_AFTER_MS,
} = require('../agent/rate-limit.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { defaults, resolveBudgets, validateBudgets, GLOBAL_ONLY_KEYS, fields } = require('../agent/budgets.cjs');
const { classifyFailure } = require('../agent/team-nurse.cjs');

/* A COMPLETE action, so the run-control loop ends after one request. A bare
 * string would be parsed as a missing action and trigger a recovery round,
 * which would make these tests count someone else's requests. */
const action = (status, message, actions = []) => JSON.stringify({ status, message, actions, options: [] });
const reply = (res, content) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
};

function headerBag(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: name => lower[String(name).toLowerCase()] ?? null };
}

/* A controllable clock + sleep. `sleep` advances the clock instead of waiting,
 * so the gate's real back-off arithmetic is exercised in microseconds. */
function fakeClock(start = 1000000) {
  let now = start;
  const slept = [];
  return {
    now: () => now,
    sleep: async ms => { slept.push(ms); now += Math.max(0, ms); },
    advance: ms => { now += ms; },
    slept,
  };
}

async function endpoint(t, handler) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => handler(JSON.parse(raw || '{}'), res, req));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function loopFor(url, budgets = {}) {
  return new AgentLoop({
    agentId: 'a', store: new MemoryStore(), endpoint: url, model: 'fixture',
    budgets: { ...defaults, ...budgets },
  });
}

/* Create the loop's shared gate and neutralise only its TIMER, so the real
 * penalty arithmetic still runs but the suite does not actually sleep. */
function stubGateSleep(loop) {
  const gate = loop._rateGate();
  gate._sleep = async () => {};
  return gate;
}

// ---------------------------------------------------------------------------
// 1. Gate arithmetic (no network)
// ---------------------------------------------------------------------------

test('a healthy endpoint is never paced: the happy path costs nothing', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ now: clock.now, sleep: clock.sleep });
  const before = clock.now();
  for (let i = 0; i < 25; i++) await gate.acquire();
  assert.equal(clock.slept.length, 0, 'no timer is ever armed before the first rate limit');
  assert.equal(clock.now(), before, 'acquire() does not advance time on a healthy endpoint');
  assert.equal(gate.rpm, 0, 'still un-paced');
  assert.equal(gate.available(), true);
  assert.equal(gate.snapshot().limits, 0);
});

test('the first rate limit engages a pace and honors Retry-After as one shared window', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ now: clock.now, sleep: clock.sleep, minRpm: 6 });
  assert.equal(gate.rpm, 0, 'un-paced before any push-back');

  const applied = gate.note429(5000);
  assert.equal(applied.rpm, 24, 'engages at 4x the floor (6 -> 24)');
  assert.equal(applied.penaltyMs, 5000, 'the provider Retry-After becomes the penalty');

  /* The penalty is an ABSOLUTE deadline, not a per-caller timer: ten workers
   * that all hit the same 429 must wait out ONE window together, not ten
   * windows stacked end to end. That is the whole reason a crew does not
   * amplify its own rate limit. */
  const started = clock.now();
  await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()]);
  const elapsed = clock.now() - started;
  assert.equal(elapsed, 5000, `three waiters shared exactly one 5000ms window (got ${elapsed}ms)`);
  assert.equal(gate.snapshot().limits, 1, 'three waiters recorded one rate limit, not three');
});

test('further limits tighten the pace toward the floor, never past it', () => {
  const gate = createRateGate({ minRpm: 6 });
  gate.note429(1000);
  const engaged = gate.rpm;
  gate.note429(1000);
  assert.ok(gate.rpm < engaged, 'a second limit halves the pace');
  for (let i = 0; i < 30; i++) gate.note429(1000);
  assert.equal(gate.rpm, DEFAULT_MIN_RPM, `never paces below the configured floor (got ${gate.rpm})`);
});

test('a Retry-After below the floor is raised, an absent one gets a default, a huge one is clamped', () => {
  const gate = createRateGate();
  assert.equal(gate.note429(0).penaltyMs, DEFAULT_PENALTY_MS, 'a zero Retry-After still pauses');
  assert.equal(gate.note429(null).penaltyMs, DEFAULT_PENALTY_MS, 'no header at all still pauses');
  /* A hostile or mistaken Retry-After must not park a run for an hour. */
  assert.equal(createRateGate().note429(99999999).penaltyMs, MAX_RETRY_AFTER_MS, 'clamped at the ceiling');
  assert.equal(createRateGate().note429(5000).penaltyMs, 5000, 'a sane value is honored exactly');
});

test('the pace is released only after a quiet window with repeated successes', () => {
  const clock = fakeClock();
  const gate = createRateGate({ now: clock.now, sleep: clock.sleep, recoverMs: 15000 });
  gate.note429(2000);
  assert.ok(gate.rpm > 0, 'paced after a limit');

  // A success INSIDE the quiet window is not evidence: a crew's first requests
  // after a limit can succeed on a partially-refilled bucket. Counting those is
  // how a brake gets released mid-storm and the limit re-triggered.
  clock.advance(1000);
  assert.equal(gate.noteSuccess(), false, 'a success inside the window does not count');
  assert.ok(gate.rpm > 0, 'still paced');
  assert.equal(gate.noteSuccess(), false, 'nor does a second one');
  assert.ok(gate.rpm > 0, 'still paced after early successes');

  // Quiet for long enough, but not yet enough successes, is not recovery either.
  clock.advance(20000);
  assert.equal(gate.noteSuccess(), false, 'the first success after the window is not recovery alone');
  assert.equal(gate.noteSuccess(), false, 'nor two');
  assert.ok(gate.rpm > 0, 'still paced at two successes');
  assert.equal(gate.noteSuccess(), true, 'the third consecutive success releases the pace');
  assert.equal(gate.rpm, 0, 'back to the free happy path');
  assert.equal(gate.available(), true);
  assert.equal(gate.snapshot().released, 1);
});

test('pacing off still honors a provider Retry-After, then stops pacing', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ now: clock.now, sleep: clock.sleep, enabled: false });
  const applied = gate.note429(3000);
  assert.equal(applied.rpm, 0, 'no app-imposed pace when pacing is off');
  assert.equal(applied.disabled, true);
  /* The server's instruction is not Studio's to overrule: "off" removes the
   * app-imposed rate, not the provider's own Retry-After. */
  assert.equal(gate.available(), false, 'the penalty still applies with pacing off');
  await gate.acquire();
  assert.ok(clock.slept.length === 1 && clock.slept[0] >= 3000, 'the Retry-After is waited out once');
  assert.equal(gate.available(), true, 'with the penalty spent, an unpaced gate is free again');
});

test('an aborted wait unwinds immediately instead of sleeping out the penalty', async () => {
  const gate = createRateGate({ minRpm: 6 });
  gate.note429(30000);
  const controller = new AbortController();
  const pending = gate.acquire({ signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Stop')), 10);
  await assert.rejects(pending, /Stop/, 'Stop during a rate-limit pause is immediate');
});

test('an unparseable or missing endpoint shares one gate rather than bursting', () => {
  resetGates();
  assert.equal(gateKeyFor(''), 'default');
  assert.equal(gateKeyFor('not a url'), 'default');
  assert.equal(gateKeyFor(undefined), 'default');
  // Same origin, different paths: one pace per provider origin.
  assert.equal(gateKeyFor('https://api.example.com/v1'), gateKeyFor('https://api.example.com/v2'));
  assert.notEqual(gateKeyFor('https://api.example.com/v1'), gateKeyFor('https://other.example.com/v1'));
  // And the registry really hands back one instance for one origin.
  assert.equal(gateFor(gateKeyFor('https://api.example.com/v1')), gateFor(gateKeyFor('https://api.example.com/v1')));
  resetGates();
});

// ---------------------------------------------------------------------------
// 2. Status classification (the 429-vs-503 contract)
// ---------------------------------------------------------------------------

test('429 is always a rate limit; a bare 503 stays a hard failure', () => {
  const none = headerBag({});
  assert.ok(rateLimitInfoFrom(429, none), '429 with no headers is still a rate limit');
  assert.equal(rateLimitInfoFrom(429, none).retryAfterMs, null, 'and reports no provider instruction');
  assert.equal(isRateLimitStatus(429), true);

  // THE CONTRACT: a bare 503 is a dead route, not a pace instruction.
  assert.equal(rateLimitInfoFrom(503, none), null, 'a bare 503 is NOT retryable');
  assert.equal(isRateLimitStatus(503), false, '503 alone must not classify as a rate limit');

  // But a 503 that names a time is a load shedder doing its job.
  const withHeader = headerBag({ 'Retry-After': '7' });
  assert.deepEqual(rateLimitInfoFrom(503, withHeader), { status: 503, retryAfterMs: 7000 });

  // Unrelated statuses are never rate limits, even with the header.
  for (const status of [400, 401, 404, 422, 500, 502, 504]) {
    assert.equal(rateLimitInfoFrom(status, withHeader), null, `${status} is not a rate limit`);
  }
});

test('the 503 rule preserves the existing Nurse quarantine contract', () => {
  /* This is the exact string the loop produced before this change, and the
   * fixture in test/agent.test.cjs (model 'm-hard') returns a bare 503. If this
   * ever regresses, a dead provider route becomes a retry storm — the failure
   * the Nurse exists to prevent. */
  assert.equal(classifyFailure('Endpoint returned HTTP 503: provider unavailable'), 'hard-provider',
    'a dead provider route must still be quarantined, not retried at a slower pace');
  // And the new wording for an EXHAUSTED rate limit is deliberately hard too.
  assert.equal(classifyFailure('api.example.com is rate limiting (HTTP 429). Retry limit reached.'), 'hard-provider');
});

test('Retry-After parses both legal spellings and clamps', () => {
  const now = Date.parse('2015-10-21T07:28:00Z');
  assert.equal(retryAfterMsFrom(headerBag({ 'Retry-After': '30' }), { now }), 30000, 'delta-seconds');
  assert.equal(retryAfterMsFrom(headerBag({ 'Retry-After': '1.5' }), { now }), 1500, 'fractional seconds');
  assert.equal(retryAfterMsFrom(headerBag({ 'Retry-After': 'Wed, 21 Oct 2015 07:28:30 GMT' }), { now }), 30000, 'HTTP-date');
  assert.equal(retryAfterMsFrom(headerBag({ 'Retry-After': 'Wed, 21 Oct 2015 07:27:00 GMT' }), { now }), 0, 'a past date is zero, not negative');
  assert.equal(retryAfterMsFrom(headerBag({}), { now }), null, 'absent header is null, not zero');
  assert.equal(retryAfterMsFrom(headerBag({ 'Retry-After': 'soon' }), { now }), null, 'unusable value is null');
  assert.equal(retryAfterMsFrom(null, { now }), null, 'no headers at all is safe');
  assert.equal(retryAfterMsFrom(headerBag({ 'Retry-After': '600' }), { now }), MAX_RETRY_AFTER_MS, 'an absurd value is clamped');
});

// ---------------------------------------------------------------------------
// 3. End-to-end through the real loop and a real HTTP server
// ---------------------------------------------------------------------------

test('a rate-limited provider is retried after the pause, not failed', async t => {
  let hits = 0;
  const url = await endpoint(t, (_body, res) => {
    if (++hits === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
      return;
    }
    reply(res, action('complete', 'Recovered'));
  });

  resetGates();
  const events = [];
  const store = new MemoryStore();
  const loop = new AgentLoop({
    agentId: 'a', store, endpoint: url, model: 'fixture',
    budgets: { ...defaults, requestPacingRpm: 1 }, sendEvent: (_, e) => events.push(e),
  });
  stubGateSleep(loop);

  await loop.sendUserMessage('Hello');
  assert.equal(hits, 2, 'the request was retried exactly once');
  assert.equal(store.get('a').runState.status, 'completed', 'the run completed instead of erroring');
  assert.ok(events.some(e => e.type === 'rate-limit'), 'a rate-limit event is emitted for the activity trail');
  assert.ok(!events.some(e => e.type === 'error'), 'no error is surfaced for a plain rate limit');
  assert.equal(loop._rateLimitRetries, 0, 'the counter resets after a success');
  resetGates();
});

test('the whole crew shares one pace for one provider', async t => {
  let hits = 0;
  const url = await endpoint(t, (_body, res) => { hits++; reply(res, action('complete', 'ok')); });

  resetGates();
  /* Three independent loops on the same provider — a crew. One of them records
   * a limit; all of them must see the same engaged pace, because the limit
   * belongs to the provider, not to an agent. */
  const loops = [loopFor(url), loopFor(url), loopFor(url)];
  const gates = loops.map(l => l._rateGate());
  assert.equal(gates[0], gates[1], 'same provider origin resolves one shared gate');
  assert.equal(gates[1], gates[2], 'and it is the same object for all of them');
  gates[0].note429(1000);
  for (const g of gates) {
    assert.equal(g.snapshot().limits, 1, "one agent's rate limit is visible to the whole crew");
    assert.ok(g.rpm > 0, 'the pace is engaged for everyone');
  }
  assert.equal(hits, 0, 'the accounting above made no request');
  resetGates();
});

test('exhausting the bounded retries fails with a real, named diagnostic', async t => {
  const url = await endpoint(t, (_body, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: { message: 'slow down' } }));
  });

  resetGates();
  const store = new MemoryStore();
  const loop = new AgentLoop({ agentId: 'a', store, endpoint: url, model: 'fixture', budgets: { ...defaults, requestPacingRpm: 1 } });
  stubGateSleep(loop);
  await loop.sendUserMessage('Hello');

  const state = store.get('a').runState;
  assert.equal(state.status, 'paused', 'a permanently limited provider pauses the run');
  assert.match(state.reason, /rate limiting \(HTTP 429\)/, 'the reason names the provider and the status');
  assert.match(state.reason, /Retry limit reached/, 'and says Studio gave up rather than hanging forever');
  assert.equal(loop._rateLimitRetries, 4, 'exactly RATE_LIMIT_RETRIES+1 attempts were made');
  resetGates();
});

test('a bare 503 is still a hard failure, not a paced retry', async t => {
  let hits = 0;
  const url = await endpoint(t, (_body, res) => {
    hits++;
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('provider unavailable');
  });

  resetGates();
  const store = new MemoryStore();
  const loop = new AgentLoop({ agentId: 'a', store, endpoint: url, model: 'fixture', budgets: { ...defaults, requestPacingRpm: 1 } });
  const gate = stubGateSleep(loop);
  await loop.sendUserMessage('Hello');

  assert.equal(hits, 1, 'a dead route is NOT retried');
  assert.equal(store.get('a').runState.status, 'paused');
  assert.match(store.get('a').runState.reason, /503/);
  assert.equal(gate.snapshot().limits, 0, 'a dead route does not engage the pace');
  assert.equal(gate.rpm, 0);
  resetGates();
});

test('a 503 that states a Retry-After is treated as a pace instruction', async t => {
  let hits = 0;
  const url = await endpoint(t, (_body, res) => {
    if (++hits === 1) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '2' });
      res.end('overloaded');
      return;
    }
    reply(res, action('complete', 'Recovered'));
  });

  resetGates();
  const store = new MemoryStore();
  const loop = new AgentLoop({ agentId: 'a', store, endpoint: url, model: 'fixture', budgets: { ...defaults, requestPacingRpm: 1 } });
  stubGateSleep(loop);
  await loop.sendUserMessage('Hello');

  assert.equal(hits, 2, 'a shedding 503 with a named time is retried once');
  assert.equal(store.get('a').runState.status, 'completed');
  resetGates();
});

test('a healthy endpoint makes exactly one request and never engages the gate', async t => {
  let hits = 0;
  const url = await endpoint(t, (_body, res) => { hits++; reply(res, action('complete', 'fine')); });

  resetGates();
  const loop = loopFor(url);
  const gate = loop._rateGate();
  let slept = 0;
  gate._sleep = async () => { slept++; };

  await loop.sendUserMessage('Hello');
  assert.equal(hits, 1, 'exactly one request');
  assert.equal(slept, 0, 'the happy path never waits');
  assert.equal(gate.snapshot().limits, 0, 'nothing was recorded');
  assert.equal(gate.rpm, 0, 'the gate is still un-paced');
  resetGates();
});

// ---------------------------------------------------------------------------
// 4. Configuration surface (the settings form must be able to reach it)
// ---------------------------------------------------------------------------

test('pacing is configurable, global-only, and a per-conversation override cannot reach it', () => {
  assert.equal(defaults.requestPacing, true, 'pacing is on by default');
  assert.equal(defaults.requestPacingRpm, DEFAULT_MIN_RPM);
  const keys = fields.filter(f => f.globalOnly).map(f => f.key);
  assert.ok(keys.includes('requestPacing') && keys.includes('requestPacingRpm'),
    'both knobs are marked global-only so the settings form cannot offer them per conversation');
  assert.ok(GLOBAL_ONLY_KEYS.has('requestPacingRpm'));

  /* A conversation override is filtered out in the ONE resolver every execution
   * path reads — not merely hidden in the UI, so a hand-written IPC call cannot
   * reach around it. */
  const overridden = resolveBudgets({}, { budgetOverrides: { requestPacingRpm: 999 } });
  assert.equal(overridden.requestPacingRpm, DEFAULT_MIN_RPM, 'a hand-written override is ignored');
  const global = resolveBudgets({ budgets: { ...defaults, requestPacingRpm: 30 } }, { budgetOverrides: { requestPacingRpm: 999 } });
  assert.equal(global.requestPacingRpm, 30, 'the global value wins');

  // Validation still holds: the floor is 1, so 0 is rejected rather than
  // silently meaning "unlimited".
  assert.throws(() => validateBudgets({ requestPacingRpm: 0 }), /whole number from 1/);
  assert.throws(() => validateBudgets({ requestPacing: 1 }), /true or false/);
});

test('a per-request budget change reaches the shared gate on the NEXT request', async t => {
  const url = await endpoint(t, (_body, res) => reply(res, action('complete', 'ok')));
  resetGates();
  const loop = loopFor(url);
  assert.equal(loop._rateGate().enabled, true, 'default is on');
  loop._budgets = () => ({ ...defaults, requestPacing: false });
  assert.equal(loop._rateGate().enabled, false, 'the loop reads the live budget on the next request');
  loop._budgets = () => ({ ...defaults, requestPacing: true });
  assert.equal(loop._rateGate().enabled, true, 'and back on again');
  resetGates();
});

test('the diagnostic names the provider, the status and what Studio is doing', () => {
  const text = rateLimitDiagnostic('https://api.example.com/v1', 45000, 429);
  assert.match(text, /api\.example\.com/, 'names the provider host');
  assert.match(text, /HTTP 429/);
  assert.match(text, /45s/, 'states the real wait');
  assert.match(text, /slower pace/, 'says a retry is coming, so a pause is not read as a hang');
  assert.match(rateLimitDiagnostic('https://api.example.com/v1', 0, 429), /retries immediately/);
  assert.match(rateLimitDiagnostic('not a url', 2000, 503), /The endpoint/, 'an unparseable endpoint is described, not echoed raw');
});
