'use strict';
(() => {
 const pet=new window.ReachCliPet.Pet(),canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),label=document.querySelector('#pet-status');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');let motion=true,lastActivity='idle';
 window.petWindow.onState(state=>{
   if(state.theme?.vars){
     for(const [key,value] of Object.entries(state.theme.vars))document.documentElement.style.setProperty('--'+key,value);
     document.documentElement.style.colorScheme=state.theme.scheme;
     document.documentElement.dataset.theme=state.theme.theme;
   }
   if(state.kind)pet.select(state.kind);motion=state.motion!==false;
   if(state.activity && state.activity!==lastActivity){pet.setActivity(state.activity);lastActivity=state.activity;}
 });
 document.querySelector('#pet-close').onclick=()=>window.petWindow.command('close');
 document.querySelectorAll('[data-care]').forEach(b=>b.onclick=()=>{pet.care(b.dataset.care);paint();});
 function paint(){const state=pet.snapshot(motion&&!reduced.matches);ctx.clearRect(0,0,264,72);ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--gold').trim()||'#d5e895';for(const [x,y]of window.ReachCliPet.pixels(state))ctx.fillRect(x*6,y*6,5,5);if(label.textContent!==state.status)label.textContent=state.status;}
 function tick(){paint();setTimeout(tick,160);}window.petWindow.command('ready');tick();
})();
