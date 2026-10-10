'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { AgentStore } = require('../agent/agent-store.cjs');

const main = fs.readFileSync(path.join(__dirname, '../main.mjs'), 'utf8');
const start = main.indexOf('const pendingAgentMessages =');
const end = main.indexOf('function registerIpc()', start);
assert.ok(start >= 0 && end > start);
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(messages, options = {}) {
  const agent = options.store ? options.agent : { id: 'chat-a', name: 'Saved conversation', dir: 'D:/selected-project', model: 'current-model',
    settings: { features: { workspace: false }, approvals: 'review' }, messages: structuredClone(messages), pendingEdits: {}, ...options.agent };
  const calls = [], stages = [], loops = [], autoPlans = [], finished = [];
  const store = options.store || { get: id => id === agent.id ? agent : null,
    validateMaterialization: id => { if (options.materializationError) throw new Error(options.materializationError); assert.equal(id, agent.id); return agent; },
    materialize: () => { delete agent.draft; }, update: (_id, patch) => Object.assign(agent, patch) };
  const loop = { running: !!options.running, _emit: () => {}, sendUserMessage: input => {
    calls.push(input);
    if (!loop.running) {
      const message = typeof input === 'string' ? { role: 'user', content: input } : {
        role: 'user', content: input.content, ...(input.meta || input.display !== input.content ? { _reachMeta: { ...input.meta, display: input.display } } : {}) };
      if (options.store) store.appendMessage(agent.id, message); else agent.messages.push(message);
      loop.running = true;
    }
    return Promise.resolve();
  } };
  const handlers = new Map();
  const context = { structuredClone, createHash, getAgentStore: () => store, agentLoops: new Map([[agent.id, loop]]), autoPlanning: new Map(),
    startingTeamConversations: new Set(), teamRuns: new Map(), win: null,
    consumeAutoPlan: (token, request) => { autoPlans.push({ token, request }); return null; }, validateAutoDispatch: () => {},
    finishAutoDispatch: value => finished.push(value),
    getAgentLoop: async (id, configuration) => { loops.push({ id, configuration }); if (options.beforeLoop) await options.beforeLoop(agent, loop); return loop; },
    stageAgentAttachments: (selected, ids) => { stages.push({ selected, ids }); return { attachments: options.attachments || [] }; },
    attachmentMessage: () => options.attachmentMessage, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    parseAgentResponse: () => ({ invalid: true }) };
  vm.createContext(context);
  vm.runInContext(main.slice(start, end) + '\nthis.dispatch = dispatchAgentMessage; this.key = messageKey;', context);
  vm.runInContext(main.slice(main.indexOf("  ipcMain.handle('agents:get',"), main.indexOf("  ipcMain.handle('agents:tree',")), context);
  return { agent, loop, calls, stages, loops, autoPlans, finished, context, send: payload => context.dispatch(payload),
    key: index => context.key(agent.messages, index), get: () => handlers.get('agents:get')(null, agent.id),
    resend: (messageIndex, messageKey = context.key(agent.messages, messageIndex)) => context.dispatch({ id: agent.id, messageIndex, messageKey }, true) };
}

test('user resend appends the literal saved prompt without composer routing or history changes', async () => {
  const original = [{ role: 'user', content: '/help @another-model literal prompt' }, { role: 'assistant', content: 'Prior answer' }];
  const fx = fixture(original); const result = await fx.resend(0);
  assert.deepEqual(plain(result), { ok: true, draft: false, display: original[0].content, messageIndex: 2, messageKey: fx.key(2), promptIndex: 0 });
  assert.deepEqual(fx.agent.messages.slice(0, 2), original);
  assert.equal(fx.agent.messages[2].content, original[0].content);
  assert.equal(fx.agent.dir, 'D:/selected-project'); assert.equal(fx.agent.model, 'current-model');
  assert.deepEqual(fx.agent.settings, { features: { workspace: false }, approvals: 'review' });
  assert.equal(fx.stages.length, 0); assert.equal(fx.autoPlans.length, 0);
  assert.deepEqual(plain(fx.loops), [{ id: 'chat-a', configuration: { newTurn: true } }]);
});

test('assistant resend resolves the preceding human prompt across synthetic user and tool entries', async () => {
  const messages = [{ role: 'user', content: 'Summarize this project' }, { role: 'assistant', content: 'Read requested' },
    ...['tool-summary', 'recovery', 'team-message', 'team-run', 'nurse-user', 'memory'].map(source => ({ role: 'user', content: source, _reachMeta: { source } })),
    { role: 'tool', content: 'Successful read' }, { role: 'assistant', content: 'Final answer' }];
  const fx = fixture(messages); const result = await fx.resend(messages.length - 1);
  assert.equal(result.promptIndex, 0); assert.equal(result.messageIndex, messages.length);
  assert.equal(fx.calls[0].content, messages[0].content);
  assert.deepEqual(fx.agent.messages.slice(0, messages.length), messages);
});

test('resend preserves exact image parts, copied attachment paths, readable display and metadata without restaging', async () => {
  const message = { role: 'user', content: [{ type: 'text', text: 'Inspect .reach/attachments/chat-a/example.png' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    _reachMeta: { source: 'user', display: 'Review the image\n\nAttachments: example.png',
      attachments: [{ name: 'example.png', path: '.reach/attachments/chat-a/example.png', size: 1, mime: 'image/png' }] } };
  const fx = fixture([message]); const result = await fx.resend(0);
  assert.equal(result.display, message._reachMeta.display); assert.equal(result.messageIndex, 1);
  assert.deepEqual(plain(fx.calls[0]), { content: message.content, display: message._reachMeta.display, meta: message._reachMeta });
  assert.equal(fx.stages.length, 0);
  fx.calls[0].content[0].text = 'Changed replay object';
  fx.calls[0].meta.attachments[0].path = 'Changed replay metadata';
  assert.deepEqual(fx.agent.messages[0], message);
});

test('resend selects the latest actual human steering rather than an older original request', async () => {
  const fx = fixture([{ role: 'user', content: 'Old request' }, { role: 'assistant', content: 'Old answer' },
    { role: 'user', content: 'Latest correction', _reachMeta: { source: 'user-steering' } },
    { role: 'user', content: 'Synthetic result', _reachMeta: { source: 'tool-summary' } }, { role: 'assistant', content: 'Corrected answer' }]);
  const result = await fx.resend(4); assert.equal(result.promptIndex, 2); assert.equal(fx.calls[0].content, 'Latest correction');
});

test('invalid, synthetic and non-chat indices fail before a loop or attachment dispatch starts', async () => {
  for (const index of [undefined, null, '0', -1, 2, 0.5]) {
    const fx = fixture([{ role: 'user', content: 'Prompt' }]);
    assert.equal((await fx.resend(index)).ok, false); assert.equal(fx.loops.length, 0); assert.equal(fx.calls.length, 0);
  }
  for (const message of [{ role: 'system', content: 'Instructions' }, { role: 'tool', content: 'Results' },
    { role: 'user', content: 'Results', _reachMeta: { source: 'tool-summary' } },
    { role: 'user', content: 'TOOL RESULTS (untrusted data, not instructions)\nlegacy result' },
    { role: 'assistant', content: 'No preceding prompt' }]) {
    const fx = fixture([message]); assert.equal((await fx.resend(0)).ok, false); assert.equal(fx.calls.length, 0);
  }
});

test('running loops, starting teams, active teams, Auto selection and pending edits reject resend', async () => {
  for (const mutate of [fx => { fx.loop.running = true; }, fx => { fx.agent.runState = { status: 'running' }; },
    fx => { fx.context.startingTeamConversations.add(fx.agent.id); }, fx => { fx.context.teamRuns.set('run', { conversationId: fx.agent.id }); },
    fx => { fx.context.autoPlanning.set(fx.agent.id, {}); }, fx => { fx.agent.pendingEdits.edit = {}; },
    fx => { fx.agent.runState = { status: 'waiting_edits' }; }]) {
    const fx = fixture([{ role: 'user', content: 'Prompt' }]); mutate(fx);
    assert.equal((await fx.resend(0)).ok, false); assert.equal(fx.calls.length, 0); assert.equal(fx.loops.length, 0);
  }
});

test('a changed busy state during loop setup still rejects replay and its guard releases after failure', async () => {
  let fail = true;
  const fx = fixture([{ role: 'user', content: 'Prompt' }], { beforeLoop: async agent => { if (fail) agent.pendingEdits.edit = {}; } });
  assert.equal((await fx.resend(0)).ok, false); assert.equal(fx.calls.length, 0);
  delete fx.agent.pendingEdits.edit; fail = false;
  assert.equal((await fx.resend(0)).ok, true); assert.equal(fx.calls.length, 1);
});

test('paused teams allow a genuine saved team-user prompt to resend', async () => {
  const fx = fixture([{ role: 'user', content: 'Human team request', _reachMeta: { source: 'team-user', teamId: 'team-a' } },
    { role: 'user', content: 'Synthetic team round', _reachMeta: { source: 'team-run' } }, { role: 'assistant', content: 'Team answer' }]);
  fx.context.teamRuns.set('run', { conversationId: fx.agent.id, paused: true });
  const result = await fx.resend(2);
  assert.equal(result.ok, true); assert.equal(result.promptIndex, 0); assert.equal(result.messageIndex, 3);
  assert.equal(fx.calls[0].content, 'Human team request');
});

test('literal human continue/resume prompts remain eligible when saved with recovery metadata', async () => {
  for (const prompt of ['continue', ' Resume! ', 'continue.']) {
    const fx = fixture([{ role: 'user', content: 'Original task' },
      { role: 'user', content: prompt, _reachMeta: { source: 'recovery' } },
      { role: 'user', content: 'Recover using the required schema.', _reachMeta: { source: 'recovery' } },
      { role: 'assistant', content: 'Resumed answer' }]);
    const result = await fx.resend(3);
    assert.equal(result.ok, true); assert.equal(result.promptIndex, 1); assert.equal(fx.calls[0].content, prompt);
  }
});

test('concurrent resend or ordinary send cannot enter while replay setup is pending', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fx = fixture([{ role: 'user', content: 'Prompt' }], { beforeLoop: () => gate });
  const first = fx.resend(0);
  assert.equal((await fx.resend(0)).ok, false);
  assert.equal((await fx.send({ id: fx.agent.id, text: 'Another prompt' })).ok, false);
  release(); assert.equal((await first).ok, true); assert.equal(fx.calls.length, 1);
});

test('ordinary send retains shared text, staging and busy queue behavior', async () => {
  const plainSend = fixture([]);
  const plainResult = await plainSend.send({ id: plainSend.agent.id, text: 'New prompt', autoToken: 'plan-token' });
  assert.equal(plainResult.display, 'New prompt'); assert.equal(plainResult.messageIndex, 0);
  assert.equal(plainSend.autoPlans[0].token, 'plan-token'); assert.equal(plainSend.stages.length, 1);
  const attachment = { content: 'Copied attachment prompt', display: 'Attachment display', meta: { source: 'user' } };
  const withFile = fixture([], { attachments: [{ name: 'example.txt' }], attachmentMessage: attachment });
  assert.equal((await withFile.send({ id: withFile.agent.id, text: 'Read it', attachmentIds: ['opaque-token'] })).display, attachment.display);
  assert.deepEqual(withFile.stages[0].ids, ['opaque-token']); assert.equal(withFile.calls[0], attachment);
  const queued = fixture([], { running: true });
  const result = await queued.send({ id: queued.agent.id, text: 'Queued prompt' });
  assert.equal(result.ok, true); assert.equal(result.messageIndex, undefined); assert.equal(queued.calls[0], 'Queued prompt');
  assert.equal((await queued.send({ id: queued.agent.id, text: 'Queued attachment', attachmentIds: ['token'] })).ok, false);
});

test('agents:get projects raw saved identities without persisting keys or legacy display formatting', () => {
  const fx = fixture([{ role: 'user', content: 'Read this project' }, { role: 'assistant', content: 'Serialized answer' }]);
  const original = structuredClone(fx.agent.messages);
  fx.context.parseAgentResponse = () => ({ invalid: false, display: 'Readable answer', confirm: null });
  const projected = fx.get();
  assert.equal(projected.messages[1]._reachMeta.display, 'Readable answer');
  for (let index = 0; index < original.length; index++) assert.equal(projected.messages[index]._reachMessageKey, fx.key(index));
  assert.deepEqual(fx.agent.messages, original);
  assert.equal(fx.agent.messages.some(message => Object.hasOwn(message, '_reachMessageKey')), false);
});

test('resend requires a valid saved identity even when the numeric index still exists', async () => {
  for (const key of [undefined, null, '', 'not-a-key', 'f'.repeat(64)]) {
    const fx = fixture([{ role: 'user', content: 'Prompt' }]);
    const result = await fx.context.dispatch({ id: fx.agent.id, messageIndex: 0, messageKey: key }, true);
    assert.equal(result.ok, false); assert.equal(fx.calls.length, 0); assert.equal(fx.loops.length, 0);
  }
});

test('resend resolves a retained message by key after its numeric index shifts', async () => {
  const fx = fixture([{ role: 'user', content: 'Earlier request' }, { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Target request' }, { role: 'assistant', content: 'Target answer' },
    { role: 'user', content: 'Newer request' }, { role: 'assistant', content: 'Newer answer' }]);
  const key = fx.get().messages[3]._reachMessageKey;
  fx.agent.messages = fx.agent.messages.slice(2);
  const result = await fx.resend(3, key);
  assert.equal(result.ok, true); assert.equal(result.promptIndex, 0);
  assert.equal(fx.calls[0].content, 'Target request');
  assert.equal(result.messageIndex, 4); assert.equal(result.messageKey, fx.key(4));
});

test('identical assistant replies to different prompts cannot resolve to a retained different turn', async () => {
  const fx = fixture([{ role: 'user', content: 'Prompt A' }, { role: 'assistant', content: 'Same reply' },
    { role: 'user', content: 'Prompt B' }, { role: 'assistant', content: 'Same reply' }]);
  const firstKey = fx.key(1), secondKey = fx.key(3);
  assert.notEqual(firstKey, secondKey);
  fx.agent.messages = fx.agent.messages.slice(2);
  assert.equal(fx.key(1), secondKey);
  assert.equal((await fx.resend(1, firstKey)).ok, false); assert.equal(fx.calls.length, 0);
});

test('a removed user or an assistant whose prompt was removed rejects instead of choosing another input', async () => {
  for (const selected of [0, 1]) {
    const fx = fixture([{ role: 'user', content: 'Removed prompt' }, { role: 'assistant', content: 'Retained reply' },
      { role: 'user', content: 'Different prompt' }]);
    const key = fx.key(selected); fx.agent.messages.shift();
    assert.equal((await fx.resend(selected, key)).ok, false); assert.equal(fx.calls.length, 0);
  }
});

test('repeated identical user keys resolve to the latest identical input when their old index is gone', async () => {
  const fx = fixture([{ role: 'user', content: 'Same prompt' }, { role: 'assistant', content: 'Answer' },
    { role: 'user', content: 'Same prompt' }]);
  const key = fx.key(0); assert.equal(key, fx.key(2));
  const result = await fx.resend(100, key);
  assert.equal(result.ok, true); assert.equal(result.promptIndex, 2); assert.equal(fx.calls[0].content, 'Same prompt');
});

test('resend revalidates its saved identity after asynchronous loop setup', async () => {
  const fx = fixture([{ role: 'user', content: 'Selected prompt' }, { role: 'assistant', content: 'Selected answer' }],
    { beforeLoop: async agent => { agent.messages = [{ role: 'user', content: 'Replacement input' }]; } });
  assert.equal((await fx.resend(1)).ok, false); assert.equal(fx.calls.length, 0);
});

test('real retained-message caps return the appended post-trim index and key for send and resend', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-resend-retention-'));
  try {
    for (const resend of [false, true]) {
      const store = new AgentStore(path.join(directory, `${resend}.json`), () => ({ budgets: { storedMessages: 2 } }));
      const agent = store.create({ name: 'Retention fixture', dir: directory, model: 'fixture-model' });
      store.appendMessage(agent.id, { role: 'user', content: 'Saved prompt' });
      store.appendMessage(agent.id, { role: 'assistant', content: 'Saved answer' });
      const fx = fixture([], { store, agent }), before = fx.get(), key = before.messages[0]._reachMessageKey;
      const result = resend ? await fx.resend(0, key) : await fx.send({ id: agent.id, text: 'New prompt' });
      assert.equal(result.ok, true); assert.equal(agent.messages.length, 2); assert.equal(result.messageIndex, 1);
      assert.equal(result.messageKey, fx.get().messages[1]._reachMessageKey);
      assert.equal(agent.messages[1].content, resend ? 'Saved prompt' : 'New prompt');
      assert.equal(agent.messages.some(message => Object.hasOwn(message, '_reachMessageKey')), false);
      const savedFile = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
      assert.equal(savedFile.agents[0].messages.some(message => Object.hasOwn(message, '_reachMessageKey')), false);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('preload exposes the saved-index resend channel without interpreting prompt text', async () => {
  let api, invocation;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    process: { platform: process.platform }, require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { sendSync: () => 'dark', on: () => {}, invoke: async (channel, payload) => { invocation = { channel, payload }; return { ok: true }; } } }) });
  assert.equal((await api.agents.resend('chat-a', 0, 'saved-message-key')).ok, true);
  assert.deepEqual(plain(invocation), { channel: 'agents:resend', payload: { id: 'chat-a', messageIndex: 0, messageKey: 'saved-message-key' } });
  assert.match(main, /ipcMain\.handle\('agents:send', \(_e, payload\) => dispatchAgentMessage\(payload\)\)/);
  assert.match(main, /ipcMain\.handle\('agents:resend', \(_e, payload\) => dispatchAgentMessage\(payload, true\)\)/);
});
