'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBridgeHandler } = require('../copilot/tray/bridge.js');

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('Gemini is listed but receives only explicit gemini-chat requests', async () => {
  const calls = [];
  const handler = createBridgeHandler(
    async () => 'Copilot answer', async () => 'ChatGPT answer', async () => 'CodeGPT answer',
    () => ({ ok: true }), null, () => {},
    async (text, options) => {
      calls.push({ text, model: options.model, onDelta: options.onDelta });
      return 'Gemini final answer';
    });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const models = await request(port, 'GET', '/v1/models');
    assert.equal(models.status, 200);
    assert.ok(JSON.parse(models.text).data.some((model) => model.id === 'gemini-chat'));
    assert.equal(calls.length, 0, 'model discovery must not send a prompt');

    const messages = [{ role: 'system', content: 'Only this request context' },
      { role: 'user', content: 'Explicit Gemini prompt' }];
    const copilot = await request(port, 'POST', '/v1/chat/completions', { messages, stream: false });
    assert.equal(copilot.status, 200);
    assert.equal(JSON.parse(copilot.text).model, 'copilot-chat');
    assert.equal(calls.length, 0, 'default requests must stay with Copilot');

    const gemini = await request(port, 'POST', '/v1/chat/completions',
      { model: 'gemini-chat', messages, stream: false });
    assert.equal(gemini.status, 200);
    assert.equal(JSON.parse(gemini.text).model, 'gemini-chat');
    assert.equal(JSON.parse(gemini.text).choices[0].message.content, 'Gemini final answer');
    assert.deepEqual(calls, [{ text: 'system: Only this request context\n\nuser: Explicit Gemini prompt',
      model: 'gemini-chat', onDelta: undefined }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
