'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const actionsModule = require('../renderer/message-actions.js');
const translationModule = require('../renderer/message-translation.js');

// Small DOM boundary fixture: fragments move their actual nodes, so identity
// checks catch lost original bodies, thought markers, and message furniture.
class NodeFixture {
  constructor(nodeType = 1, text = '') {
    this.nodeType = nodeType;
    this._text = text;
    this.childNodes = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.disabled = false;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, enabled = !this.classList.contains(name)) => { this.classList[enabled ? 'add' : 'remove'](name); return enabled; },
    };
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get isConnected() { return this.rootConnected === true || !!this.parentNode?.isConnected; }
  get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  insertBefore(node, before) {
    if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.insertBefore(child, before); return node; }
    node.remove();
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    assert.ok(index >= 0, 'Insertion anchor belongs to its parent');
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { for (const node of [...this.childNodes]) node.remove(); this.append(...nodes); }
  remove() {
    if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  querySelectorAll(selector) {
    const direct = selector.startsWith(':scope > ');
    const classes = selector.replace(':scope > ', '').slice(1).split('.');
    const nodes = direct ? this.children : this.children.flatMap(node => [node, ...node.descendants()]);
    return nodes.filter(node => classes.every(name => node.classList.contains(name)));
  }
  descendants() { return this.children.flatMap(node => [node, ...node.descendants()]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener() {}
}

function fixture() {
  const document = {
    createElement: () => new NodeFixture(),
    createTextNode: text => new NodeFixture(3, String(text)),
    createDocumentFragment: () => new NodeFixture(11),
  };
  const values = new Map();
  const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  const events = [];
  const window = { addEventListener: (...args) => events.push(args), requestAnimationFrame() {} };
  const chatLog = new NodeFixture();
  chatLog.rootConnected = true;
  let agent = { id: 'first', todos: [] };
  const notices = [];
  const getCurrentAgent = () => agent;
  return { document, localStorage, window, chatLog, events, notices, getCurrentAgent,
    setAgent(value) { agent = value; }, showNotice: text => notices.push(text) };
}

test('browser module registration defers DOM work and scripts load before app initialization', () => {
  const context = vm.createContext({ window: {} });
  for (const file of ['message-translation.js', 'message-actions.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer', file), 'utf8'), context);
  }
  assert.equal(typeof context.window.ReachMessageTranslation.create, 'function');
  assert.equal(typeof context.window.ReachMessageActions.create, 'function');
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  const index = file => scripts.indexOf(file);
  assert.ok(index('languages.js') < index('message-translation.js'));
  assert.ok(index('translate.js') < index('message-translation.js'));
  assert.ok(index('message-translation.js') < index('message-actions.js'));
  assert.ok(index('message-actions.js') < index('app.js'));
  assert.equal(scripts.filter(file => file === 'message-actions.js').length, 1);
});

test('app forwarding helpers remain hoisted window APIs with module-owned state and return values', () => {
  const f = fixture();
  const context = vm.createContext({
    ...f.window, document: f.document, localStorage: f.localStorage,
    chatLog: f.chatLog, chatScroll: {}, composerInput: {}, md: {}, reachApi: {},
    showNotice: f.showNotice, confirmAction: () => false, escapeHtml: String,
    currentAgent: f.getCurrentAgent(), agentRunning: false, runningAgentIds: new Set(),
    composerIntentPending: false, stoppingAll: false, activeTeamRun: null,
    updateSendControl() {}, appendChatMessage() {}, updateStatusPill() {},
    loadAgentTree() {}, renderTodos() {}, scheduleBrowserLayout() {},
  });
  vm.runInContext('window = globalThis;', context);
  for (const file of ['message-translation.js', 'message-actions.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer', file), 'utf8'), context);
  }
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="(app[^"]+)"><\/script>/g)].map(match => match[1]);
  const source = scripts.map(file => fs.readFileSync(path.join(__dirname, '../renderer', file), 'utf8')).join('\n');
  const start = source.indexOf('function messageResendBusy()');
  const end = source.indexOf('function appendChatMessage(', start);
  assert.ok(start >= 0 && end > start, 'Locate actual application transcript wiring');
  vm.runInContext('window.helperWasHoisted = typeof window.openTranslatePopover === "function";\n' + source.slice(start, end), context);
  assert.equal(context.helperWasHoisted, true);
  for (const [name, arity] of Object.entries({
    appendThoughtIndicator: 2, updateMessageActions: 0, collapseMessageTray: 1,
    appendMessageActions: 3, applyBubbleTranslation: 5, openTranslatePopover: 4,
  })) {
    assert.equal(typeof context[name], 'function', name + ' remains a window function');
    assert.equal(context[name].length, arity, name + ' preserves its signature');
  }
  assert.equal(context.pinnedMessagesKey('first'), 'reach:pinned:first');
  assert.equal(context.togglePinnedMessage('first', 'saved-key', 'body', 'user'), true);
  assert.equal(context.isMessagePinned('first', 'saved-key'), true);
  assert.equal(context.togglePinnedMessage('first', 'saved-key', 'body', 'user'), false);
  assert.equal(context.isMessagePinned('first', 'saved-key'), false);
  assert.equal(context.savedTranslatePos(), null);
  assert.match(context.messageActionIcon('copy'), /<svg/);
});

test('translation toggles and replacement preserve original node identity and furniture', () => {
  const f = fixture();
  const api = translationModule.create({ ...f, md: {}, reachApi: {}, scheduleBrowserLayout() {} });
  const bubble = f.document.createElement('div');
  const original = f.document.createTextNode('Hola mundo');
  const thought = f.document.createElement('span'); thought.className = 'thought-lead';
  const timestamp = f.document.createElement('span'); timestamp.className = 'msg-ts';
  const actions = f.document.createElement('span'); actions.className = 'msg-actions';
  bubble.append(original, thought, timestamp, actions);
  f.chatLog.appendChild(bubble);
  api.applyBubbleTranslation(bubble, 'Hello world', 'Spanish', 'English', 'user');
  assert.equal(original.parentNode, bubble._translate.origFrag);
  assert.equal(thought.parentNode, bubble._translate.origFrag);
  assert.equal(timestamp.parentNode, bubble);
  assert.equal(actions.parentNode, bubble);
  assert.equal(bubble._translate.tagToggle.textContent, 'Show original');
  api.showBubbleTranslation(bubble, 'original');
  assert.equal(api.bubbleBodyNodes(bubble)[0], original);
  assert.equal(api.bubbleBodyNodes(bubble)[1], thought);
  api.showBubbleTranslation(bubble, 'translated');
  api.applyBubbleTranslation(bubble, 'Bonjour monde', 'Spanish', 'French', 'user');
  assert.equal(api.bubbleBodyNodes(bubble)[0].textContent, 'Bonjour monde');
  api.clearBubbleTranslation(bubble);
  assert.deepEqual(api.bubbleBodyNodes(bubble), [original, thought]);
  assert.equal(bubble.querySelector('.msg-translation-tag'), null);
  assert.equal(bubble.classList.contains('is-translated'), false);
});

test('pin identity, per-conversation storage, limits, and unavailable catalog behavior survive extraction', () => {
  const f = fixture();
  const api = actionsModule.create(f);
  assert.equal(f.events.length, 1, 'Tray resize handler is attached once at factory creation');
  assert.equal(api.togglePinnedMessage('first', '', 'text', 'user'), false);
  assert.match(f.notices[0], /identity is unavailable/);
  for (let index = 0; index < 51; index++) api.togglePinnedMessage('first', 'key-' + index, 'x'.repeat(4500), 'user');
  assert.equal(api.getPinnedMessages('first').length, 50);
  assert.equal(api.isMessagePinned('first', 'key-0'), false);
  assert.equal(api.getPinnedMessages('first')[0].text.length, 4000);
  assert.equal(api.getPinnedMessages('second').length, 0);
  assert.equal(actionsModule.create(f).isMessagePinned('first', 'key-50'), true);
  f.localStorage.setItem(api.pinnedMessagesKey('second'), '{');
  assert.deepEqual(api.getPinnedMessages('second'), []);
  const translation = translationModule.create({ ...f, md: {}, reachApi: {}, scheduleBrowserLayout() {} });
  translation.openTranslatePopover(new NodeFixture(), null, 'Hola', 'user');
  assert.match(f.notices.at(-1), /language catalog is unavailable/);
});

test('resend callbacks read current selection live and always release pending state after an async switch', async () => {
  const f = fixture();
  let resolveReply;
  const reply = new Promise(resolve => { resolveReply = resolve; });
  const calls = [], pending = [], running = [], appended = [];
  let refreshed = 0;
  const api = actionsModule.create({ ...f, composerInput: {},
    reachApi: { agents: { resend(...args) { calls.push(args); return reply; } } },
    messageResendBusy: () => false,
    setComposerIntentPending: value => pending.push(value),
    setAgentRunning: value => running.push(value),
    updateSendControl() {}, updateStatusPill() {}, renderTodos() {},
    appendChatMessage: (...args) => appended.push(args),
    loadAgentTree: async () => { refreshed += 1; },
  });
  const bubble = new NodeFixture(); f.chatLog.appendChild(bubble);
  api.appendMessageActions(bubble, 'user', 'Run this prompt', 0, false, 'stable-message-key');
  const button = bubble.querySelector('.msg-resend');
  assert.equal(button.disabled, false);
  f.setAgent({ id: 'second' });
  await button.onclick();
  assert.equal(calls.length, 0, 'A stale message action cannot resend another conversation');
  f.setAgent({ id: 'first' });
  const run = button.onclick();
  assert.deepEqual(calls, [['first', 0, 'stable-message-key']]);
  assert.deepEqual(pending, [true]);
  f.setAgent({ id: 'second' });
  resolveReply({ ok: true, display: 'Run this prompt', messageIndex: 1, messageKey: 'new-key' });
  await run;
  assert.deepEqual(pending, [true, false]);
  assert.deepEqual(running, []);
  assert.deepEqual(appended, []);
  assert.equal(refreshed, 1);
});
