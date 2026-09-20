'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const intents = require('../renderer/composer-intents.js');

test('command registry is accessible, unique and parseable through aliases', () => {
  const paths = new Set();
  for (const command of intents.COMMANDS) {
    assert.ok(command.path.startsWith('/'));
    assert.ok(command.description);
    assert.ok(command.usage);
    for (const path of [command.path, ...(command.aliases || [])]) {
      assert.equal(paths.has(path.toLowerCase()), false, `duplicate command form: ${path}`);
      paths.add(path.toLowerCase());
      assert.equal(intents.parse(path).id, command.id);
    }
  }
  assert.equal(intents.parse('/not-a-command').error, 'unknown-command');
  assert.equal(intents.parse('explain /team list').kind, 'chat');
  assert.equal(intents.parse('https://example.test/path').kind, 'chat');
  assert.equal(intents.parse('C:/repo/file.js').kind, 'chat');
});

test('lexer preserves quoted mention selectors and task text boundaries', () => {
  const parsed = intents.parse('  @team:"Red Team"#member-2 @model:"qwen/a+b" Review user@example.com and /tmp/a.');
  assert.equal(parsed.kind, 'mentions');
  assert.deepEqual(parsed.mentions.map(m => ({ kind: m.kind, selector: m.selector, id: m.id })), [
    { kind: 'team', selector: 'Red Team', id: 'member-2' },
    { kind: 'model', selector: 'qwen/a+b', id: '' },
  ]);
  assert.equal(parsed.body, 'Review user@example.com and /tmp/a.');
  assert.equal(intents.parse('Please ask @team:Reviewer later').kind, 'chat');
  assert.equal(intents.parse('user@example.com').kind, 'chat');
});

test('completion triggers only at valid boundaries and replaces only its token', () => {
  assert.deepEqual(intents.completionContext('/te', 3), { mode: 'command', start: 0, end: 3, query: '/te' });
  assert.deepEqual(intents.completionContext('/msg @agent:', 12), { mode: 'mention', start: 5, end: 12, query: 'agent:', raw: '@agent:', commandId: 'message' }, 'target completion takes over while command arguments are entered');
  assert.equal(intents.completionContext('/model use @', 12).commandId, 'model-use');
  assert.equal(intents.completionContext('/stop @', 7), null, 'commands without target arguments never offer an ignored mention');
  assert.equal(intents.completionContext('/msg @agent:"A"#a1 -- please ask @', 35), null, 'message-body mentions stay literal after the target argument');
  assert.equal(intents.completionContext('user@example.com', 16), null);
  assert.equal(intents.completionContext('Please read /tmp/a', 18), null);
  assert.equal(intents.completionContext('Ask @pers', 9), null, 'inline prose never offers a route that submission would ignore');
  const text = '@agent:"Lead"#a1 @pers next';
  const ctx = intents.completionContext(text, text.indexOf(' next'));
  assert.equal(ctx.mode, 'mention');
  const replaced = intents.replaceCompletion(text, ctx, intents.mentionInsert('persona', 'QA [A+B]', 'persona-7'));
  assert.equal(replaced.text, '@agent:"Lead"#a1 @persona:"QA [A+B]"#persona-7 next');
  const atEnd = intents.replaceCompletion('@rev', { mode: 'mention', start: 0, end: 4 }, intents.mentionInsert('team', 'Reviewer', 'm2-reviewer'));
  assert.equal(atEnd.text, '@team:"Reviewer"#m2-reviewer ');
  assert.equal(atEnd.cursor, atEnd.text.length);
  const middle = '@persXYZ next';
  const middleContext = intents.completionContext(middle, 5);
  assert.equal(middleContext.end, 8, 'completion owns the entire active token even when the caret is in its middle');
  assert.equal(intents.replaceCompletion(middle, middleContext, intents.mentionInsert('persona', 'Reviewer', 'p1')).text, '@persona:"Reviewer"#p1 next');
});

test('candidate filtering is literal, stable-id based, deterministic and capped', () => {
  const candidates = [
    { kind: 'persona', id: '2', label: '<img src=x>', search: '<img src=x>' },
    { kind: 'persona', id: '1', label: 'A+B [QA]', search: 'A+B [QA]' },
    { kind: 'agent', id: '3', label: 'A+B [QA]', search: 'A+B [QA]' },
    { kind: 'persona', id: '1', label: 'duplicate record', search: 'duplicate record' },
  ];
  assert.deepEqual(intents.filterCandidates(candidates, 'A+B').map(c => c.id), ['3', '1']);
  assert.equal(intents.filterCandidates(candidates, '<img').at(0).id, '2');
  const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'agent', id: String(i), label: `Agent ${i}`, search: `Agent ${i}` }));
  assert.equal(intents.filterCandidates(many, '', 12).length, 12);
});

test('target and option parsing keeps message content as data', () => {
  const result = intents.takeTargetAndMessage('@persona:"Reviewer"#p1 --model "qwen 3" --role auditor -- Check @x, /tmp/a, and "quoted text".', ['model', 'role']);
  assert.equal(result.target, '@persona:Reviewer#p1');
  assert.deepEqual(result.options, { model: 'qwen 3', role: 'auditor' });
  assert.equal(result.message, 'Check @x, /tmp/a, and "quoted text".');
  assert.equal(intents.stripDelimiter('-- hello'), 'hello');
  assert.equal(intents.stripDelimiter('hello'), 'hello');
  assert.equal(intents.optionValue(result.options, 'model'), 'qwen 3');
  assert.throws(() => intents.optionValue({ model: true }, 'model'), /requires a value/);
  assert.throws(() => intents.optionValue({ model: '' }, 'model'), /requires a value/);
  assert.throws(() => intents.takeTargetAndMessage('@agent:A#a1 --modle qwen -- hello', ['model']), /Unknown option/);
  assert.equal(intents.singleArgument('@agent:A#a1', '/agent open @agent').value, '@agent:A#a1');
  assert.equal(intents.singleArgument('', '/agent status [@agent]', { optional: true }), null);
  assert.throws(() => intents.singleArgument('@agent:A#a1 trailing text', '/agent open @agent'), /Usage: \/agent open/);
  assert.equal(intents.modelIdFromToken('@model:"qwen 3"'), 'qwen 3');
  assert.equal(intents.modelIdFromToken('vendor/model'), 'vendor/model');
  assert.throws(() => intents.modelIdFromToken('@agent:"Not a model"#a1'), /Choose a model/);
});

test('delivery identity deduplicates current and saved aliases for one chat', () => {
  assert.equal(intents.deliveryKey({ kind: 'current', id: 'chat-1' }), 'agent:chat-1');
  assert.equal(intents.deliveryKey({ kind: 'agent', id: 'chat-1' }), 'agent:chat-1');
  assert.equal(intents.deliveryKey({ kind: 'persona', id: 'chat-1' }), 'persona:chat-1');
  assert.equal(intents.deliveryKey({ kind: 'team', id: 'run-1/m1' }), 'team:run-1/m1');
});

test('command completion comes from the execution registry', () => {
  const results = intents.commandCandidates('/team ');
  assert.ok(results.some(item => item.label === '/team add'));
  assert.ok(results.some(item => item.label === '/team message'));
  assert.ok(results.every(item => intents.parse(item.label).kind === 'command'));
});

test('every advertised command has a renderer execution branch', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const start = renderer.indexOf('async function executeComposerCommand');
  const end = renderer.indexOf('async function executeMentionRouting', start);
  assert.ok(start >= 0 && end > start, 'composer dispatcher boundaries not found');
  const dispatcher = renderer.slice(start, end);
  for (const command of intents.COMMANDS) {
    assert.match(dispatcher, new RegExp(`case ['"]${command.id.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}['"]\\s*:`), `${command.path} is advertised but has no execution branch`);
  }
});
