const {test}=require('node:test');
const assert=require('node:assert/strict');
const {compactMessages,contextChars,MEMORY_PREFIX}=require('../vscode/context');

test('long history compresses while current instructions, request and recent source remain exact',async()=>{
 const rules={role:'system',content:'Preserve all user edits.'};
 const current={role:'user',content:'Finish the pending cache fix.'};
 const recent={role:'user',content:'TOOL RESULTS\n'+ 'current source\n'.repeat(4000)+'EXACT_END'};
 const history=[rules,...Array.from({length:10},(_,i)=>({role:'assistant',content:`Earlier step ${i}: `+'x'.repeat(45000)})),current,recent];
 const snapshot=JSON.stringify(history);let archived;
 const result=await compactMessages(history,async m=>{archived=m;return 'User wants the cache fix. Old decisions retained; earlier files must be reread before edits.';});
 assert.equal(result.changed,true);assert.ok(result.after<140000);
 assert.ok(result.messages.includes(rules));assert.ok(result.messages.includes(current));assert.ok(result.messages.includes(recent));
 assert.ok(archived.length>0);assert.equal(JSON.stringify(history),snapshot);
 const next=await compactMessages(result.messages,()=>{throw new Error('should reuse memory');});
 assert.equal(next.changed,false);
});
test('a single oversized tool read is summarized fully with an explicitly partial excerpt',async()=>{
 const content='TOOL RESULTS\nFILE_START\n'+'z'.repeat(600000)+'\nFILE_END';let archived;
 const result=await compactMessages([{role:'user',content:'Inspect this file.'},{role:'user',content}],async m=>{archived=m;return 'File inspected; preserve the task, reread exact ranges for edits.';});
 assert.ok(archived.some(m=>m.content===content));
 assert.match(result.messages.at(-1).content,/Partial excerpt/);assert.match(result.messages.at(-1).content,/FILE_END/);
 assert.ok(contextChars(result.messages)<240000);
});
test('message count compaction retains native tool calls with their results',async()=>{
 const messages=Array.from({length:90},(_,i)=>({role:'user',content:'Old request '+i}));
 messages.push({role:'assistant',content:'',tool_calls:[{id:'read-1',type:'function',function:{name:'read',arguments:'{}'}}]},
 {role:'tool',tool_call_id:'read-1',content:'EXACT_TOOL_RESULT'});
 const result=await compactMessages(messages,async()=> 'Earlier turns summarized.');
 assert.ok(result.messages.length<=72);const index=result.messages.findIndex(m=>m.tool_call_id==='read-1');
 assert.equal(result.messages[index-1].tool_calls[0].id,'read-1');
});
test('previous memory is merged when more results accumulate and summary failure preserves input',async()=>{
 const memory={role:'system',content:MEMORY_PREFIX+'\nKeep constraint ALPHA.'};
 const messages=[memory,...Array.from({length:5},()=>({role:'user',content:'TOOL RESULTS\n'+'a'.repeat(80000)}))];
 const result=await compactMessages(messages,async archived=>{assert.ok(archived.includes(memory));return 'Constraint ALPHA retained, new work summarized.';});
 assert.equal(result.messages.filter(m=>m.content.startsWith(MEMORY_PREFIX)).length,1);
 const snapshot=JSON.stringify(messages);
 await assert.rejects(compactMessages(messages,async()=>{throw new Error('network failed');}),/network failed/);
 assert.equal(JSON.stringify(messages),snapshot);
});

const fs=require('node:fs'),vm=require('node:vm');
const ui=fs.readFileSync(require('node:path').join(__dirname,'../vscode/media/chat.js'),'utf8');
test('compacted context survives tool rounds and later turns without changing visible history',()=>{
 const history=[{role:'user',content:'OLDER_VISIBLE_MESSAGE'},{role:'assistant',content:'Older answer'},{role:'user',content:'Current goal'}];
 const ctx={busy:true,conv:{id:42,messages:history.slice()},agentMessages:[],activeRequestLength:3,activeRequestConvId:42,
  contextRevision:0,activeContextRevision:0,persist(){},saveConv(){},showStep(){},attachments:[],
  contTools:[{action:'read',path:'file.js',result:'FRESH_EXACT_SOURCE'}],pendingText:'Reading',agentRounds:0,pendingBubble:null,
  pickVoice:()=>({text:''}),post:(type,payload)=>{ctx.sent=payload.body.messages;}};
 const handler=ui.slice(ui.indexOf("      case 'contextCompacted': {"),ui.indexOf("      case 'contextProgress':"));
 const builder=ui.slice(ui.indexOf('  function buildRequestMessages('),ui.indexOf('  function renderChips('));
 const continuation=ui.slice(ui.indexOf('  function continueAgent('),ui.indexOf('  /* ---------- per-message actions'));
 vm.runInNewContext('function deliver(msg){switch(msg.type){'+handler+'}}\n'+builder+continuation,ctx);
 ctx.deliver({type:'contextCompacted',messages:[{role:'system',content:MEMORY_PREFIX+'\nOlder goal and constraints.'},{role:'user',content:'Current goal'}],before:500000,after:10000});
 assert.deepEqual(ctx.conv.messages,history);
 vm.runInNewContext('continueAgent()',ctx);
 assert.ok(ctx.sent.some(m=>m.content.includes('FRESH_EXACT_SOURCE')));
 assert.ok(ctx.sent.some(m=>m.content.includes(MEMORY_PREFIX)));
 assert.equal(ctx.sent.some(m=>m.content.includes('OLDER_VISIBLE_MESSAGE')),false);
 ctx.conv.messages.push({role:'assistant',content:'Finished step.'},{role:'user',content:'Next step please.'});
 const next=vm.runInNewContext('buildRequestMessages()',ctx);
 assert.equal(next.at(-1).content,'Next step please.');assert.equal(next.at(-2).content,'Finished step.');
 assert.equal(next.some(m=>m.content==='OLDER_VISIBLE_MESSAGE'),false);
 assert.equal(ctx.conv.messages[0].content,'OLDER_VISIBLE_MESSAGE');
});
