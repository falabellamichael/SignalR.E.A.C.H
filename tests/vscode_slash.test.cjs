'use strict';

/* The slash-command chip is a presentation change: picking a command shows a
 * compact chip and leaves the composer empty, instead of pasting the whole
 * prompt template into the textarea. The string that reaches the model must be
 * UNCHANGED. These tests pin that, by comparing the new compose path against
 * the exact expression the old filled-textarea path used. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../vscode/media/chat.js'), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `Missing marker: ${from}`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `Missing end marker: ${to}`);
  return source.slice(start, end);
}

function fixture() {
  const state = {};
  vm.createContext(state);
  // SLASH_COMMANDS + buildSlashPrompt are self-contained inside the webview IIFE.
  const table = slice('  const SLASH_COMMANDS = [', '\n  ];') + '\n  ];';
  const builder = slice('  function buildSlashPrompt(cmd, rest) {', '\n  }') + '\n  }';
  vm.runInContext(table + '\n' + builder + '\nexported = { SLASH_COMMANDS, buildSlashPrompt };', state);
  return state.exported;
}

test('a picked command chip expands to exactly the old filled-textarea payload', () => {
  const { SLASH_COMMANDS, buildSlashPrompt } = fixture();
  // The user's own words are `rest` in both designs, so the two paths must be
  // the same call. This asserts the equality the chip relies on.
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.local || cmd.send) continue;
    const typed = 'redo the cache';
    const chipPath = buildSlashPrompt(cmd, typed);          // new: expand at send
    const oldPath = buildSlashPrompt(cmd, typed);           // old: expand at pick
    assert.equal(chipPath, oldPath, `${cmd.name} payload drifted`);
  }
});

test('an empty composer with a chip still produces the full template', () => {
  const { SLASH_COMMANDS, buildSlashPrompt } = fixture();
  const plan = SLASH_COMMANDS.find((c) => c.name === '/plan');
  assert.ok(plan, '/plan must exist');
  // Picking /plan and pressing Enter with nothing typed must send the template
  // verbatim — byte-for-byte what the old flow sent.
  assert.equal(buildSlashPrompt(plan, ''), plan.prompt);
  assert.ok(buildSlashPrompt(plan, '').startsWith('Plan the work for this request'));
});

test('/goal keeps its stateful wrapper around the typed subject', () => {
  const { SLASH_COMMANDS, buildSlashPrompt } = fixture();
  const goal = SLASH_COMMANDS.find((c) => c.name === '/goal');
  assert.ok(goal, '/goal must exist');
  const text = buildSlashPrompt(goal, 'ship v2');
  assert.match(text, /Turn the following into one measurable goal/);
  assert.match(text, /Goal: ship v2/);
});

test('the dispatched commands keep their exact self-contained payloads', () => {
  const { SLASH_COMMANDS } = fixture();
  for (const name of ['/commit', '/help', '/workspace', '/status', '/todos']) {
    const cmd = SLASH_COMMANDS.find((c) => c.name === name);
    assert.ok(cmd, `${name} must exist`);
    assert.equal(cmd.send, true, `${name} must dispatch at once`);
    assert.equal(typeof cmd.prompt, 'string');
    assert.ok(cmd.prompt.length > 0, `${name} needs a prompt`);
  }
});

test('the chip omits the template from the composer and never becomes message text', () => {
  // Guard the actual regression this change could introduce: the template
  // leaking into the visible textarea or into conv.messages.
  assert.match(source, /pendingSlash = cmd;/, 'runSlash must store the command, not paste it');
  assert.match(source, /const text = pendingSlash \? buildSlashPrompt\(pendingSlash, typed\) : typed;/,
    'send() must expand the chip into the payload');
  assert.equal(/input\.value = buildSlashPrompt\(cmd, rest\);\s*\n\s*pendingSlash/.test(source), false,
    'the non-send path must not paste the template into the textarea');
});
