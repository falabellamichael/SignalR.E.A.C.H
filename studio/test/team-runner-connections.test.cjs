'use strict';

/* Per-member endpoint routing through the real team runtime.
 *
 * team-connections.test.cjs covers the pure resolution table. These tests cover
 * the two things that can only break in the wiring:
 *
 *  1. TeamRunner actually hands each member its OWN endpoint/key/model to the
 *     AgentLoop (and to the `start` event the UI renders), instead of the
 *     team-wide defaults.
 *  2. A subagent spawned by a pinned member inherits that member's provider, so
 *     the helper does not land on an endpoint that lacks its model.
 *
 * Plus a guard on the failure mode that motivated (2): access keys now live on
 * agent-net records, and those records are read by agent.list / agent.status /
 * snapshot, which return data TO THE MODEL. If any of them ever switches to
 * spreading the record, the key leaks into a prompt.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentNet } = require('../agent/agent-net.cjs');
const TeamRunner = (() => {
  const m = require('../agent/team-runner.cjs');
  return m.TeamRunner || m;
})();

/** Minimal settings-free resolutions, shaped like team-connections output. */
function resolutions(specs) {
  return specs.map((s, i) => ({
    index: i,
    personaId: s.id,
    connectionId: 'conn_' + s.tag,
    connectionName: s.tag,
    endpoint: `https://${s.tag}.example.com/v1`,
    accessKey: s.key,
    model: s.model,
    reason: 'spread',
    pinnedConnectionId: '',
  }));
}

const persona = (id, extra = {}) => ({ id, name: 'P-' + id, model: '', prompt: '', ...extra });

function makeRunner({ memberConnections, personas, endpoint = 'https://default.example.com/v1', accessKey = 'DEFAULT-FIXTURE', defaultModel = 'default-model' }) {
  const events = [];
  return {
    events,
    runner: new TeamRunner({
      team: { id: 'team-1', name: 'Crew', mode: 'parallel', members: [] },
      personas,
      roles: [],
      task: 'do the thing',
      projectDir: '',
      endpoint,
      accessKey,
      defaultModel,
      memberConnections,
      sendEvent: (channel, payload) => events.push({ channel, payload }),
      requestApproval: () => Promise.resolve(true),
      reachExecutor: () => ({ ok: true }),
      browserExecutor: () => ({ ok: true }),
      budgets: null,
      agentSettings: {},
    }),
  };
}

/* ------------------------------------------------- TeamRunner._memberConn --- */

test('_memberConn returns each member own endpoint, key and model', () => {
  const { runner } = makeRunner({
    memberConnections: resolutions([
      { id: 'p1', tag: 'a', key: 'A-FIXTURE', model: 'm-a' },
      { id: 'p2', tag: 'b', key: 'B-FIXTURE', model: 'm-b' },
    ]),
    personas: [persona('p1'), persona('p2')],
  });
  const c0 = runner._memberConn(0);
  const c1 = runner._memberConn(1);
  assert.equal(c0.endpoint, 'https://a.example.com/v1');
  assert.equal(c0.accessKey, 'A-FIXTURE');
  assert.equal(c0.model, 'm-a');
  assert.equal(c1.endpoint, 'https://b.example.com/v1');
  assert.equal(c1.accessKey, 'B-FIXTURE');
  assert.equal(c1.model, 'm-b');
  assert.notEqual(c0.endpoint, c1.endpoint, 'members must not share an endpoint');
});

test('_memberConn falls back to team-wide values when nothing was resolved', () => {
  // Direct construction (older callers, unit tests) passes no memberConnections.
  const { runner } = makeRunner({ memberConnections: null, personas: [persona('p1')] });
  const c = runner._memberConn(0);
  assert.equal(c.endpoint, 'https://default.example.com/v1');
  assert.equal(c.accessKey, 'DEFAULT-FIXTURE');
  assert.equal(c.model, 'default-model');
});

test('fallback keeps a persona model override (pre-feature behaviour)', () => {
  // No memberConnections means "one endpoint for the crew", but each persona's
  // OWN model must still win — that was always the rule, and a regression here
  // silently sent every member the team default. The personas have DIFFERENT
  // models to prove it is per-member, not a single shared fallback.
  const { runner } = makeRunner({
    memberConnections: null,
    personas: [persona('p1', { model: 'm1' }), persona('p2', { model: 'm2' })],
    defaultModel: 'm0',
  });
  assert.equal(runner._memberConn(0).model, 'm1');
  assert.equal(runner._memberConn(1).model, 'm2');
  assert.notEqual(runner._memberConn(0).model, runner._memberConn(1).model, 'each member keeps its own model');
});

test('_memberConn falls back for an out-of-range or endpoint-less entry', () => {
  const { runner } = makeRunner({
    memberConnections: [{ index: 0, endpoint: '', accessKey: '', model: '', reason: 'none' }],
    personas: [persona('p1'), persona('p2')],
  });
  // Entry 0 resolved to nothing usable; entry 1 does not exist at all.
  assert.equal(runner._memberConn(0).endpoint, 'https://default.example.com/v1');
  assert.equal(runner._memberConn(1).endpoint, 'https://default.example.com/v1');
  assert.equal(runner._memberConn(99).endpoint, 'https://default.example.com/v1', 'never throws out of range');
});

test('the start event reports each member own model and connection, never a key', () => {
  const { runner, events } = makeRunner({
    memberConnections: resolutions([
      { id: 'p1', tag: 'a', key: 'SECRET-A-FIXTURE', model: 'm-a' },
      { id: 'p2', tag: 'b', key: 'SECRET-B-FIXTURE', model: 'm-b' },
    ]),
    personas: [persona('p1'), persona('p2')],
  });
  runner.teamRunId = 'run-1';
  // Emit the same payload run() builds, without performing the network work.
  runner._emit('start', {
    teamName: runner.team.name,
    mode: 'parallel',
    members: runner.personas.map((p, i) => {
      const conn = runner._memberConn(i);
      return { index: i, name: p.name, model: conn.model, role: runner.roleOf(i), connectionName: conn.connectionName, connectionReason: conn.reason };
    }),
    task: runner.task,
  });
  const ev = events.find(e => e.payload && e.payload.type === 'start');
  assert.ok(ev, 'start event was emitted');
  assert.deepEqual(ev.payload.members.map(m => m.model), ['m-a', 'm-b']);
  assert.deepEqual(ev.payload.members.map(m => m.connectionName), ['a', 'b']);
  const blob = JSON.stringify(ev.payload);
  assert.ok(!blob.includes('SECRET-A-FIXTURE'), 'an access key must never reach the renderer');
  assert.ok(!blob.includes('SECRET-B-FIXTURE'));
});

/* ------------------------------------------- AgentNet subagent inheritance --- */

function makeNet({ endpoint = 'https://default.example.com/v1', accessKey = 'DEFAULT-FIXTURE', defaultModel = 'default-model' } = {}) {
  const events = [];
  const net = new AgentNet({
    teamRunId: 'run-1',
    teamName: 'Crew',
    endpoint,
    accessKey,
    defaultModel,
    projectDir: '',
    agentSettings: {},
    sendEvent: (channel, payload) => events.push({ channel, payload }),
    requestApproval: () => Promise.resolve(true),
    budgets: null,
    onSettled: () => {},
  });
  return { net, events };
}

test('a roster member registered with its own routing is recorded', () => {
  const { net } = makeNet();
  net.preRegister({
    agentId: 'm0-p1', name: 'Pinned', model: 'm-b', prompt: '', depth: 0, task: 't',
    endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE',
  });
  const rec = net.agents.get('m0-p1');
  assert.equal(rec.endpoint, 'https://b.example.com/v1');
  assert.equal(rec.accessKey, 'B-FIXTURE');
  assert.equal(rec.model, 'm-b');
});

test('preRegister without routing keeps empty strings so the net default applies', () => {
  const { net } = makeNet();
  net.preRegister({ agentId: 'm0-p2', name: 'Plain', model: '', prompt: '', depth: 0, task: 't' });
  const rec = net.agents.get('m0-p2');
  assert.equal(rec.endpoint, '');
  assert.equal(rec.accessKey, '');
});

test('a subagent inherits the PARENT member endpoint, key and model', () => {
  const { net } = makeNet();
  net.preRegister({
    agentId: 'm0-p1', name: 'Pinned', model: 'm-b', prompt: '', depth: 0, task: 't',
    endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE',
  });
  const spawned = net.spawn({ name: 'Helper', task: 'help out', parentId: 'm0-p1', depth: 1 });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const rec = net.agents.get(spawned.agentId);
  assert.equal(rec.endpoint, 'https://b.example.com/v1', 'helper must run on the parent provider');
  assert.equal(rec.accessKey, 'B-FIXTURE');
  assert.equal(rec.model, 'm-b', 'inherits the parent model: the global default may not exist on that endpoint');
});

test('a grandchild inherits too', () => {
  const { net } = makeNet();
  net.preRegister({
    agentId: 'm0-p1', name: 'Pinned', model: 'm-b', prompt: '', depth: 0, task: 't',
    endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE',
  });
  const child = net.spawn({ name: 'Helper', task: 'x', parentId: 'm0-p1', depth: 1 });
  const grand = net.spawn({ name: 'SubHelper', task: 'y', parentId: child.agentId, depth: 2 });
  assert.equal(grand.ok, true, JSON.stringify(grand));
  const rec = net.agents.get(grand.agentId);
  assert.equal(rec.endpoint, 'https://b.example.com/v1');
  assert.equal(rec.model, 'm-b');
});

test('a spawn with no parent uses the network default', () => {
  const { net } = makeNet();
  const spawned = net.spawn({ name: 'Orphan', task: 'x', depth: 1 });
  assert.equal(spawned.ok, true);
  const rec = net.agents.get(spawned.agentId);
  assert.equal(rec.endpoint, 'https://default.example.com/v1');
  assert.equal(rec.model, 'default-model');
});

test('an explicitly named model still wins over inheritance', () => {
  const { net } = makeNet();
  net.preRegister({
    agentId: 'm0-p1', name: 'Pinned', model: 'm-b', prompt: '', depth: 0, task: 't',
    endpoint: 'https://b.example.com/v1', accessKey: 'B-FIXTURE',
  });
  const spawned = net.spawn({ name: 'Helper', model: 'chosen-model', task: 'x', parentId: 'm0-p1', depth: 1 });
  assert.equal(net.agents.get(spawned.agentId).model, 'chosen-model');
  assert.equal(net.agents.get(spawned.agentId).endpoint, 'https://b.example.com/v1', 'endpoint still inherited');
});

/* ------------------------------------------------ the model-facing leak guard --- */

test('agent.list / status / snapshot never expose endpoint or accessKey to the model', () => {
  const { net } = makeNet();
  net.preRegister({
    agentId: 'm0-p1', name: 'Pinned', model: 'm-b', prompt: '', depth: 0, task: 't',
    endpoint: 'https://secret-host.example.com/v1', accessKey: 'LEAK-CANARY-FIXTURE',
  });

  const listed = net.list('m0-p1');
  const status = net.status('m0-p1', 'm0-p1');
  const snap = net.snapshot();

  for (const [label, value] of [['list', listed], ['status', status], ['snapshot', snap]]) {
    const blob = JSON.stringify(value);
    assert.ok(!blob.includes('LEAK-CANARY-FIXTURE'), `${label} leaked the access key`);
    assert.ok(!blob.includes('secret-host'), `${label} leaked the endpoint`);
    assert.ok(!/"accessKey"/.test(blob), `${label} exposed an accessKey field`);
    assert.ok(!/"endpoint"/.test(blob), `${label} exposed an endpoint field`);
  }
  // Sanity: the tools still return the useful identity fields.
  assert.equal(listed.agents[0].name, 'Pinned');
  assert.equal(status.model, 'm-b');
  assert.equal(snap[0].agentId, 'm0-p1');
});
