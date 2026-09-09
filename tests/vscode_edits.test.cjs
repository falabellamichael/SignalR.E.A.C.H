const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../vscode/media/chat.js'),'utf8');
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.disabled=false;this.className='';this.handlers={};this.classList={add:c=>{this.className+=' '+c;}};}
 append(...nodes){nodes.forEach(n=>this.appendChild(n));}
 appendChild(n){this.children.push(n);n.parent=this;return n;}
 insertBefore(n,after){const idx=this.children.indexOf(after);if(idx<0)this.appendChild(n);else{this.children.splice(idx,0,n);n.parent=this;}}
 closest(cls){return this.className.split(' ').includes(cls.slice(1))?this:this.parent?.closest(cls);}
 setAttribute(){}
 addEventListener(type,handler){this.handlers[type]=handler;}
 click(){if(!this.disabled)return this.handlers.click?.();}
 remove(){this.parent.children=this.parent.children.filter(n=>n!==this);}
 querySelector(cls){return this.children.find(n=>n.className.split(' ').includes(cls.slice(1)))||this.children.map(n=>n.querySelector(cls)).find(Boolean);}
}
function render(){
 const log=new Element('main'),anchor=new Element('div');log.appendChild(anchor);
 const calls=[];const ctx={document:{createElement:t=>new Element(t)},log,editCards:{},post:(type,p)=>calls.push({type,...p}),scrollBottom(){},endStep(){},showStep(){},busy:false,conv:{model:'test-model'},appliedEdits:[],anchor,edits:[0,1,2].map(i=>({path:'same.js',search:'old'+i,replace:'new'+i}))};
 const code=source.slice(source.indexOf('  function diffLines('),source.indexOf('  /* ---------- rich rendering'));
 vm.runInNewContext(code+'\nrenderEditCards(anchor,edits);',ctx);
 const handler=source.slice(source.indexOf("      case 'editRefreshed': {"),source.indexOf('      default:',source.indexOf("      case 'editRefreshed': {")));
 vm.runInNewContext('function deliver(msg){switch(msg.type){'+handler+'}}',ctx);
 return {ctx,calls,records:Object.values(ctx.editCards),bar:log.children[1].children[0],batch:log.children[1]};
}
test('Reject prevents later Apply all and proposals keep their original order',async()=>{
 const h=render();
 assert.equal(h.batch.children[1],h.records[0].card);
 h.records[0].card.querySelector('.reject').click();
 const applying=h.bar.querySelector('.apply').click();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].search,'old1');
 h.records[1].finish(true);
 await Promise.resolve();
 assert.equal(h.calls.length,2);assert.equal(h.calls[1].search,'old2');
 h.records[2].finish(true);await applying;
 assert.equal(h.records[0].state,'rejected');
 assert.equal(h.bar.querySelector('.apply').disabled,true);
});
test('Reject all cancels queued edits while an already submitted apply finishes',async()=>{
 const h=render();const applying=h.bar.querySelector('.apply').click();
 assert.equal(h.calls.length,1);
 h.bar.querySelector('.reject').click();
 assert.deepEqual(h.records.map(r=>r.state),['applying','rejected','rejected']);
 h.records[0].finish(true);await applying;
 assert.equal(h.calls.length,1,'no rejected edit reaches the file-writing handler');
 assert.equal(h.bar.querySelector('.reject').disabled,true);
});
test('failed edits can be rejected and a failed batch stops before the next write',async()=>{
 const h=render();const applying=h.bar.querySelector('.apply').click();
 h.records[0].finish(false);await applying;
 assert.equal(h.calls.length,1);
 assert.equal(h.records[0].card.querySelector('.reject').disabled,false);
 h.bar.querySelector('.reject').click();
 assert.ok(h.records.every(r=>r.state==='rejected'));
});

const {locateEdit,repairWindow}=require('../vscode/edits');
test('exact edits handle LF proposals on CRLF files without changing indentation',()=>{
 const current='before\r\n  one\r\n  two\r\nafter\r\n';
 const change=locateEdit(current,'  one\n  two','  three\n  four');
 assert.equal(current.slice(0,change.start)+change.text+current.slice(change.end),'before\r\n  three\r\n  four\r\nafter\r\n');
 assert.throws(()=>locateEdit(current,'one\ntwo','wrong'),/no longer matches/);
});
test('ambiguous and empty anchors never choose an arbitrary location',()=>{
 assert.throws(()=>locateEdit('same\nsame','same','other'),/more than once/);
 assert.throws(()=>locateEdit('aaa','aa','other'),/more than once/);
 assert.throws(()=>locateEdit('existing','','new file'),/already exists/);
 assert.throws(()=>repairWindow('x'.repeat(9000),'missing source'),/Could not locate/);
});

test('a failed review exposes Refresh and a refreshed proposal requires a separate Apply',()=>{
 const h=render();const rec=h.records[0];const uid=Object.keys(h.ctx.editCards)[0];
 h.ctx.deliver({type:'editResult',uid,reviewed:true,error:'Proposal no longer matches.'});
 const refresh=rec.card.querySelector('.refresh');
 assert.equal(refresh.hidden,false);assert.equal(refresh.disabled,false);
 refresh.click();assert.equal(h.calls[0].type,'refreshEdit');assert.equal(refresh.disabled,true);
 h.ctx.deliver({type:'editRefreshed',uid,edit:{path:'same.js',search:'current',replace:'corrected'}});
 assert.equal(rec.state,'rejected');assert.equal(h.calls.length,1,'refresh does not apply');
 const fresh=Object.values(h.ctx.editCards).at(-1);fresh.card.querySelector('.apply').click();
 assert.equal(h.calls[1].type,'applyEdit');assert.equal(h.calls[1].search,'current');
});
