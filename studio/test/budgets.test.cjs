'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, presets, resolveBudgets, validateBudgets } = require('../agent/budgets.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { TeamRunner, boundedRelay } = require('../agent/team-runner.cjs');
const { AgentNet } = require('../agent/agent-net.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { AgentStore } = require('../agent/agent-store.cjs');
const { runToTerminal } = require('../agent/pause-resume.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const action = (status, message, actions = []) => JSON.stringify({ status, message, actions, options: [] });
function reply(res, content) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] })); }
async function endpoint(t, handler) {
  const server = require('node:http').createServer((req, res) => {
    let data = ''; req.on('data', c => data += c); req.on('end', () => handler(JSON.parse(data), res));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}
test('global budgets replace legacy defaults; overrides and explicit zero survive validation', () => {
  assert.equal(resolveBudgets({}, { maxTokens: 5000 }).maxTokens, 5000);
  assert.equal(resolveBudgets({ budgets: presets.heavy }, { maxTokens: 4096 }).maxTokens, 32768);
  assert.equal(resolveBudgets({ budgets: presets.heavy }, { budgetOverrides: { maxTokens: 0 } }).maxTokens, 0);
  assert.deepEqual(validateBudgets(presets.unrestricted), presets.unrestricted);
  for (const value of [-1, 2.5, null, '4096', Infinity, 2147483648]) assert.throws(() => validateBudgets({ maxTokens: value }));
  assert.throws(() => validateBudgets({ autoCompact: 0 }));
  assert.throws(() => validateBudgets({ contextTarget: 200 }));
});
test('HTTP requests honor high output caps and omit max_tokens only for zero', async t => {
  const bodies = [];
  const url = await endpoint(t, (body, res) => { bodies.push(body); reply(res, action('complete', 'Done')); });
  for (const maxTokens of [4096, 65536, 0]) {
    const loop = new AgentLoop({ agentId: 'x', store: new MemoryStore(), endpoint: url, budgets: { ...defaults, maxTokens } });
    await loop.sendUserMessage('Hello');
  }
  assert.deepEqual(bodies.map(b => b.max_tokens), [4096, 65536, undefined]);
  assert.equal(Object.hasOwn(bodies[2], 'max_tokens'), false);
});
test('unrestricted execution passes 40 rounds and skips automatic compaction', async t => {
  let calls = 0;
  const url = await endpoint(t, (_, res) => reply(res, ++calls <= 42 ? action('actions', 'Check', [{ name: 'todo_read', arguments: {} }]) : action('complete', 'Finished 42 actions')));
  const store = new MemoryStore();
  const loop = new AgentLoop({ agentId: 'x', store, endpoint: url, budgets: presets.unrestricted });
  loop._summarizeForCompaction = () => { throw new Error('Compaction must be disabled'); };
  await loop.sendUserMessage('Continue');
  assert.equal(calls, 43);
  assert.equal(store.get('x').runState.status, 'completed');
  assert.ok(store.get('x').messages.length > 72);
});
test('zero request timeout still permits immediate Stop during a stalled stream', async t => {
  let started;
  const ready = new Promise(r => started = r);
  const url = await endpoint(t, (_, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); started(); });
  const store = new MemoryStore();
  const loop = new AgentLoop({ agentId: 'x', store, endpoint: url, budgets: presets.unrestricted });
  const work = loop.sendUserMessage('Wait');
  await ready;
  loop.stop();
  await work;
  assert.equal(loop.running, false);
  assert.equal(store.get('x').runState.status, 'stopped');
});
test('team roster and spawned workers inherit high output caps and independent round budgets', async t => {
  const bodies = [];
  const url = await endpoint(t, (body, res) => { bodies.push(body); reply(res, action('complete', 'Done')); });
  const budgets = { ...presets.unrestricted, maxTokens: 65536, subagentMaxRounds: 100 };
  const runner = new TeamRunner({ team: { name: 'test', mode: 'parallel', members: [{ personaId: 'a' }, { personaId: 'b' }] }, personas: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], task: 'test', endpoint: url, budgets, sendEvent: () => {} });
  const result = await runner.run('test-team');
  assert.equal(result.filter(r => r.ok).length, 2);
  const net = new AgentNet({ endpoint: url, budgets });
  const child = net.spawn({ name: 'child', task: 'Work', depth: 20 });
  assert.equal(child.ok, true);
  assert.equal(net.agents.get(child.agentId).loop._budgets().maxRounds, 100);
  assert.equal(net.maxAgents, Infinity);
  assert.equal(net.maxDepth, Infinity);
  await net.settle();
  assert.equal(net.agents.get(child.agentId).status, 'completed');
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every(b => b.max_tokens === 65536));
  assert.equal(runner.concurrency, Infinity);
  assert.equal(boundedRelay(['a'.repeat(25000), 'b'.repeat(25000)], 0).length, 50002);
});
test('compression uses its own output allowance and preserves history on reasoning-only failure', async t => {
  let body;
  const url = await endpoint(t, (b, res) => {
    body = b;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'thinking' }, finish_reason: 'length' }] }));
  });
  const store = new MemoryStore();
  const messages = Array.from({ length: 80 }, () => ({ role: 'user', content: 'Some history' }));
  store.setMessages('x', messages);
  const before = JSON.stringify(messages);
  const loop = new AgentLoop({ agentId: 'x', store, endpoint: url, budgets: { ...defaults, summaryTokens: 65536 } });
  loop.abortController = new AbortController();
  await assert.rejects(loop._maybeCompact(messages), /Settings > Budgeting/);
  assert.equal(body.max_tokens, 65536);
  assert.equal(JSON.stringify(store.get('x').messages), before);
});
test('unrestricted history survives disk reload past the old 400-message cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-budgets-'));
  try {
    const file = path.join(dir, 'agents.json'), settings = () => ({ budgets: presets.unrestricted });
    const store = new AgentStore(file, settings), a = store.create({ name: 'Long conversation' });
    // Seed the old boundary, then exercise the real append/save/reload path.
    a.messages = Array.from({ length: 405 }, (_, i) => ({ role: 'user', content: `Message ${i}` }));
    store.appendMessage(a.id, { role: 'assistant', content: 'Newest' });
    const saved = new AgentStore(file, settings).get(a.id);
    assert.equal(saved.messages.length, 406);
    assert.equal(saved.messages[0].content, 'Message 0');
    assert.equal(saved.settings.approvals, 'prompt');
    assert.equal(saved.settings.reviewEdits, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('unlimited review resumptions exceed the former six-cycle limit', async () => {
  const store = new MemoryStore(); let turns = 0;
  const loop = { sendUserMessage: async () => {
    store.setRunState('x', { status: ++turns > 8 ? 'completed' : 'waiting_input', reason: 'Input?' });
    store.appendMessage('x', { role: 'assistant', content: 'Result' });
  } };
  const result = await runToTerminal({ loop, store, agentId: 'x', maxCycles: Infinity, requestMemberAnswer: async () => 'Yes', stopSignal: () => new Promise(() => {}) });
  assert.equal(result.status, 'completed');
  assert.equal(result.cycles, 8);
});
