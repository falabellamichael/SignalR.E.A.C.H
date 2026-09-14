'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { budgetPolicy, reserveGuard } = require('../agent/budget-awareness.cjs');
const { defaults } = require('../agent/budgets.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const action = (status, message, actions = []) => JSON.stringify({ status, message, actions, options: [] });
async function endpoint(t, handler) {
  const server = require('node:http').createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    handler(JSON.parse(raw), res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function reply(res, content, reason = 'stop', reasoning = '') {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: reason }] }));
}
function fixture(url, budgets = {}) {
  const store = new MemoryStore(), events = [];
  const loop = new AgentLoop({ agentId: 'a', store, endpoint: url, model: 'Qwen/fixture', budgets: { ...defaults, maxTokens: 4096, ...budgets }, sendEvent: (_, event) => events.push(event) });
  return { loop, store, events };
}
test('policy explains actual cap, answer reserve, remaining rounds and explicit zero', () => {
  const policy = budgetPolicy({ maxTokens: 4096, purpose: 'answer', budgets: { ...defaults, maxRounds: 5 }, round: 5, contextChars: 20000 });
  assert.match(policy, /4096 tokens/);
  assert.match(policy, /Reserve at least 1639 tokens/);
  assert.match(policy, /Round 5 of 5; 1 request/);
  assert.match(policy, /last permitted round/);
  assert.match(policy, /do not pad/);
  assert.match(budgetPolicy({ maxTokens: 0, purpose: 'answer', budgets: defaults }), /No application output cap/);
  assert.doesNotMatch(budgetPolicy({ maxTokens: 0, purpose: 'answer', budgets: defaults }), /Hard output allowance/);
});
test('soft reserve ignores answer-bearing or finished frames and unbounded requests', () => {
  const guard = reserveGuard(1000);
  assert.throws(() => guard({ reasoningChars: 1800 }), { code: 'REACH_OUTPUT_RESERVE' });
  for (const p of [{ contentChars: 10 }, { toolCalls: true }, { finishReason: 'stop' }]) assert.doesNotThrow(() => guard({ reasoningChars: 20000, ...p }));
  assert.doesNotThrow(() => reserveGuard(0)({ reasoningChars: 1000000 }));
});
test('reasoning reserve cancels a live stream and obtains a complete response with the same cap', async t => {
  const bodies = [];
  let closed; const streamClosed = new Promise(r => { closed = r; });
  const url = await endpoint(t, (body, res) => {
    bodies.push(body);
    if (bodies.length === 1) {
      res.on('close', closed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'x'.repeat(8000) } }] }) + '\n\n');
    } else reply(res, action('complete', 'A concise, complete answer.'));
  });
  const { loop, store, events } = fixture(url);
  await loop.sendUserMessage('Answer within the budget.');
  await streamClosed;
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every(b => b.max_tokens === 4096));
  assert.equal(bodies[1].chat_template_kwargs.enable_thinking, false);
  assert.match(bodies[0].messages[0].content, /Hard output allowance: 4096/);
  assert.deepEqual(bodies[0].messages.filter(m => m.role === 'system').length, 1);
  assert.equal(store.get('a').runState.status, 'completed');
  assert.ok(events.some(e => e.type === 'budget-recovery'));
  assert.ok(!events.some(e => e.type === 'error'));
});
test('a complete JSON response with long reasoning is accepted without needless retry', async t => {
  let requests = 0;
  const url = await endpoint(t, (_, res) => { requests++; reply(res, action('complete', 'Answer.'), 'stop', 'x'.repeat(20000)); });
  const { loop, store } = fixture(url);
  await loop.sendUserMessage('Answer');
  assert.equal(requests, 1);
  assert.equal(store.get('a').runState.status, 'completed');
});
test('truncated responses never execute even syntactically complete actions', async t => {
  let requests = 0;
  const url = await endpoint(t, (_, res) => {
    if (++requests === 1) reply(res, action('actions', 'Change the plan', [{ name: 'todo_write', arguments: { todos: [{ text: 'Wrong plan', status: 'completed' }] } }]), 'length');
    else reply(res, action('complete', 'Answer without running the truncated action.'));
  });
  const { loop, store, events } = fixture(url);
  await loop.sendUserMessage('Inspect');
  assert.equal(requests, 2);
  assert.equal(store.get('a').runState.status, 'completed');
  assert.equal(events.filter(e => e.type === 'tool-call').length, 0);
  assert.deepEqual(store.get('a').todos, []);
});
test('repeated budget exhaustion produces an honest saved checkpoint, not an error or false completion', async t => {
  let requests = 0;
  const url = await endpoint(t, (_, res) => {
    if (++requests === 1) reply(res, action('actions', 'Check the plan', [{ name: 'todo_read', arguments: {} }]));
    else reply(res, '', 'length', 'thinking');
  });
  const { loop, store, events } = fixture(url);
  store.setTodos('a', [{ text: 'Validate the change', status: 'pending' }]);
  await loop.sendUserMessage('Finish the task');
  assert.equal(requests, 3);
  assert.equal(store.get('a').runState.status, 'paused');
  const saved = store.get('a').messages.at(-1);
  assert.equal(saved._reachMeta.source, 'budget-checkpoint');
  assert.match(saved._reachMeta.display, /REACH budget checkpoint/);
  assert.match(saved._reachMeta.display, /todo_read: succeeded/);
  assert.match(saved._reachMeta.display, /Validate the change/);
  assert.ok(events.some(e => e.type === 'message-end' && /REACH budget checkpoint/.test(e.content)));
  assert.ok(!events.some(e => e.type === 'error'));
});
test('round budget report is visible and never starts an action needing another round', async t => {
  let requests = 0;
  const url = await endpoint(t, (body, res) => {
    requests++;
    assert.match(body.messages[0].content, /last permitted round/);
    reply(res, action('actions', 'Read plan next', [{ name: 'todo_read', arguments: {} }]));
  });
  const { loop, store, events } = fixture(url, { maxRounds: 1 });
  await loop.sendUserMessage('Do the task');
  assert.equal(requests, 1);
  assert.equal(store.get('a').runState.status, 'paused');
  assert.match(store.get('a').messages.at(-1)._reachMeta.display, /round budget has been reached/);
  assert.equal(events.filter(e => e.type === 'tool-call').length, 0);
});
test('Stop during concise recovery remains Stop without creating a budget checkpoint', async t => {
  let requests = 0, ready; const started = new Promise(r => { ready = r; });
  const url = await endpoint(t, (_, res) => {
    if (++requests === 1) reply(res, '', 'length', 'thinking');
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); ready(); }
  });
  const { loop, store } = fixture(url);
  const run = loop.sendUserMessage('Work');
  await started; loop.stop(); await run;
  assert.equal(store.get('a').runState.status, 'stopped');
  assert.ok(!store.get('a').messages.some(m => m._reachMeta?.source === 'budget-checkpoint'));
});
test('small Qwen caps request minimal thinking up front; provider-default cap remains omitted', async t => {
  const bodies = [];
  const url = await endpoint(t, (body, res) => { bodies.push(body); reply(res, action('complete', 'Done')); });
  await fixture(url, { maxTokens: 256 }).loop.sendUserMessage('Hello');
  await fixture(url, { maxTokens: 0 }).loop.sendUserMessage('Hello');
  assert.equal(bodies[0].chat_template_kwargs.enable_thinking, false);
  assert.equal(bodies[0].max_tokens, 256);
  assert.equal(bodies[1].max_tokens, undefined);
  assert.equal(bodies[1].chat_template_kwargs, undefined);
});
test('compression policy uses its own configured output allowance', async t => {
  let body;
  const url = await endpoint(t, (b, res) => { body = b; reply(res, 'Memory of the task.'); });
  const { loop } = fixture(url, { summaryTokens: 65536 });
  loop.abortController = new AbortController();
  await loop._summarizeForCompaction([{ role: 'assistant', content: 'History' }], { maxChars: 1000 });
  assert.equal(body.max_tokens, 65536);
  assert.match(body.messages[0].content, /Hard output allowance: 65536/);
  assert.doesNotMatch(body.messages[0].content, /Round 1 of/);
});

test('a prose-only concise retry does not start another cycle of budget/format retries', async t => {
  let requests = 0;
  const url = await endpoint(t, (_, res) => {
    if (++requests === 1) reply(res, '', 'length', 'thinking');
    else reply(res, 'I will continue working.');
  });
  const { loop, store } = fixture(url);
  await loop.sendUserMessage('Finish the task');
  assert.equal(requests, 2);
  assert.equal(store.get('a').runState.status, 'paused');
  assert.equal(store.get('a').messages.at(-1)._reachMeta.source, 'budget-checkpoint');
});
