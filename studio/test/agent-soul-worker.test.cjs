'use strict';

/* Spawned crew workers own their SOUL.md + MEMORY.md (agent/agent-net.cjs).
 *
 * A spawned worker is a FULL agent — same loop, same tools, same edit-review
 * flow as the member that spawned it — so it must own its own pair of files
 * rather than appending to its parent's memory. Before this, AgentNet built
 * worker loops with no soulStore at all, so a worker's `memory` tool answered
 * "This run has no agent memory directory" and the worker could never record
 * anything. The three properties worth pinning:
 *
 *   1. identity — a worker's key is derived from (parent identity, worker
 *      name), so the SAME worker finds its own notes on the next run while a
 *      differently-named helper is a different agent;
 *   2. containment — the worker writes ITS file, never its parent's;
 *   3. degradation — no soulStore, or a parent with no identity, means no key
 *      is invented and the memory tool explains itself instead of pretending.
 *
 * `deferStart: true, operatorAdded: true` admits the worker without running it,
 * so none of this needs a model endpoint: the identity is established at SPAWN
 * time, which is what makes the guarantee hold even for a queued helper.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentNet, workerSoulKey, MAX_WORKER_KEY_CHARS } = require('../agent/agent-net.cjs');
const { AgentSoulStore, sanitizeAgentKey } = require('../agent/agent-soul.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { TOOLS } = require('../agent/tool-registry.cjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reach-worker-soul-'));
}

/* A net with a registered lead carrying a persona identity, plus the store.
 * The lead's loop is never run: only its soulKey is needed here. */
function leadNet({ root = tmpRoot(), parentKey = 'persona-lead', soulStore } = {}) {
  /* `soulStore: null` is a REAL case under test (a net with no store), so the
   * default must be "not supplied" rather than null. `||` is safe here because
   * both falsy forms mean the same thing to this helper. */
  const store = soulStore || new AgentSoulStore(root);
  const net = new AgentNet({ teamRunId: 'net-soul', soulStore: store, sendEvent: () => {} });
  const leadStore = new MemoryStore();
  net.register({
    agentId: 'lead-1', name: 'Lead', model: 'lead',
    loop: { running: false, stop() {} }, store: leadStore, task: 'lead task',
    soulKey: parentKey,
  });
  return { net, store, root };
}

/* Admit a worker without running it — identity is set at spawn. */
function admittedWorker(net, { name, parentId = 'lead-1', prompt = '', soulKey = '' } = {}) {
  const res = net.spawn({
    name, task: 'Do the delegated work.', prompt, parentId, depth: 1,
    deferStart: true, operatorAdded: true, soulKey,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return net.agents.get(res.agentId);
}

const memoryCall = (agent, args) => TOOLS.memory.execute(args, {
  soulDir: agent.loop._soulDir(), agentId: agent.id,
});

test('workerSoulKey derives a safe, stable key from the parent identity and name', () => {
  assert.equal(workerSoulKey('persona-lead', 'Auditor'), 'persona-lead-worker-auditor');
  // The same worker under the same parent always resolves to the same files,
  // which is the whole point: its notes must still be there next run.
  assert.equal(workerSoulKey('persona-lead', 'Auditor'), workerSoulKey('persona-lead', 'Auditor'));
  assert.notEqual(workerSoulKey('persona-lead', 'Auditor'), workerSoulKey('persona-lead', 'Reviewer'));
  assert.notEqual(workerSoulKey('persona-lead', 'Auditor'), workerSoulKey('persona-other', 'Auditor'));

  // Names that are not ids at all are slugged into one segment: no separators,
  // no dots, no spaces, nothing that could traverse out of <root>/agents.
  assert.equal(workerSoulKey('persona-lead', '  Audit /../ or  '), 'persona-lead-worker-audit-or');
  assert.equal(workerSoulKey('persona-lead', '!!!'), 'persona-lead-worker-worker');
  assert.equal(workerSoulKey('persona-lead', ''), 'persona-lead-worker-worker');

  // No parent identity means no key: two unrelated crews must never share one
  // memory file, so nothing is invented.
  assert.equal(workerSoulKey('', 'Auditor'), '');
  assert.equal(workerSoulKey(null, 'Auditor'), '');
  assert.equal(workerSoulKey('   ', 'Auditor'), '');

  // Every derived key is usable by the store, including for an over-long parent
  // (bounded by a digest of the full key, so two long ids still differ).
  const long = 'p'.repeat(200);
  const a = workerSoulKey(long, 'Auditor');
  const b = workerSoulKey('p'.repeat(199) + 'q', 'Auditor');
  for (const key of [a, b, workerSoulKey('persona-lead', 'Auditor')]) {
    assert.ok(key.length <= MAX_WORKER_KEY_CHARS, `${key} must fit the store cap`);
    assert.notEqual(sanitizeAgentKey(key), '', 'a derived key must be usable by the store');
  }
  assert.notEqual(a, b, 'identical prefixes must not collide');
  assert.equal(a.startsWith('p'.repeat(10)), true, 'the parent identity still leads the key');
});

test('a spawned worker gets its own SOUL.md and MEMORY.md, not its parent\'s', async () => {
  const { net, store } = leadNet();
  const worker = admittedWorker(net, { name: 'Auditor', prompt: 'You audit smart contracts.' });

  const key = worker.soulKey;
  assert.equal(key, 'persona-lead-worker-auditor');
  assert.deepEqual(store.exists(key), { soul: true, memory: true }, 'the worker is born with both files');
  // The identity is the WORKER's, in its own directory — the parent's files are
  // not created as a side effect of spawning (the lead has none here).
  assert.deepEqual(store.exists('persona-lead'), { soul: false, memory: false });
  assert.equal(path.dirname(store.paths(key).dir), path.resolve(store.rootDir));

  // Its soul names the worker and carries the caller's prompt as its role.
  const soul = store.read(key, 'soul');
  assert.match(soul, /Auditor/);
  assert.match(soul, /You audit smart contracts\./);

  // The `memory` tool now works from the worker's own loop.
  const appended = await memoryCall(worker, { op: 'append', entry: 'The audit suite is green at 572 tests.' });
  assert.equal(appended.ok, true, JSON.stringify(appended));
  assert.ok(appended.bytes > 0);

  const read = await memoryCall(worker, { op: 'read' });
  assert.equal(read.ok, true);
  assert.match(read.memory, /The audit suite is green at 572 tests\./);

  // …and it landed in the WORKER's memory, never the parent's.
  assert.match(store.read(key, 'memory'), /audit suite is green/);
  assert.doesNotMatch(store.read('persona-lead', 'memory'), /audit suite is green/);
});

test('the worker\'s soul reaches its own prompt, and the parent\'s stays its own', async () => {
  const { net, store } = leadNet();
  store.scaffold('persona-lead', { name: 'Lead' });
  const worker = admittedWorker(net, { name: 'Auditor' });
  await memoryCall(worker, { op: 'append', entry: 'WORKER-NOTE-ONLY' });

  const settings = { features: { agent: true, workspace: true }, approvals: 'prompt', reviewEdits: true };
  worker.store.get(worker.id).settings = structuredClone(settings);

  const workerPrompt = worker.loop._buildSystemPrompt();
  assert.match(workerPrompt, /WORKER-NOTE-ONLY/, 'a worker reads its own memory');
  assert.match(workerPrompt, /<untrusted_data>/, 'worker memory is fenced as data, like every memory');
  assert.match(workerPrompt, /Auditor/);

  // The lead's own prompt must not carry the worker's notes: they are two
  // agents, and a spawned helper's private memory is not the lead's history.
  const { AgentLoop } = require('../agent/agent-loop.cjs');
  const leadStore = new MemoryStore();
  leadStore.get('lead').settings = structuredClone(settings);
  const leadLoop = new AgentLoop({
    agentId: 'lead', store: leadStore, endpoint: 'http://x/v1', model: 'm',
    soulStore: store, soulKey: 'persona-lead',
  });
  assert.doesNotMatch(leadLoop._buildSystemPrompt(), /WORKER-NOTE-ONLY/);
});

test('without a soulStore, or under a parent with no identity, no key is invented', async () => {
  // No store at all: spawning still works and the worker simply has no files.
  const bare = new AgentNet({ teamRunId: 'net-bare', sendEvent: () => {} });
  bare.register({ agentId: 'lead-x', name: 'Lead', loop: { running: false }, store: new MemoryStore(), task: '' });
  const noStore = admittedWorker(bare, { name: 'Auditor', parentId: 'lead-x' });
  assert.equal(noStore.soulKey, '');
  assert.equal(noStore.loop._soulDir(), '');
  const refused = await memoryCall(noStore, { op: 'append', entry: 'x' });
  assert.equal(refused.ok, false, 'a worker with no directory must not believe it recorded anything');
  assert.match(refused.error, /no agent memory directory/);

  // A store, but a parent with no identity: still no key, so two crews cannot
  // silently share one worker memory file.
  const { net, store } = leadNet({ parentKey: '' });
  const anonymous = admittedWorker(net, { name: 'Auditor' });
  assert.equal(anonymous.soulKey, '');
  assert.deepEqual(store.exists('persona-lead-worker-auditor'), { soul: false, memory: false });
  assert.deepEqual(fs.readdirSync(store.rootDir), [], 'nothing may be created without an identity');
});

test('an explicitly supplied identity is honoured, but only when the store accepts it', async () => {
  const { net, store } = leadNet();
  // The operator-added case: a helper that IS a saved persona joins with that
  // persona's own files rather than a derived worker key.
  store.scaffold('persona-adopted', { name: 'Adopted' });
  const adopted = admittedWorker(net, { name: 'Adopted', soulKey: 'persona-adopted' });
  assert.equal(adopted.soulKey, 'persona-adopted');
  assert.deepEqual(store.exists('persona-adopted'), { soul: true, memory: true });

  const appended = await memoryCall(adopted, { op: 'append', entry: 'ADOPTED-NOTE' });
  assert.equal(appended.ok, true, JSON.stringify(appended));
  assert.match(store.read('persona-adopted', 'memory'), /ADOPTED-NOTE/);

  // A key the STORE would refuse is never used to name a directory: the worker
  // falls back to its derived key instead of escaping or impersonating.
  const unsafe = admittedWorker(net, { name: 'Sneaky', soulKey: '../escape' });
  assert.equal(unsafe.soulKey, 'persona-lead-worker-sneaky');
  assert.equal(unsafe.soulKey.includes('..'), false);
});

test('a worker spawned by a worker derives from its own identity, not the root persona', () => {
  const { net } = leadNet();
  const first = admittedWorker(net, { name: 'Auditor' });
  assert.equal(first.soulKey, 'persona-lead-worker-auditor');

  // Grandchild: parentId is the worker's net id, so it inherits the WORKER's
  // identity — the intermediate agent is a real agent with a real key.
  const second = admittedWorker(net, { name: 'Checker', parentId: first.id });
  assert.equal(second.soulKey, 'persona-lead-worker-auditor-worker-checker');
  assert.notEqual(second.soulKey, first.soulKey, 'a grandchild is its own agent');
});
