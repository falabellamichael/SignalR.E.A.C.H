'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { actionInstruction, parseActionResponse } = require('../agent/agent-action.cjs');
const { parseAgentResponse } = require('../agent/agent-response.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { defaults } = require('../agent/budgets.cjs');

const toolName = 'roblox-studio__start_stop_play';
const toolArguments = { datamodel_type: 'Edit', action: 'start' };
const descriptor = {
  name: toolName,
  description: 'Start or stop Play in the specified datamodel.',
  inputSchema: {
    type: 'object',
    properties: {
      datamodel_type: { type: 'string', enum: ['Edit', 'Play'] },
      action: { type: 'string', enum: ['start', 'stop'] },
    },
    required: ['datamodel_type', 'action'],
  },
};
const actionResponse = (args = toolArguments, name = toolName) => JSON.stringify({
  status: 'actions',
  message: 'Starting Play to build the strip in the Play DM and verify it renders.',
  actions: [{ name, arguments: args }],
  options: [],
});
const prose = 'All redlines confirmed stale - saved files are correct. Starting Play to verify the strip builds and renders.';

for (const [label, reply] of [
  ['exact structured MCP call', actionResponse()],
  ['prose-wrapped MCP call', prose + '\n' + actionResponse()],
  ['stringified MCP arguments', actionResponse(JSON.stringify(toolArguments))],
]) {
  test(`${label} preserves the external action parameter and displays only its message`, () => {
    const structured = parseActionResponse(reply);
    assert.equal(structured.error, undefined);
    assert.deepEqual(structured.actions, [{ name: toolName, arguments: toolArguments }]);
    const parsed = parseAgentResponse(reply);
    assert.equal(parsed.invalid, false);
    assert.deepEqual(parsed.actions, structured.actions);
    assert.equal(parsed.display, structured.message);
    assert.equal(parsed.control, null);
    assert.equal(parsed.confirm, null);
  });
}

test('MCP prompt scopes the legacy discriminator restriction to built-ins', () => {
  const prompt = actionInstruction({ mcpTools: [descriptor] });
  assert.match(prompt, /For built-in tools, do not put action inside arguments/);
  assert.match(prompt, /MCP tools[^.]*including a parameter named action/);
  assert.match(prompt, /MCP tools retain all fields required by their input schema/);
});

test('built-in structured calls still reject the legacy action discriminator', () => {
  for (const args of [{ path: 'index.rsh', action: 'read' }, JSON.stringify({ path: 'index.rsh', action: 'read' })]) {
    const reply = actionResponse(args, 'read');
    assert.ok(parseActionResponse(reply).error);
    const parsed = parseAgentResponse(reply);
    assert.equal(parsed.invalid, true);
    assert.deepEqual(parsed.actions, []);
  }
  assert.equal(parseActionResponse(actionResponse({ path: 'index.rsh' }, 'read')).error, undefined);
});

test('MCP arguments must still be an object and MCP names must remain canonical', () => {
  for (const args of [[], '[]', 1, 'start']) {
    assert.ok(parseActionResponse(actionResponse(args)).error);
  }
  for (const name of ['roblox-studio_start_stop_play', 'start_stop_play', 'unknown_tool']) {
    assert.ok(parseActionResponse(actionResponse(toolArguments, name)).error);
  }
});

test('terminal and question responses retain their controls and cannot contain MCP actions', () => {
  for (const status of ['complete', 'blocked', 'question']) {
    const response = { status, message: 'Fixture result.', actions: [], options: status === 'question' ? ['Continue'] : [] };
    const parsed = parseAgentResponse(JSON.stringify(response));
    assert.equal(parsed.invalid, false);
    assert.deepEqual(parsed.actions, []);
    if (status === 'question') {
      assert.deepEqual(parsed.confirm, { question: response.message, options: response.options });
      assert.equal(parsed.control, null);
    } else {
      assert.deepEqual(parsed.control, { status, [status === 'complete' ? 'summary' : 'reason']: response.message });
      assert.equal(parsed.confirm, null);
    }
    response.actions = [{ name: toolName, arguments: toolArguments }];
    assert.ok(parseActionResponse(JSON.stringify(response)).error);
    assert.equal(parseAgentResponse(JSON.stringify(response)).invalid, true);
  }
  assert.ok(parseActionResponse(JSON.stringify({ status: 'actions', message: 'Starting Play.', actions: [], options: [] })).error);
});

for (const [label, reply] of [
  ['structured', actionResponse()],
  ['prose-wrapped', prose + '\n' + actionResponse()],
  ['stringified arguments', actionResponse(JSON.stringify(toolArguments))],
]) {
  test(`AgentLoop dispatches ${label} MCP action arguments without recovery or pause`, { timeout: 5000 }, async t => {
    const requests = [], calls = [], events = [];
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json');
      if (requests.length > 2) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'Unexpected format recovery.' } }));
        return;
      }
      const content = requests.length === 1 ? reply : JSON.stringify({
        status: 'complete', message: 'The fixture Play action completed.', actions: [], options: [],
      });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }));
    const mcpManager = {
      toolDescriptors: async () => [descriptor],
      callTool: async (name, args, { signal }) => {
        assert.ok(signal instanceof AbortSignal);
        calls.push({ name, args });
        return { ok: true, text: 'Fixture Play started.' };
      },
    };
    const store = new MemoryStore();
    const agent = store.get('mcp-action-fixture');
    const loop = new AgentLoop({
      agentId: agent.id, store, mcpManager, model: 'Qwen/Qwen3.8-27B-FP8',
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      budgets: { ...defaults, retryLimit: 0, requestPacing: false, codeContext: false, autoCompact: false },
      sendEvent: (_, event) => events.push(event),
    });
    await loop.sendUserMessage('Start Play in the fixture.');
    assert.deepEqual(calls, [{ name: toolName, args: toolArguments }]);
    assert.equal(requests.length, 2);
    assert.equal(agent.runState.status, 'completed');
    assert.equal(agent.runState.noActionRounds, 0);
    assert.equal(events.filter(event => event.type === 'recovery').length, 0);
    assert.equal(events.filter(event => event.type === 'tool-call').length, 1);
    assert.ok(!agent.messages.some(message => message._reachMeta?.source === 'recovery'));
    assert.deepEqual(agent.messages.filter(message => message.role === 'assistant').map(message => message._reachMeta.display), [
      JSON.parse(actionResponse()).message,
      'The fixture Play action completed.',
    ]);
    assert.ok(requests[1].messages.some(message => typeof message.content === 'string' && message.content.includes('Fixture Play started.')));
  });
}
