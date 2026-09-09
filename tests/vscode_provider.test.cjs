const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const extensionPath=path.resolve(__dirname,'../vscode/extension.js');
const source=fs.readFileSync(extensionPath,'utf8');

function host(values, response) {
 const calls=[],posts=[];
 const config={provider:'endpoint',endpoint:'https://free.example/v1',model:'my/free-model',accessKey:'free-only-key',...values};
 const req=createRequire(extensionPath);
 const context={module:{exports:{}},console,process,Buffer,URL,AbortController,AbortSignal,TextDecoder,setTimeout,clearTimeout,
 require:name=>name==='vscode'?{ConfigurationTarget:{Global:1},Uri:{joinPath:()=>''},workspace:{getConfiguration:()=>({get:key=>config[key],update:async(key,value)=>{config[key]=value;}})}}:name==='./search'?{}:req(name),
 fetch:async(url,options)=>{calls.push({url,options});return response(url,options);}
 };
 vm.runInNewContext(source+'\nmodule.exports.TestProvider=ReachChatViewProvider; module.exports.testConfig=config;',context,{filename:extensionPath});
 const provider=new context.module.exports.TestProvider({});
 provider._post=(type,payload)=>posts.push({type,...payload});
 let receive;
 provider._html=()=>'';
 provider.resolveWebviewView({webview:{onDidReceiveMessage:handler=>{receive=handler;}}});
 return {provider,calls,posts,config,readConfig:context.module.exports.testConfig,receive};
}

test('VS Code free-endpoint chat keeps the selected model and access key',async()=>{
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'FREE OK'}}]})));
 await h.provider._chat({messages:[{role:'user',content:'hello'}],model:'my/free-model',stream:false});
 assert.equal(h.calls[0].url,'https://free.example/v1/chat/completions');
 assert.equal(JSON.parse(h.calls[0].options.body).model,'my/free-model');
 assert.equal(h.calls[0].options.headers.Authorization,'Bearer free-only-key');
 assert.equal(h.posts.find(p=>p.type==='done').full,'FREE OK');
});

test('added providers are saved and selected independently from the locked Free endpoints connection', async()=>{
 const h=host({},(url, options)=>{
   if(url.endsWith('/models')) return new Response(JSON.stringify({data:(url.includes('second') ? ['other/model','shared'] : ['my/free-model','shared']).map(id=>({id}))}));
   return new Response(JSON.stringify({choices:[{message:{content:'SECOND OK'}}]}));
 });
 await h.receive({type:'setConfig',key:'additionalEndpoints',value:['https://second.example/v1']});
 assert.deepEqual(Array.from(h.config.additionalEndpoints),['https://second.example/v1']);
 assert.equal(h.readConfig().endpoint,'https://free.example/v1');
 assert.deepEqual(Array.from(h.posts.find(p=>p.type==='models').models),['my/free-model','shared']);
 assert.ok(h.calls.every(call=>call.url.startsWith('https://free.example/')));
 await h.receive({type:'setConfig',key:'provider',value:'endpoint:https://second.example/v1'});
 assert.equal(h.readConfig().providerSelection,'endpoint:https://second.example/v1');
 assert.equal(h.config.selectedEndpoint,'https://second.example/v1');
 assert.deepEqual(Array.from(h.posts.filter(p=>p.type==='models').at(-1).models),['other/model','shared']);
 // A model ID shared with Free endpoints must still use the selected provider.
 await h.provider._chat({messages:[{role:'user',content:'hi'}],model:'shared',stream:false});
 assert.equal(h.calls.at(-1).url,'https://second.example/v1/chat/completions');
 await h.provider._think('hi',false,'other/model');
 assert.equal(h.calls.at(-1).url,'https://second.example/v1/chat/completions');
 await h.provider._deriveQuery('hi','other/model');
 assert.equal(h.calls.at(-1).url,'https://second.example/v1/chat/completions');
 await h.receive({type:'setConfig',key:'endpoint',value:'https://changed.example/v1'});
 assert.equal(h.config.endpoint,'https://free.example/v1');
 await h.receive({type:'setConfig',key:'provider',value:'endpoint:https://unknown.example/v1'});
 assert.equal(h.config.selectedEndpoint,'https://second.example/v1');
 await h.receive({type:'setConfig',key:'provider',value:'endpoint'});
 assert.equal(h.readConfig().endpoint,'https://free.example/v1');
 assert.equal(h.config.selectedEndpoint,'');
 await h.receive({type:'setConfig',key:'provider',value:'endpoint:https://second.example/v1'});
 await h.receive({type:'setConfig',key:'additionalEndpoints',value:[]});
 assert.equal(h.readConfig().providerSelection,'endpoint');
 assert.equal(h.readConfig().endpoint,'https://free.example/v1');
});

test('an unavailable selected provider reports its error without using a different endpoint',async()=>{
 const h=host({additionalEndpoints:['https://second.example/v1'],selectedEndpoint:'https://second.example/v1'},()=>new Response('',{status:503}));
 await h.provider._fetchModels();
 assert.equal(h.posts.some(p=>p.type==='models'),false);
 assert.match(h.posts.find(p=>p.type==='error').message,/second.example.*503/);
 assert.ok(h.calls.every(call=>call.url.startsWith('https://second.example/')));
});

test('Copilot ignores additional free endpoints during model discovery',async()=>{
 const h=host({provider:'copilot',additionalEndpoints:['https://second.example/v1']},url=>
   new Response(JSON.stringify({data:[{id:'copilot-chat'}]})));
 const catalog=await h.provider._discoverModels(h.readConfig());
 assert.ok(h.calls.every(call=>call.url.startsWith('http://127.0.0.1:21302/')));
 assert.deepEqual(Array.from(catalog.routes.keys()),['copilot-chat']);
});

test('VS Code Copilot uses its bridge/model and never sends the free endpoint key',async()=>{
 const h=host({provider:'copilot'},()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'COPILOT OK'}}]})+'\n\ndata: [DONE]\n\n'));
 await h.provider._chat({messages:[{role:'user',content:'hello'}],model:'old-free-model',stream:true});
 assert.equal(h.calls[0].url,'http://127.0.0.1:21302/v1/chat/completions');
 assert.equal(JSON.parse(h.calls[0].options.body).model,'copilot-chat');
 assert.equal(h.calls[0].options.headers.Authorization,undefined);
 assert.equal(h.posts.find(p=>p.type==='delta').text,'COPILOT OK');
 assert.ok(h.posts.some(p=>p.type==='done'));
});

test('VS Code shows streaming provider errors and retains prefixed model IDs',async()=>{
 const h=host({},()=>new Response('data: {"error":{"message":"Sign in required"}}\n\ndata: [DONE]\n\n'));
 await h.provider._chat({messages:[{role:'user',content:'hi'}],stream:true});
 assert.equal(h.posts.find(p=>p.type==='error').message,'Sign in required');
 const models=host({},()=>new Response(JSON.stringify({data:[{id:'gpt-4o'},{id:'my/free-model'}]})));
 await models.provider._fetchModels();
 assert.deepEqual(Array.from(models.posts.find(p=>p.type==='models').models),['gpt-4o','my/free-model']);
});

test('endpoint keys save independently and only authenticate their own provider',async()=>{
 const second='https://second.example/v1';
 const h=host({additionalEndpoints:[second]},url=>new Response(JSON.stringify(url.endsWith('/models')
   ? {data:[{id:'shared'}]} : {choices:[{message:{content:'OK'}}]})));
 await h.receive({type:'setConfig',key:'endpointAccessKey',endpoint:second,value:'second-key'});
 assert.equal(h.calls.length,0,'saving an inactive key should not contact a provider');
 assert.equal(h.config.endpointAccessKeys[second],'second-key');
 assert.equal(h.config.accessKey,'free-only-key');
 await h.receive({type:'setConfig',key:'provider',value:'endpoint:'+second});
 assert.equal(h.calls.at(-1).options.headers.Authorization,'Bearer second-key');
 await h.provider._chat({messages:[],model:'shared',stream:false});
 assert.equal(h.calls.at(-1).options.headers.Authorization,'Bearer second-key');
 await h.provider._think('hi',false,'shared');
 assert.equal(h.calls.at(-1).options.headers.Authorization,'Bearer second-key');
 await h.provider._deriveQuery('hi','shared');
 assert.equal(h.calls.at(-1).options.headers.Authorization,'Bearer second-key');
 await h.receive({type:'setConfig',key:'endpointAccessKey',endpoint:second,value:''});
 assert.equal(h.calls.at(-1).options.headers.Authorization,undefined,'a cleared key must not fall back to the free key');
 await h.receive({type:'setConfig',key:'endpointAccessKey',endpoint:'https://unknown.example',value:'ignore'});
 assert.equal(h.config.endpointAccessKeys['https://unknown.example'],undefined);
 await h.receive({type:'setConfig',key:'provider',value:'endpoint'});
 assert.equal(h.calls.at(-1).options.headers.Authorization,'Bearer free-only-key');
 await h.receive({type:'setConfig',key:'endpointAccessKey',endpoint:'https://free.example/v1',value:'updated-free-key'});
 assert.equal(h.calls.at(-1).options.headers.Authorization,'Bearer updated-free-key');
 await h.receive({type:'setConfig',key:'endpointAccessKey',endpoint:second,value:'second-key'});
 await h.receive({type:'setConfig',key:'additionalEndpoints',value:['https://replacement.example/v1']});
 assert.equal(h.config.endpointAccessKeys[second],undefined);
 await h.receive({type:'setConfig',key:'provider',value:'endpoint:https://replacement.example/v1'});
 assert.equal(h.calls.at(-1).options.headers.Authorization,undefined,'editing a URL must not copy its key');
});
