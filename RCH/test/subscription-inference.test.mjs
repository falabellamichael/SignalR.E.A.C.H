import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { AccountStore } from '../service/store.mjs';
import { createAccountService } from '../service/server.mjs';

const { models } = JSON.parse(readFileSync(new URL('../config/subscription-petpigfarm.example.json', import.meta.url)));
const subscription = { basic: { id: 'basic-wallet', includedRequests: 1500, priceUsdMicros: 15000000 },
  overageUsdMicrosPerRequest: 10000, proEnabled: false };
const wallet = '0x' + '35'.repeat(20);
const embedding = { model: 'bge-m3', input: ['hello', 'world'] };
const rerank = { model: 'bge-reranker-v2-m3', query: 'red planet', documents: ['Earth', 'Mars'], top_n: 1, return_documents: true };
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

async function fixture(t, fetchImpl) {
  const store = new AccountStore(':memory:', { models, subscription });
  const account = store.grantPlan({ wallet, grantId: 'test-period', planId: 'basic-wallet', name: 'Basic',
    models: models.map(m => m.id), tokens: 0, expiresAt: Date.now() + 3600000 });
  const key = store.createApiKey(account.id, 'test').key;
  const { server } = createAccountService({ store, config: { origin: 'http://127.0.0.1:20978', chainId: 1,
    models, subscription, redemption: { enabled: false } }, fetchImpl });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); });
  return { store, account, key, base: `http://127.0.0.1:${server.address().port}`,
    call: (path, body, id = 'request', auth = key) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': id,
        ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
    }) };
}

function responseFor(payload) {
  if (payload.model === 'bge-m3') return { model: payload.model, object: 'list',
    usage: { prompt_tokens: 4, total_tokens: 4 },
    data: (Array.isArray(payload.input) ? payload.input : [payload.input]).map((_, index) => ({ index,
      embedding: payload.encoding_format === 'base64' ? Buffer.alloc(4096).toString('base64') : Array(1024).fill(0.125) })) };
  return { model: payload.model, usage: { prompt_tokens: 8, total_tokens: 8 }, results: [{ index: 1, relevance_score: 2.5 }] };
}

test('authenticated embedding and reranking use fixed destinations, bill once and replay', async t => {
  const sent = [];
  const f = await fixture(t, async (url, options) => { sent.push({ url, payload: JSON.parse(options.body), headers: options.headers }); return json(responseFor(sent.at(-1).payload)); });
  const r = await f.call('/v1/embeddings', embedding, 'embed');
  assert.equal(r.status, 200); const vector = await r.json();
  assert.equal(vector.data.length, 2); assert.equal(vector.data[0].embedding.length, 1024);
  assert.equal(vector.model, 'bge-m3'); assert.equal(sent[0].url, 'http://127.0.0.1:8200/v1/embeddings');
  assert.equal(sent[0].headers.authorization, undefined);
  const replay = await f.call('/v1/embeddings', embedding, 'embed');
  assert.equal(replay.headers.get('x-reach-replayed'), 'true'); assert.deepEqual(await replay.json(), vector);
  const ranking = await f.call('/api/v1/rerank', rerank, 'rank');
  assert.equal(ranking.status, 200); assert.deepEqual((await ranking.json()).results, [{ index: 1, relevance_score: 2.5, document: { text: 'Mars' } }]);
  assert.equal(sent[1].url, 'http://127.0.0.1:8201/v1/rerank');
  assert.equal(sent.length, 2); assert.equal(f.store.requestAllowance(f.account.id).completed, 2);
  const encoded = await f.call('/api/v1/embeddings', { ...embedding, encoding_format: 'base64', dimensions: 1024 }, 'base64');
  assert.equal(encoded.status, 200); assert.equal(Buffer.from((await encoded.json()).data[0].embedding, 'base64').length, 4096);
});

test('model APIs preserve authentication, subscription and operation boundaries', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return json({}); });
  assert.equal((await f.call('/v1/embeddings', embedding, 'no-auth', null)).status, 401);
  for (const [i, path, body] of [
    [1, '/v1/embeddings', { ...embedding, model: 'qwen3.8-27b' }],
    [2, '/v1/rerank', { ...rerank, model: 'bge-m3' }],
    [3, '/v1/chat/completions', { model: 'bge-m3', messages: [{ role: 'user', content: 'hi' }] }],
    [4, '/v1/embeddings', { ...embedding, input: Array(33).fill('x') }],
    [5, '/v1/embeddings', { ...embedding, input: ['ok', ''] }],
    [6, '/v1/embeddings', { ...embedding, dimensions: 12 }],
    [7, '/v1/embeddings', { ...embedding, url: 'https://example.invalid' }],
    [8, '/v1/rerank', { ...rerank, top_n: 3 }],
    [9, '/v1/rerank', { ...rerank, return_documents: 'yes' }],
  ]) assert.equal((await f.call(path, body, 'invalid-' + i)).status, 400);
  f.store.db.prepare('UPDATE accounts SET plan_expires=0 WHERE id=?').run(f.account.id);
  assert.equal((await f.call('/v1/embeddings', embedding, 'expired')).status, 402);
  assert.equal((await f.call('/v1/rerank', rerank, 'expired-rank')).status, 402);
  assert.equal(calls, 0);
});

test('invalid output and backend outages release request holds without a fallback', async t => {
  let mode = 'identity', calls = 0;
  const f = await fixture(t, async (_url, options) => {
    calls++; if (mode === 'offline') throw new Error('offline');
    const out = responseFor(JSON.parse(options.body));
    if (mode === 'identity') out.model = 'wrong-model';
    if (mode === 'dimensions') out.data[0].embedding = [1];
    if (mode === 'indices') out.data[1].index = 0;
    if (mode === 'rank') out.results[0].index = 99;
    return json(out);
  });
  for (const name of ['identity', 'dimensions', 'indices', 'offline', 'rank']) {
    mode = name;
    const r = await f.call(name === 'rank' ? '/v1/rerank' : '/v1/embeddings', name === 'rank' ? rerank : embedding, name);
    assert.equal(r.status, 502); await r.text();
  }
  assert.equal(calls, 5); assert.equal(f.store.requestAllowance(f.account.id).completed, 0);
  assert.equal(f.store.requestAllowance(f.account.id).reserved, 0);
});

test('account transport accepts large model inputs while retaining bounded non-model bodies', async t => {
  const f = await fixture(t, async (_url, options) => json(responseFor(JSON.parse(options.body))));
  const large = await f.call('/v1/embeddings', { ...embedding, input: 'x'.repeat(600000) }, 'large-model');
  assert.equal(large.status, 200); await large.text();
  assert.equal((await f.call('/v1/auth/start', { unused: 'x'.repeat(600000) }, 'large-auth', null)).status, 413);
});
