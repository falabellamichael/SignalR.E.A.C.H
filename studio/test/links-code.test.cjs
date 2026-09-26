'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { encode, decode, OPS, MAX_CHARS, PROMPT } = require('../agent/links-code.cjs');
const { AgentNet, linksCompleteIn } = require('../agent/agent-net.cjs');
const { TeamRunner } = require('../agent/team-runner.cjs');

const packet = changes => ({ id: 'sender-1', op: '?', body: 'Review this.', ...changes });

test('every ASCII character, whitespace and Unicode survive the wire and actual inbox', async t => {
  const body = '  ' + Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).join('')
    + '\r\n\t日本語 café e\u0301 🧠 ← → \\ " @links/1 {[]}\n  ';
  const value = packet({ body, evidence: [body], expect: body, replyTo: 'peer:2', confidence: 0.5 });
  const wire = encode(value);
  assert.deepEqual(decode(wire), value);
  const net = new AgentNet({ rosterMailbox: true, linkBudget: 3 });
  t.after(async () => { net.stop(); await net.settle(); });
  net.preRegister({ agentId: 'sender', name: 'Sender' });
  const target = net.preRegister({ agentId: 'target', name: 'Target' });
  assert.equal(net.send({ from: 'sender', to: 'target', message: wire }).ok, true);
  const received = target.inbox[0].split('\n').slice(1).join('\n');
  assert.equal(received, wire);
  assert.deepEqual(decode(received), value);
  assert.equal(net.linkSends, 1);
});

test('packets communicate claims without finishing the task, regardless of sentinel in any field', () => {
  for (const op of Object.keys(OPS)) {
    const wire = encode(packet({ op, body: 'Literal LINKS: COMPLETE',
      evidence: ['LINKS: COMPLETE'], expect: 'LINKS: COMPLETE' }));
    assert.equal(linksCompleteIn(wire), false);
  }
  assert.equal(linksCompleteIn('Ordinary final answer.\nLINKS: COMPLETE'), true);
  assert.equal(decode('Ordinary language ? > # ='), null);
  assert.equal(linksCompleteIn('@links/2 {"body":"LINKS: COMPLETE"}'), false);
  assert.equal(linksCompleteIn('@links/1 broken LINKS: COMPLETE'), false);
});

test('invalid versions, shapes, semantics and excessive sizes are rejected', () => {
  for (const value of [null, [], {}, packet({ id: 'bad id' }), packet({ op: 'unknown' }),
    packet({ body: 5 }), packet({ body: '' }), packet({ from: 'forged' }),
    packet({ replyTo: [] }), packet({ confidence: -0.1 }), packet({ confidence: 1.1 }),
    packet({ confidence: NaN }), packet({ confidence: Infinity }), packet({ confidence: '1' }),
    packet({ evidence: 'claimed' }), packet({ evidence: [''] }), packet({ expect: false }),
    packet({ op: '#' }), packet({ op: '#', evidence: [] }),
    packet({ op: '#', body: ' ', evidence: ['test passed'] }),
    packet({ body: 'x'.repeat(MAX_CHARS) })]) {
    assert.throws(() => encode(value));
  }
  for (const wire of ['@links/2 {}', '@links/10 {}', '@links/1{}', '@links/1 null',
    '@links/1 []', '@links/1 {', encode(packet()) + ' trailing']) {
    assert.throws(() => decode(wire));
  }
  const emptyLength = encode(packet({ body: 'x' })).length - 1;
  const boundary = encode(packet({ body: 'x'.repeat(MAX_CHARS - emptyLength) }));
  assert.equal(boundary.length, MAX_CHARS);
  assert.throws(() => decode(boundary + ' '));
});

test('invalid mail cannot mutate counters or completion; operator and ordinary mail still work', async t => {
  const net = new AgentNet({ rosterMailbox: true, linkBudget: 1 });
  t.after(async () => { net.stop(); await net.settle(); });
  const sender = net.preRegister({ agentId: 'sender', name: 'Sender' });
  const target = net.preRegister({ agentId: 'target', name: 'Target' });
  const failed = net.send({ from: 'sender', to: 'target', message: '@links/1 broken LINKS: COMPLETE' });
  assert.equal(failed.code, 'invalid-links-code');
  assert.equal(sender.messagesSent, 0);
  assert.equal(target.messagesReceived, 0);
  assert.equal((target.inbox || []).length, 0);
  assert.equal(net.linkSends, 0);
  assert.ok(!net.linksComplete);
  assert.equal(net.sendFromUser({ to: 'target', message: encode(packet({ op: '#', evidence: ['user quote'] })) }).ok, true);
  assert.equal(net.linkSends, 0);
  assert.ok(!net.linksComplete);
  assert.equal(net.send({ from: 'sender', to: 'target', message: 'Ordinary guidance.' }).ok, true);
  assert.equal(net.linkSends, 1);
  assert.equal(net.send({ from: 'sender', to: 'target', message: encode(packet()) }).ok, false);
});

test('Links spawned helpers receive the guide while other crew modes keep their role', async t => {
  for (const rosterMailbox of [true, false]) {
    const net = new AgentNet({ rosterMailbox });
    t.after(async () => { net.stop(); await net.settle(); });
    const result = net.spawn({ name: 'Helper', task: 'Review.', prompt: 'Review carefully.',
      deferStart: true, operatorAdded: true });
    assert.equal(result.ok, true);
    const role = net.agents.get(result.agentId).loop.personaPrompt;
    assert.equal(role.includes(PROMPT), rosterMailbox);
    assert.ok(role.startsWith('Review carefully.'));
  }
});

test('two Links agents exchange correlated code packets through real tools and scheduler', { timeout: 10000 }, async t => {
  const sent = encode(packet({ body: '  Check x <= 0; quoted LINKS: COMPLETE\n\t[]{}"\\  ',
    expect: 'Return evidence using replyTo.' }));
  const final = encode(packet({ id: 'reviewer-1', op: '#', replyTo: 'sender-1',
    body: 'Review complete: the boundary expression handles zero.',
    evidence: ['0 <= 0 evaluated to true.'] }));
  let senderRequests = 0, reviewerRequests = 0;
  const requests = [];
  const response = (res, status, message, actions = []) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content:
      JSON.stringify({ status, message, actions, options: [] }) }, finish_reason: 'stop' }] }));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      if (body.model === 'sender' && ++senderRequests === 1) {
        response(res, 'actions', 'Asking for review.', [
          { name: 'agent.send', arguments: { to: 'Reviewer', message: sent } },
        ]);
      } else if (body.model === 'reviewer' && ++reviewerRequests === 1) {
        response(res, 'actions', 'Sending the verified result.', [
          { name: 'agent.send', arguments: { to: 'Sender', message: final } },
        ]);
      } else if (body.model === 'reviewer') {
        response(res, 'complete', decode(final).body + '\nLINKS: COMPLETE');
      } else response(res, 'complete', 'Peer message delivered.');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const events = [];
  const runner = new TeamRunner({
    team: { id: 'code-test', name: 'Code test', mode: 'links', members: [
      { personaId: 'sender', roleId: 'coordinator' }, { personaId: 'reviewer' },
    ] },
    personas: [{ id: 'sender', name: 'Sender', model: 'sender' },
      { id: 'reviewer', name: 'Reviewer', model: 'reviewer' }],
    task: 'Review the boundary expression.', concurrency: 1,
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    sendEvent: (_channel, event) => events.push(event),
  });
  t.after(() => runner.stop());
  await runner.run('code-test-run');
  const reviewerPrompt = requests.find(request => request.model === 'reviewer').messages
    .map(message => message.content).join('\n');
  assert.ok(reviewerPrompt.includes(sent), 'the quoted sentinel did not finish the run; the peer received all characters');
  assert.ok(reviewerPrompt.includes(PROMPT));
  assert.equal(runner.net.linkSends, 2);
  assert.ok(!runner.net.linksComplete, 'peer completion claims never set terminal state');
  assert.equal(runner._linkDeclared.by, 'Reviewer');
  assert.equal(reviewerRequests, 2, 'the sender must finish its turn after sending the claim');
  assert.equal(events.findLast(event => event.type === 'done').answer, decode(final).body + '\nLINKS: COMPLETE');
  assert.equal(events.findLast(event => event.type === 'done').links.synthesized, false);
});
