'use strict';

/* The structured plan the model writes with todo_write and reads back with
 * todo_read. normalizeTodos() and renderTodos() are module-private in
 * extension.js, so they are lifted out with vm the same way
 * vscode_header_parsing.test.cjs lifts parseHeaderLines. The point of the
 * checklist is that the 40-round pause is resumable, so both the validation
 * and the rendered round-trip are covered here. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'extension.js'), 'utf8');

function lift(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'could not find ' + name + '() in extension.js');
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const fn = source.slice(start, end);
  const ctx = { String, Array, Error, TODO_STATUSES: ['pending', 'in_progress', 'completed'] };
  vm.runInNewContext(fn + '\nthis.' + name + '=' + name + ';', ctx);
  return ctx[name];
}

const normalizeTodos = lift('normalizeTodos');
const renderTodos = lift('renderTodos');

test('normalizeTodos accepts a well-formed list and preserves order', () => {
  const todos = normalizeTodos([
    { text: 'Read the parser', status: 'in_progress' },
    { text: 'Patch the executor', status: 'pending' },
    { text: 'Run the suite', status: 'completed' },
  ]);
  assert.equal(todos.length, 3);
  assert.deepEqual(todos.map((t) => t.text), ['Read the parser', 'Patch the executor', 'Run the suite']);
  assert.deepEqual(todos.map((t) => t.status), ['in_progress', 'pending', 'completed']);
});

test('normalizeTodos defaults an unknown or missing status to pending', () => {
  const todos = normalizeTodos([
    { text: 'No status' },
    { text: 'Bogus status', status: 'nonsense' },
  ]);
  assert.equal(todos[0].status, 'pending');
  assert.equal(todos[1].status, 'pending');
});

test('normalizeTodos rejects malformed input rather than silently dropping it', () => {
  assert.throws(() => normalizeTodos('not an array'), /todos/);
  assert.throws(() => normalizeTodos([null]), /object/);
  assert.throws(() => normalizeTodos([{ text: '   ' }]), /no text/);
  assert.throws(() => normalizeTodos([{}]), /no text/);
});

test('normalizeTodos bounds the list length and per-item text', () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ text: 'step ' + i }));
  assert.throws(() => normalizeTodos(many), /50/);

  const long = normalizeTodos([{ text: 'x'.repeat(5000) }]);
  assert.equal(long[0].text.length, 300, 'per-item text must be truncated to 300 chars');
});

test('renderTodos marks each status and counts completion', () => {
  const text = renderTodos([
    { text: 'done thing', status: 'completed' },
    { text: 'doing thing', status: 'in_progress' },
    { text: 'todo thing', status: 'pending' },
  ]);
  assert.ok(text.includes('1/3 completed'), 'completion count missing: ' + text);
  assert.ok(text.includes('[x] done thing'));
  assert.ok(text.includes('[~] doing thing'));
  assert.ok(text.includes('[ ] todo thing'));
});

test('renderTodos on an empty list is explicit, not a blank string', () => {
  const text = renderTodos([]);
  assert.ok(text.length > 0);
  assert.ok(/empty/i.test(text));
});

test('a normalized list round-trips through renderTodos (the resume path)', () => {
  // This is what "continue" after the 40-round pause actually reads back.
  const todos = normalizeTodos([
    { text: 'Step A', status: 'completed' },
    { text: 'Step B', status: 'in_progress' },
  ]);
  const rendered = renderTodos(todos);
  assert.ok(rendered.includes('Step A'));
  assert.ok(rendered.includes('Step B'));
  assert.ok(rendered.includes('1/2 completed'));
});

/* The host posted a `todos` message that the webview had no handler for, so a
 * model-written plan was invisible to the user. These guard the two ends of
 * that wiring so it cannot silently come apart again. */
const CHAT_SRC = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'media', 'chat.js'), 'utf8');
const EXT_SRC = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'extension.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(__dirname, '..', 'vscode', 'media', 'style.css'), 'utf8');

test('the host still posts todo state to the webview', () => {
  assert.match(EXT_SRC, /_post\(\s*'todos'/,
    'extension.js no longer posts the todos message');
});

test('the webview handles the todos message and renders a checklist', () => {
  assert.match(CHAT_SRC, /case 'todos':/, 'chat.js has no todos message handler');
  assert.match(CHAT_SRC, /function renderTodoCard\(/, 'chat.js has no checklist renderer');
  assert.match(CHAT_SRC, /renderTodoCard\(/, 'the todos handler never calls the renderer');
  // The three status classes the renderer emits must have styling.
  for (const cls of ['todo-card', 'todo-items', 'todo-completed', 'todo-in_progress']) {
    assert.ok(CSS_SRC.includes('.' + cls), 'style.css is missing .' + cls);
  }
});

/* The renderer is re-painted in place, not appended per update: a plan the
 * model rewrites repeatedly must read as one checklist, not N stacked copies. */
test('todo rendering is idempotent across repeated writes', () => {
  const body = CHAT_SRC.slice(
    CHAT_SRC.indexOf('function renderTodoCard('),
    CHAT_SRC.indexOf('function paintStep('),
  );
  assert.ok(body.includes('if (!todoCard || !todoCard.isConnected)'),
    'renderTodoCard must reuse the existing card instead of appending a new one');
  assert.ok(body.includes('items.textContent = \'\''),
    'renderTodoCard must clear the list before repainting');
});
