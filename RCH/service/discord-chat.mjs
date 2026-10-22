import { createHash } from 'node:crypto';

const snowflake = value => typeof value === 'string' && /^\d{10,22}$/.test(value);
const problem = (status, message) => { throw Object.assign(new Error(message), { status }); };

// One publisher Gateway connection serves individually authenticated Studio
// sessions. Neither the bot token nor another customer's messages reach a client.
export function createDiscordGateway({ token, applicationId, api, onMessage, socketFactory = url => new WebSocket(url) }) {
  let socket, connecting, reconnect, heartbeat, firstBeat, session, sequence = null, resumeUrl, awaitingAck = false;
  let stopped = true, terminal = '', state = 'offline', attempts = 0;
  const clearBeats = () => { clearInterval(heartbeat); clearTimeout(firstBeat); awaitingAck = false; };
  const send = (op, d) => { if (socket?.readyState === 1) socket.send(JSON.stringify({ op, d })); };
  function heartbeatNow() {
    if (awaitingAck) { socket?.close(4000, 'Heartbeat acknowledgement missing'); return; }
    awaitingAck = true; send(1, sequence);
  }
  function validGateway(value) {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) || url.username || url.password || url.port) throw new Error('Invalid Discord Gateway.');
    url.search = '?v=10&encoding=json'; return url.href;
  }
  async function connect() {
    if (stopped || terminal) return;
    state = 'connecting';
    let address = resumeUrl;
    if (!address) {
      const info = await api('gateway/bot');
      if (info.session_start_limit?.remaining === 0) throw new Error('Discord session starts are exhausted.');
      address = info.url;
    }
    if (stopped) return;
    const current = socket = socketFactory(validGateway(address));
    current.addEventListener('message', event => {
      if (current !== socket || stopped) return;
      let payload;
      try { if (String(event.data).length > 1024 * 1024) throw new Error(); payload = JSON.parse(String(event.data)); }
      catch { current.close(4002, 'Invalid Gateway payload'); return; }
      if (Number.isSafeInteger(payload.s)) sequence = payload.s;
      if (payload.op === 10) {
        clearBeats();
        const interval = Number(payload.d?.heartbeat_interval);
        if (!Number.isFinite(interval) || interval < 1000) { current.close(4002); return; }
        firstBeat = setTimeout(() => { heartbeatNow(); heartbeat = setInterval(heartbeatNow, interval); heartbeat.unref?.(); }, interval * Math.random()); firstBeat.unref?.();
        if (session) send(6, { token, session_id: session, seq: sequence });
        else send(2, { token, intents: 1 | 512 | 4096 | 32768, properties: { os: process.platform, browser: 'REACH Studio', device: 'REACH Studio' } });
      } else if (payload.op === 11) awaitingAck = false;
      else if (payload.op === 1) { awaitingAck = true; send(1, sequence); }
      else if (payload.op === 7) current.close(4000, 'Reconnect requested');
      else if (payload.op === 9) {
        if (!payload.d) { session = undefined; sequence = null; resumeUrl = undefined; }
        current.close(4000, 'Session refresh requested');
      } else if (payload.op === 0) {
        if (payload.t === 'READY') {
          if (payload.d?.user?.id !== applicationId) { terminal = 'The Discord bot does not match the REACH registration.'; current.close(4000); return; }
          try { resumeUrl = validGateway(payload.d.resume_gateway_url); } catch { terminal = 'Discord returned an invalid resume address.'; current.close(4000); return; }
          session = payload.d.session_id; state = 'online'; attempts = 0;
        } else if (payload.t === 'RESUMED') { state = 'online'; attempts = 0; }
        else if (payload.t === 'MESSAGE_CREATE') Promise.resolve(onMessage(payload.d)).catch(() => {});
      }
    });
    current.addEventListener('error', () => { if (current === socket) current.close(); });
    current.addEventListener('close', event => {
      if (current !== socket) return;
      clearBeats(); socket = undefined; state = 'offline';
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) terminal = 'Discord rejected the bot connection. Check its token and Message Content Intent.';
      if ([4007, 4009].includes(event.code)) { session = undefined; sequence = null; resumeUrl = undefined; }
      if (!stopped && !terminal) schedule();
    });
  }
  function schedule() {
    clearTimeout(reconnect);
    reconnect = setTimeout(() => { connecting = connect().catch(() => { state = 'offline'; if (!stopped) schedule(); }); }, Math.min(30000, 1500 * 2 ** Math.min(attempts++, 5)));
    reconnect.unref?.();
  }
  return {
    async start() {
      if (terminal) problem(503, terminal);
      if (!stopped) return connecting;
      stopped = false; connecting = connect().catch(() => { state = 'offline'; schedule(); }); return connecting;
    },
    status: () => terminal || state,
    close() { stopped = true; clearTimeout(reconnect); clearBeats(); socket?.close(1000, 'Studio disconnected'); socket = undefined; state = 'offline'; },
  };
}

export function createDiscordChatServer({ applicationId, botToken, api, now = Date.now, socketFactory, pollMs = 12000 }) {
  const bindings = new Map(), jobs = new Map(), seen = new Map();
  let closed = false;
  const gateway = createDiscordGateway({ token: botToken, applicationId, api, socketFactory, onMessage: receive });
  function prune() {
    const time = now();
    for (const [id, binding] of bindings) if (binding.expires <= time) { binding.wake?.(); bindings.delete(id); }
    for (const [id, job] of jobs) if (job.expires <= time) jobs.delete(id);
    for (const [id, expiry] of seen) if (expiry <= time) seen.delete(id);
    if (!bindings.size) gateway.close();
  }
  const timer = setInterval(prune, 15000); timer.unref();
  async function receive(message) {
    prune();
    if (closed || !snowflake(message?.id) || !snowflake(message.channel_id) || !snowflake(message.author?.id) || message.author.bot || message.webhook_id || ![0, 19].includes(message.type ?? 0) || seen.has(message.id)) return;
    const binding = bindings.get(message.author.id);
    if (!binding) return;
    const control = /^!(?:approve|deny|stop|new|status|help)\b/i.test(String(message.content || '').trim());
    const mentioned = (message.mentions || []).some(user => user.id === applicationId);
    if (message.guild_id && !mentioned && (!control || message.channel_id !== binding.channel && ![...jobs.values()].some(job => job.userId === message.author.id && job.bridgeId === binding.bridgeId && job.channel === message.channel_id))) return;
    if (jobs.size >= 5000 || [...jobs.values()].filter(job => job.userId === message.author.id && !job.acknowledged).length >= 25) return;
    seen.set(message.id, now() + 3600000);
    const text = String(message.content || '').replace(new RegExp('<@!?' + applicationId + '>', 'g'), '').trim().slice(0, 4000);
    if (!text) return;
    jobs.set(message.id, { id: message.id, userId: message.author.id, channel: message.channel_id, guildId: message.guild_id || '', bridgeId: binding.bridgeId, text, expires: now() + 3600000, replies: new Map(), acknowledged: false });
    binding.wake?.();
  }
  function bindingFor(userId, bridgeId) {
    const binding = bindings.get(userId);
    if (!binding || binding.expires <= now() || binding.bridgeId !== bridgeId) problem(409, 'This Discord chat belongs to another Studio session or has expired.');
    return binding;
  }
  function jobFor(userId, input) {
    bindingFor(userId, input.bridgeId);
    const job = jobs.get(input.jobId);
    if (!job || job.userId !== userId || job.bridgeId !== input.bridgeId || job.expires <= now()) problem(404, 'This Discord message has expired.');
    return job;
  }
  return {
    async poll(userId, input, res) {
      prune();
      if (!/^[a-f0-9-]{36}$/.test(input.bridgeId || '') || input.channel && !snowflake(input.channel)) problem(400, 'Invalid Discord chat settings.');
      const old = bindings.get(userId);
      if (old && old.bridgeId !== input.bridgeId) problem(409, 'Discord chat is already active in another Studio instance. Disable it there first.');
      if (!old && bindings.size >= 1000) problem(503, 'The Discord chat service is busy.');
      const binding = old || { bridgeId: input.bridgeId };
      binding.channel = input.channel || ''; binding.expires = now() + 90000; bindings.set(userId, binding);
      await gateway.start();
      const next = () => [...jobs.values()].find(job => job.userId === userId && job.bridgeId === input.bridgeId && !job.acknowledged);
      if (!next() && !closed) await new Promise(resolve => {
        const finish = () => { clearTimeout(deadline); if (binding.wake === finish) delete binding.wake; res?.removeListener('close', finish); resolve(); };
        const deadline = setTimeout(finish, pollMs); binding.wake?.(); binding.wake = finish; res?.once('close', finish);
      });
      if (closed) problem(503, 'Discord chat is stopping.');
      bindingFor(userId, input.bridgeId);
      const job = next();
      return { userId, editableReplies: true, gateway: gateway.status(), ...(job ? { job: { id: job.id, userId, channel: job.channel, guildId: job.guildId, text: job.text } } : { pending: true }) };
    },
    async reply(userId, input) {
      const job = jobFor(userId, input);
      if (input.ack === true) { job.acknowledged = true; return { accepted: true }; }
      if (!/^[a-f0-9-]{36}$/.test(input.replyId || '') || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 1900) problem(400, 'Invalid Discord reply.');
      if (input.slot !== undefined) {
        if (input.slot !== 'response' || !Number.isSafeInteger(input.revision) || input.revision < 1) problem(400, 'Invalid response revision.');
        // Serialize edits per job; clients cannot supply arbitrary Discord message IDs.
        const update = (job.responseQueue || Promise.resolve()).catch(() => {}).then(async () => {
          if (input.revision <= (job.responseRevision || 0)) return { sent: true };
          const body = { content: input.content, allowed_mentions: { parse: [], replied_user: false } };
          const route = 'channels/' + job.channel + '/messages';
          if (job.responseMessageId) await api(route + '/' + job.responseMessageId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          else {
            const message = await api(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body,
              message_reference: { message_id: job.id, fail_if_not_exists: false },
              nonce: createHash('sha256').update(job.bridgeId + ':' + job.id + ':response').digest('hex').slice(0, 24), enforce_nonce: true }) });
            if (!snowflake(message?.id)) problem(502, 'Discord did not return a message ID.');
            job.responseMessageId = message.id;
          }
          job.responseRevision = input.revision;
          return { sent: true };
        });
        job.responseQueue = update;
        return update;
      }
      if (job.replies.has(input.replyId)) return job.replies.get(input.replyId);
      if (job.replies.size >= 60) problem(429, 'This Discord response has reached its message limit.');
      const pending = api('channels/' + job.channel + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: input.content, allowed_mentions: { parse: [], replied_user: false }, message_reference: { message_id: job.id, fail_if_not_exists: false }, nonce: createHash('sha256').update(input.replyId).digest('hex').slice(0, 24), enforce_nonce: true }) }).then(() => ({ sent: true }));
      job.replies.set(input.replyId, pending);
      try { return await pending; } catch (error) { job.replies.delete(input.replyId); throw error; }
    },
    discard(userId, input) { const job = jobFor(userId, input); jobs.delete(job.id); },
    disconnect(userId, input) { const binding = bindingFor(userId, input.bridgeId); binding.wake?.(); bindings.delete(userId); for (const [id, job] of jobs) if (job.userId === userId) jobs.delete(id); prune(); return { disconnected: true }; },
    close() { closed = true; clearInterval(timer); for (const binding of bindings.values()) binding.wake?.(); bindings.clear(); jobs.clear(); gateway.close(); },
  };
}
