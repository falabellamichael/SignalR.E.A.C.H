'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const intents = require('../renderer/composer-intents.js');
const source = fs.readFileSync(require.resolve('../renderer/app-dispatch.js'), 'utf8');

function harness({ ok = true, selected = 'chat-1' } = {}) {
  const calls = [];
  const context = vm.createContext({
    composerIntents: intents,
    currentAgent: { id: selected },
    reachApi: { agents: { clear: async id => {
      calls.push(['clear', id]);
      return { ok, agent: { id, messages: [] }, err: 'Stop the conversation first.' };
    } } },
    runningAgentIds: new Set(['chat-1']),
    setBackgroundAgentGate: id => calls.push(['gate', id]),
    discardTeamConversation: id => calls.push(['discard', id]),
    selectAgent: async (agent, options) => calls.push(['select', agent.id, options.preserveEditors]),
    loadAgentTree: async () => calls.push(['tree']),
  });
  vm.runInContext(source, context);
  return { calls, context, run: (text = '/clear', snapshot = { contextAgentId: 'chat-1' }) =>
    context.executeComposerCommand(intents.parse(text), snapshot) };
}

test('/clear is discoverable and clears persisted state before refreshing the selected chat', async () => {
  assert.equal(intents.parse('  /CLEAR  ').id, 'agent-clear');
  assert.ok(intents.commandCandidates('/cl').some(item => item.label === '/clear'));
  const h = harness();
  await h.run();
  assert.deepEqual(h.calls, [['clear', 'chat-1'], ['gate', 'chat-1'], ['discard', 'chat-1'], ['select', 'chat-1', true]]);
  assert.equal(h.context.runningAgentIds.has('chat-1'), false);
});

test('/clear leaves the UI intact when the backend rejects an active run', async () => {
  const h = harness({ ok: false });
  await assert.rejects(h.run(), /Stop the conversation first/);
  assert.deepEqual(h.calls, [['clear', 'chat-1']]);
  assert.equal(h.context.runningAgentIds.has('chat-1'), true);
});

test('/clear validates arguments, conversation and attachments before clearing', async () => {
  const h = harness();
  await assert.rejects(h.run('/clear all'), /Usage: \/clear/);
  await assert.rejects(h.run('/clear', {}), /Open a conversation first/);
  await assert.rejects(h.run('/clear', { contextAgentId: 'chat-1', attachments: [{}] }), /Remove.*attachments/);
  assert.deepEqual(h.calls, []);
});

test('/clear targets the submitted conversation without reopening it after a view switch', async () => {
  const h = harness({ selected: 'chat-2' });
  await h.run();
  assert.deepEqual(h.calls, [['clear', 'chat-1'], ['gate', 'chat-1'], ['discard', 'chat-1'], ['tree']]);
});
