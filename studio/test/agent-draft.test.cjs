'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentStore } = require('../agent/agent-store.cjs');

function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-agent-draft-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'agents.json');
  return { store: new AgentStore(file, () => settings), file, project: path.join(root, 'project') };
}

test('New Chat reuses one in-memory identity per project and never enters saved history', t => {
  const { store, file, project } = fixture(t);
  const draft = store.create({ dir: project, draft: true });
  assert.equal(store.create({ dir: project, name: 'Ignored replacement', draft: true }), draft);
  assert.notEqual(store.create({ dir: project + '-other', draft: true }).id, draft.id);
  assert.equal(store.get(draft.id).draft, true);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.tree(project), []);
  assert.equal(fs.existsSync(file), false, 'Opening New Chat must not write a conversation');
});

test('draft model and tool preferences survive navigation without leaking into disk saves', t => {
  const { store, file, project } = fixture(t);
  const saved = store.create({ dir: project, name: 'Existing chat' });
  const draft = store.create({ dir: project, draft: true });
  store.update(draft.id, { model: 'local-model', settings: { features: { web: false }, teamChat: { enabled: true } } });
  store.setTodos(draft.id, [{ text: 'Draft plan', status: 'pending' }]);
  store.setActivity(draft.id, { status: 'idle' });
  store.update(saved.id, { name: 'Updated saved chat' });
  assert.equal(store.create({ dir: project, draft: true }).model, 'local-model');
  assert.equal(store.get(draft.id).settings.features.web, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agents.map(a => a.id), [saved.id]);
  const restarted = new AgentStore(file);
  assert.equal(restarted.get(draft.id), null);
  assert.equal(restarted.get(saved.id).name, 'Updated saved chat');
});

test('first accepted user message promotes the same draft and preserves its controls', t => {
  const { store, file, project } = fixture(t);
  const draft = store.create({ dir: project, draft: true });
  store.update(draft.id, { model: 'chosen-model', settings: { features: { terminal: false } } });
  store.appendMessage(draft.id, { role: 'user', content: 'Explain the project' });
  assert.equal(store.get(draft.id), draft, 'Attachment and loop identity must stay stable');
  assert.equal(draft.draft, undefined);
  assert.equal(store.list().length, 1);
  assert.equal(store.tree(project)[0].id, draft.id);
  const reloaded = new AgentStore(file).get(draft.id);
  assert.equal(reloaded.messages[0].content, 'Explain the project');
  assert.equal(reloaded.model, 'chosen-model');
  assert.equal(reloaded.settings.features.terminal, false);
  assert.equal(store.materialize(draft.id), draft, 'Promotion must be idempotent');
  assert.equal(store.list().length, 1);
  const next = store.create({ dir: project, draft: true });
  assert.notEqual(next.id, draft.id);
  assert.equal(next.draft, true);
  assert.equal(store.list().length, 1);
});

test('full saved-history budget keeps New Chat available but rejects promotion before mutation', t => {
  const { store, project } = fixture(t, { budgets: { maxConversations: 1 } });
  const saved = store.create({ dir: project });
  const draft = store.create({ dir: project, draft: true });
  assert.throws(() => store.validateMaterialization(draft.id), /Conversation limit reached/);
  assert.throws(() => store.materialize(draft.id), /Conversation limit reached/);
  assert.throws(() => store.appendMessage(draft.id, { role: 'user', content: 'First prompt' }), /Conversation limit reached/);
  assert.equal(draft.messages.length, 0);
  assert.equal(draft.draft, true);
  assert.equal(store.list().length, 1);
  store.remove(saved.id);
  store.appendMessage(draft.id, { role: 'user', content: 'Retry prompt' });
  assert.equal(store.list()[0].id, draft.id);
});

test('blank welcome drafts require a project and empty prompts never create saved chats', t => {
  const { store, project } = fixture(t);
  const draft = store.create({ draft: true });
  assert.throws(() => store.materialize(draft.id), /Choose a project/);
  assert.throws(() => store.appendMessage(draft.id, { role: 'user', content: 'Prompt before project' }), /Choose a project/);
  store.update(draft.id, { dir: project });
  assert.equal(store.create({ dir: project, draft: true }).id, draft.id);
  assert.throws(() => store.appendMessage(draft.id, { role: 'user', content: '  ' }), /message is required/);
  assert.equal(draft.draft, true);
  assert.deepEqual(store.list(), []);
  store.appendMessage(draft.id, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] });
  assert.equal(store.list().length, 1, 'An attachment-only message can create a conversation');
});

test('drafts cannot branch and removing one does not affect saved conversations', t => {
  const { store, project } = fixture(t);
  const saved = store.create({ dir: project });
  const draft = store.create({ dir: project, draft: true });
  assert.throws(() => store.fork(draft.id), /Send a message before branching/);
  assert.equal(store.remove(draft.id), true);
  assert.equal(store.remove(draft.id), false);
  assert.equal(store.get(draft.id), null);
  assert.equal(store.get(saved.id), saved);
  assert.equal(store.list().length, 1);
  assert.notEqual(store.create({ dir: project, draft: true }).id, draft.id);
});

test('failed promotion restores the draft so a persistence retry cannot duplicate it', t => {
  const { store, file, project } = fixture(t);
  const draft = store.create({ dir: project, draft: true });
  const save = store._save;
  store._save = () => { throw new Error('Disk unavailable'); };
  assert.throws(() => store.materialize(draft.id), /Disk unavailable/);
  assert.equal(store.get(draft.id), draft);
  assert.equal(draft.draft, true);
  assert.deepEqual(store.list(), []);
  assert.equal(store.create({ dir: project, draft: true }), draft);
  store._save = save;
  store.materialize(draft.id);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agents.length, 1);
  assert.equal(store.get(draft.id).draft, undefined);
});
