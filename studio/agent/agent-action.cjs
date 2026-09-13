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

function actionInstruction({ includeCollab = false } = {}) {
  const call = (name, args) => ({name, arguments:args});
  const visible = Object.entries(TOOLS).filter(([,tool]) =>
    tool.tier !== 'browser' && (includeCollab || tool.tier !== 'collab'));
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
  + 'Use tool_help to request browser tool details.\n'
  + 'Example: ' + JSON.stringify({status:'actions',message:'Reading the relevant files.',
    actions:[call('read', {path:'index.rsh'})],options:[]}) + '\n'
  + 'Schema: ' + JSON.stringify(promptSchema);
}

/* Parse a structured action response. Returns { actions, message, status }
 * or { error }. Accepts only the exact JSON object, no surrounding prose. */
function parseActionResponse(text) {
  let value;
  try {
    value = JSON.parse(String(text || '').trim());
  } catch {
    return { error: 'The response was not valid JSON.' };
  }
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
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a || typeof a !== 'object') return { error: `Action ${i + 1} is not an object.` };
    if (!names.includes(a.name)) return { error: `Action ${i + 1} has an unknown tool name: ${a.name}` };
    if (!a.arguments || typeof a.arguments !== 'object' || Array.isArray(a.arguments) || 'action' in a.arguments) {
      return { error: `Action ${i + 1} arguments must be an object.` };
    }
  }
  return { status, message, actions, options };
}

module.exports = { schema, actionInstruction, parseActionResponse };
