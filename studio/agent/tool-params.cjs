'use strict';

// Declarative argument contract for every registered tool. Unknown fields are
// tolerated during migration; declared fields are checked before sandbox and
// approval so malformed calls never become review prompts.
const s = (name, required = false, maxLength = 100000, defaultValue) => ({ name, type: 'string', required, maxLength, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const n = (name, min = 0) => ({ name, type: 'integer', min });
const b = name => ({ name, type: 'boolean' });
const a = (name, required = false, maxItems = 1000, defaultValue) => ({ name, type: 'array', required, maxItems, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const o = name => ({ name, type: 'object' });
const path = (required = false) => s('path', required, 2048);
const command = (required = false) => s('command', required, 4000);

const PARAMS = {
  read: [path(true), n('startLine', 1), n('endLine', 1)],
  write: [path(true), s('content', true, 4_000_000)],
  edit_patch: [path(true), a('hunks', true, 1000)],
  glob: [s('pattern', false, 2000, '*'), path()],
  search: [s('pattern', true, 2000), path(), b('regex'), b('caseSensitive'), s('include', false, 2000)],
  list: [path()],
  shell: [command(true)],
  websearch: [s('query', true, 4000)],
  browse: [s('url', true, 4096)],
  memory: [s('op', false, 20, 'read'), s('entry', false, 10000)],
  todo_write: [a('todos', true, 200)],
  todo_read: [],
  tool_help: [s('topic', false, 40, 'core')],
  browser: [s('op', false, 40, 'read'), s('url', false, 4096), s('tabId', false, 120), s('direction', false, 20)],
  'browser.click': [s('tabId', false, 120), s('ref', true, 500)],
  'browser.type': [s('tabId', false, 120), s('ref', true, 500), s('text', true, 100000)],
  'reach.compile': [path()],
  'reach.run': [path(), a('args', false, 100)],
  'reach.init': [],
  'reach.clean': [],
  'reach.version': [],
  'agent.spawn': [s('name', true, 200), s('task', true, 20000), s('prompt', false, 20000), s('model', false, 240)],
  'agent.send': [s('to', true, 200), s('message', true, 40000)],
  'agent.status': [s('agent', true, 200)],
  'agent.list': [],
  'agent.transcript': [s('agent', true, 200), n('limit', 1)],
  'agent.await': [s('agent', true, 200), n('timeoutMs')],
  'agent.reflect': [],
  'code.index': [b('refresh')],
  'code.search': [s('query', true, 4000), n('limit', 1)],
  'code.context': [s('query', true, 4000), n('maxSymbols', 1), n('maxChars', 1)],
  'code.impact': [s('symbol', false, 4000), s('file', false, 2048)],
  'refactor.plan': [a('edits', true, 200), b('dependencyIndex'), n('context')],
  'refactor.apply': [s('planId', true, 200), o('accepted'), b('commit'), s('commitMessage', false, 1000)],
  'patch.review': [path(true), s('content', true, 4_000_000), n('context')],
  'tests.run': [a('gates', false, 8, [{ id: 'test', command: 'npm test', runner: 'node' }])],
  'tests.quickfix': [command(true), a('paths', false, 400)],
};

// @fixed denotes a structured invocation of Studio's bundled Reach CLI. All
// other paths name argument fields that can reach a shell.
const COMMAND_PATHS = {
  shell: ['command'],
  'reach.compile': ['@fixed'],
  'reach.run': ['@fixed'],
  'reach.init': ['@fixed'],
  'reach.clean': ['@fixed'],
  'tests.run': ['gates[].command'],
  'tests.quickfix': ['command'],
};

function validateToolArgs(params, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Tool arguments must be an object.' };
  const args = { ...raw };
  for (const field of params) {
    let value = args[field.name];
    if (value === undefined) {
      if (field.default !== undefined) { args[field.name] = structuredClone(field.default); continue; }
      if (field.required) return { ok: false, error: `Argument "${field.name}" is required.` };
      continue;
    }
    if (field.type === 'integer' && typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    if (field.type === 'boolean' && (value === 'true' || value === 'false')) value = value === 'true';
    const valid = field.type === 'string' ? typeof value === 'string'
      : field.type === 'integer' ? Number.isSafeInteger(value) && value >= field.min
        : field.type === 'array' ? Array.isArray(value)
          : field.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
            : field.type === 'boolean' ? typeof value === 'boolean' : false;
    if (!valid) return { ok: false, error: `Argument "${field.name}" must be ${field.type}.` };
    if (field.maxLength !== undefined && value.length > field.maxLength) return { ok: false, error: `Argument "${field.name}" exceeds ${field.maxLength} characters.` };
    if (field.maxItems !== undefined && value.length > field.maxItems) return { ok: false, error: `At most ${field.maxItems} ${field.name} may be supplied.` };
    args[field.name] = value;
  }
  return { ok: true, args };
}

function commandsAt(args, paths) {
  const commands = [];
  for (const expression of paths) {
    if (expression === '@fixed') continue;
    const match = /^(\w+)\[\]\.([\w]+)$/.exec(expression);
    if (match) {
      for (const item of Array.isArray(args[match[1]]) ? args[match[1]] : []) {
        if (typeof item?.[match[2]] === 'string' && item[match[2]].trim()) commands.push(item[match[2]]);
      }
    } else if (typeof args[expression] === 'string' && args[expression].trim()) commands.push(args[expression]);
  }
  return commands;
}

module.exports = { PARAMS, COMMAND_PATHS, validateToolArgs, commandsAt };
