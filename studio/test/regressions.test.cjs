'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentStore } = require('../agent/agent-store.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { parseAgentResponse } = require('../agent/agent-response.cjs');
const { readTextFile, writeTextFile } = require('../agent/text-files.cjs');
const { TOOLS } = require('../agent/tool-registry.cjs');
const { listDirectory } = require('../agent/file-browser.cjs');

test('file browser keeps root source visible despite hundreds of build artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-browser-'));
  try {
    fs.mkdirSync(path.join(dir, 'build'));
    for (let i = 0; i < 601; i++) fs.writeFileSync(path.join(dir, 'build', `${i}.txt`), 'fixture');
    fs.writeFileSync(path.join(dir, 'query_cli.py'), 'print("source")');
    fs.writeFileSync(path.join(dir, '.env.example'), 'EXAMPLE=true');
    fs.mkdirSync(path.join(dir, '.vscode'));
    const root = await listDirectory(dir);
    assert.ok(root.tree.some(e => e.path === 'query_cli.py'));
    assert.ok(root.tree.some(e => e.path === '.env.example'));
    assert.ok(root.tree.some(e => e.path === '.vscode'));
    assert.ok(root.tree.every(e => e.depth === 0 && !e.path.includes('/')));
    const names = [];
    let offset = 0;
    do {
      const page = await listDirectory(dir, 'build', offset);
      assert.ok(page.tree.length <= 250);
      names.push(...page.tree.map(e => e.path));
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(names.length, 601);
    assert.equal(new Set(names).size, 601);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file browser exposes deep folders and reports invalid paths rather than empty success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-browser-deep-'));
  try {
    const deep = 'a/b/c/d/e/f/g/h';
    fs.mkdirSync(path.join(dir, deep), { recursive: true });
    fs.writeFileSync(path.join(dir, deep, 'source.py'), 'source');
    assert.equal((await listDirectory(dir, deep)).tree[0].path, deep + '/source.py');
    await assert.rejects(listDirectory(dir, '../'), /traversal/);
    await assert.rejects(listDirectory(dir, 'missing'), /ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const action = (status, message, actions = [], options = []) => JSON.stringify({ status, message, actions, options });
const tool = (name, args) => ({ name, arguments: args });
const complete = action('complete', 'Done.');
function fixture(replies, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-regression-'));
  fs.writeFileSync(path.join(dir, 'hello.py'), 'print("hello")\n');
  const store = new AgentStore(path.join(dir, 'state', 'agents.json'));
  const agent = store.create({ name: 'regression', dir, model: 'fixture-model' });
  store.update(agent.id, { settings: { maxRounds: 6 } });
  const events = [], requests = [];
  const loop = new AgentLoop({ agentId: agent.id, store, projectDir: dir, endpoint: 'http://127.0.0.1/v1',
    sendEvent: (_, event) => events.push(event), ...options });
  loop._fetchChat = async messages => {
    requests.push(messages);
    const reply = replies[requests.length - 1];
    if (reply === undefined) throw new Error('Unexpected extra model request');
    return new Response(JSON.stringify({ choices: [{ message: typeof reply === 'string' ? { content: reply } : reply, finish_reason: 'stop' }] }),
      { headers: { 'content-type': 'application/json' } });
  };
  return { loop, store, agent, events, requests, dir };
}

test('structured recovery supplies schema and completes once', async () => {
  const f = fixture(['I will inspect it.', action('actions', 'Reading Python.', [tool('read', { path: 'hello.py' })]), complete]);
  await f.loop.sendUserMessage('Read the Python file.');
  assert.equal(f.agent.runState.status, 'completed');
  assert.equal(f.requests.length, 3);
  assert.match(f.requests[1][0].content, /EXECUTABLE ACTION RESPONSE/);
  assert.doesNotMatch(f.requests[1][0].content, /emit each action as a fenced/);
  assert.match(f.requests[0][0].content, /may be Python/);
  assert.deepEqual(f.events.filter(e => e.type === 'run-state').map(e => e.status), ['running', 'completed']);
  assert.ok(f.requests[2].every(m => m.role !== 'tool' && !m._reachMeta && !m.tool_call_id));
  assert.ok(f.events.some(e => e.type === 'message-end' && e.content === 'Done.'));
});

test('greeting with a valid completion does not trigger recovery', async () => {
  const f = fixture([action('complete', 'Doing well, thanks!')]);
  await f.loop.sendUserMessage('how are you');
  assert.equal(f.requests.length, 1);
  assert.equal(f.agent.runState.status, 'completed');
});

test('heyy screenshot: two unmarked replies are provisional, final answer appears once', async () => {
  const f = fixture(["Hello! I'm REACH Studio, ready to help with your project. How can I assist you today?",
    'Hello! How can I help you with your project today?',
    action('complete', 'Hello! How can I help you with your project today?')]);
  await f.loop.sendUserMessage('heyy');
  assert.match(f.requests[0][0].content, /EXECUTABLE ACTION RESPONSE/);
  const ends = f.events.filter(e => e.type === 'message-end');
  assert.deepEqual(ends.map(e => e.provisional), [true, true, false]);
  const replies = f.agent.messages.filter(m => m.role === 'assistant' && m._reachMeta.source !== 'recovery-attempt');
  assert.equal(replies.length, 1);
  assert.equal(replies[0]._reachMeta.display, 'Hello! How can I help you with your project today?');
  assert.equal(f.agent.runState.status, 'completed');
});

test('plain promises still cannot complete unfinished coding work', async () => {
  const f = fixture(['I will fix it.', 'I will fix it.', 'I will fix it.']);
  await f.loop.sendUserMessage('Fix the bug in hello.py.');
  assert.equal(f.agent.runState.status, 'paused');
  assert.equal(f.events.filter(e => e.type === 'message-end' && !e.provisional).length, 1);
});

test('legacy tool blocks still work when resuming a paused structured run', async () => {
  const f = fixture(['```tool\n{"action":"list","path":""}\n```', complete]);
  f.store.setRunState(f.agent.id, { status: 'paused', structuredActions: true });
  await f.loop.sendUserMessage('continue');
  assert.equal(f.agent.runState.status, 'completed');
  assert.ok(f.events.some(e => e.type === 'tool-result' && e.tool === 'list' && e.ok));
});

for (const response of [action('question', 'Which file?', [], ['hello.py']), '```confirm\n{"question":"Which file?","options":["hello.py"]}\n```']) {
  test('question becomes waiting_input and choices, without recovery: ' + response.slice(0, 20), async () => {
    const f = fixture([response]);
    await f.loop.sendUserMessage('Change a file.');
    assert.equal(f.agent.runState.status, 'waiting_input');
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.events.find(e => e.question)?.question.options, ['hello.py']);
    assert.equal(f.events.find(e => e.type === 'message-end').content, '', 'Question appears once in its choice card');
    assert.doesNotMatch(f.events.find(e => e.type === 'message-end').content, /```|"question"/);
  });
}

test('native calls dispatch through the same registry', async () => {
  const f = fixture([{ content: null, tool_calls: [{ type: 'function', function: { name: 'read', arguments: '{"path":"hello.py"}' } }] }, complete]);
  await f.loop.sendUserMessage('Read the file.');
  assert.equal(f.agent.runState.status, 'completed');
  assert.ok(f.events.some(e => e.type === 'tool-result' && e.ok));
});

test('truncated, unknown, mixed, and nested actions never execute', () => {
  for (const response of [
    '```tool\n{"action":"read","path":"hello.py"}',
    '```tool\n{"action":"unknown"}\n```',
    action('complete', 'Done', [tool('write', { path: 'x', content: 'bad' })]),
    '```tool\n{"action":"write","path":"x"}\n```\n```agent_status\n{"status":"complete","summary":"done"}\n```',
    '```tool\n{"action":"read"}\n```\n```confirm\n{"question":"okay?"}\n```',
  ]) assert.deepEqual(parseAgentResponse(response).actions, []);
  assert.deepEqual(parseAgentResponse('````markdown\n```tool\n{"action":"write","path":"x"}\n```\n````').actions, []);
  assert.deepEqual(parseAgentResponse('> ```tool\n> {"action":"write","path":"x"}\n> ```').actions, []);
});

test('pending edits pause for review before another request and preserve original file', async () => {
  const f = fixture([action('actions', 'Proposing edit.', [tool('write', { path: 'hello.py', content: 'print("updated")\n' })])]);
  f.loop.requestEditReview = edit => f.store.addPendingEdit(f.agent.id, edit);
  await f.loop.sendUserMessage('Update the greeting.');
  assert.equal(f.agent.runState.status, 'waiting_edits');
  assert.equal(f.requests.length, 1);
  assert.equal(fs.readFileSync(path.join(f.dir, 'hello.py'), 'utf8'), 'print("hello")\n');
  assert.equal(Object.keys(f.agent.pendingEdits).length, 1);
});

test('open todos prevent completion, cancelled todos do not', async () => {
  const f = fixture([complete, complete, complete]);
  f.store.setTodos(f.agent.id, [{ text: 'Unfinished', status: 'pending' }]);
  await f.loop.sendUserMessage('Finish the work.');
  assert.equal(f.agent.runState.status, 'paused');
  const g = fixture([complete]);
  g.store.setTodos(g.agent.id, [{ text: 'No longer needed', status: 'cancelled' }]);
  await g.loop.sendUserMessage('Done');
  assert.equal(g.agent.runState.status, 'completed');
});

test('transport errors persist a resumable state', async () => {
  const f = fixture([]);
  await f.loop.sendUserMessage('Hello');
  assert.equal(f.agent.runState.status, 'paused');
  assert.notEqual(new AgentStore(f.store.filePath).get(f.agent.id).runState.status, 'running');
});

test('restarting the app cannot leave an abandoned run marked running', () => {
  const f = fixture([]);
  f.store.setRunState(f.agent.id, { status: 'running', structuredActions: true });
  const reloaded = new AgentStore(f.store.filePath).get(f.agent.id);
  assert.equal(reloaded.runState.status, 'paused');
  assert.equal(reloaded.runState.structuredActions, true);
});

test('Stop while awaiting approval prevents execution and leaves queued work unrun', async () => {
  let approvalStarted;
  const ready = new Promise(resolve => { approvalStarted = resolve; });
  const f = fixture([action('actions', 'Compile.', [tool('reach.compile', {})])], {
    requestApproval: () => { approvalStarted(); return new Promise(() => {}); },
    reachExecutor: () => { throw new Error('Must not execute'); },
  });
  const running = f.loop.sendUserMessage('Compile.');
  await ready;
  await f.loop.sendUserMessage('Queued task');
  f.loop.stop();
  await running;
  assert.equal(f.agent.runState.status, 'stopped');
  assert.equal(f.store.queueLength(f.agent.id), 1);
  assert.equal(f.requests.length, 1);
});

test('bytecode and binary data cannot be read, overwritten, or proposed as text', async () => {
  const f = fixture([]);
  for (const file of ['sample.pyc', 'binary.bin', 'invalid.txt']) {
    const abs = path.join(f.dir, file);
    const bytes = file === 'invalid.txt' ? Buffer.from([0x80, 0xff]) : Buffer.from([65, 0, 66, 13, 10]);
    fs.writeFileSync(abs, bytes);
    assert.throws(() => readTextFile(abs), /binary|Binary|bytecode/);
    assert.throws(() => writeTextFile(abs, 'replacement'), /binary|Binary|bytecode/);
    await assert.rejects(TOOLS.write.execute({ path: file, content: 'replacement' }, {
      projectDir: f.dir, requestEditReview: () => assert.fail('Cannot propose binary edit'),
    }), /binary|Binary|bytecode/);
    assert.deepEqual(fs.readFileSync(abs), bytes);
  }
});

test('UTF-8, UTF-8 BOM, and both UTF-16 BOM formats survive edits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-encoding-'));
  const text = 'café — 你好\r\n';
  for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'utf16be']) {
    const abs = path.join(dir, encoding + '.txt');
    let bytes = Buffer.from(text, encoding.startsWith('utf8') ? 'utf8' : 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    const bom = encoding === 'utf8' ? [] : encoding === 'utf8-bom' ? [0xef, 0xbb, 0xbf] : encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff];
    fs.writeFileSync(abs, Buffer.concat([Buffer.from(bom), bytes]));
    assert.equal(readTextFile(abs).content, text);
    writeTextFile(abs, text + 'updated');
    assert.equal(readTextFile(abs).content, text + 'updated');
    assert.deepEqual([...fs.readFileSync(abs).subarray(0, bom.length)], bom);
  }
});

test('search and listing skip Python cache while keeping Python source', async () => {
  const f = fixture([]);
  fs.mkdirSync(path.join(f.dir, '__pycache__'));
  fs.writeFileSync(path.join(f.dir, '__pycache__', 'hello.pyc'), Buffer.from([0, 65, 66]));
  const result = await TOOLS.list.execute({ path: '' }, { projectDir: f.dir });
  assert.match(result.tree, /hello.py/);
  assert.doesNotMatch(result.tree, /__pycache__|hello.pyc/);
});

test('recursive scans enforce one global result limit across sibling directories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-scan-limit-'));
  try {
    for (let d = 0; d < 4; d++) {
      fs.mkdirSync(path.join(dir, String(d)));
      for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(dir, String(d), `${i}.txt`), 'needle\n');
    }
    const ctx = { projectDir: dir };
    const [glob, search, list] = await Promise.all([
      TOOLS.glob.execute({ pattern: '**/*.txt' }, ctx),
      TOOLS.search.execute({ pattern: 'needle' }, ctx),
      TOOLS.list.execute({}, ctx),
    ]);
    assert.equal(glob.matches.length, 200);
    assert.equal(search.matches.length, 200);
    assert.equal(list.tree.split('\n').length, 300);
    assert.ok(glob.truncated && search.truncated && list.truncated);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a pathological search regex cannot freeze the main event loop and Stop interrupts it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-scan-stop-'));
  fs.writeFileSync(path.join(dir, 'slow.txt'), 'a'.repeat(50000) + '!');
  const controller = new AbortController();
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  const stop = setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(TOOLS.search.execute({ pattern: '(a+)+$', regex: true }, { projectDir: dir, signal: controller.signal }), /abort/i);
    assert.ok(ticks >= 5, `main-thread heartbeat ran ${ticks} times`);
    await assert.rejects(TOOLS.search.execute({ pattern: '(a+)+$', regex: true }, { projectDir: dir, scanTimeoutMs: 200 }), /timed out/);
  } finally {
    clearTimeout(stop); clearInterval(heartbeat);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function localEndpoint(t, handler) {
  const server = require('node:http').createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => handler(JSON.parse(body), res));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function jsonReply(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}
function teamFixture(endpoint, overrides = {}) {
  const { TeamRunner } = require('../agent/team-runner.cjs');
  const events = [];
  const runner = new TeamRunner({ team: { name: 'Test team', mode: 'parallel', members: [{}, {}] },
    personas: [{ id: 'a', name: 'A', model: 'a' }, { id: 'b', name: 'B', model: 'b' }],
    endpoint, task: 'Inspect the fixture.', sendEvent: (_, event) => events.push(event), ...overrides });
  return { runner, events };
}

for (const bodyStarted of [false, true]) {
  test(`model deadline covers ${bodyStarted ? 'a stalled response body' : 'missing response headers'}`, async t => {
    const endpoint = await localEndpoint(t, (_, res) => {
      if (bodyStarted) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); }
    });
    const f = teamFixture(endpoint, { requestTimeoutMs: 150 });
    const result = await f.runner.run('deadline');
    assert.ok(result.every(r => !r.ok && r.status === 'paused' && /exceeded/.test(r.error)));
    assert.equal(f.runner.running, false);
    assert.equal(f.events.filter(e => e.type === 'done').length, 1);
  });
}

test('team stop cancels both members waiting on model streams', async t => {
  let started = 0, ready;
  const bothStarted = new Promise(resolve => { ready = resolve; });
  const endpoint = await localEndpoint(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n');
    if (++started === 2) ready();
  });
  const f = teamFixture(endpoint);
  const running = f.runner.run('stop');
  await bothStarted;
  f.runner.stop();
  const result = await running;
  assert.ok(result.every(r => !r.ok && r.status === 'stopped'));
  assert.equal(f.runner.loops.size, 0);
});

test('team does not call paused members successful or relay their unfinished output', async t => {
  let requests = 0;
  const endpoint = await localEndpoint(t, (_, res) => { requests++; jsonReply(res, 'I will inspect it.'); });
  const f = teamFixture(endpoint, { team: { name: 'Chain', mode: 'chain', members: [{}, {}] } });
  const result = await f.runner.run('paused');
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, false);
  assert.equal(result[0].status, 'paused');
  assert.ok(result[0].error);
  assert.equal(requests, 3, 'only first member and its two format recoveries');
});

test('structured team handoffs and answers contain only the visible answer', async t => {
  const requests = [];
  const endpoint = await localEndpoint(t, (body, res) => { requests.push(body); jsonReply(res, action('complete', 'Readable answer.')); });
  const f = teamFixture(endpoint, { team: { name: 'Chain', mode: 'chain', members: [{}, {}] } });
  const result = await f.runner.run('handoff');
  assert.ok(result.every(r => r.ok && r.output === 'Readable answer.'));
  const handoff = requests[1].messages.find(m => m.content.includes('HANDOFF FROM'));
  assert.match(handoff.content, /HANDOFF FROM A.*\nReadable answer\./);
  assert.doesNotMatch(handoff.content, /"status"|"actions"/);
});

test('an empty provider reply reports its real diagnostic once', async t => {
  let requests = 0;
  const endpoint = await localEndpoint(t, (_, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'thinking' }, finish_reason: 'length' }] }));
  });
  const f = teamFixture(endpoint);
  const result = await f.runner.run('empty');
  assert.equal(requests, 2);
  assert.ok(result.every(r => !r.ok && /reasoning.*no final answer.*token limit/.test(r.error)));
});

test('long conversations compact and resume against an endpoint allowing only one initial system message', async t => {
  const { MEMORY_PREFIX } = require('../agent/context.cjs');
  const requests = [];
  const endpoint = await localEndpoint(t, (body, res) => {
    requests.push(body);
    if (body.messages.some((m, i) => m.role === 'system' && i !== 0)) {
      res.writeHead(400); res.end('System message must be at the beginning.'); return;
    }
    jsonReply(res, body.stream ? action('complete', 'Long conversation completed.') : 'Preserve the fixture goal.');
  });
  const f = fixture([]);
  f.store.setMessages(f.agent.id, Array.from({ length: 74 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Synthetic turn ${i}` })));
  const loop = new AgentLoop({ agentId: f.agent.id, store: f.store, endpoint, projectDir: f.dir });
  await loop.sendUserMessage('Finish the fixture.');
  assert.equal(f.agent.runState.status, 'completed');
  const memory = f.agent.messages.find(m => m.content.startsWith(MEMORY_PREFIX));
  assert.equal(memory.role, 'user');
  // Also cover old persisted memories, without requiring a destructive migration.
  memory.role = 'system';
  await loop.sendUserMessage('Continue after reloading an older memory.');
  assert.equal(f.agent.runState.status, 'completed');
  for (const request of requests.filter(r => r.stream)) {
    assert.deepEqual(request.messages.flatMap((m, i) => m.role === 'system' ? [i] : []), [0]);
    assert.ok(request.messages.some(m => m.role === 'user' && m.content.startsWith(MEMORY_PREFIX)));
    assert.doesNotMatch(request.messages[0].content, /REACH conversation memory/);
  }
});

test('request normalization preserves instructions and treats legacy memory as data without mutating history', () => {
  const { normalizeChatMessages, MEMORY_PREFIX } = require('../agent/context.cjs');
  const input = [{ role: 'system', content: 'Primary instructions.' }, { role: 'user', content: 'Task.' },
    { role: 'system', content: MEMORY_PREFIX + '\nUntrusted summary.' }, { role: 'developer', content: 'Additional instructions.' }];
  const before = JSON.stringify(input);
  const result = normalizeChatMessages(input);
  assert.deepEqual(result.map(m => m.role), ['system', 'user', 'user']);
  assert.equal(result[0].content, 'Primary instructions.\n\nAdditional instructions.');
  assert.equal(JSON.stringify(input), before);
});

/* ---------- multiagent crew behaviour (pause/resume, relay, concurrency) ---------- */

const { TeamRunner } = require('../agent/team-runner.cjs');

function crewFixture(endpoint, { replies, mode = 'parallel', members = [{}], personas, projectDir = '', ...rest } = {}) {
  const events = [];
  const requests = [];
  let call = 0;
  const runner = new TeamRunner({
    team: { name: 'Crew', mode, members },
    personas: personas || [{ id: 'a', name: 'A', model: 'a' }],
    endpoint, task: 'Do the job.', projectDir,
    sendEvent: (_, event) => events.push(event),
    ...rest,
  });
  // Scripted model: each call takes the next reply (per-member queues keyed by
  // the persona model so parallel members stay deterministic).
  const queue = new Map();
  runner._fetchScript = (model) => {
    if (!queue.has(model)) queue.set(model, []);
    return queue.get(model);
  };
  return { runner, events, requests };
}

test('a member that proposes an edit pauses, resumes after acceptance, and completes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-crew-'));
  fs.writeFileSync(path.join(dir, 'index.rsh'), 'old content\n');
  const endpoint = await localEndpoint(t, (body, res) => {
    const model = body.model;
    if (model === 'a' && !body.messages.some(m => m.content.includes('ACCEPTED and written to disk'))) {
      jsonReply(res, action('actions', 'Writing the fix.', [tool('write', { path: 'index.rsh', content: 'new content\n' })]));
    } else {
      jsonReply(res, action('complete', 'Wrote it.'));
    }
  });
  const seenEdits = [];
  const f = crewFixture(endpoint, {
    projectDir: dir,
    requestEditReview: (edit) => seenEdits.push(edit),
    awaitEditResolution: async (refs) => refs.map(r => ({ ...r, accepted: true })),
  });
  const result = await f.runner.run('edit-resume');
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, true, 'member should complete after its edit was accepted, got: ' + JSON.stringify(result[0]));
  assert.equal(result[0].output, 'Wrote it.');
  assert.equal(seenEdits.length, 1);
  assert.equal(seenEdits[0].path, 'index.rsh');
  assert.equal(seenEdits[0].memberName, 'A');
  assert.equal(fs.readFileSync(path.join(dir, 'index.rsh'), 'utf8'), 'old content\n',
    'the runner itself must NOT write; teams:resolveEdit in main does');
  assert.ok(f.events.some(e => e.type === 'member-waiting'), 'member-waiting emitted');
  assert.ok(f.events.some(e => e.type === 'member-resumed'), 'member-resumed emitted');
});

test('a member whose edits are all rejected fails with a clear reason, not a silent pass', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-crew-'));
  fs.writeFileSync(path.join(dir, 'index.rsh'), 'old\n');
  const endpoint = await localEndpoint(t, (_, res) => {
    jsonReply(res, action('actions', 'Writing.', [tool('write', { path: 'index.rsh', content: 'new\n' })]));
  });
  const f = crewFixture(endpoint, {
    projectDir: dir,
    requestEditReview: () => {},
    awaitEditResolution: async (refs) => refs.map(r => ({ ...r, accepted: false })),
  });
  const result = await f.runner.run('edit-reject');
  assert.equal(result[0].ok, false);
  assert.match(result[0].error, /not accepted/);
});

test('a member that asks a question waits, receives the answer, and completes', async t => {
  const endpoint = await localEndpoint(t, (body, res) => {
    if (!body.messages.some(m => m.content.includes('ANSWER FROM THE USER'))) {
      jsonReply(res, action('question', 'Which contract should I audit?', [], ['index.rsh', 'treasury.rsh']));
    } else {
      jsonReply(res, action('complete', 'Auditing treasury.rsh now.'));
    }
  });
  let asked = null;
  const f = crewFixture(endpoint, {
    requestMemberAnswer: async (q) => { asked = q; return 'treasury.rsh'; },
  });
  const result = await f.runner.run('question-resume');
  assert.equal(result[0].ok, true, 'member should complete after being answered: ' + JSON.stringify(result[0]));
  assert.equal(asked.question, 'Which contract should I audit?');
  assert.equal(asked.name, 'A');
  assert.ok(asked.questionId);
  const qEvent = f.events.find(e => e.type === 'member-question');
  assert.ok(qEvent && qEvent.questionId === asked.questionId);
  // The resume message must carry the marker the endpoint script keys on.
  const resumed = f.events.filter(e => e.type === 'member' && e.memberType === 'message' && e.role === 'user');
  assert.ok(resumed.some(e => e.content.includes('ANSWER FROM THE USER: treasury.rsh')));
});

test('chain relays the FULL crew transcript: member 3 sees handoffs from members 1 AND 2', async t => {
  const bodies = [];
  const endpoint = await localEndpoint(t, (body, res) => {
    bodies.push(body);
    const who = /You are (Alpha|Beta|Gamma)/.exec(body.messages[0].content);
    jsonReply(res, action('complete', `Findings from ${who ? who[1] : '?'}.`));
  });
  const f = crewFixture(endpoint, {
    mode: 'chain',
    members: [{ role: 'audit' }, { role: 'fix' }, { role: 'document' }],
    personas: [
      { id: 'a', name: 'Alpha', model: 'a', prompt: 'You are Alpha.' },
      { id: 'b', name: 'Beta', model: 'b', prompt: 'You are Beta.' },
      { id: 'c', name: 'Gamma', model: 'c', prompt: 'You are Gamma.' },
    ],
  });
  const result = await f.runner.run('multihop');
  assert.equal(result.length, 3);
  assert.ok(result.every(r => r.ok));
  const third = bodies[2].messages.map(m => m.content).join('\n');
  assert.match(third, /HANDOFF FROM Alpha \(audit\)/);
  assert.match(third, /HANDOFF FROM Beta \(fix\)/);
  assert.match(third, /Findings from Alpha\./);
  assert.match(third, /Findings from Beta\./);
  // Crew context: Gamma knows it is third of three and mid-pipeline.
  assert.match(third, /You are Gamma, and your role on this crew is: document/);
  assert.match(third, /crew working in sequence/);
});

test('parallel members know the crew and their own role (crew context in every prompt)', async t => {
  const bodies = [];
  const endpoint = await localEndpoint(t, (body, res) => {
    bodies.push(body);
    jsonReply(res, action('complete', 'ok'));
  });
  const f = crewFixture(endpoint, {
    members: [{ role: 'auditor' }, { role: 'fixer' }],
    personas: [{ id: 'a', name: 'A', model: 'a' }, { id: 'b', name: 'B', model: 'b' }],
  });
  await f.runner.run('crew-awareness');
  assert.equal(bodies.length, 2);
  for (const [i, body] of bodies.entries()) {
    const text = body.messages.map(m => m.content).join('\n');
    assert.match(text, /CREW CONTEXT/);
    assert.match(text, /mode: parallel/);
    assert.match(text, /- A \(auditor\)/);
    assert.match(text, /- B \(fixer\)/);
    assert.match(text, /← YOU/);
    assert.match(text, i === 0 ? /You are A, and your role on this crew is: auditor/ : /You are B, and your role on this crew is: fixer/);
  }
});

test('parallel runs are capped at the concurrency limit and results stay index-aligned', async t => {
  let inFlight = 0, maxInFlight = 0;
  const endpoint = await localEndpoint(t, async (body, res) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 60));
    inFlight--;
    jsonReply(res, action('complete', `done ${body.model}`));
  });
  const f = crewFixture(endpoint, {
    members: [{}, {}, {}, {}],
    personas: [
      { id: 'p1', name: 'P1', model: 'm1' }, { id: 'p2', name: 'P2', model: 'm2' },
      { id: 'p3', name: 'P3', model: 'm3' }, { id: 'p4', name: 'P4', model: 'm4' },
    ],
    concurrency: 2,
  });
  const result = await f.runner.run('concurrency');
  assert.equal(result.length, 4);
  assert.ok(result.every(r => r.ok));
  assert.ok(maxInFlight <= 2, `concurrency cap violated: ${maxInFlight} in flight`);
  assert.ok(maxInFlight >= 2, `expected real overlap, saw ${maxInFlight}`);
  // Index alignment: each result carries its own member's identity.
  assert.deepEqual(result.map(r => r.name), ['P1', 'P2', 'P3', 'P4']);
  assert.deepEqual(result.map(r => r.output), ['done m1', 'done m2', 'done m3', 'done m4']);
});

test('stop while a member waits for edit review unwinds the whole run', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-crew-'));
  fs.writeFileSync(path.join(dir, 'index.rsh'), 'old\n');
  const endpoint = await localEndpoint(t, (_, res) => {
    jsonReply(res, action('actions', 'Writing.', [tool('write', { path: 'index.rsh', content: 'new\n' })]));
  });
  const f = crewFixture(endpoint, {
    projectDir: dir,
    requestEditReview: () => {},
    // Never resolves on its own — only Stop can end this wait.
    awaitEditResolution: () => new Promise(() => {}),
  });
  const running = f.runner.run('stop-during-review');
  await new Promise(r => setTimeout(r, 300)); // let the member reach the pause
  f.runner.stop();
  const result = await running;
  assert.equal(f.runner.running, false);
  assert.ok(result.length <= 1);
  const done = f.events.find(e => e.type === 'done');
  assert.ok(done && done.stopped === true);
});

async function waitForControl(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Run control did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('individual Stop retains context, does not stop peers, and Start resumes only unfinished work', async t => {
  const requests = [];
  const endpoint = await localEndpoint(t, (body, res) => {
    requests.push(body);
    if (body.model === 'b' || body.messages.some(m => m.content.startsWith('Continue the original task'))) {
      jsonReply(res, action('complete', 'Finished.'));
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting\n\n');
    }
  });
  const { runner } = crewFixture(endpoint, { members: [{}, {}], personas: [{ id: 'a', name: 'A', model: 'a' }, { id: 'b', name: 'B', model: 'b' }] });
  t.after(() => runner.stop());
  const work = runner.run('individual-controls');
  await waitForControl(() => requests.length === 2 && runner.controls[1].finished);
  runner.controlMember(0, false);
  await waitForControl(() => !runner.loops.get('m0-a').running);
  assert.equal(runner.controls[0].paused, true);
  assert.equal(runner.controls[1].finished, true);
  assert.equal(runner.running, true);
  runner.controlMember(0, true);
  const results = await work;
  assert.ok(results.every(r => r.ok));
  assert.equal(requests.filter(r => r.model === 'b').length, 1);
  assert.ok(requests.at(-1).messages.some(m => m.content.startsWith('Do the job.')));
  assert.throws(() => runner.controlMember(20, true), /not found/);
});

test('global Stop holds queued members and Start continues the chain without replaying earlier members', async t => {
  const requests = [];
  const endpoint = await localEndpoint(t, (body, res) => {
    requests.push(body);
    if (body.model === 'b' && !body.messages.some(m => m.content.startsWith('Continue the original task'))) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n');
    } else jsonReply(res, action('complete', 'Finished ' + body.model));
  });
  const { runner } = crewFixture(endpoint, { mode: 'chain', members: [{}, {}, {}], personas: ['a', 'b', 'c'].map(id => ({ id, name: id, model: id })) });
  t.after(() => runner.stop());
  const work = runner.run('chain-controls');
  await waitForControl(() => requests.length === 2);
  runner.pause();
  await waitForControl(() => !runner.loops.get('m1-b').running);
  assert.equal(requests.length, 2);
  assert.equal(runner.controls[2].paused, true);
  runner.resume();
  assert.ok((await work).every(r => r.ok));
  assert.deepEqual(requests.map(r => r.model), ['a', 'b', 'b', 'c']);
  assert.ok(requests.at(-1).messages.some(m => m.content.includes('HANDOFF FROM a') && m.content.includes('HANDOFF FROM b')));
});

test('spawned workers stay stopped when peers send messages and resume their saved task', async t => {
  const { AgentNet } = require('../agent/agent-net.cjs');
  const requests = [];
  const endpoint = await localEndpoint(t, (body, res) => {
    requests.push(body);
    if (requests.length === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n');
    } else jsonReply(res, action('complete', 'Worker finished.'));
  });
  const net = new AgentNet({ endpoint });
  t.after(() => net.stop());
  const child = net.spawn({ name: 'Worker', task: 'Original worker task' });
  await waitForControl(() => requests.length === 1);
  net.controlWorker(child.agentId, false);
  const rec = net.agents.get(child.agentId);
  await waitForControl(() => !rec.loop.running);
  assert.equal(net.send({ from: 'peer', to: child.agentId, message: 'Extra context' }).delivered, 'queued');
  assert.equal(rec.loop.running, false);
  net.controlWorker(child.agentId, true);
  await net.settle();
  assert.equal(rec.status, 'completed');
  assert.ok(requests[1].messages.some(m => m.content === 'Original worker task'));
  assert.ok(requests.some(r => r.messages.some(m => m.content.includes('Extra context'))));
});
