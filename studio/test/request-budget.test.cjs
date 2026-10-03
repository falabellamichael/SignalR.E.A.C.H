'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { measureRequest, inputLimitFromError, budgetExceeded, budgetRatio } = require('../agent/request-budget.cjs');

test('wire measurement counts UTF-8 and JSON escaping in the actual envelope', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'é漢字\n"\\' }],
    tools: [{ type: 'function', function: { name: 'inspect', description: 'Read source' } }],
    response_format: { type: 'json_object' }, max_tokens: 100 };
  const measured = measureRequest(body);
  const encoded = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
  assert.equal(measured.messagesBytes, encoded(body.messages));
  assert.equal(measured.requestFieldsBytes, encoded({ messages: body.messages, tools: body.tools, response_format: body.response_format }));
  assert.equal(measured.requestBytes, encoded(body));
  assert.equal(measured.inputTokens, encoded(body.messages) + encoded(body.tools) + encoded(body.response_format));
  assert.equal(measured.outputTokens, 100);
});

test('different byte scopes remain independent and exact limits fit', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hello' }], tools: [{ description: 'x'.repeat(1000) }] };
  const measured = measureRequest(body);
  const limits = { inputByteLimits: [
    { limit: measured.messagesBytes, scope: 'messages' },
    { limit: measured.requestFieldsBytes - 1, scope: 'request_fields' },
  ] };
  assert.equal(budgetExceeded(body, { maxInputBytes: measured.messagesBytes, inputLimitScope: 'messages' }), null);
  assert.deepEqual(budgetExceeded(body, limits), { unit: 'UTF-8 bytes', used: measured.requestFieldsBytes, limit: measured.requestFieldsBytes - 1 });
  assert.ok(budgetRatio(body, limits) > 1);
  assert.equal(budgetExceeded(body, { maxInputBytes: 1 }), null, 'unknown scope cannot justify a guessed messages limit');
});

test('context windows include the output reserve while input limits do not', () => {
  const body = { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 };
  const { inputTokens } = measureRequest(body);
  assert.equal(budgetExceeded(body, { maxInputTokens: inputTokens }), null);
  assert.equal(budgetExceeded(body, { contextTokens: inputTokens + 100 }), null);
  assert.equal(budgetExceeded(body, { contextTokens: inputTokens + 99 }).used, inputTokens + 100);
});

test('input errors learn only explicit valid limits and preserve unknown-overflow fallback', () => {
  const error = JSON.stringify({ error: { max_input_bytes: 32000, input_limit_scope: 'body', max_input_tokens: 4096, context_window: 8192 } });
  assert.deepEqual(inputLimitFromError(error, 413), { maxInputBytes: 32000, inputLimitScope: 'request', maxInputTokens: 4096, contextTokens: 8192 });
  assert.deepEqual(inputLimitFromError('{"max_input_bytes":32000}', 413), {});
  assert.deepEqual(inputLimitFromError('maximum context exceeded', 400), {});
  assert.equal(inputLimitFromError(error, 429), null);
  assert.equal(inputLimitFromError('bad credentials', 401), null);
  assert.equal(inputLimitFromError('{"max_input_tokens":-1}', 422), null);
});
