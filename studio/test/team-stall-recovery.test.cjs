'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TeamRunner } = require('../agent/team-runner.cjs');
const { nativeToolName } = require('../agent/agent-action.cjs');
const { defaults } = require('../agent/budgets.cjs');

function reply(res, content, name, args = {}) {
  const message = name ? { content: null, tool_calls: [{
    id: 'call-' + name, type: 'function',
    function: { name: nativeToolName(name), arguments: JSON.stringify(args) },
  }] } : { content };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: name ? 'tool_calls' : 'stop' }] }));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function transcript(body) {
  return body.messages.map(message => String(message.content || '')).join('\n');
}

async function localEndpoint(t, handler) {
  const active = new Map(), maxActive = new Map(), counts = new Map();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), model = body.model;
    counts.set(model, (counts.get(model) || 0) + 1);
    active.set(model, (active.get(model) || 0) + 1);
    maxActive.set(model, Math.max(maxActive.get(model) || 0, active.get(model)));
    let settled = false;
    const finish = () => {
      if (!settled) active.set(model, active.get(model) - 1);
      settled = true;
    };
    res.once('finish', finish);
    res.once('close', finish);
    try { await handler(body, res, counts.get(model)); }
    catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, counts, maxActive };
}

function crew(t, endpoint, { nurse = true, concurrency = 2, maxRounds = 12, names = ['Coordinator', 'Worker'], onEvent = () => {} } = {}) {
  const events = [];
  const personas = names.map((name, index) => ({ id: 'member-' + index, name, model: 'member-' + index }));
  const runner = new TeamRunner({
    team: { id: 'stall-regression', name: 'Stall regression', mode: 'links', toolProtocol: 'native', nurse,
      members: personas.map((persona, index) => ({ personaId: persona.id, ...(index === 0 ? { roleId: 'coordinator' } : {}) })) },
    personas,
    task: 'Coordinate the pending work, inspect the crew state, and return the verified result.',
    endpoint,
    budgets: { ...defaults, teamConcurrency: concurrency, requestTimeoutMs: 2500, maxRounds,
      maxLinkRounds: 3, memberLinkTurns: 2, autoCompact: false, codeContext: false, requestPacing: false },
    sendEvent: (_channel, event) => { events.push(event); onEvent(event); },
  });
  t.after(() => runner.stop());
  return { runner, events };
}

test('Nurse recovers an entirely tool-less native crew without requiring a completed peer first', { timeout: 7000 }, async t => {
  const sawNurse = new Set(), usedTools = new Set(), firstReplies = new Set();
  const bothRecovered = deferred();
  const mock = await localEndpoint(t, async (body, res, count) => {
    if (count === 1) {
      firstReplies.add(body.model);
      reply(res, 'I am waiting for the other member before continuing.');
      return;
    }
    const guidance = body.messages.some(message => message.role === 'user' && /TEAM NURSE RECOVERY/.test(message.content || ''));
    if (!guidance) { reply(res, 'I am still waiting for the other member.'); return; }
    sawNurse.add(body.model);
    if (!usedTools.has(body.model)) {
      usedTools.add(body.model);
      if (usedTools.size === 2) bothRecovered.resolve();
      reply(res, null, 'agent.list');
      return;
    }
    // Neither member provides a completed source until both have been rescued.
    await bothRecovered.promise;
    reply(res, null, 'task_complete', {
      summary: transcript(body).includes('FINAL SYNTHESIS')
        ? 'Both crew members inspected the live roster and delivered their results.\nLINKS: COMPLETE'
        : 'Inspected the live crew roster and resolved my remaining work.',
    });
  });
  const { runner, events } = crew(t, mock.endpoint);
  const results = await runner.run('all-tool-less-native-run');
  assert.equal(firstReplies.size, 2, 'both members first stop at prose, with no completed source to rescue them');
  assert.equal(sawNurse.size, 2, 'the Nurse supplies actionable team state to each unfinished member');
  assert.equal(usedTools.size, 2);
  assert.equal(events.filter(event => event.type === 'links-revive' && event.source === 'nurse').length, 2,
    'both terminal protocol stalls are automatically woken without a user Start');
  assert.equal(events.filter(event => event.type === 'member' && event.memberType === 'tool-result'
    && event.tool === 'agent.list' && event.ok).length, 2, 'recovery executes real collaboration tools');
  assert.ok(results.every(result => result.ok && result.status === 'completed'));
  assert.equal(events.findLast(event => event.type === 'done').outcome, 'completed');
  assert.ok([...mock.counts.values()].every(count => count <= 12), 'rescue has a bounded request cost');
  assert.ok([...mock.maxActive.values()].every(count => count === 1), 'a member never runs simultaneous model requests');
});

test('a crew that keeps ignoring tools exhausts bounded recovery without fabricating completion', { timeout: 7000 }, async t => {
  const nurseRecipients = new Set();
  const mock = await localEndpoint(t, (body, res) => {
    if (body.messages.some(message => message.role === 'user' && /TEAM NURSE RECOVERY/.test(message.content || ''))) {
      nurseRecipients.add(body.model);
    }
    reply(res, 'I will wait for my teammate.\nLINKS: COMPLETE');
  });
  const { runner, events } = crew(t, mock.endpoint);
  const results = await runner.run('persistent-tool-less-native-run');
  assert.equal(nurseRecipients.size, 2, 'both members receive recovery before the crew gives up');
  assert.ok([...mock.counts.values()].every(count => count <= 12), 'unchanged waiting prose cannot restart paid work forever');
  assert.ok(results.every(result => !result.ok && result.status === 'stalled'));
  const done = events.findLast(event => event.type === 'done');
  assert.equal(done.outcome, 'failed');
  assert.equal(done.successfulCount, 0);
  assert.equal(done.answer, '');
  assert.equal(runner._linksDone(), null, 'a prose completion marker cannot override task_complete');
});

test('an active Links member consumes peer mail before its next request within the same turn', { timeout: 7000 }, async t => {
  const mailSent = deferred(), recipientContinued = deferred();
  const token = 'verified-peer-result-7391';
  let nextRequestSawMail = false, nextRequestCopies = 0;
  const mock = await localEndpoint(t, async (body, res, count) => {
    if (body.model === 'member-1') {
      if (count === 1) {
        await mailSent.promise;
        reply(res, null, 'agent.list');
        return;
      }
      if (count === 2) {
        const userMessages = body.messages.filter(message => message.role === 'user');
        nextRequestCopies = userMessages.filter(message => String(message.content || '').includes(token)).length;
        nextRequestSawMail = nextRequestCopies === 1;
        recipientContinued.resolve();
      }
      if (!transcript(body).includes(token)) { reply(res, 'I still need the result from my teammate.'); return; }
      reply(res, null, 'task_complete', { summary: 'Used the delivered peer result to finish the assigned work.' });
      return;
    }
    if (count === 1) { reply(res, null, 'agent.send', { to: 'Worker', message: token }); return; }
    await recipientContinued.promise;
    reply(res, null, 'task_complete', { summary: transcript(body).includes('FINAL SYNTHESIS')
      ? 'The peer result was delivered and the worker completed its assignment.\nLINKS: COMPLETE'
      : 'Delivered the verified peer result and checked that the worker continued.' });
  });
  const { runner, events } = crew(t, mock.endpoint, { nurse: false, onEvent: event => {
    if (event.type === 'subagent' && event.netType === 'agent-message' && event.toName === 'Worker') mailSent.resolve();
  } });
  const results = await runner.run('active-member-mail-run');
  assert.equal(nextRequestSawMail, true, 'mail received during a request must be visible at its next safe request boundary');
  assert.equal(nextRequestCopies, 1, 'the same packet is not inserted twice');
  assert.equal(mock.counts.get('member-1'), 2, 'the member consumes mail in its original conversation, without an extra wake');
  assert.equal(mock.maxActive.get('member-1'), 1);
  assert.equal(events.filter(event => event.type === 'member-start' && event.index === 1).length, 1);
  assert.equal(events.filter(event => event.type === 'links-round' && event.waking?.includes('Worker')).length, 0);
  assert.ok(results.every(result => result.ok));
});

test('a member cannot hold the only team slot while awaiting a pending roster peer', { timeout: 7000 }, async t => {
  let waitResult = null, peerStarted = false;
  const mock = await localEndpoint(t, (body, res, count) => {
    if (body.model === 'member-1') {
      peerStarted = true;
      reply(res, null, 'task_complete', { summary: 'The queued peer started and delivered its evidence.' });
      return;
    }
    if (count === 1) { reply(res, null, 'agent.await', { agent: 'Worker', timeoutMs: 1000 }); return; }
    reply(res, null, 'task_complete', { summary: transcript(body).includes('FINAL SYNTHESIS')
      ? 'Both members delivered their evidence after the pending peer obtained a slot.\nLINKS: COMPLETE'
      : 'Yielding my finished assignment so the pending peer can obtain a team slot.' });
  });
  const { runner } = crew(t, mock.endpoint, { nurse: false, concurrency: 1, onEvent: event => {
    if (event.type === 'member' && event.memberType === 'tool-result' && event.tool === 'agent.await') waitResult = event.result;
  } });
  const results = await runner.run('pending-roster-await-run');
  assert.equal(waitResult?.status, 'pending', 'the actual await tool reports the pending roster peer');
  assert.equal(waitResult?.timedOut, undefined, 'a known slot dependency is refused without consuming the wait budget');
  assert.match(waitResult?.error || '', /team (slot|capacity)/i, 'the caller receives the actionable scheduling blocker');
  assert.equal(peerStarted, true);
  assert.ok(results.every(result => result.ok));
});

for (const atRoundLimit of [false, true]) {
  test(atRoundLimit
    ? 'mail arriving during final completion at the round cap survives for one counted Links wake'
    : 'mail arriving during final completion is consumed before the crew can declare success', { timeout: 7000 }, async t => {
    const finalStarted = deferred(), mailSent = deferred();
    const token = 'late-verification-correction-9402';
    const staleAnswer = 'Finished using the earlier evidence.\nLINKS: COMPLETE';
    const updatedAnswer = 'Applied the late verification correction and delivered the updated result.\nLINKS: COMPLETE';
    let runner, doneBeforeUpdatedReply = null, copiesInUpdatedRequest = 0;
    const mock = await localEndpoint(t, async (body, res, count) => {
      if (body.model === 'member-1') {
        if (count === 1) { reply(res, null, 'agent.list'); return; }
        if (count === 2) {
          finalStarted.resolve();
          await mailSent.promise;
          // This request started before the sender's evidence existed. Its
          // completion is stale even though task_complete itself is valid.
          reply(res, null, 'task_complete', { summary: staleAnswer });
          return;
        }
        doneBeforeUpdatedReply = !!runner._linksDone();
        copiesInUpdatedRequest = body.messages.filter(message => message.role === 'user'
          && String(message.content || '').includes(token)).length;
        reply(res, null, 'task_complete', { summary: updatedAnswer });
        return;
      }
      if (count === 1) {
        await finalStarted.promise;
        reply(res, null, 'agent.send', { to: 'Worker', message: token });
        return;
      }
      reply(res, null, 'task_complete', { summary: 'Delivered the newly verified correction to the worker.' });
    });
    const fixture = crew(t, mock.endpoint, { nurse: false, maxRounds: atRoundLimit ? 2 : 12, onEvent: event => {
      if (event.type === 'subagent' && event.netType === 'agent-message' && event.toName === 'Worker') mailSent.resolve();
    } });
    runner = fixture.runner;
    const results = await runner.run(atRoundLimit ? 'final-reply-cap-mail-run' : 'final-reply-mail-run');
    const { events } = fixture;
    assert.equal(doneBeforeUpdatedReply, false, 'the old in-flight completion cannot finish the team over unread mail');
    assert.equal(copiesInUpdatedRequest, 1, 'the late packet survives and reaches the next request exactly once');
    assert.equal(mock.counts.get('member-1'), 3, 'only the initial tool request, stale completion, and updated completion are needed');
    assert.equal(mock.maxActive.get('member-1'), 1, 'the recipient never starts overlapping model requests');
    const starts = events.filter(event => event.type === 'member-start' && event.index === 1);
    assert.equal(starts.filter(event => !event.retake).length, 1, 'the saved member is created once');
    assert.equal(starts.filter(event => event.retake).length, atRoundLimit ? 1 : 0, 'only the counted round-cap wake may start a new turn');
    const wakes = events.filter(event => event.type === 'links-round' && event.waking?.includes('Worker'));
    assert.equal(wakes.length, atRoundLimit ? 1 : 0, 'round-capped mail uses a counted wake; otherwise it stays in the current turn');
    if (atRoundLimit) {
      assert.equal(wakes[0].round, 1);
      assert.ok(events.some(event => event.type === 'member-done' && event.index === 1
        && !event.ok && /Unread crew messages/.test(event.error || '')), 'the capped turn remains unfinished until its queued mail is processed');
    }
    assert.equal(results[1].ok, true);
    assert.equal(results[1].output, updatedAnswer);
    assert.equal(events.findLast(event => event.type === 'done').answer, updatedAnswer);
  });
}
