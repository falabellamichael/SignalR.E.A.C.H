'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSubscriptionProviders, subscriptionRoute } = require('../agent/subscription-providers.cjs');
const { configureSubscriptions, providerFetch } = require('../agent/endpoint.cjs');
const { readChatResponse } = require('../agent/chat-response.cjs');
const { AgentLoop } = require('../agent/agent-loop.cjs');
const { AgentStore } = require('../agent/agent-store.cjs');
const path = require('node:path');
const os = require('node:os');
const root = 'http://127.0.0.1:20777/_reach/login-providers/';

for (const provider of ['devin', 'codex']) {
  test(`${provider} subscription completes a native-configured member through verified Studio actions`, async t => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-subscription-actions-'));
    fs.writeFileSync(path.join(project, 'proof.txt'), 'verified-fixture-742');
    const store = new AgentStore(path.join(project, 'agents.json'));
    const agent = store.create({ name: 'Subscription member', dir: project });
    const requests = [], events = [];
    configureSubscriptions({ request: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (body.tools?.length) return new Response(JSON.stringify({ error: { message: 'Native function calling tools are not supported by this subscription transport. Use Studio actions.' } }), { status: 400 });
      const transcript = body.messages.map(m => m.content).join('\n');
      const content = transcript.includes('NATIVE TOOL CALLS') ? 'I cannot call task_complete here.'
        : JSON.stringify(transcript.includes('TOOL RESULTS') && transcript.includes('verified-fixture-742')
          ? { status: 'complete', message: 'Read proof.txt: verified-fixture-742', actions: [], options: [] }
          : { status: 'actions', message: 'Read the proof file.', actions: [{ name: 'read', arguments: { path: 'proof.txt' } }], options: [] });
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    t.after(() => { configureSubscriptions(undefined); fs.rmSync(project, { recursive: true, force: true }); });
    const loop = new AgentLoop({ agentId: agent.id, store, endpoint: root + provider,
      model: provider === 'devin' ? 'swe-2-max' : 'gpt-6-luna', projectDir: project, nativeTools: true,
      sendEvent: (_channel, event) => events.push(event) });
    await loop.sendUserMessage('Read proof.txt and report its contents.');
    assert.equal(store.get(agent.id).runState.status, 'completed');
    assert.equal(requests.length, 2, 'read and completion must not need protocol recovery');
    assert.ok(requests.every(body => !body.tools && !body.response_format));
    assert.ok(requests[0].messages[0].content.includes('EXECUTABLE ACTION RESPONSE'));
    assert.ok(requests[0].messages.at(-1).content.includes('exactly one JSON object'));
    assert.ok(events.some(event => event.type === 'tool-call' && event.tool === 'read'));
    assert.ok(!events.some(event => event.type === 'recovery'));
  });
}

function fixture({ signedIn = true, holdPrompt = false, failPrompt = false } = {}) {
  const calls = [], messages = [], configs = [];
  let login;
  const spawnImpl = (exe, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.close = code => { if (child.exitCode !== null) return; child.exitCode = code; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
    child.kill = () => { child.killed = true; setImmediate(() => child.close(1)); return true; };
    const emit = msg => child.stdout.write(JSON.stringify(msg) + '\n');
    calls.push({ exe, args, options, child });
    if (args.includes('acp')) {
      configs.push(JSON.parse(fs.readFileSync(args[1], 'utf8')));
      child.stdin.on('data', chunk => {
        const msg = JSON.parse(String(chunk)); messages.push(msg);
        if (msg.method === 'initialize') setImmediate(() => emit({ id: msg.id, result: { protocolVersion: 1 } }));
        if (msg.method === 'session/new') setImmediate(() => emit({ id: msg.id, result: { sessionId: 'fixture' } }));
        if (msg.method === 'session/prompt' && !holdPrompt) setImmediate(() => {
          emit({ id: 44, method: 'session/request_permission', params: { options: [{ optionId: 'allow', kind: 'allow_once' }] } });
          emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native answer' } } } });
          emit(failPrompt ? { id: msg.id, error: { message: 'secret-token-should-not-leak' } } : { id: msg.id, result: { stopReason: 'end_turn' } });
        });
      });
    } else if (args.at(-1) === 'login') {
      login = child; child.stderr.write('https://provider.test/authorize?secret=private-login-material');
    } else setImmediate(() => {
      if (args.includes('status')) {
        child.stdout.write(signedIn ? exe === 'codex' ? 'Logged in using ChatGPT' : 'Logged in (via Devin).\nEmail: private@example.test' : 'Not logged in');
        child.close(signedIn ? 0 : 1);
      } else if (args.includes('models')) {
        child.stdout.write(exe === 'codex' ? JSON.stringify({ models: [{ slug: 'codex-visible', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] })
          : 'Available models\nFamily\n  aliases: alias\n  swe-fixture    Name [Free]\n'); child.close(0);
      } else if (args[0] === 'exec') {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'native answer'); child.close(0);
      }
    });
    return child;
  };
  const client = createSubscriptionProviders({ spawnImpl, resolveExecutable: provider => provider });
  return { client, calls, messages, configs, finishLogin: () => login.close(0) };
}

test('native routing is exact and cannot capture custom endpoints or URL credentials', async () => {
  for (const provider of ['devin', 'codex']) assert.deepEqual(subscriptionRoute(root + provider + '/models'), { provider, action: 'models' });
  for (const url of ['https://remote.test/_reach/login-providers/devin/models', root + 'devin/extra/models',
    root + 'codex/models?key=secret', root.replace('127.0.0.1', 'localhost') + 'devin/models',
    root.replace('127.0.0.1', 'user:pass@127.0.0.1') + 'devin/models']) assert.equal(subscriptionRoute(url), null);
  const f = fixture(); configureSubscriptions(f.client);
  try {
    const result = await providerFetch(root + 'codex/models', {}, () => { throw new Error('Must not contact local HTTP service'); });
    assert.equal(result.status, 200);
    assert.equal(await providerFetch('https://custom.test/v1/models', {}, async () => 'custom'), 'custom');
  } finally { f.client.close(); configureSubscriptions(undefined); }
});

test('status and native catalogs expose no credentials and distinguish signed-out accounts', async () => {
  const f = fixture();
  for (const provider of ['devin', 'codex']) {
    assert.deepEqual(await f.client.status(provider), { status: 'connected', provider });
    const models = await f.client.models(provider);
    assert.equal(models[0].id, provider + '-chat');
    assert.equal(models.length, 2);
    assert.equal(models.some(m => m.id === 'hidden' || m.id === 'aliases:'), false);
  }
  const out = fixture({ signedIn: false });
  const response = await out.client.request(root + 'devin/models');
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /Sign in to Devin/);
  f.client.close(); out.client.close();
});

test('browser OAuth runs the official login command once and reports pending until completion', async () => {
  for (const provider of ['devin', 'codex']) {
    const f = fixture();
    assert.deepEqual(f.client.signIn(provider), { ok: true, status: 'pending' });
    f.client.signIn(provider);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].args, provider === 'codex' ? ['login'] : ['auth', 'login']);
    assert.deepEqual(await f.client.status(provider), { provider, status: 'pending' });
    f.finishLogin(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.client.status(provider)).status, 'connected');
    assert.equal(f.calls[0].options.windowsHide, true);
    assert.equal(f.calls[0].options.shell, false);
    for (const key of ['OPENAI_API_KEY', 'WINDSURF_API_KEY', 'DEVIN_API_KEY']) assert.equal(f.calls[0].options.env[key], undefined);
    f.client.close();
  }
});

test('both native transports return answers without a browser or tray; Devin tools are denied', async () => {
  const f = fixture();
  for (const provider of ['devin', 'codex']) {
    const response = await f.client.request(root + provider + '/chat/completions', { method: 'POST', body: JSON.stringify({
      model: provider + '-chat', stream: true, messages: [{ role: 'system', content: 'Context' }, { role: 'user', content: 'Question' }],
    }) });
    const answer = await readChatResponse(response, { stream: true });
    assert.equal(answer.content, 'native answer'); assert.equal(answer.error, null);
  }
  assert.deepEqual(f.messages.find(msg => msg.id === 44).result, { outcome: { outcome: 'cancelled' } });
  assert.ok(f.configs[0].permissions.deny.includes('exec'));
  assert.ok(f.configs[0].permissions.deny.includes('mcp__*'));
  const exec = f.calls.find(call => call.args[0] === 'exec');
  assert.ok(exec.args.includes('--ignore-user-config'));
  assert.equal(exec.args[exec.args.indexOf('-s') + 1], 'read-only');
  assert.equal(fs.existsSync(exec.options.cwd), false, 'temporary prompt workspace is cleaned');
  f.client.close();
});

test('mid-response errors are surfaced without retrying or exposing provider diagnostics', async () => {
  const f = fixture({ failPrompt: true });
  const response = await f.client.request(root + 'devin/chat/completions', { method: 'POST', body: JSON.stringify({
    stream: true, messages: [{ role: 'user', content: 'Question' }],
  }) });
  const answer = await readChatResponse(response, { stream: true });
  assert.equal(answer.content, 'native answer');
  assert.match(answer.error, /Devin rejected/); assert.doesNotMatch(answer.error, /secret-token/);
  assert.equal(f.calls.filter(call => call.args.includes('acp')).length, 1);
  f.client.close();
});

test('Stop aborts an in-flight native session and terminates its client', async () => {
  const f = fixture({ holdPrompt: true });
  const abort = new AbortController();
  const response = await f.client.request(root + 'devin/chat/completions', { method: 'POST', signal: abort.signal,
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Question' }] }) });
  const reading = response.text();
  for (let i = 0; i < 100 && !f.messages.some(msg => msg.method === 'session/prompt'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  abort.abort();
  await assert.rejects(reading, /abort/i);
  assert.equal(f.calls.find(call => call.args.includes('acp')).child.killed, true);
  f.client.close();
});
