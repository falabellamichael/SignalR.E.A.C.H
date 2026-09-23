'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { resolveEndpoint } = require('../agent/endpoint.cjs');

test('endpoint normalization preserves base paths and allows local providers', async () => {
  for (const raw of ['http://localhost:11434', 'http://localhost:11434/', 'http://localhost:11434/v1/', 'http://localhost:11434/v1?x=1#x']) {
    assert.equal(await resolveEndpoint(raw), 'http://localhost:11434/v1');
  }
  assert.equal(await resolveEndpoint('https://example.test/api/'), 'https://example.test/api/v1');
});

test('endpoint rejects non-HTTP schemes and embedded credentials', async () => {
  for (const raw of ['file:///etc/passwd', 'ftp://example.test', 'https://user:pass@example.test/v1', 'https://user@example.test']) {
    await assert.rejects(resolveEndpoint(raw), /HTTP or HTTPS endpoint without embedded credentials/);
  }
});

/* Regression: a pasted endpoint that already carries a version segment AND a
 * trailing API path used to gain a second version segment, because the /v1$
 * strip could not match a path ending in "/models". The result was
 * ".../v1/models/v1" and an HTTP 404 from the relay. */
test('endpoint collapses a pasted API path to a single version root', async () => {
  for (const raw of [
    'https://relay.test/v1/models',
    'https://relay.test/v1/models/',
    'https://relay.test/v1/chat/completions',
    'https://relay.test/v1/completions',
    'https://relay.test/models',
  ]) {
    assert.equal(await resolveEndpoint(raw), 'https://relay.test/v1', raw);
  }
});

test('pointer resolution normalizes .txt/v1, follows chains and rejects loops and HTTP failures', async t => {
  let base;
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/bad.txt') { res.writeHead(503); res.end('Unavailable'); }
    else if (req.url === '/loop.txt') res.end(base + '/loop.txt');
    else if (req.url === '/creds.txt') res.end('https://user:pass@example.test');
    else if (req.url === '/first.txt') res.end(base + '/next.txt');
    else res.end(' https://example.test/api/v1/\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await resolveEndpoint(base + '/first.txt/v1'), 'https://example.test/api/v1');
  assert.deepEqual(hits, ['/first.txt', '/next.txt']);
  await assert.rejects(resolveEndpoint(base + '/loop.txt'), /loop/);
  assert.equal(hits.filter(hit => hit === '/loop.txt').length, 4);
  await assert.rejects(resolveEndpoint(base + '/bad.txt'), /HTTP 503/);
  await assert.rejects(resolveEndpoint(base + '/creds.txt'), /without embedded credentials/);
});
