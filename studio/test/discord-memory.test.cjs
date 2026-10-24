const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiscordMemory } = require('../agent/discord-memory.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');

test('Discord rules precede memory and persona, reload edits, and survive recreation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = new DiscordMemory(root);
  memory.ensure();
  fs.writeFileSync(path.join(memory.dir, 'RULES.md'), 'Always report verified results.');
  fs.writeFileSync(path.join(memory.dir, 'MEMORY.md'), 'Preferred project: editor.');
  const loop = Object.create(AgentLoop.prototype);
  loop.rulesProvider = () => memory.prompt();
  loop._buildBaseSystemPrompt = () => 'PERSONA';
  const prompt = loop._buildSystemPrompt();
  assert.ok(prompt.indexOf('Always report') < prompt.indexOf('Preferred project'));
  assert.ok(prompt.indexOf('Preferred project') < prompt.indexOf('PERSONA'));
  fs.writeFileSync(path.join(memory.dir, 'RULES.md'), 'New owner rule.');
  assert.match(loop._buildSystemPrompt(), /New owner rule/);
  assert.match(new DiscordMemory(root).prompt(), /New owner rule/);
  fs.writeFileSync(path.join(memory.dir, 'RULES.md'), '');
  assert.throws(() => loop._buildSystemPrompt(), /empty/);
  fs.writeFileSync(path.join(memory.dir, 'RULES.md'), 'x'.repeat(12001));
  assert.throws(() => loop._buildSystemPrompt(), /12000 bytes/);
});

test('non-Discord prompts are unchanged without a rules provider', () => {
  const loop = Object.create(AgentLoop.prototype);
  loop._buildBaseSystemPrompt = () => 'original';
  assert.equal(loop._buildSystemPrompt(), 'original');
});
