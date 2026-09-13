'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { TeamRunner } = require('../agent/team-runner.cjs');
const { AgentNet } = require('../agent/agent-net.cjs');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { actionInstruction } = require('../agent/agent-action.cjs');
const { toolHelp } = require('../agent/tool-registry.cjs');

async function endpoint(t) {
  const server = require('node:http').createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const complete = body.messages.some(m => m.content.includes('TOOL RESULTS'));
      const reply = complete ? { status: 'complete', message: 'Read browser fixture.', actions: [], options: [] }
        : { status: 'actions', message: 'Inspecting the browser.', actions: [{ name: 'browse', arguments: { url: 'http://localhost:3000' } }], options: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function executor(calls) {
  return async (op, args, ctx) => {
    assert.equal(op, 'open'); assert.equal(args.url, 'http://localhost:3000');
    assert.ok(ctx.agentId); assert.ok(ctx.signal instanceof AbortSignal);
    calls.push(ctx.agentId);
    return { ok: true, tabId: 'fixture-' + ctx.agentId, text: 'Browser fixture' };
  };
}
test('browser tools are discoverable in structured and legacy prompts', () => {
  for (const prompt of [actionInstruction(), actionInstruction({ includeCollab: true }), toolHelp('core')]) {
    for (const name of ['browser.click', 'browser.type', 'browser:']) assert.ok(prompt.includes(name));
    assert.ok(!prompt.includes('not yet wired'));
  }
});
test('regular agent loop dispatches browse through the in-app browser executor', async t => {
  const store = new MemoryStore(), calls = [];
  const loop = new AgentLoop({ agentId: 'solo', store, endpoint: await endpoint(t), browserExecutor: executor(calls) });
  await loop.sendUserMessage('Inspect the browser fixture.');
  assert.deepEqual(calls, ['solo']);
  assert.equal(store.get('solo').runState.status, 'completed');
});
test('parallel team members and their spawned workers inherit the browser executor', async t => {
  const calls = [], url = await endpoint(t);
  const runner = new TeamRunner({ team: { name: 'Browser crew', mode: 'parallel', members: [{}, {}] }, personas: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    endpoint: url, task: 'Read the browser fixture.', browserExecutor: executor(calls), sendEvent: () => {} });
  await runner.run('browser-crew');
  assert.ok(calls.includes('m0-a') && calls.includes('m1-b'));
  assert.equal(runner.net.browserExecutor, runner.browserExecutor);
  const net = new AgentNet({ teamRunId: 'browser-workers', endpoint: url, browserExecutor: executor(calls) });
  const worker = net.spawn({ name: 'Browser worker', task: 'Inspect the browser fixture.', parentId: null, depth: 0 });
  assert.ok(worker.ok);
  await net.settle();
  assert.ok(calls.includes(worker.agentId));
  assert.equal(net.agents.get(worker.agentId).status, 'completed');
  net.stop();
});
test('browser interactions obey existing approvals and cannot proceed without an approval provider', async () => {
  const store = new MemoryStore(); let executed = 0, prompted = 0;
  const ctx = { agentId: 'a', agentStore: store, browserExecutor: async () => { executed++; return { ok: true }; }, requestApproval: async () => { prompted++; return false; } };
  assert.equal((await runToolCall('a', 'browser.click', { ref: 'r1' }, ctx)).ok, false);
  assert.equal(executed, 0); assert.equal(prompted, 1);
  assert.equal((await runToolCall('a', 'browser.type', { ref: 'r1', text: 'test' }, { ...ctx, requestApproval: undefined })).ok, false);
  assert.equal(executed, 0);
  store.get('a').settings.approvals = 'auto-all';
  assert.equal((await runToolCall('a', 'browser.type', { ref: 'r1', text: 'test' }, ctx)).ok, true);
  assert.equal(executed, 1); assert.equal(prompted, 1);
});
