'use strict';
// Real backend + renderer, two chats using the same saved team concurrently.
// Local held provider and disposable profile: no installed user data touched.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-team-concurrency-'));
app.setPath('userData', root);
let win;
const errors = [], pending = [], requests = [];
const server = http.createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.end(JSON.stringify({data:[{id:'fixture-model'}]})); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const text = body.messages.map(m => m.content).join('\n');
  const chat = text.includes('BETA') ? 'BETA' : text.includes('GAMMA') ? 'GAMMA' : 'ALPHA';
  requests.push({chat,text});
  await new Promise(resolve => pending.push({chat,resolve}));
  if (res.destroyed) return;
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({status:'complete',message:`Answer for ${chat}`,actions:[],options:[]})},finish_reason:'stop'}]}));
});
const release = chat => { for (const item of pending.filter(x=>x.chat===chat)) item.resolve(); };
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i=0;i<200;i++) { if (await run(code)) return; await delay(30); }
  throw new Error(label);
}
const timeout = setTimeout(()=>{console.error('Concurrent teams timed out',root);app.exit(1);},60000);
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({theme:'light',endpoint:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model',telemetrySources:[]}));
  fs.writeFileSync(path.join(root,'projects.json'),JSON.stringify([{name:'Fixture',dir:root}]));
  const store = new AgentStore(path.join(root,'agents.json'));
  const first=store.create({name:'Chat A',dir:root}), second=store.create({name:'Chat B',dir:root});
  await import(pathToFileURL(path.resolve(__dirname,'../main.mjs')).href);
  await app.whenReady();
  while(!win||win.webContents.isLoading()) await delay(30);
  await until('typeof ReachTeamComposer !== "undefined" && document.querySelector("#agent-project-select option")','Renderer did not load');
  await run(`(async()=>{
    setDrawer(false); await showTab('agents');
    const p=await reachApi.personas.create({name:'Worker',model:'fixture-model',prompt:'Answer.'});
    const t=await reachApi.teams.create({name:'Shared team',mode:'parallel',members:[{personaId:p.persona.id}]});
    window.testTeam=t.team;
    for(const id of ${JSON.stringify([first.id,second.id])}) await reachApi.agents.update(id,{settings:{teamChat:{enabled:true,teamId:t.team.id}}});
    await loadCreatePage(); await selectAgent({id:${JSON.stringify(first.id)}});
    composerInput.value='ALPHA task'; await sendComposer(); window.runA=activeTeamRun;
  })()`);
  await until('runA?.cards.size===1','First team did not start');
  await run(`(async()=>{
    await selectAgent({id:${JSON.stringify(second.id)}});
    window.freshChatClean = activeTeamRun===null && !chatLog.querySelector('.team-deck');
    composerInput.value='BETA task'; await sendComposer(); window.runB=activeTeamRun;
  })()`);
  assert.equal(await run('freshChatClean'),true,'A new chat must not inherit another chat’s deck');
  await until('runB?.cards.size===1 && teamRunViews.size===2','Both chats must run their own team');
  assert.equal(await run('runA.teamRunId!==runB.teamRunId && runA.deck!==runB.deck'),true);
  assert.equal(await run('runA.deck.ended'),false,'Starting B must not finish A');
  assert.equal(await run(`chatLog.querySelectorAll('.team-deck').length`),1);
  assert.equal(await run(`document.querySelectorAll('#btn-stop-team').length`),1);
  const aStatus=await run('reachApi.teams.members(runA.teamRunId)');
  assert.equal(aStatus.ok,true); assert.equal(aStatus.paused,false);
  // Background output, spawned workers, questions and edit review stay in A.
  await run(`(()=>{
    composerInput.value='B draft'; composerInput.focus();
    handleTeamEvent({teamRunId:runA.teamRunId,type:'member',index:0,memberType:'reasoning',chars:3141});
    handleTeamEvent({teamRunId:runA.teamRunId,type:'member-question',index:0,questionId:'a-question',name:'Worker',question:'ALPHA question'});
    handleTeamEvent({teamRunId:runA.teamRunId,type:'subagent',netType:'agent-created',agentId:'a-child',name:'A child',model:'fixture-model',task:'ALPHA child'});
    handleTeamEditPending({teamRunId:runA.teamRunId,edit:{editId:'a-review',path:'a.txt',stats:{added:1,removed:0},hunks:[{type:'add',text:'ALPHA edit'}]}});
  })()`);
  assert.equal(await run(`document.activeElement===composerInput && composerInput.value==='B draft'`),true);
  assert.equal(await run('runA.subCards.size===1 && runB.subCards.size===0'),true);
  assert.match(await run('runA.wrap.textContent'),/ALPHA question/);
  assert.doesNotMatch(await run('chatLog.textContent'),/ALPHA question|ALPHA edit|A child/);
  // Stop in B is scoped; A keeps working. Resume B so both can finish normally.
  await run(`(async()=>{composerInput.value=''; await sendComposer();})()`);
  await until('runB.paused','B did not pause');
  assert.equal((await run('reachApi.teams.members(runA.teamRunId)')).paused,false);
  await run('reachApi.teams.start(runB.teamRunId)');
  await until('!runB.paused','B did not resume');
  await run(`selectAgent({id:${JSON.stringify(first.id)}})`);
  assert.equal(await run('activeTeamRun===runA && chatLog.contains(runA.wrap) && !runB.wrap.isConnected'),true);
  assert.match(await run('chatLog.textContent'),/ALPHA question/);
  // Finishing background B must not clear A or append B's answer to A.
  release('BETA');
  await until('runB.deck.ended && !teamRunViews.has(runB.teamRunId)','Background B did not complete');
  assert.equal(await run('activeTeamRun===runA && !runA.deck.ended'),true);
  assert.doesNotMatch(await run('chatLog.textContent'),/Answer for BETA/);
  release('ALPHA');
  await until('activeTeamRun===null && runA.deck.ended','A did not complete');
  const saved=JSON.parse(fs.readFileSync(path.join(root,'agents.json'),'utf8')).agents;
  for(const [id,label,other] of [[first.id,'ALPHA','BETA'],[second.id,'BETA','ALPHA']]){
    const messages=saved.find(a=>a.id===id).messages.map(m=>m.content).join('\n');
    assert.match(messages,new RegExp(`Answer for ${label}`)); assert.doesNotMatch(messages,new RegExp(other));
  }
  await run(`selectAgent({id:${JSON.stringify(second.id)}})`);
  assert.equal(await run('chatLog.contains(runB.wrap) && activeTeamRun===null'),true,'Completed chat retains its own deck');
  // Async validation cannot admit two simultaneous starts for the same chat.
  const race=await run(`(async()=>{
    const c=await reachApi.agents.create('Chat C',currentAgent.dir,'');
    const results=await Promise.all([1,2].map(()=>reachApi.teams.run(testTeam.id,'GAMMA task',currentAgent.dir,c.agent.id)));
    const success=results.find(r=>r.ok); if(success) startTeamRunView(success.teamRunId,testTeam,'GAMMA task',c.agent.id);
    window.raceRunId=success?.teamRunId; return results;
  })()`);
  assert.equal(race.filter(r=>r.ok).length,1,'Only one start per conversation');
  assert.match(race.find(r=>!r.ok).err,/already starting|already running/);
  release('GAMMA');
  assert.deepEqual(errors,[]);
  console.log('CONCURRENT TEAM CHATS UI PASS',root);
  clearTimeout(timeout); server.closeAllConnections();server.close();app.exit(0);
})().catch(error=>{console.error(error.stack,root,errors);clearTimeout(timeout);server.closeAllConnections();server.close();app.exit(1);});
