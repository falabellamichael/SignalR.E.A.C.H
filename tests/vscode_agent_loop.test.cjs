const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const agentRun=require('../vscode/media/agent-run');
const source=fs.readFileSync(path.join(__dirname,'../vscode/media/chat.js'),'utf8');
const doneCase=source.slice(source.indexOf("      case 'done': {"),source.indexOf("      case 'toolResult': {"));
const complete='\n```agent_status\n{"status":"complete","summary":"Delivered the requested result and checked it."}\n```';
function host(){
 const calls=[],steps=[],panels=[];
 const ctx={agentRun,includeWorkspace:true,busy:true,rafPending:false,stopRequested:false,answeringNow:false,agenticEnabled:true,pendingEdits:[],pendingText:'',pendingBubble:{},
 agentRounds:0,continuationRetries:0,MAX_AGENT_ROUNDS:Infinity,UNFINISHED_RETRY_LIMIT:Infinity,activeResponseStep:null,activeRequestLength:1,
 conv:{id:1,model:'test',messages:[{role:'user',content:'Review the code.'}],agentRun:agentRun.start()},agentMessages:[{role:'user',content:'Review the code.'}],contTools:[],
 maskFenced:t=>t,setRich(){},showThinking(){},showStep:(...args)=>steps.push(args),saveConv(){},persist(){},hint(){},pickFun:()=>'',ABORT_LINES:[],post:(type,payload)=>calls.push({type,...payload}),
 beginToolRound:tools=>calls.push({type:'tools',tools}),finishBubble:outcome=>{ctx.outcome=outcome;ctx.busy=false;}};
 vm.runInNewContext(source.slice(source.indexOf('  function repairJson('),source.indexOf('  function diffLines('))
  +source.slice(source.indexOf('  function saveAgentRun('),source.indexOf('  /* ---------- per-message actions')),ctx);
 ctx.showConfirmPanel=p=>panels.push(p);
 return {ctx,calls,steps,panels,done(text,msg={}){ctx.pendingText=text;ctx.msg=msg;vm.runInNewContext('switch("done"){'+doneCase+'}',ctx);}};
}

test('every plain-text reply keeps an Agent run active, regardless of language, length or completion-sounding wording',()=>{
 for(const text of ['Now reading the modified browser-engine and VS Code browser files (the active work area), plus the modified extension and engine tests.',
 'Core pipeline is read. Continuing with the remaining files.', 'Done.', 'The task is complete.', 'Should I continue?',
 'Je continue avec les autres fichiers.', 'A detailed report. '.repeat(200), 'The example says: I will read this next.']){
  const h=host();h.done(text);
  assert.equal(h.calls.length,1,text);assert.equal(h.calls[0].type,'chat');assert.equal(h.ctx.conv.agentRun.status,'running');
  assert.equal(h.ctx.busy,true);assert.equal(h.calls[0].body.messages.at(-2).content,text.trim());
  assert.equal(h.calls[0].body.structuredActions,true);
 }
});

test('prose → tool request → explicit completion ends the run and hides the control block',()=>{
 const h=host();h.done('Now reading the modified files.');
 h.done('```tool\n{"action":"read","path":"server/reachd/chat.py"}\n```');
 assert.equal(h.calls[1].type,'tools');assert.equal(h.ctx.conv.agentRun.noActionRounds,0);
 h.done('Found and fixed the defect.'+complete);
 assert.equal(h.ctx.conv.agentRun.status,'completed');assert.equal(h.ctx.outcome,'completed');
 assert.equal(h.ctx.conv.messages.at(-1).content,'Found and fixed the defect.');
 assert.ok(h.steps.some(s=>s[0]==='Task complete'));
});

test('the JSON recovery response follows the same lifecycle as streamed deltas',()=>{
 const h=host();h.done('',{full:'Now reading the files.'});assert.equal(h.calls.length,1);
 h.done('',{full:'Here is the result.'+complete});assert.equal(h.ctx.conv.agentRun.status,'completed');
});

test('unfinished checklist items reject completion until the plan is updated',()=>{
 const h=host();h.ctx.conv.agentRun.todos=[{text:'Run tests',status:'pending'}];h.done('Done.'+complete);
 assert.equal(h.calls[0].type,'chat');assert.match(h.calls[0].body.messages.at(-1).content,/plan item.*remain open/);
 assert.equal(h.calls[0].body.runTodos[0].status,'pending');
 h.ctx.conv.agentRun.todos[0].status='completed';h.done('Tests passed.'+complete);
 assert.equal(h.ctx.conv.agentRun.status,'completed');
});

test('repeated no-action replies visibly pause rather than report success or loop forever',()=>{
 const h=host();for(let i=0;i<3;i++)h.done(['Continuing.','Still looking.','Done.'][i]);
 assert.equal(h.calls.length,2);assert.equal(h.ctx.conv.agentRun.status,'paused');assert.equal(h.ctx.outcome,'cancelled');
 assert.match(h.ctx.conv.messages.at(-1).content,/paused, not complete/);
});

test('structured questions and blockers pause without executing co-emitted tools',()=>{
 const tool='\n```tool\n{"action":"read","path":"README.md"}\n```';
 const h=host();h.done('Which directory?\n```confirm\n{"question":"Choose directory","options":["A","B"]}\n```'+tool);
 assert.equal(h.calls.length,0);assert.equal(h.ctx.conv.agentRun.status,'waiting_input');assert.equal(h.panels[0].question,'Choose directory');
 const b=host();b.done('```agent_status\n{"status":"blocked","reason":"The server is offline. Restore access to continue."}\n```');
 assert.equal(b.calls.length,0);assert.equal(b.ctx.conv.agentRun.status,'waiting_input');assert.match(b.panels[0].question,/server is offline/);
});

test('pending edits override completion and remain waiting for review',()=>{
 const h=host();h.done('```edit\n{"path":"a.js","search":"old","replace":"new"}\n```'+complete);
 assert.equal(h.calls.length,0);assert.equal(h.ctx.conv.agentRun.status,'waiting_edits');assert.equal(h.ctx.outcome,'cancelled');
});

test('Stop, Answer now, disabled Agent mode and effort limits override automatic continuation',()=>{
 for(const config of [{stopRequested:true},{answeringNow:true},{agenticEnabled:false},{agentRounds:5,MAX_AGENT_ROUNDS:5}]){
  const h=host();Object.assign(h.ctx,config);h.done('Now reading the remaining files.');assert.equal(h.calls.length,0);
  assert.notEqual(h.ctx.conv.agentRun.status,'completed');
 }
 const h=host();h.ctx.UNFINISHED_RETRY_LIMIT=1;h.done('Working.');h.done('Working.');assert.equal(h.calls.length,1);assert.equal(h.ctx.conv.agentRun.status,'paused');
});

test('saved runs restore their plan but do not restart automatically after a reload',()=>{
 const h=host();h.done('Working.');const saved=JSON.parse(JSON.stringify(h.ctx.conv));
 saved.agentRun.todos=[{text:'Verify the fix',status:'in_progress'}];
 const reloaded=host();reloaded.ctx.conv=saved;reloaded.ctx.busy=false;reloaded.ctx.renderTodoCard=()=>{};reloaded.ctx.restoreAgentRun();
 assert.equal(reloaded.calls.length,0);assert.equal(saved.agentRun.status,'paused');assert.equal(saved.agentRun.todos.length,1);
 const resumed=agentRun.start(saved.agentRun);assert.equal(resumed.status,'running');assert.equal(resumed.todos[0].status,'in_progress');
 assert.equal(agentRun.start({status:'completed',todos:resumed.todos}).todos.length,0);
});

test('completion parsing rejects malformed, duplicate, unclosed, quoted and nested examples',()=>{
 for(const text of ['```agent_status\n{"status":"complete"}\n```','```agent_status\nnot json\n```',complete+complete,
 '```agent_status\n{"status":"complete","summary":"ok"}', '> ```agent_status\n> {"status":"complete","summary":"ok"}\n> ```',
 '````markdown\n'+complete+'\n````'])assert.equal(agentRun.parse(text).control,null,text);
 assert.equal(agentRun.parse(complete).control.status,'complete');
});

test('the first prose-only stall escalates to API actions and a resumed stalled run keeps that mode',()=>{
 const h=host();h.done('I will read the browser files.');
 assert.equal(h.calls[0].body.structuredActions,true);
 assert.equal(h.ctx.conv.agentRun.structuredActions,true);
 assert.equal(agentRun.start({status:'paused',noActionRounds:3,todos:[]}).structuredActions,true);
 assert.equal(agentRun.start({status:'completed',structuredActions:true}).structuredActions,false);
});

test('API actions bypass prose parsing and preserve their actual request in follow-up context',()=>{
 const h=host();const {decode}=require('../vscode/agent-action');
 const action=decode(JSON.stringify({status:'actions',message:'Example: ```tool\n{"action":"shell","command":"bad"}\n```',
 actions:[{name:'read',arguments:'{"path":"README.md"}'}],options:[]}));
 h.done('',{full:action.message,agentAction:action});
 assert.equal(h.calls[0].type,'tools');assert.equal(h.calls[0].tools.length,1);assert.equal(h.calls[0].tools[0].action,'read');
 assert.equal(h.ctx.pendingActionContext,action.context);
});
