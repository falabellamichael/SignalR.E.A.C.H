'use strict';
const { test: nodeTest } = require('node:test');
const test = (name, options, fn) => typeof options === 'function' ? nodeTest(name, { timeout: 10000 }, options) : nodeTest(name, options, fn);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { AgentStore } = require('../agent/agent-store.cjs');
const { TOOLS } = require('../agent/tool-registry.cjs');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = (actions = []) => ({ content: JSON.stringify({ status: actions.length ? 'actions' : 'complete', message: 'Done.', actions, options: [] }) });
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-steering-'));
  const store = new AgentStore(path.join(dir, 'agents.json'));
  const agent = store.create({ name: 'Fixture', dir, model: 'fixture-model' });
  store.update(agent.id, { settings: { maxRounds: 6, autoCompact: false } });
  const events = [];
  const loop = new AgentLoop({ agentId: agent.id, store, projectDir: dir, endpoint: 'http://127.0.0.1/v1', sendEvent: (_, event) => events.push(event), ...options });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store, agent, events, loop };
}

test('steering aborts a real pending HTTP response and the next request contains guidance', { timeout: 10000 }, async t => {
  const started = defer(), requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    if (requests.length === 1) { started.resolve(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: reply(), finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const f = fixture(t, { endpoint: `http://127.0.0.1:${server.address().port}/v1` });
  let applied = 0;
  const running = f.loop.sendUserMessage('Start the work.');
  await started.promise;
  const answerSignal = f.loop.answerController.signal;
  assert.equal(f.loop.steerUserMessage('Correction: use COBALT.', { onApplied: () => applied++ }).ok, true);
  assert.equal(answerSignal.aborted, true);
  assert.equal(f.loop.abortController.signal.aborted, false);
  await running;
  assert.equal(requests.length, 2); assert.equal(applied, 1);
  assert.ok(requests[1].messages.some(m => m.content === 'Correction: use COBALT.'));
  assert.equal(f.agent.runState.status, 'completed');
});

test('a provider reply racing steering cannot execute stale actions', async t => {
  const f = fixture(t), started = defer(), release = defer(); let calls = 0;
  f.loop._budgetedAnswer = async messages => {
    if (++calls === 1) { started.resolve(); await release.promise; return reply([{ name: 'write', arguments: { path: 'stale.txt', content: 'bad' } }]); }
    assert.ok(messages.some(m => m.content === 'Do not write that file.'));
    return reply();
  };
  const running = f.loop.sendUserMessage('Work.'); await started.promise;
  f.loop.steerUserMessage('Do not write that file.'); release.resolve(); await running;
  assert.equal(calls, 2); assert.equal(fs.existsSync(path.join(f.dir, 'stale.txt')), false);
  assert.equal(f.events.some(e => e.type === 'tool-call'), false);
});

test('an executing tool finishes, later writes are skipped, and guidance reaches the next round', async t => {
  const f = fixture(t), started = defer(), release = defer(); let calls = 0, executed = 0, toolSignal;
  const originalTool = TOOLS.write;
  TOOLS.write = { ...originalTool, class: 'write', tier: 'core', approval: false, budget: 1000, help: 'Fixture', execute: async (_args, ctx) => {
    executed++; toolSignal = ctx.signal; started.resolve(); await release.promise; return { ok: true, value: 'finished-current-tool' };
  } };
  t.after(() => { TOOLS.write = originalTool; });
  f.loop._budgetedAnswer = async messages => {
    if (++calls === 1) return reply([{ name: 'write', arguments: { path: 'first.txt', content: 'first' } }, { name: 'write', arguments: { path: 'second.txt', content: 'second' } }]);
    const text = messages.map(m => m.content).join('\n');
    assert.match(text, /finished-current-tool/); assert.match(text, /Not executed: new user guidance arrived/); assert.match(text, /Change direction/);
    return reply();
  };
  const running = f.loop.sendUserMessage('Work.'); await started.promise;
  f.loop.steerUserMessage('Change direction.'); assert.equal(toolSignal.aborted, false);
  release.resolve(); await running; assert.equal(executed, 1); assert.equal(calls, 2);
});

test('guidance during approval prevents the stale command from starting', async t => {
  const started = defer(), approval = defer(); let executed = 0, calls = 0;
  const f = fixture(t, { requestApproval: () => { started.resolve(); return approval.promise; } });
  const originalTool = TOOLS.shell;
  TOOLS.shell = { ...originalTool, class: 'exec', tier: 'core', approval: true, budget: 1000, help: 'Fixture', execute: async () => { executed++; return { ok: true }; } };
  t.after(() => { TOOLS.shell = originalTool; });
  f.loop._budgetedAnswer = async () => ++calls === 1 ? reply([{ name: 'shell', arguments: { command: 'node --version' } }]) : reply();
  const running = f.loop.sendUserMessage('Work.'); await started.promise;
  f.loop.steerUserMessage('Use the new requirement.'); approval.resolve(true); await running;
  assert.equal(executed, 0); assert.equal(calls, 2);
});

test('guidance does not bypass pending edit review and is applied on resume', async t => {
  const f = fixture(t), started = defer(), release = defer(); let calls = 0, applied = 0;
  const originalTool = TOOLS.write;
  TOOLS.write = { ...originalTool, class: 'write', tier: 'core', approval: false, budget: 1000, help: 'Fixture', execute: async () => {
    f.agent.pendingEdits = { fixture: {} }; started.resolve(); await release.promise; return { ok: true, pending: true };
  } };
  t.after(() => { TOOLS.write = originalTool; });
  f.loop._budgetedAnswer = async () => ++calls === 1 ? reply([{ name: 'write', arguments: { path: 'review.txt', content: 'review' } }]) : reply();
  const running = f.loop.sendUserMessage('Work.'); await started.promise;
  f.loop.steerUserMessage('Preserve formatting.', { onApplied: () => applied++ }); release.resolve(); await running;
  assert.equal(f.agent.runState.status, 'waiting_edits'); assert.equal(calls, 1); assert.equal(applied, 0);
  assert.equal((await f.loop.resumeAfterEditReview()).reason, 'pending-edits');
  f.agent.pendingEdits = {}; await f.loop.resumeAfterEditReview();
  assert.equal(calls, 2); assert.equal(applied, 1);
});

test('repeated steering respects the configured round limit', async t => {
  const f = fixture(t); f.store.update(f.agent.id, { settings: { maxRounds: 2 } }); let calls = 0;
  f.loop._budgetedAnswer = async () => { calls++; f.loop.steerUserMessage('Another correction.'); return reply(); };
  await f.loop.sendUserMessage('Work.');
  assert.equal(calls, 2); assert.equal(f.agent.runState.status, 'paused'); assert.equal(f.loop.steering.length, 1);
});

test('pending team messages persist across AgentStore reload and clear with the conversation', t => {
  const f = fixture(t), pending = [{ id: 'q', message: 'Follow up later.', state: 'queued' }];
  f.store.setTeamMessageQueue(f.agent.id, pending);
  const reloaded = new AgentStore(path.join(f.dir, 'agents.json'));
  assert.deepEqual(reloaded.get(f.agent.id).teamMessageQueue, pending);
  reloaded.clear(f.agent.id);
  assert.deepEqual(reloaded.get(f.agent.id).teamMessageQueue, []);
});
