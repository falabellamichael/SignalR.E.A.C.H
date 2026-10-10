'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentDir = process.env.REACH_AGENT_TEST_DIR || path.resolve(__dirname, '../agent');
const { defaults, presets, budgetsForModel } = require(path.join(agentDir, 'budgets.cjs'));
const { AgentLoop } = require(path.join(agentDir, 'agent-loop.cjs'));
const { AgentStore } = require(path.join(agentDir, 'agent-store.cjs'));
const { MemoryStore } = require(path.join(agentDir, 'memory-store.cjs'));
const { contextChars } = require(path.join(agentDir, 'context.cjs'));
const response = (status, actions = []) => JSON.stringify({ status, message: 'Verified result.', actions, options: [] });
function json(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}
async function endpoint(t, handler) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    handler(JSON.parse(raw), res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

for (const model of ['copilot-chat', 'chatgpt-chat', 'gemini-chat']) {
  test(`${model} runs past configured round caps without max_tokens`, async t => {
    let calls = 0;
    const url = await endpoint(t, (body, res) => {
      assert.equal(body.max_tokens, undefined);
      assert.equal(body.messages[0].content.includes('last permitted round'), false);
      json(res, ++calls <= 42 ? response('actions', [{ name: 'todo_read', arguments: {} }]) : response('complete'));
    });
    const store = new MemoryStore();
    const loop = new AgentLoop({ agentId: 'a', store, endpoint: url, model,
      budgets: { ...presets.unrestricted, maxRounds: 2, maxTokens: 100, requestTimeoutMs: 1 } });
    await loop.sendUserMessage('Read the saved todos until the task is finished.');
    assert.equal(calls, 43);
    assert.equal(store.get('a').runState.status, 'completed');
    assert.equal(loop.requestTimeoutMs, 0);
    assert.equal(loop._budgets().autoCompact, true);
  });
}

test('other provider models retain their configured budgets', () => {
  for (const model of ['gemini-3.8-flash', 'codegpt-eco', 'chatgpt-chat-extra', 'gpt-4o']) {
    assert.equal(budgetsForModel(defaults, model), defaults);
  }
});

test('browser chat Stop cancels an unlimited stalled stream', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const url = await endpoint(t, (_, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); started(); });
  const store = new MemoryStore();
  const loop = new AgentLoop({ agentId: 'a', store, endpoint: url, model: 'gemini-chat', budgets: defaults });
  const pending = loop.sendUserMessage('Wait for the answer.');
  await ready;
  loop.stop();
  await pending;
  assert.equal(store.get('a').runState.status, 'stopped');
});

test('browser history retention follows pinned or active model and survives reload', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-browser-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agents.json');
  const settings = () => ({ budgets: { ...defaults, storedMessages: 2 }, activeConnection: 'browser',
    connections: [{ id: 'browser', model: 'gemini-chat' }] });
  const store = new AgentStore(file, settings);
  for (const model of ['', 'copilot-chat', 'chatgpt-chat']) {
    const agent = store.create({ name: 'Long browser chat', model });
    for (let i = 0; i < 6; i++) store.appendMessage(agent.id, { role: 'user', content: `Request ${i}` });
    assert.equal(new AgentStore(file, settings).get(agent.id).messages.length, 6);
  }
});

test('provider overflow recovers repeatedly with autoCompact off and keeps the transcript', async t => {
  let generations = 0;
  const sizes = [];
  const url = await endpoint(t, (body, res) => {
    if (body.messages[0].content.includes('durable conversation memory')) return json(res, 'Original goal; verified evidence; remaining tests.');
    sizes.push(contextChars(body.messages));
    if (++generations <= 2) { res.writeHead(400); return res.end('maximum context length exceeded'); }
    json(res, response('complete'));
  });
  const store = new MemoryStore();
  const history = [{ role: 'user', content: 'Original task: inspect the project and report.' },
    ...Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', content: `Evidence ${i}: ` + 'x'.repeat(2000) }))];
  store.setMessages('a', history);
  const loop = new AgentLoop({ agentId: 'a', store, endpoint: url, model: 'provider-fixture',
    budgets: { ...defaults, autoCompact: false, contextTrigger: 0, contextMessages: 0, maxRounds: 1 } });
  await loop.sendUserMessage('Continue');
  assert.equal(generations, 3);
  assert.ok(sizes[1] < sizes[0] && sizes[2] < sizes[1]);
  assert.deepEqual(store.get('a').messages.slice(0, history.length), history);
  assert.equal(store.get('a').runState.status, 'completed');
});

test('an irreducible rejected request pauses without replaying it indefinitely', async t => {
  let calls = 0;
  const url = await endpoint(t, (_, res) => { calls++; res.writeHead(400); res.end('maximum context length exceeded'); });
  const store = new MemoryStore();
  const loop = new AgentLoop({ agentId: 'a', store, endpoint: url, model: 'provider-fixture', budgets: presets.unrestricted });
  await loop.sendUserMessage('Hello');
  assert.equal(calls, 1);
  assert.equal(store.get('a').runState.status, 'paused');
});
