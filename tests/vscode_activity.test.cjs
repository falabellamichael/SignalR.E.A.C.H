const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../vscode/media/chat.js'),'utf8');
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.className='';this.handlers={};this.textContent='';}
 append(...nodes){nodes.forEach(n=>this.appendChild(n));}
 appendChild(n){this.children.push(n);n.parent=this;return n;}
 insertBefore(n,anchor){const i=this.children.indexOf(anchor);if(i<0)this.appendChild(n);else{this.children.splice(i,0,n);n.parent=this;}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(){}
 addEventListener(name,fn){this.handlers[name]=fn;}
 querySelector(selector){return this.children.find(n=>selector.startsWith('.')?n.className.split(' ').includes(selector.slice(1)):n.tag===selector)||this.children.map(n=>n.querySelector(selector)).find(Boolean);}
}
function host(){
 const log=new Element('main'),answer=new Element('div');log.appendChild(answer);
 const ctx={document:{createElement:t=>new Element(t)},log,stepsEl:null,stepRows:[],rowByUid:{},activeTrace:null,activeTraceConvId:null,activeResponseStep:null,
  // The webview has timers; the running-step ticker uses them (time is never
  // advanced here, so the stubs just need to exist).
  setInterval:()=>0,clearInterval:()=>{},Date,
  busy:true,activeRequestLength:1,conv:{id:9,messages:[{role:'user',content:'Inspect these files'}]},pendingBubble:{parentElement:answer},persist(){},saveConv(){},scrollBottom(){}};
 vm.runInNewContext(source.slice(source.indexOf('  /* ---- step analysis'),source.indexOf('  function beginToolRound(')),ctx);
 return {ctx,log,answer};
}
test('all activity steps and their results remain after completion and restore before the answer',()=>{
 const {ctx,log,answer}=host();
 const rows=Array.from({length:8},(_,i)=>ctx.addStepRow('read-'+i,'Read: file-'+i+'.js'));
 rows.forEach((row,i)=>ctx.closeStep(row,'FILE_'+i+'_RESULT'));
 const trace=ctx.conv.activity[0],region=log.children[0];
 assert.equal(trace.steps.length,8);assert.equal(log.children[1],answer);
 assert.equal(rows[6].outputEl.children[0].children[1].textContent,'FILE_6_RESULT');
 ctx.endStep();assert.equal(log.children[0],region,'completed timeline is not removed');
 assert.equal(ctx.conv.messages.length,1,'activity is separate from model conversation');
 ctx.log=new Element('main');ctx.restoreTimelines(1);
 assert.equal(ctx.log.children[0].children.length,9,'title plus all eight steps restored');
});
test('failures and cancelled operations remain distinct, and large results have explicit saved previews',()=>{
 const {ctx}=host();const failed=ctx.addStepRow('bad','Read: missing.js');
 ctx.closeStep(failed,'File not found.','error');
 const large=ctx.addStepRow('large','Read: large.js');ctx.closeStep(large,'SOURCE\n'.repeat(3000));
 const pending=ctx.addStepRow('waiting','Search workspace');
 ctx.endStep('cancelled');
 assert.equal(failed.record.status,'error');assert.equal(pending.record.status,'cancelled');
 assert.equal(large.record.result.length,12000);assert.equal(large.record.resultChars,21000);
 ctx.log=new Element('main');ctx.restoreTimelines(1);
 const restored=ctx.log.children[0].children[2];
 assert.match(restored.querySelector('.step-preview-note').textContent,/12,000 of 21,000/);
});
test('every step is numbered, gets a stable quip, and the current row is flagged',()=>{
 const {ctx}=host();
 const first=ctx.addStepRow('a','Read: src/app.js');
 const second=ctx.addStepRow('b','Search: TODO');
 assert.equal(first.record.index,1);assert.equal(second.record.index,2);
 assert.equal(first.record.quip,ctx.quipFor('read','a'),'the quip is a deterministic pick for the step');
 assert.equal(second.record.quip,ctx.quipFor('search','b'));
 assert.match(second.el.className,/current/);assert.doesNotMatch(first.el.className,/current/);
 const region=ctx.log.children[0],head=region.children[0];
 assert.equal(head.children[1].textContent,'Step 2');
 assert.match(head.children[2].className,/running/);
 ctx.closeStep(second,'SEARCH_RESULT');
 assert.match(first.el.className,/current/,'the marker moves to the row that is still open');
 assert.doesNotMatch(second.el.className,/current/);
});
test('a finished step keeps its data in a dropdown that stays open once the user opens it',()=>{
 const {ctx}=host();
 const row=ctx.addStepRow('x','Read: a.js');
 assert.equal(row.outputEl.textContent,'Waiting for result…','a running step stays live, never folded');
 ctx.closeStep(row,'FILE_CONTENTS');
 assert.match(row.stateEl.textContent,/^Done · /);
 const drop=row.outputEl.children[0];
 assert.equal(drop.className,'step-drop');
 assert.equal(drop.open,false,'folded by default');
 assert.match(drop.children[0].textContent,/^Result · /);
 assert.equal(drop.children[1].textContent,'FILE_CONTENTS','the data is kept inside the dropdown');
 drop.open=true;drop.handlers.toggle();
 ctx.updateStep(row,'completed','FILE_CONTENTS');
 const reopened=row.outputEl.children[0];
 assert.equal(reopened.open,true,'an opened dropdown is not folded again by an update');
 assert.equal(reopened.children[1].textContent,'FILE_CONTENTS');
});
test('failures and cancelled rows report their state in the open',()=>{
 const {ctx}=host();
 const failed=ctx.addStepRow('bad','Read: missing.js');
 ctx.closeStep(failed,'File not found.','error');
 assert.equal(failed.outputEl.children[0].open,true,'an error opens its own dropdown');
 const stopped=ctx.addStepRow('stop','Search workspace');
 ctx.closeStep(stopped,'Stopped.','cancelled');
 assert.equal(stopped.outputEl.children[0].open,false);
 assert.match(stopped.stateEl.textContent,/^Stopped · /);
});
test('the Agent plan drives the counter and groups the steps under its items',()=>{
 const {ctx}=host();
 ctx.addStepRow('a','Read: src/app.js');
 ctx.renderTodoCard([{text:'Read the parser',status:'in_progress'},{text:'Patch it',status:'pending'}]);
 const region=ctx.log.children[0],head=region.children[0];
 assert.equal(head.children[1].textContent,'Plan 1/2');
 const grouped=ctx.addStepRow('b','Read: src/parser.js');
 assert.equal(grouped.record.phase,'Plan 1/2 · Read the parser');
 const group=region.children.find(c=>c.className==='step-group');
 assert.ok(group);assert.equal(group.textContent,'Plan 1/2 · Read the parser');
 ctx.renderTodoCard([{text:'Read the parser',status:'completed'},{text:'Patch it',status:'in_progress'}]);
 assert.equal(head.children[1].textContent,'Plan 2/2');
 ctx.addStepRow('c','Apply: src/parser.js');
 const groups=region.children.filter(c=>c.className==='step-group');
 assert.equal(groups.length,2,'one group header per plan item, not per step');
 assert.equal(groups[1].textContent,'Plan 2/2 · Patch it');
});
test('numbering, quips and plan groups survive a reload of the timeline',()=>{
 const {ctx}=host();
 ctx.renderTodoCard([{text:'Do the thing',status:'in_progress'}]);
 const a=ctx.addStepRow('a','Read: src/app.js');
 const b=ctx.addStepRow('b','Search: TODO');
 ctx.closeStep(a,'A_RESULT');ctx.closeStep(b,'B_RESULT');
 const quipA=a.record.quip,quipB=b.record.quip;
 ctx.endStep();
 ctx.log=new Element('main');
 ctx.restoreTimelines(1);
 const region=ctx.log.children[0];
 const rows=region.children.filter(c=>c.className.includes('step-line'));
 assert.equal(rows.length,2);
 assert.equal(rows[0].children[0].children[1].textContent,'1.','numbering is stored, not renumbered');
 assert.equal(rows[1].children[0].children[1].textContent,'2.');
 assert.equal(rows[0].children[1].textContent,quipA,'the same quip comes back after a reload');
 assert.equal(rows[1].children[1].textContent,quipB);
 assert.equal(region.children[0].children[1].textContent,'2 steps','a finished timeline freezes to a count');
 assert.equal(region.children.filter(c=>c.className==='step-group').length,1);
});
test('a running step shows live progress from the host instead of only elapsed time',()=>{
 const {ctx}=host();
 const row=ctx.addStepRow('seg','Compress context · segment 2 of 4');
 assert.equal(row.outputEl.textContent,'Waiting for result…','before any progress arrives');
 ctx.noteStep('seg','Thinking through the segment · 4,000 characters received');
 assert.equal(row.outputEl.textContent,'Thinking through the segment · 4,000 characters received');
 ctx.startRunningTicker(row);
 assert.match(row.outputEl.textContent,/^Thinking through the segment · 4,000 characters received · \d+s elapsed$/);
 ctx.noteStep('seg','Writing the summary · 120 characters received');
 ctx.startRunningTicker(row);
 assert.match(row.outputEl.textContent,/^Writing the summary · 120 characters received · \d+s elapsed$/);
 const finished=ctx.addStepRow('done-seg','Compress context · segment 1 of 4');
 ctx.closeStep(finished,'Updated conversation memory.');
 ctx.noteStep('done-seg','late note');
 assert.equal(finished.outputEl.children[0].className,'step-drop','a closed row ignores late notes');
});
