'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { AgentStore } = require('../agent/agent-store.cjs');
const { TOOLS } = require('../agent/tool-registry.cjs');
const { disabledTools } = require('../agent/tool-policy.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { defaults } = require('../agent/budgets.cjs');
test('group switches remove tools from prompts and refuse direct execution', async () => {
  const store = new MemoryStore(); store.get('a').settings.features = { terminal: false, workspace: false, web: false };
  for (const name of ['shell', 'reach.run', 'read', 'write', 'browse', 'websearch', 'browser.click']) {
    assert.ok(disabledTools(store.get('a').settings, TOOLS).includes(name));
    const result = await runToolCall('a', name, {}, { agentStore: store, requestApproval: () => assert.fail('Disabled tool must not prompt'), reachExecutor: () => assert.fail('Disabled tool must not execute') });
    assert.match(result.error, /disabled/);
  }
  const loop = new AgentLoop({ store, agentId: 'a' }); store.get('a').runState = { structuredActions: true };
  assert.doesNotMatch(loop._buildSystemPrompt(), /"name":"shell"|"name":"read"/);
});
test('disabling a tool while its approval is open also prevents execution', async () => {
  const store = new MemoryStore();
  const result = await runToolCall('a', 'reach.run', {}, { agentStore: store, requestApproval: async () => { store.get('a').settings.features = { terminal: false }; return true; }, reachExecutor: () => assert.fail('Must not execute after revoked permission') });
  assert.match(result.error, /disabled/);
});
test('Agent off returns plain text once without the structured recovery loop', async () => {
  const store = new MemoryStore(); store.get('a').settings.features = { agent: false };
  const loop = new AgentLoop({ store, agentId: 'a', budgets: { ...defaults, autoCompact: false } });
  let calls = 0; loop._budgetedAnswer = async () => { calls++; return { content: 'Hello, ready to help.' }; };
  await loop.sendUserMessage('Hello'); assert.equal(calls, 1); assert.equal(store.get('a').runState.status, 'completed');
  assert.equal(store.get('a').messages.at(-1).content, 'Hello, ready to help.');
});
test('clear removes every context source, preserves settings and does not clear branches', () => {
  const store = Object.create(AgentStore.prototype); store.getSettings = () => ({}); store.agents = []; store._save = () => {};
  const parent = store.create({ name: 'Original', dir: 'fixture', model: 'model' });
  parent.settings.features = { terminal: false }; parent.messages = [{ role: 'user', content: 'private old context' }];
  const child = store.fork(parent.id);
  Object.assign(parent, { context: { memory: 'old' }, activity: {}, queue: ['old'], todos: [{}], pendingEdits: { x: {} } });
  store.clear(parent.id);
  assert.equal(parent.messages.length, 0); assert.equal(parent.context, undefined); assert.equal(parent.activity, undefined);
  assert.deepEqual(parent.pendingEdits, {}); assert.equal(parent.queue.length, 0); assert.equal(parent.settings.features.terminal, false);
  assert.equal(child.messages.length, 1); assert.equal(parent.dir, 'fixture'); assert.equal(parent.model, 'model');
  parent.runState = { status: 'running' }; assert.throws(() => store.clear(parent.id), /Stop/);
});
test('team members and spawned workers inherit conversation controls', async () => {
  const { TeamRunner } = require('../agent/team-runner.cjs');
  const seen = [], original = AgentLoop.prototype.sendUserMessage;
  AgentLoop.prototype.sendUserMessage = async function () {
    seen.push(structuredClone(this._agent().settings)); this.store.appendMessage(this.agentId, { role: 'assistant', content: 'done' }); this.store.setRunState(this.agentId, { status: 'completed' });
  };
  try {
    const settings = { features: { terminal: false }, disabledTools: ['write'] };
    const runner = new TeamRunner({ team: { name: 'Fixture', mode: 'parallel', members: [{ personaId: 'p' }] }, personas: [{ id: 'p', name: 'Worker' }], task: 'fixture', agentSettings: settings, sendEvent: () => {} });
    await runner.run('policy-team');
    assert.equal(seen[0].features.terminal, false); assert.deepEqual(seen[0].disabledTools, ['write']);
    const { AgentNet } = require('../agent/agent-net.cjs');
    const net = new AgentNet({ agentSettings: settings, sendEvent: () => {} });
    const result = net.spawn({ name: 'Child', task: 'fixture' });
    assert.equal(result.ok, true); net.stop();
    assert.equal(seen.at(-1).features.terminal, false);
  } finally { AgentLoop.prototype.sendUserMessage = original; }
});
