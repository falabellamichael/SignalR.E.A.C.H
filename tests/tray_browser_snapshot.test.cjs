'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'copilot', 'tray', 'main.js'), 'utf8');

function snapshotScript(startMarker, endMarker, name, globals) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'snapshot source exists');
  return vm.runInNewContext(source.slice(start, end) + '\n' + name, globals);
}

const answer = 'A'.repeat(14000)
  + '\n```agent_status\n{"status":"complete","summary":"Verified the full answer."}\n```';

test('ChatGPT snapshot keeps a long final answer and its closing status fence', () => {
  const script = snapshotScript('function chatgptReplyText(root)', 'async function chatgptSnapshot()',
    'CHATGPT_SNAPSHOT_JS', { CHATGPT_COMPOSER_SELECTOR: '#composer' });
  const answerBlock = {
    offsetWidth: 1, offsetHeight: 1, closest: () => null,
    querySelectorAll: () => [], querySelector: () => null,
    innerText: answer, textContent: answer,
  };
  const turn = { offsetWidth: 1, offsetHeight: 1, querySelectorAll: () => [answerBlock] };
  const document = {
    querySelectorAll: (selector) => selector.includes('data-message-author-role') ? [turn] : [],
    querySelector: () => ({}),
    body: { innerText: '' },
  };
  const snapshot = JSON.parse(vm.runInNewContext(script, { document, location: { href: 'https://chatgpt.com/' } }));
  assert.equal(snapshot.text, answer);
});

test('ChatGPT snapshot and cold readiness accept both the old ID and the observed Ask ChatGPT editor', async () => {
  const selector = snapshotScript('const CHATGPT_COMPOSER_SELECTOR =', 'const CHATGPT_SEND_SELECTOR =',
    'CHATGPT_COMPOSER_SELECTOR', {});
  const script = snapshotScript('function chatgptReplyText(root)', 'async function chatgptSnapshot()',
    'CHATGPT_SNAPSHOT_JS', { CHATGPT_COMPOSER_SELECTOR: selector });
  const wait = snapshotScript('async function waitForProviderWindow(', 'async function snapshot()',
    'waitForProviderWindow', { browserScriptDeadline: promise => promise,
      sleep: async () => { throw new Error('A ready editor must not poll or time out.'); } });
  const fixtures = [
    { tagName: 'DIV', id: 'prompt-textarea', role: '', ariaLabel: '', contenteditable: 'true', matchingSelector: '#prompt-textarea' },
    { tagName: 'DIV', id: '', role: 'textbox', ariaLabel: 'Ask ChatGPT', contenteditable: 'true',
      matchingSelector: '[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]' },
  ];
  for (const editor of fixtures) {
    const document = { body: { innerText: '' }, querySelectorAll: () => [],
      querySelector: value => value.split(',').map(part => part.trim()).includes(editor.matchingSelector) ? editor : null };
    const snapshot = JSON.parse(vm.runInNewContext(script, { document, location: { href: 'https://chatgpt.com/' } }));
    assert.equal(snapshot.composer, true, `ready editor: ${editor.id || editor.ariaLabel}`);
    assert.equal(snapshot.signIn, false);
    let polls = 0;
    await wait(() => {}, async () => { polls++; return snapshot; },
      () => { throw new Error('A ready editor must not open a sign-in window.'); }, 'ChatGPT');
    assert.equal(polls, 1);
  }
});

test('ChatGPT snapshot captures the observed MarkdownRoot answer and excludes thinking and the composer', () => {
  const script = snapshotScript('function chatgptReplyText(root)', 'async function chatgptSnapshot()',
    'CHATGPT_SNAPSHOT_JS', { CHATGPT_COMPOSER_SELECTOR: '#composer' });
  const newRootSelector = '[class*="MarkdownRoot-"]';
  const finalAnswer = 'The completed answer.\n```text\nfinal line\n```';
  const root = (text, thinking = false, visible = true) => ({
    className: 'MarkdownRoot-rZKhxa', offsetWidth: visible ? 1 : 0, offsetHeight: 0,
    closest: selector => thinking && selector.includes('thinking') ? {} : null,
    querySelectorAll: () => [], querySelector: () => null,
    innerText: text, textContent: text,
  });
  const roots = [root(finalAnswer), root('Private thinking summary', true), root('Hidden old answer', false, false)];
  const matchingRoots = selector => selector.includes(newRootSelector) ? roots : [];
  const composer = { className: 'ProseMirror', innerText: 'An unsent draft' };
  for (const legacyTurn of [false, true]) {
    const turn = { offsetWidth: 1, offsetHeight: 1,
      querySelectorAll: matchingRoots, querySelector: () => ({}) };
    const document = {
      querySelectorAll: selector => selector === '[data-message-author-role="assistant"]'
        ? (legacyTurn ? [turn] : []) : matchingRoots(selector),
      querySelector: selector => selector === '#composer' ? composer : null,
      body: { innerText: '' },
    };
    const snapshot = JSON.parse(vm.runInNewContext(script, { document, location: { href: 'https://chatgpt.com/' } }));
    assert.equal(snapshot.text, finalAnswer, `answer path with legacy turn: ${legacyTurn}`);
    assert.equal(snapshot.count, 1);
    assert.equal(snapshot.composer, true);
    assert.equal(snapshot.generating, false);
  }
});

test('ChatGPT snapshot never treats a ProseMirror composer draft as an answer', () => {
  const script = snapshotScript('function chatgptReplyText(root)', 'async function chatgptSnapshot()',
    'CHATGPT_SNAPSHOT_JS', { CHATGPT_COMPOSER_SELECTOR: '#composer' });
  const composer = { className: 'ProseMirror', innerText: 'An unsent draft' };
  const document = { querySelectorAll: () => [],
    querySelector: selector => selector === '#composer' ? composer : null, body: { innerText: '' } };
  const snapshot = JSON.parse(vm.runInNewContext(script, { document, location: { href: 'https://chatgpt.com/' } }));
  assert.equal(snapshot.text, '');
  assert.equal(snapshot.count, 0);
  assert.equal(snapshot.composer, true);
});

test('ChatGPT preserves all code-renderer text around copy controls when no semantic block exists', () => {
  const extract = snapshotScript('function chatgptReplyText(root)', 'const CHATGPT_SNAPSHOT_JS =',
    'chatgptReplyText', {});
  const code = Array.from({ length: 100 }, (_, index) => String(index + 1)).join('\n');
  const removed = new Set();
  const control = { remove: () => removed.add('control') };
  const widget = { remove: () => removed.add('widget') };
  const copy = {
    querySelectorAll: selector => selector.includes('button') ? [control, widget] : [],
    get innerText() { return ''; },
    get textContent() { return code + (removed.has('control') ? '' : '\nCopy code')
      + (removed.has('widget') ? '' : '\nWidget content'); },
  };
  const root = { querySelectorAll: () => [], querySelector: () => control,
    closest: () => null, cloneNode: () => copy,
    innerText: code + '\nCopy code\nWidget content' };
  assert.equal(extract(root), code);
  assert.deepEqual([...removed], ['control', 'widget']);
});

test('ChatGPT keeps plain div answer text after stripping a toolbar', () => {
  const extract = snapshotScript('function chatgptReplyText(root)', 'const CHATGPT_SNAPSHOT_JS =',
    'chatgptReplyText', {});
  let toolbarRemoved = false;
  const toolbar = { remove: () => { toolbarRemoved = true; } };
  const copy = { querySelectorAll: selector => selector.includes('button') ? [toolbar] : [],
    get innerText() { return 'The actual answer.' + (toolbarRemoved ? '' : '\nCopy'); } };
  const root = { querySelectorAll: () => [], querySelector: () => toolbar,
    closest: () => null, cloneNode: () => copy, innerText: 'The actual answer.\nCopy' };
  assert.equal(extract(root), 'The actual answer.');
});

test('ChatGPT returns no invented answer for empty controls or an interactive widget', () => {
  const extract = snapshotScript('function chatgptReplyText(root)', 'const CHATGPT_SNAPSHOT_JS =',
    'chatgptReplyText', {});
  const control = { remove: () => {} };
  const copy = { querySelectorAll: selector => selector.includes('button') ? [control] : [],
    innerText: '', textContent: '' };
  const controlsOnly = { querySelectorAll: () => [], querySelector: () => control,
    closest: () => null, cloneNode: () => copy, innerText: 'Copy' };
  assert.equal(extract(controlsOnly), '');
  const widget = { querySelectorAll: () => [], querySelector: () => null,
    closest: () => ({}), cloneNode: () => { throw new Error('Do not extract widget content.'); },
    innerText: 'Interactive widget content' };
  assert.equal(extract(widget), '');
});

test('ChatGPT formats a bare CODE answer with all 100 lines and its explicit language', () => {
  const extract = snapshotScript('function chatgptReplyText(root)', 'const CHATGPT_SNAPSHOT_JS =',
    'chatgptReplyText', {});
  const body = Array.from({ length: 100 }, (_, index) => String(index + 1)).join('\n');
  for (const language of ['text', '']) {
    const copy = { className: language ? `language-${language}` : '', textContent: body,
      querySelectorAll: () => [], getAttribute: () => null };
    const code = { tagName: 'CODE', parentElement: null, closest: () => null,
      cloneNode: () => copy };
    const root = { querySelectorAll: selector => selector.split(', ').includes('code') ? [code] : [],
      innerText: 'text1\nCopy code' };
    assert.equal(extract(root), '```' + language + '\n' + body + '\n```');
  }
});

test('ChatGPT keeps inline CODE inside its paragraph without a second fenced block', () => {
  const extract = snapshotScript('function chatgptReplyText(root)', 'const CHATGPT_SNAPSHOT_JS =',
    'chatgptReplyText', {});
  let codeClones = 0;
  const paragraph = { tagName: 'P', parentElement: null, closest: () => null,
    cloneNode: () => ({ querySelectorAll: () => [], innerText: 'Use const x = 1; here.' }) };
  const code = { tagName: 'CODE', parentElement: { closest: () => paragraph }, closest: () => null,
    cloneNode: () => { codeClones++; throw new Error('Inline code must remain in its paragraph.'); } };
  const root = { querySelectorAll: () => [paragraph, code], contains: element => element === paragraph,
    innerText: 'Unfiltered root text' };
  assert.equal(extract(root), 'Use const x = 1; here.');
  assert.equal(codeClones, 0);
});

test('Copilot snapshot keeps long text and newlines in a final status fence', () => {
  const script = snapshotScript('function copilotReplyText(root)', 'const sleep =', 'SNAPSHOT_JS', {
    REPLY_STOP_MARKERS: ['Message Copilot'], COMPOSER_SELECTOR: '#composer',
  });
  const message = { offsetWidth: 1, offsetHeight: 1, innerText: answer, querySelectorAll: () => [] };
  const document = {
    querySelectorAll: (selector) => selector === '.fai-CopilotMessage__content' ? [message] : [],
    querySelector: () => ({}),
    body: { innerText: '' },
  };
  const snapshot = JSON.parse(vm.runInNewContext(script, { document, location: { href: 'https://m365.cloud.microsoft/chat' } }));
  assert.equal(snapshot.text, answer);
});

test('Copilot snapshot restores a labeled code fence and omits code UI text', () => {
  const script = snapshotScript('function copilotReplyText(root)', 'const sleep =', 'SNAPSHOT_JS', {
    REPLY_STOP_MARKERS: ['Message Copilot'], COMPOSER_SELECTOR: '#composer',
  });
  const status = '{"status":"complete","summary":"Verified."}';
  const paragraph = {
    tagName: 'P', parentElement: null, closest: () => null,
    cloneNode: () => ({ querySelectorAll: () => [], innerText: 'COPILOT_STATUS_OK' }),
  };
  const codeUi = {
    tagName: 'P', parentElement: null,
    closest: (selector) => selector.includes('code-header') ? {} : null,
  };
  const code = {
    textContent: status, className: '',
    getAttribute: (name) => name === 'data-language' ? 'agent_status' : null,
  };
  const pre = {
    tagName: 'PRE', parentElement: null, closest: () => null,
    querySelector: () => code, getAttribute: () => null, className: '',
  };
  const message = {
    offsetWidth: 1, offsetHeight: 1,
    innerText: 'COPILOT_STATUS_OK\n\nPlain Text\nagent_status isn’t fully supported.\n' + status,
    querySelectorAll: () => [paragraph, codeUi, pre],
  };
  const document = {
    querySelectorAll: (selector) => selector === '.fai-CopilotMessage__content' ? [message] : [],
    querySelector: () => ({}), body: { innerText: '' },
  };
  const snapshot = JSON.parse(vm.runInNewContext(script, { document, location: { href: 'https://m365.cloud.microsoft/chat' } }));
  assert.equal(snapshot.text, 'COPILOT_STATUS_OK\n\n```agent_status\n' + status + '\n```');
  assert.equal(snapshot.codeBlocks, 1);
  assert.equal(snapshot.unlabeledCodeBlocks, 0);
  assert.deepEqual(snapshot.codeLanguageKinds, ['agent_status']);
});

test('Copilot snapshot does not invent a language for unlabeled code', () => {
  const script = snapshotScript('function copilotReplyText(root)', 'const sleep =', 'SNAPSHOT_JS', {
    REPLY_STOP_MARKERS: [], COMPOSER_SELECTOR: '#composer',
  });
  const code = { textContent: '{"status":"complete"}', className: '', getAttribute: () => null };
  const pre = { tagName: 'PRE', parentElement: null, closest: () => null,
    querySelector: () => code, getAttribute: () => null, className: '' };
  const message = { offsetWidth: 1, offsetHeight: 1, querySelectorAll: () => [pre] };
  const document = { querySelectorAll: (selector) => selector === '.fai-CopilotMessage__content' ? [message] : [],
    querySelector: () => ({}), body: { innerText: '' } };
  const snapshot = JSON.parse(vm.runInNewContext(script, { document, location: { href: 'https://m365.cloud.microsoft/chat' } }));
  assert.equal(snapshot.text, '```\n{"status":"complete"}\n```');
  assert.equal(snapshot.unlabeledCodeBlocks, 1);
  assert.deepEqual(snapshot.codeLanguageKinds, ['missing']);
});

test('Copilot restores agent_status only from its explicit unsupported-language notice', () => {
  const script = snapshotScript('function copilotReplyText(root)', 'const sleep =', 'SNAPSHOT_JS', {
    REPLY_STOP_MARKERS: [], COMPOSER_SELECTOR: '#composer',
  });
  const notice = 'Plain Text\nagent_status isn’t fully supported. Syntax highlighting is based on Plain Text.';
  const body = '{"status":"complete","summary":"Verified."}';
  const message = { offsetWidth: 1, offsetHeight: 1, innerText: 'COPILOT_STATUS_OK\n\n' + notice + '\n' + body,
    querySelectorAll: () => [] };
  const document = { querySelectorAll: (selector) => selector === '.fai-CopilotMessage__content' ? [message] : [],
    querySelector: () => ({}), body: { innerText: '' } };
  const context = { document, location: { href: 'https://m365.cloud.microsoft/chat' } };
  const snapshot = JSON.parse(vm.runInNewContext(script, context));
  assert.equal(snapshot.text, 'COPILOT_STATUS_OK\n\n```agent_status\n' + body + '\n```');
  assert.equal(snapshot.statusWidgetNormalized, true);

  message.innerText = body;
  const arbitrary = JSON.parse(vm.runInNewContext(script, context));
  assert.equal(arbitrary.text, body);
  assert.equal(arbitrary.statusWidgetNormalized, false);

  message.innerText = notice + '\n{"status":"complete"}';
  const invalid = JSON.parse(vm.runInNewContext(script, context));
  assert.equal(invalid.text, message.innerText);
  assert.equal(invalid.statusWidgetNormalized, false);
});

test('CodeGPT DOM fallback has no silent 12,000-character cut', () => {
  assert.doesNotMatch(source, /nonEmpty\s*\?\s*nonEmpty\.innerText[\s\S]{0,80}\.slice\(0,\s*12000\)/);
});

test('a cold provider window waits for a ready composer before the first send', async () => {
  const wait = snapshotScript('async function waitForProviderWindow(', 'async function snapshot()',
    'waitForProviderWindow', { browserScriptDeadline: (promise) => promise, sleep: async () => {} });
  let created = 0;
  let shown = 0;
  let polls = 0;
  await wait(() => { created++; }, async () => ({ composer: ++polls > 1 }),
    () => { shown++; }, 'CodeGPT');
  assert.equal(created, 1);
  assert.equal(polls, 2);
  assert.equal(shown, 0);
});

test('Copilot waits for navigation to settle before using a cold composer', async () => {
  let now = 3000;
  let polls = 0;
  let shown = 0;
  const wait = snapshotScript('async function waitForCopilotHydration(', 'async function checkSignedIn()',
    'waitForCopilotHydration', {
      Date: { now: () => now }, copilotNavigationAt: 2000,
      snapshot: async () => { polls++; return { composer: true, signIn: false,
        challenge: false, url: 'https://m365.cloud.microsoft/chat' }; },
      isAppHost: () => true,
      sleep: async (ms) => { now += ms; },
      showBrowser: () => { shown++; },
    });
  await wait();
  assert.ok(now >= 7400, 'the composer survived five seconds after navigation and two checks');
  assert.ok(polls >= 2);
  assert.equal(shown, 0);
});

test('Copilot reports an empty reply shell before a client timeout', async () => {
  let now = 0;
  let snapshots = 0;
  const logs = [];
  const wc = {
    executeJavaScript: async (script) => script.includes('return ta ?') ? '' : true,
    insertText: async () => {},
  };
  const send = snapshotScript('async function copilotSend(', '/* ------------------------------ bridge server',
    'copilotSend', {
      Date: { now: () => now },
      log: (message) => logs.push(message),
      waitForProviderWindow: async () => {},
      waitForCopilotHydration: async () => {},
      ensureBrowser: () => {}, showBrowser: () => {},
      checkSignedIn: async () => ({ ok: true }),
      snapshot: async () => snapshots++ === 0
        ? { count: 0, text: '' }
        : { count: 1, text: '', generating: false, url: 'https://m365.cloud.microsoft/chat' },
      browserWin: { webContents: wc },
      browserScriptDeadline: (promise) => promise,
      COMPOSER_SELECTOR: '#composer',
      sleep: async (ms) => { now += ms; },
      sendEnter: async () => {}, clickSendButton: async () => true,
      POLL_MS: 2000, isAppHost: () => true,
    });
  await assert.rejects(send('harmless probe'), /did not show a reply within 60 seconds/);
  assert.ok(logs.some((line) => line.includes('awaiting first reply after 20s')));
  assert.ok(now < 70000);
});
