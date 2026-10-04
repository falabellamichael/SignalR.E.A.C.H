'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { defaults } = require('../agent/budgets.cjs');
const { start, decide, actionResponseReminder } = require('../agent/agent-run.cjs');

const complete = message => JSON.stringify({ status: 'complete', message, actions: [], options: [] });
const answer = 'The selected project is a Python application for retrieving information from documents.';

async function fixture(t, model, replies, { nativeTools = false, budgets = {} } = {}) {
  const requests = [], events = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const content = replies[requests.length - 1];
    res.setHeader('Content-Type', 'application/json');
    if (content === undefined) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'Unexpected extra model request.' } }));
      return;
    }
    if (content && typeof content === 'object' && content.httpStatus) {
      res.statusCode = content.httpStatus;
      res.end(JSON.stringify({ error: { message: content.message } }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const store = new MemoryStore();
  const agent = store.get('browser-recovery');
  const loop = new AgentLoop({ agentId: agent.id, store, model,
    endpoint: `http://127.0.0.1:${server.address().port}/v1`, nativeTools,
    budgets: { ...defaults, retryLimit: 0, requestPacing: false, codeContext: false,
      autoCompact: false, ...budgets },
    sendEvent: (_, event) => events.push(event) });
  return { loop, store, agent, requests, events };
}

for (const model of ['chatgpt-chat', 'copilot-chat']) {
  test(`${model}: transport retries off still permits one successful format correction`, { timeout: 5000 }, async t => {
    const f = await fixture(t, model, [answer, complete(answer)]);
    await f.loop.sendUserMessage('Write a concise summary of the selected project.');
    assert.equal(f.requests.length, 2);
    assert.equal(f.agent.runState.status, 'completed');
    assert.equal(f.agent.runState.noActionRounds, 1);
    assert.ok(f.requests[0].messages.filter(m => m.role === 'user').at(-1).content.endsWith(actionResponseReminder));
    assert.ok(f.requests[1].messages.filter(m => m.role === 'user').at(-1).content.endsWith(actionResponseReminder));
    const correction = f.agent.messages.find(m => m._reachMeta?.source === 'recovery');
    assert.ok(correction && correction.content.includes(actionResponseReminder));
    const displayed = f.events.filter(e => e.type === 'message-end');
    assert.deepEqual(displayed.map(e => e.provisional), [true, false]);
    assert.equal(displayed.at(-1).content, answer);
    const final = f.agent.messages.filter(m => m.role === 'assistant' && m._reachMeta?.source !== 'recovery-attempt');
    assert.equal(final.length, 1);
    assert.equal(final[0]._reachMeta.display, answer);
  });

  test(`${model}: repeated prose pauses after three generations and retains the full history`, { timeout: 5000 }, async t => {
    const replies = ['I will inspect the project.', 'I will inspect it next.', 'I will continue the work.'];
    const f = await fixture(t, model, replies);
    const task = 'Fix the bug in the selected project.';
    await f.loop.sendUserMessage(task);
    assert.equal(f.requests.length, 3);
    assert.equal(f.agent.runState.status, 'paused');
    assert.equal(f.agent.runState.noActionRounds, 3);
    assert.match(f.agent.runState.reason, /usable action after structured recovery/);
    assert.equal(f.agent.messages[0].content, task);
    assert.deepEqual(f.agent.messages.filter(m => m.role === 'assistant').map(m => m.content), replies);
    assert.equal(f.agent.messages.filter(m => m._reachMeta?.source === 'recovery').length, 2);
    assert.equal(f.events.filter(e => e.type === 'tool-call').length, 0);
  });
}

test('open todos reject explicit completion throughout the bounded recovery', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'chatgpt-chat', [complete(answer), complete(answer), complete(answer)]);
  f.store.setTodos(f.agent.id, [{ text: 'Inspect the project files.', status: 'pending' }]);
  await f.loop.sendUserMessage('Inspect and summarize the project.');
  assert.equal(f.requests.length, 3);
  assert.equal(f.agent.runState.status, 'paused');
  assert.equal(f.agent.todos[0].status, 'pending');
  assert.ok(f.agent.messages.some(m => m._reachMeta?.source === 'recovery' && /plan item/.test(m.content)));
});

test('transport retries remain disabled despite independent format recovery', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'chatgpt-chat', [{ httpStatus: 500, message: 'Upstream failure.' }]);
  await f.loop.sendUserMessage('Summarize the project.');
  assert.equal(f.requests.length, 1);
  assert.equal(f.agent.runState.status, 'paused');
  assert.match(f.agent.runState.reason, /HTTP 500/);
  assert.equal(f.agent.runState.noActionRounds, 0);
  assert.equal(f.agent.messages.filter(m => m._reachMeta?.source === 'recovery').length, 0);
});

test('pending edits retain their review state rather than completing or generating a recovery', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'copilot-chat', [complete(answer)]);
  f.agent.pendingEdits = { review: { editId: 'review', path: 'project.py', content: 'pending change' } };
  await f.loop.sendUserMessage('Finish the proposed change.');
  assert.equal(f.requests.length, 1);
  assert.equal(f.agent.runState.status, 'waiting_edits');
  assert.equal(f.agent.pendingEdits.review.content, 'pending change');
  assert.equal(f.events.filter(e => e.type === 'tool-call').length, 0);
});

for (const [name, response] of [
  ['mixed completion and actions', JSON.stringify({ status: 'complete', message: 'Finished.',
    actions: [{ name: 'write', arguments: { path: 'project.py', content: 'unsafe' } }], options: [] })],
  ['unknown action', JSON.stringify({ status: 'actions', message: 'Running a tool.',
    actions: [{ name: 'unknown_tool', arguments: {} }], options: [] })],
  ['unfinished control', '```agent_status\n{"status":"complete","summary":"Finished."}'],
]) {
  test(`${name} is never executed or accepted as completion`, { timeout: 5000 }, async t => {
    const f = await fixture(t, 'chatgpt-chat', [response, response, response]);
    await f.loop.sendUserMessage('Fix the project.');
    assert.equal(f.requests.length, 3);
    assert.equal(f.agent.runState.status, 'paused');
    assert.equal(f.events.filter(e => e.type === 'tool-call').length, 0);
    assert.deepEqual(f.agent.messages.filter(m => m.role === 'assistant').map(m => m.content), [response, response, response]);
  });
}

test('native recovery remains native with transport retries disabled and is bounded independently', () => {
  const input = { enabled: true, native: true, invalid: false, control: null,
    rounds: 1, roundLimit: 40, retryLimit: 0 };
  let result = decide(start(), input);
  assert.equal(result.action, 'continue');
  assert.match(result.instruction, /task_complete/);
  assert.doesNotMatch(result.instruction, /EXECUTABLE ACTION RESPONSE|"status":"complete"/);
  assert.equal(result.state.structuredActions, false);
  const done = decide(result.state, { ...input, rounds: 2,
    control: { status: 'complete', summary: answer } });
  assert.equal(done.action, 'complete');
  result = decide(result.state, { ...input, rounds: 2 });
  assert.equal(result.action, 'continue');
  result = decide(result.state, { ...input, rounds: 3 });
  assert.equal(result.action, 'pause');
  assert.equal(result.state.noActionRounds, 3);
});

test('the configured conversation round limit still stops format recovery', () => {
  for (const native of [false, true]) {
    const result = decide(start(), { enabled: true, native, invalid: false,
      rounds: 1, roundLimit: 1, retryLimit: 0 });
    assert.equal(result.action, 'pause');
    assert.match(result.reason, /Agent round limit reached/);
  }
});

test('browser action reminder is transient and restricted to structured answer requests', () => {
  assert.equal(typeof actionResponseReminder, 'string');
  assert.match(actionResponseReminder, /complete/);
  const cases = [
    ['chatgpt-chat', {}, {}, false, true],
    ['copilot-chat', {}, {}, false, true],
    ['gemini-chat', {}, {}, false, false],
    ['deepseek-v4.1-flash', {}, {}, false, false],
    ['other-chatgpt-chat', {}, {}, false, false],
    ['chatgpt-chat', { purpose: 'summary' }, {}, false, false],
    ['copilot-chat', {}, { features: { agent: false } }, false, false],
    ['chatgpt-chat', {}, {}, true, false],
  ];
  for (const [model, options, settings, nativeTools, expected] of cases) {
    const store = new MemoryStore();
    store.get('a').settings = settings;
    const loop = new AgentLoop({ agentId: 'a', store, model, nativeTools, budgets: { ...defaults } });
    const messages = [{ role: 'system', content: 'Project instructions.' }, { role: 'user', content: 'Original task.' }];
    const snapshot = structuredClone(messages);
    const body = loop._requestBody(messages, options);
    assert.equal(body.messages.some(m => m.role === 'user' && m.content.endsWith(actionResponseReminder)), expected,
      `${model}, ${JSON.stringify(options)}, ${JSON.stringify(settings)}, native=${nativeTools}`);
    if (expected) assert.ok(body.messages.filter(m => m.role === 'user').at(-1).content.endsWith(actionResponseReminder));
    assert.deepEqual(messages, snapshot, 'request construction never mutates the supplied transcript');
    assert.equal(store.get('a').messages.length, 0, 'the reminder is not appended to the saved chat');
  }
});

test('the system prompt distinguishes REACH Studio from the selected project', () => {
  const store = new MemoryStore();
  store.get('a').runState = { structuredActions: true };
  const loop = new AgentLoop({ agentId: 'a', store, projectDir: 'C:/fixture/document-project' });
  const prompt = loop._buildSystemPrompt();
  assert.match(prompt, /C:\/fixture\/document-project/);
  assert.match(prompt, /REACH Studio[^.\n]*(?:host|application)/i);
  assert.match(prompt, /(?:selected|bound) project[^.\n]*(?:files|evidence)|(?:files|evidence)[^.\n]*(?:selected|bound) project/i);
});
