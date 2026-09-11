'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  browserOpen,
  browserSnapshot,
  browserClick,
  browserType,
  browserPress,
  browserScroll,
  browserWait,
  browserBack,
  browserConsole,
  browserNetwork,
  browserScreenshot,
  browserClose,
  runBrowserAction,
  __resetForTest,
  numberedRefs,
} = require('../vscode/browser-tools');

test('numberedRefs correctly extracts and numbers interactive elements', () => {
  const html = '<div><h1>Title</h1><a href="/link1">Link 1</a><button id="btn">Click me</button><input type="text" /></div>';
  const refs = numberedRefs(html);
  assert.equal(refs.length, 3);
  assert.equal(refs[0].ref, 1);
  assert.equal(refs[0].label, 'a element');
  assert.equal(refs[1].ref, 2);
  assert.equal(refs[1].label, 'button element');
  assert.equal(refs[2].ref, 3);
  assert.equal(refs[2].label, 'input element');
});

test('browser tools dispatch actions and handle engine mock server', async (t) => {
  // Bind an ephemeral port: a fixed one (21301) collides with a running REACH
  // tray / shim, which made this test fail on any machine with REACH open.
  __resetForTest();
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = body ? JSON.parse(body) : {};
      received.push(data);
      res.setHeader('Content-Type', 'application/json');
      if (data.action === 'session') {
        res.end(JSON.stringify({ ok: true, token: 'test-session-token' }));
      } else if (data.action === 'create') {
        res.end(JSON.stringify({ ok: true, width: data.width, height: data.height, tab: data.tab }));
      } else if (data.action === 'snapshot') {
        res.end(JSON.stringify({
          ok: true,
          url: 'http://127.0.0.1:21887',
          title: 'Test Page',
          text: 'Hello world',
          html: '<html><body><button>Click</button></body></html>',
          image: 'data:image/png;base64,fakeimage',
        }));
      } else if (data.action === 'console') {
        res.end(JSON.stringify({
          ok: true,
          logs: [
            { level: 'error', text: 'Uncaught ReferenceError: foo is not defined', line: 42, source: 'app.js' },
            { level: 'info', text: 'App initialized', line: 10, source: 'app.js' },
          ],
        }));
      } else if (data.action === 'network') {
        res.end(JSON.stringify({
          ok: true,
          requests: [
            { url: 'http://127.0.0.1:21887/api/data', method: 'GET', status: 200, type: 'fetch' },
            { url: 'http://127.0.0.1:21887/missing', method: 'GET', status: 404, type: 'fetch' },
          ],
        }));
      } else if (data.action === 'input' || data.action === 'text' || data.action === 'back') {
        res.end(JSON.stringify({ ok: true }));
      } else if (data.action === 'close_session') {
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.REACH_BROWSER_PORT = String(server.address().port);
  t.after(() => {
    delete process.env.REACH_BROWSER_PORT;
    __resetForTest();
    server.close();
  });

  const openRes = await runBrowserAction({ action: 'browser_open', url: 'http://127.0.0.1:21887' });
  assert.ok(openRes.text.includes('Opened: http://127.0.0.1:21887'));
  assert.ok(openRes.text.includes('Title: Test Page'));

  const snapRes = await runBrowserAction({ action: 'browser_snapshot' });
  assert.ok(snapRes.text.includes('Snapshot: http://127.0.0.1:21887'));

  const clickRes = await runBrowserAction({ action: 'browser_click', selector: 'button' });
  assert.ok(clickRes.text.includes('Done.'));

  const typeRes = await runBrowserAction({ action: 'browser_type', selector: 'input', text: 'test input', submit: true });
  assert.ok(typeRes.text.includes('Done.'));

  const pressRes = await runBrowserAction({ action: 'browser_press', key: 'Enter' });
  assert.ok(pressRes.text.includes('Done.'));

  const scrollRes = await runBrowserAction({ action: 'browser_scroll', x: 0, y: 100 });
  assert.ok(scrollRes.text.includes('Scrolled'));

  const navRes = await runBrowserAction({ action: 'browser_navigate', url: 'http://127.0.0.1:21887/other' });
  assert.ok(navRes.text.includes('Navigated to:'));
  assert.ok(navRes.text.includes('Title: Test Page'));

  const fwdRes = await runBrowserAction({ action: 'browser_forward' });
  assert.ok(fwdRes.text.includes('Forward: http://127.0.0.1:21887'));

  const reloadRes = await runBrowserAction({ action: 'browser_reload' });
  assert.ok(reloadRes.text.includes('Reloaded: http://127.0.0.1:21887'));

  const findRes = await runBrowserAction({ action: 'browser_find', text: 'missing-term' });
  assert.ok(findRes.text.includes('No matches on the page'));

  const consoleRes = await runBrowserAction({ action: 'browser_console' });
  assert.ok(consoleRes.text.includes('[error]:42 app.js Uncaught ReferenceError'));
  assert.ok(consoleRes.text.includes('[info]:10 app.js App initialized'));

  const networkRes = await runBrowserAction({ action: 'browser_network' });
  assert.ok(networkRes.text.includes('[200] GET http://127.0.0.1:21887/api/data (fetch)'));
  assert.ok(networkRes.text.includes('[404] GET http://127.0.0.1:21887/missing (fetch)'));

  const shotRes = await runBrowserAction({ action: 'browser_screenshot' });
  assert.ok(shotRes.text.includes('Screenshot taken.'));
  assert.equal(shotRes.image, 'data:image/png;base64,fakeimage');

  const closeRes = await runBrowserAction({ action: 'browser_close' });
  assert.ok(closeRes.text.includes('Browser session closed.'));
});
