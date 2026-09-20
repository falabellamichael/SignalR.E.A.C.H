const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { reduce, summary } = require('../renderer/activity-state.js');
const { AgentStore } = require('../agent/agent-store.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');

test('provider silence is waiting, and reasoning/output counters come only from real events', () => {
  let state = reduce(null, {type:'run-state',status:'running'}, 1000);
  state = reduce(state, {type:'request-start'}, 2000);
  assert.equal(summary(state, 33000).title, 'Waiting for an update');
  assert.equal(state.steps.at(-1).chars, 0);
  state = reduce(state, {type:'reasoning',chars:1250}, 34000);
  assert.equal(summary(state, 34000).title, 'Thinking');
  assert.equal(summary(state, 34000).silent, false);
  state = reduce(state, {type:'delta',text:'Hello'}, 35000);
  assert.equal(state.steps.at(-1).chars, 5);
  state = reduce(state, {type:'message-end',content:'Hello'}, 36000);
  state = reduce(state, {type:'run-state',status:'completed'}, 37000);
  assert.equal(summary(state, 999999).elapsed, '36s');
  assert.equal(summary(state).active, false);
});
test('approval waiting, declined actions, retries and Stop never appear completed', () => {
  let state = reduce(null, {type:'tool-call',tool:'shell'}, 1000);
  state = reduce(state, {type:'approval-wait'}, 2000);
  assert.equal(summary(state, 99999).waiting, true);
  assert.equal(summary(state, 99999).title, 'Waiting for your approval');
  state = reduce(state, {type:'tool-result',tool:'shell',ok:false,error:'Declined'}, 3000);
  assert.equal(state.steps.at(-1).status, 'error');
  state = reduce(state, {type:'retry',error:'Connection closed'}, 4000);
  state = reduce(state, {type:'stopped'}, 5000);
  assert.equal(summary(state, 10000).title, 'Stopped');
  assert.equal(state.steps.at(-1).status, 'paused');
});
test('trace and results are bounded, while step numbers keep increasing', () => {
  let state;
  for (let i=0;i<100;i++) { state=reduce(state,{type:'tool-call',tool:'read'},1000+i); state=reduce(state,{type:'tool-result',ok:true,result:{output:'x'.repeat(10000)}},1000+i); }
  assert.equal(state.steps.length,80);
  assert.equal(state.count,100);
  assert.equal(state.steps.at(-1).result.length,6000);
});
test('backend traces persist on completion and interrupted sessions restore paused', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reach-activity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new AgentStore(path.join(root,'agents.json'));
  const agent=store.create('Activity',root,'fixture');
  const loop=new AgentLoop({agentId:agent.id,store,projectDir:root,sendEvent:()=>{}});
  store.setRunState(agent.id,{status:'running'});
  loop._emit('run-state',{status:'running'});
  loop._emit('request-start',{});
  loop._emit('reasoning',{chars:100});
  store.setActivity(agent.id,loop.activity);
  const restored=new AgentStore(path.join(root,'agents.json')).get(agent.id);
  assert.equal(restored.activity.status,'paused');
  assert.equal(summary(restored.activity).active,false);
  assert.equal(restored.activity.steps.at(-1).reasoning,100);
  loop._emit('run-state',{status:'completed'});
  store.setRunState(agent.id,{status:'completed'});
  assert.equal(new AgentStore(path.join(root,'agents.json')).get(agent.id).activity.status,'completed');
});

test('completed activity summarizes status without duplicating a long final answer', () => {
  const answer = 'A very long final report. '.repeat(1000);
  let state = reduce(null, { type: 'run-state', status: 'running' });
  state = reduce(state, { type: 'message-end', content: answer });
  state = reduce(state, { type: 'run-state', status: 'completed', reason: answer });
  assert.equal(summary(state).detail, 'Response saved in the conversation.');
  assert.equal(state.reason, answer);
  assert.ok(summary(state).detail.length < 100);
});

test('stalled is a distinct terminal activity state', () => {
  let state = reduce(null, { type: 'run-state', status: 'running' }, 1000);
  state = reduce(state, { type: 'run-state', status: 'stalled', reason: 'Provider timed out.' }, 2000);
  assert.equal(summary(state, 3000).title, 'Stalled');
  assert.equal(summary(state, 3000).active, false);
  assert.equal(summary(state, 3000).detail, 'Provider timed out.');
});
