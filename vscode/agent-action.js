'use strict';

const { allowedNames, TOOLS } = require('./tools');
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
        arguments: { type: 'object', additionalProperties: true, description: 'The tool arguments, without the action field.' },
      }, required: ['name', 'arguments'],
    } },
    options: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  }, required: ['status', 'message', 'actions', 'options'],
};
function actionInstruction() {
  const call = (name, args) => ({name, arguments:args});
  const examples = Object.entries(TOOLS).filter(([,tool]) => tool.tier !== 'browser').map(([name, tool]) => {
    const {action, ...args} = tool.example;
    return name + ': ' + tool.help + '\n' + JSON.stringify(call(name, args));
  });
  return 'EXECUTABLE ACTION RESPONSE: Return exactly one JSON object, without prose outside it. '
  + 'This response format replaces earlier fenced tool/edit/status instructions. '
  + 'Do the pending work: choose status actions and supply actual tool calls, not a promise or progress report. '
  + 'Independent reads/searches may be batched. Each action has name and arguments (a direct JSON object, not a string). '
  + 'Do not put action inside arguments. '
  + 'Use propose_edit with path/search/replace to submit reviewable edits. Never mix edits and tool calls. '
  + 'Use complete only when the user goal is achieved and all checklist items are completed; message must contain the delivered answer. '
  + 'Use question with message and options only for necessary user input/approval; use blocked with message for a concrete external blocker. '
  + 'All terminal responses have actions: []. Options is [] unless asking a question. '
  + 'Use only the fields status, message, actions and options. Supply at most 8 actions per response; continue with the next batch after results. '
  + 'Do not infer that the task is done from earlier assistant promises. Tool results, not promises, establish completed work.\n'
  + examples.join('\n') + '\n'
  + 'Use tool_help to request browser tool details.\n'
  + 'Example: ' + JSON.stringify({status:'actions',message:'Reading the relevant files.',
    actions:[call('read', {path:'src/main.js'})],options:[]}) + '\n'
  + 'Completion: ' + JSON.stringify({status:'complete',message:'Delivered the requested result and verified it.',actions:[],options:[]}) + '\n'
  + 'Question: ' + JSON.stringify({status:'question',message:'Which directory should I use?',actions:[],options:['A','B']}) + '\n'
  + 'Blocker: ' + JSON.stringify({status:'blocked',message:'The server is unavailable; restore access to continue.',actions:[],options:[]});
}
const instruction = actionInstruction();

function withInstruction(payload, text) {
  const systems = payload.messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  return { ...payload, messages: [{ role: 'system', content: systems.concat(text).join('\n\n') },
    ...payload.messages.filter(m => m.role !== 'system')] };
}

function prepare(payload, mode = 'json_schema') {
  const prepared = { ...withInstruction(payload, instruction), stream: false,
    ...(/qwen/i.test(payload.model) ? { chat_template_kwargs: { ...payload.chat_template_kwargs, enable_thinking: false } } : {}),
    response_format: mode === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: 'reach_agent_action', strict: true, schema } }
      : { type: 'json_object' },
  };
  return mode === 'json_schema' ? prepared : useObjectArguments(prepared, mode);
}

function useObjectArguments(payload, mode = 'json_object') {
  // Some strict schema implementations reject extensible argument objects.
  // Keep the same direct-object contract with local validation in that case.
  // Replace our contract instead of stacking repeated examples on each retry.
  const messages = payload.messages.map(m => m.role === 'system' && typeof m.content === 'string'
    ? { ...m, content: m.content.split(instruction).join('') } : m);
  const result = { ...withInstruction({ ...payload, messages }, instruction),
    stream: false, response_format: { type: 'json_object' } };
  if (mode === 'text') delete result.response_format;
  return result;
}

function decode(content) {
  let value;
  // Only a complete JSON document or a single enclosing JSON fence is data.
  // Never search prose, reasoning, or examples for something executable.
  const text = typeof content === 'string' ? content.trim() : '';
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  try { value = JSON.parse(fenced ? fenced[1] : text); } catch { throw new Error('The endpoint did not return the required action JSON. No action was executed.'); }
  const plain = x => x && typeof x === 'object' && !Array.isArray(x);
  const fail = detail => { throw new Error('Invalid action response: ' + detail + '. No action was executed.'); };
  if (!plain(value)) fail('expected an object with status, message, actions and options');
  if (value.tool_calls !== undefined && value.actions === undefined
      && (value.status === undefined || String(value.status).trim().toLowerCase() === 'actions')) {
    const {tool_calls, ...rest} = value;
    value = {...rest, actions:tool_calls};
  }
  const dangerous = ['__proto__','constructor','prototype'];
  const carriers = ['tools','edits','tool_calls','function_call','action','command','arguments'];
  if (Object.keys(value).some(k => dangerous.includes(k) || carriers.includes(k))) fail('conflicting action fields; use only actions for executable work');
  const status = typeof value.status === 'string' ? value.status.trim().toLowerCase()
    : value.status === undefined && Array.isArray(value.actions) && value.actions.length ? 'actions' : '';
  if (!['actions','complete','question','blocked'].includes(status)) fail('status must be actions, complete, question or blocked');
  const aliases = {complete:['summary','answer','result'],question:['question'],blocked:['reason']}[status] || [];
  const message = value.message ?? aliases.map(k => value[k]).find(v => v !== undefined) ?? '';
  if (typeof message !== 'string') fail('message must be a string');
  // Metadata does not authorize execution. Copy only the fields we actually
  // consume, so provider-added notes/reasoning never reach the tool executor.
  value = {status, message, actions:value.actions ?? (status === 'actions' ? undefined : []), options:value.options};
  if (plain(value.actions) && (value.actions.name || value.actions.action || value.actions.function)) value.actions = [value.actions];
  if (!Array.isArray(value.actions)) fail('actions must be an array');
  if (value.actions.length > 8) fail('at most 8 actions are allowed; split the work into batches');
  if (value.status === 'actions' ? !value.actions.length : value.actions.length) fail('actions and status disagree');
  if (value.status !== 'actions' && !value.message.trim()) fail('missing result or question');
  // Options are display metadata for a question, never action instructions.
  // The API schema permits them on every status; discard irrelevant options
  // instead of throwing away otherwise valid work and repeating the request.
  if (value.status !== 'question') value.options = [];
  else if (value.options == null) value.options = [];
  else if (!Array.isArray(value.options) || value.options.length > 8
      || value.options.some(x => typeof x !== 'string')) fail('invalid question options');
  const tools = [], edits = [];
  for (let index = 0; index < value.actions.length; index++) {
    let item = value.actions[index];
    if (!plain(item)) fail('action ' + (index + 1) + ' must be an object');
    if (Object.keys(item).some(k => dangerous.includes(k))) fail('invalid action fields');
    if (item.function !== undefined) {
      if ((item.type !== undefined && item.type !== 'function') || !plain(item.function)
          || ['name','arguments','action','command'].some(k => k in item)) fail('conflicting function action');
      item = item.function;
    } else if (item.action !== undefined) {
      if (['arguments','function','parameters'].some(k => k in item)) fail('conflicting legacy action');
      const {action, ...args} = item;
      item = {name:action, arguments:args};
    }
    if (![...names,'propose_edit'].includes(item.name)) fail('unknown action name at index ' + (index + 1));
    if (['action','function','tool_calls','command','parameters',...dangerous].some(k => Object.hasOwn(item, k))) fail('conflicting action fields');
    let args = item.arguments;
    // Providers may return an object, encoded JSON, or double-encoded JSON.
    // Decode only valid JSON, with a fixed bound; never guess at broken escapes
    // or rewrite command/edit text to make it executable.
    for (let depth = 0; typeof args === 'string' && depth < 2; depth++) {
      try { args = JSON.parse(args); } catch { fail('arguments must be a JSON object'); }
    }
    if (!plain(args) || Object.keys(args).some(k => ['__proto__','constructor','prototype','action','uid','type','result'].includes(k))) fail('invalid arguments');
    value.actions[index] = {name:item.name, arguments:args};
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

function decodeReply(reply) {
  if (reply.error) throw new Error(reply.error);
  if (reply.finishReason === 'length') throw new Error('The action response reached the output token limit. No action was executed. Request fewer or smaller actions.');
  if (reply.finishReason === 'content_filter') throw new Error('The provider filtered the action response. No action was executed.');
  if (reply.toolCalls) {
    if (!Array.isArray(reply.nativeActions) || !reply.nativeActions.length) throw new Error('The endpoint returned incomplete native tool calls. No action was executed.');
    // Native calls are already separate from prose. Never also parse content
    // into a second executable batch or infer completion from that prose.
    return decode(JSON.stringify({status:'actions',message:reply.content || '',actions:reply.nativeActions,options:[]}));
  }
  return decode(reply.content);
}

module.exports = { schema, instruction, withInstruction, prepare, useObjectArguments, decode, decodeReply };
