const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const extensionPath=path.resolve(__dirname,'../vscode/extension.js');
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
 assert.ok(final.messages.some(m=>m.content.startsWith('REACH conversation memory')));
 assert.equal(final.agentic,undefined);assert.equal(messages.length,13);
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
