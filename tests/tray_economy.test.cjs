const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const economy = require('../copilot/tray/economy-models.js');
const source = fs.readFileSync(path.join(__dirname, '../copilot/tray/main.js'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
const { codegptProviderError, extractCodegptRunReply: parse, extractCodegptApiReply } = vm.runInNewContext(
 section('function codegptProviderError(', 'async function debugCodegptDom()')
  + '\n({ codegptProviderError, extractCodegptRunReply, extractCodegptApiReply })');
const run = messages => JSON.stringify({ t: 'final', done: true, messages });
function listen(handler) {
 return new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
 });
}

// The CodeGPT extension allocates its driver port per activation, so the chat
// page path must be resolved live. A pinned port is how the tray once drove a
// page whose backend was gone (HTML instead of JSON, then an endless wait).
test('the chat url carries the discovered driver port in the path', async () => {
 const build = (port) => vm.runInNewContext(
  section('const CODEGPT_SIDECAR_PORT', 'const CODEGPT_PARTITION') + '\ncodegptChatUrl',
  { discoverCodegptApiPort: async () => port, log() {} });
 assert.equal(await build(54114)(), 'http://localhost:54112/54114/');
 assert.equal(await build(0)(), 'http://localhost:54112/54113/');
});
test('discovery probes live ports and never mistakes the sidecar for the driver', async () => {
 const sidecar = await listen((req, res) => {  // Next sidecar: HTML on /version
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!DOCTYPE html><html></html>');
 });
 const driver = await listen((req, res) => {  // extension driver: plain version
  res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('3.24.65');
 });
 try {
  const sidecarPort = sidecar.address().port, driverPort = driver.address().port;
  const first = Math.min(sidecarPort, driverPort), last = Math.max(sidecarPort, driverPort);
  assert.equal(await economy.discoverCodegptApiPort({ force: true, first, last }), driverPort);
  // Cached: the answer survives without probing again while the TTL holds.
  await new Promise((resolve) => driver.close(resolve));
  assert.equal(await economy.discoverCodegptApiPort({ first, last }), driverPort);
  // Forced rescan after the driver went away reports "not found" (0).
  assert.equal(await economy.discoverCodegptApiPort({ force: true, first, last }), 0);
 } finally {
  await new Promise((resolve) => sidecar.close(resolve));
 }
});
test('no driver at all resolves to 0 so the fallback url is used', async () => {
 assert.equal(await economy.discoverCodegptApiPort({ force: true, first: 64990, last: 64992 }), 0);
});
test('NDJSON returns the final answer without reasoning, history or progress', () => {
 const answer = '```js\n' + 'x'.repeat(14000) + '\n```';
 const body = JSON.stringify({ t: 'd', text: 'unfinished' }) + '\n' + run([
  { role: 'assistant', content: 'old reply' }, { role: 'user', content: 'new question' },
  { role: 'assistant', content: '<think>private reasoning</think>\n' + answer }
 ]);
 assert.equal(parse(body), answer);
});
test('invalid, incomplete, approval and error responses cannot masquerade as answers', () => {
 for (const body of ['<html>wrong port</html>', '{"t":"d","text":"partial"}',
  '{"t":"error","message":"denied"}', '{"error":"offline"}',
  JSON.stringify({t:'final',done:true,pending:{tool:'edit'},messages:[]}),
  run([{role:'assistant',content:'old'}, {role:'user',content:'new'}]),
  run([{role:'assistant',content:'<think>unfinished'}])
 ]) assert.throws(() => parse(body));
});
test('nested CodeGPT Economy concurrency failure becomes a short typed 429', () => {
 const upstream = { errorMessage: 'Economy models are unlimited for one interactive session at a time. Another stream on this account is still running.',
  status: 429, code: 'ECONOMY_CONCURRENCY_LIMIT' };
 const body = JSON.stringify({ t: 'error', message: 'CodeGPT: ' + JSON.stringify(upstream) });
 for (const call of [() => parse(body), () => extractCodegptApiReply(JSON.stringify({ error: upstream })),
  () => extractCodegptApiReply('data: ' + JSON.stringify({ error: upstream }) + '\n\ndata: [DONE]\n\n')]) {
  assert.throws(call, error => {
   assert.equal(error.code, 'ECONOMY_CONCURRENCY_LIMIT');
   assert.equal(error.status, 429);
   assert.equal(error.provider, 'codegpt');
   assert.equal(error.retryable, true);
   assert.equal(error.retryAfterSeconds, 15);
   assert.match(error.message, /one.*session|another interactive session/i);
   assert.doesNotMatch(error.message, /\{|errorMessage|ECONOMY_CONCURRENCY_LIMIT/);
   return true;
  });
 }
 const plain429 = codegptProviderError('rate limited', 429);
 assert.equal(plain429.code, 'CODEGPT_RATE_LIMIT');
 assert.equal(plain429.status, 429);
});
test('empty CodeGPT streams and provider pages never become assistant text', () => {
 for (const body of [
  'data: [DONE]\n\n',
  'data: {"choices":[]}\n\ndata: [DONE]\n\n',
  'data: {"error":\n\n',
  'data: null\n\ndata: [DONE]\n\n',
  '<html>provider unavailable</html>',
  '{"choices":[]}',
  'null'
 ]) assert.equal(extractCodegptApiReply(body), '');
 assert.equal(extractCodegptApiReply(
  'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'), 'OK');
 assert.equal(extractCodegptApiReply('plain answer'), 'plain answer');
 assert.throws(() => extractCodegptApiReply('CodeGPT: ' + JSON.stringify({
  status: 429, code: 'ECONOMY_CONCURRENCY_LIMIT', message: 'Another stream on this account'
 })), (error) => error.code === 'ECONOMY_CONCURRENCY_LIMIT' && error.status === 429);
});
test('capture waits for the entire local run and preserves responses over 6000 chars', async () => {
 let finish;
 const context = { window: { fetch: async () => ({ status: 200, clone: () => ({ text: () => new Promise(resolve => {finish=resolve;}) }) }), XMLHttpRequest: class {} }, Date };
 const hook = vm.runInNewContext(section('const CODEGPT_HOOK_JS =', 'const CODEGPT_SNAPSHOT_JS =') + '\nCODEGPT_HOOK_JS');
 vm.runInNewContext(hook, context);
 await context.window.fetch('http://localhost:54112/54113/api/runs');
 assert.equal(context.window.__reachCg.pending, true);
 const body = run([{role:'assistant',content:'x'.repeat(15000)}]);
 finish(body); await new Promise(resolve => setImmediate(resolve));
 assert.equal(context.window.__reachCg.pending, false);
 assert.equal(context.window.__reachCg.run, true);
 assert.equal(context.window.__reachCg.body, body);
});
test('send uses one trusted click, not duplicate submissions', () => {
 const send = section('async function codegptClickSend()', 'let codegptQueue');
 assert.equal(send.includes('b.click()'), false);
 assert.equal((send.match(/type: 'mouseUp'/g) || []).length, 1);
});

test('an unavailable requested model fails before sending anything', async () => {
 const context = {checkCodegptSignedIn:async()=>({ok:true}), codegptSelectModel:async()=>false,
  lastCodegptRequested:'',lastCodegptServed:'',log(){}};
 const send = vm.runInNewContext(section('async function codegptSendRequest(', '/* ---------------------- ChatGPT page driving') + '\ncodegptSendRequest',context);
 await assert.rejects(send('hello',undefined,{id:'missing',label:'Missing'}),/could not select.*No request was sent/);
});
test('default and legacy requests select a real economy entry, unknown IDs fail', async () => {
 const engines=[];
 const context={codegptWin:{isDestroyed:()=>false}, ECONOMY_PREFIX:'codegpt-eco',
  waitForProviderWindow:async()=>{}, ensureCodegpt(){}, codegptSnapshot:async()=>({}), showCodegpt(){},
  economyBridgeIds:()=>['codegpt-eco','codegpt-eco-first'],
  economyModelFor:id=>id==='codegpt-eco-first'?{id:'first'}:null,
  codegptSendRequest:async(text,signal,engine)=>{engines.push(engine.id);return 'OK';},log(){}};
 const send=vm.runInNewContext(section('async function codegptSend(text', 'async function codegptSendRequest(')+'\ncodegptSend',context);
 for(const model of [undefined,'codegpt-eco','codegpt-eco-gpt-4o-mini']) assert.equal(await send('hello',{model}),'OK');
 assert.deepEqual(engines,['first','first','first']);
 await assert.rejects(send('hello',{model:'codegpt-eco-unknown'}),/Unknown CodeGPT economy model/);
});
