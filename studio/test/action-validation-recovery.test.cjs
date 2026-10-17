'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = process.env.REACH_TEST_ROOT || path.resolve(__dirname, '..');
const { parseActionResponse } = require(path.join(root, 'agent/agent-action.cjs'));
const { parseAgentResponse, chatPreviewText } = require(path.join(root, 'agent/agent-response.cjs'));
const { AgentLoop } = require(path.join(root, 'agent/agent-loop.cjs'));
const { MemoryStore } = require(path.join(root, 'agent/memory-store.cjs'));
const { defaults } = require(path.join(root, 'agent/budgets.cjs'));
// Byte-exact action payload from the reported run, without profile data.
const captured = fs.readFileSync(path.join(__dirname, 'fixtures/malformed-edit-patch.txt'), 'utf8');
const action = JSON.stringify({ status: 'actions', message: 'Apply the targeted border change.',
  actions: [{ name: 'edit_patch', arguments: { path: 'sudoku.html',
    hunks: [{ search: '.cell { border: 0; }', replace: '.cell { border: 1px solid; }' }] } }], options: [] });
const complete = JSON.stringify({ status: 'complete', message: 'The targeted patch was applied.', actions: [], options: [] });

test('captured malformed edit is rejected with a precise delimiter error and no raw JSON display', () => {
  const parsed = parseAgentResponse(captured);
  assert.equal(parsed.invalid, true);
  assert.deepEqual(parsed.actions, []);
  assert.match(parsed.error, /Expected } before \] at character \d+/);
  assert.match(parsed.display, /No actions from this response were executed/);
  assert.doesNotMatch(parsed.display, /"status"|"hunks"|thick-bottom/);
  for (let end = 1; end <= captured.length; end++) assert.equal(chatPreviewText(captured.slice(0, end)), '');
});

test('diagnostics respect strings and escapes and never repair executable content', () => {
  const valid = JSON.stringify({ status: 'actions', message: 'Read braces: } ] " \\',
    actions: [{ name: 'read', arguments: { path: 'file}].txt' } }], options: [] });
  assert.equal(parseAgentResponse(valid).invalid, false);
  for (const raw of [valid.slice(0, -1), valid.slice(0, 23), '{"status":"actions","message":}', captured]) {
    assert.ok(parseActionResponse(raw).error);
    assert.deepEqual(parseAgentResponse(raw).actions, []);
  }
  const mixed = JSON.stringify({ status: 'complete', message: 'Done', actions: JSON.parse(action).actions });
  assert.match(parseAgentResponse(mixed).error, /Terminal responses cannot contain actions/);
  assert.deepEqual(parseAgentResponse(mixed).actions, []);
});

async function fixture(t, replies, reviewEdits = false) {
  const requests = [], events = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-action-recovery-'));
  fs.writeFileSync(path.join(dir, 'sudoku.html'), '.cell { border: 0; }\n');
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const content = replies[requests.length - 1];
    res.setHeader('Content-Type', 'application/json');
    if (content === undefined) { res.writeHead(400); res.end('{"error":{"message":"Unexpected request"}}'); return; }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new MemoryStore(), agent = store.get('validation-recovery');
  agent.settings = { reviewEdits };
  agent.pendingEdits = {};
  const loop = new AgentLoop({ agentId: agent.id, store, projectDir: dir, model: 'ornith-1.5-9b',
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    budgets: { ...defaults, requestPacing: false, retryLimit: 0, codeContext: false, autoCompact: false },
    requestEditReview: edit => { agent.pendingEdits[edit.editId] = edit; },
    sendEvent: (_, event) => events.push(event) });
  return { loop, agent, requests, events, file: path.join(dir, 'sudoku.html') };
}

test('AgentLoop recovers the captured failure, applies only the new valid patch, and completes', async t => {
  const f = await fixture(t, [captured, action, complete]);
  await f.loop.sendUserMessage('Fix the cell border with a targeted patch.');
  assert.equal(f.requests.length, 3);
  assert.equal(f.agent.runState.status, 'completed');
  assert.equal(fs.readFileSync(f.file, 'utf8'), '.cell { border: 1px solid; }\n');
  assert.deepEqual(f.events.filter(e => e.type === 'tool-call').map(e => e.tool), ['edit_patch']);
  const correction = f.requests[1].messages.filter(m => m.role === 'user').at(-1).content;
  assert.match(correction, /Expected } before \]/);
  assert.match(correction, /one hunk per response/);
  assert.match(correction, /do not replace the whole file/);
  assert.match(correction, /"hunks":\[.*\}\]\}\}\]/);
  const failed = f.agent.messages.find(m => m.role === 'assistant');
  assert.equal(failed.content, captured, 'original response is retained for diagnostics');
  assert.equal(failed._reachMeta.validationError, parseActionResponse(captured).error);
  for (const event of f.events.filter(e => e.type === 'message-end')) assert.doesNotMatch(event.content || '', /"status"|"hunks"/);
});

test('repeated malformed replies stop at the recovery bound without touching the file', async t => {
  const f = await fixture(t, [captured, captured, captured]);
  await f.loop.sendUserMessage('Fix the cell border.');
  assert.equal(f.requests.length, 3);
  assert.equal(f.agent.runState.status, 'paused');
  assert.match(f.agent.runState.reason, /Last validation error:.*Expected } before \]/);
  assert.equal(f.events.filter(e => e.type === 'tool-call').length, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '.cell { border: 0; }\n');
});

test('recovered edits still require review when review is enabled', async t => {
  const f = await fixture(t, [captured, action], true);
  await f.loop.sendUserMessage('Propose the cell border fix.');
  assert.equal(f.requests.length, 2);
  assert.equal(f.agent.runState.status, 'waiting_edits');
  assert.equal(Object.keys(f.agent.pendingEdits).length, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '.cell { border: 0; }\n');
});
