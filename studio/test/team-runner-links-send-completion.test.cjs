'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');

const { TeamRunner } = require('../agent/team-runner.cjs');

const action = (status, message, actions = [], options = []) =>
  JSON.stringify({ status, message, actions, options });
const tool = (name, arguments_) => ({ name, arguments: arguments_ });

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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('LINKS: COMPLETE sent through AgentNet cancels an unrelated header-stalled peer after the conclusion grace', async t => {
  const requestTimeoutMs = 5000;
  const stalledStarted = deferred();
  const stalledClosed = deferred();
  let messengerRequests = 0;

  const endpoint = await localEndpoint(t, (body, res) => {
    if (body.model === 'stalled') {
      res.on('close', stalledClosed.resolve);
      stalledStarted.resolve();
      return; // Never send headers; only the Links conclusion should abort it.
    }

    messengerRequests++;
    if (messengerRequests === 1) {
      jsonReply(res, action('actions', 'Declaring the verified crew result to my peer.', [
        tool('agent.send', {
          to: 'Stalled',
          message: 'The crew result is complete and verified.\nLINKS: COMPLETE',
        }),
      ]));
      return;
    }
    jsonReply(res, action('complete', 'The completion declaration was delivered to the crew.'));
  });

  const events = [];
  const runner = new TeamRunner({
    team: {
      id: 'links-send-completion',
      name: 'Links send completion',
      mode: 'links',
      members: [{ personaId: 'messenger', roleId: 'coordinator' }, { personaId: 'stalled' }],
    },
    personas: [
      { id: 'messenger', name: 'Messenger', model: 'messenger' },
      { id: 'stalled', name: 'Stalled', model: 'stalled' },
    ],
    task: 'Finish the verified crew result and notify the peer.',
    endpoint,
    requestTimeoutMs,
    concurrency: 2,
    sendEvent: (_channel, event) => events.push(event),
  });

  const startedAt = performance.now();
  const running = runner.run('links-send-completion-run');
  await stalledStarted.promise;

  let safetyTimer;
  const results = await Promise.race([
    running,
    new Promise((_, reject) => {
      safetyTimer = setTimeout(() => reject(new Error('AgentNet completion did not release the header-stalled peer.')), 2000);
    }),
  ]).finally(() => clearTimeout(safetyTimer));
  const elapsedMs = performance.now() - startedAt;
  let socketTimer;
  await Promise.race([
    stalledClosed.promise,
    new Promise((_, reject) => {
      socketTimer = setTimeout(() => reject(new Error('The aborted provider socket did not close.')), 500);
    }),
  ]).finally(() => clearTimeout(socketTimer));

  // The stalled member is released by the configured 250 ms conclusion grace:
  // neither immediately nor anywhere close to its five-second provider timeout.
  assert.ok(elapsedMs >= 200, `expected the conclusion grace before cancellation; elapsed ${elapsedMs.toFixed(1)} ms`);
  assert.ok(elapsedMs < requestTimeoutMs / 2, `completion waited too close to the provider timeout; elapsed ${elapsedMs.toFixed(1)} ms`);
  assert.equal(runner._linksConclusionTimer, null, 'the conclusion timer is consumed and cleared');
  assert.equal(runner.net.linksComplete.by, 'Messenger');
  assert.equal(runner.net.linksComplete.to, 'Stalled');
  assert.match(runner.net.linksComplete.message, /LINKS: COMPLETE/);
  assert.equal(messengerRequests, 2, 'the declaring member finishes its current tool turn normally');
  assert.ok(results.every(result => result.ok), 'the cancelled peer is superseded by successful Links completion');

  const delivery = events.find(event => event.type === 'subagent' && event.netType === 'agent-message');
  assert.ok(delivery, 'the declaration travels through AgentNet.send');
  assert.equal(delivery.fromName, 'Messenger');
  assert.equal(delivery.toName, 'Stalled');
  const done = events.findLast(event => event.type === 'done');
  assert.equal(done.links.completedBy, 'Messenger');
  assert.equal(done.links.synthesized, false);
  assert.match(done.answer, /crew result is complete and verified/i);
  assert.match(done.answer, /LINKS: COMPLETE/);
});
