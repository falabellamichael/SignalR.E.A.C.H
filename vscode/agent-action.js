'use strict';

const { allowedNames, toolHelp, CORE_TOOLS } = require('./tools');
const names = allowedNames();
const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['actions', 'complete', 'question', 'blocked'] },
    message: { type: 'string' },
    actions: { type: 'array', maxItems: 8, items: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', enum: [...names, 'propose_edit'] },
        arguments: { type: 'string', description: 'A JSON object containing the tool arguments, without the action field.' },
      }, required: ['name', 'arguments'],
    } },
    options: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  }, required: ['status', 'message', 'actions', 'options'],
};
const instruction = 'EXECUTABLE ACTION RESPONSE: This request uses API-enforced JSON output. '
  + 'This response format replaces earlier fenced tool/edit/status instructions. '
  + 'Do the pending work: choose status actions and supply actual tool calls, not a promise or progress report. '
  + 'Independent reads/searches may be batched. Each action has name and arguments (a JSON-encoded object). '
  + 'Use propose_edit with path/search/replace to submit reviewable edits. Never mix edits and tool calls. '
  + 'Use complete only when the user goal is achieved and all checklist items are completed; message must contain the delivered answer. '
  + 'Use question with message and options only for necessary user input/approval; use blocked with message for a concrete external blocker. '
  + 'All terminal responses have actions: []. Options is [] unless asking a question. '
  + 'Do not infer that the task is done from earlier assistant promises. Tool results, not promises, establish completed work.\n'
  + toolHelp(['core']) + '\n'
  + ['todo_write','todo_read','edit_patch'].map(name => name + ': ' + CORE_TOOLS[name].help + ' ' + JSON.stringify(CORE_TOOLS[name].example)).join('\n') + '\n'
  + 'Example: {"status":"actions","message":"Reading the relevant files.","actions":[{"name":"read","arguments":"{\\"path\\":\\"src/main.js\\"}"}],"options":[]}';

function withInstruction(payload, text) {
  const systems = payload.messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  return { ...payload, messages: [{ role: 'system', content: systems.concat(text).join('\n\n') },
    ...payload.messages.filter(m => m.role !== 'system')] };
}

function prepare(payload, mode = 'json_schema') {
  return { ...withInstruction(payload, instruction), stream: false,
    ...(/qwen/i.test(payload.model) ? { chat_template_kwargs: { ...payload.chat_template_kwargs, enable_thinking: false } } : {}),
    response_format: mode === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: 'reach_agent_action', strict: true, schema } }
      : { type: 'json_object' },
  };
}

function decode(content) {
  let value;
  try { value = JSON.parse(content); } catch { throw new Error('The endpoint did not return the required action JSON. No action was executed.'); }
  const plain = x => x && typeof x === 'object' && !Array.isArray(x);
  const fail = detail => { throw new Error('Invalid action response: ' + detail + '. No action was executed.'); };
  if (!plain(value) || !['actions','complete','question','blocked'].includes(value.status)
      || typeof value.message !== 'string' || !Array.isArray(value.actions) || value.actions.length > 8
      || Object.keys(value).some(k => !['status','message','actions','options'].includes(k))) fail('unexpected fields');
  if (value.status === 'actions' ? !value.actions.length : value.actions.length) fail('actions and status disagree');
  if (value.status !== 'actions' && !value.message.trim()) fail('missing result or question');
  // Options are display metadata for a question, never action instructions.
  // The API schema permits them on every status; discard irrelevant options
  // instead of throwing away otherwise valid work and repeating the request.
  if (value.status !== 'question') value.options = [];
  else if (!Array.isArray(value.options) || value.options.length > 8
      || value.options.some(x => typeof x !== 'string')) fail('invalid question options');
  const tools = [], edits = [];
  for (const item of value.actions) {
    if (!plain(item) || ![...names,'propose_edit'].includes(item.name) || typeof item.arguments !== 'string'
        || Object.keys(item).some(k => !['name','arguments'].includes(k))) fail('unknown action');
    let args;
    try { args = JSON.parse(item.arguments); } catch { fail('arguments must be a JSON object'); }
    if (!plain(args) || Object.keys(args).some(k => ['__proto__','constructor','prototype','action','uid','type','result'].includes(k))) fail('invalid arguments');
    if (item.name === 'propose_edit') {
      if (!['path','search','replace'].every(k => typeof args[k] === 'string') || !args.path.trim()) fail('invalid edit');
      edits.push({path: args.path.replace(/\\/g, '/'), search: args.search, replace: args.replace});
    } else {
      // Required fields for common actions. Detailed validation and approvals
      // stay in the existing executor; this path never bypasses those checks.
      const field = {read:'path',glob:'pattern',search:'pattern',shell:'command',browse:'url',websearch:'query',tool_help:'topic'}[item.name];
      if (field && !(typeof args[field] === 'string' && args[field].trim())) fail('missing ' + field);
      if (item.name === 'todo_write' && !Array.isArray(args.todos)) fail('missing todos');
      tools.push({...args, action:item.name});
    }
  }
  if (tools.length && edits.length) fail('mixed tools and pending edits');
  return { message:value.message, tools, edits,
    control: value.status === 'complete' ? {status:'complete',summary:value.message}
      : value.status === 'blocked' ? {status:'blocked',reason:value.message} : null,
    confirm: value.status === 'question' ? {question:value.message,options:value.options} : null,
    context: JSON.stringify(value),
  };
}

module.exports = { schema, instruction, withInstruction, prepare, decode };
