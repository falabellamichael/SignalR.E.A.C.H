'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = process.env.REACH_SEARCH_TEST_FILE || path.resolve(__dirname, '../vscode/extension.js');
const source = fs.readFileSync(filename, 'utf8');
const req = createRequire(path.resolve(__dirname, '../vscode/extension.js'));
function fixture(response) {
  const calls = [];
  const settings = { provider: 'endpoint', endpoint: 'https://fixture.invalid/v1', model: 'fixture-model' };
  const context = { module: { exports: {} }, console, process, Buffer, URL, AbortController,
    AbortSignal, TextDecoder, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? {
      workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
    } : name.startsWith('./') ? {} : req(name),
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response(); },
  };
  vm.runInNewContext(source + '\nmodule.exports.TestProvider = ReachChatViewProvider;', context, { filename });
  const provider = new context.module.exports.TestProvider({ fsPath: '/fixture' });
  provider._modelEndpoint = async () => settings.endpoint;
  return { provider, calls };
}
const completion = (content, finish_reason = 'stop', extra = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }], ...extra }));

test('complete query is used with enough generation room', async () => {
  const h = fixture(() => completion('"Node.js release notes"'));
  assert.equal(await h.provider._deriveQuery('Find Node.js release notes', 'fixture-model'), 'Node.js release notes');
  assert.equal(h.calls[0].body.max_tokens, 512);
  assert.equal(h.calls[0].body.model, 'fixture-model');
});

for (const [label, response] of [
  ['warning from screenshot', () => completion('[⚠ Output limit reached. The response used the maximum output tokens allowed for this request and may be incomplete.]')],
  ['short warning with no finish reason', () => completion('[⚠ Output limit reached.]', null)],
  ['truncated query', () => completion('unrelated partial query', 'length')],
  ['incomplete response', () => completion('unrelated partial query', 'stop', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })],
  ['provider error', () => completion('unrelated query', 'stop', { error: { message: 'Provider failed' } })],
  ['empty output', () => completion('')],
  ['non-text output', () => completion([{ text: 'unexpected content' }])],
  ['HTTP failure', () => new Response('', { status: 503 })],
  ['network failure', () => { throw new Error('offline'); }],
  ['verbose output', () => completion('Here is a query:\nNode.js releases')],
]) {
  test(`${label} falls back to original question`, async () => {
    const h = fixture(response);
    const prompt = 'Find C++ 更新 and Node.js release notes';
    assert.equal(await h.provider._deriveQuery(prompt, 'fixture-model'), prompt);
  });
}

test('fallback remains bounded and preserves a genuine token-limit question', async () => {
  const h = fixture(() => completion('', 'length'));
  const prompt = 'Why does max_output_tokens cause an output limit reached error?';
  assert.equal(await h.provider._deriveQuery(prompt), prompt);
  assert.ok((await h.provider._deriveQuery('release '.repeat(100))).length <= 120);
});
