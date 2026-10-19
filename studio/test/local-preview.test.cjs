'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { runToolCall } = require('../agent/agent-tool-runner.cjs');
const { closePreviews } = require('../agent/local-preview.cjs');
const { actionInstruction, toolDefs, canonicalToolName } = require('../agent/agent-action.cjs');
const { toolHelp } = require('../agent/tool-registry.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const runControl = require('../agent/agent-run.cjs');

after(closePreviews);

test('missing-object-brace recovery explains edit_patch closure without accepting invalid actions', () => {
  const result = runControl.decide(runControl.start(), { enabled: true, invalid: true,
    validationError: 'The response was not valid JSON. Expected } before ] at character 773.', rounds: 1, roundLimit: 8 });
  assert.equal(result.action, 'continue');
  assert.match(result.instruction, /exact closing sequence is \}\]\}\}\]/);
  assert.match(result.instruction, /No actions from the rejected response were executed/);
  assert.match(result.instruction, /do not replace the whole file/);
});

function fixture(t, settings = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-coffee-preview-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectDir, 'assets'));
  fs.writeFileSync(path.join(projectDir, 'coffee.html'), '<title>Coffee</title><link rel="stylesheet" href="/assets/style.css"><h1>Coffee preview</h1>');
  fs.writeFileSync(path.join(projectDir, 'assets/style.css'), 'body { color: brown; }');
  fs.writeFileSync(path.join(projectDir, '.env'), 'PRIVATE_FIXTURE');
  const calls = [], store = new MemoryStore();
  Object.assign(store.get('coffee').settings, settings);
  const context = { projectDir, agentId: 'coffee', agentStore: store,
    signal: new AbortController().signal,
    browserExecutor: async (op, args) => {
      assert.equal(op, 'open');
      calls.push(args);
      const response = await fetch(args.url);
      assert.equal(response.status, 200, 'server must be ready before browser navigation');
      return { ok: true, tabId: 'coffee-tab', url: args.url, text: await response.text() };
    } };
  return { projectDir, calls, store, context };
}

test('preview is discoverable in structured, legacy and native tools', () => {
  for (const prompt of [actionInstruction(), actionInstruction({ compact: true }), toolHelp('core')]) {
    assert.match(prompt, /preview/);
    assert.match(prompt, /foreground web server/);
  }
  const browser = toolDefs().find(d => canonicalToolName(d.function.name) === 'browser').function;
  assert.equal(browser.parameters.properties.path.type, 'string');
  assert.match(browser.description, /preview/);
});

test('static page opens without shell approval, returns ready URL and serves updated assets', async t => {
  const f = fixture(t); let approvals = 0;
  f.context.requestApproval = () => { approvals++; return false; };
  const first = await runToolCall('coffee', 'browser', { op: 'preview', path: 'coffee.html' }, f.context);
  assert.equal(first.ok, true);
  assert.match(first.text, /Coffee preview/);
  assert.match(first.previewUrl, /^http:\/\/127\.0\.0\.1:\d+\/coffee.html$/);
  assert.equal(approvals, 0);
  const asset = await fetch(new URL('/assets/style.css', first.previewUrl));
  assert.match(asset.headers.get('content-type'), /text\/css/);
  assert.equal(await asset.text(), 'body { color: brown; }');
  fs.writeFileSync(path.join(f.projectDir, 'coffee.html'), '<h1>Fresh coffee</h1>');
  const second = await runToolCall('coffee', 'browser', { op: 'preview', path: 'coffee.html', tabId: first.tabId }, f.context);
  assert.equal(second.previewUrl, first.previewUrl, 'reuse the managed server');
  assert.match(second.text, /Fresh coffee/);
  assert.equal(f.calls[1].tabId, 'coffee-tab');
  assert.ok(f.store.get('coffee').messages.some(m => m.role === 'tool' && m.name === 'browser'));
  const head = await fetch(first.previewUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('existing file URLs recover through browser and browse, including spaces and apostrophes', async t => {
  const f = fixture(t);
  const name = "coffee's menu #1.html";
  fs.writeFileSync(path.join(f.projectDir, name), '<h1>Menu</h1>');
  const url = pathToFileURL(path.join(f.projectDir, name)).href;
  for (const tool of ['browser', 'browse']) {
    const result = await runToolCall('coffee', tool, { op: 'open', url }, f.context);
    assert.equal(result.ok, true, result.error);
    assert.match(result.text, /Menu/);
    assert.match(result.url, /^http:/);
  }
});

test('directory previews use index.html and nested directory links redirect correctly', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.projectDir, 'site'));
  fs.writeFileSync(path.join(f.projectDir, 'site/index.html'), '<h1>Site index</h1>');
  const result = await runToolCall('coffee', 'browser', { op: 'preview', path: 'site' }, f.context);
  assert.equal(result.ok, true);
  assert.match(result.url, /\/site\/index.html$/);
  const response = await fetch(new URL('/site', result.url), { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/site/');
});

test('preview rejects missing and escaped paths, disabled workspace/web and cancellation', async t => {
  const f = fixture(t);
  for (const requested of ['', 'missing.html', '../outside.html', '.env']) {
    const result = await runToolCall('coffee', 'browser', { op: 'preview', path: requested }, f.context);
    assert.equal(result.ok, false, requested);
  }
  const outside = pathToFileURL(path.join(f.projectDir, '..', 'outside.html')).href;
  assert.equal((await runToolCall('coffee', 'browse', { url: outside }, f.context)).ok, false);
  for (const feature of ['workspace', 'web']) {
    f.store.get('coffee').settings.features = { [feature]: false };
    assert.equal((await runToolCall('coffee', 'browser', { op: 'preview', path: 'coffee.html' }, f.context)).ok, false);
  }
  f.store.get('coffee').settings.features = {};
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runToolCall('coffee', 'browser', { op: 'preview', path: 'coffee.html' }, { ...f.context, signal: cancelled.signal }));
  assert.equal(f.calls.length, 0);
});

test('HTTP preview rejects hidden files, traversal, rebinding hosts, foreign origins and writes', async t => {
  const f = fixture(t);
  const result = await runToolCall('coffee', 'browser', { op: 'preview', path: 'coffee.html' }, f.context);
  const request = (requestPath, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request(result.url, { path: requestPath, headers, method }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  for (const route of ['/.env', '/%2e%2e/outside.html', '/assets%5c..%5c.env', '/coffee.html:secret', '/%00', '/%zz']) {
    assert.equal(await request(route), 403, route);
  }
  assert.equal(await request('/coffee.html', { Host: 'attacker.invalid' }), 403);
  assert.equal(await request('/coffee.html', { Origin: 'https://attacker.invalid' }), 403);
  assert.equal(await request('/coffee.html', { 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal(await request('/coffee.html', {}, 'POST'), 405);
  assert.equal(await request('/missing.html'), 404);
  assert.equal(await request('/assets/'), 404, 'no directory listing');
});

test('regular agent loop completes preview after the browser tool returns, without starting a shell', async t => {
  const f = fixture(t);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const done = body.messages.some(m => m.content?.includes('TOOL RESULTS'));
      const reply = done ? { status: 'complete', message: 'Coffee preview is open.', actions: [], options: [] }
        : { status: 'actions', message: 'Opening the coffee preview.', actions: [{ name: 'browser', arguments: { op: 'preview', path: 'coffee.html' } }], options: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const loop = new AgentLoop({ agentId: 'coffee', store: f.store, projectDir: f.projectDir,
    endpoint: `http://127.0.0.1:${server.address().port}/v1`, browserExecutor: f.context.browserExecutor });
  await loop.sendUserMessage('Run coffee.html in the in-app browser.');
  assert.equal(f.store.get('coffee').runState.status, 'completed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get('coffee').messages.some(m => m.name === 'shell'), false);
});

test('preview refuses directory junctions or symlinks escaping the project', async t => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-preview-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'private.html'), 'OUTSIDE');
  fs.symlinkSync(outside, path.join(f.projectDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const denied = await runToolCall('coffee', 'browser', { op: 'preview', path: 'linked/private.html' }, f.context);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /escapes/);
  const allowed = await runToolCall('coffee', 'browser', { op: 'preview', path: 'coffee.html' }, f.context);
  assert.equal((await fetch(new URL('/linked/private.html', allowed.url))).status, 403);
});
