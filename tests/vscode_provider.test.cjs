const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const extensionPath=path.resolve(process.env.REACH_VSCODE_TEST_PATH || path.join(__dirname,'../vscode'),'extension.js');
const source=fs.readFileSync(extensionPath,'utf8');

function host(values, response, workspace = {}, api = {}) {
 const calls=[],posts=[];
 const config={provider:'endpoint',endpoint:'https://free.example/v1',model:'my/free-model',accessKey:'free-only-key',...values};
 const req=createRequire(extensionPath);
 const context={module:{exports:{}},console,process,Buffer,URL,AbortController,AbortSignal,TextDecoder,setTimeout,clearTimeout,
 require:name=>name==='vscode'?{window:{tabGroups:{all:[]}},RelativePattern:class {constructor(folder,pattern){this.folder=folder;this.pattern=pattern;}},ConfigurationTarget:{Global:1},Uri:{joinPath:(root,rel)=>({fsPath:path.join(root.fsPath,rel)})},workspace:{isTrusted:true,getConfiguration:()=>({get:key=>config[key],update:async(key,value)=>{config[key]=value;}}),...workspace},...api}:name==='./search'?{}:req(name),
 fetch:async(url,options)=>{calls.push({url,options});return response(url,options);}
 };
 vm.runInNewContext(source+'\nmodule.exports.TestProvider=ReachChatViewProvider; module.exports.testConfig=config;',context,{filename:extensionPath});
 const provider=new context.module.exports.TestProvider({fsPath:'/extension'});
 provider._ideBridge={handles:()=>false}; // Legacy provider tests; bridge activation is covered separately.
 provider._secrets={store:async()=>{}};
 provider._post=(type,payload)=>posts.push({type,...payload});
 let receive;
 provider._html=()=>'';
 provider.resolveWebviewView({webview:{onDidReceiveMessage:handler=>{receive=handler;}}});
 return {provider,calls,posts,config,readConfig:context.module.exports.testConfig,receive};
}

test('custom agent templates retain their text and receive every missing output format',()=>{
 const context={vscode:{workspace:{workspaceFolders:[]}}};
 vm.runInNewContext(source.slice(source.indexOf('function expandAgentTemplate('),source.indexOf('const TRAY_PROVIDERS')),context);
 for (const template of ['Keep edits small.', 'Custom ```edit contract.', 'Custom ```tool contract.', 'Custom ```confirm contract.']) {
  const prompt=context.agentSystemPrompt({agentTemplate:template});
  assert.ok(prompt.startsWith(template));
  for (const format of ['edit','tool','confirm']) assert.ok(prompt.includes('```'+format),format+' contract missing');
 }
 const complete='Use ```edit, ```tool and ```confirm.';
 assert.equal(context.agentSystemPrompt({agentTemplate:complete}),complete);
});

test('VS Code free-endpoint chat keeps the selected model and access key',async()=>{
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'FREE OK'}}]})));
 await h.provider._chat({messages:[{role:'user',content:'hello'}],model:'my/free-model',stream:false});
 assert.equal(h.calls[0].url,'https://free.example/v1/chat/completions');
 assert.equal(JSON.parse(h.calls[0].options.body).model,'my/free-model');
 assert.equal(h.calls[0].options.headers.Authorization,'Bearer free-only-key');
 assert.equal(h.posts.find(p=>p.type==='done').full,'FREE OK');
});

test('Agent-off requests remove saved action formatting while keeping context and explicit format requests',async()=>{
 const actionCodec=require('../vscode/agent-action');
 const {protocol}=require('../vscode/media/agent-run');
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'Readable answer'}}]})));
 const messages=[{role:'system',content:'Keep the project facts.\n'+actionCodec.instruction+'\n'+protocol},
  {role:'user',content:'Show a JSON example for SQLite metadata.'}];
 const original=JSON.stringify(messages);
 await h.provider._chat({messages,agentic:false,structuredActions:true});
 assert.equal(h.calls.length,1);
 const payload=JSON.parse(h.calls[0].options.body);
 assert.equal(payload.response_format,undefined);
 assert.match(payload.messages[0].content,/Keep the project facts/);
 assert.match(payload.messages[0].content,/Agent mode is off/);
 assert.match(payload.messages[0].content,/when the user explicitly requests it/);
 assert.ok(!payload.messages[0].content.includes(actionCodec.instruction));
 assert.ok(!payload.messages[0].content.includes(protocol));
 assert.equal(payload.messages.at(-1).content,messages.at(-1).content);
 assert.equal(JSON.stringify(messages),original);
 assert.equal(h.posts.find(p=>p.type==='done').full,'Readable answer');
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
 // Free endpoints also probes the LOCAL tray bridge for the economy group, so
 // every call is either the free endpoint or 127.0.0.1:21302 — never a third
 // party. (The bridge probe is best-effort and adds no models when the tray is
 // not running, which is the case here.)
 assert.ok(h.calls.every(call=>call.url.startsWith('https://free.example/')||call.url.startsWith('http://127.0.0.1:21302/')),'unexpected destination: '+h.calls.map(c=>c.url).join(', '));
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
 // The failure must be reported without falling back to another endpoint. The
 // local bridge probe is expected and does not count as a fallback.
 assert.ok(h.calls.every(call=>call.url.startsWith('https://second.example/')||call.url.startsWith('http://127.0.0.1:21302/')),'unexpected destination: '+h.calls.map(c=>c.url).join(', '));
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

test('Gemini provider lists only its model and sends selected chats to the local tray',async()=>{
 const h=host({provider:'gemini',additionalEndpoints:['https://second.example/v1']},(url)=>
   url.endsWith('/models')
     ? new Response(JSON.stringify({data:['copilot-chat','chatgpt-chat','gemini-chat','codegpt-eco'].map(id=>({id}))}))
     : new Response(JSON.stringify({choices:[{message:{content:'GEMINI OK'}}]})));
 const catalog=await h.provider._discoverModels(h.readConfig());
 assert.deepEqual(Array.from(catalog.routes.keys()),['gemini-chat']);
 assert.ok(h.calls.every(call=>call.url.startsWith('http://127.0.0.1:21302/')));
 await h.provider._chat({messages:[{role:'user',content:'hello'}],model:'old-free-model',stream:false});
 assert.equal(h.calls.at(-1).url,'http://127.0.0.1:21302/v1/chat/completions');
 assert.equal(JSON.parse(h.calls.at(-1).options.body).model,'gemini-chat');
 assert.equal(h.calls.at(-1).options.headers.Authorization,undefined);
 assert.equal(h.posts.find(p=>p.type==='done').full,'GEMINI OK');
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
 // Discovery also probes the local bridge; assert on the calls that actually
 // target the selected endpoint, not simply the most recent one.
 const toSecond=()=>h.calls.filter(c=>c.url.startsWith('https://second.example/')).at(-1);
 assert.equal(toSecond().options.headers.Authorization,'Bearer second-key');
 await h.provider._chat({messages:[],model:'shared',stream:false});
 assert.equal(toSecond().options.headers.Authorization,'Bearer second-key');
 await h.provider._think('hi',false,'shared');
 assert.equal(toSecond().options.headers.Authorization,'Bearer second-key');
 await h.provider._deriveQuery('hi','shared');
 assert.equal(toSecond().options.headers.Authorization,'Bearer second-key');
 await h.receive({type:'setConfig',key:'endpointAccessKey',endpoint:second,value:''});
 assert.equal(toSecond().options.headers.Authorization,undefined,'a cleared key must not fall back to the free key');
 await h.receive({type:'setConfig',key:'endpointAccessKey',endpoint:'https://unknown.example',value:'ignore'});
 assert.equal(h.config.endpointAccessKeys['https://unknown.example'],undefined);
 await h.receive({type:'setConfig',key:'provider',value:'endpoint'});
 const toFree=()=>h.calls.filter(c=>c.url.startsWith('https://free.example/')).at(-1);
 assert.equal(toFree().options.headers.Authorization,'Bearer free-only-key');
 await h.receive({type:'setConfig',key:'endpointAccessKey',endpoint:'https://free.example/v1',value:'updated-free-key'});
 assert.equal(toFree().options.headers.Authorization,'Bearer updated-free-key');
 await h.receive({type:'setConfig',key:'endpointAccessKey',endpoint:second,value:'second-key'});
 await h.receive({type:'setConfig',key:'additionalEndpoints',value:['https://replacement.example/v1']});
 assert.equal(h.config.endpointAccessKeys[second],undefined);
 await h.receive({type:'setConfig',key:'provider',value:'endpoint:https://replacement.example/v1'});
 assert.equal(h.calls.filter(c=>c.url.startsWith('https://replacement.example/')).at(-1).options.headers.Authorization,undefined,'editing a URL must not copy its key');
});

test('Think and final chat retain prior turns when answering a follow-up', async()=>{
 const h=host({think:true},()=>new Response(JSON.stringify({choices:[{message:{content:'The earlier code word was cobalt.'}}]})));
 const messages=[
  {role:'user',content:'Remember the code word cobalt.'},
  {role:'assistant',content:'I will remember cobalt.'},
  {role:'user',content:'What was the code word?'}
 ];
 await h.provider._chat({messages,model:'my/free-model',stream:false,think:true,includeWorkspace:false});
 assert.equal(h.calls.length,2);
 for(const call of h.calls){
  const sent=JSON.parse(call.options.body).messages;
  assert.deepEqual(sent.filter(m=>m.role!=='system'),messages);
 }
 assert.equal(messages.length,3);
});

test('Copilot receives complete files beyond the old read limits, including unsaved text', async()=>{
 const file='first line\n'+'x'.repeat(70000)+'\nUNSAVED_END_SENTINEL';
 const h=host({provider:'copilot'},()=>new Response(JSON.stringify({choices:[{message:{content:'Read the end.'}}]})),{
  workspaceFolders:[{uri:{fsPath:'/workspace'}}],
  openTextDocument:async uri=>{assert.equal(uri.fsPath,path.join('/workspace','large.js'));return {getText:()=>file,isDirty:true};}
 });
 await h.receive({type:'toolReq',uid:'full',action:'read',path:'large.js'});
 const result=h.posts.find(p=>p.type==='toolResult');
 assert.equal(result.ok,true);assert.ok(result.result.includes(file));
 assert.match(result.result,/complete file/);assert.match(result.result,/unsaved editor contents/);
 await h.provider._chat({model:'copilot-chat',stream:false,messages:[{role:'user',content:result.result}]});
 const parts=h.calls.map(c=>JSON.parse(c.options.body).messages[0].content).filter(c=>c.startsWith('Read this consecutive part'));
 assert.ok(parts.map(c=>c.split(/Part \d+\/\d+:\n/)[1]).join('').includes(file));
 assert.ok(parts.every(c=>c.length<=7000));
});

test('large reads report their limit and support explicit line ranges without truncation', async()=>{
 const file=Array.from({length:2000},(_,i)=>`${i+1}: `+'x'.repeat(600)).join('\n');
 const h=host({},()=>{}, {workspaceFolders:[{uri:{fsPath:'/workspace'}}],openTextDocument:async()=>({getText:()=>file})});
 await h.receive({type:'toolReq',uid:'large',action:'read',path:'large.txt'});
 assert.equal(h.posts.at(-1).ok,false);assert.match(h.posts.at(-1).error,/no file content was returned/);
 await h.receive({type:'toolReq',uid:'range',action:'read',path:'large.txt',startLine:1999,endLine:2000});
 assert.equal(h.posts.at(-1).ok,true);assert.match(h.posts.at(-1).result,/lines 1999-2000 of 2000/);
 assert.ok(h.posts.at(-1).result.includes(file.split('\n').slice(1998).join('\n')));
 await h.receive({type:'toolReq',uid:'bad',action:'read',path:'large.txt',startLine:0});
 assert.equal(h.posts.at(-1).ok,false);
 await h.receive({type:'toolReq',uid:'escape',action:'read',path:'../outside.txt'});
 assert.equal(h.posts.at(-1).ok,false);
});

function sourceWorkspace(files) {
 const reads=[];
 return {reads, workspace:{
  workspaceFolders:[{name:'project',uri:{fsPath:'/workspace'}}],
  findFiles:async()=>Object.keys(files).map(p=>({fsPath:'/workspace/'+p})),
  getWorkspaceFolder:()=>({uri:{fsPath:'/workspace'}}),
  openTextDocument:async uri=>{
   const rel=uri.fsPath.slice('/workspace/'.length); reads.push(rel);
   assert.ok(Object.hasOwn(files,rel),'only catalog files may be opened');
   return {uri,languageId:'javascript',isDirty:true,getText:()=>files[rel]};
  },
 }};
}

test('a repository review reads closed source before both Think and the answer',async()=>{
 const full='// source\n'+'x'.repeat(70000)+'\nACTUAL_FILE_END';
 const fixture=sourceWorkspace({'src/nested/service.js':full,'package.json':'{"name":"fixture"}'});
 const h=host({think:true},(url,options)=>{
  const sent=JSON.parse(options.body);
  const selecting=sent.messages[0].content.includes('Select workspace');
  return new Response(JSON.stringify({choices:[{message:{content:selecting
   ? '["src/nested/service.js"]' : 'Grounded response'}}]}));
 },fixture.workspace);
 await h.provider._chat({messages:[{role:'user',content:'Review this filebase'}],model:'my/free-model',agentic:true,includeWorkspace:true,think:true,stream:false});
 assert.deepEqual(fixture.reads,['src/nested/service.js']);
 assert.equal(h.calls.length,3);
 assert.match(JSON.parse(h.calls[0].options.body).messages[0].content,/src\/nested\/service.js/);
 for(const call of h.calls.slice(1)) {
  const sent=JSON.parse(call.options.body);
  assert.equal(sent.model,'my/free-model');
  assert.ok(sent.messages.some(m=>m.content.includes(full)),'Think and final must see the full source');
 }
 const info=h.posts.find(p=>p.type==='contextInfo');
 assert.equal(info.files,1);assert.match(info.context,/ACTUAL_FILE_END/);
 const steps=h.posts.filter(p=>p.type==='agentStep');
 const read=steps.find(p=>p.title==='Read: src/nested/service.js');
 assert.equal(read.status,'running');
 const result=steps.find(p=>p.uid===read.uid && p.status==='completed');
 assert.ok(result.result.includes(full),'the read step receives the actual complete source result');
 const response=steps.find(p=>p.kind==='response');
 assert.ok(response && steps.indexOf(response)>steps.indexOf(result),'source results appear before response generation');
});

test('providers that refuse file selection still get real source and cannot select outside the catalog',async()=>{
 const fixture=sourceWorkspace({'package.json':'{}','src/app.js':'IMPLEMENTATION_END','secret.pem':'PRIVATE KEY'});
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'["../../outside.js", "secret.pem"]'}}]})),fixture.workspace);
 await h.provider._chat({messages:[{role:'user',content:'review the repository'}],agentic:true,includeWorkspace:true,stream:false});
 assert.deepEqual(fixture.reads,['package.json','src/app.js']);
 assert.match(JSON.parse(h.calls.at(-1).options.body).messages.map(m=>m.content).join('\n'),/IMPLEMENTATION_END/);
});

test('source budget omits whole files explicitly and disabling workspace avoids automatic reads',async()=>{
 const fixture=sourceWorkspace({'large.js':'x'.repeat(20000)+'FILE_END'});
 const h=host({contextMaxKb:8},()=>new Response(JSON.stringify({choices:[{message:{content:'["large.js"]'}}]})),fixture.workspace);
 await h.provider._chat({messages:[{role:'user',content:'read large.js'}],agentic:true,includeWorkspace:true,stream:false});
 const info=h.posts.find(p=>p.type==='contextInfo');
 assert.equal(info.files,0);assert.match(info.context,/large.js: not included/);assert.doesNotMatch(info.context,/xxxx/);
 fixture.reads.length=0;h.calls.length=0;
 await h.provider._chat({messages:[{role:'user',content:'read large.js'}],agentic:true,includeWorkspace:false,stream:false});
 assert.equal(fixture.reads.length,0);assert.equal(h.calls.length,1);
});

test('Copilot reads every part of long source and keeps the final request below the transport limit',async()=>{
 const full='// sample source\n'.repeat(800)+'const END_MARKER="READ_THROUGH_EOF";';
 const h=host({provider:'copilot',think:true},(url,options)=>{
  const text=JSON.parse(options.body).messages[0].content;
  assert.ok(text.length<=7000,'every browser-bound request must fit');
  return new Response(JSON.stringify({choices:[{message:{content:text.includes('READ_THROUGH_EOF') ? 'END_MARKER is READ_THROUGH_EOF.' : 'Continue reading the source.'}}]}));
 });
 await h.provider._chat({messages:[{role:'system',content:full},{role:'user',content:'What is END_MARKER?'}],stream:false,think:true});
 const parts=h.calls.map(c=>JSON.parse(c.options.body).messages[0].content).filter(c=>c.startsWith('Read this consecutive part')).map(c=>c.split(/Part \d+\/\d+:\n/)[1]);
 assert.ok(parts.join('').includes(full),'all characters reach a reading pass in order');
 assert.equal(parts.join('').indexOf(full),parts.join('').lastIndexOf(full),'Think reuses the source reading notes');
 const final=JSON.parse(h.calls.at(-1).options.body).messages[0].content;
 assert.match(final,/What is END_MARKER/);assert.match(final,/READ_THROUGH_EOF/);
 assert.match(h.posts.find(p=>p.type==='done').full,/READ_THROUGH_EOF/);
});

test('Stop cancels a long Copilot reading pass before the remaining parts are sent',async()=>{
 let h;
 h=host({provider:'copilot'},()=>{
  h.provider._controller.abort();
  return new Response(JSON.stringify({choices:[{message:{content:'Partial reading notes.'}}]}));
 });
 await h.provider._chat({messages:[{role:'user',content:'Read this: '+'x'.repeat(14000)}],stream:false});
 assert.equal(h.calls.length,1);
 assert.equal(h.posts.find(p=>p.type==='done').aborted,true);
});

test('strict endpoints: every system message is merged into one leading system',async()=>{
 // vLLM/Qwen-class servers reject any system message past index 0. REACH's
 // pipeline stacks several (agent rules, context, compacted memory), so the
 // outbound payload must collapse them into a single first message.
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'OK'}}]})));
 await h.provider._chat({
  messages:[
   {role:'system',content:'OLD CTX'},
   {role:'user',content:'first question'},
   {role:'assistant',content:'first answer'},
   {role:'system',content:'MID CONVERSATION NOTE'},
   {role:'user',content:'second question'},
  ],
  model:'my/free-model',stream:false,agentic:true,
 });
 const sent=JSON.parse(h.calls[0].options.body).messages;
 assert.deepEqual(sent.map(m=>m.role),['system','user','assistant','user']);
 assert.equal(sent.filter(m=>m.role==='system').length,1);
 assert.match(sent[0].content,/OLD CTX/);
 assert.match(sent[0].content,/MID CONVERSATION NOTE/);
 assert.match(sent[0].content,/agentic coding assistant/,'the agent rules ride in the same message');
 // Think merges its own system with any the conversation carried.
 await h.provider._think([{role:'system',content:'CTX'},{role:'user',content:'q'}],false,'my/free-model');
 const thinkSent=JSON.parse(h.calls.at(-1).options.body).messages;
 assert.deepEqual(thinkSent.map(m=>m.role),['system','user']);
 assert.match(thinkSent[0].content,/private reasoning engine/);
 assert.match(thinkSent[0].content,/CTX/);
});

function editableWorkspace(initial, dirty=false) {
 let text=initial,disk=dirty?'UNSAVED BASE ON DISK':initial,writes=0,saves=0;
 const doc={isDirty:dirty,getText:()=>text,positionAt:i=>i,save:async()=>{saves++;disk=text;return true;}};
 return {doc,get text(){return text;},get disk(){return disk;},get writes(){return writes;},get saves(){return saves;},
 workspace:{workspaceFolders:[{uri:{fsPath:'/workspace'}}],openTextDocument:async()=>doc,
 applyEdit:async edit=>{writes++;for(const op of edit.ops)text=text.slice(0,op.range.start)+op.text+text.slice(op.range.end);return true;}},
 api:{window:{showTextDocument:async()=>{}},Range:class{constructor(start,end){this.start=start;this.end=end;}},
 WorkspaceEdit:class{constructor(){this.ops=[];}replace(uri,range,text){this.ops.push({uri,range,text});}}}};
}
test('Apply uses the current unsaved document and preserves other edits without saving them',async()=>{
 const f=editableWorkspace('USER CHANGE\r\nconst old = 1;\r\nend\r\n',true);
 const h=host({},()=>{},f.workspace,f.api);
 await h.receive({type:'applyEdit',uid:'edit',path:'source.js',search:'const old = 1;\nend',replace:'const updated = 2;\nend'});
 assert.equal(f.text,'USER CHANGE\r\nconst updated = 2;\r\nend\r\n');
 assert.equal(f.disk,'UNSAVED BASE ON DISK');assert.equal(f.saves,0);
 assert.equal(h.posts.at(-1).ok,true);assert.equal(h.posts.at(-1).unsaved,true);
});
test('stale proposals never write and Refresh returns a validated proposal without applying it',async()=>{
 const f=editableWorkspace('const count = 3;\n// preserve this change');
 const proposal={search:'const count = 3;',replace:'const count = 4;'};
 const h=host({},(url,options)=>{
  assert.match(JSON.parse(options.body).messages[0].content,/CURRENT SOURCE.*\nconst count = 3;/);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(proposal)}}]}));
 },f.workspace,f.api);
 await h.receive({type:'applyEdit',uid:'stale',path:'source.js',search:'const count = 1;',replace:'const count = 4;'});
 assert.equal(f.writes,0);assert.match(h.posts.at(-1).error,/no longer matches/);
 await h.receive({type:'refreshEdit',uid:'stale',path:'source.js',search:'const count = 1;',replace:'const count = 4;'});
 const refreshed=h.posts.at(-1);assert.equal(refreshed.type,'editRefreshed');assert.ok(refreshed.edit);
 assert.equal(f.writes,0,'refresh must not apply changes');
 await h.receive({type:'applyEdit',uid:'fresh',...refreshed.edit});
 assert.equal(f.text,'const count = 4;\n// preserve this change');assert.equal(f.saves,1);
});
test('Refresh rejects another hallucinated anchor',async()=>{
 const f=editableWorkspace('actual source');
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'{"search":"invented source","replace":"change"}'}}]})),f.workspace,f.api);
 await h.receive({type:'refreshEdit',uid:'x',path:'source.js',search:'old source',replace:'new source'});
 assert.match(h.posts.at(-1).error,/no longer matches/);assert.equal(f.writes,0);assert.equal(h.posts.at(-1).edit,undefined);
});

test('all providers compress before the 400000-character relay cap, including Think',async()=>{
 const latest='TOOL RESULTS\n'+ 'RECENT_SOURCE\n'.repeat(4500)+'EXACT_CURRENT_END';
 const messages=[{role:'system',content:'Keep user edits.'},
  ...Array.from({length:10},(_,i)=>({role:'assistant',content:'Earlier step '+i+'\n'+'x'.repeat(48000)})),
  {role:'user',content:'Finish the current task.'},{role:'user',content:latest}];
 const h=host({think:true},(url,options)=>{
  const body=JSON.parse(options.body);
  assert.ok(body.messages.reduce((n,m)=>n+(typeof m.content==='string'?m.content.length:0),0)<240000);
  return new Response(JSON.stringify({choices:[{message:{content:'Task memory: preserve constraints and pending work.'}}]}));
 });
 await h.provider._chat({messages,model:'my/free-model',stream:false,think:true,agentic:true});
 assert.ok(h.posts.some(p=>p.type==='contextCompacted'));
 const final=JSON.parse(h.calls.at(-1).options.body);
 assert.ok(final.messages.some(m=>m.content===latest));
 // After compaction the memory rides inside the ONE leading system message
 // (strict endpoints reject any system past index 0).
 assert.ok(final.messages.some(m=>String(m.content).includes('REACH conversation memory')));
 assert.equal(final.messages.filter(m=>m.role==='system').length,1,'exactly one system message');
 assert.equal(final.messages[0].role,'system','and it comes first');
 assert.equal(final.agentic,undefined);assert.equal(messages.length,13);
});
test('context compression can never re-stack system messages (strict endpoints)',async()=>{
 // Compression prepends its memory system while keeping the existing one, so
 // a payload rebuilt by _encodePayload must STILL carry exactly one leading
 // system or vLLM/Qwen endpoints answer 400 "System message must be at the
 // beginning." Regression: the merge used to happen only before compaction.
 const messages=[{role:'system',content:'Keep user edits.'},
  ...Array.from({length:9},(_,i)=>({role:'assistant',content:'Step '+i+'\n'+'x'.repeat(32000)})),
  {role:'user',content:'Finish the current task.'}];
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'memory note'}}]})));
 const wire=JSON.parse(await h.provider._encodePayload({model:'my/free-model',messages,stream:false}));
 assert.ok(wire.messages.some(m=>String(m.content).includes('REACH conversation memory')),'compaction ran');
 assert.equal(wire.messages.filter(m=>m.role==='system').length,1,'exactly one system message');
 assert.equal(wire.messages[0].role,'system','and it comes first');
 assert.match(wire.messages[0].content,/Keep user edits/,'the retained system content is not lost');
});
test('output budgets are user settings: unset means the parameter is omitted',async()=>{
 // No hardcoded budgets: 0 (the default) omits max_tokens entirely so the
 // provider's own maximum applies — a fixed budget starved reasoning models
 // into empty replies. Positive values are the user's, sent verbatim.
 const plain=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'FREE OK'}}]})));
 await plain.provider._chat({messages:[{role:'user',content:'hello'}],model:'my/free-model',stream:false});
 assert.equal(JSON.parse(plain.calls[0].options.body).max_tokens,undefined,'no answer budget by default');
 await plain.provider._think('q',false,'my/free-model');
 assert.equal(JSON.parse(plain.calls.at(-1).options.body).max_tokens,undefined,'no think budget by default');
 const capped=host({maxTokens:4200,thinkMaxTokens:900},()=>new Response(JSON.stringify({choices:[{message:{content:'OK'}}]})));
 await capped.provider._chat({messages:[{role:'user',content:'hello'}],model:'my/free-model',stream:false});
 assert.equal(JSON.parse(capped.calls[0].options.body).max_tokens,4200);
 await capped.provider._think('q',false,'my/free-model');
 assert.equal(JSON.parse(capped.calls.at(-1).options.body).max_tokens,900);
});
test('compaction follows the user budget and omits the field when unset',async()=>{
 const messages=[{role:'user',content:'go'},
  ...Array.from({length:8},(_,i)=>({role:'assistant',content:'Earlier step '+i+'\n'+'x'.repeat(34000)})),
  {role:'user',content:'Finish the current task.'}];
 const seen=[];
 const h=host({},(url,options)=>{ seen.push(JSON.parse(options.body).max_tokens); return new Response(JSON.stringify({choices:[{message:{content:'memory note'}}]})); });
 const result=await h.provider._compactContext(messages,'my/free-model');
 assert.equal(result.changed,true);
 assert.ok(result.messages.some(m=>String(m.content).includes('REACH conversation memory')));
 assert.ok(seen.length&&seen.every(b=>b===undefined),'no summary budget is sent unless the user sets one');
 const h2=host({summaryMaxTokens:5000},()=>new Response(JSON.stringify({choices:[{message:{content:'memory note'}}]})));
 await h2.provider._compactContext(messages,'my/free-model');
 assert.equal(JSON.parse(h2.calls[0].options.body).max_tokens,5000);
});
test('compression skips the reasoning trace unless the user opts in',async()=>{
 // Summarizing is extraction, not deliberation: dense segments sent a
 // reasoning endpoint into minutes of invisible thinking (2026-09-12), so the
 // default asks such endpoints to skip it — and streams the summary so the
 // activity row shows it growing. The user can opt back in.
 const messages=[{role:'user',content:'go'},
  ...Array.from({length:8},(_,i)=>({role:'assistant',content:'Earlier step '+i+'\n'+'x'.repeat(34000)})),
  {role:'user',content:'Finish the current task.'}];
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'memory note'}}]})));
 await h.provider._compactContext(messages,'my/free-model');
 const body=JSON.parse(h.calls[0].options.body);
 assert.deepEqual(body.chat_template_kwargs,{enable_thinking:false},'thinking is skipped by default');
 assert.equal(body.stream,true,'the summary streams so the row can show progress');
 const opted=host({compressThink:true},()=>new Response(JSON.stringify({choices:[{message:{content:'memory note'}}]})));
 await opted.provider._compactContext(messages,'my/free-model');
 assert.equal(JSON.parse(opted.calls[0].options.body).chat_template_kwargs,undefined,'the user can put the deliberation back');
});
test('an endpoint that rejects chat_template_kwargs is retried with the plain body and the summary streams live',async()=>{
 const messages=[{role:'user',content:'go'},
  ...Array.from({length:8},(_,i)=>({role:'assistant',content:'Earlier step '+i+'\n'+'x'.repeat(34000)})),
  {role:'user',content:'Finish the current task.'}];
 let compactions=0,withThink=0,plain=0,firstBody=null,secondBody=null;
 const h=host({},(url,options)=>{
  const body=JSON.parse(options.body);
  if(String(body.messages[0].content).startsWith('Compress this conversation segment')){
   compactions++;
   if(compactions===1){firstBody=body;return new Response('{"error":{"message":"Unrecognized request argument: chat_template_kwargs"}}',{status:400});}
   if(compactions===2)secondBody=body;
   if(body.chat_template_kwargs)withThink++;else plain++;
   return new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'deliberating about the segment'}}]})+'\n\n'
    +'data: '+JSON.stringify({choices:[{delta:{content:'- goal: finish the task'}}]})+'\n\n'
    +'data: '+JSON.stringify({choices:[{delta:{content:'; pending: verify the fix'}}]})+'\n\n'
    +'data: [DONE]\n\n');
  }
  return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}));
 });
 const result=await h.provider._compactContext(messages,'my/free-model');
 assert.deepEqual(firstBody.chat_template_kwargs,{enable_thinking:false},'the first attempt asks to skip thinking');
 assert.equal(secondBody.chat_template_kwargs,undefined,'the rejected field is dropped, not the request');
 assert.equal(withThink,0,'a rejected field is not repeated for later segments');
 assert.ok(plain>=2&&compactions===plain+1,'one wasteful 400 for the whole run, then plain bodies');
 assert.ok(result.messages.some(m=>String(m.content).includes('goal: finish the task')&&String(m.content).includes('pending: verify the fix')),'the streamed deltas form the memory');
 assert.ok(!result.messages.some(m=>String(m.content).includes('deliberating about the segment')),'the thinking trace never becomes memory');
 assert.ok(h.posts.some(p=>p.type==='agentStep'&&p.status==='running'&&/Thinking through the segment/.test(String(p.note||''))),'the row shows live thinking progress');
 assert.ok(h.posts.some(p=>p.type==='agentStep'&&p.status==='running'&&/Writing the summary/.test(String(p.note||''))),'and live writing progress');
});
test('a lower advertised character budget triggers one compressed retry',async()=>{
 let answers=0;
 const h=host({},(url,options)=>{
  const body=JSON.parse(options.body);const content=body.messages[0].content;
  if(content.startsWith('Compress this conversation segment')){assert.ok(content.length<50000);return new Response(JSON.stringify({choices:[{message:{content:'Keep working on the requested fix.'}}]}));}
  answers++;
  if(answers===1)return new Response('{"error":{"message":"input too large (max 50000 chars)"}}',{status:400});
  assert.ok(body.messages.reduce((n,m)=>n+m.content.length,0)<50000);
  return new Response(JSON.stringify({choices:[{message:{content:'RETRY_OK'}}]}));
 });
 await h.provider._chat({messages:[{role:'assistant',content:'x'.repeat(65000)},{role:'user',content:'Continue.'}],stream:false});
 assert.equal(answers,2);assert.equal(h.posts.find(p=>p.type==='done').full,'RETRY_OK');
});

test('REACH CodeGPT discovers only economy models and preserves model, history and stream', async()=>{
 const model='codegpt-eco-deepseek-v4.1-flash';
 const h=host({provider:'codegpt',model},url=>{
  if(url.endsWith('/models')) {
   const data=['copilot-chat','chatgpt-chat','codegpt-eco',model].map(id=>({id}));
   return new Response(JSON.stringify({data}));
  }
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:'ECONOMY OK'}}]})+'\n\ndata: [DONE]\n\n');
 });
 const catalog=await h.provider._discoverModels(h.readConfig());
 assert.deepEqual(Array.from(catalog.routes.keys()),['codegpt-eco',model]);
 const messages=[{role:'user',content:'My name is Mira.'},{role:'assistant',content:'Hi Mira'},{role:'user',content:'My name?'}];
 await h.provider._chat({messages,model,stream:true});
 const call=h.calls.at(-1), body=JSON.parse(call.options.body);
 assert.equal(call.url,'http://127.0.0.1:21302/v1/chat/completions');
 assert.equal(call.options.headers.Authorization,undefined);
 assert.equal(body.model,model);
 assert.equal(body.stream,true);
 for(const message of messages) assert.ok(body.messages.some(m=>m.role===message.role && m.content===message.content));
 assert.equal(h.posts.filter(p=>p.type==='delta').map(p=>p.text).join(''),'ECONOMY OK');
 assert.ok(h.posts.some(p=>p.type==='done'));
});
test('a transient gateway 502 on the free endpoint is retried until it succeeds',async()=>{
 let attempts=0;
 const h=host({},()=>{
  attempts++;
  if(attempts<3)return new Response('Bad Gateway',{status:502});
  return new Response(JSON.stringify({choices:[{message:{content:'RECOVERED OK'}}]}));
 });
 await h.provider._chat({messages:[{role:'user',content:'hello'}],model:'my/free-model',stream:false});
 assert.equal(attempts,3,'502 must be retried');
 assert.equal(h.calls.length,3);
 assert.equal(h.calls[0].url,'https://free.example/v1/chat/completions');
 assert.equal(h.posts.find(p=>p.type==='done').full,'RECOVERED OK');
});

test('a non-transient status on the free endpoint fails immediately without retrying',async()=>{
 let attempts=0;
 const h=host({},()=>{attempts++;return new Response('nope',{status:401});});
 await h.provider._chat({messages:[{role:'user',content:'hello'}],model:'my/free-model',stream:false});
 assert.equal(attempts,1,'401 must not be retried');
 assert.match(h.posts.find(p=>p.type==='error').message,/401/);
});
test('Free endpoints groups the CodeGPT economy models and routes them to the local bridge',async()=>{
 // A Free-endpoints refresh probes BOTH the configured endpoint and the local
 // tray bridge. Economy ids come only from the bridge; they are grouped for
 // the picker and, at request time, routed to the bridge even though the
 // selected provider is Free endpoints (a remote endpoint cannot serve them —
 // its own 127.0.0.1:21302 is not this machine, which is the 503 this fixes).
 const h=host({},url=>new Response(JSON.stringify(url.endsWith('/models')
   ? (url.startsWith('http://127.0.0.1:21302')
      ? {data:[{id:'codegpt-eco'},{id:'codegpt-eco-ox-alpha'},{id:'copilot-chat'}]}
      : {data:[{id:'my/free-model'}]})
   : {choices:[{message:{content:'OK'}}]})));
 await h.provider._fetchModels();
 const models=h.posts.find(p=>p.type==='models');
 assert.deepEqual(Array.from(models.models),['my/free-model','codegpt-eco','codegpt-eco-ox-alpha']);
 // copilot-chat belongs to its own provider and must not leak into this list.
 assert.equal(models.models.includes('copilot-chat'),false);
 // Cross-realm arrays: compare structurally via JSON, not deepEqual.
 const groups=JSON.parse(JSON.stringify(models.groups.map(g=>({label:g.label,models:Array.from(g.models)}))));
 assert.deepEqual(groups,[
   {label:'Free models',models:['my/free-model']},
   {label:'CodeGPT economy',models:['codegpt-eco','codegpt-eco-ox-alpha']},
 ]);
 // An economy model selected under Free endpoints goes to the BRIDGE...
 await h.provider._chat({messages:[{role:'user',content:'hi'}],model:'codegpt-eco-ox-alpha',stream:false});
 const econ=h.calls.at(-1);
 assert.equal(econ.url,'http://127.0.0.1:21302/v1/chat/completions');
 // ...without the free endpoint's access key.
 assert.equal(econ.options.headers.Authorization,undefined,'the bridge must never receive the free endpoint key');
 // A free alias still goes to the configured endpoint, WITH its key.
 await h.provider._chat({messages:[{role:'user',content:'hi'}],model:'my/free-model',stream:false});
 const free=h.calls.at(-1);
 assert.equal(free.url,'https://free.example/v1/chat/completions');
 assert.equal(free.options.headers.Authorization,'Bearer free-only-key');
});

test('a bare economy alias from the endpoint is routed to the bridge with the bridge id',async()=>{
 // reachd publishes the economy models under their bare ids while the bridge
 // validates `codegpt-eco-<id>`. Selecting the bare alias must go DIRECT to
 // the bridge — a relay hop swallowed the tray's run error and surfaced it as
 // an empty stream (2026-09-11) — and the wire body must carry the bridge id.
 const h=host({},url=>new Response(JSON.stringify(url.endsWith('/models')
   ? (url.startsWith('http://127.0.0.1:21302')
      ? {data:[{id:'codegpt-eco-deepseek-v4.1-flash'},{id:'copilot-chat'}]}
      : {data:[{id:'my/free-model'},{id:'deepseek-v4.1-flash'}]})
   : {choices:[{message:{content:'OK'}}]})));
 await h.provider._fetchModels();
 await h.provider._chat({messages:[{role:'user',content:'hi'}],model:'deepseek-v4.1-flash',stream:false});
 const econ=h.calls.at(-1);
 assert.equal(econ.url,'http://127.0.0.1:21302/v1/chat/completions');
 assert.equal(econ.options.headers.Authorization,undefined,'the bridge must never receive the free endpoint key');
 assert.equal(JSON.parse(econ.options.body).model,'codegpt-eco-deepseek-v4.1-flash');
 // A free alias still goes to the configured endpoint with its own id.
 await h.provider._chat({messages:[{role:'user',content:'hi'}],model:'my/free-model',stream:false});
 const free=h.calls.at(-1);
 assert.equal(free.url,'https://free.example/v1/chat/completions');
 assert.equal(JSON.parse(free.options.body).model,'my/free-model');
});

test('a tray that is not running drops the economy group without failing Free endpoints',async()=>{
 // The bridge leg rejects; the free aliases must still load, with a note.
 const h=host({},url=>url.startsWith('http://127.0.0.1:21302')
   ? Promise.reject(new Error('ECONNREFUSED'))
   : new Response(JSON.stringify(url.endsWith('/models')
      ? {data:[{id:'my/free-model'}]} : {choices:[{message:{content:'OK'}}]})));
 await h.provider._fetchModels();
 const models=h.posts.find(p=>p.type==='models');
 assert.deepEqual(Array.from(models.models),['my/free-model']);
 assert.equal(models.groups.length,1);
 assert.equal(models.groups[0].label,'Free models');
 // The bridge failure is reported as an economy-group note, not as a generic
 // endpoint error, so the cause is obvious from the chat.
 const msgs=h.posts.filter(p=>p.type==='error').map(p=>p.message).join(' | ');
 assert.match(msgs,/CodeGPT economy models/);
});

test('reasoning-only Qwen completion retries once with the same context, endpoint, model, key and token budget', async()=>{
 const endpoint='https://nexus.example/v1';
 const h=host({additionalEndpoints:[endpoint],selectedEndpoint:endpoint,endpointAccessKeys:{[endpoint]:'nexus-key'},maxTokens:100000},(_url,options)=>{
  const body=JSON.parse(options.body);
  return body.chat_template_kwargs
   ? new Response(JSON.stringify({choices:[{message:{content:'Recovered answer'},finish_reason:'stop'}]}))
   : new Response('data: {"choices":[{"delta":{"reasoning":"private reasoning with ```tool blocks"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
 });
 await h.provider._chat({model:'Qwen/Qwen3.8-27B-FP8',messages:[{role:'user',content:'Continue the long task.'}],stream:true});
 assert.equal(h.calls.length,2);
 const first=JSON.parse(h.calls[0].options.body),second=JSON.parse(h.calls[1].options.body);
 assert.deepEqual(second,{...first,stream:false,chat_template_kwargs:{enable_thinking:false}});
 for(const c of h.calls){assert.equal(c.url,endpoint+'/chat/completions');assert.equal(c.options.headers.Authorization,'Bearer nexus-key');}
 assert.equal(h.posts.filter(p=>p.type==='delta').length,0);
 assert.equal(h.posts.find(p=>p.type==='done').full,'Recovered answer');
 assert.ok(h.posts.some(p=>p.note?.includes('Model is reasoning')));
 assert.equal(h.posts.some(p=>p.type==='error'),false);
});

test('an empty stream retries as JSON and a provider ignoring stream:true is accepted immediately',async()=>{
 for(const ignoreStream of [true,false]){
  const h=host({},(_url,options)=>new Response(ignoreStream||!JSON.parse(options.body).stream
   ? JSON.stringify({choices:[{message:{content:'The answer'},finish_reason:'stop'}]})
   : 'data: [DONE]\n\n'));
  await h.provider._chat({model:'custom/model',messages:[{role:'user',content:'hi'}],stream:true});
  assert.equal(h.calls.length,ignoreStream?1:2);
  assert.equal(h.posts.some(p=>p.type==='error'),false);
  assert.equal(ignoreStream?h.posts.find(p=>p.type==='delta').text:h.posts.find(p=>p.type==='done').full,'The answer');
 }
});

test('two reasoning-only replies stop with an accurate diagnostic, not a CodeGPT connection error or tool execution',async()=>{
 const h=host({},(_url,options)=>new Response(JSON.parse(options.body).stream
  ? 'data: {"choices":[{"delta":{"reasoning":"private trace"},"finish_reason":"length"}]}\n\n'
  : JSON.stringify({choices:[{message:{reasoning:'private trace'},finish_reason:'length'}]})));
 await h.provider._chat({model:'Qwen/test',messages:[{role:'user',content:'hi'}],stream:true});
 assert.equal(h.calls.length,2);
 assert.equal(h.posts.some(p=>p.type==='delta'),false);
 const error=h.posts.find(p=>p.type==='error').message;
 assert.match(error,/Qwen\/test.*reasoning.*no final answer.*output token limit/);
 assert.doesNotMatch(error,/CodeGPT|tray/);
});

test('provider errors, content filtering and native tool calls are never retried as empty replies',async()=>{
 for(const data of [{error:{message:'Provider refused request'}},{choices:[{delta:{},finish_reason:'content_filter'}]},
  {choices:[{delta:{tool_calls:[{index:0,function:{name:'read',arguments:'{}'}}]},finish_reason:'tool_calls'}]}]){
  const h=host({},()=>new Response('data: '+JSON.stringify(data)+'\n\n'));
  await h.provider._chat({model:'Qwen/test',messages:[{role:'user',content:'hi'}],stream:true});
  assert.equal(h.calls.length,1);
  assert.ok(h.posts.some(p=>p.type==='error'));
 }
});

test('Stop after a reasoning-only reply prevents the automatic retry',async()=>{
 let h;
 h=host({},()=>new Response(new ReadableStream({start(c){
  c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n'));
  h.provider._controller.abort();c.close();
 }})));
 await h.provider._chat({model:'Qwen/test',messages:[{role:'user',content:'hi'}],stream:true});
 assert.equal(h.calls.length,1);
 assert.ok(h.posts.some(p=>p.type==='done'&&p.aborted));
});

test('Agent requests always include explicit run control, even with a custom prompt, while chat stays plain',async()=>{
 for(const agentic of [true,false]){
  const h=host({agentTemplate:'My custom instructions.'},()=>new Response(JSON.stringify({choices:[{message:{content:'Hello'}}]})));
  await h.provider._chat({model:'my/free-model',messages:[{role:'user',content:'hello'}],agentic,runTodos:[],stream:false});
  const text=JSON.parse(h.calls[0].options.body).messages.map(m=>m.content).join('\n');
  assert.equal(text.includes('AGENT RUN CONTROL'),agentic);
  if(agentic)assert.ok(text.includes('My custom instructions.'));
 }
});

test('the host restores the supplied conversation checklist before a resumed tool read',async()=>{
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'OK'}}]})),{workspaceFolders:[{uri:{fsPath:'/workspace'}}]});
 await h.provider._chat({messages:[{role:'user',content:'continue'}],stream:false,runTodos:[{text:'Verify result',status:'in_progress'}]});
 await h.receive({type:'toolReq',uid:'restored-plan',action:'todo_read'});
 assert.match(h.posts.find(p=>p.type==='toolResult'&&p.uid==='restored-plan').result,/Verify result/);
 await h.provider._chat({messages:[{role:'user',content:'new task'}],stream:false,runTodos:[]});
 await h.receive({type:'toolReq',uid:'new-plan',action:'todo_read'});
 assert.doesNotMatch(h.posts.find(p=>p.type==='toolResult'&&p.uid==='new-plan').result,/Verify result/);
});

function socketFailure(code = 'UND_ERR_HEADERS_TIMEOUT') {
 return new TypeError('fetch failed', {cause:Object.assign(new Error('private token must not appear'),{code})});
}

test('a headers timeout retries the inference request without changing context or model', async()=>{
 let count=0;
 const h=host({},()=>{if(++count===1)throw socketFailure();return new Response(JSON.stringify({choices:[{message:{content:'RECOVERED'}}]}));});
 await h.provider._chat({messages:[{role:'user',content:'continue current work'}],stream:false});
 assert.equal(count,2);
 assert.equal(h.calls[0].options.body,h.calls[1].options.body);
 assert.equal(h.calls[0].url,h.calls[1].url);
 assert.ok(h.posts.some(p=>p.type==='agentStep'&&p.status==='running'&&/UND_ERR_HEADERS_TIMEOUT.*Retrying/.test(p.note)));
 assert.equal(h.posts.find(p=>p.type==='done').full,'RECOVERED');
 assert.ok(!h.posts.some(p=>p.type==='error'));
});

test('persistent transport failure is bounded and preserves a useful redacted cause', async()=>{
 const h=host({},()=>{throw socketFailure('ECONNRESET');});
 await h.provider._chat({messages:[{role:'user',content:'hello'}],stream:false});
 assert.equal(h.calls.length,3);
 const error=h.posts.find(p=>p.type==='error').message;
 assert.match(error,/ECONNRESET/);assert.match(error,/3 request attempt/);assert.match(error,/conversation is preserved/);
 assert.ok(!error.includes('private token'));
});

test('Stop interrupts the transport backoff before another request starts', async()=>{
 const h=host({},()=>{setTimeout(()=>h.provider._controller.abort(),10);throw socketFailure();});
 const began=Date.now();
 await h.provider._chat({messages:[{role:'user',content:'hello'}],stream:false});
 assert.equal(h.calls.length,1);assert.ok(Date.now()-began<450);
 assert.equal(h.posts.find(p=>p.type==='done').aborted,true);
 assert.ok(!h.posts.some(p=>p.type==='error'));
});

test('certificate failures are diagnosed but never blindly retried', async()=>{
 const h=host({},()=>{throw socketFailure('CERT_HAS_EXPIRED');});
 await h.provider._chat({messages:[{role:'user',content:'hello'}],stream:false});
 assert.equal(h.calls.length,1);assert.match(h.posts.find(p=>p.type==='error').message,/CERT_HAS_EXPIRED/);
});

function brokenStream(text) {
 let sent=false;
 return new Response(new ReadableStream({pull(controller){
  if(text&&!sent){sent=true;controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n'));}
  else controller.error(socketFailure('UND_ERR_SOCKET'));
 }}));
}

test('a broken stream before any answer recovers once', async()=>{
 let count=0;
 const h=host({},()=>++count===1?brokenStream(''):new Response('data: {"choices":[{"delta":{"content":"Recovered stream"}}]}\n\n'));
 await h.provider._chat({messages:[{role:'user',content:'hello'}],stream:true});
 assert.equal(h.calls.length,2);assert.equal(h.posts.find(p=>p.type==='delta').text,'Recovered stream');
 assert.ok(!h.posts.some(p=>p.type==='error'));
});

test('a stream that fails after a partial tool block is never automatically replayed', async()=>{
 const h=host({},()=>brokenStream('```tool\n{"action":"run","command":"echo example"}\n```'));
 await h.provider._chat({messages:[{role:'user',content:'hello'}],stream:true});
 assert.equal(h.calls.length,1);
 assert.match(h.posts.find(p=>p.type==='error').message,/partial answer was not executed/);
 assert.match(h.posts.find(p=>p.type==='error').message,/UND_ERR_SOCKET/);
});

test('a real socket close before headers recovers through the host request path', async()=>{
 const http=require('node:http');let hits=0;
 const server=http.createServer((req,res)=>{if(++hits===1){req.socket.destroy();return;}res.end(JSON.stringify({choices:[{message:{content:'SOCKET RECOVERED'}}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const h=host({},(_,options)=>fetch('http://127.0.0.1:'+server.address().port,options));
  await h.provider._chat({messages:[{role:'user',content:'test local disconnect'}],stream:false});
  assert.equal(hits,2);assert.equal(h.posts.find(p=>p.type==='done').full,'SOCKET RECOVERED');
  assert.ok(h.posts.some(p=>/UND_ERR_SOCKET/.test(p.note||'')));
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

const actionResponse=(actions=[{name:'read',arguments:'{"path":"README.md"}'}],message='Reading files.')=>JSON.stringify({status:'actions',message,actions,options:[]});
test('structured recovery delivers validated tool data without streaming JSON or changing providers',async()=>{
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:actionResponse()}}]})));
 await h.provider._chat({messages:[{role:'user',content:'Original request and completed tool results'}],agentic:true,structuredActions:true,stream:true});
 const payload=JSON.parse(h.calls[0].options.body);
 assert.equal(payload.response_format.type,'json_schema');assert.equal(payload.stream,false);
 assert.equal(payload.messages[0].role,'system');assert.equal(payload.messages.filter(m=>m.role==='system').length,1);
 assert.match(payload.messages[0].content,/EXECUTABLE ACTION RESPONSE/);
 assert.ok(payload.messages.some(m=>m.content==='Original request and completed tool results'));
 const done=h.posts.find(p=>p.type==='done');assert.deepEqual(done.agentAction.tools,[{path:'README.md',action:'read'}]);
 assert.equal(done.full,'Reading files.');assert.ok(!h.posts.some(p=>p.type==='delta'));
});

test('schema rejection negotiates JSON mode while preserving action validation',async()=>{
 let count=0;
 const h=host({},()=>++count===1?new Response('response_format json_schema is unsupported',{status:400}):new Response(JSON.stringify({choices:[{message:{content:actionResponse()}}]})));
 await h.provider._chat({messages:[{role:'user',content:'Continue'}],agentic:true,structuredActions:true,stream:true});
 assert.equal(h.calls.length,2);assert.equal(JSON.parse(h.calls[1].options.body).response_format.type,'json_object');
 assert.equal(h.posts.find(p=>p.type==='done').agentAction.tools[0].action,'read');
});

test('an endpoint ignoring action format is repaired once and never releases unvalidated output',async()=>{
 let count=0;
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:++count===1?'I will continue.':actionResponse()}}]})));
 await h.provider._chat({messages:[{role:'user',content:'Continue'}],agentic:true,structuredActions:true,stream:true});
 assert.equal(h.calls.length,2);assert.equal(h.posts.find(p=>p.type==='done').agentAction.tools[0].action,'read');
 assert.ok(!h.posts.some(p=>p.type==='delta'));
 const invalid=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'Still continuing.'}}]})));
 await invalid.provider._chat({messages:[{role:'user',content:'Continue'}],agentic:true,structuredActions:true,stream:true});
 assert.equal(invalid.calls.length,2);assert.match(invalid.posts.find(p=>p.type==='error').message,/No action was executed/);
 assert.ok(!invalid.posts.some(p=>p.agentAction));
});

test('Answer now and disabled Agent mode bypass action output even with a stale recovery flag',async()=>{
 for(const override of [{quickAnswer:true,agentic:true},{agentic:false}]){
  const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:'Normal answer'}}]})));
  await h.provider._chat({messages:[{role:'user',content:'Answer'}],structuredActions:true,stream:false,...override});
  assert.equal(JSON.parse(h.calls[0].options.body).response_format,undefined);
  assert.equal(h.posts.find(p=>p.type==='done').full,'Normal answer');
 }
});

test('valid actions with surplus options execute without a format retry',async()=>{
 const content=JSON.parse(actionResponse());content.options=['Yes','No'];
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]})));
 await h.provider._chat({messages:[{role:'user',content:'Continue'}],agentic:true,structuredActions:true,stream:true});
 assert.equal(h.calls.length,1);assert.ok(!h.posts.some(p=>p.type==='error'));
 const action=h.posts.find(p=>p.agentAction).agentAction;
 assert.equal(action.tools[0].action,'read');assert.equal(action.confirm,null);
});

test('a format repair reuses and checkpoints the compressed context instead of summarizing it again',async()=>{
 const {compactMessages}=require('../vscode/context');
 let answers=0,summaries=0;
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:++answers===1?'invalid JSON':actionResponse()}}]})));
 h.provider._compactContext=(messages)=>compactMessages(messages,async()=>{summaries++;return 'Retained goal: review browser files. Completed reads preserved. Remaining work: inspect implementation.';},
  messages.some(m=>String(m.content).includes('EXECUTABLE ACTION RESPONSE'))?{trigger:45000,target:20000}:{});
 const original=[{role:'user',content:'Large historical source: '+ 'ARCHIVED_SOURCE '.repeat(4000)},
  {role:'assistant',content:'Completed earlier reads.'},{role:'user',content:'Continue reviewing the browser implementation.'}];
 await h.provider._chat({messages:original,agentic:true,structuredActions:true,stream:true});
 assert.equal(h.calls.length,2);assert.equal(summaries,1,'recovery must reuse the memory from the first encoding');
 const first=JSON.parse(h.calls[0].options.body),repair=JSON.parse(h.calls[1].options.body);
 assert.ok(JSON.stringify(first.messages).includes('Retained goal:'));
 assert.ok(JSON.stringify(repair.messages).includes('Retained goal:'));
 assert.ok(!JSON.stringify(repair.messages).includes('ARCHIVED_SOURCE'));
 assert.ok(JSON.stringify(repair.messages).includes('Return valid action JSON'));
 const checkpoint=h.posts.find(p=>p.type==='contextCompacted');assert.ok(checkpoint);
 assert.ok(checkpoint.after<checkpoint.before);
 assert.ok(h.posts.some(p=>p.agentAction));
 const checkpoints=JSON.parse(JSON.stringify(checkpoint.messages));
 await h.provider._chat({messages:checkpoints.concat({role:'user',content:'TOOL RESULTS\n[read README.md]\nActual file contents.'}),agentic:true,structuredActions:true,stream:true});
 assert.equal(summaries,1,'the following tool round must also keep the saved memory');
});

test('schema negotiation also reuses the first encoded context',async()=>{
 const {compactMessages}=require('../vscode/context');let replies=0,summaries=0;
 const h=host({},()=>++replies===1?new Response('json_schema response_format unsupported',{status:400})
  :new Response(JSON.stringify({choices:[{message:{content:actionResponse()}}]})));
 h.provider._compactContext=messages=>compactMessages(messages,async()=>{summaries++;return 'Retained request and completed work.';},
  messages.some(m=>String(m.content).includes('EXECUTABLE ACTION RESPONSE'))?{trigger:45000,target:20000}:{});
 await h.provider._chat({messages:[{role:'user',content:'ARCHIVE '.repeat(8000)},{role:'user',content:'Continue the pending task'}],agentic:true,structuredActions:true});
 assert.equal(summaries,1);assert.equal(h.calls.length,2);
 assert.equal(JSON.parse(h.calls[1].options.body).response_format.type,'json_object');
 assert.ok(h.posts.some(p=>p.agentAction));
});

test('switching Agent back on removes the saved ordinary-chat override',async()=>{
 const {chatInstruction}=require('../vscode/media/agent-run');
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:actionResponse()}}]})));
 await h.provider._chat({messages:[{role:'system',content:'Saved project facts.\n'+chatInstruction},
  {role:'user',content:'Continue the work'}],agentic:true,structuredActions:true});
 const payload=JSON.parse(h.calls[0].options.body);
 assert.ok(!payload.messages[0].content.includes(chatInstruction));
 assert.match(payload.messages[0].content,/Saved project facts/);
 assert.match(payload.messages[0].content,/EXECUTABLE ACTION RESPONSE/);
 assert.equal(h.posts.find(p=>p.type==='done').agentAction.tools[0].action,'read');
});

test('broken nested JSON retries as object arguments and remembers success only for that endpoint/model',async()=>{
 let replies=0;
 const malformed=actionResponse([{name:'read',arguments:'{"path":"README.md"'}]);
 const valid=actionResponse([{name:'read',arguments:{path:'README.md'}}]);
 const h=host({maxTokens:9000},()=>new Response(JSON.stringify({choices:[{message:{content:++replies===1?malformed:valid}}]})));
 const request={messages:[{role:'user',content:'Continue with the existing tool results.'}],model:'Qwen/Qwen3.8-27B-FP8',agentic:true,structuredActions:true,stream:true};
 await h.provider._chat(request);
 assert.equal(h.calls.length,2);
 const first=JSON.parse(h.calls[0].options.body),repair=JSON.parse(h.calls[1].options.body);
 assert.equal(first.response_format.type,'json_schema');assert.equal(repair.response_format.type,'json_object');
 assert.match(repair.messages[0].content,/a direct JSON object, not a string/);
 assert.doesNotMatch(repair.messages[0].content,/JSON-encoded object string/);
 assert.equal(repair.model,first.model);assert.equal(repair.max_tokens,9000);assert.equal(repair.stream,false);
 assert.equal(h.calls[1].url,h.calls[0].url);assert.deepEqual(h.calls[1].options.headers,h.calls[0].options.headers);
 assert.ok(repair.messages.some(m=>m.content===request.messages[0].content));
 assert.deepEqual(h.posts.find(p=>p.agentAction).agentAction.tools,[{path:'README.md',action:'read'}]);
 assert.ok(!h.posts.some(p=>p.type==='delta'));
 await h.provider._chat(request);
 assert.equal(h.calls.length,3);assert.equal(JSON.parse(h.calls[2].options.body).response_format.type,'json_object');
 await h.provider._chat({...request,model:'different/model'});
 assert.equal(JSON.parse(h.calls[3].options.body).response_format.type,'json_schema');
 h.config.endpoint='https://different.example/v1';
 await h.provider._chat(request);
 assert.equal(JSON.parse(h.calls[4].options.body).response_format.type,'json_schema');
});

test('invalid object repair releases no part of a batch and does not remember an unsuccessful format',async()=>{
 const invalid=actionResponse([{name:'read',arguments:{path:'README.md'}},{name:'shell',arguments:{command:'echo unsafe',action:'read'}}]);
 const h=host({},()=>new Response(JSON.stringify({choices:[{message:{content:invalid}}]})));
 const request={messages:[{role:'user',content:'Continue'}],agentic:true,structuredActions:true};
 await h.provider._chat(request);
 assert.equal(h.calls.length,2);assert.ok(!h.posts.some(p=>p.agentAction));
 assert.match(h.posts.find(p=>p.type==='error').message,/No action was executed/);
 await h.provider._chat(request);
 assert.equal(JSON.parse(h.calls[2].options.body).response_format.type,'json_schema');
 assert.equal(h.calls.length,4);assert.ok(!h.posts.some(p=>p.agentAction));
});

test('200 consecutive structured rounds accept provider dialects with no repeated requests or lost work',async()=>{
 let round=0;
 const h=host({},()=>{
  const index=round++, path='fixture-'+index+'.js';
  const content={status:'actions',actions:[{name:'read',arguments:{path}}],notes:'Provider metadata',reasoning:'Not executable'};
  if(index===199){content.status='complete';content.actions=[];content.summary='Verified the synthetic task.';}
  else if(index%4===1) content.actions=[{action:'read',path}];
  else if(index%4===2) return new Response(JSON.stringify({choices:[{message:{content:'Reading.',tool_calls:[{type:'function',function:{name:'read',arguments:JSON.stringify({path})}}]}}]}));
  return new Response(JSON.stringify({choices:[{message:{content:index%4===3?'```json\n'+JSON.stringify(content)+'\n```':JSON.stringify(content)}}]}));
 });
 for(let i=0;i<200;i++){
  const before=h.posts.length;
  await h.provider._chat({model:'universal/model',agentic:true,structuredActions:true,stream:true,
   messages:[{role:'user',content:'Synthetic round '+i+'; preserve completed work.'}]});
  const posts=h.posts.slice(before),action=posts.find(p=>p.agentAction)?.agentAction;
  assert.ok(action,'round '+i+': '+JSON.stringify(posts));
  assert.ok(!posts.some(p=>p.type==='error'||p.type==='delta'));
  if(i<199) assert.deepEqual(action.tools,[{path:'fixture-'+i+'.js',action:'read'}]);
  else assert.equal(action.control.status,'complete');
 }
 assert.equal(h.calls.length,200);
});

test('format and template negotiation reaches validated plain JSON and remembers it',async()=>{
 const h=host({},(url,options)=>{
  const p=JSON.parse(options.body);
  if(p.chat_template_kwargs) return new Response('chat_template_kwargs unsupported',{status:400});
  if(p.response_format) return new Response('response_format unsupported',{status:422});
  return new Response(JSON.stringify({choices:[{message:{content:actionResponse()}}]}));
 });
 const request={model:'Qwen/test',agentic:true,structuredActions:true,messages:[{role:'user',content:'Continue the task.'}]};
 await h.provider._chat(request);
 assert.equal(h.calls.length,4);assert.ok(h.posts.some(p=>p.agentAction));
 const final=JSON.parse(h.calls.at(-1).options.body);
 assert.equal(final.response_format,undefined);assert.equal(final.chat_template_kwargs,undefined);
 await h.provider._chat(request);
 assert.equal(h.calls.length,5);
 assert.equal(JSON.parse(h.calls.at(-1).options.body).response_format,undefined);
});

test('format repair can negotiate an unsupported JSON object mode without losing original context',async()=>{
 let count=0;
 const h=host({},()=>++count===1?new Response(JSON.stringify({choices:[{message:{content:'{"status":"invalid"}'}}]})):
  count===2?new Response('json_object response_format unsupported',{status:400}):
  new Response(JSON.stringify({choices:[{message:{content:actionResponse()}}]})));
 await h.provider._chat({agentic:true,structuredActions:true,messages:[{role:'user',content:'Keep this exact task.'}]});
 assert.equal(h.calls.length,3);assert.ok(h.posts.some(p=>p.agentAction));
 const final=JSON.parse(h.calls[2].options.body);
 assert.equal(final.response_format,undefined);assert.ok(final.messages.some(m=>m.content==='Keep this exact task.'));
});

test('filtered and refused structured replies do not trigger execution or a format retry',async()=>{
 for(const choice of [{finish_reason:'content_filter',message:{content:actionResponse()}},
  {message:{content:actionResponse(),refusal:'Declined'}}]){
  const h=host({},()=>new Response(JSON.stringify({choices:[choice]})));
  await h.provider._chat({agentic:true,structuredActions:true,messages:[{role:'user',content:'Test filtering.'}]});
  assert.equal(h.calls.length,1);assert.ok(!h.posts.some(p=>p.agentAction));assert.ok(h.posts.some(p=>p.type==='error'));
 }
});
