const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../vscode/media/chat.js'), 'utf8');
const doneCase = source.slice(source.indexOf("      case 'done': {"), source.indexOf("      case 'toolResult': {"));
function host() {
 const calls=[],steps=[],panels=[];
 const ctx={includeWorkspace:true,busy:true,rafPending:false,stopRequested:false,agenticEnabled:true,pendingEdits:[],pendingText:'',pendingBubble:{},
  agentRounds:0,continuationRetries:0,MAX_AGENT_ROUNDS:40,UNFINISHED_RETRY_LIMIT:2,activeResponseStep:null,
  conv:{id:1,model:'test',messages:[{role:'user',content:'Clean up the CLI modules and tests.'}]},
  agentMessages:[{role:'user',content:'Clean up the CLI modules and tests.'}],contTools:[],
  setRich(){},showThinking(){},showStep:(...args)=>steps.push(args),saveConv(){},hint(){},
  pickFun:()=>'',ABORT_LINES:[],post:(type,payload)=>calls.push({type,...payload}),
  beginToolRound:tools=>calls.push({type:'tools',tools}),
  finishBubble:outcome=>{ctx.outcome=outcome;ctx.busy=false;}};
 vm.runInNewContext(source.slice(source.indexOf('  function repairJson('),source.indexOf('  function diffLines('))
  +source.slice(source.indexOf('  function isUnfinishedUpdate('),source.indexOf('  /* ---------- per-message actions')),ctx);
 // The real panel renders DOM; tests spy on the call instead.
 ctx.showConfirmPanel = (payload) => panels.push(payload);
 return {ctx,calls,steps,panels,done(text,msg={}){ctx.pendingText=text;ctx.msg=msg;vm.runInNewContext('switch("done") {\n'+doneCase+'\n}',ctx);}};
}
test('announced next actions continue automatically, and repeated promises pause explicitly',()=>{
 const h=host(); const plan='I’ll continue with a focused cleanup pass in the CLI modules and tests, then apply a few safe fixes.\n\nFirst I’ll scan for TODO/FIXME-style signals and then patch clear issues in tools/reach_cli + tests.';
 h.done(plan);
 assert.equal(h.calls[0].type,'chat');assert.equal(h.ctx.busy,true);assert.equal(h.ctx.pendingText,'');
 assert.equal(h.calls[0].body.messages.at(-2).content,plan);
 assert.match(h.calls[0].body.messages.at(-1).content,/Emit the required tool blocks/);
 h.done(plan);assert.equal(h.calls.length,2);
 h.done(plan);assert.equal(h.calls.length,2);assert.equal(h.ctx.outcome,'cancelled');
 assert.match(h.ctx.conv.messages.at(-1).content,/Paused because the model repeated a plan/);
});
test('no configured limits: announced work keeps being chased instead of pausing',()=>{
 const h=host();h.ctx.UNFINISHED_RETRY_LIMIT=Infinity;h.ctx.MAX_AGENT_ROUNDS=Infinity;
 const plan='I’ll continue with a focused cleanup pass in the CLI modules and tests, then apply a few safe fixes.\n\nFirst I’ll scan for TODO/FIXME-style signals and then patch clear issues in tools/reach_cli + tests.';
 for(let i=0;i<5;i+=1)h.done(plan);
 assert.equal(h.calls.length,5,'each repeated promise gets another nudge');
 assert.notEqual(h.ctx.outcome,'cancelled');
});
test('agent limits come from settings: 0 means no limit',()=>{
 const start=source.indexOf('  function applyAgentLimits(');
 const end=source.indexOf('\n  }',start);
 const ctx={};
 vm.runInNewContext(source.slice(start,end+'\n  }'.length),ctx);
 ctx.applyAgentLimits({agentMaxRounds:0,agentUnfinishedRetries:0});
 assert.equal(ctx.MAX_AGENT_ROUNDS,Infinity);
 assert.equal(ctx.UNFINISHED_RETRY_LIMIT,Infinity);
 ctx.applyAgentLimits({agentMaxRounds:12,agentUnfinishedRetries:3});
 assert.equal(ctx.MAX_AGENT_ROUNDS,12);
 assert.equal(ctx.UNFINISHED_RETRY_LIMIT,3);
});
test('finished answers, offers, questions, and approval requests do not trigger continuation',()=>{
 for(const text of ['Fixed the parser and tested the changes.', 'I can inspect more files if you want.',
  'Should I continue?', 'I will run the migration after your approval.', 'The example says: I will read this next.']) {
  const h=host();h.done(text);assert.equal(h.calls.length,0,text);assert.equal(h.ctx.outcome,'completed');
 }
});
test('announcements in every voice continue the run (Let me / I need to / We should)',()=>{
 for(const plan of ['Let me inspect the actual "custom browser" components — the interactive engine and the VS Code browser UI — to see exactly where URL/localhost restrictions live.',
  'Let me also check the relay handler.', 'Now let me read server/reachd/handler.py.',
  'Next, I’ll compare both implementations.', 'I need to find where the restriction is enforced.',
  'I should inspect test_browser.py next.', 'We need to trace the blocked-address guard.',
  'Let me check why the page cannot be reached.',
  // The real reply that stopped a run (2026-09-12): a mid-text "I need to
  // confirm…" plus a gerund headline trailer in the last line.
  'The search tool is unreliable here (it missed strings I can see in files I\'ve already read), so I\'ll rely on direct reads. I now have the engine, the relay, the VS Code proxy, and the engine tests.\n\nKey finding: the engine already allows loopback (localhost, 127.0.0.1, ::1 pass parseUrl). What it blocks is the rest of "every URL": private/reserved IPs, .local/.localhost names, and any DNS that resolves to a non-public address. So the likely reason "localhost doesn\'t work in the custom browser" is the relay\'s pre-validator — browser_engine.py calls browser.py::_parse_url on every create/navigate before Chromium ever sees the URL. If that reader parser is strict (public-only, no loopback at the parser level), it will veto localhost before the engine runs. I need to confirm exactly what _parse_url accepts before I edit anything.\n\nReading the reader\'s URL/IP validation now: ',
  'I found the mismatch in both validators.\n\nReading the reader’s URL/IP validation now:',
  'Next: check the relay handler.',
  // The reply that stopped a run AGAIN (2026-09-12): a gerund headline whose
  // verb ("Emitting") was not on the curated list.
  'Emitting the reads for the two browser UIs to confirm there is no client-side URL gate:',
  // And the next stall, hours later: present continuous at the sentence start.
  'I’m checking the client-side UIs to see if there are any URL restrictions that might override the engine changes, and I’ll read through those files now to understand what I’m working with.']) {
  const h=host();h.ctx.UNFINISHED_RETRY_LIMIT=Infinity;h.ctx.MAX_AGENT_ROUNDS=Infinity;
  h.done(plan);
  assert.equal(h.calls.length,1,plan);
  assert.equal(h.calls[0].type,'chat');
  assert.match(h.calls[0].body.messages.at(-1).content,/Emit the required tool blocks/);
 }
});
test('summaries, explanations and real wait-states still finish the run',()=>{
 for(const text of ['Let me summarize what changed: the parser and the tests.',
  'I need your approval before continuing.', 'I’m blocked until the calendar API answers.',
  'The results are described below.', 'Running the tests showed everything passes.',
  'Reading the config confirmed the guard.', 'Next: the roadmap.']) {
  const h=host();h.done(text);assert.equal(h.calls.length,0,text);assert.equal(h.ctx.outcome,'completed');
 }
});
test('tool work continues past four rounds, resets promise retries, and pauses visibly at forty',()=>{
 const h=host();h.ctx.agentRounds=4;h.ctx.continuationRetries=2;
 const tool='<tool>{"action":"read","path":"README.md"}</tool>';
 h.done(tool);assert.equal(h.calls[0].type,'tools');assert.equal(h.ctx.continuationRetries,0);
 h.ctx.agentRounds=40;h.done(tool);assert.equal(h.calls.length,1);
 assert.match(h.ctx.conv.messages.at(-1).content,/Paused after 40 agent rounds/);
});
test('Stop prevents both planned continuations and already emitted tool requests from launching',()=>{
 for(const text of ['I’ll inspect the tests next.', '<tool>{"action":"read","path":"README.md"}</tool>']) {
  const h=host();h.ctx.stopRequested=true;h.done(text);
  assert.equal(h.calls.length,0);assert.equal(h.ctx.outcome,'cancelled');
 }
});
test('after a nudge, further no-action replies keep being chased until completion is stated',()=>{
 const h=host();h.ctx.UNFINISHED_RETRY_LIMIT=Infinity;h.ctx.MAX_AGENT_ROUNDS=Infinity;
 h.done('Emitting the reads for the two browser UIs to confirm there is no client-side URL gate:');
 assert.equal(h.calls.length,1,'the gerund headline is chased');
 h.done('Emitting the reads for the two browser UIs to confirm there is no client-side URL gate:');
 assert.equal(h.calls.length,2,'repeats keep being chased');
 h.done('Still pondering whatever the next move might be.');
 assert.equal(h.calls.length,3,'after a nudge, any no-action reply is chased again');
 h.done('The task is complete: the URL gate lives client-side.');
 assert.equal(h.calls.length,3,'an explicit completion settles the run');
 assert.equal(h.ctx.outcome,'completed');
});
test('a tool run chases any no-action reply and settles only on repeat or completion',()=>{
 const h=host();h.ctx.UNFINISHED_RETRY_LIMIT=Infinity;h.ctx.MAX_AGENT_ROUNDS=Infinity;h.ctx.agentRounds=2;
 h.done('I have gathered what I need for now.');
 assert.equal(h.calls.length,1,'ambiguous prose after tool work is chased');
 h.done('I have gathered what I need for now.');
 assert.equal(h.calls.length,1,'an exact repeat settles instead of looping');
 const c=host();c.ctx.agentRounds=3;
 c.done('The task is complete: the URL gate lives client-side.');
 assert.equal(c.calls.length,0,'a completion statement settles immediately');
 const p=host();p.ctx.agentRounds=3;
 p.done('I’m checking the client-side UIs to see if there are any URL restrictions that might override the engine changes, and I’ll read through those files now to understand what I’m working with.');
 assert.equal(p.calls.length,1,'the screenshot sentence is chased');
 const q=host();q.ctx.agentRounds=3;
 q.done('Should I continue with the migration?');
 assert.equal(q.calls.length,0,'a real question still waits for the user');
 assert.equal(q.panels.length,1);
});
test('agent questions open a confirmation panel with the offered options',()=>{
 const h=host();
 h.done('Before I proceed: keep the old parser as a fallback?\n\n```confirm\n{"question": "Keep the old parser as a fallback?", "options": ["Yes, keep it", "No, remove it"]}\n```');
 assert.equal(h.calls.length,0,'asking must not auto-continue');
 assert.equal(h.panels.length,1,'the question opens the confirmation panel');
 assert.match(h.panels[0].question,/fallback/);
 assert.deepEqual(Array.from(h.panels[0].options),['Yes, keep it','No, remove it']);
 assert.doesNotMatch(h.ctx.pendingText,/confirm/,'the block is removed from the reply');
 assert.equal(h.ctx.outcome,'completed');
 const plain=host();
 plain.done('Should I continue with the migration?');
 assert.equal(plain.panels.length,1,'a plain question still opens the panel');
 assert.deepEqual(Array.from(plain.panels[0].options),[]);
 const finished=host();
 finished.done('Fixed the parser and tested the changes.');
 assert.equal(finished.panels.length,0,'a finished answer opens no panel');
});
test('extractConfirm parses the confirm block and keeps unparseable ones visible',()=>{
 const h=host();
 const parsed=h.ctx.extractConfirm('Intro\n```confirm\n{"question": "Proceed?", "options": ["Yes", "No", "Stop"]}\n```\nOutro');
 assert.equal(parsed.confirm.question,'Proceed?');
 assert.deepEqual(Array.from(parsed.confirm.options),['Yes','No','Stop']);
 assert.match(parsed.text,/Intro/);assert.match(parsed.text,/Outro/);
 assert.doesNotMatch(parsed.text,/Proceed\?/,'the block text is removed from the reply');
 const bad=h.ctx.extractConfirm('```confirm\nnot json\n```');
 assert.equal(bad.confirm,null);
 assert.match(bad.text,/not json/,'unparseable blocks stay visible');
});
