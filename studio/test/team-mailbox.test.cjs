'use strict';
/* Unified crew mailbox + shared Notes — appended as its own node:test block;
 * run via npm test. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentNet } = require('../agent/agent-net.cjs');
const { TOOLS } = require('../agent/tool-registry.cjs');

/* Two pre-registered roster members; no loops, so direct mail buffers as
 * pending-start — exactly the path Links chain members exercise. */
function crewFixture(teamRunId = 'mail-net') {
  const events = [];
  const net = new AgentNet({ teamRunId, endpoint: 'http://127.0.0.1:9/v1', sendEvent: (_, e) => events.push(e) });
  net.preRegister({ agentId: 'm0-lead', name: 'Lead', task: 'coordinate' });
  net.preRegister({ agentId: 'm1-worker', name: 'Worker', task: 'work' });
  return { net, events };
}

test('every accepted send also lands in the unified mailbox', async () => {
  const { net } = crewFixture('mail-1');
  const sent = net.send({ from: 'm0-lead', to: 'Worker', message: 'Check the withdraw path.' });
  assert.equal(sent.ok, true);
  // Direct delivery is unchanged: the recipient's inbox still gets its copy.
  assert.equal(net.agents.get('m1-worker').inbox.length, 1);
  assert.equal(net.mail.length, 1);
  const entry = net.mail[0];
  assert.equal(entry.from, 'm0-lead');
  assert.equal(entry.fromName, 'Lead');
  assert.equal(entry.to, 'm1-worker');
  assert.equal(entry.toName, 'Worker');
  assert.equal(entry.text, 'Check the withdraw path.');
  // User mail is crew mail too.
  net.send({ from: '__user__', to: 'm1-worker', message: 'Priority changed.', source: 'user', exact: true });
  assert.equal(net.mail.length, 2);
  assert.equal(net.mail[1].source, 'user');
  await net.settle();
});

test('broadcast posts to the mailbox without touching any inbox', async () => {
  const { net, events } = crewFixture('mail-2');
  const res = net.broadcast({ from: 'm0-lead', message: 'Freeze the schema, no new columns.' });
  assert.equal(res.ok, true);
  assert.equal(res.delivered, 'mailbox');
  assert.equal(net.mail.length, 1);
  assert.equal(net.mail[0].to, '*');
  assert.equal(net.mail[0].toName, 'crew');
  assert.equal(net.agents.get('m1-worker').inbox, undefined);
  assert.ok(events.some(e => e.netType === 'agent-message' && e.to === '*'));
  // Broadcasts are visible to a peer reading the whole board.
  const read = net.mailbox('m1-worker');
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].text, 'Freeze the schema, no new columns.');
  await net.settle();
});

test('mailbox read supports an agent filter and a limit', async () => {
  const { net } = crewFixture('mail-3');
  net.send({ from: 'm0-lead', to: 'Worker', message: 'first' });
  net.broadcast({ from: 'm1-worker', message: 'second' });
  net.send({ from: 'm0-lead', to: 'Worker', message: 'third' });
  const all = net.mailbox('m0-lead');
  assert.equal(all.total, 3);
  assert.equal(all.entries.length, 3);
  const filtered = net.mailbox('m0-lead', { agent: 'Worker' });
  // Worker sent the broadcast (from) and received the two directs (to).
  assert.equal(filtered.entries.length, 3);
  const limited = net.mailbox('m0-lead', { limit: 1 });
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.entries[0].text, 'third');
  await net.settle();
});

test('shared notes pin a finding the whole crew can read back', async () => {
  const { net } = crewFixture('mail-4');
  const posted = net.postNote('m0-lead', 'index.rsh reverts on zero-amount withdraw.');
  assert.equal(posted.ok, true);
  const listed = net.crewNotes();
  assert.equal(listed.count, 1);
  assert.equal(listed.notes[0].by, 'Lead');
  assert.match(listed.notes[0].text, /zero-amount withdraw/);
  // Empty and over-cap notes are refused, not truncated into silence.
  assert.equal(net.postNote('m0-lead', '   ').ok, false);
  await net.settle();
});

test('agent.mail tool dispatches read, broadcast send, and notes ops', async () => {
  const { net } = crewFixture('mail-5');
  const ctx = { agentId: 'm0-lead' };
  const mail = TOOLS['agent.mail'];

  const sent = await mail.execute({ op: 'send', to: 'Worker', message: 'Direct via tool.' }, ctx);
  assert.equal(sent.ok, true);
  assert.equal(sent.delivered, 'pending-start');

  const bcast = await mail.execute({ op: 'send', to: 'all', message: 'Broadcast via tool.' }, ctx);
  assert.equal(bcast.ok, true);
  assert.equal(bcast.delivered, 'mailbox');
  assert.equal(net.mail.length, 2);

  const noted = await mail.execute({ op: 'note', entry: 'Shared finding via tool.' }, ctx);
  assert.equal(noted.ok, true);

  const read = await mail.execute({ op: 'read' }, { agentId: 'm1-worker' });
  assert.equal(read.ok, true);
  assert.equal(read.entries.length, 2);
  assert.equal(read.notes, 1);

  const notes = await mail.execute({ op: 'notes' }, ctx);
  assert.equal(notes.notes[0].text, 'Shared finding via tool.');

  const bad = await mail.execute({ op: 'bogus' }, ctx);
  assert.equal(bad.ok, false);
  await net.settle();
});
