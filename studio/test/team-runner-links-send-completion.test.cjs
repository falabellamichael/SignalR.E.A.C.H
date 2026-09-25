'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');

const { TeamRunner } = require('../agent/team-runner.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { linksCompleteIn } = require('../agent/team-completion.cjs');

const action = (status, message, actions = [], options = []) =>
  JSON.stringify({ status, message, actions, options });
const tool = (name, arguments_) => ({ name, arguments: arguments_ });

function jsonReply(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}

async function localEndpoint(t, handler) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => handler(JSON.parse(raw), res));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('peer mail cannot conclude Links; validated final completion releases a header-stalled peer', async t => {
  const requestTimeoutMs = 5000;
  const stalledStarted = deferred();
  const stalledClosed = deferred();
  let messengerRequests = 0;

  const endpoint = await localEndpoint(t, (body, res) => {
    if (body.model === 'stalled') {
      res.on('close', stalledClosed.resolve);
      stalledStarted.resolve();
      return; // Never send headers; only the Links conclusion should abort it.
    }

    messengerRequests++;
    if (messengerRequests === 1) {
      jsonReply(res, action('actions', 'Declaring the verified crew result to my peer.', [
        tool('agent.send', {
          to: 'Stalled',
          message: 'The crew result is complete and verified.\nLINKS: COMPLETE',
        }),
      ]));
      return;
    }
    setTimeout(() => jsonReply(res, action('complete', 'The crew result is complete and verified.\nLINKS: COMPLETE')), 350);
  });

  const events = [];
  const runner = new TeamRunner({
    team: {
      id: 'links-send-completion',
      name: 'Links send completion',
      mode: 'links',
      members: [{ personaId: 'messenger', roleId: 'coordinator' }, { personaId: 'stalled' }],
    },
    personas: [
      { id: 'messenger', name: 'Messenger', model: 'messenger' },
      { id: 'stalled', name: 'Stalled', model: 'stalled' },
    ],
    task: 'Finish the verified crew result and notify the peer.',
    endpoint,
    requestTimeoutMs,
    concurrency: 2,
    sendEvent: (_channel, event) => events.push(event),
  });

  const startedAt = performance.now();
  const running = runner.run('links-send-completion-run');
  await stalledStarted.promise;

  let safetyTimer;
  const results = await Promise.race([
    running,
    new Promise((_, reject) => {
      safetyTimer = setTimeout(() => reject(new Error('AgentNet completion did not release the header-stalled peer.')), 2000);
    }),
  ]).finally(() => clearTimeout(safetyTimer));
  const elapsedMs = performance.now() - startedAt;
  let socketTimer;
  await Promise.race([
    stalledClosed.promise,
    new Promise((_, reject) => {
      socketTimer = setTimeout(() => reject(new Error('The aborted provider socket did not close.')), 500);
    }),
  ]).finally(() => clearTimeout(socketTimer));

  // The stalled member is released by the configured 250 ms conclusion grace:
  // neither immediately nor anywhere close to its five-second provider timeout.
  assert.ok(elapsedMs >= 200, `expected the conclusion grace before cancellation; elapsed ${elapsedMs.toFixed(1)} ms`);
  assert.ok(elapsedMs < requestTimeoutMs / 2, `completion waited too close to the provider timeout; elapsed ${elapsedMs.toFixed(1)} ms`);
  assert.equal(runner._linksConclusionTimer, null, 'the conclusion timer is consumed and cleared');
  assert.equal(runner.net.linksComplete, null, 'peer mail never sets terminal state');
  assert.equal(runner._linkDeclared.by, 'Messenger');
  assert.ok(elapsedMs >= 550, 'the peer remains active until the sender really completes, then gets its grace');
  assert.equal(messengerRequests, 2, 'the declaring member finishes its current tool turn normally');
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false, 'cancellation is not a completed answer');
  assert.equal(results[1].status, 'skipped');
  assert.equal(results[1].output, '');

  const delivery = events.find(event => event.type === 'subagent' && event.netType === 'agent-message');
  assert.ok(delivery, 'the declaration travels through AgentNet.send');
  assert.equal(delivery.fromName, 'Messenger');
  assert.equal(delivery.toName, 'Stalled');
  const done = events.findLast(event => event.type === 'done');
  assert.equal(done.outcome, 'completed', 'a superseded peer does not fail a valid team completion');
  assert.equal(done.successfulCount, 1, 'only a delivered answer counts');
  assert.equal(done.links.completedBy, 'Messenger');
  assert.equal(done.links.synthesized, false);
  assert.match(done.answer, /crew result is complete and verified/i);
  assert.match(done.answer, /LINKS: COMPLETE/);
});

test('a native member stalled without task_complete cannot end Links or cancel final synthesis', { timeout: 8000 }, async t => {
  const stalled = deferred();
  let synthesisRequests = 0;
  const finalAnswer = 'Project summary: the relay serves model requests; Studio manages agents and projects.';
  const nativeComplete = (res, summary) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
      id: 'completion', type: 'function',
      function: { name: 'task_complete', arguments: JSON.stringify({ summary }) },
    }] }, finish_reason: 'tool_calls' }] }));
  };
  const endpoint = await localEndpoint(t, async (body, res) => {
    if (body.model === 'thinker') {
      jsonReply(res, 'I sent the summary to my peers.\nLINKS: COMPLETE');
      return;
    }
    const transcript = body.messages.map(message => String(message.content || '')).join('\n');
    if (transcript.includes('FINAL SYNTHESIS')) {
      synthesisRequests++;
      nativeComplete(res, finalAnswer + '\nLINKS: COMPLETE');
      return;
    }
    await stalled.promise;
    // Outlast the conclusion grace: an invalid declaration used to abort this
    // productive member before it could supply evidence and synthesize it.
    await new Promise(resolve => setTimeout(resolve, 400));
    nativeComplete(res, 'Verified relay and Studio source evidence.');
  });
  const events = [];
  const runner = new TeamRunner({
    team: { id: 'native-stalled', name: 'Native crew', mode: 'links', toolProtocol: 'native', nurse: false,
      members: [{ personaId: 'thinker' }, { personaId: 'ceo', roleId: 'coordinator' }] },
    personas: [{ id: 'thinker', name: 'Thinker', model: 'thinker' }, { id: 'ceo', name: 'CEO', model: 'ceo' }],
    task: 'Write a summary of the project.', endpoint, requestTimeoutMs: 3000, concurrency: 2,
    sendEvent: (_channel, event) => {
      events.push(event);
      if (event.type === 'member-done' && event.index === 0) stalled.resolve();
    },
  });
  t.after(() => runner.stop());
  const results = await runner.run('native-stalled-run');
  assert.equal(results[0].status, 'stalled');
  assert.match(results[0].error, /without task_complete/);
  assert.equal(results[1].ok, true);
  assert.equal(synthesisRequests, 1);
  const done = events.findLast(event => event.type === 'done');
  assert.equal(done.outcome, 'partial');
  assert.equal(done.successfulCount, 1);
  assert.equal(done.links.completedBy, 'CEO');
  assert.equal(done.links.synthesized, true);
  assert.equal(done.answer, finalAnswer + '\nLINKS: COMPLETE');
  assert.doesNotMatch(done.answer, /sent the summary to my peers/);
});

test('interrupted progress stays skipped while genuine completed answers survive peer completion', () => {
  const persona = { id: 'peer', name: 'Peer', model: 'mock' };
  const key = 'm0-peer';
  const runner = new TeamRunner({ team: { mode: 'links', members: [{}] }, personas: [persona], sendEvent() {} });
  const store = new MemoryStore();
  store.appendMessage(key, { role: 'assistant', content: 'I am still reading the remaining files.' });
  store.setRunState(key, { status: 'stopped' });
  runner._linksSuperseded.set(key, 'Coordinator');
  const result = runner._asLinksResult(runner._harvest(key, store, persona, 0, 'mock'));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'skipped');
  assert.equal(result.output, '');
  store.appendMessage(key, { role: 'assistant', content: action('complete', 'Verified source evidence.') });
  store.setRunState(key, { status: 'completed' });
  const finished = runner._harvest(key, store, persona, 0, 'mock');
  assert.equal(finished.ok, true);
  assert.equal(finished.output, 'Verified source evidence.');
});

test('completion guard rejects marker-only answers, open work and pending review without trusting model status', () => {
  const persona = { id: 'peer', name: 'Peer', model: 'mock' };
  const key = 'm0-peer';
  for (const scenario of [
    { output: 'LINKS: COMPLETE', expected: /no delivered answer/ },
    { output: 'Answer.\nLINKS: COMPLETE', todos: [{ text: 'Verify', status: 'pending' }], expected: /unfinished plan/ },
    { output: 'Answer.\nLINKS: COMPLETE', edits: [{ editId: 'review-me' }], expected: /edit review/ },
    { output: 'Answer.\nLINKS: COMPLETE', driverError: 'Completion transport failed', expected: /transport failed/ },
  ]) {
    const runner = new TeamRunner({ team: { mode: 'links', members: [{}] }, personas: [persona], sendEvent() {} });
    const store = new MemoryStore();
    store.appendMessage(key, { role: 'assistant', content: scenario.output });
    store.setRunState(key, { status: 'completed' });
    store.setTodos(key, scenario.todos || []);
    runner.memberEdits.set(key, scenario.edits || []);
    const result = runner._harvest(key, store, persona, 0, 'mock', scenario.driverError);
    assert.equal(result.ok, false);
    assert.match(result.error, scenario.expected);
    assert.equal(runner._linksDone(), null);
    assert.equal(runner._linksConclusionTimer, null);
  }
});

test('completion marker must be a standalone terminal line outside a quoted or fenced example', () => {
  for (const text of [
    'They said LINKS: COMPLETE yesterday.',
    'Answer.\n> LINKS: COMPLETE',
    'Answer.\n```text\nLINKS: COMPLETE',
    'Answer.\n~~~\nLINKS: COMPLETE\n~~~',
    'Answer.\nLINKS: COMPLETE\nStill investigating.',
  ]) assert.equal(linksCompleteIn(text), false, text);
  assert.equal(linksCompleteIn('Answer.\nlinks: complete\n'), true);
});
