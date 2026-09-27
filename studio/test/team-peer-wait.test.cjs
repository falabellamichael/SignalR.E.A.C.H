'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentNet } = require('../agent/agent-net.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');

function fixture(t, { nurse = true, awaitTimeoutMs = 120000 } = {}) {
  const net = new AgentNet({ rosterMailbox: true, awaitTimeoutMs, linkBudget: 8 });
  net.nurse = { enabled: nurse };
  for (const id of ['caller', 'peer']) {
    const store = new MemoryStore();
    store.setRunState(id, { status: 'running' });
    const rec = net.register({ agentId: id, name: id, store,
      loop: { running: true, stop() {} } });
    rec.control = { paused: false };
    rec.inbox = [];
  }
  t.after(async () => { net.stop(); await net.settle(); });
  return { net, caller: net.agents.get('caller'), peer: net.agents.get('peer') };
}

test('awaiting a pending roster member returns without holding its scheduler slot', async t => {
  const { net } = fixture(t);
  net.preRegister({ agentId: 'pending', name: 'Pending reviewer' });
  const result = await net.awaitAgent('pending', 'caller', { timeoutMs: Infinity });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'pending');
  assert.match(result.error, /independent part/);
  assert.match(result.error, /Do not claim unfinished work is complete/);
  assert.equal(net.awaiting.size, 0);
});

test('peer mail releases an active await without consuming mail or starting another turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { net, caller } = fixture(t);
  caller.loop.sendUserMessage = () => assert.fail('mail must not start a hidden conversation');
  const waiting = net.awaitAgent('peer', 'caller', { timeoutMs: 120000 });
  const sent = net.send({ from: 'peer', to: 'caller', message: 'The dependency is ready; use this evidence.' });
  assert.equal(sent.ok, true);
  t.mock.timers.tick(100);
  const result = await waiting;
  assert.equal(result.ok, true);
  assert.equal(result.waiting, true);
  assert.equal(result.messagesPending, true);
  assert.equal(result.status, 'running');
  assert.equal(caller.inbox.length, 1);
  assert.equal(net.linkSends, 1);
  assert.equal(net.awaiting.size, 0);
  const messages = net.takePendingMessages('caller');
  assert.match(messages[0], /The dependency is ready/);
  assert.deepEqual(net.takePendingMessages('caller'), []);
  assert.equal(net.linkSends, 1, 'delivery consumes the peer allowance once');
});

test('Nurse returns a 30-second check-in for saved long waits and unlimited waits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { net } = fixture(t, { awaitTimeoutMs: Infinity });
  for (const timeoutMs of [180000, Infinity, undefined]) {
    const waiting = net.awaitAgent('peer', 'caller', { timeoutMs });
    t.mock.timers.tick(30000);
    const result = await waiting;
    assert.equal(result.ok, true);
    assert.equal(result.checkIn, true);
    assert.equal(result.waiting, true);
    assert.equal(result.status, 'running');
    assert.match(result.note, /after 30s/);
    assert.match(result.note, /Continue independent work/);
    assert.equal(result.error, undefined, 'a supervisor check-in is not a peer failure');
  }
});

test('Nurse honors explicitly shorter waits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { net } = fixture(t);
  const waiting = net.awaitAgent('peer', 'caller', { timeoutMs: 1000 });
  t.mock.timers.tick(1000);
  const result = await waiting;
  assert.equal(result.checkIn, true);
  assert.match(result.note, /after 1s/);
});

test('disabling Nurse preserves a configured wait beyond the supervisor slice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { net } = fixture(t, { nurse: false });
  let settled = false;
  const waiting = net.awaitAgent('peer', 'caller', { timeoutMs: 60000 }).then(result => { settled = true; return result; });
  t.mock.timers.tick(30000);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(30000);
  const result = await waiting;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /after 60s/);
  assert.doesNotMatch(result.error, /await again/);
});

test('peer input and edit review states return promptly and truthfully', async t => {
  const { net, peer } = fixture(t);
  for (const status of ['waiting_input', 'waiting_edits']) {
    peer.store.setRunState(peer.id, { status });
    const result = await net.awaitAgent('peer', 'caller');
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.match(result.error, /pending user decision or review/);
    assert.equal(net.awaiting.size, 0);
    assert.equal(net.status('peer', 'caller').status, status);
    assert.equal(net.status('peer', 'caller').running, false);
  }
  peer.control.paused = true;
  assert.equal((await net.awaitAgent('peer', 'caller')).status, 'paused');
});

test('terminal peer state wins over stale store waits and does not consume incoming mail', async t => {
  const { net, peer, caller } = fixture(t);
  peer.status = 'completed';
  peer.output = 'Verified work.';
  peer.store.setRunState(peer.id, { status: 'waiting_input' });
  caller.inbox.push('Unread peer information.');
  const result = await net.awaitAgent('peer', 'caller');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Verified work.');
  assert.deepEqual(caller.inbox, ['Unread peer information.']);
});

test('same-turn mail remains queued during pause, input, review, and Stop', t => {
  const { net, caller } = fixture(t);
  caller.inbox.push('Evidence that must not be lost.');
  net.paused = true;
  assert.deepEqual(net.takePendingMessages('caller'), []);
  net.paused = false;
  caller.control.paused = true;
  assert.deepEqual(net.takePendingMessages('caller'), []);
  caller.control.paused = false;
  for (const status of ['waiting_input', 'waiting_edits']) {
    caller.store.setRunState(caller.id, { status });
    assert.deepEqual(net.takePendingMessages('caller'), []);
  }
  caller.store.setRunState(caller.id, { status: 'running' });
  caller.store.get(caller.id).pendingEdits = { edit1: {} };
  assert.deepEqual(net.takePendingMessages('caller'), []);
  caller.store.get(caller.id).pendingEdits = {};
  net.stop();
  assert.deepEqual(net.takePendingMessages('caller'), []);
  assert.deepEqual(caller.inbox, ['Evidence that must not be lost.']);
});

test('Stop and abort settle an await before pending mail can be mistaken for success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { net, caller } = fixture(t);
  const signal = new AbortController();
  const waiting = net.awaitAgent('peer', 'caller', { signal: signal.signal });
  caller.inbox.push('Retain this mail.');
  signal.abort();
  t.mock.timers.tick(100);
  const result = await waiting;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Await interrupted.');
  assert.equal(caller.inbox.length, 1);
  assert.equal(net.awaiting.size, 0);
});
