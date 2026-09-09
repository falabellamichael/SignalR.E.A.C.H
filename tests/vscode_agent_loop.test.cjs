const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../vscode/media/chat.js'), 'utf8');
const doneCase = source.slice(source.indexOf("      case 'done': {"), source.indexOf("      case 'toolResult': {"));
function host() {
 const calls=[],steps=[];
 const ctx={includeWorkspace:true,busy:true,rafPending:false,stopRequested:false,agenticEnabled:true,pendingEdits:[],pendingText:'',pendingBubble:{},
  agentRounds:0,continuationRetries:0,MAX_AGENT_ROUNDS:40,activeResponseStep:null,
  conv:{id:1,model:'test',messages:[{role:'user',content:'Clean up the CLI modules and tests.'}]},
  agentMessages:[{role:'user',content:'Clean up the CLI modules and tests.'}],contTools:[],
  setRich(){},showThinking(){},showStep:(...args)=>steps.push(args),saveConv(){},hint(){},
  pickFun:()=>'',ABORT_LINES:[],post:(type,payload)=>calls.push({type,...payload}),
  beginToolRound:tools=>calls.push({type:'tools',tools}),
  finishBubble:outcome=>{ctx.outcome=outcome;ctx.busy=false;}};
 vm.runInNewContext(source.slice(source.indexOf('  function repairJson('),source.indexOf('  function diffLines('))
  +source.slice(source.indexOf('  function isUnfinishedUpdate('),source.indexOf('  /* ---------- per-message actions')),ctx);
 return {ctx,calls,steps,done(text,msg={}){ctx.pendingText=text;ctx.msg=msg;vm.runInNewContext('switch("done") {\n'+doneCase+'\n}',ctx);}};
}
test('announced next actions continue automatically, and repeated promises pause explicitly',()=>{
 const h=host(); const plan='I’ll continue with a focused cleanup pass in the CLI modules and tests, then apply a few safe fixes.\n\nFirst I’ll scan for TODO/FIXME-style signals and then patch clear issues in tools/reach_cli + tests.';
 h.done(plan);
 assert.equal(h.calls[0].type,'chat');assert.equal(h.ctx.busy,true);assert.equal(h.ctx.pendingText,'');
 assert.equal(h.calls[0].body.messages.at(-2).content,plan);
 assert.match(h.calls[0].body.messages.at(-1).content,/Emit the required tool blocks/);
 h.done(plan);assert.equal(h.calls.length,2);
 h.done(plan);assert.equal(h.calls.length,2);assert.equal(h.ctx.outcome,'cancelled');
 assert.match(h.ctx.conv.messages.at(-1).content,/Paused because the model repeated a plan/);
});
test('finished answers, offers, questions, and approval requests do not trigger continuation',()=>{
 for(const text of ['Fixed the parser and tested the changes.', 'I can inspect more files if you want.',
  'Should I continue?', 'I will run the migration after your approval.', 'The example says: I will read this next.']) {
  const h=host();h.done(text);assert.equal(h.calls.length,0,text);assert.equal(h.ctx.outcome,'completed');
 }
});
test('tool work continues past four rounds, resets promise retries, and pauses visibly at forty',()=>{
 const h=host();h.ctx.agentRounds=4;h.ctx.continuationRetries=2;
 const tool='<tool>{"action":"read","path":"README.md"}</tool>';
 h.done(tool);assert.equal(h.calls[0].type,'tools');assert.equal(h.ctx.continuationRetries,0);
 h.ctx.agentRounds=40;h.done(tool);assert.equal(h.calls.length,1);
 assert.match(h.ctx.conv.messages.at(-1).content,/Paused after 40 agent rounds/);
});
test('Stop prevents both planned continuations and already emitted tool requests from launching',()=>{
 for(const text of ['I’ll inspect the tests next.', '<tool>{"action":"read","path":"README.md"}</tool>']) {
  const h=host();h.ctx.stopRequested=true;h.done(text);
  assert.equal(h.calls.length,0);assert.equal(h.ctx.outcome,'cancelled');
 }
});
