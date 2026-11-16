'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TeamRunner } = require('../agent/team-runner.cjs');
const { AgentNet, netForAgent } = require('../agent/agent-net.cjs');

test('simultaneous Links runs with the same persona keep tools and cleanup in their own network', { timeout: 5000 }, async t => {
  let releaseBoth, finishA;
  const both = new Promise(resolve => { releaseBoth = resolve; });
  const aFinished = new Promise(resolve => { finishA = resolve; });
  const calls = { A: 0, B: 0 };
  let starts = 0, bTranscript = '';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(raw), name = body.model, turn = ++calls[name];
      let response;
      if (turn === 1) {
        if (++starts === 2) releaseBoth();
        await both;
        response = { status: 'actions', message: 'Record our finding.', actions: [{ name: 'agent.mail', arguments: { op: 'note', entry: 'note-' + name } }] };
      } else if (name === 'B' && turn === 2) {
        await aFinished;
        response = { status: 'actions', message: 'Read our notes after the other run ends.', actions: [{ name: 'agent.mail', arguments: { op: 'notes' } }] };
      } else {
        if (name === 'B') bTranscript = JSON.stringify(body.messages);
        response = { status: 'complete', message: 'Verified result for run ' + name + '.\nLINKS: COMPLETE', actions: [] };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...response, options: [] }) }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runners = ['A', 'B'].map(name => new TeamRunner({
    team: { name, mode: 'links', members: [{ personaId: 'same-persona' }] },
    personas: [{ id: 'same-persona', name: 'Shared persona', model: name }],
    task: 'Record and verify this run only.', endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    requestTimeoutMs: 2000, sendEvent() {},
  }));
  t.after(() => { for (const runner of runners) runner.stop(); releaseBoth(); finishA(); server.closeAllConnections(); server.close(); });
  const first = runners[0].run('isolation-A').finally(finishA);
  const second = runners[1].run('isolation-B');
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result[0].ok));
  assert.deepEqual(runners[0].net.notes.map(note => note.text), ['note-A']);
  assert.deepEqual(runners[1].net.notes.map(note => note.text), ['note-B']);
  assert.doesNotMatch(bTranscript, /not part of a crew|note-A/);
  assert.equal(netForAgent('m0-same-persona'), null, 'both completed runs release their registrations');
});

test('stopping a network releases only its own registrations', async () => {
  const first = new AgentNet(), second = new AgentNet();
  first.preRegister({ agentId: 'shared-fixture', name: 'First' });
  second.preRegister({ agentId: 'shared-fixture', name: 'Second' });
  try {
    assert.equal(netForAgent('shared-fixture'), null, 'ambiguous unscoped lookups must not route into an arbitrary run');
    first.stop();
    assert.equal(netForAgent('shared-fixture'), second);
    await first.settle();
    assert.equal(netForAgent('shared-fixture'), second, 'late cleanup cannot unregister another run');
    second.stop();
    assert.equal(netForAgent('shared-fixture'), null);
  } finally { first.stop(); second.stop(); await Promise.all([first.settle(), second.settle()]); }
});
