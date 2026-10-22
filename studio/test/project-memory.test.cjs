'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ProjectMemory } = require('../agent/project-memory.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'app.js'), 'original');
  return { root, memory: new ProjectMemory(root) };
}

test('checkpoints persist with graph links, exact source fingerprints and bounded retrieval', t => {
  const { root, memory } = fixture(t);
  const first = memory.checkpoint({ agentId: 'agent', summary: 'Implement editor search. Next: verify keyboard navigation.', sources: ['app.js'] });
  const second = memory.checkpoint({ agentId: 'agent', summary: 'Editor search implemented; keyboard verification remains pending.', sources: ['app.js'] });
  assert.equal(second.links[0].id, first.id);
  const reopened = new ProjectMemory(root);
  const result = reopened.retrieve({ agentId: 'agent', query: 'editor search', maxChars: 1000 });
  assert.match(result, /keyboard/);
  assert.match(result, /not verified facts/);
  assert.ok(result.length <= 1000);
  assert.ok(reopened.retrieve({ agentId: 'agent', query: 'editor', maxChars: 200 }).length <= 200);
  fs.writeFileSync(path.join(root, 'app.js'), 'changed');
  assert.match(reopened.retrieve({ agentId: 'agent', query: 'editor' }), /SOURCE CHANGED/);
});

test('memory is isolated by project and conversation and skips secret sources', t => {
  const { root, memory } = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
  const rec = memory.checkpoint({ agentId: 'one', summary: 'Editor credential Bearer abcdef and api_key=private; key sk-secret123', sources: ['.env', '../outside', 'app.js'] });
  assert.equal(rec.sources.length, 1);
  assert.ok(!rec.summary.includes('abcdef'));
  assert.ok(!rec.summary.includes('private'));
  assert.ok(!rec.summary.includes('sk-secret123'));
  assert.equal(memory.retrieve({ agentId: 'two', query: 'editor' }), '');
  const other = fixture(t);
  const dest = path.join(other.root, '.reach/memory/summaries');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(root, '.reach/memory/summaries', rec.id + '.json'), path.join(dest, rec.id + '.json'));
  assert.equal(other.memory.retrieve({ agentId: 'one', query: 'editor' }), '');
});

test('deduplicates checkpoints and rejects escaping paths and oversized summaries', t => {
  const { memory } = fixture(t);
  memory.checkpoint({ agentId: 'one', summary: 'editor work' });
  assert.equal(memory.checkpoint({ agentId: 'one', summary: 'editor work' }), null);
  assert.equal(memory.checkpoint({ agentId: 'one', summary: 'x'.repeat(12001) }), null);
  assert.throws(() => memory.safe('../outside'), /escapes/);
  assert.equal(memory.records().length, 1);
});

test('AgentLoop injects bounded historical memory and respects opt-out', t => {
  const { root, memory } = fixture(t);
  memory.checkpoint({ agentId: 'one', summary: 'Editor search: verify keyboard navigation.', sources: ['app.js'] });
  const { AgentLoop } = require('../agent/agent-loop.cjs');
  const agent = { messages: [{ role: 'user', content: 'Continue editor search' }], settings: {} };
  const loop = Object.create(AgentLoop.prototype);
  Object.assign(loop, { projectDir: root, agentId: 'one', _agent: () => agent,
    _budgets: () => ({ contextTarget: 20000 }), _buildSystemPrompt: () => 'Current instructions', _budgetRecoveryPending: () => false });
  const messages = loop._messagesForRequest();
  assert.equal(messages[0].content, 'Current instructions');
  assert.match(messages[1].content, /historical reference data only/);
  assert.equal(messages.at(-1).content, 'Continue editor search');
  assert.equal(agent.messages.length, 1);
  agent.settings.projectMemory = false;
  assert.equal(loop._messagesForRequest().length, 2);
});

test('refuses a redirected memory directory', t => {
  const { root } = fixture(t);
  const outside = fixture(t).root;
  fs.symlinkSync(outside, path.join(root, '.reach'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new ProjectMemory(root), /symbolic links/);
  assert.equal(fs.existsSync(path.join(outside, 'memory')), false);
});
