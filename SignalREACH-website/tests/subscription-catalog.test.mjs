import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/subscription-catalog.js', import.meta.url), 'utf8');
const liveStatus = 'From the REACH subscription service. Your account determines which models you can use.';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

async function load({body, ok = true, error, invalidJson, section = true} = {}) {
  const list = new Element('ul'), status = new Element('p'), original = new Element('li');
  list.append(original);
  status.textContent = 'Catalog checked on November 23, 2026.';
  const calls = [];
  let timeout;
  const signal = new AbortController().signal;
  const document = {
    getElementById: id => section && ({'subscription-model-list': list, 'subscription-model-status': status})[id],
    createElement: tag => new Element(tag)
  };
  await vm.runInNewContext(source, {
    document,
    AbortSignal: {timeout(ms) { timeout = ms; return signal; }},
    fetch: async (url, options) => {
      calls.push({url, options});
      if (error) throw error;
      return {ok, json: async () => { if (invalidJson) throw new SyntaxError(); return body; }};
    }
  });
  return {list, status, original, calls, timeout, signal};
}

test('requests public account configuration as a guest only when the catalog section exists', async () => {
  const {calls, timeout, signal} = await load({body: {redemptionModels: []}});
  assert.equal(calls.length, 1);
  const [{url, options}] = calls;
  assert.equal(url, 'https://unbent-semicolon-hermit.ngrok-free.dev/v1/account/config');
  assert.deepEqual({...options.headers}, {Accept: 'application/json', 'ngrok-skip-browser-warning': '1'});
  assert.deepEqual([options.method, options.credentials, options.referrerPolicy, options.redirect, options.cache],
    ['GET', 'omit', 'no-referrer', 'error', 'no-store']);
  assert.equal(options.signal, signal);
  assert.ok(timeout > 0 && timeout <= 10000);
  assert.equal((await load({section: false})).calls.length, 0);
});

test('renders only request models, using explicit operations, literal names and positive integer context lengths', async () => {
  const request = (id, capabilities, name = id) => ({id, name, access: 'requests', capabilities});
  const {list, status} = await load({body: {redemptionModels: [
    request('chat', {outputTokenLimit: true, automaticOutput: true, jsonSchema: false, context_window: 163840}, '<b>Qwen & more</b>'),
    {id: 'prepaid', name: 'Priced separately', pricing: {}},
    request('vectors', {chat: false, embedding: true, endpoint: '/v1/embeddings', context_window: 8192}),
    request('rerank', {rerank: true, endpoint: '/v1/rerank'}),
    request('decision', {decisions: true, endpoint: '/v1/decisions'}),
    request('plain-chat', {chat: true, endpoint: '/v1/chat/completions'}),
    request('future', {endpoint: '/v1/other', context_window: -2}),
    request('unclassified', {context_window: '4096'}),
    request('no-capabilities', undefined)
  ]}});
  assert.equal(status.textContent, liveStatus);
  const fields = list.children.map(row => {
    assert.equal(row.tag, 'li');
    assert.equal(row.className, 'model-row');
    assert.equal(row.children.length, 1);
    const [info] = row.children;
    assert.equal(info.className, 'model-name');
    assert.deepEqual(info.children.map(child => child.tag), ['b', 'small', 'span']);
    assert.equal(info.children[2].className, 'model-description');
    return info.children.map(child => child.textContent);
  });
  assert.deepEqual(fields.map(row => row[1]), ['Chat', 'Embeddings', 'Reranking', 'Decision scoring', 'Chat',
    'Subscription model', 'Subscription model', 'Subscription model']);
  assert.deepEqual(fields[0], ['<b>Qwen & more</b>', 'Chat', 'Model ID: chat · ' + (163840).toLocaleString() + ' token context']);
  assert.equal(fields[1][2], 'Model ID: vectors · ' + (8192).toLocaleString() + ' token context');
  assert.equal(fields[5][2], 'Model ID: future');
  assert.equal(fields[6][2], 'Model ID: unclassified');
});

test('keeps the complete dated snapshot on a bad response, timeout, or partially malformed catalog', async () => {
  for (const options of [
    {error: new Error('offline')}, {error: new DOMException('Timed out', 'TimeoutError')},
    {ok: false}, {invalidJson: true}, {body: null}, {body: {data: []}},
    {body: {redemptionModels: [{id: 'valid', name: 'Valid', access: 'requests'}, null]}},
    {body: {redemptionModels: [{id: 'invalid', access: 'requests'}]}},
    {body: {redemptionModels: [{id: 'invalid', name: 'Invalid', access: 'requests', capabilities: []}]}}
  ]) {
    const {list, status, original} = await load(options);
    assert.deepEqual(list.children, [original]);
    assert.equal(status.textContent, 'Catalog checked on November 23, 2026.');
  }
});

test('clears stale entries when a valid catalog contains no subscription models', async () => {
  for (const redemptionModels of [[], [{id: 'other', name: 'Prepaid', pricing: {}}]]) {
    const {list, status} = await load({body: {redemptionModels}});
    assert.equal(list.children.length, 0);
    assert.equal(status.textContent, liveStatus + ' No subscription models are listed.');
  }
});
