'use strict';

const { parse } = require('./agent-run.cjs');
const { parseActionResponse, CONTROL_NAMES, canonicalToolName } = require('./agent-action.cjs');
const { parseDsmlActions } = require('./agent-dsml.cjs');
const { allowedNames } = require('./tool-registry.cjs');

const nonEmpty = value => (typeof value === 'string' ? value.trim() : '');

// Only closed, top-level protocol fences are executable. Quoted examples,
// enclosing code fences and partially streamed JSON are never recovered.
function protocolBlocks(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let fence = null, start = 0, kind = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!fence) {
      const match = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
      if (match) { fence = match[1]; start = i; kind = match[2].trim(); }
    } else if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(line)) {
      if (fence === '```' && ['tool', 'confirm', 'agent_status'].includes(kind)) {
        blocks.push({ kind, start, end: i, body: lines.slice(start + 1, i).join('\n') });
      }
      fence = null;
    }
  }
  return { lines, blocks, unfinished: !!fence && ['tool', 'confirm', 'agent_status'].includes(kind) };
}

function parseAgentResponse(content, nativeActions = []) {
  const raw = String(content || '').trim();
  const wrapped = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(raw);
  const structured = parseActionResponse(wrapped ? wrapped[1] : raw);
  const legacy = protocolBlocks(raw);
  const control = parse(raw);
  let display = raw, actions = [], confirm = null, terminal = control.control;
  let invalid = control.invalid || legacy.unfinished;
  if (!structured.error) {
    if (nativeActions.length) return { invalid: true, actions: [], display: structured.message };
    actions = structured.actions;
    display = structured.message;
    if (structured.status === 'complete') terminal = { status: 'complete', summary: display };
    if (structured.status === 'blocked') terminal = { status: 'blocked', reason: display };
    if (structured.status === 'question') confirm = { question: display, options: structured.options };
    return { actions, control: terminal, confirm, display: confirm ? '' : display, invalid: false };
  }
  // DeepSeek DSML dialect (byte-exact capture 2026-09-19): some endpoints
  // stream the model's native tool markup as plain content because the app
  // asks for JSON actions instead of advertising OpenAI `tools`. Recover the
  // real actions and strip the markup from display; a malformed block marks
  // the response invalid so the structured recovery asks again.
  const dsml = parseDsmlActions(raw);
  if (dsml.detected) {
    if (!dsml.error && dsml.actions.length && !nativeActions.length) {
      return { actions: dsml.actions, control: null, confirm: null, display: dsml.display, invalid: false };
    }
    invalid = true;
  }
  if (/^\s*\{/.test(wrapped ? wrapped[1] : raw)) invalid = true;
  const removed = new Set();
  for (const block of legacy.blocks) {
    try {
      const value = JSON.parse(block.body);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      if (block.kind === 'tool') {
        const { action, ...args } = value;
        if (!allowedNames().includes(action)) throw Error();
        actions.push({ name: action, arguments: args });
      } else if (block.kind === 'confirm') {
        if (confirm || typeof value.question !== 'string' || !value.question.trim()
          || (value.options !== undefined && (!Array.isArray(value.options) || value.options.length > 8 || value.options.some(o => typeof o !== 'string')))) throw Error();
        confirm = { question: value.question, options: value.options || [] };
      }
      for (let i = block.start; i <= block.end; i++) removed.add(i);
    } catch { invalid = true; }
  }
  display = legacy.lines.filter((_, i) => !removed.has(i)).join('\n').trim();
  // Native protocol: the model's tool_calls arrive as OpenAI function calls.
  // Real tools execute; the synthetic control tools (task_complete /
  // task_blocked / ask_user — advertised only on the native protocol) become
  // the SAME terminal states the JSON contract's status field produces.
  if (nativeActions.length) {
    if (actions.length || confirm || terminal) invalid = true;
    let controlCall = null;
    for (const call of nativeActions) {
      try {
        const wireName = call.function?.name;
        const name = canonicalToolName(wireName);
        if (!name) throw Error();
        const args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function?.arguments;
        if (!args || Array.isArray(args) || typeof args !== 'object') throw Error();
        if (CONTROL_NAMES.includes(name)) {
          if (controlCall) throw Error();
          if (name === 'task_complete' && !nonEmpty(args.summary)) throw Error();
          if (name === 'task_blocked' && !nonEmpty(args.reason)) throw Error();
          if (name === 'ask_user' && !nonEmpty(args.question)) throw Error();
          controlCall = { name, args };
          continue;
        }
        if (!allowedNames().includes(name)) throw Error();
        actions.push({ name, arguments: args });
      } catch { invalid = true; }
    }
    if (controlCall) {
      // A control call must be the whole response: mixed with real work the
      // model contradicted itself, so recovery re-asks instead of guessing.
      if (actions.length || confirm || terminal) invalid = true;
      else if (controlCall.name === 'task_complete') terminal = { status: 'complete', summary: nonEmpty(controlCall.args.summary) || display || 'Task complete.' };
      else if (controlCall.name === 'task_blocked') terminal = { status: 'blocked', reason: nonEmpty(controlCall.args.reason) || display || 'Blocked.' };
      else confirm = {
        question: nonEmpty(controlCall.args.question) || display || 'The agent needs your input.',
        options: Array.isArray(controlCall.args.options) ? controlCall.args.options.filter(o => typeof o === 'string').slice(0, 8) : [],
      };
    }
  }
  if (actions.length > 8 || (actions.length && (terminal || confirm)) || (terminal && confirm)) invalid = true;
  if (invalid) return { invalid: true, actions: [], display };
  if (!display) display = terminal?.summary || terminal?.reason || '';
  return { actions, control: terminal, confirm, display, invalid: false };
}

function extractToolBlocks(text) {
  const parsed = parseAgentResponse(text);
  return parsed.invalid ? [] : parsed.actions.map(a => ({ action: a.name, ...a.arguments }));
}

module.exports = { parseAgentResponse, extractToolBlocks };
