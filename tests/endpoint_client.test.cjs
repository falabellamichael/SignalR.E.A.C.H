const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../tools/endpoint-client.cjs');

async function fixture(t, upstream, options = {}) {
 const calls=[];
 const server=createClient({pointer:'https://pointer.test/url',fetchImpl:async(url,options)=>{
  calls.push({url,options});
  return url==='https://pointer.test/url' ? new Response('https://hosted.test') : upstream(url,options);
 },...options});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return {base:'http://127.0.0.1:'+server.address().port,calls};
}
test('hosted status and models work without a local OmniRoute instance',async t=>{
 const h=await fixture(t,url=>new Response(JSON.stringify(url.endsWith('/health')
  ? {service:'signalreach',ok:true,upstream_ok:true,models:['remote-model']}
  : {data:[{id:'remote-model'}]})));
 const status=await (await fetch(h.base+'/status')).json();
 assert.equal(status.connection_mode,'hosted');assert.equal(status.public_url,'https://hosted.test');
 assert.equal(status.upstream_ok,true);
 assert.deepEqual((await (await fetch(h.base+'/v1/models')).json()).data,[{id:'remote-model'}]);
 assert.equal(h.calls.filter(c=>c.url.includes('pointer.test')).length,1);
 assert.ok(h.calls.filter(c=>c.url.includes('hosted.test')).every(c=>c.options.headers['ngrok-skip-browser-warning']==='1'));
});
test('streaming forwards full conversations and preserves the OpenAI event stream',async t=>{
 const wire='data: {"choices":[{"delta":{"content":"Mira"}}]}\n\ndata: [DONE]\n\n';
 const h=await fixture(t,()=>new Response(wire,{headers:{'content-type':'text/event-stream'}}));
 const payload={model:'remote-model',stream:true,messages:[{role:'user',content:'My name is Mira.'},{role:'assistant',content:'Hi Mira'},{role:'user',content:'My name?'}]};
 const r=await fetch(h.base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 assert.equal(r.headers.get('content-type'),'text/event-stream');assert.equal(await r.text(),wire);
 assert.deepEqual(JSON.parse(h.calls.at(-1).options.body.toString()),payload);
 assert.equal(h.calls.at(-1).url,'https://hosted.test/v1/chat/completions');
});
test('hosting actions are blocked locally and never sent to the hosted service',async t=>{
 const h=await fixture(t,()=>{throw Error('Unexpected upstream request');});
 for(const path of ['/_reach/restart','/_reach/publish','/_reach/settings']){
  const r=await fetch(h.base+path,{method:'POST',body:'{}'});assert.equal(r.status,403);
 }
 assert.equal(h.calls.length,0);
});
test('upstream errors remain errors instead of reporting the endpoint as online',async t=>{
 const h=await fixture(t,()=>new Response(JSON.stringify({error:{message:'Unavailable'}}),{status:503}));
 assert.equal((await fetch(h.base+'/status')).status,502);
 const r=await fetch(h.base+'/v1/chat/completions',{method:'POST',body:'{}'});
 assert.equal(r.status,503);assert.equal((await r.json()).error.message,'Unavailable');
});

// --- access key: the hosted relay requires one --------------------------------
const httpRaw=(base,path,headers)=>new Promise((resolve,reject)=>{
 const u=new URL(base+path);
 const req=require('node:http').request({host:u.hostname,port:u.port,path:u.pathname,method:'GET',headers},res=>{
  let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});
 req.on('error',reject);req.end();
});
const okModels=()=>new Response(JSON.stringify({data:[]}));
test('a configured key is supplied for local programs that bring none',async t=>{
 const h=await fixture(t,okModels,{key:'  sk-reach-friend  '});
 assert.equal((await fetch(h.base+'/v1/models')).status,200);
 assert.equal(h.calls.at(-1).options.headers.Authorization,'Bearer sk-reach-friend');
});
test('a caller with its own credentials keeps them over the configured key',async t=>{
 const h=await fixture(t,okModels,{key:'sk-reach-friend'});
 await fetch(h.base+'/v1/models',{headers:{Authorization:'Bearer sk-reach-theirs'}});
 assert.equal(h.calls.at(-1).options.headers.Authorization,'Bearer sk-reach-theirs');
 await fetch(h.base+'/v1/models',{headers:{'X-Reach-Key':'sk-reach-theirs'}});
 assert.equal(h.calls.at(-1).options.headers['X-Reach-Key'],'sk-reach-theirs');
 assert.equal(h.calls.at(-1).options.headers.Authorization,undefined);
});
test('nothing is added when no key is configured',async t=>{
 const h=await fixture(t,okModels,{key:''});
 await fetch(h.base+'/v1/models');
 assert.equal(h.calls.at(-1).options.headers.Authorization,undefined);
});
test('a web page cannot borrow the configured key through the bridge',async t=>{
 const h=await fixture(t,okModels,{key:'sk-reach-friend'});
 const port=new URL(h.base).port;
 // a page on another site: browsers attach its Origin
 await httpRaw(h.base,'/v1/models',{Host:'127.0.0.1:'+port,Origin:'https://evil.example'});
 assert.equal(h.calls.at(-1).options.headers.Authorization,undefined,'foreign Origin');
 // DNS rebinding: the page is "same origin", so no Origin, but Host is its own domain
 await httpRaw(h.base,'/v1/models',{Host:'rebind.evil.example:'+port});
 assert.equal(h.calls.at(-1).options.headers.Authorization,undefined,'foreign Host');
 // a genuine local program still gets it
 await httpRaw(h.base,'/v1/models',{Host:'localhost:'+port});
 assert.equal(h.calls.at(-1).options.headers.Authorization,'Bearer sk-reach-friend');
});
