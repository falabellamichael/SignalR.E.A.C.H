'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TeamRunner } = require('../agent/team-runner.cjs');
const { TeamNurse, recoveryScore } = require('../agent/team-nurse.cjs');
const { AgentNet } = require('../agent/agent-net.cjs');
const { defaults, resolveBudgets, validateBudgets, presets } = require('../agent/budgets.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const finish = res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'complete', message: 'Work complete.', actions: [], options: [] }) }, finish_reason: 'stop' }] })); };
async function endpoint(t, handler) {
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; handler(JSON.parse(raw), res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function runner(endpoint, mode, events, options = {}) {
  return new TeamRunner({ team: { id: 'test', name: 'Fixture', mode, nurse: false, members: [{ personaId: 'target' }, { personaId: 'other' }] },
    personas: [{ id: 'target', name: 'Target', model: 'target' }, { id: 'other', name: 'Other', model: 'other' }], endpoint,
    task: 'Original task', sendEvent: (_channel, event) => events.push(event), ...options });
}

test('Nurse retains exact guidance, cancels generation and restarts even at the last round and exhausted peer budget', { timeout: 10000 }, async t => {
  const started = deferred(), closed = deferred(), requests = [], events = []; let applied = 0;
  const url = await endpoint(t, (body, res) => {
    if (body.model !== 'target') return finish(res);
    requests.push(body);
    if (requests.length === 1) { res.on('close', closed.resolve); started.resolve(); return; }
    finish(res);
  });
  const team = runner(url, 'parallel', events, { budgets: { ...defaults, maxRounds: 1, messageHandoffs: 1 } });
  const running = team.run('r'); await started.promise;
  team.net.linkSends = 1;
  const message = 'Correction: keep “Alpha” unchanged.\nUse BETA for the remaining work.';
  assert.equal(team.steerMember('m0-target', message, { id: 'guidance', onApplied: () => applied++ }).ok, true);
  assert.equal(applied, 0); assert.equal(team.nurse.userMessages.size, 1);
  await closed.promise; const result = await running;
  assert.equal(requests.length, 2); assert.ok(requests[1].messages.some(m => m.content.endsWith(message)));
  assert.equal(result[0].ok, true); assert.equal(applied, 1); assert.equal(team.nurse.userMessages.size, 0);
  assert.equal(team.net.linkSends, 1); assert.equal(team.nurse.meta().userRestarts, 1);
  assert.ok(events.some(e => e.memberType === 'nurse-restarted' && e.round === 1));
  assert.ok(events.some(e => e.nurseType === 'user-delivered'));
});

test('Nurse wakes an idle Links member beyond the peer-turn limit without charging peer handoffs', { timeout: 10000 }, async t => {
  const events = [], requests = []; let slow;
  const url = await endpoint(t, (body, res) => {
    if (body.model === 'other') { slow = res; return; }
    requests.push(body); finish(res);
  });
  const team = runner(url, 'links', events, { budgets: { ...defaults, messageHandoffs: 1 } });
  const running = team.run('r'); t.after(() => team.stop());
  while (!slow || !team.controls[0].finished) await tick();
  team.net.linkSends = 1;
  let applied = 0;
  for (let i = 0; i < 7; i++) {
    const before = events.filter(e => e.type === 'member-done' && e.index === 0).length;
    assert.equal(team.steerMember('m0-target', `New user direction ${i}`, { id: `u${i}`, onApplied: () => applied++ }).ok, true);
    while (events.filter(e => e.type === 'member-done' && e.index === 0).length === before) await tick();
    while (!team.controls[0].finished) await tick();
  }
  assert.equal(applied, 7); assert.equal(team.net.linkSends, 1);
  assert.equal(team.nurse.meta().userHandoffs, 7); assert.equal(team.nurse.wakes.size, 0);
  assert.ok(requests[7].messages.some(m => m.content.includes('New user direction 6')));
  finish(slow); await running;
});

test('Nurse never overrides a user pause or pending review and does not acknowledge a refused handoff', () => {
  for (const status of ['paused', 'waiting_edits', 'waiting_input']) {
    const rec = { id: 'm', status, control: { paused: status === 'paused' }, messagesReceived: 0 };
    const nurse = new TeamNurse({ net: { agents: new Map([['m', rec]]) } });
    const result = nurse.carryUserMessage('m', 'New guidance', { id: 'q', onApplied: () => assert.fail('Not delivered'), wake: () => assert.fail('Must not wake') });
    assert.equal(result.ok, false); assert.equal(nurse.userMessages.size, 0);
  }
});

test('Nurse recovery has no prior-start penalty even when legacy policy contains one', () => {
  const input = { failureKind: 'protocol', hasNewEvidence: true, sourceChars: 200, sourceIsCoordinator: true };
  assert.equal(recoveryScore({ ...input, priorWakes: 100 }, { priorWakePenalty: 3 }), recoveryScore({ ...input, priorWakes: 0 }));
  assert.equal(new TeamNurse({ policy: { priorWakePenalty: 3 } }).meta().policy.priorWakePenalty, 0);
});

test('handoff budget defaults to 9, supports overrides and zero, and counts only accepted agent sends', () => {
  assert.equal(resolveBudgets().messageHandoffs, 9); assert.equal(presets.balanced.messageHandoffs, 9);
  assert.equal(resolveBudgets({ budgets: { messageHandoffs: 27 } }, { budgetOverrides: { messageHandoffs: 0 } }).messageHandoffs, 0);
  for (const value of [-1, 1.2, '9', Infinity]) assert.throws(() => validateBudgets({ messageHandoffs: value }));
  for (const limit of [1, 9, 27, 0]) {
    const net = new AgentNet({ rosterMailbox: true, linkBudget: limit });
    net.preRegister({ agentId: 'a', name: 'A' }); net.preRegister({ agentId: 'b', name: 'B' });
    for (let i = 0; i < (limit || 40); i++) assert.equal(net.send({ from: 'a', to: 'b', message: 'Useful info' }).ok, true);
    if (limit) assert.equal(net.send({ from: 'a', to: 'b', message: 'Over limit' }).ok, false);
    assert.equal(net.linkSends, limit || 40);
    assert.equal(net.sendFromUser({ to: 'b', message: 'User direction' }).ok, true);
    assert.equal(net.linkSends, limit || 40);
    net.stop();
  }
});
