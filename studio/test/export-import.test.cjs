'use strict';

/* Item 4.4 — conversation export/import. Export must round-trip a
 * conversation's messages, todos and pending edits; import must reject a
 * malformed file with a clear error, and must mint a fresh id so an imported
 * snapshot can never overwrite an existing conversation. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentStore } = require('../agent/agent-store.cjs');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-export-'));
  return new AgentStore(path.join(dir, 'agents.json'));
}

test('export/import round-trips messages, todos and pending edits', () => {
  const store = tmpStore();
  const original = store.create({ name: 'Round Trip', dir: 'D:/proj', model: 'demo' });
  store.appendMessage(original.id, { role: 'user', content: 'hello' });
  store.appendMessage(original.id, { role: 'assistant', content: 'hi there' });
  store.setTodos(original.id, [
    { text: 'step one', status: 'completed' },
    { text: 'step two', status: 'in_progress' },
  ]);
  store.addPendingEdit(original.id, { editId: 'e1', path: 'a.js', absPath: 'D:/proj/a.js', proposed: 'x' });

  // Simulate the export handler's shape (id stripped, wrapped in envelope).
  const { id: _exportedId, ...agentData } = store.get(original.id);
  const payload = { format: 'reach-studio.conversation', version: 1, agent: agentData };

  const imported = store.importConversation(payload.agent);
  assert.notEqual(imported.id, original.id, 'import must mint a fresh id');
  assert.equal(imported.name, 'Round Trip');
  assert.equal(imported.dir, 'D:/proj');
  assert.equal(imported.messages.length, 2);
  assert.deepEqual(imported.todos.map(t => t.text), ['step one', 'step two']);
  assert.equal(imported.pendingEdits.e1.path, 'a.js');

  // Both conversations are independently stored.
  assert.equal(store.list().length, 2);
});

test('import rejects a malformed snapshot with a clear error', () => {
  const store = tmpStore();
  assert.throws(() => store.importConversation(null), /expected an object/);
  assert.throws(() => store.importConversation([]), /expected an object/);
  assert.throws(() => store.importConversation({ messages: [] }), /missing its project directory/);
  assert.equal(store.list().length, 0, 'a rejected import must not create a conversation');
});

test('import sanitizes and never overwrites an existing conversation', () => {
  const store = tmpStore();
  const existing = store.create({ name: 'Existing', dir: 'D:/proj' });

  // A hostile export carries the existing id — it must be ignored.
  const hostile = {
    id: existing.id,
    dir: 'D:/proj',
    name: 'Hostile',
    messages: [{ role: 'user', content: 'pwn' }],
    settings: { approvals: 'auto-all' },
  };
  const imported = store.importConversation(hostile);
  assert.notEqual(imported.id, existing.id);
  assert.equal(store.get(existing.id).name, 'Existing');
  assert.equal(store.get(existing.id).messages.length, 0, 'existing conversation untouched');
  assert.equal(store.list().length, 2);
});
