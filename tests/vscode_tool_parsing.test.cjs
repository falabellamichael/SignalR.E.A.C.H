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
