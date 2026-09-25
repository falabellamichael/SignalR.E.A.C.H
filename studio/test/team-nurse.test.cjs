'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TeamNurse,
  classifyFailure,
  recoveryScore,
} = require('../agent/team-nurse.cjs');
const { TeamRunner } = require('../agent/team-runner.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');

function nurseFixture({
  targetStatus = 'stalled',
  targetPaused = false,
  netPaused = false,
  targetInbox = [],
  policy = null,
  events = [],
} = {}) {
  const personas = [
    { id: 'target', name: 'Target' },
    { id: 'source', name: 'Source' },
  ];
  const target = {
    id: 'm0-target',
    name: 'Target',
    status: targetStatus,
    inbox: [...targetInbox],
    messagesReceived: targetInbox.length,
    control: { paused: targetPaused },
  };
  const source = {
    id: 'm1-source',
    name: 'Source',
    status: 'completed',
    inbox: [],
    messagesReceived: 0,
    control: { paused: false },
  };
  const net = { paused: netPaused, agents: new Map([[target.id, target], [source.id, source]]) };
  const team = { members: [{}, { roleId: 'coordinator' }] };
  const nurse = new TeamNurse({
    personas,
    team,
    net,
    policy,
    emit: (_type, payload) => events.push(payload),
  });
  return { nurse, personas, team, net, target, source, events };
}

function recoveryResults({
  targetStatus = 'stalled',
  targetError = 'The model returned an invalid action schema.',
  sourceOutput = `Verified coordinator evidence: ${'x'.repeat(220)}`,
} = {}) {
  return [
    { index: 0, name: 'Target', ok: false, status: targetStatus, output: '', error: targetError },
    { index: 1, name: 'Source', ok: true, status: 'completed', output: sourceOutput, error: null, completedAt: 10 },
  ];
}

test('Team Nurse classifies provider, protocol, exhausted transport, and work failures', () => {
  assert.equal(classifyFailure('Endpoint returned HTTP 401: unauthorized'), 'hard-provider');
  assert.equal(classifyFailure('Endpoint returned HTTP 500: internal error'), 'hard-provider');
  assert.equal(classifyFailure('model alpha was not found on this endpoint'), 'hard-provider');
  assert.equal(classifyFailure('structured recovery produced an invalid action schema'), 'protocol');
  assert.equal(classifyFailure('The model stopped calling tools without task_complete.'), 'protocol');
  assert.equal(classifyFailure('Completion rejected: the final response has no delivered answer.'), 'protocol');
  assert.equal(classifyFailure('socket reset by a temporary network failure'), 'transport');
  assert.equal(classifyFailure('the member could not reconcile the two reports'), 'recoverable');

  assert.equal(recoveryScore({ failureKind: 'hard-provider', hasNewEvidence: true }), Number.NEGATIVE_INFINITY);
  assert.equal(recoveryScore({ failureKind: 'transport', hasNewEvidence: true }), Number.NEGATIVE_INFINITY);
  assert.equal(recoveryScore({ failureKind: 'protocol', hasNewEvidence: false }), Number.NEGATIVE_INFINITY);
  assert.ok(recoveryScore({ failureKind: 'protocol', hasNewEvidence: true }) >= 8);
});

test('Nurse recovers rejected completion with new evidence and preserves drafts without counting them as completed', () => {
  const f = nurseFixture();
  const error = 'The model stopped calling tools without task_complete.';
  const results = recoveryResults({ targetError: error });
  results[0].output = 'Draft: the relay routes requests to configured model endpoints.';
  const stalled = new Map([[0, error]]);
  const staged = f.nurse.stageRecoveries({ results, stalled });
  assert.equal(staged.length, 1);
  assert.equal(staged[0].failureKind, 'protocol');
  assert.match(f.target.inbox[0], /task_complete/);
  assert.match(f.target.inbox[0], /Peer messages and plain-text completion claims cannot finish the team/);
  const handoff = f.nurse.synthesisHandoff(results, stalled);
  assert.match(handoff, /unverified draft, not a completed result/);
  assert.match(handoff, /Draft: the relay routes requests/);
  assert.doesNotMatch(handoff, /Target · completed/);
  f.nurse.recordWakeResult(0, { ok: true, status: 'stalled', output: 'LINKS: COMPLETE' });
  assert.equal(f.nurse.meta().wakeSucceeded, 0);
  f.target.inbox = [];
  assert.equal(f.nurse.stageRecoveries({ results, stalled }).length, 0, 'unchanged evidence cannot cause a retry loop');
});

test('Nurse never uses skipped, stalled or marker-only replies as completed recovery evidence', () => {
  for (const source of [
    { status: 'skipped', output: 'Still reading.' },
    { status: 'stalled', output: 'Sent the summary to peers.' },
    { status: 'completed', output: 'LINKS: COMPLETE' },
  ]) {
    const f = nurseFixture();
    const results = recoveryResults();
    results[1] = { ...results[1], ...source, ok: true };
    assert.equal(f.nurse.stageRecoveries({ results, stalled: new Map([[0, 'without task_complete']]) }).length, 0);
    assert.equal(f.target.inbox.length, 0);
  }
});

test('Team Nurse delivers each evidence revision once and permits genuinely new evidence', () => {
  const f = nurseFixture();
  const stalled = new Map([[0, 'invalid action schema']]);
  const turns = [1, 1];
  const results = recoveryResults();

  const first = f.nurse.stageRecoveries({ results, stalled, turns, maxTurns: 5 });
  assert.equal(first.length, 1);
  assert.equal(f.target.inbox.length, 1);
  assert.equal(f.nurse.meta().stagedWakes, 1);
  f.nurse.recordWakeStarted(0);
  f.nurse.recordWakeResult(0, { ok: true, status: 'completed', output: 'The requested fix is implemented.' });
  assert.equal(f.nurse.meta().wakeStarted, 1);
  assert.equal(f.nurse.meta().wakeSucceeded, 1);

  // Simulate the scheduler consuming the staged handoff. The same evidence
  // revision must not manufacture another model turn.
  f.target.inbox = [];
  const duplicate = f.nurse.stageRecoveries({ results, stalled, turns, maxTurns: 5 });
  assert.equal(duplicate.length, 0);
  assert.equal(f.target.inbox.length, 0);
  assert.equal(f.nurse.meta().stagedWakes, 1);
  assert.equal(f.nurse.meta().suppressed, 1);

  // A changed source report is a new evidence revision. Protocol recovery with
  // a substantive Coordinator source is eligible for the second bounded wake.
  results[1] = { ...results[1], output: results[1].output + '\nRevision two adds the missing proof.' };
  const revised = f.nurse.stageRecoveries({ results, stalled, turns, maxTurns: 5 });
  assert.equal(revised.length, 1);
  assert.equal(f.target.inbox.length, 1);
  assert.equal(f.nurse.meta().stagedWakes, 2);
});

test('Team Nurse coalesces delivered sources and a newer tiny note cannot shadow strong evidence', () => {
  const personas = [
    { id: 'target', name: 'Target' },
    { id: 'strong', name: 'StrongCoordinator' },
    { id: 'tiny', name: 'TinyPeer' },
  ];
  const records = personas.map((persona, index) => ({
    id: `m${index}-${persona.id}`, name: persona.name,
    status: index ? 'completed' : 'stalled', inbox: [], messagesReceived: 0,
    control: { paused: false },
  }));
  const net = { paused: false, agents: new Map(records.map(record => [record.id, record])) };
  const events = [];
  const nurse = new TeamNurse({
    personas,
    team: { members: [{}, { roleId: 'coordinator' }, {}] },
    net,
    policy: { maxSourceChars: 5000 },
    emit: (_type, payload) => events.push(payload),
  });
  const results = [
    { index: 0, name: 'Target', ok: false, status: 'stalled', output: '', error: 'ordinary work failure' },
    { index: 1, name: 'StrongCoordinator', ok: true, status: 'completed', output: `verified proof ${'x'.repeat(240)}`, completedAt: 10 },
    { index: 2, name: 'TinyPeer', ok: true, status: 'completed', output: 'new', completedAt: 20 },
  ];
  const planned = nurse.stageRecoveries({
    results,
    stalled: new Map([[0, 'ordinary work failure']]),
    turns: [1, 1, 1],
    maxTurns: 5,
  });

  assert.equal(planned.length, 1, 'the eligible strong source wins even though the tiny source is newer');
  assert.deepEqual(planned[0].sourceNames, ['StrongCoordinator', 'TinyPeer']);
  assert.match(records[0].inbox[0], /verified proof/);
  assert.match(records[0].inbox[0], /FROM TinyPeer\nnew/);

  // With a tight packet cap only the strong source is actually delivered.
  // Mutating an excluded source must not manufacture a novel recovery packet.
  const capped = new TeamNurse({
    personas,
    team: { members: [{}, { roleId: 'coordinator' }, {}] },
    net,
    policy: { maxSourceChars: 80 },
    emit: () => {},
  });
  records[0].inbox = [];
  assert.equal(capped.stageRecoveries({ results, stalled: new Map([[0, 'ordinary work failure']]), turns: [1, 1, 1], maxTurns: 5 }).length, 1);
  assert.doesNotMatch(records[0].inbox[0], /TinyPeer/);
  records[0].inbox = [];
  results[2] = { ...results[2], output: 'different excluded note', completedAt: 30 };
  assert.equal(capped.stageRecoveries({ results, stalled: new Map([[0, 'ordinary work failure']]), turns: [1, 1, 1], maxTurns: 5 }).length, 0);
});

test('Team Nurse enforces its per-member wake cap across new evidence revisions', () => {
  const f = nurseFixture({ policy: { maxAutoWakesPerMember: 1, minRecoveryScore: 0 } });
  const stalled = new Map([[0, 'invalid action schema']]);
  const turns = [1, 1];
  const results = recoveryResults();

  assert.equal(f.nurse.stageRecoveries({ results, stalled, turns, maxTurns: 5 }).length, 1);
  f.target.inbox = [];
  results[1] = { ...results[1], output: results[1].output + '\nA different verified revision.' };
  assert.equal(f.nurse.stageRecoveries({ results, stalled, turns, maxTurns: 5 }).length, 0);
  assert.equal(f.nurse.meta().stagedWakes, 1);
  assert.equal(f.nurse.meta().suppressed, 1);
});

test('Team Nurse quarantines hard provider failures without staging a wake', () => {
  const f = nurseFixture();
  const stalled = new Map([[0, 'Endpoint returned HTTP 401: unauthorized']]);
  const results = recoveryResults({ targetError: stalled.get(0) });

  assert.equal(f.nurse.stageRecoveries({ results, stalled, turns: [1, 1], maxTurns: 5 }).length, 0);
  assert.equal(f.target.inbox.length, 0);
  assert.equal(f.nurse.meta().quarantined, 1);
  assert.equal(f.events.filter(event => event.action === 'quarantine').length, 1);

  // Re-observing the same hard failure is silent; quarantine telemetry is not
  // a periodic error stream.
  assert.equal(f.nurse.stageRecoveries({ results, stalled, turns: [1, 1], maxTurns: 5 }).length, 0);
  assert.equal(f.events.filter(event => event.action === 'quarantine').length, 1);
});

test('Team Nurse defers to an intentional peer inbox instead of duplicating it', () => {
  const peerMessage = 'MESSAGE FROM Source (a crew member):\nUse the verified branch result.';
  const f = nurseFixture({ targetInbox: [peerMessage] });
  const stalled = new Map([[0, 'invalid action schema']]);

  assert.equal(f.nurse.stageRecoveries({
    results: recoveryResults(),
    stalled,
    turns: [1, 1],
    maxTurns: 5,
  }).length, 0);
  assert.deepEqual(f.target.inbox, [peerMessage]);
  assert.equal(f.nurse.meta().stagedWakes, 0);
  assert.equal(f.nurse.meta().suppressed, 1);
});

test('Team Nurse never auto-wakes user-gated or user-paused members', () => {
  for (const state of [
    { status: 'waiting_input', error: 'Which environment should I use?', paused: false },
    { status: 'waiting_edits', error: 'Review the proposed edits.', paused: false },
    { status: 'stalled', error: 'invalid action schema', paused: true },
    { status: 'stalled', error: 'invalid action schema', paused: false, netPaused: true },
  ]) {
    const f = nurseFixture({ targetStatus: state.status, targetPaused: state.paused, netPaused: state.netPaused });
    const results = recoveryResults({ targetStatus: state.status, targetError: state.error });
    // Pass the observation defensively even if a caller accidentally retains a
    // stale stalled-map entry. The Nurse itself must preserve the user gate.
    const planned = f.nurse.stageRecoveries({
      results,
      stalled: new Map([[0, state.error]]),
      turns: [1, 1],
      maxTurns: 5,
    });
    assert.equal(planned.length, 0, `${state.status} must not be auto-woken`);
    assert.equal(f.target.inbox.length, 0, `${state.status} must not receive a synthetic handoff`);
    assert.equal(f.nurse.meta().stagedWakes, 0);
  }
});

test('a globally paused team holds a queued Nurse wake until explicit resume', async () => {
  const events = [];
  const persona = { id: 'target', name: 'Target', model: 'model-a', prompt: 'Recover.' };
  const runner = new TeamRunner({
    team: { id: 'paused-team', name: 'Paused', mode: 'links', members: [{ personaId: persona.id }] },
    personas: [persona],
    task: 'Finish the task.',
    endpoint: 'http://127.0.0.1:9/v1',
    defaultModel: persona.model,
    sendEvent: (_channel, event) => events.push(event),
  });
  runner.teamRunId = 'paused-run';
  const key = 'm0-target';
  runner.memberStores.set(key, new MemoryStore());
  runner.loops.set(key, { running: false, stop() {} });
  const rec = { id: key, name: persona.name, status: 'stalled', inbox: [], messagesReceived: 0 };
  runner.net = {
    agents: new Map([[key, rec]]),
    syncMember(_id, update) { Object.assign(rec, update); },
    pause() {},
    resume() {},
    workersPaused() { return true; },
  };
  let driveCalls = 0;
  runner._drive = async () => { driveCalls++; return { status: 'completed' }; };
  runner._harvest = () => ({
    index: 0, name: persona.name, model: persona.model,
    ok: true, output: 'Recovered.', status: 'completed', error: null,
  });

  runner.userPaused = true;
  runner.paused = true;
  runner.controls[0].finished = true;
  const waking = runner._wakeMember(0, ['TEAM NURSE RECOVERY\nnew evidence']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(driveCalls, 0, 'no provider turn starts while the user pause is active');
  assert.equal(events.filter(event => event.type === 'member-start').length, 0, 'a held wake does not claim it started');

  runner.resume();
  const result = await waking;
  assert.equal(driveCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(events.filter(event => event.type === 'member-start').length, 1, 'resume starts the queued wake exactly once');
});

test('Team Nurse synthesis handoff is bounded and records its lifecycle stats', () => {
  const f = nurseFixture({ policy: { maxSourceChars: 32, maxSynthesisChars: 240 } });
  const longOutput = 'A'.repeat(200);
  const handoff = f.nurse.synthesisHandoff([
    { index: 0, name: 'Target', ok: true, status: 'completed', output: longOutput },
  ], new Map(), [
    { agentId: 'net-worker', name: 'Worker', origin: 'spawned', status: 'completed', output: 'late worker proof' },
    { agentId: 'net-failed', name: 'FailedWorker', origin: 'spawned', status: 'failed', output: 'ignore this' },
  ], [
    { name: 'CappedMember', messages: ['MESSAGE FROM Peer:\nturn-cap evidence'] },
  ]);

  assert.match(handoff, /TEAM NURSE HANDOFF/);
  assert.match(handoff, new RegExp('A{32}'));
  assert.doesNotMatch(handoff, new RegExp('A{33}'));
  assert.match(handoff, /Worker · completed worker/);
  assert.match(handoff, /late worker proof/);
  assert.doesNotMatch(handoff, /FailedWorker/);
  assert.match(handoff, /CappedMember · queued crew information/);
  assert.match(handoff, /turn-cap/);
  assert.equal(f.nurse.meta().handoffs, 3);
  assert.equal(f.nurse.meta().pulses, 0);

  f.nurse.stageRecoveries({ results: [], stalled: new Map(), turns: [], maxTurns: 5 });
  const meta = f.nurse.meta();
  assert.equal(meta.pulses, 1);
  assert.equal(meta.handoffs, 3);
  assert.equal(meta.enabled, true);
  assert.ok(meta.formula);
});
