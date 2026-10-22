'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TeamRunner } = require('../agent/team-runner.cjs');
const { AgentNet } = require('../agent/agent-net.cjs');
const { nativeToolName } = require('../agent/agent-action.cjs');

const MODEL_ENDPOINT = 'https://team-connections.example.test/v1';
const secrets = ['fixture-private-access-one', 'fixture-private-access-two',
  'fixture-private-refresh', 'fixture-private-client-secret', 'fixture-private-model-key'];
const signIn = (accessToken = secrets[0]) => ({
  todo: { enabled: true, accessToken, refreshToken: secrets[2], clientSecret: secrets[3],
    expiresAt: Date.now() + 3600000, scope: 'Tasks.Read' },
});
const action = (name, args = {}) => ({ name, arguments: args });
const actions = (...items) => ({ status: 'actions', message: 'Reading the connected app.', actions: items });
const complete = message => ({ status: 'complete', message, actions: [] });
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

// Both provider and Graph requests are intercepted. No provider, profile, or
// OAuth service is contacted; real AgentLoops and the actual todo.read run.
function mockRequests(t, nextReply) {
  const prompts = [], graph = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.origin === new URL(MODEL_ENDPOINT).origin) {
      const body = JSON.parse(options.body);
      prompts.push(structuredClone(body));
      const reply = await nextReply(body);
      const native = Array.isArray(body.tools);
      const calls = reply.status === 'complete'
        ? [action('task_complete', { summary: reply.message })] : reply.actions;
      const message = native ? { content: null, tool_calls: calls.map((call, index) => ({
        id: `call-${prompts.length}-${index}`, type: 'function',
        function: { name: nativeToolName(call.name), arguments: JSON.stringify(call.arguments) },
      })) } : { content: JSON.stringify(reply) };
      return response({ choices: [{ message, finish_reason: native ? 'tool_calls' : 'stop' }] });
    }
    assert.equal(target.origin, 'https://graph.microsoft.com', 'unexpected external request');
    assert.equal(target.pathname, '/v1.0/me/todo/lists');
    assert.equal(options.method, 'GET', 'app verification stays read-only');
    graph.push(new Headers(options.headers).get('authorization'));
    return response({ value: [{ id: 'fixture-list', displayName: 'Connected task lists' }] });
  });
  return { prompts, graph };
}

function makeRunner({ mode = 'parallel', toolProtocol = 'json', getPlugins, events, journal }) {
  return new TeamRunner({
    team: { id: 'connected-team', name: 'Connected crew', mode, toolProtocol, nurse: false, members: ['ceo'] },
    personas: [{ id: 'ceo', name: 'CEO', model: 'coordinator', prompt: '' }],
    task: 'Read the Microsoft To Do task lists.', projectDir: '',
    endpoint: MODEL_ENDPOINT, accessKey: secrets[4], defaultModel: 'coordinator',
    getPlugins, agentSettings: {}, journal,
    sendEvent: (channel, payload) => events.push({ channel, payload }),
  });
}

function assertNoSecrets(value) {
  const exposed = JSON.stringify(value);
  for (const secret of secrets) assert.equal(exposed.includes(secret), false, 'credentials must stay outside agent-visible data');
}

function assertConnectedPrompt(body) {
  const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.match(system, /"app":"todo","enabled":true,"authentication":"saved sign-in"/);
}

for (const toolProtocol of ['json', 'native']) {
for (const mode of ['parallel', 'chain', 'links']) {
  test(`${mode} ${toolProtocol} TeamRunner roster uses the current saved app sign-in without copying credentials`, async t => {
    let calls = 0;
    const fixture = mockRequests(t, () => calls++ === 0
      ? actions(action('todo.read', { limit: 1 }))
      : complete('The connected task lists were read successfully. LINKS: COMPLETE'));
    const events = [], journalEntries = [];
    const runner = makeRunner({ mode, toolProtocol, getPlugins: () => signIn(), events,
      journal: { append: (...entry) => journalEntries.push(entry), evidence: () => [] } });
    t.after(() => runner.stop());

    const results = await runner.run(`app-sign-in-${mode}`);
    const member = runner.net.agents.get('m0-ceo');
    const state = member.store.get(member.id);
    assert.deepEqual(fixture.graph, [`Bearer ${secrets[0]}`],
      'the roster must reach Graph through the saved OAuth sign-in');
    assert.ok(results[0], JSON.stringify(events.filter(event => event.payload.type === 'error')));
    assert.equal(results[0].ok, true);
    assert.match(JSON.stringify(state.messages), /Connected task lists/);
    assert.doesNotMatch(JSON.stringify(state.messages), /Connect todo in Connections first/);
    assertConnectedPrompt(fixture.prompts[0]);
    assert.equal(state.settings.plugins, undefined, 'app credentials must not be copied into member settings');
    assertNoSecrets({ prompts: fixture.prompts, events, journalEntries, state,
      snapshot: runner.net.snapshot(), list: runner.net.list(member.id) });
  });
}

test(`${toolProtocol} TeamRunner passes saved app sign-in access through AgentNet to a model-spawned worker`, async t => {
  const counts = new Map();
  const fixture = mockRequests(t, body => {
    const count = counts.get(body.model) || 0;
    counts.set(body.model, count + 1);
    if (body.model === 'coordinator') return count === 0
      ? actions(action('agent.spawn', { name: 'Task reader', model: 'task-reader', task: 'Read Microsoft To Do lists.' }))
      : complete('The task reader was assigned the connected list check.');
    assert.equal(body.model, 'task-reader');
    return count === 0 ? actions(action('todo.read', { limit: 1 }))
      : complete('The worker read the connected task lists successfully.');
  });
  const events = [];
  const runner = makeRunner({ toolProtocol, getPlugins: () => signIn(), events });
  t.after(() => runner.stop());
  await runner.run('app-sign-in-spawn');

  const worker = [...runner.net.agents.values()].find(agent => agent.origin === 'spawned');
  assert.ok(worker, 'the real agent.spawn tool created a worker');
  assert.deepEqual(fixture.graph, [`Bearer ${secrets[0]}`], 'spawned workers inherit app authentication access');
  assert.equal(worker.status, 'completed');
  assert.match(JSON.stringify(worker.store.get(worker.id).messages), /Connected task lists/);
  assertConnectedPrompt(fixture.prompts.find(body => body.model === 'task-reader'));
  const states = [...runner.net.agents.values()].map(agent => agent.store.get(agent.id));
  assert.ok(states.every(state => state.settings.plugins === undefined));
  assertNoSecrets({ prompts: fixture.prompts, events, states, snapshot: runner.net.snapshot() });
});

test(`an existing ${toolProtocol} spawned worker re-reads app sign-in after token rotation and revocation`, async t => {
  let plugins = signIn(), calls = 0;
  const fixture = mockRequests(t, () => {
    const call = calls++;
    if (call === 0) return actions(action('todo.read', { limit: 1 }));
    if (call === 1) {
      // Replace the object, as settings reloads do, after the worker exists.
      plugins = signIn(secrets[1]);
      return actions(action('todo.read', { limit: 1 }));
    }
    if (call === 2) {
      plugins = { todo: { enabled: false } };
      return actions(action('todo.read', { limit: 1 }));
    }
    return complete('Two authorized reads completed; the disconnected app is unavailable.');
  });
  const events = [], journalEntries = [];
  const net = new AgentNet({ teamRunId: 'app-sign-in-rotation', endpoint: MODEL_ENDPOINT,
    accessKey: secrets[4], defaultModel: 'task-reader', getPlugins: () => plugins,
    nativeTools: toolProtocol === 'native',
    sendEvent: (channel, payload) => events.push({ channel, payload }),
    journal: { append: (...entry) => journalEntries.push(entry) } });
  t.after(() => net.stop());
  const spawned = net.spawn({ name: 'Task reader', task: 'Read the Microsoft To Do task lists.' });
  assert.equal(spawned.ok, true);
  await net.settle();

  const worker = net.agents.get(spawned.agentId), state = worker.store.get(worker.id);
  assert.deepEqual(fixture.graph, [`Bearer ${secrets[0]}`, `Bearer ${secrets[1]}`],
    'rotation must take effect immediately and revocation must prevent a third API request');
  assert.match(JSON.stringify(state.messages), /This app connection is disabled/);
  assertConnectedPrompt(fixture.prompts[0]);
  const finalSystem = fixture.prompts.at(-1).messages.find(message => message.role === 'system').content;
  assert.match(finalSystem, /"app":"todo","enabled":false,"authentication":"not connected"/);
  assert.equal(state.settings.plugins, undefined);
  assertNoSecrets({ prompts: fixture.prompts, events, journalEntries, state, snapshot: net.snapshot(), list: net.list(worker.id) });
});
}
