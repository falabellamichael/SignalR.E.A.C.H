'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { TeamRunner } = require('../agent/team-runner.cjs');
const { AgentNet } = require('../agent/agent-net.cjs');
const { defaults } = require('../agent/budgets.cjs');

test('an Auto mask removes prompt tools without changing saved controls or permissions', () => {
  const store = new MemoryStore(), agent = store.get('a');
  agent.settings = { features: { terminal: true, workspace: true, web: false }, approvals: 'prompt', reviewEdits: true, disabledTools: ['write'] };
  agent.runState = { structuredActions: true };
  const before = structuredClone(agent.settings);
  const loop = new AgentLoop({ store, agentId: 'a', featureMask: { terminal: false, workspace: false, web: true } });
  assert.doesNotMatch(loop._buildSystemPrompt(), /"name":"shell"|"name":"read"|"name":"websearch"/);
  assert.equal(loop._settings().features.web, false, 'Auto cannot grant a feature the user disabled');
  assert.deepEqual(agent.settings, before);
  assert.equal(loop._settings().approvals, 'prompt');
  assert.equal(loop._settings().reviewEdits, true);
  const manual = new AgentLoop({ store, agentId: 'a' });
  assert.equal(manual._settings().features.workspace, true, 'a later manual turn keeps the saved choice');
});

test('a model-emitted tool excluded by Auto is refused by real loop dispatch', async () => {
  const store = new MemoryStore(), events = [];
  const loop = new AgentLoop({ store, agentId: 'a', projectDir: 'unused',
    featureMask: { workspace: false }, budgets: { ...defaults, autoCompact: false },
    sendEvent: (_channel, event) => events.push(event) });
  const replies = [
    { content: JSON.stringify({ status: 'actions', message: 'Read a file.', actions: [{ name: 'read', arguments: { path: 'private.txt' } }], options: [] }) },
    { content: JSON.stringify({ status: 'complete', message: 'Answered without project files.', actions: [], options: [] }) },
  ];
  loop._budgetedAnswer = async () => replies.shift() || assert.fail('Unexpected model round');
  await loop.sendUserMessage('Answer this general question.');
  const result = events.find(event => event.type === 'tool-result');
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled/);
  assert.equal(store.get('a').settings.features, undefined, 'temporary choice was not persisted');
});

test('live user restrictions still revoke an Auto-permitted tool during approval', async () => {
  const store = new MemoryStore();
  store.get('a').settings.features = { terminal: true };
  const loop = new AgentLoop({ store, agentId: 'a', featureMask: { terminal: true } });
  const result = await runToolCall('a', 'reach.run', {}, {
    agentStore: store, getSettings: () => loop._settings(),
    requestApproval: async () => { store.get('a').settings.features.terminal = false; return true; },
    reachExecutor: () => assert.fail('A revoked tool must not execute'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled/);
});

test('Auto masks reach both team members and spawned workers while original settings remain intact', async () => {
  const seen = [], original = AgentLoop.prototype.sendUserMessage;
  AgentLoop.prototype.sendUserMessage = async function () {
    seen.push({ effective: structuredClone(this._settings()), saved: structuredClone(this._agent().settings) });
    this.store.appendMessage(this.agentId, { role: 'assistant', content: 'done' });
    this.store.setRunState(this.agentId, { status: 'completed' });
  };
  try {
    const settings = { features: { terminal: true, workspace: true }, approvals: 'prompt', reviewEdits: true };
    const runner = new TeamRunner({ team: { name: 'Fixture', mode: 'parallel', members: [{ personaId: 'p' }] },
      personas: [{ id: 'p', name: 'Worker' }], task: 'fixture', agentSettings: settings,
      featureMask: { terminal: false }, sendEvent: () => {} });
    await runner.run('auto-policy-team');
    const net = new AgentNet({ agentSettings: settings, featureMask: { terminal: false }, sendEvent: () => {} });
    const result = net.spawn({ name: 'Child', task: 'fixture' });
    assert.equal(result.ok, true);
    await net.settle();
    net.stop();
    assert.equal(seen.length, 2);
    for (const row of seen) {
      assert.equal(row.effective.features.terminal, false);
      assert.equal(row.saved.features.terminal, true);
      assert.equal(row.effective.approvals, 'prompt');
      assert.equal(row.effective.reviewEdits, true);
    }
    assert.equal(settings.features.terminal, true);
  } finally { AgentLoop.prototype.sendUserMessage = original; }
});
