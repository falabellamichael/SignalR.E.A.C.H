import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDiscordChatServer, createDiscordGateway } from '../service/discord-chat.mjs';

class Socket extends EventTarget {
  readyState = 1; sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  packet(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close(code = 1000) { this.readyState = 3; const event = new Event('close'); Object.defineProperty(event, 'code', { value: code }); this.dispatchEvent(event); }
}
const app = '123456789012', owner = '223456789012', stranger = '323456789012', channel = '423456789012';
test('Discord Gateway identifies, receives messages and stops on invalid privileged intents', async t => {
  const socket = new Socket(), received = [];
  const gateway = createDiscordGateway({ token: 'fixture-bot', applicationId: app, api: async () => ({ url: 'wss://gateway.discord.gg', session_start_limit: { remaining: 10 } }), socketFactory: () => socket, onMessage: message => received.push(message) });
  t.after(() => gateway.close()); await gateway.start();
  socket.packet({ op: 10, d: { heartbeat_interval: 45000 } });
  assert.equal(socket.sent[0].op, 2); assert.equal(socket.sent[0].d.intents, 37377);
  socket.packet({ op: 0, t: 'READY', s: 1, d: { user: { id: app }, session_id: 'fixture-session', resume_gateway_url: 'wss://gateway.discord.gg' } });
  assert.equal(gateway.status(), 'online');
  socket.packet({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { content: 'Hello' } }); assert.equal(received.length, 1);
  socket.close(4014); await assert.rejects(gateway.start(), /Message Content Intent/);
});

test('Discord messages and replies stay bound to the authenticated owner and Studio instance', async t => {
  const socket = new Socket(), sent = []; let clock = 1000;
  const service = createDiscordChatServer({ applicationId: app, botToken: 'fixture-bot', now: () => clock, pollMs: 2, socketFactory: () => socket, api: async (route, options) => { if (route === 'gateway/bot') return { url: 'wss://gateway.discord.gg' }; sent.push({ route, body: JSON.parse(options.body) }); return { id: 'fixture-reply' }; } });
  t.after(() => service.close()); const bridgeId = randomUUID(), input = { bridgeId, channel };
  await service.poll(owner, input);
  socket.packet({ op: 10, d: { heartbeat_interval: 45000 } });
  socket.packet({ op: 0, t: 'READY', s: 1, d: { user: { id: app }, session_id: 'fixture-session', resume_gateway_url: 'wss://gateway.discord.gg' } });
  const message = { id: '523456789012', type: 0, channel_id: channel, guild_id: '623456789012', author: { id: stranger }, mentions: [{ id: app }], content: '<@' + app + '> hello' };
  socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: message });
  assert.equal((await service.poll(owner, input)).pending, true);
  message.author.id = owner; socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: message }); socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: message });
  const result = await service.poll(owner, input); assert.equal(result.job.text, 'hello');
  await assert.rejects(service.poll(owner, { bridgeId: randomUUID(), channel }), /another Studio/);
  await service.poll(stranger, { bridgeId: randomUUID(), channel: '' });
  await assert.rejects(service.reply(stranger, { bridgeId, jobId: message.id, content: 'steal' }), /another Studio/);
  const reply = { bridgeId, jobId: message.id, replyId: randomUUID(), channel: '999999999999', content: '@everyone hi' };
  await service.reply(owner, reply); await service.reply(owner, reply);
  assert.equal(sent.length, 1); assert.equal(sent[0].route, 'channels/' + channel + '/messages'); assert.deepEqual(sent[0].body.allowed_mentions, { parse: [], replied_user: false }); assert.equal(sent[0].body.enforce_nonce, true);
  await service.reply(owner, { bridgeId, jobId: message.id, ack: true }); assert.equal((await service.poll(owner, input)).pending, true);
  socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: { ...message, id: '723456789012', channel_id: '823456789012', guild_id: undefined, mentions: [], content: '!status' } });
  assert.equal((await service.poll(owner, input)).job.text, '!status');
  clock += 90001; await assert.rejects(service.reply(owner, { ...reply, replyId: randomUUID() }), /expired/);
});

test('editable responses reuse one message and reject stale revisions', async t => {
  const socket = new Socket(), sent = [];
  const service = createDiscordChatServer({ applicationId: app, botToken: 'fixture', pollMs: 2, socketFactory: () => socket,
    api: async (route, options) => {
      if (route === 'gateway/bot') return { url: 'wss://gateway.discord.gg' };
      sent.push({ route, method: options.method, body: JSON.parse(options.body) });
      return { id: '923456789012' };
    } });
  t.after(() => service.close());
  const input = { bridgeId: randomUUID(), channel };
  assert.equal((await service.poll(owner, input)).editableReplies, true);
  socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: { id: '523456789012', channel_id: channel, author: { id: owner }, content: 'hello' } });
  const { job } = await service.poll(owner, input);
  const update = { ...input, jobId: job.id, replyId: randomUUID(), slot: 'response', revision: 1, content: 'Working' };
  await service.reply(owner, update);
  await service.reply(owner, { ...update, revision: 2, content: 'Web search complete' });
  await service.reply(owner, update);
  await service.reply(owner, { ...update, revision: 3, content: 'Final answer' });
  assert.deepEqual(sent.map(item => item.method), ['POST', 'PATCH', 'PATCH']);
  assert.equal(sent[2].route, 'channels/' + channel + '/messages/923456789012');
  assert.equal(sent[2].body.content, 'Final answer');
});

test('mentions reach Studio across channels while ordinary messages and other accounts stay excluded', async t => {
  const socket = new Socket(), sent = [], otherChannel = '823456789012';
  const service = createDiscordChatServer({ applicationId: app, botToken: 'fixture-bot', pollMs: 2, socketFactory: () => socket, api: async (route, options) => {
    if (route === 'gateway/bot') return { url: 'wss://gateway.discord.gg' };
    sent.push(route); return {};
  } });
  t.after(() => service.close());
  const input = { bridgeId: randomUUID(), channel };
  await service.poll(owner, input);
  const message = { id: '523456789012', channel_id: otherChannel, guild_id: '623456789012', author: { id: owner }, mentions: [], content: 'Ordinary channel conversation' };
  socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: message });
  assert.equal((await service.poll(owner, input)).pending, true);
  socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: { ...message, content: '!status' } });
  assert.equal((await service.poll(owner, input)).pending, true, 'A bare control must not start an unrelated channel');
  socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: { ...message, author: { id: stranger }, mentions: [{ id: app }], content: '<@' + app + '> hello' } });
  assert.equal((await service.poll(owner, input)).pending, true);
  socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: { ...message, mentions: [{ id: app }], content: '<@' + app + '> hello elsewhere' } });
  const received = await service.poll(owner, input);
  assert.equal(received.job.channel, otherChannel); assert.equal(received.job.text, 'hello elsewhere');
  const changedDefault = { ...input, channel: '923456789012' };
  assert.equal((await service.poll(owner, changedDefault)).job.id, message.id, 'Changing the read default must preserve pending messages');
  await service.reply(owner, { ...input, jobId: message.id, replyId: randomUUID(), content: 'Reply elsewhere' });
  assert.deepEqual(sent, ['channels/' + otherChannel + '/messages']);
  await service.reply(owner, { ...input, jobId: message.id, ack: true });
  socket.packet({ op: 0, t: 'MESSAGE_CREATE', d: { ...message, id: '723456789012', content: '!status' } });
  assert.equal((await service.poll(owner, changedDefault)).job.text, '!status', 'Bare controls work in an established channel conversation');
});
