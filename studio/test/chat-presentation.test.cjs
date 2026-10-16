'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chatDisplayText, chatPreviewText } = require('../agent/agent-response.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { defaults } = require('../agent/budgets.cjs');

const envelope = (message, status = 'complete', actions = []) => JSON.stringify({ status, message, actions, options: [] });

test('chat presentation unwraps only complete action envelopes and preserves answer formatting', () => {
  const message = 'Ready.\n\n**Code:** `{"value": 1}`\nQuotes: "hello"; path: D:\\project.';
  for (const status of ['complete', 'actions', 'question', 'blocked']) {
    const raw = envelope(message, status);
    assert.equal(chatDisplayText(raw), message);
    assert.equal(chatDisplayText('```json\n' + raw + '\n```'), message);
  }
  for (const text of ['Normal prose.', '{"message":"ordinary data"}', '[1,2,3]', '{unfinished',
    '```json\n{"message":"ordinary data"}\n```', 'Example:\n```json\n' + envelope(message) + '\n```']) {
    assert.equal(chatDisplayText(text), text);
  }
});

test('fragmented protocol envelopes never become streaming text', () => {
  for (const raw of [envelope('Hello.'), '  \n' + envelope('Hello.'),
    '```json\n' + envelope('Hello.') + '\n```', '```\n' + envelope('Hello.') + '\n```']) {
    for (let end = 1; end <= raw.length; end++) assert.equal(chatPreviewText(raw.slice(0, end)), '');
  }
  for (const text of ['Hello.', 'Here is {ordinary text}.', '```javascript\nconst x = 1;\n```']) {
    assert.equal(chatPreviewText(text), text);
  }
});

function streamedResponse(content) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    for (const character of content) {
      controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: character } }] }) + '\n\n'));
    }
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

function fixture(replies) {
  const store = new MemoryStore(), agent = store.get('chat-presentation'), events = [], requests = [];
  const loop = new AgentLoop({ agentId: agent.id, store, model: 'fixture',
    budgets: { ...defaults, autoCompact: false, codeContext: false, requestPacing: false },
    sendEvent: (_, event) => events.push(event) });
  loop._fetchChat = async messages => {
    requests.push(messages);
    assert.ok(requests.length <= replies.length, 'no unexpected format-recovery request');
    return streamedResponse(replies[requests.length - 1]);
  };
  return { loop, agent, events, requests };
}

test('switching Agent mode off renders the inherited JSON format as a normal reply', async () => {
  const f = fixture([envelope('Hi!'), envelope('Ready to help.')]);
  await f.loop.sendUserMessage('hey');
  f.agent.settings.features = { agent: false };
  await f.loop.sendUserMessage('how are you?');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.events.filter(e => e.type === 'message-end').map(e => e.content), ['Hi!', 'Ready to help.']);
  assert.equal(f.events.filter(e => e.type === 'delta').length, 0, 'protocol bytes never reach the renderer');
  assert.equal(f.agent.messages.at(-1).content, 'Ready to help.');
  assert.equal(f.agent.messages.at(-1)._reachMeta.display, 'Ready to help.');
  assert.equal(f.agent.runState.status, 'completed');
});

test('chat mode displays the message without executing action proposals or opening questions', async () => {
  for (const status of ['actions', 'question', 'blocked']) {
    const f = fixture([envelope('Visible message.', status, [{ name: 'write', arguments: { path: 'never-written.txt', content: 'no' } }])]);
    f.agent.settings.features = { agent: false };
    await f.loop.sendUserMessage('hello');
    assert.equal(f.agent.messages.at(-1).content, 'Visible message.');
    assert.equal(f.events.filter(e => e.type === 'tool-call' || e.question).length, 0);
    assert.equal(f.requests.length, 1);
  }
});

test('ordinary chat still streams and preserves prose, Markdown and JSON examples', async () => {
  for (const answer of ['Hello!\n\n**Ready to help.**', 'Example:\n```json\n' + envelope('Example only.') + '\n```',
    '{"message":"ordinary JSON data"}']) {
    const f = fixture([answer]);
    f.agent.settings.features = { agent: false };
    await f.loop.sendUserMessage('hello');
    assert.equal(f.agent.messages.at(-1).content, answer);
    assert.equal(f.events.find(e => e.type === 'message-end').content, answer);
    if (!answer.startsWith('{')) assert.equal(f.events.filter(e => e.type === 'delta').map(e => e.text).join(''), answer);
  }
});
