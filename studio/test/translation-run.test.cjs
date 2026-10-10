'use strict';

// Exercise the actual popover request handler with a deferred IPC reply. The
// DOM and IPC boundaries are small fixtures; the request logic is not copied.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const languages = require('../renderer/languages.js');
const translate = require('../renderer/translate.js');

function requestFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/message-translation.js'), 'utf8').replace(/\r\n/g, '\n').replace(/^ {4}/gm, '');
  const popoverStart = source.indexOf('function openTranslatePopover(');
  const start = source.indexOf('  async function run() {', popoverStart);
  const end = source.indexOf('\n  swap.onclick = ', start);
  assert.ok(popoverStart >= 0 && start > popoverStart && end > start, 'Locate the actual popover request handler');
  let resolve, reject;
  const reply = new Promise((yes, no) => { resolve = yes; reject = no; });
  const calls = [], translations = [];
  let closed = 0;
  const context = vm.createContext({
    target: languages.get('en'),
    input: { value: 'English' },
    languages,
    translate,
    getCurrentAgent: () => ({ id: 'translation-fixture' }),
    runId: 0,
    go: { disabled: false, textContent: 'Translate' },
    swap: { disabled: false },
    pick: { focus() {} },
    meta: { textContent: '' },
    known: languages.get('es'),
    sourceName: 'Spanish',
    text: 'Hola mundo',
    role: 'user',
    pop: { isConnected: true },
    bubble: { isConnected: true },
    localStorage: { setItem() {} },
    TRANSLATE_TARGET_KEY: 'reach:translate-target',
    reachApi: { playground: { run(payload) { calls.push(payload); return reply; } } },
    applyBubbleTranslation(...args) { translations.push(args); },
    closeTranslatePopovers() { closed += 1; },
  });
  const run = vm.runInContext(source.slice(start, end) + '\nrun;', context);
  return { context, run, resolve, reject, calls, translations, closed: () => closed };
}

test('an in-flight translation keeps the language requested when the picker changes', async () => {
  const fixture = requestFixture();
  const pending = fixture.run();
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0].prompt, /English/);
  assert.equal(fixture.calls[0].controls, false);
  assert.equal(fixture.context.go.disabled, true);
  fixture.context.target = languages.get('fr');
  fixture.context.input.value = 'French';
  fixture.resolve({ ok: true, text: 'Hello world' });
  await pending;
  assert.equal(fixture.translations.length, 1);
  assert.equal(fixture.translations[0][1], 'Hello world');
  assert.equal(fixture.translations[0][3], 'English', 'Label the result with its requested target');
  assert.equal(fixture.context.go.disabled, false);
  assert.equal(fixture.context.swap.disabled, false);
  assert.equal(fixture.closed(), 1);
});

test('a rejected translation request restores its controls and reports the error', async () => {
  const fixture = requestFixture();
  const pending = fixture.run();
  assert.equal(fixture.context.go.disabled, true);
  fixture.reject(new Error('Bridge offline'));
  await assert.doesNotReject(pending);
  assert.equal(fixture.context.go.disabled, false);
  assert.equal(fixture.context.go.textContent, 'Translate');
  assert.equal(fixture.context.swap.disabled, false);
  assert.equal(fixture.context.meta.textContent, 'Bridge offline');
  assert.equal(fixture.translations.length, 0);
  assert.equal(fixture.closed(), 0);
});
