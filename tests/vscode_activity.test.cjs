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
 vm.runInNewContext(source.slice(source.indexOf('  function createTimeline('),source.indexOf('  function beginToolRound(')),ctx);
 return {ctx,log,answer};
}
test('all activity steps and their results remain after completion and restore before the answer',()=>{
 const {ctx,log,answer}=host();
 const rows=Array.from({length:8},(_,i)=>ctx.addStepRow('read-'+i,'Read: file-'+i+'.js'));
 rows.forEach((row,i)=>ctx.closeStep(row,'FILE_'+i+'_RESULT'));
 const trace=ctx.conv.activity[0],region=log.children[0];
 assert.equal(trace.steps.length,8);assert.equal(log.children[1],answer);
 assert.equal(rows[6].outputEl.children[0].textContent,'FILE_6_RESULT');
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
