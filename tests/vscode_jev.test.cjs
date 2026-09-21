'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { jevRequestIsSelfContained, jevShortlistCoversRequest, shortlistPaths, selectWorkspaceFilesWithJev } = require('../vscode/typesafe-jev');

const extensionPath = path.resolve(__dirname, '../vscode/extension.js');
const extensionSource = fs.readFileSync(extensionPath, 'utf8');

function host({ enabled = true, key = 'private-jev-key', files = ['src/app.js', 'src/other.js'],
  jevAnswers, providerPaths = ['src/other.js'] } = {}) {
  const calls = [], reads = [], posts = [];
  const config = { provider: 'endpoint', endpoint: 'https://chat.example/v1', model: 'selected-model',
    typesafeFileSelection: enabled };
  const folder = { name: 'project', uri: { fsPath: '/workspace' } };
  const uris = files.map(file => ({ fsPath: '/workspace/' + file }));
  const vscode = {
    RelativePattern: class { constructor(root, pattern) { this.root = root; this.pattern = pattern; } },
    window: { tabGroups: { all: [] }, activeTextEditor: null },
    workspace: {
      workspaceFolders: [folder], textDocuments: [], isTrusted: true,
      getConfiguration: () => ({ get: name => config[name] }),
      findFiles: async () => uris,
      getWorkspaceFolder: () => folder,
      openTextDocument: async uri => {
        const rel = uri.fsPath.slice('/workspace/'.length);
        reads.push(rel);
        return { uri, languageId: 'javascript', isDirty: false, getText: () => `source for ${rel}` };
      },
    },
  };
  const request = createRequire(extensionPath);
  const sandbox = { module: { exports: {} }, Buffer, process, console, URL, AbortController, AbortSignal,
    TextDecoder, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? vscode : name === './search' ? {} : request(name),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        return new Response(JSON.stringify({ answers: jevAnswers || {
          file_0: { type: 'noul', noul: 0.94 }, file_1: { type: 'noul', noul: 0.08 },
        }, usage: { input_tokens: 111, output_tokens: 0 } }));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(providerPaths) } }] }));
    },
  };
  vm.runInNewContext(extensionSource + '\nmodule.exports.Provider = ReachChatViewProvider;', sandbox,
    { filename: extensionPath });
  const provider = new sandbox.module.exports.Provider({ fsPath: '/extension' });
  provider._secrets = { get: async () => key };
  provider._post = (type, payload) => posts.push({ type, ...payload });
  provider._controller = new AbortController();
  const select = prompt => provider._prepareWorkspaceContext([{ role: 'user', content: prompt }],
    'selected-model', true, 100000);
  return { calls, reads, posts, provider, select };
}

test('Jev receives only a bounded path catalog and latest request, then reads its selected file', async () => {
  const h = host();
  await h.select('Inspect src/app.js for the bug');
  assert.equal(h.calls.length, 1);
  const sent = h.calls[0];
  assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent.options.headers.Authorization, 'Bearer private-jev-key');
  assert.equal(sent.options.redirect, 'error');
  const body = JSON.parse(sent.options.body);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, { user_request: 'Inspect src/app.js for the bug' });
  assert.equal(Object.keys(body.questions).length, 2);
  assert.equal(sent.options.body.includes('source for'), false);
  assert.deepEqual(h.reads, ['src/app.js']);
  assert.ok(h.posts.some(post => post.note?.includes('111 input')));
  await h.select('Inspect src/app.js for the bug');
  assert.equal(h.calls.length, 1, 'same request and catalog reuses the judgment');
});

test('disabled or missing key keeps the selected provider file-selection call', async () => {
  for (const options of [{ enabled: false }, { key: '' }]) {
    const h = host(options);
    await h.select('Inspect src/other.js');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, 'https://chat.example/v1/chat/completions');
    assert.deepEqual(h.reads, ['src/other.js']);
  }
});

test('uncertain Jev answers report their usage before provider fallback, and follow-ups stay local', async () => {
  const uncertain = host({ jevAnswers: { file_0: { type: 'noul', noul: 0.48 }, file_1: { type: 'noul', noul: 0.12 } } });
  await uncertain.select('Review the module implementation');
  assert.deepEqual(uncertain.calls.map(call => call.url),
    ['https://api.typesafe.ai/v1/systemone', 'https://chat.example/v1/chat/completions']);
  assert.deepEqual(uncertain.reads, ['src/other.js']);
  assert.ok(uncertain.posts.some(post => post.note?.includes('Jev used 111 input / 0 output tokens')));
  const followup = host();
  await followup.select('continue with that');
  assert.equal(followup.calls.length, 1);
  assert.equal(followup.calls[0].url, 'https://chat.example/v1/chat/completions');
  assert.equal(jevRequestIsSelfContained('continue with that'), false);
  const toolResults = host();
  await toolResults.select('TOOL RESULTS (you asked for these):\n\n[read src/app.js]\nprivate tool output');
  assert.equal(toolResults.calls.length, 1);
  assert.equal(toolResults.calls[0].url, 'https://chat.example/v1/chat/completions');
  assert.equal(jevRequestIsSelfContained('TOOL RESULTS (results gathered before answering):\nsecret'), false);
});

test('explicitly named paths remain first and Stop aborts Jev without provider fallback', async () => {
  const h = host({ jevAnswers: { file_0: { type: 'noul', noul: 0.08 }, file_1: { type: 'noul', noul: 0.94 } } });
  await h.select('Inspect src/other.js and explain its behavior');
  assert.deepEqual(h.reads, ['src/other.js', 'src/app.js']);
  const stop = host();
  stop.provider._controller.abort();
  await assert.rejects(stop.select('Review the module implementation'));
  assert.equal(stop.calls.length, 0);
});

test('Stop during secret lookup rejects cached selection without a new network request', async () => {
  const h = host();
  const prompt = 'Inspect src/app.js for the bug';
  await h.select(prompt);
  let releaseKey, lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  h.provider._secrets.get = () => { lookupStarted(); return new Promise(resolve => { releaseKey = resolve; }); };
  const pending = h.select(prompt);
  await started;
  h.provider._controller.abort();
  releaseKey('private-jev-key');
  await assert.rejects(pending);
  assert.equal(h.calls.length, 1, 'cached result must not be applied after Stop');
  assert.equal(h.reads.length, 1, 'no second source read after Stop');
});

test('a superseding request cannot inherit the old selection after secret lookup', async () => {
  const h = host();
  let releaseKey, lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  h.provider._secrets.get = () => { lookupStarted(); return new Promise(resolve => { releaseKey = resolve; }); };
  const pending = h.select('Inspect src/app.js for the bug');
  await started;
  h.provider._controller = new AbortController();
  releaseKey('private-jev-key');
  await assert.rejects(pending, /superseded/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.reads.length, 0);
});

test('path shortlist is bounded and rejects long or context-dependent requests', async () => {
  const paths = Array.from({ length: 100 }, (_, index) => `src/file-${index}.js`);
  assert.equal(shortlistPaths(paths, 'Review source files').length, 32);
  assert.equal(jevShortlistCoversRequest(shortlistPaths(paths, 'Review the repository'), 'Review the repository', paths.length), false);
  const wide = host({ files: paths });
  await wide.select('Review the repository');
  assert.equal(wide.calls[0].url, 'https://chat.example/v1/chat/completions');
  assert.equal(jevRequestIsSelfContained('x'.repeat(1501)), false);
  const pending = new AbortController();
  pending.abort();
  await assert.rejects(selectWorkspaceFilesWithJev({ key: 'unused', request: 'Review files', paths, signal: pending.signal,
    fetchImpl: () => { throw new Error('fetch should not run'); } }));
});

test('Jev rejects a wrong answer type and discards malformed token usage', async () => {
  const request = { key: 'private', request: 'Inspect the implementation', paths: ['src/app.js'] };
  await assert.rejects(selectWorkspaceFilesWithJev({ ...request, fetchImpl: async () => new Response(JSON.stringify({
    answers: { file_0: { noul: 0.99 } },
  })) }), /Invalid Jev relevance answer/);
  await assert.rejects(selectWorkspaceFilesWithJev({ ...request, fetchImpl: async () => new Response(JSON.stringify({
    answers: { file_0: { type: 'choice', noul: 0.99 } },
  })) }), /Invalid Jev relevance answer/);
  const result = await selectWorkspaceFilesWithJev({ ...request, fetchImpl: async () => new Response(JSON.stringify({
    answers: { file_0: { type: 'noul', noul: 0.99 } },
    usage: { input_tokens: -1, output_tokens: 'wrong' },
  })) });
  assert.deepEqual(result.paths, ['src/app.js']);
  assert.equal(result.usage, null);
});
