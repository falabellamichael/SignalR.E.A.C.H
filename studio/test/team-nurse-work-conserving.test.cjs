'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { TeamRunner } = require('../agent/team-runner.cjs');

const action = (status, message, actions = [], options = []) =>
  JSON.stringify({ status, message, actions, options });

function jsonReply(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}

async function localEndpoint(t, handler) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    await handler(JSON.parse(raw), res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('Links Nurse starts an evidence-backed recovery before an unrelated slow initial member resolves', async t => {
  const slowStarted = deferred();
  const releaseSlow = deferred();
  const nurseRequestStarted = deferred();
  let slowResolved = false;
  let nurseRequests = 0;
  let nurseTranscript = '';
  let inFlight = 0;
  let maxInFlight = 0;

  const endpoint = await localEndpoint(t, async (body, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const transcript = body.messages.map(message => String(message.content || '')).join('\n');
      if (body.model === 'slow') {
        slowStarted.resolve();
        await releaseSlow.promise;
        slowResolved = true;
        jsonReply(res, action('complete', 'The unrelated slow member eventually finished.'));
        return;
      }
      if (body.model === 'source') {
        jsonReply(res, action('complete', `Verified source evidence for the recovery target. ${'e'.repeat(240)}`));
        return;
      }
      if (/TEAM NURSE RECOVERY/.test(transcript)) {
        nurseRequests++;
        nurseTranscript = transcript;
        nurseRequestStarted.resolve();
        jsonReply(res, action('complete', 'The new evidence repaired the target.\nLINKS: COMPLETE'));
        return;
      }
      // A protocol failure: AgentLoop performs its bounded structured-recovery
      // attempts, then TeamRunner exposes this member as stalled to the Nurse.
      jsonReply(res, 'I could not produce a usable structured action.');
    } finally {
      inFlight--;
    }
  });

  const events = [];
  const runner = new TeamRunner({
    team: {
      id: 'work-conserving-nurse',
      name: 'Work-conserving Nurse',
      mode: 'links',
      members: [
        { personaId: 'source', roleId: 'coordinator' },
        { personaId: 'target' },
        { personaId: 'slow' },
      ],
    },
    personas: [
      { id: 'source', name: 'Source', model: 'source', prompt: 'You are Source.' },
      { id: 'target', name: 'Target', model: 'target', prompt: 'You are Target.' },
      { id: 'slow', name: 'Slow', model: 'slow', prompt: 'You are Slow.' },
    ],
    task: 'Use Source evidence to recover Target; Slow is unrelated.',
    endpoint,
    concurrency: 3,
    requestTimeoutMs: 5000,
    sendEvent: (_channel, event) => events.push(event),
  });

  const run = runner.run('work-conserving-nurse-run');
  await slowStarted.promise;

  let orderingError = null;
  let recoveryDeadline;
  try {
    await Promise.race([
      nurseRequestStarted.promise,
      new Promise((_, reject) => {
        recoveryDeadline = setTimeout(() => reject(new Error('Nurse recovery remained blocked behind the unrelated initial member.')), 1000);
      }),
    ]);
    assert.equal(slowResolved, false, 'the recovery request must begin while Slow is still unresolved');
  } catch (error) {
    orderingError = error;
  } finally {
    clearTimeout(recoveryDeadline);
    releaseSlow.resolve();
  }

  const results = await run;
  if (orderingError) throw orderingError;

  assert.equal(nurseRequests, 1, 'exactly one recovery provider request is made');
  assert.match(nurseTranscript, /Verified source evidence for the recovery target/, 'the queued wake preserves Source evidence until launch');
  assert.ok(maxInFlight <= 3, `provider concurrency stayed within the configured cap (observed ${maxInFlight})`);
  assert.equal(inFlight, 0, 'all provider requests are settled when the team run completes');
  assert.ok(events.some(event => event.type === 'nurse' && event.nurseType === 'wake-started' && event.name === 'Target'));
  assert.ok(events.some(event => event.type === 'links-revive' && event.source === 'nurse' && event.name === 'Target'));
  assert.equal(results[1].ok, true, 'Target completes from the early Nurse handoff');
});
