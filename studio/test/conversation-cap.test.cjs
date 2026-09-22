'use strict';

/* Reach Studio — item 1.5: per-conversation byte cap + append-only archive.
 *
 * Invariant A4 (archive, never delete): every message a trim removes from the
 * live conversation must replay from userData/agents/<id>.history.jsonl.
 * These tests use a scaled-down cap (a real 8 MB cap is the default) so the
 * arithmetic stays readable; the code path is identical.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentStore, MAX_CONVERSATION_BYTES } = require('../agent/agent-store.cjs');

const CAP = 256 * 1024;
const tmpStore = (t, settings = () => ({}), options = { maxConversationBytes: CAP }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-conv-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agents.json');
  return { dir, file, store: new AgentStore(file, settings, options) };
};
/* A conversation whose serialized form comfortably exceeds the cap. */
const bulk = (count, size = 2000) => Array.from({ length: count }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  content: `Message ${i} ` + 'x'.repeat(size),
}));

test('a conversation over the byte cap is bounded on save and replays from its archive', t => {
  const { file, store } = tmpStore(t);
  const agent = store.create({ name: 'Big chat', dir: '/proj' });
  store.appendMessage(agent.id, { role: 'system', content: 'RULE: preserve every constraint.' });

  const sent = bulk(300);
  for (const message of sent) store.appendMessage(agent.id, message);

  const live = store.get(agent.id).messages;
  // 1. The saved document is bounded: the point of the cap.
  assert.ok(Buffer.byteLength(JSON.stringify({ agents: JSON.parse(fs.readFileSync(file, 'utf8')).agents })) < MAX_CONVERSATION_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(store.get(agent.id))) <= CAP,
    'the conversation itself fits the cap after trimming');
  // 2. Something was actually trimmed and something stayed live.
  assert.ok(live.length < sent.length + 1, 'old messages were trimmed from the live conversation');
  assert.ok(live.length >= 1, 'the newest message is never trimmed');

  // 3. A4 — archive, never delete: trimmed head + live tail == everything sent.
  const archived = store.readArchive(agent.id);
  assert.ok(archived.length > 0, 'trimmed messages were archived, not dropped');
  assert.equal(archived.length + live.length, sent.length + 1, 'no message is lost or duplicated');
  assert.deepEqual([...archived, ...live.slice(1)], sent, 'archive replays oldest-first and reconstructs the full history');

  // 4. The operator's leading instruction is pinned, never archived.
  assert.equal(live[0].role, 'system');
  assert.ok(!archived.some(m => m.role === 'system' || m.role === 'developer'));

  // 5. A reload sees the same bounded conversation.
  const reloaded = new AgentStore(file).get(agent.id);
  assert.deepEqual(reloaded.messages, live);
});

test('the archive is append-only across successive saves', t => {
  const { store } = tmpStore(t);
  const agent = store.create({ name: 'Growing', dir: '/proj' });
  const rounds = bulk(40, 8000);
  const seen = [];
  for (const message of rounds) {
    store.appendMessage(agent.id, message);
    const archived = store.readArchive(agent.id);
    // Never shrinks: an append-only log, so a replay is stable over time.
    assert.ok(archived.length >= seen.length, 'the archive never loses previously archived lines');
    assert.deepEqual(archived.slice(0, seen.length), seen, 'existing archive lines are byte-stable');
    seen.length = 0;
    seen.push(...archived);
  }
  assert.ok(seen.length > 0, 'the growing conversation did spill into the archive');
  const live = store.get(agent.id).messages;
  assert.deepEqual([...seen, ...live], rounds, 'archive + live still reconstructs every message in order');
});

test('a message larger than the cap still leaves the newest message live', t => {
  const { store } = tmpStore(t);
  const agent = store.create({ name: 'One huge turn', dir: '/proj' });
  const huge = { role: 'assistant', content: 'y'.repeat(CAP * 2) };
  store.appendMessage(agent.id, huge);
  // The cap is best-effort: the newest message is the conversation's result and
  // must survive, so the live conversation may exceed the cap here by design.
  assert.deepEqual(store.get(agent.id).messages, [huge]);
  assert.deepEqual(store.readArchive(agent.id), [], 'nothing was archived to make room for the only message');
});

test('trimming drops the stale compressed-memory checkpoint instead of replaying it', t => {
  const { store } = tmpStore(t);
  const agent = store.create({ name: 'Compacted', dir: '/proj' });
  store.appendMessage(agent.id, { role: 'system', content: 'Rules' });
  for (const message of bulk(4, 50)) store.appendMessage(agent.id, message);
  store.setContext(agent.id, { messages: [{ role: 'user', content: 'memory' }], through: 1, fingerprint: 'live' });
  assert.ok(store.get(agent.id).context, 'checkpoint survives while the conversation is under the cap');
  // Grow past the cap: the checkpoint covers an exact prefix of a history that
  // is about to be trimmed, so it must not be replayed as working memory.
  for (const message of bulk(200, 3000)) store.appendMessage(agent.id, message);
  assert.equal(store.get(agent.id).context, undefined,
    'a checkpoint covering a trimmed prefix is dropped, not replayed (compaction.workingMessages)');
});

test('an explicit storedMessages retention cap also archives what it trims', t => {
  const { store } = tmpStore(t, () => ({ budgets: { storedMessages: 10 } }));
  const agent = store.create({ name: 'Retained', dir: '/proj' });
  const sent = bulk(40, 40);
  for (const message of sent) store.appendMessage(agent.id, message);
  const live = store.get(agent.id).messages;
  assert.equal(live.length, 10, 'the configured retention cap is honored');
  const archived = store.readArchive(agent.id);
  assert.equal(archived.length, 30, 'every trimmed message was archived');
  assert.deepEqual([...archived, ...live], sent, 'retention trimming stays replayable end to end');
});

test('deleting a conversation removes its history archive too', t => {
  const { file, store } = tmpStore(t);
  const agent = store.create({ name: 'Doomed', dir: '/proj' });
  for (const message of bulk(80, 5000)) store.appendMessage(agent.id, message);
  assert.ok(store.readArchive(agent.id).length > 0, 'archive exists before deletion');
  assert.equal(store.remove(agent.id), true);
  assert.deepEqual(store.readArchive(agent.id), [], 'an explicit delete does not leave a hidden copy behind');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.agents, []);
});

test('readArchive is empty for an unknown conversation and saves leave no .tmp', t => {
  const { dir, store } = tmpStore(t);
  assert.deepEqual(store.readArchive('agent-does-not-exist'), []);
  const agent = store.create({ name: 'Tidy', dir: '/proj' });
  for (const message of bulk(40, 1000)) store.appendMessage(agent.id, message);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [],
    'atomic writes leave no partial file behind');
});

test('conversations under the cap are never trimmed and never create an archive', t => {
  const { store } = tmpStore(t);
  const agent = store.create({ name: 'Small', dir: '/proj' });
  const sent = bulk(5, 100);
  for (const message of sent) store.appendMessage(agent.id, message);
  assert.deepEqual(store.get(agent.id).messages, sent, 'a conversation within the cap is untouched');
  assert.deepEqual(store.readArchive(agent.id), [], 'no archive is created when nothing is trimmed');
});
