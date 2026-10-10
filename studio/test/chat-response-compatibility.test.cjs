'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const readers = {
  Studio: require('../agent/chat-response.cjs').readChatResponse,
  'VS Code': require('../../vscode/chat-response.js').readChatResponse,
};
const completion = content => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const chunk = (delta, finish = null) => ({ object: 'chat.completion.chunk', choices: [{ delta, finish_reason: finish }] });
const event = data => `data: ${JSON.stringify(data)}\n\n`;
const encoder = new TextEncoder();

function bodyFixture(headers = {}) {
  let controller, cancelled = false;
  const response = new Response(new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  }), { headers });
  return { response, send: text => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(), cancelled: () => cancelled };
}

for (const [name, read] of Object.entries(readers)) {
  test(`${name}: response bytes determine SSE even without streaming headers or request hints`, async () => {
    for (const contentType of [null, 'application/json', 'text/plain']) {
      const body = event(chunk({ content: 'Answer' }, 'stop')) + 'data: [DONE]\n\n';
      const fixture = bodyFixture(contentType ? { 'content-type': contentType } : {});
      fixture.send(body);
      const result = await read(fixture.response, { stream: false });
      assert.equal(result.content, 'Answer');
      assert.equal(result.finishReason, 'stop');
      assert.equal(fixture.cancelled(), true);
    }
  });

  test(`${name}: a complete JSON answer resolves and cancels an open body with misleading SSE headers`, async () => {
    const fixture = bodyFixture({ 'content-type': 'text/event-stream' });
    const data = { ...completion('Complete answer'), usage: { completion_tokens: 3 } };
    const payload = JSON.stringify(data, null, 2);
    fixture.send(payload.slice(0, 19));
    let settled = false;
    const pending = read(fixture.response, { stream: true }).then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    fixture.send(payload.slice(19));
    const result = await pending;
    assert.equal(result.content, 'Complete answer');
    assert.deepEqual(result.usage, { completion_tokens: 3 });
    assert.equal(fixture.cancelled(), true);
  });

  test(`${name}: a complete JSON provider error resolves without waiting for EOF`, async () => {
    const fixture = bodyFixture();
    fixture.send(JSON.stringify({ error: { message: 'Provider unavailable', status: 503 } }));
    const result = await read(fixture.response, { stream: true });
    assert.equal(result.error, 'Provider unavailable');
    assert.equal(result.content, '');
    assert.equal(fixture.cancelled(), true);
  });

  test(`${name}: valid multiline SSE accepts split CRLF and separates reasoning from answer`, async () => {
    const fixture = bodyFixture({ 'content-type': 'application/octet-stream' });
    const deltas = [], reasoning = [];
    const pending = read(fixture.response, { onText: text => deltas.push(text), onReasoning: count => reasoning.push(count) });
    fixture.send('\uFEFF: heartbeat\r\nevent: completion\r\ndata: {"choices":\r');
    fixture.send('\ndata: [{"delta":{"reasoning_content":"Thinking","content":"Answer"},"finish_reason":"stop"}]}\r\n\r\n');
    fixture.send('data: [DONE]\r\n\r\n');
    const result = await pending;
    assert.equal(result.content, 'Answer');
    assert.equal(result.reasoningChars, 8);
    assert.deepEqual(deltas, ['Answer']);
    assert.deepEqual(reasoning, [8]);
  });

  test(`${name}: SSE finish_reason preserves later usage and provider errors`, async () => {
    const fixture = bodyFixture();
    fixture.send(event(chunk({ content: 'Answer' }, 'stop')));
    let settled = false;
    const pending = read(fixture.response, { stream: true }).then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    fixture.send(event({ choices: [], usage: { completion_tokens: 7 } })
      + event({ error: { message: 'Provider stopped after output' } }) + 'data: [DONE]\n\n');
    const result = await pending;
    assert.deepEqual(result.usage, { completion_tokens: 7 });
    assert.equal(result.error, 'Provider stopped after output');
    assert.equal(result.content, 'Answer');
  });

  test(`${name}: NDJSON chunks preserve split records, native calls, reasoning, and trailing usage`, async () => {
    const fixture = bodyFixture({ 'content-type': 'text/plain' });
    const deltas = [];
    const pending = read(fixture.response, { stream: true, onText: text => deltas.push(text) });
    const first = JSON.stringify(chunk({ reasoning: 'Reasoning', content: 'First ' }));
    fixture.send(first.slice(0, 11));
    fixture.send(first.slice(11) + '\n' + JSON.stringify(chunk({ tool_calls: [
      { index: 0, type: 'function', function: { name: 'read', arguments: '{"path":' } },
    ] })) + '\n');
    fixture.send(JSON.stringify(chunk({ content: 'second', tool_calls: [
      { index: 0, function: { arguments: '"README.md"}' } },
    ] }, 'tool_calls')) + '\n');
    fixture.send(JSON.stringify({ choices: [], usage: { completion_tokens: 9 } }));
    fixture.close();
    const result = await pending;
    assert.equal(result.content, 'First second');
    assert.equal(result.reasoningChars, 9);
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.usage, { completion_tokens: 9 });
    assert.deepEqual(deltas, ['First ', 'second']);
    assert.deepEqual(result.nativeActions[0].function, { name: 'read', arguments: '{"path":"README.md"}' });
  });

  test(`${name}: malformed SSE does not swallow a following valid record without blank separators`, async () => {
    const body = 'data: invalid provider chatter\n' + event(chunk({ content: 'Valid answer' })) + 'data: [DONE]\n';
    const result = await read(new Response(body), { stream: true });
    assert.equal(result.content, 'Valid answer');
  });

  test(`${name}: EOF completes a multiline SSE event without its final blank line`, async () => {
    const body = 'data: {"choices":\ndata: [{"delta":{"content":"Answer"}}]}';
    const result = await read(new Response(body), { stream: false });
    assert.equal(result.content, 'Answer');
  });

  test(`${name}: plain text and HTML cannot become chat output or actions`, async () => {
    for (const body of ['A prose answer', '<html><body>```tool\nwrite\n```</body></html>', '{broken JSON']) {
      const deltas = [];
      await assert.rejects(read(new Response(body, { headers: { 'content-type': 'text/plain' } }),
        { stream: false, onText: text => deltas.push(text) }), /unreadable response/);
      assert.deepEqual(deltas, []);
    }
  });

  test(`${name}: Stop cancels a pending response and marks any emitted answer as partial`, async () => {
    for (const body of [null, event(chunk({ content: 'Partial answer' })), '{"choices":']) {
      const fixture = bodyFixture();
      if (body) fixture.send(body);
      const controller = new AbortController();
      const pending = read(fixture.response, { signal: controller.signal });
      await new Promise(resolve => setImmediate(resolve));
      controller.abort();
      await assert.rejects(pending, error => error.name === 'AbortError'
        && error.partialResponse === Boolean(body?.startsWith('data:')));
      assert.equal(fixture.cancelled(), true);
      assert.equal(fixture.response.body.locked, false);
    }
  });

  test(`${name}: adapters with only a JSON method remain supported`, async () => {
    const result = await read({ json: async () => completion('Adapter answer') }, { stream: false });
    assert.equal(result.content, 'Adapter answer');
  });
}
