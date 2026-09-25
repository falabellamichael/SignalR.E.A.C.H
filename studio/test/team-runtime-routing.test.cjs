'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TeamRunner } = require('../agent/team-runner.cjs');

const action = (status, message, actions = [], options = []) =>
  JSON.stringify({ status, message, actions, options });

function jsonReply(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}

async function waitUntil(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function fixture() {
  const calls = { list: [], messages: [], spawns: [], cancelled: [] };
  const runner = new TeamRunner({
    team: { name: 'Runtime crew', mode: 'links', members: [{ personaId: 'p1' }] },
    personas: [{ id: 'p1', name: 'Planner' }],
    task: 'Ship the feature',
    sendEvent: () => {},
  });
  runner.teamRunId = 'teamrun-fixture';
  runner.acceptingRuntimeAgents = true;
  runner.net = {
    agents: new Map(),
    activeTasks: new Map(),
    list(callerId) {
      calls.list.push(callerId);
      return { ok: true, team: 'Runtime crew', count: 1, maxAgents: 8, agents: [{ agentId: 'm0-p1', name: 'Planner', status: 'running' }] };
    },
    sendFromUser(payload) {
      calls.messages.push(payload);
      return { ok: true, deliveredTo: 'm0-p1' };
    },
    spawn(payload) {
      calls.spawns.push(payload);
      return { ok: true, agentId: 'agent-runtime-1', name: payload.name, model: payload.model, queued: true };
    },
    cancelQueuedSpawned(agentId, reason) {
      calls.cancelled.push({ agentId, reason });
      const rec = this.agents.get(agentId);
      if (!rec || rec.status !== 'queued') return false;
      rec.status = 'skipped';
      return true;
    },
  };
  return { runner, calls };
}

test('operator status and messages use the live network without impersonating a member', () => {
  const { runner, calls } = fixture();
  const status = runner.members();
  assert.equal(status.ok, true);
  assert.equal(status.teamRunId, 'teamrun-fixture');
  assert.equal(status.mode, 'links');
  assert.equal(status.paused, false);
  assert.deepEqual(calls.list, ['__user__']);

  const sent = runner.messageMember('m0-p1', 'Use the new evidence.');
  assert.equal(sent.ok, true);
  assert.deepEqual(calls.messages, [{ to: 'm0-p1', message: 'Use the new evidence.' }]);

  runner.acceptingRuntimeAgents = false;
  assert.match(runner.messageMember('m0-p1', 'Too late').error, /finalizing/i);
  assert.equal(calls.messages.length, 1);
});

test('run-only agents receive resolved routing and never mutate the saved roster', () => {
  const { runner, calls } = fixture();
  const rosterBefore = structuredClone(runner.team.members);
  const result = runner.addRuntimeAgent({
    name: 'Reviewer',
    model: 'qwen/reviewer',
    prompt: 'Review every claim.',
    role: 'skeptical auditor',
    task: 'Check the current patch.',
    endpoint: 'http://127.0.0.1:11434/v1',
    accessKey: 'fixture-secret',
  });

  assert.equal(result.ok, true);
  assert.equal(result.transient, true);
  assert.match(result.note, /saved team roster is unchanged/i);
  assert.deepEqual(runner.team.members, rosterBefore);
  assert.deepEqual(calls.spawns, [{
    name: 'Reviewer',
    model: 'qwen/reviewer',
    prompt: 'Review every claim.\n\nYOUR ROLE ON THIS RUN: skeptical auditor',
    task: 'Check the current patch.',
    parentId: null,
    depth: 0,
    callerName: 'You',
    endpoint: 'http://127.0.0.1:11434/v1',
    accessKey: 'fixture-secret',
    deferStart: true,
    operatorAdded: true,
    // No saved persona was adopted, so no identity is claimed: the net derives
    // one for the helper from its parent (or creates none at all).
    soulKey: '',
  }]);

  runner.paused = true;
  assert.match(runner.addRuntimeAgent({ name: 'Late helper' }).error, /resume the team/i);
  assert.equal(calls.spawns.length, 1);

  runner.paused = false;
  runner.team.mode = 'parallel';
  assert.match(runner.addRuntimeAgent({ name: 'Parallel helper' }).error, /Links teams/i);
  assert.equal(calls.spawns.length, 1);
});

test('a helper adopted from a saved persona joins with its persona identity', () => {
  // The operator-adds-an-agent path: when the helper IS a saved persona, it
  // arrives with that persona's own SOUL.md + MEMORY.md rather than as an
  // anonymous worker with derived files. The identity is passed straight
  // through to the net, which is where the key is honoured (and validated).
  const { runner, calls } = fixture();
  const result = runner.addRuntimeAgent({
    name: 'Auditor',
    prompt: 'You audit.',
    task: 'Check the patch.',
    soulKey: 'persona-auditor',
  });

  assert.equal(result.ok, true);
  assert.equal(calls.spawns.length, 1);
  assert.equal(calls.spawns[0].soulKey, 'persona-auditor');
  // Everything else about the helper is unchanged by the identity.
  assert.equal(calls.spawns[0].deferStart, true);
  assert.equal(calls.spawns[0].operatorAdded, true);
  assert.equal(calls.spawns[0].parentId, null);
});

test('Links completion closes operator mail and helper admission immediately', () => {
  const { runner, calls } = fixture();
  runner._linkDeclared = { by: 'Planner', index: 0 };
  assert.match(runner.messageMember('m0-p1', 'One more thing').error, /finalizing/i);
  assert.match(runner.addRuntimeAgent({ name: 'Too late' }).error, /finalizing/i);
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.spawns.length, 0);
});

test('Links conclusion skips operator helpers that never received a concurrency slot', t => {
  const { runner, calls } = fixture();
  runner.net.agents.set('queued-helper', {
    id: 'queued-helper', origin: 'spawned', operatorAdded: true, status: 'queued',
  });
  t.after(() => {
    if (runner._linksConclusionTimer) clearTimeout(runner._linksConclusionTimer);
  });

  runner._concludeLinkPeers('m0-p1', 'Planner');

  assert.equal(runner.acceptingRuntimeAgents, false);
  assert.equal(runner.net.agents.get('queued-helper').status, 'skipped');
  assert.equal(calls.cancelled.length, 1);
  assert.equal(calls.cancelled[0].agentId, 'queued-helper');
  assert.match(calls.cancelled[0].reason, /completed before this helper started/i);
});

test('operator-added Links helper shares the roster concurrency slot', async t => {
  const requests = [];
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  let releaseSecondRoster;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondRosterGate = new Promise(resolve => { releaseSecondRoster = resolve; });
  const server = require('node:http').createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      const requestIndex = requests.push(body) - 1;
      active++;
      maxActive = Math.max(maxActive, active);
      if (requestIndex === 0) await firstGate;
      if (requestIndex === 2) await secondRosterGate;
      const transcript = JSON.stringify(body.messages || []);
      const message = transcript.includes('Follow up after completion')
        ? 'The added helper finished its scheduled follow-up.'
        : transcript.includes('Check queued capacity')
          ? 'The added helper finished.'
        : requestIndex === 0 ? 'The roster member finished.' : 'Final crew synthesis.';
      jsonReply(res, action('complete', message));
      active--;
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const runner = new TeamRunner({
    team: {
      name: 'Capped crew', mode: 'links', nurse: false,
      members: [{ personaId: 'p1' }, { personaId: 'p2' }],
    },
    personas: [{ id: 'p1', name: 'Planner' }, { id: 'p2', name: 'Builder' }],
    task: 'Prove helper scheduling.',
    endpoint,
    defaultModel: 'fixture-model',
    concurrency: 1,
    sendEvent: () => {},
  });

  const running = runner.run('teamrun-cap');
  await waitUntil(() => requests.length === 1, 'initial roster request did not start');
  const added = runner.addRuntimeAgent({ name: 'Reviewer', task: 'Check queued capacity.' });
  assert.equal(added.ok, true);
  assert.equal(added.queued, true);
  assert.equal(runner.net.agents.get(added.agentId).status, 'queued');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(requests.length, 1, 'helper must not start while the roster owns the only slot');

  releaseFirst();
  await waitUntil(() => requests.length >= 2, 'queued helper did not start when roster capacity freed');
  assert.match(JSON.stringify(requests[1].messages || []), /Check queued capacity/);
  await waitUntil(
    () => requests.length >= 3 && runner.net.agents.get(added.agentId).status === 'completed',
    'second roster member did not take the slot after the helper completed',
  );

  const followUp = runner.messageMember(added.agentId, 'Follow up after completion.');
  assert.equal(followUp.ok, true);
  assert.equal(followUp.delivered, 'pending-start');
  assert.equal(runner.net.agents.get(added.agentId).status, 'queued');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(requests.length, 3, 'completed helper follow-up must wait while a roster member owns the slot');

  releaseSecondRoster();
  await waitUntil(() => requests.length >= 4, 'completed helper follow-up did not start when capacity freed');
  assert.match(JSON.stringify(requests[3].messages || []), /Follow up after completion/);
  await running;

  assert.equal(maxActive, 1, 'roster and operator helper must never exceed configured concurrency');
  assert.equal(runner.net.agents.get(added.agentId).status, 'completed');
});
