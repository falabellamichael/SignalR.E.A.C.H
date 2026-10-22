'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { parseAgentResponse } = require('../agent/agent-response.cjs');
const { actionInstruction, nativeToolName, toolDefs } = require('../agent/agent-action.cjs');

const LIST_ID = 'fixture-daily-list';
const TASKS = [{ id: 'fixture-task', title: 'Fixture existing task', status: 'notStarted' }];
const LISTS = [{ id: LIST_ID, displayName: 'Fixture Daily Task List' }];

function fixture(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.origin, 'https://graph.microsoft.com');
    assert.equal(options.method, 'GET');
    requests.push(target);
    const value = target.pathname.endsWith('/tasks') ? TASKS : LISTS;
    return new Response(JSON.stringify({ value }), { headers: { 'content-type': 'application/json' } });
  });
  const agentStore = new MemoryStore();
  return { requests, context: { agentId: 'fixture-agent', agentStore,
    getPlugins: () => ({ todo: { enabled: true, accessToken: 'fixture-access', expiresAt: Date.now() + 3600000 } }) } };
}

function parsedCall(protocol, args) {
  const parsed = protocol === 'native'
    ? parseAgentResponse('', [{ id: 'fixture-call', type: 'function', function: {
      name: nativeToolName('todo.read'), arguments: JSON.stringify(args),
    } }])
    : parseAgentResponse(JSON.stringify({ status: 'actions', message: 'Read the selected task list.',
      actions: [{ name: 'todo.read', arguments: args }], options: [] }));
  assert.equal(parsed.invalid, false);
  assert.equal(parsed.actions.length, 1);
  return parsed.actions[0];
}

for (const protocol of ['json', 'native']) {
  for (const selector of ['list', 'listId']) {
    test(`${protocol} todo.read ${selector} reads existing tasks in the selected Microsoft list`, async t => {
      const { requests, context } = fixture(t);
      const call = parsedCall(protocol, { [selector]: LIST_ID, limit: 2 });
      const result = await runToolCall(context.agentId, call.name, call.arguments, context);
      assert.equal(result.ok, true);
      assert.deepEqual(result.tasks, TASKS, 'a selected-list read must return its tasks, not the task-list catalog');
      assert.equal(result.lists, undefined);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].pathname, `/v1.0/me/todo/lists/${LIST_ID}/tasks`);
      assert.equal(requests[0].searchParams.get('$top'), '2');
      assert.equal(requests[0].searchParams.has('$filter'), false);
    });
  }
}

test('todo.read without a selector preserves task-list enumeration', async t => {
  const { requests, context } = fixture(t);
  const result = await runToolCall(context.agentId, 'todo.read', { limit: 3 }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.lists, LISTS);
  assert.equal(result.tasks, undefined);
  assert.equal(requests[0].pathname, '/v1.0/me/todo/lists');
  assert.equal(requests[0].searchParams.get('$top'), '3');
});

test('todo.read accepts matching canonical and alias selectors', async t => {
  const { requests, context } = fixture(t);
  const result = await runToolCall(context.agentId, 'todo.read', { list: LIST_ID, listId: LIST_ID }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks, TASKS);
  assert.equal(requests.length, 1);
});

test('todo.read rejects conflicting selectors before contacting Microsoft', async t => {
  const { requests, context } = fixture(t);
  const result = await runToolCall(context.agentId, 'todo.read', { list: LIST_ID, listId: 'fixture-other-list' }, context);
  assert.equal(result.ok, false);
  assert.match(result.error, /list/i);
  assert.equal(requests.length, 0, 'conflicting selectors must not silently pick a list');
});

test('todo.read rejects explicitly invalid listId instead of silently enumerating lists', async t => {
  const { requests, context } = fixture(t);
  for (const listId of ['', '   ', null, 42, false, {}, [], 'x'.repeat(257)]) {
    for (const args of [{ listId }, { list: LIST_ID, listId }]) {
      const result = await runToolCall(context.agentId, 'todo.read', args, context);
      assert.equal(result.ok, false, `invalid listId ${JSON.stringify(listId)} must fail`);
      assert.match(result.error, /list|resource|argument/i);
    }
  }
  assert.equal(requests.length, 0, 'invalid list selectors must fail before any Graph request');
});

test('JSON and native tool descriptions advertise how to read a selected Microsoft task list', () => {
  const name = nativeToolName('todo.read');
  const native = toolDefs().find(definition => definition.function.name === name).function;
  assert.equal(native.parameters.properties.list.type, 'string');
  assert.equal(native.parameters.properties.listId.type, 'string');
  assert.match(native.description, /listId/);
  assert.match(native.description, /omit|without/i);
  const json = actionInstruction();
  const example = json.split('\n').find(line => line.startsWith('{"name":"todo.read"'));
  assert.ok(example, 'JSON tool instructions include an actionable selected-list example');
  assert.equal(JSON.parse(example).arguments.list, 'list-id');
  assert.match(json, /listId/);
});
