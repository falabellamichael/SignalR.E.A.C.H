'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { MemoryStore } = require('../agent/memory-store.cjs');
const { compactMessages, normalizeChatMessages, MEMORY_PREFIX } = require('../agent/context.cjs');
const { summarizeSegments, transcriptSegments, workingMessages, fingerprint } = require('../agent/compaction.cjs');
const { measureRequest, budgetExceeded } = require('../agent/request-budget.cjs');
const { defaults } = require('../agent/budgets.cjs');

const subscriptionFacts = { maxInputBytes: 32000, inputLimitScope: 'messages', outputTokenLimit: false };
const originalRequest = 'Original goal: fix src/chat.py; preserve the existing API and every saved message.';
const latestRequest = 'Latest correction: keep compatibility and verify the subscription route before reporting success.';
const archiveTail = 'ARCHIVE_TAIL: src/chat.py regression is pending; retain the original API.';
const completeSummary = (() => {
  const prefix = 'Goal: fix src/chat.py. Constraints: retain API and saved chat. Verified: diagnosis only. Pending: subscription regression.\n';
  const tail = '\n' + archiveTail;
  return prefix + 'Evidence remains available in the full audit transcript. '.repeat(50).slice(0, 1960 - prefix.length - tail.length) + tail;
})();

function history() {
  return [
    { role: 'user', content: originalRequest },
    { role: 'assistant', content: 'OLDER_SOURCE\n' + 'a'.repeat(13900) + '\n' + archiveTail },
    { role: 'assistant', content: 'RECENT_SOURCE\n' + 'b'.repeat(13900) + '\nRECENT_SOURCE_TAIL' },
    { role: 'user', content: latestRequest },
  ];
}

function fixture(url, facts = subscriptionFacts, options = {}) {
  const store = new MemoryStore(), events = [];
  const loop = new AgentLoop({
    agentId: 'wire-fixture', store, endpoint: url, model: 'deepseek-v4.1-flash', connectionId: 'fixture',
    personaPrompt: 'PINNED POLICY: preserve the existing API; require verified test evidence.',
    capabilityStore: { get: () => facts, record: () => true },
    budgets: { ...defaults, requestPacing: false, contextTrigger: 500000, contextMessages: 0, ...options.budgets },
    nativeTools: options.nativeTools || false,
    sendEvent: (_, event) => events.push(event),
  });
  store.setMessages('wire-fixture', history());
  loop.abortController = new AbortController();
  return { store, loop, events };
}

async function endpoint(t, replyFor) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const reply = replyFor(body, calls.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: reply.content }, finish_reason: reply.finishReason || 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, calls };
}

test('32,000-byte subscription accepts a complete 1,960-character memory with one compression request', async t => {
  const { url, calls } = await endpoint(t, body => ({
    content: body.messages[0].content.includes('durable conversation memory')
      ? completeSummary : '{"status":"complete","message":"Done.","actions":[],"options":[]}',
  }));
  const { store, loop, events } = fixture(url);
  const agent = store.get('wire-fixture');
  const savedHistory = JSON.stringify(agent.messages);
  const before = loop._messagesForRequest();
  const instructions = before[0].content;
  assert.equal(completeSummary.length, 1960);
  assert.ok(measureRequest(loop._requestBody(before)).messagesBytes > 32000);

  const compacted = await loop._prepareRequestContext(before);
  assert.equal(calls.length, 1, 'the valid first response must not consume shortening requests');
  assert.ok(calls[0].messages[1].content.includes(JSON.stringify(history()[1])), 'the entire archived message reaches compression');
  assert.ok(measureRequest(calls[0]).messagesBytes <= 32000);
  assert.equal(calls[0].max_tokens, undefined, 'the bridge cannot enforce an output token hint');
  assert.equal(JSON.stringify(agent.messages), savedHistory, 'compression preserves the complete saved archive');
  assert.equal(compacted[0].content, instructions, 'system instructions are retained in full');
  assert.ok(compacted.some(message => message.content === originalRequest));
  assert.ok(compacted.some(message => message.content === latestRequest));
  assert.ok(compacted.some(message => message.content === history()[2].content), 'recent source is not clipped');
  const memory = compacted.find(message => String(message.content).startsWith(MEMORY_PREFIX));
  assert.ok(memory);
  assert.ok(memory.content.endsWith(completeSummary), 'the accepted summary retains its complete tail');
  assert.equal(agent.context.through, agent.messages.length);
  assert.deepEqual(workingMessages(agent), compacted.slice(1));
  assert.equal(budgetExceeded(loop._requestBody(compacted), loop._inputLimits()), null);
  assert.ok(measureRequest(loop._requestBody(compacted)).messagesBytes <= 31360, 'the final request retains 2% headroom');

  await loop._fetchChat(compacted);
  assert.equal(calls.length, 2);
  assert.ok(measureRequest(calls[1]).messagesBytes <= 32000);
  assert.equal(calls[1].max_tokens, undefined);
  assert.equal(events.filter(event => event.type === 'compacted').length, 1);
});

test('memory headroom includes the final wrapper and retained messages', async () => {
  const source = [
    { role: 'system', content: 'Retain this complete system instruction.' },
    { role: 'user', content: originalRequest },
    { role: 'assistant', content: 'x'.repeat(10000) + archiveTail },
    { role: 'user', content: latestRequest },
  ];
  const measure = candidate => Buffer.byteLength(JSON.stringify(normalizeChatMessages(candidate)), 'utf8');
  let budget;
  const result = await compactMessages(source, async (archived, options) => {
    budget = options;
    assert.equal(archived.length, 1);
    assert.equal(archived[0].content, source[2].content);
    assert.ok(options.maxChars > 1960, 'a 32K route must not force the old 1,066-character allowance');
    assert.equal(typeof options.fitsMemory, 'function');
    assert.ok(options.fitsMemory('x'.repeat(options.maxChars)));
    assert.equal(options.fitsMemory('x'.repeat(options.maxChars + 1)), false, 'the binary-search boundary includes wrapper overhead');
    return completeSummary;
  }, { measure, trigger: 4400, target: 4200, messageLimit: 0 });
  assert.ok(result.changed);
  assert.equal(result.after, measure(result.messages));
  assert.ok(result.after <= 4200);
  assert.ok(result.messages[1].content.endsWith(completeSummary));
  assert.equal(budget.fitsMemory('漢'.repeat(budget.maxChars)), false, 'UTF-8 bytes are checked independently of JavaScript characters');
});

test('multilingual and JSON-escaped summaries below the character cap are rejected when the final wire envelope cannot fit', async () => {
  const source = [
    { role: 'system', content: 'Preserve all saved instructions.' },
    { role: 'user', content: originalRequest },
    { role: 'assistant', content: 'x'.repeat(10000) + archiveTail },
    { role: 'user', content: latestRequest },
  ];
  const rejectedSummary = ('漢😀\\"\n').repeat(400) + '\nCRITICAL_FINAL_FACT';
  const original = JSON.stringify(source);
  const requests = [];
  await assert.rejects(compactMessages(source, async (archived, options) => {
    assert.ok(rejectedSummary.length < options.maxChars);
    assert.equal(options.fitsMemory(rejectedSummary), false);
    return summarizeSegments(archived, {
      ...options, chunkSize: 28000, signal: new AbortController().signal, progress: () => {},
      request: async messages => { requests.push(messages); return { content: rejectedSummary, finishReason: 'stop' }; },
    });
  }, { measure: candidate => Buffer.byteLength(JSON.stringify(normalizeChatMessages(candidate)), 'utf8'),
    trigger: 4400, target: 4200, messageLimit: 0 }), error => {
    assert.equal(error.code, 'REACH_COMPACTION');
    assert.equal(error.reason, 'input');
    assert.match(error.message, /Saved chat and previous context are intact/);
    assert.doesNotMatch(error.message, /Increase compression output tokens/);
    return true;
  });
  assert.equal(requests.length, 3);
  assert.ok(requests[1][1].content.includes(rejectedSummary), 'retry recompresses the whole rejected summary');
  assert.ok(requests[2][1].content.includes('CRITICAL_FINAL_FACT'), 'the rejected tail is never silently truncated');
  assert.equal(JSON.stringify(source), original);
});

test('segmented wire fitting reads every multilingual source byte and carries prior memory into the final tail', async () => {
  const source = [{ role: 'tool', content: ('漢😀\\"\n').repeat(650) + '\nEXACT_TAIL: approval pending for src/chat.py' }];
  const completeTranscript = transcriptSegments(source, 28000).join('');
  const readSegments = [], requests = [];
  const memory = await summarizeSegments(source, {
    maxChars: 200, chunkSize: 28000, signal: new AbortController().signal, progress: () => {},
    fits: messages => Buffer.byteLength(JSON.stringify(messages), 'utf8') <= 2800,
    request: async messages => {
      requests.push(messages);
      const match = /\n\nTRANSCRIPT SEGMENT \d+\/\d+ \(may split a message\)\n([\s\S]*)$/.exec(messages[1].content);
      assert.ok(match);
      const segment = match[1];
      readSegments.push(segment);
      assert.ok(Buffer.byteLength(JSON.stringify(messages), 'utf8') <= 2800);
      assert.equal(/[\uD800-\uDBFF]$/.test(segment), false, 'segment does not split a Unicode surrogate pair');
      assert.equal(/^[\uDC00-\uDFFF]/.test(segment), false);
      if (requests.length > 1) assert.ok(messages[1].content.includes(`memory-${requests.length - 1}`));
      return { content: `memory-${requests.length}` + (segment.includes('EXACT_TAIL') ? ': approval pending for src/chat.py' : ''), finishReason: 'stop' };
    },
  });
  assert.ok(requests.length > 5);
  assert.equal(readSegments.join(''), completeTranscript, 'every archived character, including the unread remainder, is supplied');
  assert.match(memory, /approval pending for src\/chat.py/);
});

test('failed complete-memory attempts are bounded and distinguish empty, output-length, character, and wire failures', async t => {
  const cases = [
    { reason: 'empty', content: '  \n ', finishReason: 'stop' },
    { reason: 'length', content: 'A plausible memory with a missing final section', finishReason: 'length' },
    { reason: 'characters', content: 'x'.repeat(81), finishReason: 'stop' },
    { reason: 'input', content: '漢'.repeat(70), finishReason: 'stop', fitsMemory: text => Buffer.byteLength(text, 'utf8') <= 80 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.reason, async () => {
      let calls = 0;
      await assert.rejects(summarizeSegments([{ role: 'assistant', content: 'Original data and pending tests.' }], {
        maxChars: 80, signal: new AbortController().signal, progress: () => {},
        fitsMemory: scenario.fitsMemory,
        request: async () => { calls++; return scenario; },
      }), error => {
        assert.equal(error.code, 'REACH_COMPACTION');
        assert.equal(error.reason, scenario.reason);
        assert.equal(error.maxChars, 80);
        assert.match(error.message, /Saved chat and previous context are intact/);
        if (scenario.reason !== 'length') assert.doesNotMatch(error.message, /Increase compression output tokens/);
        return true;
      });
      assert.equal(calls, 3);
    });
  }
});

test('failed subscription compression leaves the complete archive and previous checkpoint unchanged', async t => {
  const { url, calls } = await endpoint(t, () => ({ content: 'x'.repeat(20000) + '\nCRITICAL_TAIL', finishReason: 'stop' }));
  const { store, loop } = fixture(url);
  const agent = store.get('wire-fixture');
  const checkpoint = { messages: [{ role: 'user', content: MEMORY_PREFIX + '\nPrior complete checkpoint.' }],
    through: 0, fingerprint: fingerprint([]), at: 1, before: 100, after: 90 };
  agent.context = checkpoint;
  const savedHistory = JSON.stringify(agent.messages), savedCheckpoint = JSON.stringify(checkpoint);
  await assert.rejects(loop._prepareRequestContext(loop._messagesForRequest()), error => {
    assert.equal(error.code, 'REACH_COMPACTION');
    assert.equal(error.reason, 'characters');
    assert.doesNotMatch(error.message, /Increase compression output tokens/);
    return true;
  });
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(agent.messages), savedHistory);
  assert.equal(agent.context, checkpoint);
  assert.equal(JSON.stringify(agent.context), savedCheckpoint);
  assert.ok(calls.every(body => measureRequest(body).messagesBytes <= 32000), 'shortening never bypasses the input guard');
});

test('unfit pinned multilingual instructions fail before sending a compression request', async t => {
  const { url, calls } = await endpoint(t, () => ({ content: completeSummary }));
  const { store, loop } = fixture(url);
  const agent = store.get('wire-fixture');
  agent.messages.at(-1).content = latestRequest + ('漢😀\\"\n').repeat(5000);
  const archive = JSON.stringify(agent.messages);
  await assert.rejects(loop._prepareRequestContext(loop._messagesForRequest()), error => {
    assert.equal(error.code, 'REACH_INPUT_BUDGET');
    assert.match(error.message, /original\/latest request cannot fit/);
    return true;
  });
  assert.equal(calls.length, 0, 'an impossible pinned request does not consume subscription requests');
  assert.equal(JSON.stringify(agent.messages), archive);
  assert.equal(agent.context, undefined);
});

test('unsupported output token controls are omitted while native providers retain configured limits and tools', () => {
  const bridge = fixture('http://127.0.0.1/subscription/v1');
  const messages = [{ role: 'user', content: 'Return a concise answer.' }];
  const bridgeBudgets = bridge.loop._budgets();
  assert.equal(bridgeBudgets.maxTokens, 0);
  assert.equal(bridgeBudgets.summaryTokens, 0);
  assert.equal(bridge.loop._requestBody(messages).max_tokens, undefined);
  assert.equal(bridge.loop._requestBody(messages, { purpose: 'summary', maxTokens: 4096 }).max_tokens, undefined);

  const native = fixture('http://127.0.0.1/native/v1', { outputTokenLimit: true, maxTokensCeiling: 2048 },
    { nativeTools: true, budgets: { maxTokens: 4096, summaryTokens: 4096 } });
  const answer = native.loop._requestBody(messages);
  assert.equal(answer.max_tokens, 2048);
  assert.ok(Array.isArray(answer.tools) && answer.tools.length > 0);
  const summary = native.loop._requestBody(messages, { purpose: 'summary', maxTokens: 4096 });
  assert.equal(summary.max_tokens, 2048);
  assert.equal(summary.tools, undefined);
});
