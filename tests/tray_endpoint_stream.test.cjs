'use strict';

/* The tray MiniChat now streams: endpoint.chat(config, messages, onDelta)
 * forwards SSE deltas while the endpoint generates the reply and resolves
 * with the accumulated text. Non-SSE endpoints must still work (JSON unwrap),
 * and callers without onDelta keep the old single-request behaviour. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEndpointClient } = require('../copilot/tray/endpoint');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function clientFor(t, base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = createEndpointClient(path.join(dir, 'settings.json'));
  client.saveSettings({ endpoint: base + '/v1', model: 'demo' });
  return client;
}

test('chat with onDelta streams SSE deltas and resolves with the full text', async (t) => {
  let sawStreamFlag = null;
  let sawAccept = null;
  const base = await serve(t, (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'demo' }] }));
    if (req.url === '/v1/chat/completions') {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', async () => {
        const body = JSON.parse(text);
        sawStreamFlag = body.stream;
        sawAccept = req.headers.accept;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const part of ['Hel', 'lo ', 'world']) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: part } }] }) + '\n\n');
          await sleep(20);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const client = clientFor(t, base);
  const deltas = [];
  const content = await client.chat(client.getSettings(), [{ role: 'user', content: 'hi' }],
    (delta) => deltas.push(delta));
  assert.deepEqual(deltas, ['Hel', 'lo ', 'world'], 'every delta is forwarded as it arrives');
  assert.equal(content, 'Hello world');
  assert.equal(sawStreamFlag, true, 'the stream request is explicit');
  assert.match(String(sawAccept || ''), /event-stream/);
});

test('chat with onDelta still unwraps a JSON reply from an endpoint that ignores stream', async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'demo' }] }));
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'JSON OK' } }] }));
    }
    res.writeHead(404);
    res.end();
  });
  const client = clientFor(t, base);
  const deltas = [];
  const content = await client.chat(client.getSettings(), [{ role: 'user', content: 'hi' }],
    (delta) => deltas.push(delta));
  assert.equal(content, 'JSON OK');
  assert.deepEqual(deltas, [], 'a non-SSE reply produces no deltas');
});

test('chat without onDelta stays a single non-stream request', async (t) => {
  let captured = null;
  const base = await serve(t, (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'demo' }] }));
    if (req.url === '/v1/chat/completions') {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        captured = JSON.parse(text);
        res.end(JSON.stringify({ choices: [{ message: { content: 'PLAIN OK' } }] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const client = clientFor(t, base);
  assert.equal(await client.chat(client.getSettings(), [{ role: 'user', content: 'hi' }]), 'PLAIN OK');
  assert.equal(captured.stream, false);
});

test('streaming chat merges stacked system messages too', async (t) => {
  let captured = null;
  const base = await serve(t, (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'demo' }] }));
    if (req.url === '/v1/chat/completions') {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        captured = JSON.parse(text);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const client = clientFor(t, base);
  const messages = [{ role: 'system', content: 'CTX' }, { role: 'system', content: 'RULES' },
    { role: 'user', content: 'Hi' }];
  assert.equal(await client.chat(client.getSettings(), messages, () => {}), 'OK');
  assert.deepEqual(captured.messages, [{ role: 'system', content: 'CTX\n\nRULES' },
    { role: 'user', content: 'Hi' }]);
});
