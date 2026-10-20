'use strict';
/* VS Code's step timeline vocabulary, backed by Studio's shared activity reducer. */
(() => {
 function mount(host) {
  let state=null;
  const rows=new Map();
  const header=document.createElement('div');header.className='steps-head';
  const title=document.createElement('strong');title.className='steps-title';title.textContent='Agent activity';
  const chip=document.createElement('span');chip.className='steps-chip';chip.setAttribute('role','status');
  const progress=document.createElement('div');progress.className='step-progress';progress.append(document.createElement('i'));
  header.append(title,chip,progress);const list=document.createElement('div');host.append(header,list);host.className='steps';
  function render(next) {
   state=next;host.hidden=!state;
   if(!state){list.replaceChildren();rows.clear();return;}
   const summary=window.ReachActivityState.summary(state);chip.textContent=summary.title;
   host.classList.toggle('running',summary.active&&!summary.waiting&&!summary.silent);
   const keep=new Set();
   for(const record of state.steps||[]) {
    const key=String(record.index);keep.add(key);let row=rows.get(key);
    if(!row){
     const el=document.createElement('article'),head=document.createElement('div');head.className='step-head';
     const dot=document.createElement('i');dot.className='mini-spin';dot.setAttribute('aria-hidden','true');
     const number=document.createElement('span');number.className='step-num';number.textContent=key+'.';
     const text=document.createElement('span');text.className='step-text';const status=document.createElement('span');status.className='step-state';
     head.append(dot,number,text,status);const note=document.createElement('p');note.className='step-output';
     const details=document.createElement('details');details.className='step-details';const label=document.createElement('summary');label.textContent='View result';const result=document.createElement('pre');result.className='step-result';details.append(label,result);
     el.append(head,note,details);list.append(el);row={el,text,status,note,details,result};rows.set(key,row);
    }
    const status=record.status==='done'?'completed':record.status==='paused'?'cancelled':record.status;
    row.el.className='step-line '+status+(!record.endedAt?' current':'');row.text.textContent=record.title||'Working';row.status.textContent=status==='running'?'Running':status==='waiting'?'Waiting':status==='completed'?'Done':status==='error'?'Failed':'Stopped';
    row.note.textContent=record.note||'';row.note.hidden=!record.note;
    row.details.hidden=record.result==null;row.result.textContent=record.result==null?'':String(record.result);
   }
   for(const [key,row]of rows)if(!keep.has(key)){row.el.remove();rows.delete(key);}
  }
  return {snapshot:render,event(event){if(event.type==='message-start'&&state?.status!=='running')state=null;const next=window.ReachActivityState.reduce(state,event);if(next)render(next);},refresh(){if(state)render(state);}};
 }
 window.ReachCompanionActivity={mount};
})();
