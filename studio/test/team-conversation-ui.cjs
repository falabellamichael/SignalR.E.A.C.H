'use strict';
// Real main/preload/renderer with a disposable profile and local fake provider.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-team-conversation-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
let win, held = false;
const requests = [], releases = [], errors = [];
const server = http.createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  if (held) await new Promise(resolve => releases.push(resolve));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'complete', message: 'Remembered answer: COBALT-742.', actions: [], options: [] }) }, finish_reason: 'stop' }] }));
});
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, label) {
  for (let i = 0; i < 200; i++) { if (await run(code)) return; await delay(25); }
  throw new Error(label);
}
const timeout = setTimeout(() => { console.error('Team conversation UI timed out', root); app.exit(1); }, 60000);
async function send(text) {
  await run(`composerInput.value=${JSON.stringify(text)}; composerInput.dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.equal(await run(`document.querySelector('#btn-send').textContent`), 'Send');
  await run('sendComposer()');
}
async function finish() { await until('activeTeamRun === null && !composerIntentPending', 'Team did not finish'); }
function transcript(start = 0) { return requests.slice(start).map(r => r.messages.map(m => m.content).join('\n')).join('\n'); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-model', telemetrySources: [] }));
  fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Team chat fixture', dir: project }]));
  const store = new AgentStore(path.join(profile, 'agents.json'));
  const fixture = store.create({ name: 'Team follow-ups', dir: project });
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(30);
  await until('typeof ReachTeamComposer !== "undefined" && document.querySelector("#agent-project-select option")', 'Renderer did not initialize');
  win.setContentSize(1280, 850);
  await run(`(async () => {
    setDrawer(false); await showTab('agents'); await selectAgent({id:${JSON.stringify(fixture.id)}});
    const a=await reachApi.personas.create({name:'Reader',model:'fixture-model',prompt:'Read.'});
    const b=await reachApi.personas.create({name:'Coordinator',model:'fixture-model',prompt:'Coordinate.'});
    const t=await reachApi.teams.create({name:'Team1',mode:'parallel',members:[{personaId:a.persona.id},{personaId:b.persona.id,roleId:'coordinator'}]});
    window.fixtureTeam=t.team; await loadCreatePage();
  })()`);
  assert.equal(await run(`document.querySelector('#team-chat-toggle').getAttribute('aria-checked')`), 'false');
  await run('ReachTeamComposer.open()');
  assert.equal(await run('ReachTeamComposer.enabled()'), false, 'the arrow does not toggle routing');
  assert.equal(await run(`document.querySelector('#team-chat-menu-button').getAttribute('aria-expanded')`), 'true');
  await run(`document.querySelector('#team-chat-toggle').click()`);
  await until('ReachTeamComposer.enabled()', 'Team toggle was not saved');
  assert.equal(await run(`document.querySelector('#composer-model').disabled`), true);
  await send('Compare the first options: INDIGO-319.'); await finish();
  assert.equal(requests.length, 2, 'normal Send dispatched the two team members');
  assert.match(transcript(), /INDIGO-319/);
  const second = requests.length;
  await send('Explain your previous answer.'); await finish();
  assert.match(transcript(second), /INDIGO-319/);
  assert.match(transcript(second), /COBALT-742/);
  assert.match(transcript(second), /LATEST USER MESSAGE:\nExplain your previous answer/);
  let saved = JSON.parse(fs.readFileSync(path.join(profile,'agents.json'),'utf8')).agents.find(a=>a.id===fixture.id);
  assert.equal(saved.messages.filter(m=>m.role==='user').length, 2);
  assert.equal(saved.messages.filter(m=>m.role==='assistant').length, 2, 'answers are persisted once');
  await run(`selectAgent({id:${JSON.stringify(fixture.id)}})`);
  assert.equal(await run('ReachTeamComposer.enabled()'), true, 'team selection survives reopening the chat');
  await run(`document.querySelector('#team-chat-history').checked=false; document.querySelector('#team-chat-history').dispatchEvent(new Event('change'));`);
  await until('currentAgent.settings.teamChat.useHistory === false', 'History preference was not saved');
  const fresh = requests.length;
  await send('A separate question: VIOLET-551.'); await finish();
  assert.doesNotMatch(transcript(fresh), /INDIGO-319|COBALT-742/);
  await run(`document.querySelector('#team-chat-toggle').click()`);
  await until('!ReachTeamComposer.enabled()', 'Team toggle did not turn off');
  const solo = requests.length;
  await send('An ordinary chat question.');
  await until('!agentRunning && currentAgent.runState.status === "completed"', 'Ordinary chat did not complete');
  assert.equal(requests.length - solo, 1);
  assert.doesNotMatch(transcript(solo), /CREW CONTEXT/);

  // Live follow-up uses the existing network and persists the guidance once.
  await run(`(async()=>{ await reachApi.teams.update(fixtureTeam.id,{mode:'links'}); await loadCreatePage(); document.querySelector('#team-chat-toggle').click(); })()`);
  await until('ReachTeamComposer.enabled()', 'Team toggle did not return on');
  held = true;
  await send('Wait for my next guidance.');
  await until('activeTeamRun?.cards.size === 2', 'Links members did not start');
  await send('Live guidance: use AMBER-603.');
  assert.equal(await run('activeTeamRun !== null'), true);
  const liveStatus = await run('reachApi.teams.members(activeTeamRun.teamRunId)');
  assert.ok(liveStatus.agents.find(a=>a.name==='Coordinator').messagesReceived >= 1);
  await run(`document.querySelector('#team-chat-recipient').value='selected'; document.querySelector('#team-chat-recipient').dispatchEvent(new Event('change')); activeTeamRun.deck.select(activeTeamRun.cards.get(0));`);
  await until('currentAgent.settings.teamChat.liveTarget === "selected" && !ReachTeamComposer.saving()', 'Recipient selection did not save');
  await send('Selected member guidance: GOLD-817.');
  const selectedStatus = await run('reachApi.teams.members(activeTeamRun.teamRunId)');
  assert.equal(selectedStatus.agents.find(a=>a.name==='Reader').messagesReceived, 1);
  assert.equal(selectedStatus.agents.find(a=>a.name==='Coordinator').messagesReceived, 1);
  const foreign = await run(`(async()=>{ const other=await reachApi.agents.create('Other chat',currentAgent.dir,''); return reachApi.teams.followup({teamRunId:activeTeamRun.teamRunId,teamId:fixtureTeam.id,agentId:other.agent.id,message:'Wrong conversation'}); })()`);
  assert.equal(foreign.ok, false);
  assert.match(foreign.err, /does not belong/);
  held = false; for (const release of releases.splice(0)) release(); await finish();
  assert.match(transcript(), /AMBER-603/);
  saved = JSON.parse(fs.readFileSync(path.join(profile,'agents.json'),'utf8')).agents.find(a=>a.id===fixture.id);
  assert.equal(saved.messages.filter(m=>m.content==='Live guidance: use AMBER-603.').length, 1);

  // A stale/deleted selection rejects Send without losing its draft or routing
  // that text into individual chat or another available team.
  const beforeRejected = requests.length;
  await run(`(async()=>{ await reachApi.teams.delete(fixtureTeam.id); await loadCreatePage(); })()`);
  await send('Keep this unsent draft.');
  assert.equal(requests.length, beforeRejected);
  assert.equal(await run('composerInput.value'), 'Keep this unsent draft.');
  await run(`(async()=>{ const p=await reachApi.personas.list(); const t=await reachApi.teams.create({name:'Team1',mode:'links',members:p.map(a=>({personaId:a.id}))}); await reachApi.agents.update(currentAgent.id,{settings:{teamChat:{enabled:true,teamId:t.team.id}}}); await selectAgent({id:currentAgent.id}); await loadCreatePage(); })()`);

  // Menu stays within the composer at both desktop and narrow app widths.
  for (const width of [1280,1000]) {
    win.setContentSize(width, 780); await run('ReachTeamComposer.open()'); await delay(100);
    const rect = await run(`(()=>{const r=document.querySelector('#team-chat-menu').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:innerWidth};})()`);
    assert.ok(rect.left>=0 && rect.right<=rect.width && rect.top>=0);
    fs.writeFileSync(path.join(root, `team-menu-${width}.png`), (await win.capturePage()).toPNG());
  }
  assert.deepEqual(errors, []);
  console.log('TEAM CONVERSATION UI PASS', root);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(0);
})().catch(error => { console.error(error.stack); console.error('Evidence:',root); clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(1); });
