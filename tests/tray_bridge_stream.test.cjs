'use strict';

/* The tray bridge must forward the reply while the page forms it: every
 * onDelta from the sender becomes its own SSE chunk, the accumulated deltas
 * must equal the sender's final answer (the bridge tops up any tail), and
 * non-streaming requests must stay single JSON bodies with onDelta unwired. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBridgeHandler } = require('../copilot/tray/bridge.js');

function startBridge(senders) {
  const handler = createBridgeHandler(
    senders.copilot, senders.chatgpt, senders.codegpt,
    () => ({ ok: true, service: 'test' }), null);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('streaming: each sender delta is its own SSE chunk and the stream totals the answer', async () => {
  const seen = [];
  const sendCopilot = async (text, { onDelta }) => {
    assert.equal(typeof onDelta, 'function', 'streaming requests wire onDelta');
    for (const part of ['Hel', 'lo ', 'world']) {
      onDelta(part);
      seen.push(part);
      await sleep(20);
    }
    return 'Hello world';
  };
  const { server, port } = await startBridge({
    copilot: sendCopilot, chatgpt: async () => 'x', codegpt: async () => 'x',
  });
  try {
    const res = await request(port, { model: 'copilot-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/event-stream/);
    const events = parseEvents(res.body);
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    const contents = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    assert.deepEqual(seen, ['Hel', 'lo ', 'world'], 'sender deltas went out live');
    assert.equal(contents.length, 3, 'no extra content chunk: totals already match');
    assert.equal(contents.join(''), 'Hello world');
    assert.equal(chunks[0].choices[0].delta.role, 'assistant', 'first chunk carries the role');
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

test('streaming: a tail that only exists in the final text is topped up after the deltas', async () => {
  const sendCopilot = async (text, { onDelta }) => {
    onDelta('partial');
    return 'partial answer that continued';
  };
  const { server, port } = await startBridge({
    copilot: sendCopilot, chatgpt: async () => 'x', codegpt: async () => 'x',
  });
  try {
    const res = await request(port, { model: 'copilot-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const chunks = parseEvents(res.body).slice(0, -1).map((event) => JSON.parse(event));
    const contents = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter(Boolean);
    assert.equal(contents.join(''), 'partial answer that continued', 'stream equals the final answer');
    assert.equal(contents.length, 2, 'delta + tail');
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
