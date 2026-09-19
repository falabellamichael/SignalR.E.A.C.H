'use strict';

/* Reach Studio — structured action response codec, ported from the VS Code
 * extension's agent-action.js. When the run state says structuredActions,
 * the model is asked for exactly one JSON object naming the next tool calls.
 */

const { allowedNames, TOOLS } = require('./tool-registry.cjs');
const names = allowedNames();

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['actions', 'complete', 'question', 'blocked'] },
    message: { type: 'string' },
    actions: { type: 'array', maxItems: 8, items: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', enum: names },
        arguments: { type: 'object', additionalProperties: true, description: 'The tool arguments, without the action field.' },
      }, required: ['name', 'arguments'],
    } },
    options: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  }, required: ['status', 'message', 'actions', 'options'],
};

function actionInstruction({ includeCollab = false, disabled = [] } = {}) {
  const call = (name, args) => ({name, arguments:args});
  const visible = Object.entries(TOOLS).filter(([name,tool]) =>
    !disabled.includes(name) && tool.tier !== 'browser' && (includeCollab || tool.tier !== 'collab'));
  const examples = visible.map(([name, tool]) => {
    const {action, ...args} = tool.example;
    return name + ': ' + tool.help + '\n' + JSON.stringify(call(name, args));
  });
  // The advertised schema enum must match the examples: showing agent.spawn
  // to a solo agent invites calls that can only fail (no crew net).
  const promptSchema = {
    ...schema,
    properties: {
      ...schema.properties,
      actions: {
        ...schema.properties.actions,
        items: {
          ...schema.properties.actions.items,
          properties: {
            ...schema.properties.actions.items.properties,
            name: { type: 'string', enum: visible.map(([name]) => name) },
          },
        },
      },
    },
  };
  const crew = includeCollab
    ? 'You are one agent in a crew that can collaborate at runtime. Use agent.spawn to delegate parallel work to a background worker, '
      + 'agent.send to coordinate with a peer, agent.status / agent.list to see what the crew is doing, agent.transcript to read a peer\'s reasoning, '
      + 'and agent.await when you need a peer\'s result before continuing. Prefer delegating genuinely parallel work over doing everything yourself, '
      + 'but stay accountable for the final answer. Do not spawn an agent for work you can finish in one or two tool calls.\n'
    : '';
  return 'EXECUTABLE ACTION RESPONSE: Return exactly one JSON object, without prose outside it. '
  + 'This response format replaces earlier fenced tool/edit/status instructions. '
  + crew
  + 'Do the pending work: choose status actions and supply actual tool calls, not a promise or progress report. '
  + 'Independent reads/searches may be batched. Each action has name and arguments (a direct JSON object, not a string). '
  + 'Do not put action inside arguments. '
  + 'Use edit_patch with path and hunks to submit reviewable edits. '
  + 'Use complete only when the user goal is achieved and all checklist items are completed; message must contain the delivered answer. '
  + 'Use question with message and options only for necessary user input/approval; use blocked with message for a concrete external blocker. '
  + 'All terminal responses have actions: []. Options is [] unless asking a question. '
  + 'Use only the fields status, message, actions and options. Supply at most 8 actions per response; continue with the next batch after results. '
  + 'Do not infer that the task is done from earlier assistant promises. Tool results, not promises, establish completed work.\n'
  + examples.join('\n') + '\n'
  + (visible.some(([name]) => name === 'tool_help') ? 'Use tool_help to request details for enabled tool suites.\n' : '')
  + 'Schema: ' + JSON.stringify(promptSchema);
}

/* Balanced top-level object scan — candidates in document order. Recovery
 * only: some models prepend a status line to the exact contract JSON
 * (deepseek-flash via api.deepseek.com did it mid-Links on 2026-09-19), and
 * pausing the run over a prose prefix helps nobody. Nested objects are not
 * separate candidates; a malformed outer span simply yields none. */
function extractObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { if (--depth === 0) { end = j; break; } }
    }
    if (end < 0) break;
    try {
      const v = JSON.parse(text.slice(i, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
    } catch { /* not JSON — keep scanning */ }
    i = end;
  }
  return out;
}

function validateStructured(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return { error: 'The response was not a single JSON object.' };
  }
  const status = value.status;
  if (!['actions', 'complete', 'question', 'blocked'].includes(status)) {
    return { error: 'status must be one of: actions, complete, question, blocked.' };
  }
  const message = typeof value.message === 'string' ? value.message : '';
  const actions = Array.isArray(value.actions) ? value.actions : [];
  const options = Array.isArray(value.options) ? value.options : [];
  if (!message.trim()) return { error: 'message must explain the next action or delivered answer.' };
  if (status === 'actions' && !actions.length) return { error: 'actions status requires at least one tool call.' };
  if (status !== 'actions' && actions.length) return { error: 'Terminal responses cannot contain actions.' };
  if (options.some(o => typeof o !== 'string') || options.length > 8) return { error: 'options must contain at most eight strings.' };
  if (actions.length > 8) return { error: 'At most 8 actions are allowed per response.' };
  const normalized = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a || typeof a !== 'object') return { error: `Action ${i + 1} is not an object.` };
    if (!names.includes(a.name)) return { error: `Action ${i + 1} has an unknown tool name: ${a.name}` };
    let args = a.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return { error: `Action ${i + 1} arguments must be an object.` }; }
    }
    if (args === undefined || args === null) args = {};
    if (typeof args !== 'object' || Array.isArray(args) || 'action' in args) {
      return { error: `Action ${i + 1} arguments must be an object.` };
    }
    normalized.push({ name: a.name, arguments: args });
  }
  return { status, message, actions: normalized, options };
}

/* Parse a structured action response. Returns { actions, message, status }
 * or { error }. The exact contract JSON wins; when a model wraps it in prose,
 * the last balanced object that fully validates is recovered instead. */
function parseActionResponse(text) {
  const raw = String(text || '').trim();
  let direct = null;
  try { direct = JSON.parse(raw); } catch { /* prose-wrapped or not JSON */ }
  const first = direct ? validateStructured(direct) : null;
  if (first && !first.error) return first;
  let recovered = null;
  for (const candidate of extractObjects(raw)) {
    const res = validateStructured(candidate);
    if (!res.error) recovered = res;
  }
  if (recovered) return recovered;
  return first || { error: 'The response was not valid JSON.' };
}

/* ---------- native (OpenAI) tool-calling contract ----------
 *
 * Teams may run members on the native protocol instead of the JSON contract:
 * the request advertises real OpenAI `tools`, the endpoint's tool_calls come
 * back through chat-response.cjs, and agent-response.cjs executes them. The
 * two contracts are generated from the SAME registry, so they cannot drift.
 */

/* Synthetic control tools, advertised ONLY on the native protocol. They are
 * never executed by the tool runner: agent-response.cjs converts them into the
 * exact terminal states the JSON contract's status field produces
 * (complete / blocked / question). */
const CONTROL_TOOLS = [
  { name: 'task_complete',
    description: 'Call when the whole task is finished and verified against tool results. Put the definitive final answer for the user in summary. Do not write the final answer as plain prose instead.',
    parameters: { type: 'object', properties: { summary: { type: 'string', description: 'The complete final answer / delivered work summary.' } }, required: ['summary'], additionalProperties: false } },
  { name: 'task_blocked',
    description: 'Call when a concrete external blocker prevents progress: missing credentials, an unavailable service, or information only the user has.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'What is blocked and exactly what is needed to unblock it.' } }, required: ['reason'], additionalProperties: false } },
  { name: 'ask_user',
    description: 'Call only when you need the user to choose something before you can continue.',
    parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'], additionalProperties: true } },
];
const CONTROL_NAMES = CONTROL_TOOLS.map(t => t.name);

function jsonType(value) {
  if (Array.isArray(value)) return { type: 'array', items: { type: 'string' } };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (value && typeof value === 'object') return { type: 'object', additionalProperties: true };
  return { type: 'string' };
}

/* OpenAI function definitions derived from the tool registry. Descriptions
 * come from the tool help line; parameter shapes are inferred from each
 * tool's example arguments, with `additionalProperties: true` because the
 * examples are not exhaustive (the tool runner still validates). */
function toolDefs({ includeCollab = false, disabled = [] } = {}) {
  const defs = [];
  for (const [name, tool] of Object.entries(TOOLS)) {
    if (disabled.includes(name) || tool.tier === 'browser') continue;
    if (!includeCollab && tool.tier === 'collab') continue;
    const { action, ...example } = tool.example || {};
    const properties = {};
    for (const [key, value] of Object.entries(example)) properties[key] = jsonType(value);
    defs.push({ type: 'function', function: {
      name,
      description: String(tool.help || '').trim(),
      parameters: { type: 'object', properties, additionalProperties: true },
    } });
  }
  return defs.concat(CONTROL_TOOLS.map(t => ({ type: 'function', function: t })));
}

/* The native-mode counterpart of actionInstruction(). */
function nativeInstruction({ includeCollab = false, disabled = [] } = {}) {
  const visible = toolDefs({ includeCollab, disabled }).map(d => d.function.name);
  const crew = includeCollab
    ? 'You are one agent in a crew with live collaboration tools (agent.spawn, agent.send, agent.status, agent.list, agent.transcript, agent.await, agent.reflect): coordinate with peers directly, prefer delegating genuinely parallel work, and stay accountable for the final answer.\n'
    : '';
  return 'NATIVE TOOL CALLS: call the provided tools directly with real arguments — the endpoint executes them. '
  + 'Never emit fenced tool blocks or JSON action objects, and never report work you have not done. '
  + 'Independent reads/searches may be batched in one turn. Use edit_patch with path and hunks for reviewable edits. '
  + 'Call ask_user only for necessary user input; task_blocked for a concrete external blocker; '
  + 'call task_complete with the full delivered answer in summary ONLY when the work is finished and verified. '
  + 'Tool results, not promises, establish completed work.\n'
  + crew
  + 'Available tools: ' + visible.join(', ') + '.';
}

module.exports = { schema, actionInstruction, parseActionResponse, CONTROL_NAMES, CONTROL_TOOLS, toolDefs, nativeInstruction };
