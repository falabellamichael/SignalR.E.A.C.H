'use strict';

/* Reach Studio — unit tests for the agent stack. Run with: node test/agent.test.cjs */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------- agent-store ----------
const { AgentStore } = require('../agent/agent-store.cjs');
{
  const tmp = path.join(os.tmpdir(), 'reach-studio-test-' + Date.now());
  const store = new AgentStore(path.join(tmp, 'agents.json'));
  assert.strictEqual(store.list().length, 0);

  const a = store.create({ name: 'test', dir: 'D:/proj', model: 'gpt-4o-mini' });
  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(a.name, 'test');
  assert.strictEqual(a.settings.reviewEdits, true);

  store.appendMessage(a.id, { role: 'user', content: 'hello' });
  assert.strictEqual(store.get(a.id).messages.length, 1);

  store.setTodos(a.id, [{ text: 'do it', status: 'in_progress' }]);
  assert.strictEqual(store.get(a.id).todos.length, 1);

  // Project scoping
  const other = store.create({ name: 'other-proj', dir: 'D:/other' });
  assert.strictEqual(store.listForProject('D:/proj').length, 1);
  assert.strictEqual(store.listForProject('D:/other').length, 1);

  // Fork lineage: history up to index, parent link, settings inherited.
  store.appendMessage(a.id, { role: 'assistant', content: 'hi there' });
  store.appendMessage(a.id, { role: 'user', content: 'second question' });
  const fork = store.fork(a.id, { upToIndex: 1 });
  assert.strictEqual(fork.parentChatId, a.id);
  assert.strictEqual(fork.dir, 'D:/proj');
  assert.strictEqual(fork.messages.length, 2, 'fork copies history through index 1');
  assert.strictEqual(fork.settings.reviewEdits, true);
  assert.deepStrictEqual(store.childrenOf(a.id).map(c => c.id), [fork.id]);

  // Tree: root with one child, correct depths.
  const tree = store.tree('D:/proj');
  assert.strictEqual(tree.length, 1);
  assert.strictEqual(tree[0].id, a.id);
  assert.strictEqual(tree[0].depth, 0);
  assert.strictEqual(tree[0].children.length, 1);
  assert.strictEqual(tree[0].children[0].id, fork.id);
  assert.strictEqual(tree[0].children[0].depth, 1);
  // The other project's chat is not in this tree.
  assert.ok(!tree[0].children.some(c => c.id === other.id));

  // Full-history fork (upToIndex -1).
  const fork2 = store.fork(a.id, {});
  assert.strictEqual(fork2.messages.length, store.get(a.id).messages.length);
  assert.strictEqual(fork2.forkIndex, store.get(a.id).messages.length);

  // Pending edits
  store.addPendingEdit(a.id, { editId: 'e1', path: 'index.rsh', proposed: 'x', hunks: [], stats: { added: 1, removed: 0 } });
  assert.ok(store.getPendingEdit(a.id, 'e1'));
  const resolved = store.resolvePendingEdit(a.id, 'e1', true);
  assert.strictEqual(resolved.accepted, true);
  assert.strictEqual(store.getPendingEdit(a.id, 'e1'), null);

  // Queue
  store.enqueue(a.id, 'first');
  store.enqueue(a.id, 'second');
  assert.strictEqual(store.queueLength(a.id), 2);
  assert.strictEqual(store.dequeue(a.id), 'first');
  assert.strictEqual(store.dequeue(a.id), 'second');
  assert.strictEqual(store.dequeue(a.id), null);

  store.remove(a.id);
  store.remove(fork.id);
  store.remove(fork2.id);
  store.remove(other.id);
  assert.strictEqual(store.list().length, 0);
  console.log('✓ agent-store (incl. fork + project tree)');
}

// ---------- edits ----------
const { applyPatch, alreadyApplied } = require('../agent/edits.cjs');
{
  const original = 'line one\nline two\nline three\n';
  const patched = applyPatch(original, [{ search: 'line two', replace: 'LINE TWO' }]);
  assert.strictEqual(patched, 'line one\nLINE TWO\nline three\n');
  assert.strictEqual(alreadyApplied(patched, 'line two', 'LINE TWO'), true);
  console.log('✓ edits');
}

// ---------- diff ----------
const { reviewDiff, stats } = require('../agent/diff.cjs');
{
  const oldT = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n';
  const newT = 'a\nb\nc\nd\ne\nf\ng\nh\nCHANGED\nj\nk\n';
  const hunks = reviewDiff(oldT, newT, 2);
  const s = stats(hunks);
  assert.strictEqual(s.added, 1);
  assert.strictEqual(s.removed, 1);
  assert.ok(hunks.some(h => h.type === 'gap'), 'long unchanged run should collapse into a gap');
  assert.ok(hunks.some(h => h.type === 'add' && h.text === 'CHANGED'));
  assert.ok(hunks.some(h => h.type === 'del' && h.text === 'i'));
  console.log('✓ diff');
}

// ---------- context ----------
const { compactMessages } = require('../agent/context.cjs');
{
  const messages = [
    { role: 'system', content: 'You are a helper.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  compactMessages(messages, async () => 'summary').then((result) => {
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.messages.length, 3);
    console.log('✓ context (no compaction needed)');
  }).catch((e) => { console.error('✗ context', e); process.exit(1); });
}

// ---------- chat-response ----------
const { readChatResponse } = require('../agent/chat-response.cjs');
{
  const fakeResponse = {
    headers: { get: () => 'application/json' },
    json: async () => ({
      choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }],
    }),
  };
  readChatResponse(fakeResponse, { stream: false }).then((r) => {
    assert.strictEqual(r.content, 'hello world');
    assert.strictEqual(r.finishReason, 'stop');
    console.log('✓ chat-response (json)');
  });
}

// ---------- agent-run ----------
const { protocol, start, parse, decide } = require('../agent/agent-run.cjs');
{
  assert.ok(protocol.includes('AGENT RUN CONTROL'));
  const run = start(null);
  assert.strictEqual(run.status, 'running');

  const parsed = parse('Some text\n```agent_status\n{"status":"complete","summary":"done"}\n```\nMore text');
  assert.strictEqual(parsed.control.status, 'complete');
  assert.strictEqual(parsed.text, 'Some text\nMore text');

  const decision = decide(run, { stopped: false, answerNow: false, enabled: true, confirm: null, control: parsed.control, invalid: false, edits: null, tools: false, rounds: 1, roundLimit: 40 });
  assert.strictEqual(decision.action, 'complete');
  console.log('✓ agent-run');
}

// ---------- agent-action ----------
const { actionInstruction, parseActionResponse } = require('../agent/agent-action.cjs');
{
  const inst = actionInstruction();
  assert.ok(inst.includes('EXECUTABLE ACTION RESPONSE'));
  const ok = parseActionResponse(JSON.stringify({ status: 'actions', message: 'reading', actions: [{ name: 'read', arguments: { path: 'index.rsh' } }], options: [] }));
  assert.strictEqual(ok.status, 'actions');
  assert.strictEqual(ok.actions.length, 1);
  const bad = parseActionResponse('not json');
  assert.ok(bad.error);
  console.log('✓ agent-action');
}

// ---------- tool-registry ----------
const { allowedNames, needsApproval, resolveInProject, globMatch } = require('../agent/tool-registry.cjs');
{
  assert.ok(allowedNames().includes('read'));
  assert.ok(allowedNames().includes('reach.compile'));
  assert.strictEqual(needsApproval('reach.compile'), true);
  assert.strictEqual(needsApproval('read'), false);
  assert.throws(() => resolveInProject('D:/proj', '../escape.txt'));
  assert.strictEqual(resolveInProject('D:/proj', 'src/index.rsh'), path.resolve('D:/proj', 'src/index.rsh'));
  assert.ok(globMatch('**/*.rsh', 'src/index.rsh'));
  assert.ok(globMatch('*.rsh', 'index.rsh'));
  assert.ok(!globMatch('*.rsh', 'src/index.rsh'));
  console.log('✓ tool-registry');
}

// ---------- reach-tool-executor ----------
const { buildReachArgs, safeProjectPath } = require('../agent/reach-tool-executor.cjs');
{
  assert.deepStrictEqual(buildReachArgs('reach.compile', { path: 'index.rsh' }), ['compile', 'index.rsh']);
  assert.deepStrictEqual(buildReachArgs('reach.run', { path: 'index.rsh', args: ['--foo'] }), ['run', 'index.rsh', '--foo']);
  assert.deepStrictEqual(buildReachArgs('reach.clean', {}), ['clean']);
  assert.strictEqual(safeProjectPath(null, '../evil'), null);
  assert.strictEqual(safeProjectPath(null, 'ok/file.rsh'), 'ok/file.rsh');
  console.log('✓ reach-tool-executor');
}

// ---------- extractToolBlocks ----------
const { extractToolBlocks } = require('../agent/agent-loop.cjs');
{
  const text = 'Let me read that file.\n```tool\n{"action":"read","path":"index.rsh"}\n```\nAnd compile:\n```tool\n{"action":"reach.compile"}\n```';
  const blocks = extractToolBlocks(text);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].action, 'read');
  assert.strictEqual(blocks[0].path, 'index.rsh');
  assert.strictEqual(blocks[1].action, 'reach.compile');
  console.log('✓ extractToolBlocks');
}

// ---------- AgentLoop end-to-end against a mock SSE endpoint ----------
const { AgentLoop } = require('../agent/agent-loop.cjs');
{
  const tmp = path.join(os.tmpdir(), 'reach-studio-loop-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'index.rsh'), "'reach 0.1';\nexport const main = Reach.App(() => []);\n");

  const store = new AgentStore(path.join(tmp, 'agents.json'));
  const agent = store.create({ name: 'loop-test', dir: tmp, model: 'mock' });
  // Review off so write tools hit the disk directly in the test.
  store.update(agent.id, { settings: { reviewEdits: false, approvals: 'auto-all' } });

  // Mock endpoint: serves two scripted responses as SSE, then captures the
  // final request to prove the tool result was fed back.
  const { createServer } = require('http');
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const script = [
        // Round 1: tool call via fenced block.
        'I will read the file.\n```tool\n{"action":"read","path":"index.rsh"}\n```',
        // Round 2: completion.
        'The file is a minimal Reach app.\n```agent_status\n{"status":"complete","summary":"Read index.rsh and confirmed it is a minimal Reach app."}\n```',
      ];
      const content = script[Math.min(requests.length - 1, script.length - 1)];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const events = [];
    const loop = new AgentLoop({
      agentId: agent.id,
      store,
      endpoint: `http://127.0.0.1:${port}/v1`,
      model: 'mock',
      projectDir: tmp,
      sendEvent: (channel, payload) => events.push(payload),
    });
    try {
      await loop.sendUserMessage('Read index.rsh and tell me what it is.');
      const finalAgent = store.get(agent.id);
      const roles = finalAgent.messages.map(m => m.role);
      assert.deepStrictEqual(roles, ['user', 'assistant', 'tool', 'user', 'assistant'], 'message sequence: ' + roles.join(','));
      assert.ok(finalAgent.messages[2].content.includes('reach 0.1'), 'tool message should contain the file contents');
      assert.strictEqual(requests.length, 2, 'endpoint should be hit exactly twice');
      const secondRequest = JSON.stringify(requests[1]);
      assert.ok(secondRequest.includes('TOOL RESULTS'), 'second request should carry the tool results');
      assert.ok(events.some(e => e.type === 'message-start'), 'message-start emitted');
      assert.ok(events.some(e => e.type === 'delta'), 'delta emitted');
      assert.ok(events.some(e => e.type === 'message-end'), 'message-end emitted');
      assert.ok(events.some(e => e.type === 'tool-call' && e.tool === 'read'), 'tool-call emitted');
      assert.ok(events.some(e => e.type === 'tool-result' && e.ok), 'tool-result emitted');
      assert.ok(events.some(e => e.type === 'run-state' && e.status === 'completed'), 'completed run-state emitted');
      console.log('✓ agent-loop end-to-end (mock SSE endpoint)');
    } catch (e) {
      console.error('✗ agent-loop end-to-end:', e);
      process.exitCode = 1;
    } finally {
      server.close();
    }

    // ---------- edit review flow ----------
    {
      const store2 = new AgentStore(path.join(tmp, 'agents2.json'));
      const a2 = store2.create({ name: 'review-test', dir: tmp });
      const edits = [];
      const reviewCtx = {
        projectDir: tmp,
        agentId: a2.id,
        agentStore: store2,
        requestEditReview: (edit) => { store2.addPendingEdit(a2.id, edit); edits.push(edit); },
      };
      const { TOOLS } = require('../agent/tool-registry.cjs');
      // write with review ON → returns pending, does NOT touch disk.
      const target = path.join(tmp, 'proposed.txt');
      fs.writeFileSync(target, 'before\n');
      const result = await TOOLS.write.execute({ path: 'proposed.txt', content: 'after\n' }, reviewCtx);
      assert.strictEqual(result.pending, true, 'write should return pending under review');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'before\n', 'disk untouched until accept');
      assert.ok(result.stats.added >= 1 && result.stats.removed >= 1, 'stats present');
      const stored = store2.getPendingEdit(a2.id, result.editId);
      assert.ok(stored, 'pending edit stored durably');
      assert.ok(stored.hunks.some(h => h.type === 'add' && h.text === 'after'), 'diff hunks stored');
      // identical content short-circuits review entirely.
      const same = await TOOLS.write.execute({ path: 'proposed.txt', content: 'before\n' }, reviewCtx);
      assert.strictEqual(same.unchanged, true);
      console.log('✓ edit review flow');
    }
  });
}

// ---------- persona-store ----------
const { PersonaStore } = require('../agent/persona-store.cjs');
{
  const tmp = path.join(os.tmpdir(), 'reach-studio-personas-' + Date.now());
  const ps = new PersonaStore(path.join(tmp, 'personas.json'));
  const p1 = ps.createPersona({ name: 'Auditor', model: 'model-a', prompt: 'You audit contracts.' });
  const p2 = ps.createPersona({ name: 'Writer', model: '', prompt: 'You write docs.' });
  assert.strictEqual(ps.listPersonas().length, 2);

  const team = ps.createTeam({ name: 'Crew', mode: 'chain', members: [{ personaId: p1.id, role: 'audit' }, { personaId: p2.id, role: 'docs' }] });
  assert.strictEqual(team.members.length, 2);
  assert.strictEqual(ps.listTeams()[0].members[0].personaName, 'Auditor');

  // Duplicate persona+role rejected; same persona with a different role OK.
  assert.throws(() => ps.createTeam({ name: 'bad', members: [{ personaId: p1.id, role: '' }, { personaId: p1.id, role: '' }] }));
  const dup = ps.createTeam({ name: 'ok-dup', members: [{ personaId: p1.id, role: 'a' }, { personaId: p1.id, role: 'b' }] });
  assert.strictEqual(dup.members.length, 2);

  // Deleting a persona removes it from teams.
  ps.removePersona(p2.id);
  const after = ps.getTeam(team.id);
  assert.strictEqual(after.members.length, 1);

  // Bad mode rejected.
  assert.throws(() => ps.createTeam({ name: 'x', mode: 'swarm', members: [{ personaId: p1.id }] }));

  // Reload from disk (persistence).
  const ps2 = new PersonaStore(path.join(tmp, 'personas.json'));
  assert.strictEqual(ps2.listPersonas().length, 1);
  assert.strictEqual(ps2.listTeams().length, 2);
  console.log('✓ persona-store');
}

// ---------- memory-store ----------
const { MemoryStore } = require('../agent/memory-store.cjs');
{
  const ms = new MemoryStore();
  ms.appendMessage('m1', { role: 'user', content: 'hi' });
  ms.appendMessage('m1', { role: 'assistant', content: 'first' });
  ms.appendMessage('m1', { role: 'assistant', content: '' });
  ms.appendMessage('m1', { role: 'assistant', content: 'final answer' });
  assert.strictEqual(ms.lastAssistantText('m1'), 'final answer');
  assert.strictEqual(ms.get('m1').messages.length, 4);
  assert.strictEqual(ms.lastAssistantText('nobody'), '');
  console.log('✓ memory-store');
}

// ---------- crew roles (agent/roles.cjs) ----------
const { ROLES, getRole, listRoleChoices } = require('../agent/roles.cjs');
{
  assert.strictEqual(ROLES.length, 20, 'exactly 20 preset roles');
  assert.strictEqual(new Set(ROLES.map(r => r.id)).size, 20, 'role ids are unique');
  assert.strictEqual(new Set(ROLES.map(r => r.name)).size, 20, 'role names are unique');
  assert.ok(ROLES.every(r => typeof r.tagline === 'string' && r.tagline.length > 10), 'every role carries a tagline');
  assert.ok(ROLES.every(r => typeof r.protocol === 'string' && r.protocol.length > 120), 'every role carries a real protocol');
  // Every protocol must reference crew collaboration, or the "web" is a menu.
  assert.ok(ROLES.every(r => /agent\.(send|status|await|list)|Coordinator|peer|crew/i.test(r.protocol)), 'every protocol names crew interaction');
  assert.ok(getRole('coordinator'), 'coordinator resolves by id');
  assert.strictEqual(getRole('nope'), null, 'unknown role ids resolve to null');
  assert.ok(listRoleChoices().every(c => !('protocol' in c)), 'UI choices carry no prompt text');
  console.log('✓ crew roles (20 presets)');
}

// ---------- agent-net: links mailbox, budget, completion sentinel ----------
const { AgentNet, linksCompleteIn } = require('../agent/agent-net.cjs');
{
  const net = new AgentNet({ rosterMailbox: true, linkBudget: 2 });
  net.preRegister({ agentId: 'm0-a', name: 'Alpha' });
  net.preRegister({ agentId: 'm1-b', name: 'Beta' });
  const recB = net.attach('m1-b', { running: false }, { get: () => ({}) });
  recB.status = 'completed';
  const d1 = net.send({ from: 'm0-a', to: 'Beta', message: 'please verify my draft' });
  assert.strictEqual(d1.delivered, 'mailbox', 'links mailbox accepts a message for a finished roster member');
  assert.strictEqual(recB.inbox.length, 1, 'message buffered in the inbox');
  const d2 = net.send({ from: 'm0-a', to: 'Beta', message: 'one more thing' });
  assert.strictEqual(d2.ok, true, 'second exchange allowed');
  const d3 = net.send({ from: 'm0-a', to: 'Beta', message: 'over budget' });
  assert.strictEqual(d3.ok, false, 'links budget caps total exchanges');
  assert.ok(/budget/i.test(d3.error || ''), 'budget refusal explains itself');
  assert.strictEqual(net.linkSends, 2, 'exactly two exchanges counted');

  const net2 = new AgentNet({ rosterMailbox: true });
  net2.preRegister({ agentId: 'x-1', name: 'One' });
  net2.preRegister({ agentId: 'x-2', name: 'Two' });
  const recTwo = net2.attach('x-2', { running: false }, { get: () => ({}) });
  recTwo.status = 'completed';
  net2.send({ from: 'x-1', to: 'Two', message: 'all work verified\ndone\nLINKS: COMPLETE' });
  assert.ok(net2.linksComplete && net2.linksComplete.by === 'One', 'completion declaration travels in messages');
  assert.ok(linksCompleteIn('blah LINKS: complete blah'), 'sentinel matcher is case/space tolerant');
  assert.ok(!linksCompleteIn('no declaration here'), 'matcher does not false-positive');

  const net3 = new AgentNet({});
  net3.preRegister({ agentId: 'y-1', name: 'One' });
  const recC = net3.attach('y-1', { running: false }, { get: () => ({}) });
  recC.status = 'completed';
  const refused = net3.send({ from: 'y-0', to: 'One', message: 'hi' });
  assert.strictEqual(refused.ok, false, 'without links mode, finished roster members stay un-wakeable');
  console.log('✓ agent-net links mailbox + budget + sentinel');
}

// ---------- team-runner (parallel + chain, mock SSE endpoint) ----------
const { TeamRunner } = require('../agent/team-runner.cjs');
{
  const { createServer } = require('http');
  const hits = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      hits.push(parsed);
      // Reply identifies the persona (from the system prompt) and echoes any
      // HANDOFF block so the chain test can prove relay happened.
      const sys = parsed.messages[0].content;
      const who = /You are (Alpha|Beta)/.exec(sys);
      const userMsg = parsed.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
      const relay = /HANDOFF FROM (\w+)[^\n]*:\n([\s\S]*)/.exec(userMsg);
      const content = `I am ${who ? who[1] : 'unknown'}.` + (relay ? ` Relay from ${relay[1]}: ${relay[2].trim().slice(0, 40)}` : '')
        + (/LINK MESSAGES from the crew/.test(userMsg) ? ' Reviewed the draft and I am satisfied.' : '')
        + '\n```agent_status\n{"status":"complete","summary":"done"}\n```'
        + (/LINK MESSAGES from the crew/.test(userMsg) ? '\nLINKS: COMPLETE' : '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  server.listen(0, '127.0.0.1', async () => {
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    const events = [];
    const sendEvent = (channel, payload) => events.push(payload);

    // --- parallel: two members, same task, simultaneous ---
    const parallelTeam = { id: 't1', name: 'Par', mode: 'parallel', members: [{ personaId: 'pa' }, { personaId: 'pb' }] };
    const parallelRun = new TeamRunner({
      team: parallelTeam,
      personas: [
        { id: 'pa', name: 'Alpha', model: 'm1', prompt: 'You are Alpha.' },
        { id: 'pb', name: 'Beta', model: 'm2', prompt: 'You are Beta.' },
      ],
      task: 'Analyze the contract.',
      projectDir: '', endpoint, accessKey: '', defaultModel: 'm0',
      sendEvent,
    });
    hits.length = 0;
    await parallelRun.run('run-p');
    assert.strictEqual(hits.length, 2, 'parallel: both members called the endpoint');
    assert.strictEqual(new Set(hits.map(h => h.model)).size, 2, 'parallel: each member used its own model');
    const pDone = events.filter(e => e.type === 'done').pop();
    assert.strictEqual(pDone.results.length, 2);
    assert.ok(pDone.results.every(r => r.ok), 'parallel: both members ok');
    assert.ok(pDone.answer.includes('【Alpha】') && pDone.answer.includes('【Beta】'), 'parallel answer has both outputs');
    assert.ok(events.some(e => e.type === 'member' && e.memberType === 'delta' && e.name === 'Alpha'), 'member deltas forwarded with identity');
    console.log('✓ team-runner parallel');

    // --- chain: member 2 receives member 1's output ---
    events.length = 0;
    const chainTeam = { id: 't2', name: 'Chain', mode: 'chain', members: [{ personaId: 'pa' }, { personaId: 'pb' }] };
    const chainRun = new TeamRunner({
      team: chainTeam,
      personas: [
        { id: 'pa', name: 'Alpha', model: 'm1', prompt: 'You are Alpha.' },
        { id: 'pb', name: 'Beta', model: 'm2', prompt: 'You are Beta.' },
      ],
      task: 'Review then document.',
      projectDir: '', endpoint, accessKey: '', defaultModel: 'm0',
      sendEvent,
    });
    hits.length = 0;
    await chainRun.run('run-c');
    assert.strictEqual(hits.length, 2, 'chain: two sequential calls');
    const secondPrompt = JSON.stringify(hits[1].messages);
    assert.ok(secondPrompt.includes('HANDOFF FROM Alpha'), 'chain: second member got the handoff block');
    assert.ok(secondPrompt.includes('I am Alpha'), 'chain: handoff carries the first member output');
    const cDone = events.filter(e => e.type === 'done').pop();
    assert.ok(cDone.results.every(r => r.ok));
    assert.ok(cDone.answer.includes('Relay from Alpha'), 'chain answer reflects relayed context');
    console.log('✓ team-runner chain');

    // --- links: a peer network. A mid-run message (the delivery a member's
    // agent.send tool makes) wakes the finished peer for one more turn; that
    // turn declares LINKS: COMPLETE and ends the run. ---
    events.length = 0;
    const linksTeam = { id: 't3', name: 'Links', mode: 'links', members: [{ personaId: 'pa', roleId: 'coordinator' }, { personaId: 'pb' }] };
    const linksRun = new TeamRunner({
      team: linksTeam,
      personas: [
        { id: 'pa', name: 'Alpha', model: 'm1', prompt: 'You are Alpha.' },
        { id: 'pb', name: 'Beta', model: 'm2', prompt: 'You are Beta.' },
      ],
      task: 'Draft then review.',
      projectDir: '', endpoint, accessKey: '', defaultModel: 'm0',
      sendEvent: (channel, payload) => {
        events.push(payload);
        // Deterministic inject: the moment Beta finishes its first turn,
        // "Alpha" messages it — exactly what Alpha's agent.send tool does.
        if (payload && payload.type === 'member-done' && payload.index === 1 && payload.retake !== true) {
          linksRun.net.send({ from: 'm0-pa', to: 'Beta', message: 'Review my draft please.' });
        }
      },
    });
    hits.length = 0;
    await linksRun.run('run-l');
    const lDone = events.filter(e => e.type === 'done').pop();
    assert.strictEqual(lDone.mode, 'links', 'links run reports its mode');
    assert.strictEqual(hits.length, 3, 'links: Beta ran a second turn after the message');
    const wakePrompt = JSON.stringify(hits[2].messages);
    assert.ok(wakePrompt.includes('Review my draft please.'), 'links: the message reached Beta\'s next turn');
    assert.ok(wakePrompt.includes('OPEN PEER NETWORK') || wakePrompt.includes('LINKS MODE'), 'links: wake prompt carries the peer-network protocol');
    assert.ok(lDone.links && lDone.links.rounds === 1 && lDone.links.exchanges === 1, 'links: one round, one exchange');
    assert.strictEqual(lDone.links.completedBy, 'Beta', 'links: completion attributed to the declaring member');
    assert.ok(lDone.answer.includes('LINKS: COMPLETE'), 'links: answer carries the completion declaration');
    assert.ok(events.some(e => e.type === 'links-round' && (e.waking || []).includes('Beta')), 'links: the round event names the woken member');
    console.log('✓ team-runner links');

    // --- stop mid-run: chain with 2 members, stop after the first starts ---
    events.length = 0;
    const stopRun = new TeamRunner({
      team: chainTeam,
      personas: [
        { id: 'pa', name: 'Alpha', model: 'm1', prompt: 'You are Alpha.' },
        { id: 'pb', name: 'Beta', model: 'm2', prompt: 'You are Beta.' },
      ],
      task: 'Long job.',
      projectDir: '', endpoint, accessKey: '', defaultModel: 'm0',
      sendEvent,
    });
    const stopPromise = stopRun.run('run-s');
    // Stop synchronously: run() has already entered the chain loop (member 0
    // dispatched), and the chain re-checks `stopped` before every subsequent
    // member — deterministic, unlike a timer racing a localhost mock.
    stopRun.stop();
    await stopPromise;
    const sDone = events.filter(e => e.type === 'done').pop();
    assert.ok(sDone.stopped === true || sDone.results.length < 2, 'stop halts the chain');
    console.log('✓ team-runner stop');

    server.close();
    console.log('\nAll unit tests passed.');
  });
}
