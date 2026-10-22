'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { AgentStore } = require('../agent/agent-store.cjs');
const { createDiscordChat } = require('../agent/discord-chat.cjs');
const { createAppConnections } = require('../agent/app-connections.cjs');
async function until(predicate) { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Discord fixture timed out'); await delay(10); } }

test('Discord chat settings accept saved projects and preserve the existing authorization', () => {
  let settings = { plugins: { discord: { enabled: true, accessToken: 'fixture-access', refreshToken: 'fixture-renew' } } };
  const apps = createAppConnections({ getSettings: () => settings, saveSettings: value => { settings = value; }, openExternal: async () => {}, getProjects: () => [{ name: 'Fixture', dir: '/fixture' }] });
  apps.save('discord', { chatEnabled: true, workspace: '/fixture' });
  assert.equal(settings.plugins.discord.refreshToken, 'fixture-renew'); assert.equal(apps.catalog().find(item => item.id === 'discord').chat.workspace, '/fixture');
  assert.throws(() => apps.save('discord', { workspace: '/not-a-saved-project' }), /saved Studio project/);
  assert.throws(() => apps.save('discord', { chatEnabled: 'yes' }), /Invalid Discord/);
});

test('Discord conversation uses Studio history, routes replies and approves only the same owner and channel', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-discord-chat-')), jobs = [], replies = [], store = new AgentStore(path.join(profile, 'agents.json'));
  let loopCalls = 0, approved, runtime, pendingCode;
  const settings = { plugins: { discord: { enabled: true, chatEnabled: true, accessToken: 'fixture-customer', clientId: 'fixture-client', workspace: profile } } };
  const loop = { running: false, async sendUserMessage(text) { loopCalls++; this.running = true; const agent = store.agents[0]; store.appendMessage(agent.id, { role: 'user', content: text }); approved = await runtime.requestApproval(agent.id, { tool: 'shell', arguments: { command: 'fixture-command', apiKey: 'fixture-secret' } }, { timeoutMs: 2000, fallback: () => { throw new Error('Unexpected desktop fallback'); } }); store.appendMessage(agent.id, { role: 'assistant', content: 'The fixture finished.' }); runtime.event('agent:event', { agentId: agent.id, type: 'message-end', content: 'The fixture finished.' }); this.running = false; } };
  runtime = createDiscordChat({ profile, getSettings: () => settings, getProjects: () => [{ name: 'Fixture', dir: profile }], getStore: () => store, getLoop: async () => loop, stopLoop: () => {}, clients: { discord: { clientId: 'fixture-client', brokerOrigin: 'https://fixture.example' } }, token: async () => 'fixture-customer', request: async (_id, _registration, action, body, options) => {
    if (action === 'chat-poll') { if (!jobs.length) await delay(20, undefined, { signal: options.signal }); return { userId: '223456789012', gateway: 'online', ...(jobs.length ? { job: jobs.shift() } : { pending: true }) }; }
    if (body.content) { replies.push(body.content); const match = /!approve ([a-f0-9]{12})/.exec(body.content); if (match) pendingCode = match[1]; }
    return { accepted: true, sent: true };
  } });
  t.after(() => { runtime.destroy(); if (path.dirname(profile) === os.tmpdir()) fs.rmSync(profile, { recursive: true, force: true }); });
  const job = { id: '523456789012', userId: '223456789012', channel: '423456789012', text: 'Do the fixture task.' };
  jobs.push(job); runtime.synchronize(); await until(() => pendingCode);
  assert.equal(replies.join('\n').includes('fixture-secret'), false);
  jobs.push({ ...job, id: '623456789012', channel: '923456789012', text: '!approve ' + pendingCode }); await until(() => replies.some(text => /another conversation/.test(text))); assert.equal(approved, undefined);
  jobs.push({ ...job, id: '723456789012', text: '!approve ' + pendingCode }); await until(() => replies.includes('The fixture finished.')); assert.equal(approved, true); assert.equal(loopCalls, 1);
  assert.equal(store.agents[0].settings.approvals, 'prompt'); assert.equal(store.agents[0].settings.reviewEdits, true); assert.equal(store.agents[0].dir, profile);
  jobs.push(job); await delay(70); assert.equal(loopCalls, 1, 'Replayed Discord message does not execute twice');
  assert.equal(fs.readFileSync(path.join(profile, 'discord-chat.json'), 'utf8').includes('fixture-customer'), false);
  settings.plugins.discord.chatEnabled = false; runtime.synchronize(); assert.equal(runtime.snapshot().state, 'off');
});

test('Discord polling waits for the provider retry delay without repeatedly checking or discarding the saved connection', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-discord-backoff-')), waits = [];
  let polls = 0;
  const settings = { plugins: { discord: { enabled: true, chatEnabled: true, accessToken: 'fixture-customer', clientId: 'fixture-client' } } };
  const runtime = createDiscordChat({ profile, getSettings: () => settings, getStore: () => ({}), getLoop: async () => ({}), stopLoop: () => {}, clients: { discord: { clientId: 'fixture-client', brokerOrigin: 'https://fixture.example' } }, token: async () => 'fixture-customer', request: async (_id, _registration, action) => {
    if (action !== 'chat-poll') return {};
    polls++; throw Object.assign(new Error('fixture-provider-error'), { status: 429, retryAfter: 47 });
  }, wait: async (ms, _value, options) => { waits.push(ms); await delay(60000, undefined, options); } });
  t.after(() => { runtime.destroy(); fs.rmSync(profile, { recursive: true, force: true }); });
  runtime.synchronize(); await until(() => waits.length);
  assert.equal(polls, 1); assert.deepEqual(waits, [47000]);
  assert.match(runtime.snapshot().note, /Retrying in 47 seconds/);
  assert.equal(settings.plugins.discord.accessToken, 'fixture-customer');
});

test('Discord channels keep separate Studio histories and changing the read default leaves chat running', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-discord-channels-')), jobs = [], replies = [], store = new AgentStore(path.join(profile, 'agents.json'));
  let closes = 0;
  const settings = { plugins: { discord: { enabled: true, chatEnabled: true, accessToken: 'fixture-customer', clientId: 'fixture-client', channel: '423456789012' } } };
  const runtime = createDiscordChat({ profile, getSettings: () => settings, getStore: () => store, stopLoop: () => {}, clients: { discord: { clientId: 'fixture-client', brokerOrigin: 'https://fixture.example' } }, token: async () => 'fixture-customer', getLoop: async agentId => ({
    running: false, async sendUserMessage(text) { store.appendMessage(agentId, { role: 'user', content: text }); store.appendMessage(agentId, { role: 'assistant', content: 'Reply: ' + text }); },
  }), request: async (_id, _registration, action, body, options) => {
    if (action === 'chat-close') { closes++; return {}; }
    if (action === 'chat-poll') { if (!jobs.length) await delay(20, undefined, { signal: options.signal }); return { userId: '223456789012', gateway: 'online', ...(jobs.length ? { job: jobs.shift() } : { pending: true }) }; }
    if (body.content) replies.push({ jobId: body.jobId, content: body.content });
    return { accepted: true, sent: true };
  } });
  t.after(() => { runtime.destroy(); fs.rmSync(profile, { recursive: true, force: true }); });
  jobs.push({ id: '523456789012', userId: '223456789012', channel: '423456789012', text: 'First channel' }, { id: '623456789012', userId: '223456789012', channel: '823456789012', text: 'Second channel' });
  runtime.synchronize(); await until(() => replies.filter(reply => reply.content.startsWith('Reply:')).length === 2);
  assert.equal(store.agents.length, 2);
  const histories = store.agents.map(agent => agent.messages.map(message => message.content));
  assert.ok(histories.some(messages => messages.join('|') === 'First channel|Reply: First channel'));
  assert.ok(histories.some(messages => messages.join('|') === 'Second channel|Reply: Second channel'));
  assert.deepEqual(replies.filter(reply => reply.content.startsWith('Reply:')).map(reply => reply.jobId).sort(), ['523456789012', '623456789012']);
  settings.plugins.discord.channel = '923456789012'; runtime.synchronize();
  assert.equal(closes, 0); assert.equal(runtime.snapshot().state, 'online');
  assert.match(runtime.snapshot().note, /any accessible server text channel/);
});

test('Discord never replays an old answer when the next run has no new assistant output', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-discord-repeat-'));
  const store = new AgentStore(path.join(profile, 'agents.json')), jobs = [], replies = [];
  let runtime, turns = 0;
  runtime = createDiscordChat({ profile, getSettings: () => ({ plugins: { discord: { enabled: true, chatEnabled: true, accessToken: 'fixture' } } }),
    getStore: () => store, stopLoop() {}, clients: { discord: { brokerOrigin: 'https://fixture.example' } }, token: async () => 'fixture',
    getLoop: async agentId => ({ running: false, async sendUserMessage(text) {
      store.appendMessage(agentId, { role: 'user', content: text });
      runtime.event('agent:event', { agentId, type: 'tool-call', tool: 'shell', arguments: { command: 'python private.py --token secret' } });
      runtime.event('agent:event', { agentId, type: 'tool-result', tool: 'shell', ok: true });
      if (++turns === 1) store.appendMessage(agentId, { role: 'assistant', content: 'First answer only.' });
    } }),
    request: async (_id, _registration, action, body, options) => {
      if (action === 'chat-poll') { if (!jobs.length) await delay(20, undefined, { signal: options.signal }); return { userId: '223456789012', editableReplies: true, gateway: 'online', ...(jobs.length ? { job: jobs.shift() } : {}) }; }
      if (body.content) replies.push(body.content);
      return { sent: true };
    } });
  t.after(() => { runtime.destroy(); fs.rmSync(profile, { recursive: true, force: true }); });
  const job = { id: '523456789012', userId: '223456789012', channel: '423456789012', text: 'First' };
  jobs.push(job); runtime.synchronize(); await until(() => replies.includes('First answer only.'));
  jobs.push({ ...job, id: '623456789012', text: 'Second' });
  await until(() => replies.some(text => text.includes('without a text response')));
  assert.equal(replies.filter(text => text === 'First answer only.').length, 1);
  assert.ok(replies.some(text => text.includes('Started: Python via terminal')));
  assert.ok(replies.some(text => text.includes('Succeeded: Terminal command')));
  assert.ok(!replies.join('\n').includes('private.py'));
  assert.ok(!replies.join('\n').includes('secret'));
});
