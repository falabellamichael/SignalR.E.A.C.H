const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../vscode/media/chat.js'), 'utf8');

class MockElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = '';
    this.handlers = {};
    this._textContent = '';
    this._innerHTML = '';
    this.parentElement = null;
    this.title = '';
    this.disabled = false;
  }
  get textContent() {
    if (this._textContent) return this._textContent;
    return this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v) {
    this._textContent = v;
    this.children = [];
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(v) {
    this._innerHTML = v;
    this._textContent = v.replace(/<[^>]+>/g, '');
  }
  append(...nodes) {
    nodes.forEach(n => this.appendChild(n));
  }
  appendChild(n) {
    this.children.push(n);
    if (n instanceof MockElement) n.parentElement = this;
    return n;
  }
  prepend(n) {
    this.children.unshift(n);
    if (n instanceof MockElement) n.parentElement = this;
    return n;
  }
  contains(n) {
    if (this === n) return true;
    return this.children.some(c => c instanceof MockElement && c.contains(n));
  }
  querySelector(sel) {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.children.find(c => c instanceof MockElement && c.className.split(' ').includes(cls))
        || this.children.map(c => (c instanceof MockElement ? c.querySelector(sel) : null)).find(Boolean);
    }
    return this.children.find(c => c instanceof MockElement && c.tag === sel)
      || this.children.map(c => (c instanceof MockElement ? c.querySelector(sel) : null)).find(Boolean);
  }
  setAttribute(k, v) { this[k] = v; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }
}

test('showThinking renders Answer now button in pending response bubble', () => {
  const pendingDiv = new MockElement('div');
  pendingDiv.classList = {
    add(c) { pendingDiv.className += ' ' + c; },
    remove(c) { pendingDiv.className = pendingDiv.className.replace(c, '').trim(); },
  };
  const pendingBubble = new MockElement('div');
  pendingDiv.appendChild(pendingBubble);

  const ctx = {
    pendingBubble,
    thinkRow: null,
    answerNowBtn: null,
    answeringNow: false,
    topThink: { hidden: false },
    answerNow() { },
    document: {
      createElement: tag => new MockElement(tag),
    },
  };

  const showFn = source.slice(source.indexOf('  function showThinking() {'), source.indexOf('  function thoughtIcon('));
  vm.runInNewContext(showFn, ctx);

  ctx.showThinking();
  assert.ok(ctx.thinkRow, 'thinkRow was assigned');
  assert.ok(ctx.answerNowBtn, 'answerNowBtn was assigned');
  assert.equal(ctx.answerNowBtn.textContent, 'Answer now');
  assert.ok(pendingBubble.querySelector('.answer-now-btn'), 'button is inside pendingBubble');
  assert.ok(pendingBubble.querySelector('.think-spinner'), 'spinner is inside pendingBubble');

  ctx.hideThinking();
  assert.equal(ctx.thinkRow, null, 'thinkRow was cleared on hide');
  assert.equal(ctx.answerNowBtn, null, 'answerNowBtn was cleared on hide');
  assert.equal(pendingBubble.children.length, 0, 'pending status wrap was removed');
});

test('answerNow cancels running tools, gathers completed tools and context, and requests quick answer', () => {
  const calls = [];
  const steps = [];
  const closedSteps = [];

  const ctx = {
    busy: true,
    stopRequested: false,
    answeringNow: false,
    conv: { id: 10, model: 'gpt-4o', messages: [{ role: 'user', content: 'What does this project do?' }] },
    agentMessages: [
      { role: 'system', content: 'Workspace context: repo contains 15 files.' },
      { role: 'user', content: 'What does this project do?' },
    ],
    contTools: [
      { uid: 'u1', action: 'read', path: 'package.json', result: '{"name": "test-pkg"}' },
      { uid: 'u2', action: 'search', pattern: 'main', result: null },
    ],
    contResolved: 1,
    rowByUid: {
      u1: { closed: true, record: { status: 'completed' } },
      u2: { closed: false, record: { status: 'running' } },
    },
    stepRows: [
      { closed: false, record: { status: 'running' } },
    ],
    pendingText: 'I am reading package.json now.',
    agentRounds: 1,
    pendingBubble: null,
    answerNowBtn: { disabled: false, textContent: 'Answer now' },
    showThinking() { },
    maskFenced: t => String(t || '').replace(/…/g, ''),
    closeStep: (row, msg, status) => { row.closed = true; closedSteps.push({ row, msg, status }); },
    showStep: (title, done, note) => steps.push({ title, done, note }),
    post: (type, payload) => calls.push({ type, ...payload }),
  };

  const answerFn = source.slice(source.indexOf('  function answerNow() {'), source.indexOf('  /* ---------- per-message actions'));
  vm.runInNewContext(answerFn, ctx);

  ctx.answerNow();

  assert.equal(ctx.answeringNow, true);
  assert.equal(ctx.answerNowBtn.disabled, true);
  assert.equal(ctx.answerNowBtn.textContent, 'Answering…');
  assert.equal(ctx.contTools.length, 0, 'contTools was cleared');

  // u2 was running, should be closed as cancelled
  assert.ok(ctx.rowByUid.u2.closed, 'running tool u2 was closed');
  assert.ok(steps.some(s => s.title === 'Answer now'), 'Answer now was added to activity timeline');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'chat');
  assert.equal(calls[0].body.quickAnswer, true);
  assert.equal(calls[0].body.agentic, false);
  assert.equal(calls[0].body.think, false);
  assert.equal(calls[0].body.webSearch, false);

  const sentMsgs = calls[0].body.messages;
  assert.ok(sentMsgs.some(m => m.role === 'system' && m.content.includes('Workspace context')));
  assert.ok(sentMsgs.some(m => m.role === 'user' && m.content.includes('package.json')));
  assert.ok(sentMsgs.at(-1).content.includes('Answer the user request now using the context'));
});

test('quick answer completion prevents further tool extraction even if agentic is enabled', () => {
  const source = fs.readFileSync(path.join(__dirname, '../vscode/media/chat.js'), 'utf8');
  const doneCase = source.slice(source.indexOf("      case 'done': {"), source.indexOf("      case 'toolResult': {"));

  const calls = [];
  const steps = [];
  const ctx = {
    busy: true,
    stopRequested: false,
    answeringNow: true,
    agenticEnabled: true,
    pendingEdits: [],
    rafPending: false,
    pendingText: 'Here is the answer based on package.json:\n<tool>{"action":"read","path":"unused.js"}</tool>',
    pendingBubble: {},
    agentRounds: 1,
    continuationRetries: 0,
    MAX_AGENT_ROUNDS: 40,
    activeResponseStep: null,
    conv: { id: 10, model: 'gpt-4o', messages: [{ role: 'user', content: 'What does this project do?' }] },
    agentMessages: [],
    contTools: [],
    setRich() { },
    showThinking() { },
    showStep: (...args) => steps.push(args),
    saveConv() { },
    hint() { },
    pickFun: () => '',
    ABORT_LINES: [],
    post: (type, payload) => calls.push({ type, ...payload }),
    beginToolRound: tools => calls.push({ type: 'tools', tools }),
    finishBubble: outcome => { ctx.outcome = outcome; ctx.busy = false; },
  };

  ctx.msg = {};
  vm.runInNewContext(source.slice(source.indexOf('  function repairJson('), source.indexOf('  function diffLines(')), ctx);
  vm.runInNewContext('switch("done") {\n' + doneCase + '\n}', ctx);

  assert.equal(calls.length, 0, 'No tool round was begun after Answer now');
  assert.equal(ctx.outcome, 'completed', 'Finished successfully with completed outcome');
  assert.equal(ctx.answeringNow, false, 'answeringNow was reset to false');
  assert.equal(ctx.conv.messages.length, 2);
  assert.equal(ctx.conv.messages[1].role, 'assistant');
});

test('extension controller aborts in-flight request when quick answer is launched', async () => {
  const extensionPath = path.resolve(__dirname, '../vscode/extension.js');
  const extSource = fs.readFileSync(extensionPath, 'utf8');
  const { createRequire } = require('node:module');

  const calls = [];
  const posts = [];
  const config = { provider: 'endpoint', endpoint: 'https://free.example/v1', model: 'my/free-model', accessKey: 'key' };
  const req = createRequire(extensionPath);

  let firstAborted = false;
  const context = {
    module: { exports: {} }, console, process, Buffer, URL, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? {
      window: { tabGroups: { all: [] } },
      ConfigurationTarget: { Global: 1 },
      Uri: { joinPath: (root, rel) => ({ fsPath: path.join(root.fsPath, rel) }) },
      workspace: { getConfiguration: () => ({ get: k => config[k], update: async (k, v) => { config[k] = v; } }) },
    } : req(name),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        // Slow first request in-flight: trigger quick answer while waiting
        setTimeout(() => {
          receive({ type: 'chat', body: { messages: [{ role: 'user', content: 'Quick answer now' }], stream: false, quickAnswer: true } });
        }, 5);

        return new Promise((resolve, reject) => {
          const onAbort = () => {
            firstAborted = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (options.signal?.aborted) {
            onAbort();
          } else if (options.signal) {
            options.signal.addEventListener('abort', onAbort);
          }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'QUICK ANSWER RESULT' } }] }));
    },
  };

  vm.runInNewContext(extSource + '\nmodule.exports.TestProvider=ReachChatViewProvider;', context, { filename: extensionPath });
  const provider = new context.module.exports.TestProvider({ fsPath: '/extension' });
  provider._post = (type, payload) => posts.push({ type, ...payload });
  let receive;
  provider._html = () => '';
  provider.resolveWebviewView({ webview: { onDidReceiveMessage: handler => { receive = handler; } } });

  // First request starts
  await receive({ type: 'chat', body: { messages: [{ role: 'user', content: 'Slow question' }], stream: false } });
  // Allow any pending async ticks to complete
  await new Promise(r => setTimeout(r, 30));

  assert.equal(firstAborted, true, 'First request fetch was aborted');
  // Posts should contain the second response done, not an aborted done from the first
  const donePosts = posts.filter(p => p.type === 'done');
  assert.equal(donePosts.length, 1, 'Only one done message was posted for the quick answer');
  assert.equal(donePosts[0].full, 'QUICK ANSWER RESULT');
  assert.equal(donePosts[0].aborted, undefined);
});
