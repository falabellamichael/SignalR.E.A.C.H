'use strict';

/* Frozen soul-store contract (agent/soul-store.cjs) + the `memory` tool.
 *
 * agent-soul.test.cjs covers the AgentSoulStore the UI and loop use. This file
 * covers the FLAT contract other modules were built against, and the one piece
 * of the feature that is not just reading: an agent WRITING its own memory
 * through the `memory` tool — the "writable by the agent" half of the spec.
 *
 * The three things worth testing are the three that fail silently:
 *   1. idempotence — a second ensure must not touch the agent's own writing;
 *   2. containment — an agent id must not be able to name a directory outside
 *      <userData>/agents, in either direction (traversal OR a sibling escape);
 *   3. the memory tool can only ever reach ITS OWN agent's file, because the
 *      path comes from the loop, never from the tool arguments.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  soulDir,
  soulFiles,
  ensureSoulFiles,
  readSoul,
  readMemory,
  writeSoul,
  appendMemory,
  soulTemplates,
  AGENT_ID_PATTERN,
  MAX_SOUL_CHARS,
  MAX_MEMORY_ENTRY_CHARS,
  MAX_MEMORY_BYTES,
} = require('../agent/soul-store.cjs');
const { TOOLS } = require('../agent/tool-registry.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { AgentSoulStore } = require('../agent/agent-soul.cjs');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reach-soulstore-'));
}

test('ensureSoulFiles creates both files with the specified template shape', () => {
  const userData = tmp();
  const res = ensureSoulFiles('persona-a', userData, { name: 'Auditor', role: 'security', personaPrompt: 'You audit.' });

  assert.equal(res.dir, path.join(userData, 'agents', 'persona-a'));
  assert.equal(res.soul, path.join(res.dir, 'SOUL.md'));
  assert.equal(res.memory, path.join(res.dir, 'MEMORY.md'));
  assert.deepEqual(res.created, { soul: true, memory: true });

  const soul = readSoul(res.soul);
  assert.match(soul, /^# SOUL\.md — Auditor\n/);
  assert.match(soul, /This file is Auditor's persona/);
  assert.match(soul, /- Name: Auditor/);
  assert.match(soul, /- Role: security/);
  assert.match(soul, /- Created: \d{4}-\d{2}-\d{2}T/);
  assert.match(soul, /## How Auditor works/);
  assert.match(soul, /You audit\./, 'the persona prompt becomes the "how it works" body');

  assert.match(readMemory(res.memory), /^# MEMORY\.md — Auditor\n/);
  assert.match(readMemory(res.memory), /Created this agent's memory\./);
});

test('the Role line is omitted entirely when there is no role', () => {
  const userData = tmp();
  const { soul } = soulTemplates({ name: 'Solo', role: '', created: '2026-01-01T00:00:00.000Z' });
  assert.doesNotMatch(soul, /- Role:/, 'an empty role must not render as "Role: "');
  assert.match(soul, /- Name: Solo/);
  // The fallback persona text applies when no personaPrompt was supplied.
  assert.match(soul, /A careful, competent coding agent working in the bound project/);
});

test('ensureSoulFiles is idempotent and never overwrites an agent\'s own writing', () => {
  const userData = tmp();
  const first = ensureSoulFiles('persona-keep', userData, { name: 'Keeper' });
  writeSoul(first.soul, 'HAND EDITED SOUL');
  appendMemory(first.memory, 'a real note');

  const second = ensureSoulFiles('persona-keep', userData, { name: 'Keeper' });
  assert.deepEqual(second.created, { soul: false, memory: false }, 'nothing may be recreated');
  assert.equal(readSoul(second.soul), 'HAND EDITED SOUL');
  assert.match(readMemory(second.memory), /a real note/);
});

test('an agent id cannot escape <userData>/agents', () => {
  const userData = tmp();
  const outside = tmp();
  const bad = ['', '   ', '.', '..', '../escape', 'a/b', 'a\\b', '/abs', 'persona/../x', 'x\u0000y', 'a'.repeat(65)];

  for (const id of bad) {
    assert.throws(() => soulDir(id, userData), /Invalid agent id/, `id ${JSON.stringify(id)} must be refused`);
    assert.throws(() => soulFiles(id, userData), /Invalid agent id/);
    assert.throws(() => ensureSoulFiles(id, userData, { name: 'x' }), /Invalid agent id/);
  }

  // The specific escape the frozen pattern would have allowed: '..' would have
  // resolved to <userData> itself, writing an agent's files into the shared
  // profile root instead of its own folder.
  assert.equal(AGENT_ID_PATTERN.test('..'), true, 'the frozen pattern really did accept ".." (this is the bug)');
  assert.throws(() => soulDir('..', userData), /Invalid agent id/);

  assert.equal(fs.existsSync(path.join(userData, 'SOUL.md')), false, 'nothing written into the profile root');
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written outside the store');
});

test('a legitimate id resolves to an immediate child of <userData>/agents', () => {
  const userData = tmp();
  for (const id of ['persona-mu8ts8qy-24roe4', 'a', 'A', '0', 'a.b-c_d']) {
    assert.equal(path.dirname(soulDir(id, userData)), path.join(userData, 'agents'));
  }
});

test('writeSoul refuses above the character cap and reports bytes otherwise', () => {
  const userData = tmp();
  const { soul } = ensureSoulFiles('persona-cap', userData, { name: 'Cap' });
  assert.throws(() => writeSoul(soul, 'x'.repeat(MAX_SOUL_CHARS + 1)), /cap/);
  const res = writeSoul(soul, 'exact');
  assert.equal(res.bytes, 5);
  assert.equal(readSoul(soul), 'exact');
});

test('appendMemory dates each entry, caps the entry, and refuses at 64 KB', () => {
  const userData = tmp();
  const { memory } = ensureSoulFiles('persona-mem', userData, { name: 'Mem' });

  appendMemory(memory, 'first note');
  appendMemory(memory, 'second note');
  const body = readMemory(memory);
  assert.match(body, /— first note/);
  assert.match(body, /— second note/);
  assert.equal((body.match(/^- \d{4}-\d{2}-\d{2}T/gm) || []).length, 3,
    'the scaffold line plus two appended entries');

  // An oversized entry is truncated to the entry cap rather than rejected.
  const long = appendMemory(memory, 'y'.repeat(MAX_MEMORY_ENTRY_CHARS + 500));
  assert.ok(long.bytes > 0);
  const longLine = readMemory(memory).trim().split('\n').pop();
  assert.ok(longLine.length <= MAX_MEMORY_ENTRY_CHARS + 40, 'the note itself is capped');

  // Fill toward the file cap, then assert the next append is REFUSED rather
  // than silently trimming older history.
  fs.writeFileSync(memory, 'z'.repeat(MAX_MEMORY_BYTES - 10));
  assert.throws(() => appendMemory(memory, 'one more'), /64 KB cap/);
  assert.equal(readMemory(memory).length, MAX_MEMORY_BYTES - 10, 'the refusal left the file untouched');
});

test('missing files read as empty rather than throwing', () => {
  const userData = tmp();
  assert.equal(readSoul(path.join(userData, 'nope', 'SOUL.md')), '');
  assert.equal(readMemory(path.join(userData, 'nope', 'MEMORY.md')), '');
});

test('the memory tool reads and appends the calling agent\'s own file', async () => {
  const userData = tmp();
  const store = new AgentSoulStore(path.join(userData, 'agents'));
  store.scaffold('persona-self', { name: 'Self' });

  // Two agents, to prove the tool cannot cross between them.
  store.scaffold('persona-other', { name: 'Other' });
  store.write('persona-other', 'memory', 'OTHER SECRET');

  const call = (soulKey, args) => {
    const mem = new MemoryStore();
    mem.get('c').settings = { features: { agent: true, workspace: true }, approvals: 'prompt', reviewEdits: true };
    const loop = new AgentLoop({
      agentId: 'c', store: mem, endpoint: 'http://x/v1', model: 'm',
      soulStore: store, soulKey,
    });
    return TOOLS.memory.execute(args, { soulDir: loop._soulDir(), agentId: 'c', agentStore: mem });
  };

  const appended = await call('persona-self', { op: 'append', entry: 'Learned: the suite is green.' });
  assert.equal(appended.ok, true, JSON.stringify(appended));
  assert.ok(appended.bytes > 0);

  const read = await call('persona-self', { op: 'read' });
  assert.equal(read.ok, true);
  assert.match(read.memory, /Learned: the suite is green\./);
  assert.doesNotMatch(read.memory, /OTHER SECRET/, 'an agent must never see another agent\'s memory');

  // The appended note survives into the next run's prompt, fenced as data.
  const mem = new MemoryStore();
  mem.get('c').settings = { features: { agent: true, workspace: true }, approvals: 'prompt', reviewEdits: true };
  const loop = new AgentLoop({
    agentId: 'c', store: mem, endpoint: 'http://x/v1', model: 'm',
    soulStore: store, soulKey: 'persona-self',
  });
  const prompt = loop._buildSystemPrompt();
  assert.match(prompt, /Learned: the suite is green\./);
  assert.match(prompt, /<untrusted_data>/, 'agent-written memory is fenced, not trusted');

  // Unknown op and missing entry are refused with an explanation.
  assert.equal((await call('persona-self', { op: 'delete' })).ok, false);
  assert.match((await call('persona-self', { op: 'append' })).error, /entry is required/i);
});

test('the memory tool explains itself instead of pretending when there is no soul directory', async () => {
  const res = await TOOLS.memory.execute({ op: 'append', entry: 'x' }, { soulDir: '', agentId: 'c' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no agent memory directory/);
});

test('the memory tool is advertised and needs no approval', () => {
  const tool = TOOLS.memory;
  assert.ok(tool, 'the memory tool must be registered');
  assert.equal(tool.approval, false, 'it writes the agent\'s own private file, not the project');
  assert.equal(tool.tier, 'core');
  // It must be described in the default prompt, or an agent will never call it.
  const { toolHelp } = require('../agent/tool-registry.cjs');
  assert.match(toolHelp('core'), /- memory: /);
});
