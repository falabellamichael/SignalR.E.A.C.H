'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { parseAgentResponse } = require('../agent/agent-response.cjs');
const { actionInstruction, nativeToolName, toolDefs } = require('../agent/agent-action.cjs');
const { TOOLS } = require('../agent/tool-registry.cjs');
const { createAppConnections } = require('../agent/app-connections.cjs');
const { companionSettings } = require('../agent/companion-chat.cjs');

const LIST = 'fixture-list';
const TASK = 'fixture-task';
const ACCESS = 'fixture-private-write-access';
const ROTATED = 'fixture-private-rotated-access';
const definitions = [
  { name: 'todo.create_list', args: { displayName: 'Fixture new list' }, method: 'POST',
    route: '/v1.0/me/todo/lists', body: { displayName: 'Fixture new list' } },
  { name: 'todo.update', args: { list: LIST, id: TASK, title: 'Fixture revised title', status: 'inProgress', importance: 'high', categories: ['Fixture category'] }, method: 'PATCH',
    route: `/v1.0/me/todo/lists/${LIST}/tasks/${TASK}`,
    body: { title: 'Fixture revised title', status: 'inProgress', importance: 'high', categories: ['Fixture category'] } },
];

function fixture(t, { approved = true, approvals = 'prompt', onApproval, errorStatus = 0 } = {}) {
  const requests = [], prompts = [];
  let plugins = { todo: { enabled: true, accessToken: ACCESS, expiresAt: Date.now() + 3600000, scope: 'Tasks.ReadWrite' } };
  const store = new MemoryStore();
  store.get('fixture-agent').settings.approvals = approvals;
  const state = { requests, prompts, store, replacePlugins(value) { plugins = value; } };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.origin, 'https://graph.microsoft.com', 'no unmocked external service');
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ pathname: target.pathname, method: options.method, body,
      authorization: new Headers(options.headers).get('authorization') });
    if (errorStatus) return new Response(JSON.stringify({ error: {
      code: 'ErrorAccessDenied', message: `Provider rejected ${ACCESS}; fixture-private-account-data`,
    } }), { status: errorStatus, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(options.method === 'GET' ? { value: [] }
      : { id: options.method === 'POST' ? LIST : TASK, ...body }),
    { headers: { 'content-type': 'application/json' } });
  });
  state.context = {
    agentId: 'fixture-agent', agentStore: store, getPlugins: () => plugins,
    requestApproval: async payload => {
      prompts.push(payload);
      if (onApproval) await onApproval(state);
      return approved;
    },
  };
  return state;
}

function parseCall(protocol, name, args) {
  const parsed = protocol === 'native'
    ? parseAgentResponse('', [{ id: 'fixture-write', type: 'function', function: {
      name: nativeToolName(name), arguments: JSON.stringify(args),
    } }])
    : parseAgentResponse(JSON.stringify({ status: 'actions', message: 'Apply the requested To Do change.',
      actions: [{ name, arguments: args }], options: [] }));
  assert.equal(parsed.invalid, false, `${name} is advertised and parsed for ${protocol}`);
  assert.equal(parsed.actions.length, 1);
  return parsed.actions[0];
}

for (const definition of definitions) {
  for (const approvals of ['prompt', 'auto-read']) {
    test(`${definition.name} honors a declined ${approvals} approval without contacting Microsoft`, async t => {
      const state = fixture(t, { approved: false, approvals });
      const result = await runToolCall(state.context.agentId, definition.name, definition.args, state.context);
      assert.equal(result.ok, false);
      assert.match(result.error, /declined/);
      assert.equal(state.prompts.length, 1);
      assert.equal(state.prompts[0].tool, definition.name);
      assert.deepEqual(state.prompts[0].arguments, definition.args);
      assert.equal(state.requests.length, 0);
    });
  }

  for (const protocol of ['json', 'native']) {
    test(`${protocol} ${definition.name} uses saved OAuth and sends only its approved HTTP body`, async t => {
      const state = fixture(t);
      const call = parseCall(protocol, definition.name, definition.args);
      const result = await runToolCall(state.context.agentId, call.name, call.arguments, state.context);
      assert.equal(result.ok, true);
      assert.equal(state.prompts.length, 1);
      assert.deepEqual(state.requests, [{ pathname: definition.route, method: definition.method,
        body: definition.body, authorization: `Bearer ${ACCESS}` }]);
      assert.doesNotMatch(JSON.stringify({ result, prompts: state.prompts, messages: state.store.get(state.context.agentId).messages }), /fixture-private-/);
    });
  }

  test(`${definition.name} respects disabled tool controls before requesting approval`, async t => {
    const state = fixture(t);
    state.store.get(state.context.agentId).settings.disabledTools = [definition.name];
    const result = await runToolCall(state.context.agentId, definition.name, definition.args, state.context);
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled/);
    assert.equal(state.prompts.length, 0);
    assert.equal(state.requests.length, 0);
  });

  test(`${definition.name} rechecks a connection disabled during approval`, async t => {
    const state = fixture(t, { onApproval: current => current.replacePlugins({ todo: { enabled: false } }) });
    const result = await runToolCall(state.context.agentId, definition.name, definition.args, state.context);
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled/);
    assert.equal(state.prompts.length, 1);
    assert.equal(state.requests.length, 0);
  });

  test(`${definition.name} uses a reconnected account's current token after approval`, async t => {
    const state = fixture(t, { onApproval: current => current.replacePlugins({ todo: { enabled: true,
      accessToken: ROTATED, expiresAt: Date.now() + 3600000, scope: 'Tasks.ReadWrite' } }) });
    const result = await runToolCall(state.context.agentId, definition.name, definition.args, state.context);
    assert.equal(result.ok, true);
    assert.equal(state.prompts.length, 1);
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].authorization, `Bearer ${ROTATED}`);
  });

  test(`${definition.name} cannot be redirected by an arbitrary operation or body`, async t => {
    const state = fixture(t);
    const result = await runToolCall(state.context.agentId, definition.name,
      { ...definition.args, operation: 'delete', method: 'DELETE', body: { unsafe: true } }, state.context);
    assert.equal(result.ok, true);
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].method, definition.method);
    assert.equal(state.requests[0].pathname, definition.route);
    assert.deepEqual(state.requests[0].body, definition.body);
  });

  test(`${definition.name} reports Microsoft write permission denial through saved sign-in guidance`, async t => {
    const state = fixture(t, { errorStatus: 403 });
    state.replacePlugins({ todo: { enabled: true, accessToken: ACCESS,
      expiresAt: Date.now() + 3600000, scope: 'Tasks.Read' } });
    const result = await runToolCall(state.context.agentId, definition.name, definition.args, state.context);
    assert.equal(result.ok, false);
    assert.equal(state.prompts.length, 1);
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].method, definition.method);
    assert.match(result.error, /HTTP 403/);
    assert.match(result.error, /Reconnect Microsoft in App Connections/);
    assert.match(result.error, /Grant Tasks\.ReadWrite permission/);
    assert.doesNotMatch(result.error, /Tasks\.Read or|Graph Explorer|paste|copy.*token/i);
    assert.doesNotMatch(JSON.stringify({ result, prompts: state.prompts,
      messages: state.store.get(state.context.agentId).messages }), /fixture-private-|Provider rejected/);
  });
}

test('todo.create_list rejects missing, blank, invalid, and oversized display names', async t => {
  const state = fixture(t);
  for (const args of [{}, { displayName: '' }, { displayName: '   ' }, { displayName: null }, { displayName: 42 }, { displayName: 'x'.repeat(256) }]) {
    const result = await runToolCall(state.context.agentId, 'todo.create_list', args, state.context);
    assert.equal(result.ok, false, `invalid displayName ${JSON.stringify(args)} must fail`);
    assert.match(result.error, /display|name|argument/i);
  }
  assert.equal(state.requests.length, 0);
});

test('todo.update rejects invalid identities, empty patches, and invalid fields without a request', async t => {
  const state = fixture(t);
  const invalid = [
    {}, { list: LIST }, { id: TASK }, { list: LIST, id: TASK },
    { list: '', id: TASK, title: 'Fixture' }, { list: LIST, id: '', title: 'Fixture' },
    { list: LIST, id: TASK, title: '' }, { list: LIST, id: TASK, title: '   ' },
    { list: LIST, id: TASK, title: 'x'.repeat(256) },
    { list: LIST, id: TASK, status: 'invented' }, { list: LIST, id: TASK, importance: 'urgent' },
    { list: LIST, id: TASK, categories: ['', 'Fixture'] },
    { list: LIST, id: TASK, categories: ['  '] }, { list: LIST, id: TASK, categories: [12] },
    { list: LIST, id: TASK, categories: ['x'.repeat(256)] },
    { list: LIST, id: TASK, categories: Array(26).fill('Fixture') },
  ];
  for (const args of invalid) {
    const result = await runToolCall(state.context.agentId, 'todo.update', args, state.context);
    assert.equal(result.ok, false, `invalid update ${JSON.stringify(args)} must fail`);
    assert.doesNotMatch(result.error, /Unknown tool/);
    assert.match(result.error, /list|task|id|title|status|importance|categor|patch|field|argument|suppl|update/i);
  }
  assert.equal(state.requests.length, 0);
});

test('todo.update supports every declared status and importance value and empty categories', async t => {
  const state = fixture(t);
  for (const status of ['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred']) {
    assert.equal((await runToolCall(state.context.agentId, 'todo.update', { list: LIST, id: TASK, status }, state.context)).ok, true);
    assert.deepEqual(state.requests.at(-1).body, { status });
  }
  for (const importance of ['low', 'normal', 'high']) {
    assert.equal((await runToolCall(state.context.agentId, 'todo.update', { list: LIST, id: TASK, importance }, state.context)).ok, true);
    assert.deepEqual(state.requests.at(-1).body, { importance });
  }
  assert.equal((await runToolCall(state.context.agentId, 'todo.update', { list: LIST, id: TASK, categories: [] }, state.context)).ok, true);
  assert.deepEqual(state.requests.at(-1).body, { categories: [] }, 'an explicit empty array clears categories');
  assert.ok(state.requests.every(request => request.method === 'PATCH'));
});

test('todo.read cannot perform a write through an operation override', async t => {
  const state = fixture(t);
  for (const operation of ['create', 'create_list', 'update', 'delete', 'move']) {
    const result = await runToolCall(state.context.agentId, 'todo.read', { list: LIST, id: TASK,
      operation, title: 'Must not mutate', displayName: 'Must not create', status: 'completed' }, state.context);
    assert.equal(result.ok, true);
  }
  assert.equal(state.prompts.length, 0);
  assert.equal(state.requests.length, 5);
  assert.ok(state.requests.every(request => request.method === 'GET' && request.body === undefined));
});

for (const protocol of ['json', 'native']) {
  test(`${protocol} todo.create accepts listId and preserves its approved task payload`, async t => {
    const state = fixture(t);
    const call = parseCall(protocol, 'todo.create', { listId: LIST, title: 'Fixture new task' });
    const result = await runToolCall(state.context.agentId, call.name, call.arguments, state.context);
    assert.equal(result.ok, true);
    assert.equal(state.prompts.length, 1);
    assert.deepEqual(state.requests, [{ pathname: `/v1.0/me/todo/lists/${LIST}/tasks`, method: 'POST',
      body: { title: 'Fixture new task' }, authorization: `Bearer ${ACCESS}` }]);
  });

  test(`${protocol} todo.update accepts listId and taskId with canonical selector combinations`, async t => {
    const state = fixture(t);
    for (const selectors of [{ listId: LIST, taskId: TASK }, { list: LIST, taskId: TASK }, { listId: LIST, id: TASK }]) {
      const call = parseCall(protocol, 'todo.update', { ...selectors, title: 'Fixture revised task' });
      const result = await runToolCall(state.context.agentId, call.name, call.arguments, state.context);
      assert.equal(result.ok, true);
      assert.deepEqual(state.requests.at(-1), { pathname: `/v1.0/me/todo/lists/${LIST}/tasks/${TASK}`, method: 'PATCH',
        body: { title: 'Fixture revised task' }, authorization: `Bearer ${ACCESS}` });
    }
    assert.equal(state.prompts.length, 3);
    assert.equal(state.requests.length, 3);
  });
}

test('To Do writes accept equal canonical and alias selectors', async t => {
  const state = fixture(t);
  const created = await runToolCall(state.context.agentId, 'todo.create',
    { list: LIST, listId: LIST, title: 'Fixture new task' }, state.context);
  const updated = await runToolCall(state.context.agentId, 'todo.update',
    { list: LIST, listId: LIST, id: TASK, taskId: TASK, categories: [] }, state.context);
  assert.equal(created.ok, true);
  assert.equal(updated.ok, true);
  assert.equal(state.prompts.length, 2);
  assert.deepEqual(state.requests.map(request => request.body), [{ title: 'Fixture new task' }, { categories: [] }]);
});

test('To Do write selector conflicts fail before approval or any request', async t => {
  const state = fixture(t);
  const cases = [
    ['todo.create', { list: LIST, listId: 'fixture-other-list', title: 'Fixture task' }],
    ['todo.update', { list: LIST, listId: 'fixture-other-list', id: TASK, title: 'Fixture task' }],
    ['todo.update', { list: LIST, id: TASK, taskId: 'fixture-other-task', title: 'Fixture task' }],
  ];
  for (const [name, args] of cases) {
    const result = await runToolCall(state.context.agentId, name, args, state.context);
    assert.equal(result.ok, false);
    assert.match(result.error, /list|task|id|selector/i);
  }
  assert.equal(state.prompts.length, 0, 'ambiguous targets must not reach an approval prompt');
  assert.equal(state.requests.length, 0);
});

test('malformed To Do write selectors cannot fall back to a valid alias or canonical field', async t => {
  const state = fixture(t);
  for (const invalid of ['', '   ', null, 42, false, {}, [], 'x'.repeat(257)]) {
    const cases = [
      ['todo.create', { listId: invalid }],
      ['todo.create', { list: LIST, listId: invalid }],
      ['todo.create', { list: invalid, listId: LIST }],
      ['todo.update', { listId: invalid, taskId: TASK }],
      ['todo.update', { listId: LIST, taskId: invalid }],
      ['todo.update', { list: LIST, listId: invalid, id: TASK }],
      ['todo.update', { list: LIST, id: TASK, taskId: invalid }],
      ['todo.update', { list: invalid, listId: LIST, taskId: TASK }],
      ['todo.update', { listId: LIST, id: invalid, taskId: TASK }],
    ];
    for (const [name, selectors] of cases) {
      const result = await runToolCall(state.context.agentId, name, { ...selectors, title: 'Fixture task' }, state.context);
      assert.equal(result.ok, false, `${name} must reject malformed supplied selectors`);
      assert.match(result.error, /list|task|id|selector|resource|argument/i);
    }
  }
  assert.equal(state.prompts.length, 0);
  assert.equal(state.requests.length, 0);
});

test('native To Do write schemas expose supported list and task selector aliases', () => {
  const native = name => toolDefs().find(tool => tool.function.name === nativeToolName(name)).function;
  assert.equal(native('todo.create').parameters.properties.listId.type, 'string');
  assert.equal(native('todo.update').parameters.properties.listId.type, 'string');
  assert.equal(native('todo.update').parameters.properties.taskId.type, 'string');
});

test('To Do write tools are present in the catalog, companion, JSON instructions, and native schemas', () => {
  const plugins = { todo: { enabled: true, accessToken: ACCESS, scope: 'Tasks.ReadWrite' } };
  const apps = createAppConnections({ getSettings: () => ({ plugins }), saveSettings() {}, openExternal() {} });
  const catalog = apps.catalog().find(app => app.id === 'todo');
  const companion = companionSettings({}, plugins);
  const json = actionInstruction();
  for (const definition of definitions) {
    assert.ok(catalog.actions.includes(definition.name));
    assert.equal(companion.disabledTools.includes(definition.name), false);
    assert.equal(TOOLS[definition.name].class, 'write');
    assert.equal(TOOLS[definition.name].approval, true);
    const native = toolDefs().find(tool => tool.function.name === nativeToolName(definition.name)).function;
    for (const field of Object.keys(definition.args)) assert.ok(native.parameters.properties[field], `${definition.name} advertises ${field}`);
    assert.ok(json.includes(`"name":"${definition.name}"`));
  }
  assert.doesNotMatch(JSON.stringify(catalog), /fixture-private-/);
});
