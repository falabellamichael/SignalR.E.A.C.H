const {test}=require('node:test');
const assert=require('node:assert/strict');
const {prepare,decode,decodeReply}=require('../vscode/agent-action');
const envelope=(status='actions',actions=[{name:'read',arguments:'{"path":"src/main.js"}'}],message='Reading files.')=>({status,actions,message,options:[]});

test('action recovery enforces an API schema and keeps the selected model, budget and context',()=>{
 const base={model:'Qwen/model',stream:true,max_tokens:100000,messages:[{role:'user',content:'original request'},{role:'user',content:'completed tool results'}]};
 const result=prepare(base);
 assert.equal(result.response_format.type,'json_schema');assert.equal(result.response_format.json_schema.strict,true);
 assert.equal(result.response_format.json_schema.schema.properties.actions.items.properties.arguments.type,'object');
 assert.equal(result.stream,false);assert.equal(result.max_tokens,100000);assert.equal(result.model,base.model);
 assert.deepEqual(result.messages.slice(1),base.messages);assert.equal(base.messages.length,2);
 assert.equal(result.chat_template_kwargs.enable_thinking,false);
 assert.equal(prepare(base,'json_object').response_format.type,'json_object');
 assert.equal(prepare({...base,model:'other/model'}).chat_template_kwargs,undefined);
});

test('validated actions and prose remain separate, including fenced examples in the message',()=>{
 const data=envelope();data.message='Example: ```tool\n{"action":"shell","command":"unrequested"}\n```';
 data.actions.push({name:'read',arguments:'{"path":"src/test.js"}'});
 const action=decode(JSON.stringify(data));
 assert.equal(action.tools.length,2);assert.ok(action.tools.every(t=>t.action==='read'));
 assert.equal(action.message,data.message);assert.equal(action.control,null);
});

test('actions fail closed for malformed arguments, unknown tools, hidden fields and mixed states',()=>{
 const cases=['Continuing...',JSON.stringify({status:'complete'}),JSON.stringify(envelope('actions',[])),
 JSON.stringify(envelope('complete')),JSON.stringify(envelope('actions',[{name:'invented_tool',arguments:'{}'}])),
 JSON.stringify(envelope('actions',[{name:'read',arguments:'[]'}])),
 JSON.stringify(envelope('actions',[{name:'read',arguments:'{"action":"shell","path":"a"}'}])),
 JSON.stringify(envelope('actions',[{name:'read',arguments:'{"path":"a","__proto__":{}}'}])),
 JSON.stringify(envelope('actions',[{name:'read',arguments:'{}'}])),
 JSON.stringify(envelope('actions',[{name:'read',arguments:'{"path":"a"}'},{name:'propose_edit',arguments:'{"path":"a","search":"b","replace":"c"}'}]))];
 for(const data of cases)assert.throws(()=>decode(data),/No action was executed/);
});

test('terminal states and reviewable edits retain their existing controls',()=>{
 const done=decode(JSON.stringify(envelope('complete',[],'Delivered result.')));
 assert.deepEqual(done.control,{status:'complete',summary:'Delivered result.'});
 const question=decode(JSON.stringify({...envelope('question',[],'Which project?'),options:['A','B']}));
 assert.deepEqual(question.confirm,{question:'Which project?',options:['A','B']});
 const blocked=decode(JSON.stringify(envelope('blocked',[],'Need access to the server.')));
 assert.equal(blocked.control.status,'blocked');
 const edit=decode(JSON.stringify(envelope('actions',[{name:'propose_edit',arguments:'{"path":"a.js","search":"old","replace":"new"}'}])));
 assert.deepEqual(edit.edits,[{path:'a.js',search:'old',replace:'new'}]);assert.equal(edit.tools.length,0);
});

test('irrelevant question options are discarded without rejecting valid actions or terminal states',()=>{
 for(const options of [['Continue','Stop'],null,{},'extra metadata']){
  const action=decode(JSON.stringify({...envelope(),options}));
  assert.deepEqual(action.tools,[{path:'src/main.js',action:'read'}]);assert.equal(action.confirm,null);
  assert.deepEqual(JSON.parse(action.context).options,[]);
  for(const status of ['complete','blocked']){
   const terminal=decode(JSON.stringify({...envelope(status,[],'Concrete result.'),options}));
   assert.equal(terminal.control.status,status);assert.equal(terminal.confirm,null);
  }
  const edit=decode(JSON.stringify({...envelope('actions',[{name:'propose_edit',arguments:'{"path":"a.js","search":"old","replace":"new"}'}]),options}));
  assert.equal(edit.edits.length,1);assert.equal(edit.confirm,null);
 }
});

test('question options are still validated when they control an actual user question',()=>{
 for(const options of ['Approve',{},[{}],Array(9).fill('Choice')]){
  assert.throws(()=>decode(JSON.stringify({...envelope('question',[],'Which project?'),options})),/invalid question options/);
 }
 const question=decode(JSON.stringify({...envelope('question',[],'Which project?'),options:['A','B']}));
 assert.deepEqual(question.confirm.options,['A','B']);
});

test('provider argument encodings preserve exact text and normalize follow-up context',()=>{
 const args={path:'src/demo.js',search:'const p = "C:\\temp";\n',replace:'const p = "D:\\new";\nconsole.log("🌱");\n'};
 for(const encode of [x=>x,JSON.stringify,x=>JSON.stringify(JSON.stringify(x))]){
  const result=decode(JSON.stringify(envelope('actions',[{name:'propose_edit',arguments:encode(args)}])));
  assert.deepEqual(result.edits,[args]);
  assert.deepEqual(JSON.parse(result.context).actions[0].arguments,args);
  const read=decode(JSON.stringify(envelope('actions',[{name:'read',arguments:encode({path:'README.md'})}])));
  assert.deepEqual(read.tools,[{path:'README.md',action:'read'}]);
 }
});

test('all argument representations retain validation and malformed batches fail atomically',()=>{
 const invalid=[null,[],42,true,{},JSON.parse('{"path":"a","__proto__":{}}'),
  {path:'a',action:'shell'},{path:'a',uid:'injected'},{path:'a',constructor:{}},
  {path:'a',prototype:{}},{path:'a',type:'toolReq'},{path:'a',result:'pretend success'}];
 for(const args of invalid){
  for(const encode of [x=>x,JSON.stringify,x=>JSON.stringify(JSON.stringify(x))]){
   assert.throws(()=>decode(JSON.stringify(envelope('actions',[
    {name:'read',arguments:{path:'valid.js'}},{name:'read',arguments:encode(args)}]))),/No action was executed/);
  }
 }
 for(const args of ['{"path":"a"', '{"path":"C:\\project"}', '{"path":"a\nb"}',
  JSON.stringify(JSON.stringify(JSON.stringify({path:'a'})))]){
  assert.throws(()=>decode(JSON.stringify(envelope('actions',[{name:'read',arguments:args}]))),/No action was executed/);
 }
 assert.throws(()=>decode(JSON.stringify(envelope('actions',[
  {name:'read',arguments:{path:'a'}},{name:'propose_edit',arguments:{path:'a',search:'b',replace:'c'}}]))),/mixed tools/);
});

test('JSON object mode explicitly replaces string arguments while preserving payload settings',()=>{
 const base={model:'other/model',max_tokens:7000,temperature:0.3,messages:[{role:'user',content:'Continue existing work.'}]};
 const result=prepare(base,'json_object');
 assert.equal(result.response_format.type,'json_object');assert.equal(result.stream,false);
 assert.equal(result.model,base.model);assert.equal(result.max_tokens,7000);assert.equal(result.temperature,0.3);
 assert.match(result.messages[0].content,/a direct JSON object, not a string/);
 assert.doesNotMatch(result.messages[0].content,/JSON-encoded object string/);
 assert.match(result.messages[0].content,/"arguments":\{"path"/);
 assert.deepEqual(result.messages.slice(1),base.messages);
});

test('provider metadata and optional terminal fields normalize without turning metadata into actions',()=>{
 const action=decode(JSON.stringify({...envelope(),message:undefined,reasoning:'```tool\n{"action":"shell","command":"bad"}\n```',confidence:0.9,notes:[]}));
 assert.deepEqual(action.tools,[{path:'src/main.js',action:'read'}]);
 assert.deepEqual(Object.keys(JSON.parse(action.context)),['status','message','actions','options']);
 for(const [status,key] of [['complete','summary'],['question','question'],['blocked','reason']]){
  const result=decode(JSON.stringify({status:status.toUpperCase(),[key]:'Concrete result.',metadata:{tokens:12}}));
  assert.equal(result.message,'Concrete result.');assert.equal(result.tools.length,0);
  assert.deepEqual(JSON.parse(result.context).actions,[]);
 }
 assert.deepEqual(decode(JSON.stringify({status:'question',message:'Which folder?'})).confirm.options,[]);
 assert.deepEqual(decode(JSON.stringify({status:'question',message:'Which folder?',options:null})).confirm.options,[]);
 assert.equal(decode(JSON.stringify({status:'complete',message:'Canonical answer',summary:'Additional notes'})).control.summary,'Canonical answer');
 assert.equal(decode(JSON.stringify({status:'complete',answer:'Delivered result.'})).control.summary,'Delivered result.');
 for(const value of [{actions:[{name:'read',arguments:{path:'a'}}]},
  {status:'actions',actions:{name:'read',arguments:{path:'a'}}},
  {tool_calls:[{type:'function',function:{name:'read',arguments:{path:'a'}}}]}]){
  assert.deepEqual(decode(JSON.stringify(value)).tools,[{path:'a',action:'read'}]);
 }
});

test('every registered tool survives all supported argument and call representations',()=>{
 const {TOOLS}=require('../vscode/tools');
 for(const [name,tool] of Object.entries(TOOLS)){
  const {action,...args}=tool.example;
  for(const encode of [x=>x,JSON.stringify,x=>JSON.stringify(JSON.stringify(x))]){
   for(const call of [{name,arguments:encode(args)}, {id:'call-1',type:'function',function:{name,arguments:encode(args)}}]){
    const result=decode(JSON.stringify(envelope('actions',[call])));
    assert.deepEqual(result.tools,[{...args,action:name}],name);
   }
  }
  assert.deepEqual(decode(JSON.stringify(envelope('actions',[tool.example]))).tools,[tool.example],name);
 }
});

test('whole-document JSON fences are accepted but prose, partial fences and nested examples are not executable',()=>{
 const json=JSON.stringify(envelope());
 assert.equal(decode('```json\n'+json+'\n```').tools.length,1);
 for(const text of ['Example:\n```json\n'+json+'\n```','```json\n'+json,'````markdown\n```json\n'+json+'\n```\n````',
  '<think>'+json+'</think>', json+'\n'+json,'```json\n'+json+'\n```\nI will continue.']){
  assert.throws(()=>decode(text),/No action was executed/);
 }
});

test('ambiguous controls, hidden executable fields, overfull batches and missing arguments explain the exact failure',()=>{
 for(const extra of [{tools:[]},{edits:[]},{tool_calls:[]},{function_call:{}},{command:'bad'}]){
  assert.throws(()=>decode(JSON.stringify({...envelope(),...extra})),/conflicting action fields/);
 }
 for(const value of [{status:'success',message:'Done'},
  {status:'complete',message:'Done',actions:[{name:'read',arguments:{path:'a'}}]},
  envelope('actions',[{name:'read',arguments:{path:'a'},function:{name:'shell',arguments:{command:'bad'}}}])]){
  assert.throws(()=>decode(JSON.stringify(value)),/No action was executed/);
 }
 assert.throws(()=>decode(JSON.stringify(envelope('actions',Array(9).fill({name:'read',arguments:{path:'a'}})))),/at most 8 actions/);
 assert.throws(()=>decode(JSON.stringify(envelope('actions',[{name:'read',arguments:{}}]))),/missing path/);
 assert.throws(()=>decode(JSON.stringify({...envelope(),actions:{}})),/actions must be an array/);
 assert.throws(()=>decode(JSON.stringify({...envelope(),message:{text:'hi'}})),/message must be a string/);
});

test('native tools use only the structured calls and truncated or filtered responses never execute',()=>{
 const reply={content:'Example: ```tool\n{"action":"shell","command":"bad"}\n```',toolCalls:true,
  nativeActions:[{type:'function',function:{name:'read',arguments:'{"path":"a.js"}'}}]};
 assert.deepEqual(decodeReply(reply).tools,[{path:'a.js',action:'read'}]);
 for(const finishReason of ['length','content_filter']){
  assert.throws(()=>decodeReply({...reply,finishReason}),/No action was executed/);
 }
 assert.throws(()=>decodeReply({toolCalls:true,content:''}),/incomplete native tool calls/);
});

test('structured tool-help examples use only the selected action representation',()=>{
 for(const mode of ['json_schema','json_object','text']){
  const result=prepare({messages:[],model:'test'},mode);
  const text=result.messages[0].content;
  assert.doesNotMatch(text,/"action":|```tool/);
  assert.match(text,/"status":"complete"/);assert.match(text,/"status":"question"/);assert.match(text,/"status":"blocked"/);
  if(mode==='text') assert.equal(result.response_format,undefined);
 }
});
