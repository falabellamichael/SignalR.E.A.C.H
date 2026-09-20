'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TeamRunner } = require('../agent/team-runner.cjs');

test('Start wakes a stalled member with saved context without restarting teammates', { timeout: 10000 }, async t => {
  let releaseSlow, markStalled, markRecovered;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const stalled = new Promise(resolve => { markStalled = resolve; });
  const recovered = new Promise(resolve => { markRecovered = resolve; });
  let wakeRequests = 0, slowRequests = 0, transcript = '';
  const events = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const history = body.messages.map(message => String(message.content || '')).join('\n');
    let content;
    if (body.model === 'slow') {
      slowRequests++;
      await slow;
      content = JSON.stringify({ status: 'complete', message: 'Slow finished.', actions: [], options: [] });
    } else if (history.includes('The user pressed Start')) {
      wakeRequests++;
      transcript = history;
      content = JSON.stringify({ status: 'complete', message: 'Recovered.\nLINKS: COMPLETE', actions: [], options: [] });
      markRecovered();
    } else content = 'I cannot produce a usable structured action.';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runner = new TeamRunner({
    team: { id: 'restart', mode: 'links', nurse: false, members: [{ personaId: 'target' }, { personaId: 'slow' }] },
    personas: [{ id: 'target', name: 'Target', model: 'target', prompt: 'You are Target.' }, { id: 'slow', name: 'Slow', model: 'slow', prompt: 'You are Slow.' }],
    task: 'Preserve the original unique task context.',
    endpoint: `http://127.0.0.1:${server.address().port}/v1`, concurrency: 2, requestTimeoutMs: 3000,
    sendEvent: (_channel, event) => { events.push(event); if (event.type === 'links-stall' && event.index === 0) markStalled(); },
  });
  t.after(() => { releaseSlow(); runner.stop(); server.closeAllConnections(); server.close(); });
  const running = runner.run('restart-run');
  await stalled;
  runner.userPaused = true;
  assert.throws(() => runner.controlMember(0, true), /Start the team/);
  runner.userPaused = false;
  runner.controlMember(0, true);
  runner.controlMember(0, true);
  await recovered;
  releaseSlow();
  const results = await running;
  assert.equal(wakeRequests, 1);
  assert.equal(slowRequests, 1);
  assert.equal(events.filter(event => event.type === 'member-wake-queued').length, 1);
  assert.match(transcript, /Preserve the original unique task context/);
  assert.match(transcript, /I cannot produce a usable structured action/);
  assert.equal(results[0].ok, true);
  assert.throws(() => runner.controlMember(0, true), /finished|no longer/);
});
