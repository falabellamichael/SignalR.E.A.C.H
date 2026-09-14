'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compactMessages, contextChars } = require('../agent/context.cjs');
const { summarizeSegments, transcriptSegments, workingMessages, fingerprint } = require('../agent/compaction.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { AgentStore } = require('../agent/agent-store.cjs');
const { defaults } = require('../agent/budgets.cjs');
const complete = JSON.stringify({ status: 'complete', message: 'Done.', actions: [], options: [] });
const history = () => [{ role: 'user', content: 'Original goal: fix src/chat.py; preserve API.' },
  ...Array.from({ length: 70 }, (_, i) => ({ role: 'assistant', content: `Evidence ${i}: ${'x'.repeat(1500)} END_${i}` })),
  { role: 'user', content: 'Latest correction: preserve compatibility.' }];
async function endpoint(t, handler) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    handler(JSON.parse(raw), res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function json(res, content, extra = {}) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content, ...extra }, finish_reason: extra.reasoning_content ? 'length' : 'stop' }] }));
}
function fixture(url, budgets = {}) {
  const store = new MemoryStore(), events = [];
  const loop = new AgentLoop({ agentId: 'a', store, endpoint: url, model: 'Qwen/fixture', budgets: { ...defaults, ...budgets }, sendEvent: (_, e) => events.push(e) });
  return { store, loop, events };
}

test('segmented memory reads the entire archive including long file tails and carries memory forward', async () => {
  const messages = [{ role: 'tool', content: 'A'.repeat(78000) + 'TAIL: src/deep.py test failed; approval pending' }];
  const segments = transcriptSegments(messages, 14000);
  assert.ok(segments.length > 5);
  assert.match(segments.join(''), /TAIL: src\/deep.py test failed; approval pending/);
  const seen = [], events = [];
  const result = await summarizeSegments(messages, { maxChars: 1000, chunkSize: 14000, signal: new AbortController().signal,
    progress: (type, e) => events.push({ type, ...e }), request: async m => {
      seen.push(m);
      if (seen.length > 1) assert.ok(m[1].content.includes(`memory-${seen.length - 1}`));
      return { content: `memory-${seen.length}`, finishReason: 'stop' };
    } });
  assert.equal(result, `memory-${segments.length}`);
  assert.ok(seen.at(-1)[1].content.includes('TAIL: src/deep.py'));
  assert.equal(events.filter(e => e.type === 'compaction-start').length, segments.length);
});

test('compression pins full instructions and original/latest user requests, and fits target', async () => {
  const messages = [{ role: 'system', content: 'I'.repeat(17000) }, ...history(),
    { role: 'user', content: 'Return an action', _reachMeta: { source: 'recovery' } }];
  const result = await compactMessages(messages, async archived => {
    assert.ok(archived.some(m => m.content.includes('END_0')));
    return 'Goal and pending compatibility tests.';
  }, { trigger: 60000, target: 36000, messageLimit: 48 });
  assert.ok(result.changed);
  assert.equal(result.messages[0].content.length, 17000);
  assert.ok(result.messages.some(m => m.content.startsWith('Original goal:')));
  assert.ok(result.messages.some(m => m.content.startsWith('Latest correction:')));
  assert.ok(result.after <= 36000);
});

test('unfit instructions fail before summarization instead of silently dropping constraints', async () => {
  await assert.rejects(compactMessages([{ role: 'system', content: 'x'.repeat(20000) }], () => assert.fail('should not summarize instructions'),
    { force: true, trigger: 10000, target: 8000 }), /instructions.*preserved/);
});

test('native tool call/result groups stay together during compression', async () => {
  const pair = [{ role: 'assistant', content: '', tool_calls: [{ id: 'call1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call1', content: 'file content' }];
  const result = await compactMessages([...history(), ...pair], async () => 'memory', { trigger: 50000, target: 20000 });
  const index = result.messages.findIndex(m => m.tool_calls);
  assert.ok(index >= 0);
  assert.equal(result.messages[index + 1].tool_call_id, 'call1');
});

test('deduplicates completed tool batches but retains interrupted tool results', () => {
  const single = { role: 'tool', content: 'read completed' };
  const combined = { role: 'user', content: 'TOOL RESULTS\nread completed', _reachMeta: { source: 'tool-summary' } };
  assert.deepEqual(workingMessages({ messages: [single, combined] }), [combined]);
  assert.match(workingMessages({ messages: [single] })[0].content, /read completed/);
});

test('oversize summaries are shortened as a whole and never silently truncated', async () => {
  let count = 0;
  const result = await summarizeSegments([{ role: 'assistant', content: 'data' }], {
    maxChars: 80, signal: new AbortController().signal, progress: () => {}, request: async m => {
      if (++count === 1) return { content: 'x'.repeat(90) + 'CRITICAL_TAIL', finishReason: 'stop' };
      assert.match(m[1].content, /CRITICAL_TAIL/);
      return { content: 'CRITICAL_TAIL', finishReason: 'stop' };
    } });
  assert.equal(result, 'CRITICAL_TAIL');
  assert.equal(count, 2);
});

test('manual compression persists separate context, retains all history and invalidates after edits', async t => {
  const url = await endpoint(t, (_, res) => json(res, 'Goal: fix src/chat.py. Pending: tests and compatibility.'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agents.json');
  const store = new AgentStore(file), agent = store.create({ name: 'Long chat' });
  store.setMessages(agent.id, history());
  store.setRunState(agent.id, { status: 'paused', reason: 'Unfinished task' });
  const before = JSON.stringify(agent.messages);
  const loop = new AgentLoop({ agentId: agent.id, store, endpoint: url });
  await loop.compactNow();
  assert.equal(JSON.stringify(agent.messages), before);
  assert.equal(agent.runState.status, 'paused');
  assert.ok(contextChars(workingMessages(agent)) < contextChars(agent.messages));
  const reloaded = new AgentStore(file).get(agent.id);
  assert.deepEqual(workingMessages(reloaded), workingMessages(agent));
  store.appendMessage(agent.id, { role: 'user', content: 'New task detail' });
  assert.equal(workingMessages(agent).at(-1).content, 'New task detail');
  agent.messages[0].content = 'Edited original goal';
  assert.equal(workingMessages(agent)[0].content, 'Edited original goal');
  store.setMessages(agent.id, []);
  assert.equal(agent.context, undefined);
});

test('failed compression retains history and the previous checkpoint atomically', async t => {
  const url = await endpoint(t, (_, res) => json(res, '', { reasoning_content: 'only thoughts' }));
  const { store, loop } = fixture(url);
  store.setMessages('a', history());
  store.get('a').context = { messages: history(), through: 72, fingerprint: fingerprint(history()) };
  const before = JSON.stringify(store.get('a'));
  loop.abortController = new AbortController();
  await assert.rejects(loop._maybeCompact(loop._messagesForRequest(), { force: true }), /previous context are intact/);
  const original = JSON.parse(before);
  assert.deepEqual(store.get('a').messages, original.messages);
  assert.deepEqual(store.get('a').context, original.context);
});

test('Stop aborts a streaming compaction and keeps queued work pending', async t => {
  let started;
  const ready = new Promise(r => { started = r; });
  const url = await endpoint(t, (_, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); started(); });
  const { store, loop } = fixture(url);
  store.setMessages('a', history());
  const before = JSON.stringify(store.get('a').messages);
  const pending = loop.compactNow();
  await ready;
  store.enqueue('a', 'Do this later');
  loop.stop();
  await assert.rejects(pending);
  assert.equal(JSON.stringify(store.get('a').messages), before);
  assert.equal(store.get('a').context, undefined);
  assert.equal(store.queueLength('a'), 1);
  assert.equal(loop.running, false);
});

test('Qwen reasoning exhaustion retries once with thinking disabled, honors output cap and executes tools only once', async t => {
  const calls = [];
  const url = await endpoint(t, (body, res) => {
    calls.push(body);
    if (calls.length === 1) return json(res, JSON.stringify({ status: 'actions', message: 'Read.', actions: [{ name: 'read', arguments: { path: 'hello.txt' } }], options: [] }));
    if (calls.length === 2) return json(res, '', { reasoning_content: 'thinking' });
    json(res, complete);
  });
  const { store, loop, events } = fixture(url, { maxTokens: 4096 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello');
  loop.projectDir = dir;
  await loop.sendUserMessage('Read hello.txt and report.');
  assert.equal(store.get('a').runState.status, 'completed');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(b => b.max_tokens === 4096));
  assert.equal(calls[2].chat_template_kwargs.enable_thinking, false);
  assert.equal(events.filter(e => e.type === 'tool-call').length, 1);
});

test('provider rejection of thinking hint falls back once during streamed compression', async t => {
  let hints = 0, requests = 0;
  const url = await endpoint(t, (body, res) => {
    requests++;
    assert.equal(body.stream, true);
    if (body.chat_template_kwargs) { hints++; res.writeHead(422); res.end('unknown chat_template_kwargs'); }
    else json(res, 'Preserve goal and tests.');
  });
  const { store, loop, events } = fixture(url);
  store.setMessages('a', history());
  await loop.compactNow();
  assert.equal(hints, 1);
  assert.ok(requests > 2);
  assert.ok(events.some(e => e.type === 'compaction-start' && e.total > 1));
});

test('recognized input overflow forces smaller context then retries without spending a tool round', async t => {
  let generations = 0;
  const url = await endpoint(t, (body, res) => {
    if (body.messages[0].content.includes('durable conversation memory')) return json(res, 'Goal and pending tests.');
    generations++;
    if (generations === 1) { res.writeHead(400); return res.end('maximum context length exceeded'); }
    json(res, complete);
  });
  const { store, loop } = fixture(url, { contextTrigger: 500000, contextMessages: 0, maxRounds: 1 });
  store.setMessages('a', history());
  await loop.sendUserMessage('Finish.');
  assert.equal(generations, 2);
  assert.equal(store.get('a').runState.status, 'completed');
  assert.ok(store.get('a').context.after < store.get('a').context.before);
});

test('editing an existing message during compression cannot install a stale checkpoint', async () => {
  const { store, loop } = fixture('http://127.0.0.1/v1');
  store.setMessages('a', history());
  loop.abortController = new AbortController();
  loop._summarizeForCompaction = async () => {
    store.get('a').messages[0].content = 'Changed goal while summary was running';
    return 'An outdated memory';
  };
  await assert.rejects(loop._maybeCompact(loop._messagesForRequest()), /Conversation changed/);
  assert.equal(store.get('a').context, undefined);
  assert.equal(store.get('a').messages[0].content, 'Changed goal while summary was running');
});

test('a failed checkpoint disk write restores the previous in-memory checkpoint', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-context-disk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AgentStore(path.join(dir, 'agents.json')), agent = store.create({ name: 'Disk failure' });
  const previous = { messages: [], through: 0 };
  store.setContext(agent.id, previous);
  store._save = () => { throw new Error('Disk full'); };
  assert.throws(() => store.setContext(agent.id, { messages: ['new'] }), /Disk full/);
  assert.equal(agent.context, previous);
});
