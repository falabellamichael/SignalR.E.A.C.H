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
// Keep the native integration deterministic and entirely local. The separate
// priority unit tests cover the real Jev request/response contract.
require('../agent/jev-team-priority.cjs').decideTeamPriority = async ({ message }) => ({ steer: message.startsWith('Correction:'), reason: message.startsWith('Correction:') ? 'important' : 'can-wait', probability: message.startsWith('Correction:') ? 0.95 : 0.1 });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-team-conversation-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
let win, held = false, failureMode = false;
const requests = [], releases = [], errors = [];
const server = http.createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  if (failureMode) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorMessage: 'Fixture provider is temporarily unavailable.', status: 400, code: 'FIXTURE_UNAVAILABLE' }));
    return;
  }
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
const run = async code => {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (error) { console.error('Renderer expression failed:', code.slice(0, 240)); throw error; }
};
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
  await run(`window.firstDeck = document.querySelector('#team-deck-slot .team-deck'); window.firstRail = firstDeck.querySelector('.team-deck-nav'); window.firstTab = firstDeck.querySelector('.team-tab');`);
  const second = requests.length;
  await send('Explain your previous answer.'); await finish();
  assert.equal(await run(`document.querySelectorAll('#team-deck-slot .team-deck').length`), 1, 'Follow-up reuses the existing team deck');
  assert.equal(await run(`document.querySelector('#team-deck-slot .team-deck') === firstDeck && firstDeck.querySelector('.team-deck-nav') === firstRail && firstDeck.querySelector('.team-tab') === firstTab`), true, 'Deck, rail and member tabs retain their DOM identity');
  assert.equal(await run(`firstDeck.querySelectorAll('.team-tabs > .team-tab').length`), 2);
  assert.equal(await run(`firstDeck.querySelector('.team-run-history').open`), false, 'Earlier work starts collapsed');
  assert.match(await run(`firstDeck.querySelector('.team-run-history').textContent`), /COBALT-742/);
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

  // Auto works during parallel runs, retaining ordinary messages for the next
  // turn while injecting important guidance into the currently working member.
  await run(`document.querySelector('#team-chat-toggle').click()`);
  await until('ReachTeamComposer.enabled()', 'Team toggle did not return on');
  const autoStart = requests.length;
  held = true; await send('Work on the current task.');
  await until('activeTeamRun?.cards.size === 2', 'Parallel members did not start');
  while (requests.length < autoStart + 2) await delay(25);
  await send('Later: write the follow-up notes.');
  await until(`document.querySelector('#team-message-queue').textContent.includes('Jev: can wait')`, 'Auto follow-up was not queued');
  assert.equal(requests.length, autoStart + 2);
  saved = JSON.parse(fs.readFileSync(path.join(profile,'agents.json'),'utf8')).agents.find(a=>a.id===fixture.id);
  assert.equal(saved.teamMessageQueue[0].message, 'Later: write the follow-up notes.');
  await send('Correction: use SILVER-428 now.');
  for (let i = 0; i < 200 && !transcript(autoStart).includes('SILVER-428'); i++) await delay(25);
  assert.match(transcript(autoStart), /SILVER-428/);
  assert.equal(requests.length, autoStart + 3, 'Only the steered member restarts its request');
  await until(`activeTeamRun.wrap.querySelector('.team-deck-nurse').dataset.userHandoffs === '1'`, 'Nurse delivery receipt missing');
  assert.match(await run(`activeTeamRun.wrap.querySelector('.team-deck-nurse').title`), /without restart penalty/);
  assert.match(transcript(autoStart + 2), /TEAM NURSE USER HANDOFF/);
  await send('Remove this pending follow-up.');
  await until(`document.querySelectorAll('.team-queued-message').length === 2`, 'Second queue row missing');
  await run(`Array.from(document.querySelectorAll('.team-queued-message')).find(row=>row.textContent.includes('Remove this pending')).querySelector('button:last-child').click()`);
  await until(`document.querySelectorAll('.team-queued-message').length === 1`, 'Queued message was not removed');
  win.showInactive(); await delay(200);
  const queueRect = await run(`(()=>{const r=document.querySelector('#team-message-queue').getBoundingClientRect(); return {height:r.height,left:r.left,right:r.right,top:r.top,width:innerWidth};})()`);
  assert.ok(queueRect.height > 0 && queueRect.height <= 150 && queueRect.left >= 0 && queueRect.right <= queueRect.width && queueRect.top >= 0);
  fs.writeFileSync(path.join(root, 'team-auto-queue.png'), (await win.capturePage()).toPNG());
  held = false; for (const release of releases.splice(0)) release();
  await until(`activeTeamRun === null && !composerIntentPending && document.querySelector('#team-message-queue').classList.contains('hidden')`, 'Queued follow-up did not finish');
  assert.equal(requests.length, autoStart + 5, 'Queued turn starts each member exactly once');
  assert.match(transcript(autoStart + 3), /Later: write the follow-up notes/);
  assert.doesNotMatch(transcript(autoStart), /Remove this pending follow-up/);
  saved = JSON.parse(fs.readFileSync(path.join(profile,'agents.json'),'utf8')).agents.find(a=>a.id===fixture.id);
  assert.equal(saved.messages.filter(m=>m.content==='Correction: use SILVER-428 now.').length, 1);
  assert.equal(saved.messages.filter(m=>m.content==='Later: write the follow-up notes.').length, 1);

  // Explicit steering also works in Links, with coordinator and selected-member
  // routing. It persists guidance once and rejects foreign conversations.
  await run(`(async()=>{ await reachApi.teams.update(fixtureTeam.id,{mode:'links'}); await loadCreatePage(); document.querySelector('#team-chat-delivery').value='steer'; document.querySelector('#team-chat-delivery').dispatchEvent(new Event('change')); })()`);
  await until('currentAgent.settings.teamChat.deliveryMode === "steer" && !ReachTeamComposer.saving()', 'Steer mode did not save');
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

  // An all-failed team must remain a failed run, with readable diagnostics and
  // no fabricated assistant reply in the conversation or persisted history.
  saved = JSON.parse(fs.readFileSync(path.join(profile,'agents.json'),'utf8')).agents.find(a=>a.id===fixture.id);
  const answersBeforeFailure = saved.messages.filter(message => message.role === 'assistant').length;
  failureMode = true;
  await send('Try the unavailable provider.'); await finish();
  saved = JSON.parse(fs.readFileSync(path.join(profile,'agents.json'),'utf8')).agents.find(a=>a.id===fixture.id);
  assert.equal(saved.messages.filter(message => message.role === 'assistant').length, answersBeforeFailure);
  assert.equal(await run(`teamConversationViews.get(currentAgent.id).wrap.dataset.finished`), 'error');
  const failedView = await run(`(() => {
    const deck=teamConversationViews.get(currentAgent.id).wrap;
    return {text:deck.textContent,states:[...deck.querySelectorAll('.member-state')].map(node=>node.textContent),
      restore:[...deck.querySelectorAll('button')].some(button=>button.textContent==='Restore request'),
      connections:[...deck.querySelectorAll('button')].some(button=>button.textContent==='Check connections')};
  })()`);
  assert.match(failedView.text, /could not produce an answer/i);
  assert.ok(failedView.states.some(state => state.includes('Fixture provider is temporarily unavailable.')));
  assert.doesNotMatch(failedView.text, /errorMessage|FIXTURE_UNAVAILABLE|\{"/);
  assert.equal(failedView.restore && failedView.connections, true);
  const nestedError = await run(`teamErrorSummary('CodeGPT: '+JSON.stringify({error:{message:'Provider stream busy.'},token:'private-fixture'}))`);
  assert.equal(nestedError, 'CodeGPT: Provider stream busy.');
  await run(`([...teamConversationViews.get(currentAgent.id).wrap.querySelectorAll('button')]
    .find(button=>button.textContent==='Check connections')).click()`);
  await until(`document.querySelector('#page-settings').classList.contains('active')
    && !document.querySelector('#settings-connection').classList.contains('hidden')`, 'Check connections did not open connection settings');
  await run(`showTab('agents')`);
  const requestsBeforeRestore = requests.length;
  await run(`([...teamConversationViews.get(currentAgent.id).wrap.querySelectorAll('button')]
    .find(button=>button.textContent==='Restore request')).click()`);
  assert.equal(await run('composerInput.value'), 'Try the unavailable provider.');
  assert.equal(requests.length, requestsBeforeRestore, 'restoring the prompt never resends it');
  await run(`composerInput.value=''; composerInput.dispatchEvent(new Event('input',{bubbles:true}));`);

  // Menu stays within the composer at both desktop and narrow app widths.
  for (const width of [1280,1000]) {
    win.setContentSize(width, 780); await run('ReachTeamComposer.open()'); await delay(100);
    const rect = await run(`(()=>{const r=document.querySelector('#team-chat-menu').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:innerWidth};})()`);
    assert.ok(rect.left>=0 && rect.right<=rect.width && rect.top>=0);
    fs.writeFileSync(path.join(root, `team-menu-${width}.png`), (await win.capturePage()).toPNG());
  }
  // Real Settings form, persistence and conversation overrides use one schema.
  await run(`openSettingsPanel('budgeting')`);
  const engineWrite = await run(`reachApi.files.write(currentAgent.id,'engine-smoke.txt','local engine fixture')`);
  assert.equal(engineWrite.ok, true);
  const engineDeny = await run(`reachApi.files.write(currentAgent.id,'.env','must not land')`);
  assert.equal(engineDeny.ok, false);
  assert.equal(fs.existsSync(path.join(project, '.env')), false);
  await run(`document.querySelector('#engine-status').open=true; document.querySelector('#btn-engine-report').click();`);
  await until(`document.querySelector('#engine-report').textContent.includes('receipts')`, 'Engine report did not load');
  const engineReport = await run(`reachApi.engines.report()`);
  assert.ok(engineReport.receipts >= 1);
  assert.ok(engineReport.claims >= 1, 'Team completions are recorded as unverified claims');
  assert.equal(engineReport.modelCalls, 0);
  assert.equal(engineReport.persistenceError, null);
  await run(`document.querySelector('#engine-status').open=false;`);
  await run(`document.querySelector('#budget-scope').value='global'; document.querySelector('#budget-scope').dispatchEvent(new Event('change'));`);
  assert.equal(await run(`document.querySelector('#budget-messageHandoffs').value`), '9');
  assert.equal(await run(`document.querySelector('#budget-messageHandoffs').closest('fieldset').querySelector('legend').textContent`), 'Teams');
  await run(`document.querySelector('#budget-messageHandoffs').value='27'; document.querySelector('#btn-save-budgets').click();`);
  await until(`document.querySelector('#budget-status').textContent.startsWith('Saved.')`, 'Handoff budget did not save');
  assert.equal(await run(`(async()=> (await reachApi.getSettings()).budgets.messageHandoffs)()`), 27);
  await run(`openSettingsPanel('budgeting')`);
  assert.equal(await run(`document.querySelector('#budget-messageHandoffs').value`), '27');
  await run(`document.querySelector('#budget-messageHandoffs').closest('fieldset').scrollIntoView({block:'start'});`);
  await delay(120); fs.writeFileSync(path.join(root, 'team-handoff-budget.png'), (await win.capturePage()).toPNG());
  await run(`document.querySelector('#budget-scope').value='conversation'; document.querySelector('#budget-scope').dispatchEvent(new Event('change')); document.querySelector('#budget-inherit').checked=false; document.querySelector('#budget-inherit').dispatchEvent(new Event('change')); document.querySelector('#budget-messageHandoffs').value='0'; document.querySelector('#btn-save-budgets').click();`);
  await until(`document.querySelector('#budget-status').textContent.startsWith('Saved.')`, 'Conversation handoff override did not save');
  assert.equal(await run(`(async()=> (await reachApi.agents.get(currentAgent.id)).settings.budgetOverrides.messageHandoffs)()`), 0);
  assert.equal(await run(`(async()=> (await reachApi.getSettings()).budgets.messageHandoffs)()`), 27);
  assert.deepEqual(errors, []);
  console.log('TEAM CONVERSATION UI PASS', root);
  clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(0);
})().catch(error => { console.error(error.stack); console.error('Evidence:',root); clearTimeout(timeout); server.closeAllConnections(); server.close(); app.exit(1); });
