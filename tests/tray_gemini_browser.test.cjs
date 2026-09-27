'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const main = fs.readFileSync(path.join(__dirname, '../copilot/tray/main.js'), 'utf8');
const gemini = fs.readFileSync(path.join(__dirname, '../copilot/tray/gemini.js'), 'utf8');
const section = (start, end) => main.slice(main.indexOf(start), main.indexOf(end));

function fixture({ enterWorks = true, clickWorks = true, replyDelay = 0, richTextFormatting = false } = {}) {
  let now = 0;
  let submittedAt = null;
  const calls = { show: 0, focus: 0, inserts: [], enter: 0, clicks: 0, mouse: 0, tile: 0, setup: [] };
  const app = new EventEmitter();
  app.whenReady = async () => {};
  const editor = {
    tagName: 'DIV', innerText: 'user: stranded request', selected: false,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 100 }),
    focus() { document.activeElement = this; }, contains: () => false,
  };
  const submit = () => { submittedAt = now; editor.innerText = ''; };
  const button = {
    disabled: false, getClientRects: () => [{}],
    getAttribute: key => key === 'aria-label' ? 'Send message' : '',
    getBoundingClientRect: () => ({ x: 490, y: 40, width: 30, height: 30, left: 490, right: 520, top: 40, bottom: 70 }),
    click() { calls.clicks++; if (clickWorks) submit(); },
  };
  const document = {
    activeElement: null,
    querySelectorAll: selector => selector === 'button' ? [button] : [editor],
    createRange: () => ({ selectNodeContents(el) { el.selected = true; } }),
  };
  const page = { document, window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) } };
  const state = () => {
    const fresh = submittedAt !== null && now - submittedAt >= replyDelay;
    return { ready: true, composer: true, signIn: false, challenge: false,
      count: fresh ? 2 : 1, userCount: submittedAt === null ? 1 : 2,
      composerText: editor.innerText, text: fresh ? 'New Gemini answer' : 'Previous answer',
      busy: false, url: 'https://gemini.google.com/app', signedInEvidence: false };
  };
  const wc = new EventEmitter();
  Object.assign(wc, {
    isDestroyed: () => false, setWindowOpenHandler() {},
    focus() { calls.focus++; },
    async executeJavaScript(script) {
      new vm.Script(script); // Validate the exact injected code, including template escapes.
      if (script.includes('const onGemini')) return state();
      return vm.runInNewContext(script, page);
    },
    async insertText(text) {
      assert.equal(document.activeElement, editor);
      assert.equal(editor.selected, true, 'the existing draft is selected before insertion');
      calls.inserts.push(text);
      editor.innerText = richTextFormatting ? text.replace(/\n/g, '\n\n').replace(/ /g, '\u00a0') : text;
    },
    sendInputEvent(event) {
      if (event.type === 'rawKeyDown') { calls.enter++; if (enterWorks) submit(); }
      if (event.type === 'mouseUp') { calls.mouse++; if (clickWorks) submit(); }
    },
  });
  const win = new EventEmitter();
  Object.assign(win, { webContents: wc, isDestroyed: () => false,
    isVisible: () => calls.show > 0, show() { calls.show++; }, focus() {}, hide() {},
    loadURL: async () => {},
  });
  const timers = {
    setTimeout(fn, ms) {
      if (ms < 10000) return setImmediate(() => { now += ms; fn(); });
      return setTimeout(fn, ms);
    },
    clearTimeout(id) { clearTimeout(id); clearImmediate(id); },
  };
  const helpers = vm.runInNewContext(
    section('async function replaceComposerText(', 'async function clickSendButton(')
    + '\n({ replaceComposerText, sendProviderEnter })',
    { browserScriptDeadline: promise => promise });
  const context = { module: { exports: {} }, URL, process, Date: { now: () => now }, ...timers,
    require(name) { assert.equal(name, 'electron'); return { app, session: {}, shell: {} }; },
  };
  vm.runInNewContext(gemini, context);
  const browser = context.module.exports.createGeminiBrowser('/unused', () => {}, {
    ...helpers,
    createProviderWindow(title, partition) { calls.setup.push({ title, partition }); return win; },
    installControlTile: async () => { calls.tile++; }, refreshNativeMenus() {},
    waitForProviderWindow: async (ensure, snapshot) => {
      await ensure(); assert.equal((await snapshot()).composer, true);
    },
  });
  return { browser, calls, editor, now: () => now };
}

test('Gemini replaces a stranded draft and submits without showing its browser', async () => {
  const f = fixture();
  assert.equal(await f.browser.send('current request'), 'New Gemini answer');
  assert.deepEqual(f.calls.inserts, ['current request']);
  assert.equal(f.calls.show, 0);
  assert.equal(f.calls.focus, 1);
  assert.equal(f.calls.enter, 1);
  assert.equal(f.calls.clicks + f.calls.mouse, 0, 'no fallback after Enter was accepted');
  assert.equal(f.calls.tile, 1);
  assert.equal(f.calls.setup[0].partition, 'persist:gemini');
});

test('Gemini falls back to Send when Enter leaves the composer unchanged', async () => {
  const f = fixture({ enterWorks: false });
  assert.equal(await f.browser.send('current request'), 'New Gemini answer');
  assert.equal(f.calls.clicks, 1);
  assert.equal(f.calls.mouse, 0, 'do not double-click a submitted request');
  assert.equal(f.calls.show, 0);
});

test('Gemini sends full multiline context even when the rich editor formats its text', async () => {
  const f = fixture({ richTextFormatting: true });
  const prompt = 'system: You are the REACH assistant.\n\nCurrent view: Models\n\nuser: heyy';
  assert.equal(await f.browser.send(prompt), 'New Gemini answer');
  assert.deepEqual(f.calls.inserts, [prompt], 'insert the original context unchanged');
  assert.equal(f.calls.enter, 1);
});

test('a failed submit can be retried without a permanent unsent-draft error', async () => {
  const f = fixture({ enterWorks: false, clickWorks: false });
  await assert.rejects(f.browser.send('first request'), /did not visibly submit/);
  await assert.rejects(f.browser.send('replacement request'), /did not visibly submit/);
  assert.deepEqual(f.calls.inserts, ['first request', 'replacement request']);
  assert.equal(f.editor.innerText, 'replacement request');
});

test('a new user turn cannot make Gemini return the previous assistant answer', async () => {
  const f = fixture({ replyDelay: 16000 });
  assert.equal(await f.browser.send('current request'), 'New Gemini answer');
  assert.ok(f.now() >= 28000, 'wait for the new answer and its quiet period');
});

test('a cancelled queued Gemini request never inserts or submits', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.browser.send('cancelled', { signal: controller.signal }), /cancelled/);
  assert.equal(f.calls.inserts.length, 0);
  assert.equal(f.calls.enter, 0);
});

test('the shared browser factory configures the session for each chat provider', () => {
  const sessions = [];
  const factory = vm.runInNewContext(
    section('function createProviderWindow(', 'function ensureBrowser(') + '\ncreateProviderWindow', {
      configureSession: value => sessions.push(value), session: { fromPartition: value => value },
      BrowserWindow: class { constructor(options) { this.options = options; } },
    });
  const configurations = ['copilot365', 'chatgpt', 'gemini'].map(provider => {
    const options = factory(provider, 'persist:' + provider).options;
    assert.equal(options.show, false);
    assert.equal(options.webPreferences.backgroundThrottling, false);
    return { ...options, title: '', webPreferences: { ...options.webPreferences, partition: '' } };
  });
  assert.deepEqual(configurations[0], configurations[1]);
  assert.deepEqual(configurations[1], configurations[2]);
  assert.deepEqual(sessions, ['persist:copilot365', 'persist:chatgpt', 'persist:gemini']);
});
