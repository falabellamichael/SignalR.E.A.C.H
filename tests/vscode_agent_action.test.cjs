const {test}=require('node:test');
const assert=require('node:assert/strict');
const {prepare,decode}=require('../vscode/agent-action');
const envelope=(status='actions',actions=[{name:'read',arguments:'{"path":"src/main.js"}'}],message='Reading files.')=>({status,actions,message,options:[]});

test('action recovery enforces an API schema and keeps the selected model, budget and context',()=>{
 const base={model:'Qwen/model',stream:true,max_tokens:100000,messages:[{role:'user',content:'original request'},{role:'user',content:'completed tool results'}]};
 const result=prepare(base);
 assert.equal(result.response_format.type,'json_schema');assert.equal(result.response_format.json_schema.strict,true);
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
 for(const options of [null,'Approve',{},[{}],Array(9).fill('Choice')]){
  assert.throws(()=>decode(JSON.stringify({...envelope('question',[],'Which project?'),options})),/invalid question options/);
 }
 const question=decode(JSON.stringify({...envelope('question',[],'Which project?'),options:['A','B']}));
 assert.deepEqual(question.confirm.options,['A','B']);
});
