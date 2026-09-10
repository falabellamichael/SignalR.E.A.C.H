const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEndpointClient } = require('../copilot/tray/endpoint');
const { createBridgeHandler } = require('../copilot/tray/bridge');
const { resolveEndpoint, trayDirectory, trayBinary } = require('../vscode/connection');

async function serve(t, handler) {
 const server = http.createServer(handler);
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
 return `http://127.0.0.1:${server.address().port}`;
}

test('free endpoint: pointer, prefixed models, persisted settings, and chat routing', async t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-test-'));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 let captured;
 const base = await serve(t, (req,res) => {
   if (req.url === '/pointer.txt') return res.end(base);
   if (req.url === '/v1/models') return res.end(JSON.stringify({data:[{id:'my/free-model'}]}));
   if(req.url === '/v1/chat/completions') { let text=''; req.on('data',c=>text+=c); req.on('end',()=>{ captured=JSON.parse(text); res.end(JSON.stringify({choices:[{message:{content:'FREE OK'}}]})); }); return; }
   res.writeHead(404);res.end();
 });
 const settingsPath=path.join(dir,'settings.json');
 const client=createEndpointClient(settingsPath);
 client.saveSettings({endpoint:base+'/pointer.txt',model:'my/free-model'});
 assert.deepEqual((await client.discover()).models,['my/free-model']);
 const messages=[{role:'system',content:'Context'},{role:'user',content:'Hi'}];
 assert.equal(await client.chat(client.getSettings(),messages),'FREE OK');
 assert.deepEqual(captured,{model:'my/free-model',messages,stream:false});
 assert.equal(createEndpointClient(settingsPath).getSettings().model,'my/free-model');
 assert.throws(()=>client.saveSettings({endpoint:'file:///etc/passwd'}),/HTTP/);
 assert.equal(client.getSettings().endpoint,base+'/pointer.txt');
 assert.equal(await resolveEndpoint(base+'/pointer.txt/v1'),base+'/v1');
 await assert.rejects(client.chat({...client.getSettings(),model:'removed'},messages),/no longer available/);
});

test('Copilot bridge supports legacy, JSON and SSE clients with full conversation context', async t => {
 const calls=[];
 const base=await serve(t,createBridgeHandler(async text=>{calls.push(text);return 'COPILOT OK';},null,()=>({ok:true})));
 const models=await (await fetch(base+'/v1/models')).json();
 assert.equal(models.data[0].id,'copilot-chat');
 const send=body=>fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify(body)});
 const messages=[{role:'system',content:'Explain code'},{role:'developer',content:'Read the source'},{role:'tool',content:'SOURCE_END'},{role:'user',content:'Hi'}];
 const json=await (await send({model:'copilot-chat',messages,stream:false})).json();
 assert.equal(json.choices[0].message.content,'COPILOT OK');
 assert.match(calls[0],/system: Explain code/);
 assert.match(calls[0],/developer: Read the source/);
 assert.match(calls[0],/tool: SOURCE_END/);
 const stream=await send({model:'copilot-chat',messages,stream:true});
 assert.match(stream.headers.get('content-type'),/event-stream/);
 const body=await stream.text();assert.match(body,/COPILOT OK/);assert.match(body,/data: \[DONE\]/);
 const legacy=await (await fetch(base+'/send',{method:'POST',body:JSON.stringify({text:'old shim'})})).json();
 assert.equal(legacy.content,'COPILOT OK');
 assert.equal((await send({messages,model:'wrong'})).status,400);
});

test('Copilot failures remain visible to both JSON and streaming VS Code clients',async t=>{
 const base=await serve(t,createBridgeHandler(async()=>{throw new Error('Sign in to Microsoft 365');},null,()=>({ok:true})));
 for(const stream of [false,true]){
 const response=await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'Hi'}],stream})});
 assert.equal(response.status,stream?200:502);assert.match(await response.text(),/Sign in to Microsoft 365/);
 }
});

test('tray runtime launch paths cover macOS, Windows and Linux',()=>{
 assert.match(trayBinary('/tray','darwin'),/Electron\.app\/Contents\/MacOS\/Electron$/);
 assert.match(trayBinary('/tray','win32'),/electron\.exe$/);
 assert.match(trayBinary('/tray','linux'),/dist\/electron$/);
 assert.equal(trayDirectory('darwin',{},'/home/u'),'/home/u/Library/Application Support/SignalREACH/copilot/tray');
 assert.equal(trayDirectory('linux',{XDG_CONFIG_HOME:'/config'},'/home/u'),'/config/SignalREACH/copilot/tray');
 assert.equal(trayDirectory('win32',{LOCALAPPDATA:'/local'},'/home/u'),'/local/SignalREACH/copilot/tray');
});
