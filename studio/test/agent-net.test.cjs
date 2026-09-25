'use strict';
/* AgentNet unit tests — Grok-Bot-style agent-driven collaboration.
 * Appended as its own node:test block; run via npm test. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentNet, netForAgent } = require('../agent/agent-net.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { runToTerminal } = require('../agent/pause-resume.cjs');

const action = (status, message, actions = [], options = []) =>
  JSON.stringify({ status, message, actions, options });
const tool = (name, args) => ({ name, arguments: args });

function localEndpoint(t, handler) {
  const server = require('node:http').createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => handler(JSON.parse(body), res));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => { server.closeAllConnections(); server.close(); });
      resolve(`http://127.0.0.1:${server.address().port}/v1`);
    });
  });
}
function jsonReply(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}

/* A net with one manually-registered "lead" agent so collab tools have a
 * caller. The lead's loop is scripted via _fetchChat, no HTTP needed. */
function leadFixture(net, { replies, name = 'Lead' } = {}) {
  const store = new MemoryStore();
  const id = 'lead-1';
  const loop = new AgentLoop({
    agentId: id, store, endpoint: 'http://127.0.0.1:9/v1', model: 'lead',
    sendEvent: () => {},
  });
  let call = 0;
  loop._fetchChat = async () => {
    const reply = replies[call++];
    if (reply === undefined) throw new Error('Unexpected extra model request');
    return new Response(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }),
      { headers: { 'content-type': 'application/json' } });
  };
  net.register({ agentId: id, name, model: 'lead', loop, store, task: 'lead task' });
  return { id, loop, store };
}

test('agent.spawn creates a background worker that runs to completion', async t => {
  const events = [];
  const endpoint = await localEndpoint(t, (_, res) => jsonReply(res, action('complete', 'Worker finished the audit.')));
  const net = new AgentNet({ teamRunId: 'net-1', endpoint, defaultModel: 'w', sendEvent: (_, e) => events.push(e) });
  const lead = leadFixture(net, { replies: [
    action('actions', 'Delegating.', [tool('agent.spawn', { name: 'Auditor', task: 'Audit index.rsh', prompt: 'You audit.' })]),
    action('complete', 'Delegated.'),
  ] });
  await runToTerminal({ loop: lead.loop, store: lead.store, agentId: lead.id, firstPrompt: 'Go.' });
  await net.settle();

  const created = events.find(e => e.netType === 'agent-created');
  assert.ok(created, 'agent-created event emitted');
  assert.equal(created.name, 'Auditor');
  assert.ok(created.agentId);
  const rec = net.agents.get(created.agentId);
  assert.equal(rec.status, 'completed');
  assert.equal(rec.output, 'Worker finished the audit.');
  assert.equal(rec.origin, 'spawned');
  assert.equal(rec.depth, 1);
  assert.equal(rec.parentId, lead.id);
  const states = events.filter(e => e.netType === 'agent-state');
  assert.ok(states.some(e => e.status === 'running') && states.some(e => e.status === 'completed'));
  // lead could see the worker via agent.list
  assert.equal(net.list(lead.id).agents.length, 2);
});

test('agent.send wakes an idle worker; agent.await returns its output', async t => {
  const endpoint = await localEndpoint(t, (body, res) => {
    const last = body.messages[body.messages.length - 1].content;
    if (last.includes('MESSAGE FROM Lead')) jsonReply(res, action('complete', 'Acknowledged and done.'));
    else jsonReply(res, action('complete', 'First pass done.'));
  });
  const net = new AgentNet({ teamRunId: 'net-2', endpoint, sendEvent: () => {} });
  const spawned = net.spawn({ name: 'Worker', task: 'Wait for instructions.', parentId: null, depth: 0 });
  assert.ok(spawned.ok);
  await net.settle();
  assert.equal(net.agents.get(spawned.agentId).output, 'First pass done.');

  // Lead messages the idle worker, then awaits it.
  const lead = leadFixture(net, { replies: [
    action('actions', 'Sending instructions.', [tool('agent.send', { to: 'Worker', message: 'Now audit the withdraw path.' })]),
    action('actions', 'Waiting for the worker.', [tool('agent.await', { agent: 'Worker', timeoutMs: 5000 })]),
    action('complete', 'Done with crew work.'),
  ] });
  await runToTerminal({ loop: lead.loop, store: lead.store, agentId: lead.id, firstPrompt: 'Coordinate.' });
  await net.settle();

  const worker = net.agents.get(spawned.agentId);
  assert.equal(worker.status, 'completed');
  assert.equal(worker.output, 'Acknowledged and done.');
  assert.equal(worker.messagesReceived, 1);
  // The lead's transcript shows the await result carried the worker output.
  const leadText = lead.store.get(lead.id).messages.map(m => m.content).join('\n');
  assert.match(leadText, /Acknowledged and done\./);
});

test('quiet-boundary drain awaits active workers without unregistering the crew', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const endpoint = await localEndpoint(t, async (_, res) => {
    await gate;
    jsonReply(res, action('complete', 'Late but useful worker evidence.'));
  });
  const net = new AgentNet({ teamRunId: 'net-drain', endpoint, sendEvent: () => {} });
  const spawned = net.spawn({ name: 'LateWorker', task: 'Finish the delegated proof.', depth: 0 });
  assert.equal(net.hasActiveSpawned(), true);

  const draining = net.drainActiveSpawned();
  release();
  assert.equal(await draining, 1, 'one active worker promise is awaited');
  assert.equal(net.hasActiveSpawned(), false);
  assert.equal(net.agents.get(spawned.agentId).status, 'completed');
  assert.equal(net.agents.get(spawned.agentId).output, 'Late but useful worker evidence.');
  assert.equal(netForAgent(spawned.agentId), net, 'quiet-boundary drain keeps collaboration registered for synthesis');

  await net.settle();
  assert.equal(netForAgent(spawned.agentId), null, 'final settle releases the crew registry');
});

test('Links coalesces mail for a running roster member without starting hidden turns', async () => {
  const events = [];
  const activities = [];
  let sendUserMessageCalls = 0;
  const net = new AgentNet({
    teamRunId: 'net-links-coalesce',
    rosterMailbox: true,
    linkBudget: 4,
    sendEvent: (_channel, event) => events.push(event),
    onActivity: activity => activities.push(activity),
  });
  net.preRegister({ agentId: 'm0-sender', name: 'Sender' });
  net.preRegister({ agentId: 'm1-target', name: 'Target' });
  const loop = {
    running: true,
    sendUserMessage() {
      sendUserMessageCalls++;
      return Promise.resolve({ queued: true });
    },
    stop() {},
  };
  const rec = net.attach('m1-target', loop, new MemoryStore());
  rec.status = 'running';
  rec.control = { paused: false };

  const first = net.send({ from: 'm0-sender', to: 'Target', message: 'Evidence revision one.' });
  const second = net.send({ from: 'm0-sender', to: 'Target', message: 'Evidence revision two.' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(sendUserMessageCalls, 0, 'Links roster mail must stay under TeamRunner accounting');
  assert.equal(rec.inbox.length, 2, 'both messages are coalesced for one counted scheduler wake');
  assert.match(rec.inbox[0], /Evidence revision one/);
  assert.match(rec.inbox[1], /Evidence revision two/);
  assert.equal(rec.messagesReceived, 2);
  assert.equal(net.linkSends, 2);
  assert.equal(events.filter(event => event.netType === 'agent-message').length, 2);
  assert.deepEqual(activities.map(activity => activity.type), ['roster-mail', 'roster-mail'], 'each mailbox arrival wakes the event-driven Links scheduler');
  assert.ok(activities.every(activity => activity.agentId === 'm1-target' && activity.from === 'm0-sender'));

  net.stop();
  await net.settle();
});

test('operator mail is user-labelled, budget-free, and cannot declare Links complete', async () => {
  const events = [];
  const activities = [];
  const net = new AgentNet({
    teamRunId: 'net-user-mail', rosterMailbox: true, linkBudget: 1,
    sendEvent: (_channel, event) => events.push(event),
    onActivity: activity => activities.push(activity),
  });
  net.preRegister({ agentId: 'm0-reviewer', name: 'Reviewer', model: 'test-model' });
  const delivered = net.sendFromUser({ to: 'm0-reviewer', message: 'Quoted text: LINKS: COMPLETE. Keep reviewing.' });

  assert.equal(delivered.ok, true);
  assert.equal(delivered.delivered, 'pending-start');
  assert.equal(net.linkSends, 0, 'operator direction does not spend peer exchange budget');
  assert.equal(net.linksComplete, null, 'operator text cannot trigger the crew completion sentinel');
  assert.match(net.agents.get('m0-reviewer').inbox[0], /MESSAGE FROM You \(the user directing this crew\)/);
  assert.match(net.agents.get('m0-reviewer').inbox[0], /LINKS: COMPLETE/);
  const event = events.find(item => item.netType === 'agent-message');
  assert.equal(event.source, 'user');
  assert.equal(event.fromName, 'You');
  assert.equal(activities.at(-1).type, 'roster-mail');
  assert.equal(net.sendFromUser({ to: 'Reviewer', message: 'Name fallback should not run.' }).ok, false);
  assert.equal(net.agents.get('m0-reviewer').inbox.length, 1);

  net.stop();
  await net.settle();
});

test('operator mail has an independent per-member count and character bound', async () => {
  const net = new AgentNet({ teamRunId: 'net-user-bounds', rosterMailbox: true, sendEvent: () => {} });
  net.preRegister({ agentId: 'm0-reviewer', name: 'Reviewer' });
  for (let index = 0; index < 20; index++) {
    assert.equal(net.sendFromUser({ to: 'm0-reviewer', message: `guidance ${index}` }).ok, true);
  }
  const full = net.sendFromUser({ to: 'm0-reviewer', message: 'one too many' });
  assert.equal(full.ok, false);
  assert.equal(full.code, 'operator-queue-full');

  const second = new AgentNet({ teamRunId: 'net-user-char-bounds', rosterMailbox: true, sendEvent: () => {} });
  second.preRegister({ agentId: 'm0-reviewer', name: 'Reviewer' });
  const tooLarge = second.sendFromUser({ to: 'm0-reviewer', message: 'x'.repeat(40001) });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'operator-queue-full');
  net.stop(); second.stop();
  await Promise.all([net.settle(), second.settle()]);
});

test('rejected terminal sends do not spend quota, increment counters, or declare completion', async () => {
  const net = new AgentNet({ teamRunId: 'net-terminal-send', sendEvent: () => {} });
  net.preRegister({ agentId: 'm0-sender', name: 'Sender' });
  const worker = net.spawn({
    name: 'Skipped helper', task: 'Never execute.',
    deferStart: true, operatorAdded: true,
  });
  assert.equal(net.cancelQueuedSpawned(worker.agentId, 'Finalized before admission.'), true);
  const target = net.agents.get(worker.agentId);

  const operator = net.sendFromUser({ to: worker.agentId, message: 'This should be rejected.' });
  assert.equal(operator.ok, false);
  assert.match(operator.error, /already skipped/i);
  assert.equal(target.operatorMessages || 0, 0);
  assert.equal(target.operatorChars || 0, 0);
  assert.equal(target.messagesReceived, 0);

  const peer = net.send({
    from: 'm0-sender', to: worker.agentId,
    message: 'Rejected terminal delivery. LINKS: COMPLETE',
  });
  assert.equal(peer.ok, false);
  assert.equal(net.agents.get('m0-sender').messagesSent, 0);
  assert.equal(target.messagesReceived, 0);
  assert.equal(net.linkSends, 0);
  assert.equal(net.linksComplete, null);
  await net.settle();
});

test('finished Links roster members still accept bounded scheduler mail', async () => {
  const activities = [];
  const net = new AgentNet({
    teamRunId: 'net-finished-links-mail', rosterMailbox: true, linkBudget: 2,
    sendEvent: () => {}, onActivity: activity => activities.push(activity),
  });
  net.preRegister({ agentId: 'm0-sender', name: 'Sender' });
  const target = net.preRegister({ agentId: 'm1-reviewer', name: 'Reviewer' });
  target.status = 'completed';

  const delivered = net.send({
    from: 'm0-sender', to: 'm1-reviewer',
    message: 'One bounded follow-up. LINKS: COMPLETE',
  });
  assert.equal(delivered.ok, true);
  assert.equal(delivered.delivered, 'pending-start');
  assert.equal(target.inbox.length, 1);
  assert.equal(target.messagesReceived, 1);
  assert.equal(net.agents.get('m0-sender').messagesSent, 1);
  assert.equal(net.linkSends, 1);
  assert.equal(net.linksComplete, null, 'peer mail is data, not a terminal signal');
  assert.ok(!activities.some(activity => activity.type === 'links-complete'));
  assert.ok(activities.some(activity => activity.type === 'roster-mail'));
  net.stop();
  await net.settle();
});

test('user-added worker may use a main-resolved endpoint without changing normal inheritance', async t => {
  const routed = await localEndpoint(t, (_, res) => jsonReply(res, action('complete', 'Ran on the pinned route.')));
  const net = new AgentNet({ teamRunId: 'net-user-route', endpoint: 'http://127.0.0.1:9/v1', defaultModel: 'fallback', sendEvent: () => {} });
  const worker = net.spawn({ name: 'Pinned helper', task: 'Verify routing.', model: 'pinned-model', endpoint: routed, depth: 0, callerName: 'You' });
  assert.equal(worker.ok, true);
  await net.settle();
  const record = net.agents.get(worker.agentId);
  assert.equal(record.status, 'completed');
  assert.equal(record.output, 'Ran on the pinned route.');
  assert.equal(record.endpoint, routed);
  assert.equal(record.model, 'pinned-model');
});

test('operator-added worker waits for explicit scheduler admission and queues mail', async t => {
  let requests = 0;
  const endpoint = await localEndpoint(t, (_, res) => {
    requests++;
    jsonReply(res, action('complete', requests === 1 ? 'Initial helper task done.' : 'Queued guidance done.'));
  });
  const net = new AgentNet({ teamRunId: 'net-deferred-operator', endpoint, sendEvent: () => {} });
  const worker = net.spawn({
    name: 'Capped helper', task: 'Wait for a shared team slot.', depth: 0,
    callerName: 'You', deferStart: true, operatorAdded: true,
  });

  assert.equal(worker.ok, true);
  assert.equal(worker.queued, true);
  assert.equal(net.agents.get(worker.agentId).status, 'queued');
  assert.equal(net.activeTasks.has(worker.agentId), false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests, 0, 'deferred worker must not issue a request before scheduler admission');

  const mail = net.sendFromUser({ to: worker.agentId, message: 'Also verify queued guidance.' });
  assert.equal(mail.ok, true);
  assert.equal(mail.delivered, 'pending-start');
  assert.equal(net.agents.get(worker.agentId).status, 'queued', 'mail must not bypass scheduler admission');
  assert.equal(requests, 0);
  const prematureAwait = await net.awaitAgent(worker.agentId, 'roster-member', { timeoutMs: 5000 });
  assert.equal(prematureAwait.ok, false);
  assert.equal(prematureAwait.status, 'queued');
  assert.match(prematureAwait.error, /finish this turn so the scheduler can start it/i);

  const started = net.startSpawned(worker.agentId);
  assert.equal(started.ok, true);
  assert.match(started.status, /starting|running/);
  await net.settle();
  assert.equal(requests, 2, 'queued guidance is drained only after the scheduled initial turn');
  assert.equal(net.agents.get(worker.agentId).status, 'completed');
  assert.equal(net.agents.get(worker.agentId).output, 'Queued guidance done.');
});

test('queued operator worker can be skipped without issuing a model request', async t => {
  let requests = 0;
  const endpoint = await localEndpoint(t, (_, res) => {
    requests++;
    jsonReply(res, action('complete', 'should not run'));
  });
  const events = [];
  const net = new AgentNet({
    teamRunId: 'net-cancel-deferred', endpoint,
    sendEvent: (_channel, event) => events.push(event),
  });
  const worker = net.spawn({
    name: 'Never started', task: 'Do not execute.',
    deferStart: true, operatorAdded: true,
  });

  assert.equal(net.cancelQueuedSpawned(worker.agentId, 'Links finalized first.'), true);
  assert.equal(net.cancelQueuedSpawned(worker.agentId, 'duplicate cancellation'), false);
  await net.settle();
  assert.equal(requests, 0);
  assert.equal(net.agents.get(worker.agentId).status, 'skipped');
  assert.equal(net.agents.get(worker.agentId).error, 'Links finalized first.');
  assert.ok(events.some(event => event.netType === 'agent-state' && event.status === 'skipped'));
});

test('spawn limits: max agents and depth are enforced with clear errors', async t => {
  const endpoint = await localEndpoint(t, (_, res) => jsonReply(res, action('complete', 'ok')));
  const net = new AgentNet({ teamRunId: 'net-3', endpoint, maxAgents: 1, maxDepth: 1, sendEvent: () => {} });
  const a = net.spawn({ name: 'A', task: 't', depth: 1 });
  assert.ok(a.ok);
  const b = net.spawn({ name: 'B', task: 't', depth: 1 });
  assert.ok(!b.ok && /limit reached/i.test(b.error), 'maxAgents enforced: ' + JSON.stringify(b));
  await net.settle();
  // Depth: a depth-1 agent trying to spawn depth-2 with maxDepth=1 is refused.
  const net2 = new AgentNet({ teamRunId: 'net-4', endpoint, maxDepth: 1, sendEvent: () => {} });
  const deep = net2.spawn({ name: 'Deep', task: 't', depth: 2 });
  assert.ok(!deep.ok && /depth limit/i.test(deep.error), 'maxDepth enforced: ' + JSON.stringify(deep));
  net.stop(); net2.stop();
});

test('circular await is refused instead of deadlocking', async () => {
  const net = new AgentNet({ teamRunId: 'net-5', endpoint: 'http://127.0.0.1:9/v1', sendEvent: () => {} });
  const storeA = new MemoryStore(), storeB = new MemoryStore();
  net.register({ agentId: 'A', name: 'A', loop: { running: false, stop() {} }, store: storeA, task: '' });
  net.register({ agentId: 'B', name: 'B', loop: { running: false, stop() {} }, store: storeB, task: '' });
  // A awaits B (B never finishes) in the background…
  const pending = net.awaitAgent('B', 'A', { timeoutMs: 60000 });
  await new Promise(r => setTimeout(r, 50));
  // …B awaiting A must be REFUSED as a cycle, not block.
  const cyc = await net.awaitAgent('A', 'B', { timeoutMs: 5000 });
  assert.equal(cyc.ok, false);
  assert.match(cyc.error, /Circular await refused/);
  net.stop();
  const after = await pending;
  assert.equal(after.ok, false);
});

test('collab tools error clearly for agents outside a crew', async () => {
  const { TOOLS } = require('../agent/tool-registry.cjs');
  const res = await TOOLS['agent.spawn'].execute({ name: 'X', task: 'y' }, { agentId: 'nobody' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not part of a crew run/);
  assert.equal(netForAgent('nobody'), null);
});

test('actionInstruction hides collab tools unless the agent is in a crew', () => {
  const { actionInstruction } = require('../agent/agent-action.cjs');
  const solo = actionInstruction();
  const crew = actionInstruction({ includeCollab: true });
  assert.ok(!solo.includes('agent.spawn'), 'solo prompt must not advertise agent.spawn');
  assert.ok(crew.includes('agent.spawn') && crew.includes('agent.await'));
  assert.match(crew, /one agent in a crew/);
  // The schema enum still contains them (registry-wide) — parsing accepts
  // them; the prompt simply doesn't tempt solo agents to call them.
});

test('pause-resume driver: worker proposing an edit resumes after acceptance', async t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-net-'));
  fs.writeFileSync(path.join(dir, 'x.rsh'), 'old\n');
  const endpoint = await localEndpoint(t, (body, res) => {
    const seen = body.messages.some(m => m.content.includes('ACCEPTED and written to disk'));
    jsonReply(res, seen
      ? action('complete', 'Edit applied.')
      : action('actions', 'Writing.', [tool('write', { path: 'x.rsh', content: 'new\n' })]));
  });
  const net = new AgentNet({
    teamRunId: 'net-6', endpoint, projectDir: dir, sendEvent: () => {},
    requestEditReview: () => {},
    awaitEditResolution: async (refs) => refs.map(r => ({ ...r, accepted: true })),
  });
  const spawned = net.spawn({ name: 'Writer', task: 'Replace x.rsh.', depth: 0 });
  assert.ok(spawned.ok);
  await net.settle();
  const rec = net.agents.get(spawned.agentId);
  assert.equal(rec.status, 'completed');
  assert.equal(rec.output, 'Edit applied.');
});

test('net.stop halts workers and settles pending awaits', async t => {
  let started = false, ready;
  const startedP = new Promise(r => { ready = r; });
  const endpoint = await localEndpoint(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n');
    if (!started) { started = true; ready(); }
  });
  const net = new AgentNet({ teamRunId: 'net-7', endpoint, sendEvent: () => {} });
  net.spawn({ name: 'Slow', task: 'hang', depth: 0 });
  await startedP;
  net.stop();
  await net.settle();
  const rec = [...net.agents.values()].find(a => a.name === 'Slow');
  assert.ok(['stopped', 'failed'].includes(rec.status), 'worker stopped, got ' + rec.status);
});
