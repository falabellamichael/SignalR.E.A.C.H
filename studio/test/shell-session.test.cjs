'use strict';

/* Coverage for the persistent shell session tool (Codex write_stdin parity).
 * `node -i` is the portable interactive target: it evaluates piped stdin
 * line-by-line on every platform this suite runs on. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const root = process.env.REACH_TEST_ROOT || path.resolve(__dirname, '..');
const { TOOLS } = require(path.join(root, 'agent/tool-registry.cjs'));
const sessions = require(path.join(root, 'agent/shell-session.cjs'));
const { disabledTools } = require(path.join(root, 'agent/tool-policy.cjs'));

const tool = TOOLS['shell.session'];
const cwd = () => os.tmpdir();
const ctx = (agentId = 'agent-test', signal = new AbortController().signal) => ({ agentId, projectDir: cwd(), signal });

async function openSession(c = ctx()) {
  const result = await tool.execute({ op: 'open', command: 'node -i' }, c);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.sessionId);
  return result.sessionId;
}

test('open/write/read/close round-trips interactive output', async () => {
  const c = ctx();
  const id = await openSession(c);
  const wrote = await tool.execute({ op: 'write', command: 'node -i', sessionId: id, chars: 'console.log(6*7)\n', yieldMs: 2500 }, c);
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.match(wrote.output, /42/);
  const again = await tool.execute({ op: 'read', command: 'node -i', sessionId: id, yieldMs: 200 }, c);
  assert.equal(again.ok, true);
  const closed = await tool.execute({ op: 'close', command: 'node -i', sessionId: id }, c);
  assert.equal(closed.ok, true);
  const after = await tool.execute({ op: 'write', command: 'node -i', sessionId: id, chars: '1\n' }, c);
  assert.equal(after.ok, false);
});

test('sessions are owned by their agent and bounded per agent', async () => {
  const owner = ctx('owner'), other = ctx('other');
  const id = await openSession(owner);
  const stolen = await tool.execute({ op: 'read', command: 'node -i', sessionId: id }, other);
  assert.equal(stolen.ok, false);
  assert.match(stolen.error, /different agent/);
  const ids = [id];
  for (let i = 1; i < sessions.MAX_SESSIONS_PER_AGENT; i++) ids.push(await openSession(owner));
  const over = await tool.execute({ op: 'open', command: 'node -i' }, owner);
  assert.equal(over.ok, false);
  assert.match(over.error, /Session limit/);
  for (const s of ids) await tool.execute({ op: 'close', command: 'node -i', sessionId: s }, owner);
});

test('run abort kills the session', async () => {
  const controller = new AbortController();
  const c = ctx('abortee', controller.signal);
  const id = await openSession(c);
  controller.abort();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(sessions.sessions.has(id), false);
});

test('exec class and policy wiring', () => {
  assert.equal(tool.class, 'exec');
  assert.equal(tool.approval, true);
  assert.equal(tool.tier, 'core');
  assert.ok(disabledTools({ features: { terminal: false } }, TOOLS).includes('shell.session'));
  assert.ok(disabledTools({ features: { workspace: false } }, TOOLS).includes('shell.session'));
  assert.deepEqual(tool.commandPaths, ['command', 'chars']);
});
