'use strict';

/* Browser providers emit only their settled final answer as content.
 * Temporary DOM text can include a Thinking header or a block that the
 * page later rewrites; reasoning/activity events may still stream live. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBridgeHandler } = require('../copilot/tray/bridge.js');

function startBridge(senders) {
  const handler = createBridgeHandler(
    senders.copilot, senders.chatgpt, senders.codegpt,
    () => ({ ok: true, service: 'test' }), null, undefined, senders.gemini);
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function parseEvents(body) {
  return body.split('\n').filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6).trim()).filter((line) => line !== '');
}

test('CodeGPT streaming sends the final answer once while reasoning stays live', async () => {
  const sendCodegpt = async (_text, { onDelta, onReasoning }) => {
    assert.equal(onDelta, undefined, 'CodeGPT DOM text is provisional');
    assert.equal(typeof onReasoning, 'function');
    onReasoning('Reasoning activity');
    return 'Hello world';
  };
  const { server, port } = await startBridge({
    copilot: async () => 'x', chatgpt: async () => 'x', codegpt: sendCodegpt,
  });
  try {
    const res = await request(port, { model: 'codegpt-eco', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/event-stream/);
    const events = parseEvents(res.body);
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    const contents = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    const reasoning = chunks.map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content).filter(Boolean);
    assert.deepEqual(contents, ['Hello world']);
    assert.deepEqual(reasoning, ['Reasoning activity']);
    assert.equal(chunks.find((chunk) => chunk.choices?.[0]?.delta?.content)?.choices[0].delta.role, 'assistant');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  } finally { server.close(); }
});

test('streaming: a sender without partials still yields one content chunk', async () => {
  const { server, port } = await startBridge({
    copilot: async () => 'complete answer', chatgpt: async () => 'x', codegpt: async () => 'x',
  });
  try {
    const res = await request(port, { model: 'copilot-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const chunks = parseEvents(res.body).slice(0, -1).map((event) => JSON.parse(event));
    const contents = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    assert.deepEqual(contents, ['complete answer'], 'full answer as the only content chunk');
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  } finally { server.close(); }
});

test('Gemini requests use only the selected Gemini sender', async () => {
  const calls = [];
  const { server, port } = await startBridge({
    copilot: async () => { calls.push('copilot'); return 'wrong'; },
    chatgpt: async () => { calls.push('chatgpt'); return 'wrong'; },
    codegpt: async () => { calls.push('codegpt'); return 'wrong'; },
    gemini: async (text, options) => {
      calls.push('gemini');
      assert.equal(text, 'user: hi');
      assert.equal(options.model, 'gemini-chat');
      assert.equal(options.onDelta, undefined);
      return 'Gemini final answer';
    },
  });
  try {
    const res = await request(port, { model: 'gemini-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['gemini']);
    const events = parseEvents(res.body);
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map(event => JSON.parse(event));
    assert.deepEqual(chunks.map(chunk => chunk.choices?.[0]?.delta?.content).filter(Boolean), ['Gemini final answer']);
  } finally { server.close(); }
});

test('browser providers send only settled final answers, never provisional DOM text', async () => {
  const sendBrowser = async (_text, { onDelta }) => {
    assert.equal(onDelta, undefined, 'browser DOM deltas are unverified and must not be forwarded');
    return 'final answer';
  };
  const { server, port } = await startBridge({
    copilot: sendBrowser, chatgpt: sendBrowser, codegpt: async () => 'x',
  });
  try {
    for (const model of ['copilot-chat', 'chatgpt-chat']) {
      const res = await request(port, { model, stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      const chunks = parseEvents(res.body).slice(0, -1).map((event) => JSON.parse(event));
      const contents = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter(Boolean);
      assert.deepEqual(contents, ['final answer']);
      assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
    }
  } finally { server.close(); }
});

test('empty browser replies are errors rather than successful completions', async () => {
  const { server, port } = await startBridge({
    copilot: async () => ' ', chatgpt: async () => '', codegpt: async () => 'x',
  });
  try {
    const messages = [{ role: 'user', content: 'hi' }];
    const nonstream = await request(port, { model: 'copilot-chat', stream: false, messages });
    assert.equal(nonstream.status, 502);
    assert.match(JSON.parse(nonstream.body).error.message, /no final answer/i);
    const stream = await request(port, { model: 'chatgpt-chat', stream: true, messages });
    assert.equal(stream.status, 200);
    const events = parseEvents(stream.body);
    assert.match(JSON.parse(events[0]).error.message, /no final answer/i);
    assert.equal(events.at(-1), '[DONE]');
  } finally { server.close(); }
});

test('CodeGPT provisional DOM text cannot contaminate the final stream', async () => {
  const sendCodegpt = async (_text, { onDelta }) => {
    assert.equal(onDelta, undefined, 'provisional DOM text must not be emitted');
    return 'STREAM_CHECK_6A91';
  };
  const { server, port } = await startBridge({
    copilot: async () => 'x', chatgpt: async () => 'x', codegpt: sendCodegpt,
  });
  try {
    const res = await request(port, { model: 'codegpt-eco', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const chunks = parseEvents(res.body).slice(0, -1).map((event) => JSON.parse(event));
    const contents = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    assert.deepEqual(contents, ['STREAM_CHECK_6A91']);
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  } finally { server.close(); }
});

test('non-streaming: one JSON body, onDelta never wired', async () => {
  const sendCopilot = async (text, options) => {
    assert.equal(options.onDelta, undefined, 'onDelta must not be wired for non-stream requests');
    return 'full text';
  };
  const { server, port } = await startBridge({
    copilot: sendCopilot, chatgpt: async () => 'x', codegpt: async () => 'x',
  });
  try {
    const res = await request(port, { model: 'copilot-chat', stream: false, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.choices[0].message.content, 'full text');
    assert.equal(parsed.object, 'chat.completion');
  } finally { server.close(); }
});

test('CodeGPT Economy limit has the same structured error in JSON and SSE', async () => {
  const failure = () => Object.assign(new Error('CodeGPT Economy is already serving another interactive session.'), {
    code: 'ECONOMY_CONCURRENCY_LIMIT', status: 429, provider: 'codegpt',
    retryable: true, retryAfterSeconds: 15,
  });
  const { server, port } = await startBridge({
    copilot: async () => 'x', chatgpt: async () => 'x', codegpt: async () => { throw failure(); },
  });
  const messages = [{ role: 'user', content: 'hi' }];
  try {
    const nonstream = await request(port, { model: 'codegpt-eco', stream: false, messages });
    assert.equal(nonstream.status, 429);
    assert.equal(nonstream.headers['retry-after'], '15');
    const detail = JSON.parse(nonstream.body).error;
    assert.deepEqual(detail, {
      code: 'ECONOMY_CONCURRENCY_LIMIT', status: 429, provider: 'codegpt',
      message: 'CodeGPT Economy is already serving another interactive session.',
      retryable: true, retryAfterSeconds: 15,
    });
    const stream = await request(port, { model: 'codegpt-eco', stream: true, messages });
    assert.equal(stream.status, 200);
    const events = parseEvents(stream.body);
    assert.equal(events.at(-1), '[DONE]');
    assert.deepEqual(JSON.parse(events[0]).error, detail);
  } finally { server.close(); }
});
