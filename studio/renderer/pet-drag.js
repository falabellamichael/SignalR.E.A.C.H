'use strict';
/* Native app-region drag consumes wheel events. Pointer dragging keeps both inputs independent. */
(() => {
 const interactive='button,input,textarea,select,a,summary,label,[contenteditable=true],.companion-message>div:not(.companion-message-tools),.companion-response-details>div,.step-head,.step-output,.step-result,.steps-head,.app-connection-card p,.app-connection-card h3,#pet-status,#companion-progress,.companion-caption';
 let drag=null;
 function end(){
  if(!drag)return;
  const session=drag;drag=null;document.body.classList.remove('pet-dragging');
  window.petWindow.command('drag-end').catch(()=>{});
  try{document.body.releasePointerCapture(session.id);}catch{}
 }
 document.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.target.closest(interactive))return;
  // Keep the native scrollbar thumb and track interactive too.
  for(let el=event.target;el&&el!==document.body;el=el.parentElement){const r=el.getBoundingClientRect();if(el.scrollHeight>el.clientHeight&&event.clientX>=r.left+el.clientWidth)return;}
  end();
  const session={id:event.pointerId,x:event.screenX,y:event.screenY,started:false,pending:false};drag=session;
  document.body.setPointerCapture(event.pointerId);
  // Record the original desktop cursor before movement, without moving the window on a click.
  session.ready=window.petWindow.command('drag-start').catch(()=>{if(drag===session)end();});
 });
 document.addEventListener('pointermove',async event=>{
  const session=drag;
  if(!session||session.id!==event.pointerId||session.pending)return;
  if(!session.started&&Math.hypot(event.screenX-session.x,event.screenY-session.y)<4)return;
  session.pending=true;
  try{
   await session.ready;
   if(drag!==session)return;
   session.started=true;document.body.classList.add('pet-dragging');
   await window.petWindow.command('drag-move');
  }catch{if(drag===session)end();}finally{session.pending=false;}
 });
 document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);document.body.addEventListener('lostpointercapture',end);window.addEventListener('blur',end);
 // Wheel input always wins over an in-progress window drag; its default scrolling is untouched.
 document.addEventListener('wheel',end,{passive:true,capture:true});
})();
