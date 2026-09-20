'use strict';
// Real Electron renderer, disposable profile, deterministic team events.
// No inference requests, saved conversations, or installed app are touched.
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-team-deck-ui-'));
const profile = path.join(root, 'profile'), project = path.join(root, 'project');
fs.mkdirSync(profile); fs.mkdirSync(project);
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [] }));
fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'Team UI fixture', dir: project }]));
const store = new AgentStore(path.join(profile, 'agents.json'));
const fixture = store.create({ name: 'Team interface preview', dir: project });
store.appendMessage(fixture.id, { role: 'user', content: 'Review the repository cleanup.' });
let win;
const errors = [];
app.on('browser-window-created', (_event, window) => {
  win = window;
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function until(code, message) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await run(code)) return; await delay(50); }
  throw new Error(message);
}
async function capture(name) {
  await delay(180);
  fs.writeFileSync(path.join(root, name + '.png'), (await win.capturePage()).toPNG());
  const rect = await run(`(() => { const r = previewRun.wrap.getBoundingClientRect(); return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.min(Math.floor(r.height), innerHeight - Math.ceil(r.y) - 100) }; })()`);
  if (rect.height > 0) fs.writeFileSync(path.join(root, name + '-deck.png'), (await win.capturePage(rect)).toPNG());
}
const timeout = setTimeout(() => { console.error('Team deck UI timed out'); app.exit(1); }, 60000);
(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  while (!win || win.webContents.isLoading()) await delay(50);
  await until('typeof ReachTeamDeck !== "undefined" && document.querySelector("#agent-project-select option") !== null', 'Renderer did not initialize');
  win.setContentSize(1440, 1024);
  await run(`(async () => { setDrawer(false); await showTab('agents'); await selectAgent({id:${JSON.stringify(fixture.id)}}); })()`);
  assert.equal(await run(`document.querySelector('#agent-model-info').open`), true);
  assert.equal(await run(`document.querySelector('#agent-info-summary-name').textContent`), 'Team interface preview');
  assert.equal(await run(`document.querySelector('#agent-info-summary-model').textContent`), 'Default model');
  assert.equal(await run(`getComputedStyle(document.querySelector('#agent-model-info')).position !== 'absolute'`), true);
  await run(`document.querySelector('#agent-model-info > summary').click()`);
  assert.equal(await run(`document.querySelector('#agent-model-info').open`), false);
  assert.equal(await run(`document.querySelector('#agent-name').textContent`), 'Team interface preview');
  await run(`document.querySelector('#agent-model-info > summary').click()`);
  await run(`(() => {
    startTeamRunView('deck-preview', { name: 'Team 1', mode: 'parallel' }, 'Repository cleanup · isolated preview');
    window.previewRun = activeTeamRun;
    window.previewEvent = event => handleTeamEvent({ teamRunId: 'deck-preview', ...event });
    previewEvent({ type: 'start', members: [
      { index: 0, agentId: 'm0-ceo', name: 'CEO', model: 'qwen-27b' }, { index: 1, agentId: 'm1-thinker', name: 'Thinker', model: 'qwen-35b' },
      { index: 2, agentId: 'm2-seeker', name: 'Seeker', model: 'deepseek-flash' }, { index: 3, agentId: 'm3-builder', name: 'Builder', model: 'deepseek-flash' },
      { index: 4, agentId: 'm4-reviewer', name: 'Reviewer', model: 'qwen-32b' }
    ] });
    for (const index of [0, 1, 2, 3]) {
      previewEvent({ type: 'member-start', index });
      previewEvent({ type: 'member', index, memberType: 'round', round: 2 });
      previewEvent({ type: 'member', index, memberType: 'request-start' });
    }
    previewEvent({ type: 'member', index: 0, memberType: 'tool-call', tool: 'agent.await' });
    previewEvent({ type: 'member', index: 1, memberType: 'reasoning', chars: 1248 });
    previewEvent({ type: 'member', index: 2, memberType: 'message-end', content: 'Repository settings read.' });
    previewEvent({ type: 'member', index: 2, memberType: 'tool-call', tool: 'read', arguments: {path: '.gitignore'} });
    previewEvent({ type: 'member', index: 2, memberType: 'tool-result', tool: 'read', ok: true, result: 'Read repository settings.' });
    previewEvent({ type: 'member', index: 2, memberType: 'request-start' });
    previewEvent({ type: 'member', index: 2, memberType: 'message-end', content: 'I’ve finished the repository cleanup. Three changes are ready for review.' });
    previewEvent({ type: 'member', index: 2, memberType: 'tool-call', tool: 'edit', arguments: {path: 'README.md'} });
    previewEvent({ type: 'member', index: 2, memberType: 'tool-result', tool: 'edit', ok: true, pending: true });
    previewEvent({ type: 'member-waiting', index: 2, edits: [{}, {}, {}] });
    previewEvent({ type: 'member', index: 3, memberType: 'message-end', content: 'Validation complete. All checks passed.' });
    previewEvent({ type: 'member-done', index: 3, ok: true, chars: 46 });
    window.previewDecisions = [];
    window.previewGroup = ensureEditReviewGroup({ key: 'team:deck-preview', host: previewRun.deck.reviews,
      title: 'Proposed changes', actor: 'Team 1', resolve: async (id, accepted) => { previewDecisions.push({id, accepted}); return {ok: true, accepted}; } });
    for (const [index, file] of ['.gitignore', 'README.md', 'docs/IMPROVEMENTS.md'].entries()) {
      appendEditCardToGroup(previewGroup, { editId: 'preview-edit-' + index, path: file, memberName: 'Seeker',
        stats: {added: [12,58,14][index], removed: [3,21,5][index]}, isNew: false,
        hunks: [{type:'del',text:'Clone the repository and install dependencies.'}, {type:'add',text:'Clone the repository, install dependencies, and run the setup script.'}] });
    }
    previewRun.deck.select(previewRun.cards.get(2));
    chatScroll.scrollTop = 0;
  })()`);
  await until(`document.querySelectorAll('.team-tab[data-status=working]').length === 2 && document.querySelector('.team-tab[data-status=waiting]')`, 'Tab states did not render');
  assert.equal(await run(`document.querySelectorAll('.member-card:not([hidden])').length`), 1);
  assert.equal(await run(`document.querySelector('.team-tab[aria-selected=true] .team-tab-name').textContent`), 'Seeker');
  assert.equal(await run(`document.querySelector('.team-tab[aria-selected=true] .team-tab-step').textContent`), 'Step 5');
  assert.equal(await run(`previewRun.wrap.querySelector('.team-model-info').open`), true);
  assert.equal(await run(`previewRun.wrap.querySelector('.team-model-summary-copy strong').textContent`), 'Seeker');
  assert.equal(await run(`previewRun.wrap.querySelector('.team-model-summary-model').textContent`), 'deepseek-flash');
  assert.match(await run(`previewRun.wrap.querySelector('.team-model-expanded-state').textContent`), /waiting|review/i);
  assert.equal(await run(`getComputedStyle(previewRun.cards.get(2).querySelector('.member-head')).display`), 'none');
  await run(`previewRun.wrap.querySelector('.team-model-info > summary').click()`);
  assert.equal(await run(`previewRun.wrap.querySelector('.team-model-info').open`), false);
  assert.equal(await run(`previewRun.cards.get(2).querySelector('.member-model').textContent`), 'deepseek-flash');
  await capture('desktop-collapsed');
  await run(`previewRun.wrap.querySelector('.team-model-info > summary').click()`);
  const sticky = await run(`(() => {
    const scroller = chatScroll, nav = previewRun.wrap.querySelector('.team-deck-nav');
    scroller.scrollTop = Math.min(180, scroller.scrollHeight - scroller.clientHeight);
    const scrollTop = scroller.getBoundingClientRect().top, navTop = nav.getBoundingClientRect().top;
    return { scrollTop, navTop, amount: scroller.scrollTop };
  })()`);
  assert.ok(sticky.amount > 0, 'Fixture must scroll to verify the stationary team information');
  assert.ok(sticky.navTop >= sticky.scrollTop - 1 && sticky.navTop <= sticky.scrollTop + 2, 'Team information stays pinned while the conversation scrolls');
  await run(`chatScroll.scrollTop=0`);
  assert.equal(await run(`previewRun.wrap.querySelector('.team-deck-nurse').hidden`), true);
  assert.equal(await run(`getComputedStyle(document.querySelector('.team-tab[data-status=working] .team-orbit-icon')).animationName`), 'activity-spin');
  assert.equal(await run(`getComputedStyle(document.querySelector('.team-tab[data-status=waiting] .team-orbit-icon')).animationName`), 'none');
  await capture('desktop-dark');
  await run(`previewRun.cards.get(2).querySelector('.activity-details').open=false; previewGroup.cards.get('preview-edit-1').element.open=true;`);
  await capture('desktop-review');
  await run(`previewRun.cards.get(2).querySelector('.activity-details').open=true; previewGroup.cards.get('preview-edit-1').element.open=false;`);
  // Roving focus, Home/End, wraparound, and selection never scroll the chat.
  await run(`document.querySelector('.team-tab[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
  assert.equal(await run(`document.activeElement.querySelector('.team-tab-name').textContent`), 'Reviewer');
  assert.ok(await run(`previewRun.wrap.querySelector('.team-tabs').scrollLeft > 0`));
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  assert.equal(await run(`document.activeElement.querySelector('.team-tab-name').textContent`), 'CEO');
  assert.equal(await run(`chatScroll.scrollTop`), 0);
  await run(`previewRun.wrap.querySelectorAll('.team-tab-scroll')[1].click()`);
  await until(`previewRun.wrap.querySelector('.team-tabs').scrollLeft > 100`, 'Scroll arrow did not move rail');
  await run(`previewRun.wrap.querySelector('.team-tabs').dispatchEvent(new WheelEvent('wheel',{deltaY:240,cancelable:true}))`);
  assert.ok(await run(`previewRun.wrap.querySelector('.team-tabs').scrollLeft > 200`));
  assert.equal(await run(`chatScroll.scrollTop`), 0);
  assert.equal(await run(`previewGroup.element.isConnected && previewGroup.element.getBoundingClientRect().height > 0`), true);
  // A background question must not steal the current tab, focus or text draft.
  await run(`composerInput.value = 'Keep this draft'; composerInput.focus(); previewEvent({type:'member-question',index:1,questionId:'preview-question',name:'Thinker',question:'Which test suite should I use?'});`);
  await until(`previewRun.wrap.querySelectorAll('.team-tab[data-status=waiting]').length === 2`, 'Question badge missing');
  assert.equal(await run(`document.activeElement === composerInput && composerInput.value === 'Keep this draft'`), true);
  // @ completion is a real combobox, keeps focus/draft ownership, and stable
  // ids distinguish duplicate/markup-like display names without creating HTML.
  const composerHeight = await run(`document.querySelector('.composer').getBoundingClientRect().height`);
  await run(`(() => {
    composerCatalog = [
      targetCandidate('team','deck-preview/m2-seeker','Seeker','Live member · working · deepseek-flash',{agentId:'m2-seeker',teamRunId:'deck-preview'}),
      targetCandidate('team','deck-preview/m4-reviewer','Reviewer','Live member · pending · qwen-32b',{agentId:'m4-reviewer',teamRunId:'deck-preview'}),
      targetCandidate('persona','persona-xss','<img src=x onerror="window.__mentionXss=1">','Custom agent · default model',{})
    ];
    composerCatalogKey = currentAgent.id + ':deck-preview'; composerCatalogAt = Date.now();
    composerInput.value='@'; composerInput.setSelectionRange(1,1); composerInput.focus();
    composerInput.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await until(`composerInput.getAttribute('aria-expanded') === 'true' && document.querySelectorAll('#composer-suggestions [role=option]').length === 3`, 'Composer suggestions did not open');
  assert.equal(await run(`document.activeElement === composerInput`), true);
  assert.equal(await run(`composerSuggestionsEl.getAttribute('role')`), 'listbox');
  assert.equal(await run(`composerInput.getAttribute('aria-controls')`), 'composer-suggestions');
  assert.equal(await run(`composerInput.getAttribute('aria-activedescendant')`), 'composer-suggestion-0');
  assert.equal(await run(`composerSuggestionsEl.querySelector('img,script') === null && window.__mentionXss === undefined`), true);
  assert.match(await run(`[...composerSuggestionsEl.querySelectorAll('.composer-suggestion-label')].map(x=>x.textContent).join('|')`), /<img src=x/);
  assert.match(await run(`document.querySelector('#composer-suggestions [role=option]').title`), /Live member/);
  assert.ok(Math.abs((await run(`document.querySelector('.composer').getBoundingClientRect().height`)) - composerHeight) <= 1, 'Popup must not resize composer');
  await run(`composerInput.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
  assert.equal(await run(`composerInput.getAttribute('aria-activedescendant')`), 'composer-suggestion-1');
  const completionBeforeEvent = await run(`({draft:composerInput.value,active:composerInput.getAttribute('aria-activedescendant'),selected:previewRun.wrap.querySelector('.team-tab[aria-selected=true] .team-tab-name').textContent})`);
  await run(`previewEvent({type:'member',index:0,memberType:'reasoning',chars:1400})`);
  assert.deepEqual(await run(`({draft:composerInput.value,active:composerInput.getAttribute('aria-activedescendant'),selected:previewRun.wrap.querySelector('.team-tab[aria-selected=true] .team-tab-name').textContent})`), completionBeforeEvent);
  assert.equal(await run(`document.querySelector('#btn-send').textContent`), 'Send', 'An explicit @ route remains actionable while the team works');
  await run(`composerInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  // Team suggestions sort by name: Reviewer first, Seeker after ArrowDown.
  assert.match(await run(`composerInput.value`), /^@team:"Seeker"#deck-preview\/m2-seeker /);
  assert.equal(await run(`document.activeElement === composerInput && composerInput.getAttribute('aria-expanded') === 'false'`), true);
  await run(`composerInput.value='ordinary unsent draft'; composerInput.dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(await run(`document.querySelector('#btn-send').textContent`), 'Stop', 'Ordinary text retains the existing stop control while work is active');
  await run(`composerInput.value='@'; composerInput.setSelectionRange(1,1); composerInput.dispatchEvent(new Event('input',{bubbles:true}))`);
  await until(`composerInput.getAttribute('aria-expanded') === 'true'`, 'Composer suggestions did not reopen');
  await run(`composerInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await run(`composerInput.value === '@' && composerInput.getAttribute('aria-expanded') === 'false'`), true);
  await run(`composerInput.value='Keep this draft'; composerInput.dispatchEvent(new Event('input',{bubbles:true})); composerInput.focus();`);
  await run(`previewRun.deck.select(previewRun.cards.get(1)); previewRun.cards.get(1).querySelector('textarea').value='Run unit tests'; previewRun.deck.select(previewRun.cards.get(2)); previewRun.deck.select(previewRun.cards.get(1));`);
  assert.equal(await run(`previewRun.cards.get(1).querySelector('textarea').value`), 'Run unit tests');
  await run(`previewEvent({type:'member-control',index:0,paused:true})`);
  await until(`previewRun.cards.get(0).dataset.teamStatus === 'paused'`, 'Paused tab missing');
  assert.equal(await run(`previewRun.cards.get(0).querySelector('.member-control').textContent`), 'Start');
  await run(`previewEvent({type:'member-control',index:0,paused:false})`);
  await until(`previewRun.cards.get(0).dataset.teamStatus === 'working'`, 'Resumed tab missing');
  // A live run temporarily detached from the chat keeps its activity history.
  await run(`previewRun.wrap.remove(); ReachActivity.select(null)`);
  await delay(200);
  assert.equal(await run(`ensureEditReviewGroup({key:'team:deck-preview',host:previewRun.deck.reviews}) === previewGroup`), true, 'Detached live reviews must retain their batch');
  await run(`renderChatHistory(); ReachActivity.select(currentAgent)`);
  await delay(200);
  assert.equal(await run(`previewRun.cards.get(2).querySelector('.activity-count').textContent.includes('5 steps')`), true);
  // Spawned workers use their own tab, and cannot switch the selected agent.
  await run(`previewRun.deck.select(previewRun.cards.get(2)); previewEvent({type:'subagent',agentId:'spawned',name:'A very long worker name',model:'provider/an-extremely-long-model-name-for-truncation',depth:2,netType:'agent-created'}); previewEvent({type:'subagent',agentId:'spawned',netType:'agent-state',status:'running'});`);
  assert.equal(await run(`previewRun.wrap.querySelectorAll('[role=tab]').length`), 6);
  assert.equal(await run(`previewRun.cards.get(2).hidden`), false);
  await run(`previewRun.deck.identify(previewRun.subCards.get('spawned'), '<b>literal name</b>', '<script>literal model</script>')`);
  assert.equal(await run(`previewRun.wrap.querySelector('.team-tab[data-worker=true] b, .team-tab[data-worker=true] script') === null`), true);
  await run(`previewRun.deck.identify(previewRun.subCards.get('spawned'), 'A very long worker name', 'provider/an-extremely-long-model-name-for-truncation')`);
  // Both minimum window and light theme keep the composer and tabs reachable.
  for (const theme of ['light', 'dark']) {
    win.setContentSize(1000, 640);
    await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; composerInput.value=''; previewRun.deck.select(previewRun.cards.get(2)); chatScroll.scrollTop=0;`);
    await delay(180);
    const geometry = await run(`(() => { const send = document.querySelector('#btn-send').getBoundingClientRect(); const deck = previewRun.wrap.getBoundingClientRect(); const panel = previewRun.cards.get(2).getBoundingClientRect(); return { overflow:document.body.scrollWidth>innerWidth, sendBottom:send.bottom, height:innerHeight, deck:deck.width, panel:panel.width, tabs:previewRun.wrap.querySelector('.team-tabs').clientWidth }; })()`);
    assert.equal(geometry.overflow, false);
    assert.ok(geometry.sendBottom <= geometry.height);
    assert.ok(Math.abs(geometry.deck - geometry.panel) <= 1);
    assert.ok(geometry.tabs > 150);
    await capture('narrow-' + theme);
  }
  // Reduced motion disables the ring, without removing readable state labels.
  win.webContents.setBackgroundThrottling(false);
  await win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
  assert.equal(await run(`getComputedStyle(document.querySelector('.team-tab[data-status=working] .team-orbit-icon')).animationName`), 'none');
  win.webContents.debugger.detach();
  // Nurse telemetry is one quiet heading badge. It must not create cards,
  // touch real provider activity/status, append chat/tool rows, or move tabs.
  const nurseBefore = await run(`(() => {
    const card = previewRun.cards.get(0), activity = card._teamActivity;
    return { cards:previewRun.cards.size, subCards:previewRun.subCards.size,
      tabs:previewRun.wrap.querySelectorAll('[role=tab]').length,
      updatedAt:activity.updatedAt, steps:activity.count, status:card.dataset.teamStatus,
      chatRows:previewRun.wrap.querySelectorAll('.chat-msg.system').length,
      toolRows:previewRun.wrap.querySelectorAll('.member-tool').length,
      selected:previewRun.wrap.querySelector('.team-tab[aria-selected=true] .team-tab-name').textContent };
  })()`);
  await run(`
    previewEvent({type:'nurse',nurseType:'handoff',action:'handoff',index:99,name:'Phantom',count:2,chars:900,silent:true,at:Date.now()+10000});
    previewEvent({type:'nurse',nurseType:'quarantine',action:'quarantine',index:0,name:'CEO',failureKind:'hard-provider',silent:true,at:Date.now()+20000});
    previewEvent({type:'nurse',nurseType:'quiet',action:'quiet',reason:'no-useful-work',silent:true,at:Date.now()+30000});
  `);
  const nurseAfter = await run(`(() => {
    const card = previewRun.cards.get(0), activity = card._teamActivity;
    return { cards:previewRun.cards.size, subCards:previewRun.subCards.size,
      tabs:previewRun.wrap.querySelectorAll('[role=tab]').length,
      updatedAt:activity.updatedAt, steps:activity.count, status:card.dataset.teamStatus,
      chatRows:previewRun.wrap.querySelectorAll('.chat-msg.system').length,
      toolRows:previewRun.wrap.querySelectorAll('.member-tool').length,
      selected:previewRun.wrap.querySelector('.team-tab[aria-selected=true] .team-tab-name').textContent };
  })()`);
  assert.deepEqual(nurseAfter, nurseBefore);
  assert.equal(await run(`previewRun.cards.has(99) || previewRun.subCards.has('Phantom')`), false);
  assert.equal(await run(`(() => { const b=previewRun.wrap.querySelector('.team-deck-nurse'); return !b.hidden && b.getAttribute('aria-live')==='off' && b.dataset.handoffs==='2' && b.dataset.wakes==='0' && b.dataset.skips==='1' && b.dataset.quiet==='1'; })()`), true);
  assert.match(await run(`previewRun.wrap.querySelector('.team-deck-nurse').textContent`), /no useful work/i);
  assert.match(await run(`previewRun.wrap.querySelector('.team-deck-nurse').getAttribute('aria-label')`), /2 handoffs.*1 retry avoided.*1 quiet decision/i);
  // A failed Links member remains visibly stalled. A Nurse wake uses the same
  // roster tab, while Nurse-origin round/revive notices stay out of chat.
  await run(`
    previewEvent({type:'member-start',index:4,name:'Reviewer',model:'qwen-32b'});
    previewEvent({type:'member-done',index:4,name:'Reviewer',model:'qwen-32b',ok:false,status:'stalled',error:'Provider timed out'});
  `);
  await until(`previewRun.cards.get(4).dataset.teamStatus === 'stalled'`, 'Stalled member state was not retained');
  assert.match(await run(`previewRun.deck.banner.textContent`), /1 stalled/);
  const nurseNoticeCount = await run(`previewRun.wrap.querySelectorAll('.chat-msg.system').length`);
  await run(`
    previewEvent({type:'subagent',netType:'agent-message',from:'m0-ceo',fromName:'CEO',to:'m1-architect',toName:'Architect',delivered:'mailbox-running',chars:33,messagesSent:1,messagesReceived:1,inbox:1});
    previewEvent({type:'subagent',netType:'agent-message',from:'m0-ceo',fromName:'CEO',to:'m4-reviewer',toName:'Reviewer',delivered:'stalled-wake',chars:42,messagesSent:1,messagesReceived:1,inbox:1});
    previewEvent({type:'nurse',nurseType:'wake-staged',action:'wake-staged',index:4,name:'Reviewer',sourceName:'CEO',silent:true});
    previewEvent({type:'links-round',round:1,waking:['Reviewer'],nurseWaking:['Reviewer'],silent:true,exchanges:0,budget:12});
    previewEvent({type:'links-revive',index:4,name:'Reviewer',model:'qwen-32b',messages:1,source:'nurse',silent:true});
    previewEvent({type:'nurse',nurseType:'wake-started',action:'wake-started',index:4,name:'Reviewer',silent:true});
    previewEvent({type:'member-start',index:4,name:'Reviewer',model:'qwen-32b',retake:true});
  `);
  await until(`previewRun.cards.get(4).dataset.teamStatus === 'working'`, 'Revived member did not return to working state');
  assert.equal(await run(`previewRun.wrap.querySelectorAll('.chat-msg.system').length`), nurseNoticeCount);
  assert.equal(await run(`(() => { const b=previewRun.wrap.querySelector('.team-deck-nurse'); return b.dataset.wakes==='1' && b.dataset.wakeStarted==='1'; })()`), true);
  assert.match(await run(`previewRun.wrap.querySelector('.team-deck-nurse').textContent`), /waking Reviewer/i);
  assert.match(await run(`previewRun.cards.get(0).querySelector('.member-body').textContent`), /queued for Architect/);
  assert.doesNotMatch(await run(`previewRun.cards.get(0).querySelector('.member-body').textContent`), /woke Architect/);
  assert.match(await run(`previewRun.cards.get(0).dataset.crewMeta`), /1 sent/);
  assert.match(await run(`previewRun.cards.get(4).dataset.crewMeta`), /1 received.*1 queued/);
  assert.equal(await run(`previewRun.subCards.has(undefined)`), false);
  // Existing bulk reviews still resolve exactly once through the shared group.
  await run(`previewGroup.rejectAll.click()`);
  await until(`previewDecisions.length === 3`, 'Bulk reject did not reach all files');
  assert.equal(await run(`previewDecisions.every(item => item.accepted === false)`), true);
  await run(`previewEvent({type:'member-resumed',index:2})`);
  await until(`previewRun.cards.get(2).dataset.teamStatus === 'working'`, 'Reviewed member did not regain live state');
  await run(`previewEvent({type:'member-done',index:2,ok:false,status:'error',error:'Fixture provider failed'}); previewEvent({type:'done',results:[{ok:true},{ok:false}],mode:'parallel'});`);
  await delay(200);
  assert.equal(await run(`activeTeamRun === null`), true);
  assert.equal(await run(`previewRun.wrap.querySelectorAll('.team-tab[data-status=working]').length`), 0);
  assert.equal(await run(`previewRun.cards.get(2).dataset.teamStatus`), 'error');
  assert.equal(await run(`previewRun.wrap.querySelectorAll('.member-control:not(:disabled)').length`), 0);
  await run(`previewRun.deck.select(previewRun.cards.get(3))`);
  assert.equal(await run(`previewRun.cards.get(3).querySelector('.member-body').textContent`), 'Validation complete. All checks passed.');
  assert.equal(await run(`previewRun.wrap.querySelectorAll('.member-card:not([hidden])').length`), 1);
  await capture('finished');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root,'results.json'), JSON.stringify({checks:['state fidelity','single panel','keyboard and overflow','background questions','draft preservation','pause/resume','history remount','spawned workers','narrow/light/dark','reduced motion','silent team nurse','bulk review','terminal outcomes'],errors},null,2));
  console.log('TEAM DECK UI PASS', root);
  clearTimeout(timeout); app.exit(0);
})().catch(error => { console.error(error.stack); console.error('Evidence:', root); clearTimeout(timeout); app.exit(1); });
