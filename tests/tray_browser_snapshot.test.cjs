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
