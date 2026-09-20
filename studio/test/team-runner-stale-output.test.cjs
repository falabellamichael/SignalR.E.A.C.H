'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { TeamRunner } = require('../agent/team-runner.cjs');

const complete = message => JSON.stringify({ status: 'complete', message, actions: [], options: [] });

function jsonReply(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}

async function localEndpoint(t, handler) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => handler(JSON.parse(raw), res));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test('failed Links synthesis cannot reuse stale output or erase viable pre-synthesis answers', async t => {
  let synthesisRequests = 0;
  const endpoint = await localEndpoint(t, (body, res) => {
    const transcript = body.messages.map(message => String(message.content || '')).join('\n');
    if (transcript.includes('FINAL SYNTHESIS')) {
      synthesisRequests++;
      return; // No headers: the current wake produces no assistant message.
    }
    const evidence = body.model === 'alpha' ? 'Verified Alpha evidence.' : 'Verified Beta evidence.';
    jsonReply(res, complete(evidence));
  });

  const events = [];
  const runner = new TeamRunner({
    team: {
      id: 'stale-synthesis',
      name: 'Stale synthesis regression',
      mode: 'links',
      members: [{ personaId: 'alpha', roleId: 'coordinator' }, { personaId: 'beta' }],
    },
    personas: [
      { id: 'alpha', name: 'Alpha', model: 'alpha' },
      { id: 'beta', name: 'Beta', model: 'beta' },
    ],
    task: 'Combine both verified evidence reports.',
    endpoint,
    requestTimeoutMs: 75,
    sendEvent: (_channel, event) => events.push(event),
  });

  let deadline;
  const results = await Promise.race([
    runner.run('stale-synthesis-run'),
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Links synthesis did not respect its request deadline.')), 2000);
    }),
  ]).finally(() => clearTimeout(deadline));

  assert.equal(synthesisRequests, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].output, '', 'the failed wake has no output from its current message boundary');

  const done = events.findLast(event => event.type === 'done');
  assert.ok(done, 'the team emits its terminal event');
  assert.match(done.answer, /Verified Alpha evidence\./);
  assert.match(done.answer, /Verified Beta evidence\./);
  assert.match(done.answer, /【Alpha】/);
  assert.match(done.answer, /【Beta】/);
  assert.equal(done.links.synthesisAttempted, true);
  assert.equal(done.links.synthesized, false, 'a failed synthesis attempt is not reported as completed synthesis');
  assert.equal(done.links.completedBy, null, 'a failed synthesizer is not credited with team completion');
});
