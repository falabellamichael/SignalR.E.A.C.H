const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../copilot/tray/main.js'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
const parse = vm.runInNewContext(section('function extractCodegptRunReply(', '// Pull the assistant text') + '\nextractCodegptRunReply');
const run = messages => JSON.stringify({ t: 'final', done: true, messages });

test('economy chat uses the extension API port, not the Next port', () => {
 const url = new URL(source.match(/const CODEGPT_CHAT_URL = '([^']+)'/)[1]);
 assert.equal(url.port, '54112');
 assert.equal(url.pathname, '/54113/');
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
  economyBridgeIds:()=>['codegpt-eco','codegpt-eco-first'],
  economyModelFor:id=>id==='codegpt-eco-first'?{id:'first'}:null,
  codegptSendRequest:async(text,signal,engine)=>{engines.push(engine.id);return 'OK';},log(){}};
 const send=vm.runInNewContext(section('async function codegptSend(text', 'async function codegptSendRequest(')+'\ncodegptSend',context);
 for(const model of [undefined,'codegpt-eco','codegpt-eco-gpt-4o-mini']) assert.equal(await send('hello',{model}),'OK');
 assert.deepEqual(engines,['first','first','first']);
 await assert.rejects(send('hello',{model:'codegpt-eco-unknown'}),/Unknown CodeGPT economy model/);
});
