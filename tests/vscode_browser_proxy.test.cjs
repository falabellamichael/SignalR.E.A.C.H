'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startPageProxy, pageProxyUrl, stopPageProxy } = require('../vscode/browser-proxy');

test('page proxy preserves file URLs and assets while denying unauthenticated root access', async t => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/docs/page.html?q=one') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head></head><body>Fixture page</body></html>');
    } else if (req.url === '/docs/app.js' || req.url === '/app.js') {
      res.setHeader('Content-Type', 'application/javascript'); res.end('fixtureAsset = true;');
    } else if (req.url === '/large') {
      res.end(Buffer.alloc(17 * 1024 * 1024));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { stopPageProxy(); upstream.closeAllConnections(); upstream.close(); });
  await startPageProxy();
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const url = pageProxyUrl(base + '/docs/page.html?q=one');
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Fixture page/);
  assert.equal(requests[0], '/docs/page.html?q=one');
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(url + 'app.js')).status, 200);
  assert.equal(requests.at(-1), '/docs/app.js');
  const asset = new URL('/app.js', url);
  assert.equal((await fetch(asset)).status, 404);
  assert.equal((await fetch(asset, { headers: { Referer: 'https://external.invalid/' } })).status, 404);
  assert.equal((await fetch(asset, { headers: { Referer: url } })).status, 200);
  const before = requests.length;
  assert.equal((await fetch(url, { headers: { Origin: 'https://external.invalid' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'external.invalid' } }, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(url, { method: 'POST' })).status, 403);
  assert.equal(requests.length, before);
  assert.throws(() => pageProxyUrl('file:///private'), /HTTP/);
  assert.throws(() => pageProxyUrl('https://user:password@example.invalid'), /credentials/);
  assert.equal((await fetch(pageProxyUrl(base + '/large'))).status, 502);
});
