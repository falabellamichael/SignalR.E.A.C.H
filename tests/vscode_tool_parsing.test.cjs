'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '../vscode/media/chat.js');
const source = fs.readFileSync(filename, 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `Missing source function ${name}`);
  const end = source.indexOf('\n  }', start);
  assert.notEqual(end, -1, `Missing closing brace for ${name}`);
  return source.slice(start, end + '\n  }'.length);
}

function fixture() {
  const state = {
    window: {
      REACH_TOOL_NAMES: [
        'read', 'search', 'list', 'shell', 'browse', 'websearch',
        'todo_write', 'todo_read', 'tool_help', 'edit_patch',
        'browser_open', 'browser_snapshot', 'browser_click',
      ],
    },
  };
  vm.createContext(state);
  vm.runInContext([extractFunction('repairJson'), extractFunction('extractTools')].join('\n'), state, { filename });
  return { parse: (text) => state.extractTools(text) };
}

test('extractTools parses native tool_calls / invoke / tool XML wrappers', () => {
  const f = fixture();

  // Test standard ```tool fenced block
  const standard = 'Here is the plan:\n```tool\n{"action": "read", "path": "app.js"}\n```';
  const parsedStandard = f.parse(standard);
  assert.equal(parsedStandard.tools.length, 1);
  assert.equal(parsedStandard.tools[0].action, 'read');
  assert.equal(parsedStandard.tools[0].path, 'app.js');

  // Test <tool> XML block
  const xmlTool = 'Checking code:\n<tool>\n{"action": "search", "pattern": "function test"}\n</tool>';
  const parsedXmlTool = f.parse(xmlTool);
  assert.equal(parsedXmlTool.tools.length, 1);
  assert.equal(parsedXmlTool.tools[0].action, 'search');
  assert.equal(parsedXmlTool.tools[0].pattern, 'function test');

  // Test <tool_call> wrapper
  const toolCallXml = '<tool_call>\n{"action": "list", "path": "src"}\n</tool_call>';
  const parsedToolCall = f.parse(toolCallXml);
  assert.equal(parsedToolCall.tools.length, 1);
  assert.equal(parsedToolCall.tools[0].action, 'list');
  assert.equal(parsedToolCall.tools[0].path, 'src');

  // Test <invoke> wrapper with name + parameters/arguments
  const invokeXml = '<invoke>\n{"name": "browser_open", "parameters": {"url": "http://127.0.0.1:21887"}}\n</invoke>';
  const parsedInvoke = f.parse(invokeXml);
  assert.equal(parsedInvoke.tools.length, 1);
  assert.equal(parsedInvoke.tools[0].action, 'browser_open');
  assert.equal(parsedInvoke.tools[0].url, 'http://127.0.0.1:21887');
});

test('extractTools parses todo_write, edit_patch, and browser_* verbs', () => {
  const f = fixture();

  const todoFenced = '```tool\n{"action": "todo_write", "todos": [{"text": "Inspect", "status": "in_progress"}]}\n```';
  const parsedTodo = f.parse(todoFenced);
  assert.equal(parsedTodo.tools.length, 1);
  assert.equal(parsedTodo.tools[0].action, 'todo_write');
  assert.deepEqual(JSON.parse(JSON.stringify(parsedTodo.tools[0].todos)), [{ text: 'Inspect', status: 'in_progress' }]);

  const browserFenced = '```tool\n{"action": "browser_click", "ref": "2", "selector": "#btn"}\n```';
  const parsedBrowser = f.parse(browserFenced);
  assert.equal(parsedBrowser.tools.length, 1);
  assert.equal(parsedBrowser.tools[0].action, 'browser_click');
  assert.equal(parsedBrowser.tools[0].ref, '2');
  assert.equal(parsedBrowser.tools[0].selector, '#btn');
});

test('extractTools runs every JSON value in a wrapper and survives truncation', () => {
  const f = fixture();

  // The shape Qwen endpoints actually stream (probed 2026-09-12): several
  // objects, one per line, inside a single fenced block.
  const multi = '```tool\n{"action": "read", "path": "README.md"}\n'
    + '{"action": "read", "path": "server/reachd/core.py"}\n'
    + '{"action": "read", "path": "server/reachd/chat.py"}\n```';
  const parsedMulti = f.parse(multi);
  assert.equal(parsedMulti.tools.length, 3);
  assert.deepEqual(Array.from(parsedMulti.tools, (t) => t.path),
    ['README.md', 'server/reachd/core.py', 'server/reachd/chat.py']);
  assert.equal(parsedMulti.text, '');

  // One array in the wrapper is not part of the contract (pinned by the
  // transport guard test): it stays visible text.
  const arrayFenced = '```tool\n[{"action": "read", "path": "a.js"}]\n```';
  const parsedArray = f.parse(arrayFenced);
  assert.equal(parsedArray.tools.length, 0);
  assert.equal(parsedArray.text, arrayFenced);

  // Truncated output: the closing fence never arrived; complete values still run.
  const truncated = 'Reading now.\n```tool\n{"action": "read", "path": "app.js"}';
  const parsedTruncated = f.parse(truncated);
  assert.equal(parsedTruncated.tools.length, 1);
  assert.equal(parsedTruncated.tools[0].path, 'app.js');
  assert.equal(parsedTruncated.text, 'Reading now.');

  // Wrapper content that is not a known action stays as chat content.
  const content = '```tool\n{"note": "just data"}\n```';
  const parsedContent = f.parse(content);
  assert.equal(parsedContent.tools.length, 0);
  assert.match(parsedContent.text, /just data/);
});

test('extractTools accepts the bare tool-label dialect without backticks', () => {
  const f = fixture();

  const bare = 'Let me read the core file.\ntool\n{"action": "read", "path": "server/reachd/core.py"}\n\nThat should clarify the flow.';
  const parsed = f.parse(bare);
  assert.equal(parsed.tools.length, 1);
  assert.equal(parsed.tools[0].path, 'server/reachd/core.py');
  assert.match(parsed.text, /Let me read the core file\./);
  assert.match(parsed.text, /That should clarify the flow\./);
  assert.doesNotMatch(parsed.text, /"action"/);

  // A bare "tool" line followed by prose (no JSON) changes nothing.
  const prose = 'The tool\nis documented below.';
  const untouched = f.parse(prose);
  assert.equal(untouched.tools.length, 0);
  assert.match(untouched.text, /documented below/);
});
