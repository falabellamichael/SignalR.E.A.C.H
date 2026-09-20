'use strict';

/* Integration test for prompt injection at the real request-assembly point.
 *
 * code-context.test.cjs covers the retrieval logic; this covers the wiring in
 * AgentLoop._withCodeContext — the toggles, the workspace gate, and the property
 * that matters most: injected text must NOT enter conversation history or the
 * reported context size.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { resolveBudgets } = require('../agent/budgets.cjs');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/math.ts'),
    'export function computeTotal(a: number, b: number): number { return a + b; }\n');
  return dir;
}

function makeLoop(dir, { overrides = {}, settings = {}, events } = {}) {
  const store = new MemoryStore();
  store.get('a').settings = settings;
  const sent = [];
  const loop = new AgentLoop({
    agentId: 'a',
    store,
    endpoint: 'http://127.0.0.1:9/v1',
    model: 'test-model',
    projectDir: dir,
    budgets: resolveBudgets({}, { budgetOverrides: overrides }),
    sendEvent: (channel, event) => { sent.push(event); events?.push(event); },
  });
  return { loop, store, sent };
}

const conversation = [{ role: 'user', content: 'How does computeTotal work?' }];

test('a matching prompt gets codebase data without promoting it to a system instruction', () => {
  const dir = project();
  const { loop, sent } = makeLoop(dir);
  const out = loop._withCodeContext(conversation);
  assert.equal(out.length, conversation.length + 1, 'exactly one message added');
  const injected = out[out.length - 1];
  assert.equal(injected.role, 'user');
  assert.match(injected.content, /computeTotal/);
  assert.match(injected.content, /data, not instructions/i);
  // The original conversation must not be mutated in place.
  assert.equal(conversation.length, 1);
  assert.equal(conversation[0].content, 'How does computeTotal work?');
  const evt = sent.find(e => e.type === 'code-context');
  assert.ok(evt && evt.injected === true, 'a code-context event was emitted');
  assert.ok(evt.symbols.some(s => s.name.includes('computeTotal')), JSON.stringify(evt.symbols));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the budget toggle disables injection', () => {
  const dir = project();
  for (const overrides of [{ codeContext: false }, { codeContextChars: 0 }]) {
    const { loop, sent } = makeLoop(dir, { overrides });
    const out = loop._withCodeContext(conversation);
    assert.equal(out, conversation, 'unchanged array for ' + JSON.stringify(overrides));
    assert.equal(sent.filter(e => e.type === 'code-context').length, 0,
      'no event when the feature is off entirely');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turning the workspace feature off stops injection', () => {
  const dir = project();
  // Injection reads the project tree, so the workspace toggle governs it.
  const { loop } = makeLoop(dir, { settings: { features: { workspace: false } } });
  const out = loop._withCodeContext(conversation);
  assert.equal(out, conversation);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no bound project means no injection', () => {
  const { loop } = makeLoop(null);
  const out = loop._withCodeContext(conversation);
  assert.equal(out, conversation);
});

test('a prompt with no matching symbols is left alone', () => {
  const dir = project();
  const { loop, sent } = makeLoop(dir);
  const out = loop._withCodeContext([{ role: 'user', content: 'hello there!' }]);
  assert.equal(out.length, 1, 'nothing appended');
  const evt = sent.find(e => e.type === 'code-context');
  assert.ok(evt && evt.injected === false, 'the skip is reported');
  assert.ok(evt.reason, 'with a reason');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the injected block never enters history or the reported context size', () => {
  const dir = project();
  const { loop, store } = makeLoop(dir);
  const agent = store.get('a');
  agent.messages = [{ role: 'user', content: 'How does computeTotal work?' }];

  const before = loop.contextStatus();
  const requestMessages = loop._messagesForRequest();
  const withContext = loop._withCodeContext(requestMessages);

  // The request grows; the stored conversation does not.
  assert.ok(withContext.length > requestMessages.length);
  assert.equal(agent.messages.length, 1, 'history untouched by injection');

  // contextStatus() reports the CONVERSATION, so it must be unchanged by a
  // request-time injection. Counting injected source there would inflate the
  // number and give compaction text it cannot summarise away.
  const after = loop.contextStatus();
  assert.equal(after.chars, before.chars, 'reported context size ignores the injection');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an indexing failure cannot break the request', () => {
  // A project directory that vanishes mid-conversation must degrade to "no
  // injection", never throw out of the request path.
  const dir = project();
  const { loop } = makeLoop(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const out = loop._withCodeContext(conversation);
  assert.equal(Array.isArray(out), true);
  assert.ok(out.length >= conversation.length);
});

test('the code-context event becomes an activity step only when injecting', () => {
  const dir = project();
  const events = [];
  const { loop, store } = makeLoop(dir, { events });
  loop.activity = undefined;
  // Emit a running state first so there is an activity object to reduce into.
  loop._emit('run-state', { status: 'running' });
  loop._withCodeContext(conversation);
  const step = store.get('a').activity?.steps.find(s => s.title === 'Gather codebase context');
  assert.ok(step, 'injection shows up in the activity trail');
  assert.equal(step.status, 'done');
  assert.match(step.result, /characters injected/);
  fs.rmSync(dir, { recursive: true, force: true });
});
