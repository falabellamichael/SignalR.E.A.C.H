'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {createCompanionChat}=require('../agent/companion-chat.cjs');
test('companion selects only saved workspace folders and never retargets old history',async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'companion-workspace-'));const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-project-'));const agents=new Map();let n=0;
 const store={get:id=>agents.get(id),create:value=>{const agent={...value,id:String(++n),messages:[]};agents.set(agent.id,agent);return agent;},update:(id,value)=>Object.assign(agents.get(id),value)};
 const options={profile,getProjects:()=>[{name:'Project',dir}],getStore:()=>store,getLoop:async id=>({sendUserMessage:async()=>{}}),stopLoop:()=>{},openStudio:async()=>{}};
 try{
  const chat=createCompanionChat(options);assert.equal((await chat.command('projects')).projects[0].dir,dir);
  await assert.rejects(chat.command('workspace',path.dirname(dir)),/saved Studio project/);
  await chat.command('workspace',dir);await chat.command('send','Hello');const id=chat.snapshot().agentId;assert.equal(agents.get(id).dir,dir);
  agents.get(id).runState={status:'running'};await assert.rejects(chat.command('workspace',''),/Stop/);agents.get(id).runState={status:'completed'};
  await chat.command('workspace','');assert.equal(chat.snapshot().agentId,'');assert.equal(agents.get(id).dir,dir);
  await chat.command('workspace',dir);assert.equal(createCompanionChat(options).snapshot().workspace,dir);
  await chat.command('new');assert.equal(chat.snapshot().workspace,dir);
 }finally{fs.rmSync(profile,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});}
});
