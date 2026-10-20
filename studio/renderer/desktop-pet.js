'use strict';
(() => {
  const api=window.ReachCliPet;
  const enabled=document.querySelector('#set-desktop-pet');
  if(!api || !enabled) return;
  const species=document.querySelector('#set-desktop-pet-kind'), motion=document.querySelector('#set-desktop-pet-motion');
  const native=window.reach?.pet;
  const KEY='reach.desktop-pet.v1';
  let prefs={enabled:false,kind:'cat',motion:true,x:null,y:null};
  try {const saved=JSON.parse(localStorage.getItem(KEY)||'null');if(saved) Object.assign(prefs,saved);} catch {}
  if(!api.names[prefs.kind]) prefs.kind='cat';
  const pet=new api.Pet();pet.select(prefs.kind);
  const host=document.createElement('aside');host.className='desktop-pet';host.setAttribute('aria-label','CLI companion');
  const handle=document.createElement('button');handle.type='button';handle.className='desktop-pet-handle';handle.setAttribute('aria-label','Move pet. Drag or use arrow keys.');
  const canvas=document.createElement('canvas');canvas.width=264;canvas.height=72;canvas.setAttribute('aria-hidden','true');handle.append(canvas);
  const label=document.createElement('div');label.className='desktop-pet-status';label.setAttribute('role','status');
  const care=document.createElement('div');care.className='desktop-pet-care';
  for(const [action,title] of [['feed','Feed'],['pet','Pat'],['treat','Treat']]) {const b=document.createElement('button');b.type='button';b.textContent=title;b.onclick=()=>{pet.care(action);paint();};care.append(b);}
  host.append(handle,label,care);document.body.append(host);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const save=()=>{try {localStorage.setItem(KEY,JSON.stringify(prefs));}catch{}};
  function place() {
    const width=host.offsetWidth||284,height=host.offsetHeight||145;
    const x=Number.isFinite(prefs.x)?prefs.x:innerWidth-width-24;
    const y=Number.isFinite(prefs.y)?prefs.y:innerHeight-height-80;
    prefs.x=Math.max(0,Math.min(x,Math.max(0,innerWidth-width)));prefs.y=Math.max(0,Math.min(y,Math.max(0,innerHeight-height)));
    host.style.left=prefs.x+'px';host.style.top=prefs.y+'px';
  }
  let timer=null;
  function sync() {
    enabled.checked=prefs.enabled===true;species.value=prefs.kind;motion.checked=prefs.motion!==false;
    host.hidden=!!native||!enabled.checked;species.disabled=motion.disabled=!enabled.checked;
    pet.select(prefs.kind);clearTimeout(timer);timer=null;
    if(enabled.checked) {place();tick();}
  }
  function activity() {
    const agent=typeof currentAgent!=='undefined'?currentAgent:null;
    if(!agent) return 'idle';
    const s=agent.activity;
    const run=agent.runState?.status;
    if(run==='running') {
      const step=s?.steps?.at(-1);
      if(step?.status==='waiting') return 'blocked';
      if(step?.kind==='tool' && !step.endedAt) {
        const tool=String(step.tool||'');
        return /search|find/.test(tool)?'searching':/read|browse|fetch|list/.test(tool)?'reading':/write|edit|patch/.test(tool)?'writing':/test|check/.test(tool)?'checking':'running';
      }
      return step?.chars>0?'responding':step?.reasoning>0?'thinking':'waiting';
    }
    if(['waiting_input','waiting_edits'].includes(run)) return 'blocked';
    // Terminal activity is emitted once per run, rather than reset on every paint.
    const key=agent.id+':'+run+':'+(s?.endedAt||agent.runState?.endedAt||'');
    if(['completed','error','stopped','paused','stalled'].includes(run)) {
      if(key!==terminalKey) {terminalKey=key;return run==='completed'?'complete':run==='error'?'error':'cancelled';}
      return null;
    }
    return 'idle';
  }
  let terminalKey='', lastActivity='', lastAgent='';
  function paint() {
    const state=pet.snapshot(prefs.motion!==false&&!reduced.matches);
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,264,72);
    ctx.fillStyle=getComputedStyle(host).color;
    for(const [x,y] of api.pixels(state)) ctx.fillRect(x*6,y*6,5,5);
    if(label.textContent!==state.status) label.textContent=state.status;
    host.dataset.behavior=state.behavior;host.dataset.kind=state.kind;
  }
  function tick() {
    if(!prefs.enabled || document.hidden&&!native) return;
    const agent=typeof currentAgent!=='undefined'?currentAgent:null;
    if(lastAgent!==(agent?.id||'')) {lastAgent=agent?.id||'';terminalKey='';lastActivity='';pet.setActivity('idle');}
    const a=activity();if(a && a!==lastActivity) {pet.setActivity(a);lastActivity=a;if(native)native.command('activity',a);}
    if(!native)paint();timer=setTimeout(tick,160);
  }
  const configure=()=>{save();sync();if(native)native.command('configure',{enabled:prefs.enabled,kind:prefs.kind,motion:prefs.motion});};
  enabled.onchange=()=>{prefs.enabled=enabled.checked;configure();};
  species.onchange=()=>{prefs.kind=species.value;configure();};
  motion.onchange=()=>{prefs.motion=motion.checked;configure();};
  document.querySelector('#btn-desktop-pet-reset').onclick=()=>{if(native){native.command('reset');return;}prefs.x=prefs.y=null;place();save();};
  let drag=null;
  handle.onpointerdown=e=>{if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:prefs.x,top:prefs.y};handle.setPointerCapture(e.pointerId);host.classList.add('dragging');};
  handle.onpointermove=e=>{if(!drag||drag.id!==e.pointerId)return;prefs.x=drag.left+e.clientX-drag.x;prefs.y=drag.top+e.clientY-drag.y;place();};
  const end=()=>{if(!drag)return;drag=null;host.classList.remove('dragging');save();};
  handle.onpointerup=end;handle.onpointercancel=end;handle.onlostpointercapture=end;
  handle.onkeydown=e=>{const d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!d)return;e.preventDefault();prefs.x+=d[0]*(e.shiftKey?30:10);prefs.y+=d[1]*(e.shiftKey?30:10);place();save();};
  document.querySelector('#composer-input')?.addEventListener('input',e=>{if(e.target.value && !['waiting','thinking','responding','searching','reading','writing','running','checking'].includes(pet.activity)) {pet.setActivity('typing');if(native)native.command('activity','typing');else paint();}});
  addEventListener('resize',()=>{if(prefs.enabled){place();save();}});
  document.addEventListener('visibilitychange',()=>{clearTimeout(timer);timer=null;if((!document.hidden||native)&&prefs.enabled)tick();});
  reduced.addEventListener('change',()=>{if(prefs.enabled)paint();});
  if(native){
    const receive=state=>{Object.assign(prefs,{enabled:state.enabled,kind:state.kind,motion:state.motion});save();sync();};
    native.onState(receive);native.command('get').then(receive);
  }
  sync();
})();
