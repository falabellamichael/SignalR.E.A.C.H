'use strict';
(() => {
 const pet=new window.ReachCliPet.Pet(),canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),label=document.querySelector('#pet-status');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');let motion=true,lastActivity='idle';
 const api=window.petWindow,expand=document.querySelector('#pet-expand'),panel=document.querySelector('#companion-panel');
 const input=document.querySelector('#companion-input'),messages=document.querySelector('#companion-messages'),progress=document.querySelector('#companion-progress');
 let expanded=false,running=false,sending=false,stream=null,draftTimer=0,draftWrites=Promise.resolve();
 const connectionPanel=window.ReachAppConnections.mount(document.querySelector('#companion-app-connections'),(action,value)=>api.appConnections(action,value));
 const report=error=>{progress.textContent=error?.message||String(error);};
 async function chat(action,value){const result=await api.chat(action,value);if(result?.ok===false)throw new Error(result.err);return result;}
 const updateControls=()=>{document.querySelector('#companion-send').disabled=running||sending||!input.value.trim();document.querySelector('#companion-stop').hidden=!running;document.querySelector('#companion-new').disabled=running||sending;input.readOnly=sending;};
 const activityHost=document.createElement('section');activityHost.setAttribute('aria-label','Agent activity');
 const activityView=window.ReachCompanionActivity.mount(activityHost);activityView.snapshot(null);
 function renderMessage(article,text,streaming=false){
  const wasOpen=article.querySelector('.companion-response-details')?.open===true;
  article.replaceChildren();article.classList.toggle('streaming',streaming);const content=document.createElement('div');content.innerHTML=window.ReachMarkdown.render(text);
  if(article.dataset.secondary==='true'){
   const details=document.createElement('details');details.className='companion-response-details';details.open=wasOpen;
   const summary=document.createElement('summary');const title=document.createElement('span');title.className='companion-response-title';title.textContent='Additional response';summary.append(title);
   if(article._primaryTools)summary.append(article._primaryTools);
   details.append(summary,content);article.append(details);
  }else article.append(content);
  if(article.classList.contains('assistant')&&text&&!streaming){const tools=document.createElement('div');tools.className='companion-message-tools';const copy=document.createElement('button');copy.type='button';copy.textContent='Copy response';copy.onclick=async()=>{try{await navigator.clipboard.writeText(text);copy.textContent='Copied';}catch{report(new Error('Clipboard unavailable. Select the response to copy it.'));}};tools.append(copy);(article.querySelector('.companion-response-details')||article).append(tools);}
 }
 function bubble(role,text){
  const article=document.createElement('article');article.className='companion-message '+role;
  if(role==='assistant'){
   for(let previous=messages.lastElementChild;previous;previous=previous.previousElementSibling){
    if(previous.classList.contains('user'))break;
    if(previous.classList.contains('assistant')){article.dataset.secondary='true';break;}
   }
  }
  if(article.dataset.secondary==='true'){
   let previous=messages.lastElementChild;
   while(previous&&!previous.classList.contains('assistant')&&!previous.classList.contains('user'))previous=previous.previousElementSibling;
   const tools=previous?.querySelector(':scope > .companion-message-tools');
   if(tools){article._primaryTools=tools;tools.addEventListener('click',event=>event.stopPropagation());}
  }
  renderMessage(article,text);messages.append(article);return article;
 }
 function snapshot(state,initial=false){
  if(!state)return;const follow=messages.scrollHeight-messages.scrollTop-messages.clientHeight<65;
  messages.replaceChildren();stream=null;
  const history=state.messages||[];
  let promptIndex=-1;
  for(let i=0;i<history.length;i++)if(history[i].role==='user')promptIndex=i;
  for(let i=0;i<history.length;i++){
   bubble(history[i].role,history[i].text);
   if(i===promptIndex&&state.activity)messages.append(activityHost);
  }
  if(!state.messages?.length){const empty=document.createElement('p');empty.className='companion-empty';empty.textContent='A little help, right here. Ask a question or connect an app.';messages.append(empty);}
  activityView.snapshot(state.activity||null);if(!activityHost.isConnected)messages.append(activityHost);
  running=state.running===true;if(initial)input.value=state.draft||'';
  document.querySelector('#companion-model').textContent=state.model||'Uses your active Studio model';
  progress.textContent=state.error||(running?'Thinking…':'');
  if(follow)messages.scrollTop=messages.scrollHeight;updateControls();
 }
 api.onChat(event=>{
  if(event.type==='snapshot'){snapshot(event);return;}
  activityView.event(event);if(!activityHost.isConnected)messages.append(activityHost);
  if(event.type==='message-start'){if(stream)renderMessage(stream,stream.dataset.text||'');stream=null;return;}
  if(event.type==='delta'){
   const follow=messages.scrollHeight-messages.scrollTop-messages.clientHeight<65;
   if(!stream){stream=bubble('assistant','');stream.dataset.text='';}
   stream.dataset.text+=event.text;renderMessage(stream,stream.dataset.text,true);
   if(follow)messages.scrollTop=messages.scrollHeight;
   progress.textContent='Replying…';return;
  }
  if(event.type==='approval-wait')progress.textContent='Approval required. Open in Studio to review this action.';
  if(event.type==='tool-call')progress.textContent='Using '+event.tool+'…';
  if(event.type==='reasoning')progress.textContent='Thinking…';
  if(event.type==='error')progress.textContent=event.message;
 });
 window.petWindow.onState(state=>{
   if(state.theme?.vars){
     for(const [key,value] of Object.entries(state.theme.vars))document.documentElement.style.setProperty('--'+key,value);
     document.documentElement.style.colorScheme=state.theme.scheme;
     document.documentElement.dataset.theme=state.theme.theme;
   }
   if(state.kind)pet.select(state.kind);motion=state.motion!==false;
   if(state.activity && state.activity!==lastActivity){pet.setActivity(state.activity);lastActivity=state.activity;}
   const wasExpanded=expanded;expanded=state.expanded===true;panel.hidden=!expanded;document.body.classList.toggle('expanded',expanded);document.body.classList.toggle('expand-up',expanded&&state.expandUp===true);document.body.classList.toggle('expand-left',expanded&&state.expandLeft===true);
   expand.setAttribute('aria-expanded',String(expanded));expand.setAttribute('aria-label',expanded?'Collapse mini-chat':'Expand mini-chat');expand.title=expanded?'Collapse mini-chat':'Expand mini-chat';
   if(expanded&&!wasExpanded)input.focus();
 });
 expand.onclick=()=>api.command('expand',!expanded).catch(report);
 const tabs=['chat','connections','workspace'];let currentView='chat';
 async function refreshProjects(){
  const list=document.querySelector('#companion-projects'),current=document.querySelector('#companion-workspace-current');
  try{
   const state=await chat('projects');list.replaceChildren();current.textContent=state.workspace?'Current folder: '+state.workspace:'No workspace selected';
   for(const project of [{name:'No workspace',dir:''},...(state.projects||[])]){
    const row=document.createElement('button');row.type='button';row.className='companion-project';row.disabled=running||sending;
    row.setAttribute('aria-pressed',String(project.dir===(state.workspace||'')));
    const title=document.createElement('strong');title.textContent=project.name;const folder=document.createElement('span');folder.textContent=project.dir||'General companion chat';row.append(title,folder);
    row.onclick=async()=>{row.disabled=true;try{clearTimeout(draftTimer);await saveDraft();const next=await chat('workspace',project.dir);snapshot(next,true);await refreshProjects();}catch(error){current.textContent=error.message;row.disabled=running||sending;}};list.append(row);
   }
   if(!state.projects?.length){const note=document.createElement('p');note.className='companion-caption';note.textContent='No saved projects yet. Add a project in REACH Studio, then refresh.';list.append(note);}
  }catch(error){current.textContent=error.message;}
 }
 function view(name){
  currentView=name;for(const tab of tabs){document.querySelector('#companion-'+tab).hidden=tab!==name;const button=document.querySelector('#companion-'+tab+'-tab');button.setAttribute('aria-selected',String(tab===name));button.tabIndex=tab===name?0:-1;}
  if(name==='connections')connectionPanel.refresh();else if(name==='workspace')refreshProjects();else input.focus();
 }
 for(const tab of tabs)document.querySelector('#companion-'+tab+'-tab').onclick=()=>view(tab);
 document.querySelector('#companion-workspace-refresh').onclick=refreshProjects;
 document.querySelector('[role=tablist]').onkeydown=event=>{if(['ArrowRight','ArrowLeft','Home','End'].includes(event.key)){event.preventDefault();let index=tabs.indexOf(currentView);index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;view(tabs[index]);document.querySelector('#companion-'+tabs[index]+'-tab').focus();}};
 function saveDraft(){const text=input.value;draftWrites=draftWrites.catch(()=>{}).then(()=>chat('draft',text));draftWrites.catch(report);return draftWrites;}
 input.oninput=()=>{clearTimeout(draftTimer);draftTimer=setTimeout(saveDraft,180);updateControls();};
 input.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();document.querySelector('#companion-form').requestSubmit();}if(event.key==='Escape'){event.preventDefault();api.command('expand',false).catch(report);}};
 document.querySelector('#companion-form').onsubmit=async event=>{
  event.preventDefault();if(running||sending||!input.value.trim())return;
  sending=true;updateControls();clearTimeout(draftTimer);
  try{await saveDraft();const text=input.value;const result=await chat('send',text);if(!result.stopped)input.value='';}catch(error){report(error);}finally{sending=false;updateControls();input.focus();}
 };
 document.querySelector('#companion-stop').onclick=()=>chat('stop').catch(report);
 document.querySelector('#companion-new').onclick=()=>{clearTimeout(draftTimer);draftWrites.finally(()=>chat('new').then(state=>snapshot(state,true))).catch(report);};
 document.querySelector('#companion-open').onclick=()=>chat('open').catch(report);
 messages.addEventListener('click',event=>{const link=event.target.closest('a[href]');if(link){event.preventDefault();api.openLink(link.href).catch(report);}});
 window.addEventListener('blur',()=>{clearTimeout(draftTimer);saveDraft();});
 chat('get').then(state=>snapshot(state,true)).catch(report);
 document.querySelector('#pet-close').onclick=()=>{clearTimeout(draftTimer);saveDraft().finally(()=>api.command('close')).catch(report);};
 document.querySelectorAll('[data-care]').forEach(b=>b.onclick=()=>{pet.care(b.dataset.care);paint();});
 function paint(){const state=pet.snapshot(motion&&!reduced.matches);ctx.clearRect(0,0,264,72);ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--gold').trim()||'#d5e895';for(const [x,y]of window.ReachCliPet.pixels(state))ctx.fillRect(x*6,y*6,5,5);if(label.textContent!==state.status)label.textContent=state.status;}
 function tick(){paint();setTimeout(tick,160);}window.petWindow.command('ready');tick();
})();
