'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TeamNurse } = require('../agent/team-nurse.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');

function fixture(policy = null) {
  const personas = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const records = personas.map((persona, index) => ({
    id: `m${index}-${persona.id}`, name: persona.name, origin: 'roster',
    status: 'stalled', inbox: [], messagesReceived: 0, control: { paused: false },
    store: new MemoryStore(), loop: { running: false, turnResults: [] },
  }));
  const net = { stopped: false, paused: false, agents: new Map(records.map(rec => [rec.id, rec])), awaiting: new Map() };
  const results = records.map((rec, index) => ({
    index, name: rec.name, ok: false, status: 'stalled',
    error: 'The model stopped calling tools without task_complete.', output: 'Waiting for the other agent.',
  }));
  const stalled = new Map(results.map(result => [result.index, result.error]));
  const nurse = new TeamNurse({ personas, team: { members: [{}, {}] }, net, policy });
  return { nurse, net, records, results, stalled };
}

test('Nurse rescues an entirely stalled crew once from saved progress without certifying drafts', () => {
  const f = fixture();
  f.records[0].store.setTodos('m0-a', [{ text: 'Verify the patch', status: 'pending' }, { text: 'Read the file', status: 'completed' }]);
  f.records[1].loop.turnResults = [{ tool: 'read', path: 'src/index.js', ok: true }, { tool: 'edit', path: 'src/index.js', ok: true, pending: true }];
  const actions = f.nurse.stageRecoveries({ results: f.results, stalled: f.stalled, turns: [1, 1], maxTurns: 4 });
  assert.equal(actions.length, 2);
  assert.ok(actions.every(action => action.recoveryKind === 'protocol-rescue' && action.sourceNames.length === 0));
  const packet = f.records[0].inbox[0];
  assert.match(packet, /^TEAM NURSE RECOVERY/);
  assert.match(packet, /B: stalled/);
  assert.match(packet, /Verify the patch/);
  assert.doesNotMatch(packet, /- Read the file/);
  assert.match(packet, /read src\/index.js: tool succeeded/);
  assert.match(packet, /edit src\/index.js: awaiting review; not applied/);
  assert.match(packet, /unverified draft \(not a completed result\):\nWaiting for the other agent/);
  assert.doesNotMatch(packet, /New completed evidence/);
  for (const rec of f.records) rec.inbox = [];
  assert.equal(f.nurse.stageRecoveries({ results: f.results, stalled: f.stalled, turns: [2, 2], maxTurns: 4 }).length, 0);
  f.records[1].status = 'running';
  assert.equal(f.nurse.stageRecoveries({ results: f.results, stalled: f.stalled, turns: [2, 2], maxTurns: 4 }).length, 0, 'status churn cannot buy another saved-context rescue');
});

test('Nurse can use completed worker evidence after its initial protocol rescue', () => {
  const f = fixture();
  f.nurse.stageRecoveries({ results: f.results, stalled: new Map([[0, f.results[0].error]]), turns: [1, 1], maxTurns: 4 });
  f.records[0].inbox = [];
  f.net.agents.set('worker', {
    id: 'worker', name: 'Verifier', origin: 'spawned', status: 'completed', error: null,
    output: 'Verified the patch against the reproduction and the regression checks.', finishedAt: 100,
  });
  const actions = f.nurse.stageRecoveries({ results: f.results, stalled: new Map([[0, f.results[0].error]]), turns: [2, 1], maxTurns: 4 });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].recoveryKind, 'completed-evidence');
  assert.deepEqual(actions[0].sourceNames, ['Verifier']);
  assert.match(f.records[0].inbox[0], /FROM Verifier \(completed worker\)/);
  f.records[0].inbox = [];
  assert.equal(f.nurse.stageRecoveries({ results: f.results, stalled: f.stalled, turns: [3, 4], maxTurns: 4 }).length, 0, 'two wake cap and exhausted turns still apply');
});

test('A second protocol rescue requires newly recorded successful substantive work and remains capped', () => {
  for (const journaled of [false, true]) {
    const f = fixture();
    const evidence = [];
    if (journaled) f.net.journal = { evidence: agentId => evidence.filter(result => result.agentId === agentId) };
    const record = (tool, ok = true, pending = false) => {
      const seq = evidence.length + 1;
      const result = { agentId: 'm0-a', seq, tool, ok, pending, resultSha256: `result-${seq}` };
      evidence.push(result);
      f.records[0].loop.turnResults.push(result);
      f.records[0].store.appendMessage('m0-a', {
        role: 'tool', content: JSON.stringify(result), name: tool,
        _reachMeta: { source: 'tool', observationId: `observation-${seq}` },
      });
    };
    record('read');
    const stage = turns => f.nurse.stageRecoveries({ results: f.results, stalled: new Map([[0, f.results[0].error]]), turns: [turns, 1], maxTurns: 5 });
    assert.equal(stage(1).length, 1);
    f.records[0].inbox = [];
    f.results[0].output = 'Changed prose: I am still waiting.';
    for (const tool of ['agent.list', 'agent.status', 'agent.await', 'agent.send', 'agent.transcript']) record(tool);
    record('shell', false);
    record('write', true, true);
    assert.equal(stage(2).length, 0, 'polling, prose, failed tools and pending edits do not earn a second rescue');
    record('search');
    assert.equal(stage(2).length, 1, 'new actual successful work earns the second bounded rescue');
    assert.equal(f.nurse.meta().stagedWakes, 2);
    f.records[0].inbox = [];
    record('shell');
    assert.equal(stage(3).length, 0, 'new work cannot bypass the overall two-wake cap');
  }
});

test('Nurse excludes worker completion claims with unfinished plans, pending edits or no delivered answer', () => {
  for (const invalid of ['todos', 'edits', 'marker', 'error']) {
    const f = fixture();
    const store = new MemoryStore();
    const worker = { id: 'worker', name: 'Worker', origin: 'spawned', status: 'completed', error: null, output: 'Claimed done.', store };
    if (invalid === 'todos') store.setTodos('worker', [{ text: 'Still unfinished', status: 'pending' }]);
    if (invalid === 'edits') store.get('worker').pendingEdits = { edit1: {} };
    if (invalid === 'marker') worker.output = 'LINKS: COMPLETE';
    if (invalid === 'error') worker.error = 'Completion rejected.';
    f.net.agents.set(worker.id, worker);
    const actions = f.nurse.stageRecoveries({ results: f.results, stalled: new Map([[0, f.results[0].error]]) });
    assert.equal(actions.length, 1, invalid);
    assert.equal(actions[0].recoveryKind, 'protocol-rescue', invalid);
    assert.deepEqual(actions[0].sourceNames, [], invalid);
  }
});

test('Nurse never queues or counts an unlaunchable recovery after member turns are exhausted', () => {
  for (const completedEvidence of [false, true]) {
    const f = fixture();
    if (completedEvidence) f.results[1] = { ...f.results[1], ok: true, status: 'completed', error: null, output: 'Verified peer evidence.' };
    assert.equal(f.nurse.stageRecoveries({ results: f.results, stalled: new Map([[0, f.results[0].error]]), turns: [4, 1], maxTurns: 4 }).length, 0);
    assert.deepEqual(f.records[0].inbox, []);
    assert.equal(f.nurse.meta().stagedWakes, 0);
  }
});

test('Saved-context rescue respects Stop, user gates, active loops and provider quarantine', () => {
  for (const gate of ['stopped', 'team-paused', 'member-paused', 'waiting_input', 'waiting_edits', 'pending-edits', 'running', 'provider', 'transport']) {
    const f = fixture();
    if (gate === 'stopped') f.net.stopped = true;
    if (gate === 'team-paused') f.net.paused = true;
    if (gate === 'member-paused') f.records[0].control.paused = true;
    if (gate.startsWith('waiting_')) f.records[0].store.setRunState('m0-a', { status: gate });
    if (gate === 'pending-edits') f.records[0].store.get('m0-a').pendingEdits = { edit1: {} };
    if (gate === 'running') f.records[0].loop.running = true;
    const error = gate === 'provider' ? 'Endpoint returned HTTP 503: unavailable' : gate === 'transport' ? 'socket reset by a temporary network failure' : f.results[0].error;
    assert.equal(f.nurse.stageRecoveries({ results: f.results, stalled: new Map([[0, error]]), turns: [1, 1], maxTurns: 4 }).length, 0, gate);
    assert.equal(f.records[0].inbox.length, 0, gate);
    if (['provider', 'transport'].includes(gate)) assert.equal(f.nurse.meta().quarantined, 1, gate);
  }
});

test('Active-loop progress snapshots are bounded, truthful and do not spend Nurse wakes', () => {
  const f = fixture();
  f.records[0].status = 'running';
  f.records[0].loop.running = true;
  f.net.awaiting.set('m1-b', 'm0-a');
  f.records[0].store.appendMessage('m0-a', { role: 'assistant', content: 'My saved draft.' });
  const packet = f.nurse.progressContext('m0-a');
  assert.match(packet, /B: stalled; awaiting A/);
  assert.match(packet, /unverified draft.*\nMy saved draft\./);
  assert.match(packet, /continue independent work or use agent.await/);
  assert.equal(f.nurse.meta().stagedWakes, 0);
  assert.deepEqual(f.records[0].inbox, []);
  const bounded = fixture({ maxSourceChars: 200 });
  const shortPacket = bounded.nurse.progressContext('m0-a', 'x'.repeat(10000));
  assert.ok(shortPacket.length <= 200);
  assert.match(shortPacket, /^TEAM NURSE PROGRESS/);
  f.records[1].status = 'running';
  f.records[1].store.setRunState('m1-b', { status: 'waiting_edits' });
  assert.match(f.nurse.progressContext('m0-a'), /B: waiting_edits/, 'store state wins over a stale running roster status');
  f.net._peerStatus = peer => peer.id === 'm1-b' ? 'waiting_input' : peer.status;
  assert.match(f.nurse.progressContext('m0-a'), /B: waiting_input/, 'network effective status is authoritative when available');
  f.nurse.enabled = false;
  assert.equal(f.nurse.progressContext('m0-a'), '');
});
