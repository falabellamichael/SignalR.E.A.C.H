import { createHash, randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { MAX_STREAM_BYTES, replayBody, streamRecord } from './stream-replay.mjs';
import { modelUsdPricing, requestReplay } from './store.mjs';
import { gpuBridge, hostedGpuModel, requestCapabilities, strataQwen } from './gpu-bridge.mjs';
import { compatibleGemmaTools } from './gemma-tools.mjs';
import { codegptDirect } from './codegpt-direct.mjs';

// Transport guard, independent of model context and application budgets.
const MAX_BODY = 16 * 1024 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_EVENT = 256 * 1024;
const FIELDS = new Set(['model', 'messages', 'stream', 'stream_options', 'max_tokens',
  'max_completion_tokens', 'temperature', 'top_p', 'stop', 'presence_penalty',
  'frequency_penalty', 'seed', 'n', 'tools', 'tool_choice', 'parallel_tool_calls',
  'response_format']);
const REQUEST_FIELDS = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens']);
const GPU_REQUEST_FIELDS = new Set([...REQUEST_FIELDS, 'tools', 'tool_choice', 'parallel_tool_calls']);

function inferenceRequest(body, routes, operation) {
  if (!plain(body) || Buffer.byteLength(JSON.stringify(body)) > MAX_BODY)
    fail(400, 'invalid_request', 'Invalid model request.');
  const route = routes.get(body.model);
  if (!route || route.metered !== true) fail(404, 'model_unavailable', 'This model is not available.');
  if (route.access !== 'requests' || gpuBridge(route.bridge)?.operation !== operation)
    fail(400, 'model_operation_mismatch', 'Choose a model that supports this endpoint.');
  const fields = operation === 'embeddings' ? ['model', 'input', 'encoding_format', 'dimensions']
    : ['model', 'query', 'documents', 'top_n', 'return_documents'];
  if (Object.keys(body).some(key => !fields.includes(key))) fail(400, 'unsupported_field', 'Unsupported model request fields.');
  const text = value => typeof value === 'string' && !!value.trim();
  let payload;
  if (operation === 'embeddings') {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    if (!inputs.length || inputs.length > 32 || !inputs.every(text))
      fail(400, 'invalid_input', 'Supply one text or between 1 and 32 nonempty texts.');
    if (body.encoding_format !== undefined && !['float', 'base64'].includes(body.encoding_format))
      fail(400, 'invalid_parameter', 'encoding_format must be float or base64.');
    if (body.dimensions !== undefined && body.dimensions !== 1024)
      fail(400, 'invalid_parameter', 'BGE M3 produces 1024 dimensions.');
    payload = { model: route.bridge.model, input: body.input, encoding_format: body.encoding_format ?? 'float' };
  } else {
    if (!text(body.query) || !Array.isArray(body.documents) || !body.documents.length
      || body.documents.length > 32 || !body.documents.every(text))
      fail(400, 'invalid_input', 'Supply a query and between 1 and 32 nonempty text documents.');
    if (body.top_n !== undefined && !integer(body.top_n, 1, body.documents.length))
      fail(400, 'invalid_parameter', 'top_n must be between 1 and the document count.');
    if (body.return_documents !== undefined && typeof body.return_documents !== 'boolean')
      fail(400, 'invalid_parameter', 'return_documents must be true or false.');
    payload = { model: route.bridge.model, query: body.query, documents: body.documents,
      top_n: body.top_n ?? body.documents.length, return_documents: body.return_documents ?? false };
  }
  if (route.maxInputBytes !== undefined && Buffer.byteLength(JSON.stringify(payload)) > route.maxInputBytes)
    fail(400, 'input_too_large', 'Input exceeds this model’s configured size limit.');
  return { payload, route, fingerprint: createHash('sha256').update(canonical({ operation, payload, model: route.id })).digest('hex') };
}

export class GatewayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new GatewayError(status, code, message); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function decisionRequest(body, routes) {
  if (!plain(body) || Object.keys(body).some(k => !['model', 'state', 'questions'].includes(k)))
    fail(400, 'invalid_decision', 'Provide model, state and questions.');
  const route = routes.get(body.model);
  if (!route || !gpuBridge(route.bridge)?.decision || route.metered !== true)
    fail(400, 'invalid_model', 'Choose an available decision model.');
  if (!Object.hasOwn(body, 'state') || !plain(body.questions) || !Object.keys(body.questions).length
    || Object.keys(body.questions).length > 32 || JSON.stringify(body.state).length > 32768
    || JSON.stringify(body.questions).length > 32768) fail(400, 'invalid_decision', 'Invalid decision state or questions.');
  for (const q of Object.values(body.questions)) {
    if (!plain(q) || !['noul', 'choice', 'score'].includes(q.type) || typeof q.instructions !== 'string'
      || !q.instructions.trim() || (q.type === 'choice' && (!plain(q.criteria) || Object.keys(q.criteria).length < 2))
      || (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)))
      fail(400, 'invalid_decision', 'Questions require a type, instructions and appropriate criteria.');
  }
  const payload = { ...body, model: route.bridge.model };
  return { payload, route, fingerprint: createHash('sha256').update(canonical(body)).digest('hex') };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function providerUsage(value) {
  if (!plain(value) || value.usage_source !== 'provider' || !plain(value.usage)) return null;
  const u = value.usage;
  if (![u.prompt_tokens, u.completion_tokens, u.total_tokens].every(n => integer(n, 0, 1_000_000_000))
    || u.total_tokens !== u.prompt_tokens + u.completion_tokens) return null;
  // Cached input and reasoning are subsets, not extra charges on top of totals.
  for (const [key, part] of [['prompt_tokens_details', u.prompt_tokens], ['completion_tokens_details', u.completion_tokens]]) {
    if (u[key] !== undefined && !plain(u[key])) return null;
    if (u[key] && Object.values(u[key]).some(n => !integer(n, 0, part))) return null;
  }
  return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens, source: 'provider',
    details: { prompt: u.prompt_tokens_details ?? {}, completion: u.completion_tokens_details ?? {} } };
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    fail(415, 'content_type', 'Use application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'request_too_large', 'Request exceeds the service size limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'invalid_json', 'Request body must be valid JSON.'); }
}

function responseJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function errorBody(error) {
  const safe = error instanceof GatewayError || (integer(error?.status, 400, 499) && /^[a-z_]{1,80}$/.test(error?.code));
  return { error: { code: safe ? error.code : 'gateway_error',
    message: safe ? error.message : 'The model request could not be completed.', type: 'reach_service_error',
    ...(error instanceof GatewayError && integer(error.maxInputBytes, 1, MAX_BODY)
      ? { max_input_bytes: error.maxInputBytes, input_limit_scope: error.inputLimitScope } : {}) } };
}
async function boundedText(response, limit = MAX_RESPONSE) {
  if (!response.body) fail(502, 'empty_response', 'The model provider returned no response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail(502, 'response_too_large', 'The model response exceeded the service size limit.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

function configureModels(models) {
  if (!Array.isArray(models)) throw new Error('Gateway models must be an array.');
  const routes = new Map();
  for (const model of models) {
    if (plain(model) && model.access === 'requests') {
      const bridge = model.bridge;
      const validModel = plain(bridge) && (bridge.kind === 'tray'
        ? ['copilot-chat', 'chatgpt-chat', 'gemini-chat'].includes(bridge.model)
          || (/^codegpt-eco-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(bridge.model)
            && bridge.model !== 'codegpt-eco-gpt-4o-mini')
        : bridge.kind === 'codegpt' && /^codegpt-(?!eco(?:-|$))[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(bridge.model));
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model.id) || routes.has(model.id)
        || typeof model.provider !== 'string' || model.provider.length > 100
        || (model.maxInputBytes !== undefined && !integer(model.maxInputBytes, 1, MAX_BODY)) || (!validModel && !gpuBridge(bridge) && !codegptDirect(bridge))
        || Object.keys(bridge).some(key => !['kind', 'model'].includes(key))
        || model.pricing !== undefined || model.upstreamModel !== undefined) {
        throw new Error('Invalid subscription bridge model configuration.');
      }
      if (gpuBridge(bridge) && model.maxOutputTokens !== undefined && !integer(model.maxOutputTokens, 1, 1_000_000)) {
        throw new Error('GPU output limit must be between 1 and 1000000.');
      }
      if (hostedGpuModel(model)) routes.set(model.id, Object.freeze({ ...model, bridge: Object.freeze({ ...bridge }) }));
      continue;
    }
    if (model.pricing !== undefined && !modelUsdPricing(model)) throw new Error('Invalid USD model pricing.');
    if (!plain(model) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model.id)
      || routes.has(model.id) || typeof model.provider !== 'string' || model.provider.length > 100
      || !integer(model.maxInputTokens, 1, 10_000_000)
      || !integer(model.maxInputBytes, 1, MAX_BODY) || !integer(model.maxOutputTokens, 1, 1_000_000)
      || (model.upstreamModel !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model.upstreamModel))) {
      throw new Error('Invalid hosted model configuration.');
    }
    if (hostedGpuModel(model)) routes.set(model.id, Object.freeze({ ...model }));
  }
  return routes;
}

function completionRequest(body, routes) {
  if (!plain(body) || Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) fail(400, 'invalid_request', 'Invalid completion request.');
  const route = routes.get(body.model);
  const omni = route?.access === 'requests' && route.bridge.model === 'LiquidAI/LFM3-Omni-2B';
  const unsupported = Object.keys(body).filter(k => !FIELDS.has(k) && !(omni && k === 'reasoning_effort'));
  if (unsupported.length) fail(400, 'unsupported_field', `This request includes unsupported field${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`);
  if (!route || route.metered !== true) fail(404, 'model_unavailable', 'This model is not available for metered access.');
  if (route.access === 'requests') return gpuRequest(body, route);
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 100) {
    fail(400, 'invalid_messages', 'Supply between 1 and 100 messages.');
  }
  for (const message of body.messages) {
    if (!plain(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
      || (typeof message.content !== 'string' && !(message.role === 'assistant' && message.content === null && Array.isArray(message.tool_calls)))) {
      fail(400, 'text_only', 'Metered models currently accept text messages and tool calls only.');
    }
    if (Object.keys(message).some(k => !['role', 'content', 'name', 'tool_calls', 'tool_call_id'].includes(k))) {
      fail(400, 'invalid_messages', 'Unsupported message fields.');
    }
  }
  if (Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools, response_format: body.response_format })) > route.maxInputBytes) {
    fail(400, 'input_too_large', 'Input exceeds this model’s configured size limit.');
  }
  if (body.n !== undefined && body.n !== 1) fail(400, 'single_generation', 'Only one generation per request is supported.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail(400, 'invalid_stream', 'stream must be true or false.');
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) fail(400, 'output_limit', 'Set only one output token limit.');
  const output = body.max_completion_tokens ?? body.max_tokens ?? route.maxOutputTokens;
  if (!integer(output, 1, route.maxOutputTokens)) fail(400, 'output_limit', `Output limit must be between 1 and ${route.maxOutputTokens}.`);
  for (const [key, low, high] of [['temperature', 0, 2], ['top_p', 0, 1], ['presence_penalty', -2, 2], ['frequency_penalty', -2, 2]]) {
    if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < low || body[key] > high)) {
      fail(400, 'invalid_parameter', `Invalid ${key}.`);
    }
  }
  if (body.seed !== undefined && !Number.isSafeInteger(body.seed)) fail(400, 'invalid_parameter', 'Invalid seed.');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') fail(400, 'invalid_parameter', 'Invalid parallel_tool_calls.');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 32)) fail(400, 'invalid_tools', 'Supply at most 32 tools.');
  if (body.stream_options !== undefined && (!plain(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage'))) {
    fail(400, 'invalid_stream_options', 'Only include_usage is supported.');
  }
  const payload = { ...body, model: route.upstreamModel || route.id, n: 1, stream: body.stream === true };
  const outputField = body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
  payload[outputField] = output;
  if (payload.stream) payload.stream_options = { include_usage: true };
  else delete payload.stream_options;
  // Reserve the provider's operator-configured hard input ceiling. We do not
  // manufacture an input token count from characters; final billing uses usage.
  return { payload, route, amount: route.maxInputTokens + output, reserveUsage:{promptTokens:route.maxInputTokens,completionTokens:output},
    fingerprint: createHash('sha256').update(canonical({ ...payload, model: route.id })).digest('hex') };
}

function gpuRequest(body, route) {
  const { response_format: format, ...textBody } = body;
  if (route.bridge.model === 'LiquidAI/LFM3-Omni-2B') {
    // Omni runs without reasoning. Clients may retain another model's private
    // reasoning metadata in history; keep visible content and native tool data.
    if (Object.hasOwn(textBody, 'reasoning_effort')) {
      if (textBody.reasoning_effort !== 'none')
        fail(400, 'invalid_parameter', 'Omni runs without reasoning; reasoning_effort must be none.');
      delete textBody.reasoning_effort;
    }
    if (Array.isArray(textBody.messages)) textBody.messages = textBody.messages.map(message => {
      if (!plain(message) || message.role !== 'assistant') return message;
      for (const field of ['reasoning', 'reasoning_content']) {
        if (message[field] != null && typeof message[field] !== 'string')
          fail(400, 'invalid_messages', 'Assistant reasoning metadata must be text or null.');
      }
      const { reasoning, reasoning_content, ...visible } = message;
      return visible;
    });
  }
  // SimpleRAG sends sampling controls in its OpenAI-compatible requests.
  // The native Qwen and Omni Strata routes implement these controls.
  const sampling = {};
  if (strataQwen(route.bridge.model) || route.bridge.model === 'LiquidAI/LFM3-Omni-2B') {
    if (Object.hasOwn(textBody, 'stream_options')) {
      const options = textBody.stream_options;
      if (!plain(options) || Object.keys(options).some(key => key !== 'include_usage')
        || (Object.hasOwn(options, 'include_usage') && typeof options.include_usage !== 'boolean'))
        fail(400, 'invalid_stream_options', 'Only include_usage is supported.');
      delete textBody.stream_options;
    }
    for (const [field, min, max] of [['temperature', 0, 2], ['top_p', 0, 1],
      ['frequency_penalty', -2, 2], ['presence_penalty', -2, 2]]) {
      if (!Object.hasOwn(textBody, field)) continue;
      const value = textBody[field];
      if (!Number.isFinite(value) || value < min || value > max)
        fail(400, 'invalid_parameter', `Invalid ${field}.`);
      sampling[field] = value;
      delete textBody[field];
    }
  }
  const result = bridgeRequest(textBody, route);
  if (Object.keys(sampling).length) {
    result.fingerprint = createHash('sha256').update(result.fingerprint).update(canonical(sampling)).digest('hex');
  }
  // No product ceiling: vLLM reserves the available context after tokenizing
  // the actual prompt. Explicit client and operator limits remain supported.
  const output = body.max_completion_tokens ?? body.max_tokens ?? route.maxOutputTokens;
  if (output !== undefined && !integer(output, 1, route.maxOutputTokens ?? 1_000_000)) {
    fail(400, 'output_limit', `Output limit must be between 1 and ${route.maxOutputTokens ?? 1_000_000}.`);
  }
  // Keep the client's stream preference in replay identity. Request billing
  // already buffers the verified final answer before settlement and delivery.
  const generation = gpuBridge(route.bridge).generation;
  result.payload = { ...result.payload, ...(output === undefined ? {} : { max_tokens: output }),
    ...generation, ...sampling };
  if (route.bridge.model === 'google/gemma-4-12B-it-qat-q4_0-unquantized' && result.payload.tools !== undefined) {
    result.payload.tools = compatibleGemmaTools(result.payload.tools);
  }
  // A hidden thinking trace is generated before message content. Action calls
  // need that content to be the JSON object, so those requests answer directly.
  const actionReply = format !== undefined || result.payload.messages.some(message => message.role === 'system'
    && message.content.includes('EXECUTABLE ACTION RESPONSE:'));
  if (actionReply) result.payload.chat_template_kwargs = { ...generation.chat_template_kwargs, enable_thinking: false };
  if (strataQwen(route.bridge.model) && result.payload.chat_template_kwargs?.enable_thinking && output > 1) {
    // The output cap includes reasoning; leave room for the visible answer.
    result.payload.reasoning_budget_tokens = Math.floor(output / 2);
  }
  if (route.bridge.model === 'LiquidAI/LFM3-VL-2B'
      && result.payload.chat_template_kwargs?.enable_thinking && output !== undefined) {
    // Keep thinking enabled while reserving half the output allowance for content.
    result.payload.thinking_token_budget = Math.floor(output / 2);
  }
  if (format !== undefined) {
    const jsonObject = plain(format) && format.type === 'json_object' && Object.keys(format).length === 1;
    if (!jsonObject) {
      if (!plain(format) || format.type !== 'json_schema' || Object.keys(format).some(k => !['type', 'json_schema'].includes(k))
        || !plain(format.json_schema) || typeof format.json_schema.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(format.json_schema.name)
        || !plain(format.json_schema.schema) || Object.keys(format.json_schema).some(k => !['name', 'schema', 'strict'].includes(k))
        || format.json_schema.strict !== undefined && typeof format.json_schema.strict !== 'boolean'
        || Buffer.byteLength(JSON.stringify(format)) > 16384) fail(400, 'invalid_response_format', 'Supply a bounded JSON schema response format.');
      const pending = [format.json_schema.schema];
      while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== 'object') continue;
        if (Object.hasOwn(node, '$ref') && (typeof node.$ref !== 'string' || !node.$ref.startsWith('#'))) {
          fail(400, 'invalid_response_format', 'External schema references are unsupported.');
        }
        pending.push(...Object.values(node));
      }
    }
    result.payload.response_format = jsonObject ? { type: 'json_object' } : format;
    result.fingerprint = createHash('sha256').update(result.fingerprint).update(canonical(result.payload.response_format)).digest('hex');
  }
  return result;
}

function bridgeRequest(body, route) {
  const nativeTools = !!gpuBridge(route.bridge);
  const fields = nativeTools ? GPU_REQUEST_FIELDS : REQUEST_FIELDS;
  if (Object.keys(body).some(key => !fields.has(key))) {
    fail(400, 'unsupported_field', nativeTools
      ? 'GPU requests support text messages, function tools, streaming, and output limits; other generation controls are unsupported.'
      : 'Subscription bridges support text messages and streaming; other generation controls are unsupported.');
  }
  const roles = route.bridge.kind === 'codegpt' ? ['system', 'user', 'assistant'] : ['system', 'developer', 'user', 'assistant', ...(nativeTools ? ['tool'] : [])];
  const messageFields = nativeTools ? ['role', 'content', 'name', 'tool_calls', 'tool_call_id'] : ['role', 'content'];
  if (!Array.isArray(body.messages) || body.messages.length < 1
    || body.messages.some(message => !plain(message) || !roles.includes(message.role)
      || (typeof message.content !== 'string' && !(nativeTools && message.role === 'assistant'
        && message.content == null && Array.isArray(message.tool_calls) && message.tool_calls.length))
      || Object.keys(message).some(key => !messageFields.includes(key))
      || (message.name !== undefined && typeof message.name !== 'string')
      || (message.tool_calls !== undefined && (message.role !== 'assistant' || !Array.isArray(message.tool_calls)
        || !message.tool_calls.length || message.tool_calls.some(call => !plain(call) || call.type !== 'function'
          || typeof call.id !== 'string' || !call.id || !plain(call.function)
          || typeof call.function.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string')))
      || (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id))
      || (message.tool_call_id !== undefined && message.role !== 'tool'))
    || !body.messages.some(message => typeof message.content === 'string' && message.content.trim())) {
    fail(400, 'text_only', nativeTools ? 'Supply text messages, assistant function calls, and tool results with tool_call_id.'
      : 'Subscription bridges accept text messages only, without tools or hosted actions.');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools)
    || body.tools.some(tool => !plain(tool) || tool.type !== 'function' || !plain(tool.function)
      || typeof tool.function.name !== 'string' || !tool.function.name
      || (tool.function.parameters !== undefined && !plain(tool.function.parameters))))) {
    fail(400, 'invalid_tools', 'Supply function tool definitions.');
  }
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)
    && !(plain(body.tool_choice) && body.tool_choice.type === 'function' && plain(body.tool_choice.function)
      && typeof body.tool_choice.function.name === 'string' && body.tool_choice.function.name)) {
    fail(400, 'invalid_tool_choice', 'Use auto, none, required, or a named function tool choice.');
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    fail(400, 'invalid_parameter', 'Invalid parallel_tool_calls.');
  }
  const input = body.tools === undefined ? body.messages : { messages: body.messages, tools: body.tools };
  if (route.maxInputBytes !== undefined && Buffer.byteLength(JSON.stringify(input)) > route.maxInputBytes) {
    throw Object.assign(new GatewayError(400, 'input_too_large', 'Input exceeds this model’s configured text size limit.'),
      { maxInputBytes: route.maxInputBytes, inputLimitScope: body.tools === undefined ? 'messages' : 'request_fields' });
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail(400, 'invalid_stream', 'stream must be true or false.');
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) fail(400, 'output_limit', 'Set only one output token hint.');
  const outputHint = body.max_completion_tokens ?? body.max_tokens;
  if ((body.max_tokens !== undefined || body.max_completion_tokens !== undefined) && !integer(outputHint, 1, 1_000_000)) {
    fail(400, 'output_limit', 'An output token hint must be an integer between 1 and 1000000.');
  }
  // Existing clients send token limits by default. These bridges cannot enforce
  // them, so retain the hint only in replay identity, never in upstream dispatch.
  const payload = { model: route.bridge.model, messages: body.messages, stream: body.stream === true };
  for (const field of ['tools', 'tool_choice', 'parallel_tool_calls']) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  const identity = { ...payload, model: route.id };
  if (outputHint !== undefined) identity[body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens'] = outputHint;
  return { route, payload, fingerprint: createHash('sha256')
    .update(canonical(identity)).digest('hex') };
}

/** The caller must resolve an authenticated account before invoking handle.
 * Store operations may be asynchronous, and must be durable, atomic, and scoped by account ID.
 * `metered:true` is an operator qualification, never a user-controlled flag.
 */
export function createModelGateway({ store, models = [], upstreamUrl, upstreamKey, subscription,
  fetchImpl = globalThis.fetch, timeoutMs, maxConcurrency = 6 }) {
  // Subscription request deadlines belong to the caller. A positive explicit
  // operator timeout remains supported; client disconnect always cancels.
  const requestTimeoutMs = timeoutMs ?? 0;
  timeoutMs ??= 120_000;
  let routes = configureModels(models);
  const requestRoutes = [...routes.values()].some(route => route.access === 'requests');
  if (requestRoutes && (!plain(subscription) || !plain(subscription.basic)
    || !integer(subscription.basic.includedRequests, 1, Number.MAX_SAFE_INTEGER)
    || !integer(subscription.overageUsdMicrosPerRequest, 0, Number.MAX_SAFE_INTEGER)
    || ['reserveRequest', 'settleRequest', 'releaseRequest', 'markRequestUncertain'].some(name => typeof store?.[name] !== 'function'))) {
    throw new Error('Subscription request pricing and durable request store methods are required.');
  }
  const legacyRoutes = [...routes.values()].some(route => route.access !== 'requests');
  let completionUrl;
  if (legacyRoutes) {
    const url = new URL(upstreamUrl);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
      throw new Error('Gateway upstream must use HTTPS or loopback HTTP with a /v1 base path.');
    }
    if (typeof upstreamKey !== 'string' || upstreamKey.length < 16 || /[\r\n]/.test(upstreamKey)) throw new Error('A host-only upstream credential is required.');
    completionUrl = new URL(`${url.pathname.replace(/\/$/, '')}/chat/completions`, url).toString();
  }
  if ((timeoutMs !== 0 && !integer(timeoutMs, 100, 600_000)) || !integer(maxConcurrency, 1, 100)) throw new Error('Invalid gateway limits.');
  let active = 0;
  const eligible = account => new Set((account.allowedModels || []).map(m => typeof m === 'string' ? m : m.id));
  const catalog = account => ({ object: 'list', data: [...routes.values()]
    .filter(m => m.metered === true && eligible(account).has(m.id))
    .map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'reach', name: m.name || m.id, provider: m.provider,
      ...(m.access === 'requests' ? { access: 'requests', capabilities: requestCapabilities(m),
        ...(m.maxInputBytes === undefined ? {} : { max_input_bytes: m.maxInputBytes, input_limit_scope: 'messages' }),
        pricing: account.requestAllowance?.unlimited === true ? { unit:'request',unlimited:true,includedRequests:null,usdMicrosPerRequest:0 } : { unit: 'request', includedRequests: subscription.basic.includedRequests,
        usdMicrosPerRequest: subscription.overageUsdMicrosPerRequest } } : m.pricing ? { pricing: m.pricing } : {}) })) });

  async function handle(req, res, account, body) {
    const requestUrl = new URL(req.url, 'http://gateway.invalid');
    const pathname = requestUrl.pathname;
    if (req.method === 'GET' && pathname === '/v1/models') {
      const listing = catalog(account);
      // Older Lemonade Mobile builds require downloaded=true to list a model.
      if (requestUrl.searchParams.get('show_all') === 'true') {
        for (const model of listing.data) model.downloaded = true;
      }
      responseJson(res, 200, listing); return;
    }
    const decision = pathname === '/v1/decisions';
    const operation = pathname === '/v1/embeddings' ? 'embeddings'
      : pathname === '/v1/rerank' ? 'rerank'
      : pathname === '/v1/video/generations' ? 'video'
      : pathname === '/v1/images/generations' ? 'image' : null;
    if (req.method === 'GET' && pathname.startsWith('/v1/media/')) {
      try { await comfyMedia(fetchImpl, routes, res, pathname); }
      catch (error) { if (!res.writableEnded) responseJson(res, integer(error?.status, 400, 599) ? error.status : 502, errorBody(error)); }
      return;
    }
    if (req.method !== 'POST' || (!decision && !operation && pathname !== '/v1/chat/completions')) { responseJson(res, 404, errorBody(new GatewayError(404, 'not_found', 'Route not found.'))); return; }
    let reservation;
    let dispatched = false;
    let finished = false;
    let counted = false;
    let requestMode = false;
    let settlementAttempted = false;
    const controller = new AbortController();
    let timer;
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    req.once('aborted', cancel);
    if (req.aborted || res.destroyed) cancel();
    try {
      if (controller.signal.aborted) fail(408, 'request_cancelled', 'The request was cancelled before dispatch.');
      const input = body ?? await readJson(req);
      const { payload, route, amount, reserveUsage, fingerprint } = operation === 'video' || operation === 'image'
        ? generationRequest(input, routes, operation)
        : operation ? inferenceRequest(input, routes, operation)
        : (decision ? decisionRequest : completionRequest)(input, routes);
      if (!decision && !operation && (gpuBridge(route.bridge)?.decision || gpuBridge(route.bridge)?.operation))
        fail(400, 'model_operation_mismatch', 'Use the endpoint advertised for this model.');
      const deadline = route.access === 'requests' ? requestTimeoutMs : timeoutMs;
      if (deadline > 0) timer = setTimeout(() => controller.abort(), deadline);
      requestMode = route.access === 'requests';
      const requestId = req.headers['idempotency-key'] ?? randomUUID();
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(requestId)) fail(400, 'invalid_request_id', 'Invalid Idempotency-Key.');
      res.setHeader('x-request-id', requestId);
      reservation = requestMode
        ? await store.reserveRequest(account.id ?? account.accountId, requestId, route.id, fingerprint)
        : route.pricing
        ? await store.reserveUsd(account.id ?? account.accountId,requestId,route.id,fingerprint,reserveUsage)
        : await store.reserve(account.id ?? account.accountId, requestId, route.id, fingerprint, amount);
      if (!reservation.fresh) {
        if (reservation.status === 'settled' && reservation.replay) {
          const body = replayBody(reservation.replay);
          res.writeHead(200, { 'content-type': reservation.replay.contentType, 'cache-control': 'no-store', 'x-reach-replayed': 'true' });
          res.end(body);
          return;
        }
        const code = reservation.status === 'settled' ? 'request_already_completed' : reservation.status === 'uncertain' ? 'usage_pending' : 'request_in_progress';
        fail(409, code, 'This request already exists. Reusing its key will not run another generation.');
      }
      // Stored paid responses and pending holds remain recoverable when the
      // last credit was spent. The store authorizes every fresh reservation;
      // this additional catalog gate still runs before any provider dispatch.
      if (!eligible(account).has(route.id)) fail(403, 'model_not_allowed', 'This model is not available for your account.');
      if (active >= maxConcurrency) fail(429, 'gateway_capacity', 'The model service is at capacity. Retry shortly.');
      if (controller.signal.aborted) fail(408, 'request_cancelled', 'The request was cancelled before dispatch.');
      active += 1;
      counted = true;
      dispatched = true;
      const liveStrata = requestMode && !decision && !operation && payload.stream && strataQwen(route.bridge.model);
      let record;
      let usage;
      let terminal = '';
      if (requestMode && (operation === 'video' || operation === 'image')) {
        ({ record } = await comfyGenerate(fetchImpl, payload, route, controller.signal, requestId));
      } else {
      const upstream = await fetchImpl(requestMode ? gpuBridge(route.bridge).url : completionUrl, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: requestMode ? { 'content-type': 'application/json', 'cache-control': 'no-store' }
          : { 'content-type': 'application/json', authorization: `Bearer ${upstreamKey}`,
            'x-reach-metered': 'provider-v1', 'cache-control': 'no-store' },
        body: JSON.stringify(liveStrata ? { ...payload, stream_options: { include_usage: true } }
          : gpuBridge(route.bridge) && !decision && !operation ? { ...payload, stream: false } : payload),
      });
      if (!upstream.ok) {
        let detail = '';
        if (requestMode && upstream.status === 400) {
          try { detail = (await upstream.text()).slice(0, 500); } catch { detail = ''; }
        } else await upstream.body?.cancel();
        if (requestMode && /response_format|json_schema|json_object|structured.output|strict/i.test(detail)) {
          fail(400, 'invalid_response_format', 'The GPU model rejected the requested JSON format.');
        }
        fail(502, 'provider_rejected', requestMode ? 'The subscription bridge did not complete the request.'
          : 'The provider did not complete the request. Usage is pending reconciliation.');
      }
      if ((!requestMode && upstream.headers.get('x-reach-metering') !== 'provider-v1')
        || upstream.headers.get('x-reach-cache') === 'HIT' || upstream.headers.has('x-reach-fallback')) {
        await upstream.body?.cancel();
        fail(502, 'unmetered_route', 'This provider route is not qualified for usage billing.');
      }
      const contentType = upstream.headers.get('content-type') || '';
      const compression = upstream.headers.get('x-context-compression');
      if (requestMode && /^(?:lossless_repeated_lines|hierarchical_summary); lossy=(?:true|false)$/.test(compression || '')) {
        res.setHeader('X-Context-Compression', compression);
        for (const name of ['X-Context-Original-Tokens', 'X-Context-Compressed-Tokens']) {
          const value = upstream.headers.get(name);
          if (/^\d{1,9}$/.test(value || '')) res.setHeader(name, value);
        }
      }
      if (operation) {
        ({ record, usage } = await inferenceResponse(upstream, payload, route, controller.signal, operation));
      } else if (decision) {
        const parsed = JSON.parse(await boundedText(upstream));
        if (!plain(parsed.answers) || !integer(parsed.usage?.input_tokens, 0, 1_000_000_000)
          || Object.keys(payload.questions).some(name => !plain(parsed.answers[name])))
          fail(502, 'invalid_provider_response', 'Invalid decision response.');
        usage = { promptTokens: parsed.usage.input_tokens, completionTokens: 0 };
        record = { contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ...parsed, model: route.id }) };
      } else if (liveStrata) {
        if (!/^text\/event-stream(?:\s*;|$)/i.test(contentType)) {
          await upstream.body?.cancel();
          fail(502, 'invalid_bridge_response', 'Strata did not return an event stream.');
        }
        ({ record, usage, terminal } = await forwardStream(upstream, res, route.id, controller.signal, route));
      } else if (requestMode) {
        record = await gpuResponse(upstream, payload, route, controller.signal, measured => { usage = measured; });
        if (controller.signal.aborted || res.destroyed) fail(408, 'request_cancelled', 'The request was cancelled before completion.');
      } else if (payload.stream && contentType.toLowerCase().includes('text/event-stream')) {
        ({ record, usage } = await forwardStream(upstream, res, route.id, controller.signal));
      } else {
        const text = await boundedText(upstream);
        let parsed;
        try { parsed = JSON.parse(text); } catch { fail(502, 'invalid_provider_response', 'The provider returned an invalid response.'); }
        usage = providerUsage(parsed);
        if (!usage) fail(502, 'usage_unavailable', 'The provider did not report verified usage. Your reservation is pending reconciliation.');
        if (!plain(parsed) || parsed.error || !Array.isArray(parsed.choices) || !parsed.choices.length) fail(502, 'invalid_provider_response', 'The provider returned an invalid completion.');
        const safe = completionOutput(parsed, route.id);
        record = payload.stream ? jsonAsStream(safe) : { contentType: 'application/json; charset=utf-8', body: JSON.stringify(safe) };
      }
      }
      if (requestMode) {
        // Validate escaped replay storage size before attempting a mutation.
        // A known local validation failure can release the hold safely.
        try { requestReplay(record); }
        catch { fail(502, 'response_too_large', 'The completed response exceeds the request replay limit.'); }
        settlementAttempted = true;
        await store.settleRequest(reservation.id, record);
      } else await store.settle(reservation.id, { ...usage, model: route.id, provider: route.provider }, record);
      finished = true;
      if (requestMode && usage && !res.headersSent) {
        // Private relay telemetry; subscription settlement remains per request.
        // reachd deliberately excludes these headers from public responses.
        res.setHeader('X-Reach-Usage-In', String(usage.promptTokens));
        res.setHeader('X-Reach-Usage-Out', String(usage.completionTokens));
      }
      if (res.headersSent) { res.end(terminal + 'data: [DONE]\n\n'); }
      else {
        res.writeHead(200, { 'content-type': record.contentType, 'cache-control': 'no-store' });
        res.end(replayBody(record));
      }
    } catch (error) {
      if (reservation?.fresh && !finished) {
        try {
          if (requestMode) {
            if (settlementAttempted) await store.markRequestUncertain(reservation.id, 'request_settlement_unknown');
            else await store.releaseRequest(reservation.id);
          } else if (dispatched) await store.markUncertain(reservation.id, error instanceof GatewayError ? error.code : 'dispatch_outcome_unknown');
          else await store.release(reservation.id, 'not_dispatched');
        } catch {
          // A database outage must not leave the HTTP request hanging or fabricate a
          // refund. The durable reservation stays held for operator reconciliation.
          error = new GatewayError(503, 'account_storage_unavailable', 'Account storage is unavailable. The request remains reserved for reconciliation.');
        }
      }
      if (requestMode && settlementAttempted && !finished) error = new GatewayError(503, 'account_storage_unavailable',
        'Completion settlement is pending reconciliation. Reusing this request key will not dispatch again.');
      else if (requestMode && controller.signal.aborted && !finished) error = new GatewayError(408, 'request_cancelled',
        'The subscription request was cancelled before completion.');
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.end(`data: ${JSON.stringify(errorBody(error))}\n\ndata: [DONE]\n\n`);
        else responseJson(res, integer(error?.status, 400, 599) ? error.status : 502, errorBody(error));
      }
    } finally {
      clearTimeout(timer);
      res.off('close', cancel);
      req.off('aborted', cancel);
      controller.abort();
      if (counted) active -= 1;
    }
  }
  const replaceModels = nextModels => {
    const next = configureModels(nextModels);
    // Live changes cannot introduce destinations, pricing or another access mode.
    if (next.size !== routes.size || [...next].some(([id, model]) => {
      const previous = routes.get(id);
      const fixed = value => JSON.stringify(Object.fromEntries(Object.entries(value || {}).filter(([key]) => !['metered', 'maxInputBytes', 'maxOutputTokens'].includes(key))));
      return !previous || fixed(previous) !== fixed(model);
    })) throw new Error('A live model update may only change availability and input/output limits.');
    routes = next;
  };
  return { handle, catalog, replaceModels };
}

async function bridgeText(response, signal) {
  if (!response.body) fail(502, 'empty_response', 'The subscription bridge returned no response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) fail(408, 'request_cancelled', 'The subscription request was cancelled.');
      const { value, done } = await reader.read();
      if (signal.aborted) fail(408, 'request_cancelled', 'The subscription request was cancelled.');
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) fail(502, 'response_too_large', 'The bridge response exceeded the service size limit.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
}

async function inferenceResponse(response, payload, route, signal, operation) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || ''))
    fail(502, 'invalid_provider_response', 'The model returned an unexpected response type.');
  let parsed;
  try { parsed = JSON.parse(await bridgeText(response, signal)); }
  catch (error) {
    if (error instanceof GatewayError) throw error;
    fail(502, 'invalid_provider_response', 'The model returned invalid JSON.');
  }
  if (!plain(parsed) || parsed.error || parsed.model !== route.bridge.model
    || !integer(parsed.usage?.prompt_tokens, 0, 1_000_000_000)
    || parsed.usage.total_tokens !== parsed.usage.prompt_tokens)
    fail(502, 'invalid_provider_response', 'The selected model did not return valid output and usage.');
  const output = { object: 'list', model: route.id, usage: {
    prompt_tokens: parsed.usage.prompt_tokens, total_tokens: parsed.usage.total_tokens } };
  if (operation === 'embeddings') {
    const count = Array.isArray(payload.input) ? payload.input.length : 1;
    const indices = new Set();
    if (!Array.isArray(parsed.data) || parsed.data.length !== count)
      fail(502, 'invalid_provider_response', 'The embedding response did not match the input count.');
    output.data = parsed.data.map(row => {
      if (!plain(row) || !integer(row.index, 0, count - 1) || indices.has(row.index))
        fail(502, 'invalid_provider_response', 'Invalid embedding index.');
      indices.add(row.index);
      const v = row.embedding;
      const valid = payload.encoding_format === 'base64'
        ? typeof v === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 4096
          && Buffer.from(v, 'base64').toString('base64') === v
        : Array.isArray(v) && v.length === 1024 && v.every(Number.isFinite);
      if (!valid) fail(502, 'invalid_provider_response', 'Invalid 1024-dimensional embedding.');
      return { object: 'embedding', index: row.index, embedding: v };
    });
  } else {
    const indices = new Set();
    if (!Array.isArray(parsed.results) || parsed.results.length !== payload.top_n)
      fail(502, 'invalid_provider_response', 'The reranker did not return the requested results.');
    output.results = parsed.results.map(row => {
      if (!plain(row) || !integer(row.index, 0, payload.documents.length - 1) || indices.has(row.index)
        || !Number.isFinite(row.relevance_score)) fail(502, 'invalid_provider_response', 'Invalid reranking result.');
      indices.add(row.index);
      return { index: row.index, relevance_score: row.relevance_score,
        ...(payload.return_documents ? { document: { text: payload.documents[row.index] } } : {}) };
    });
  }
  if (signal.aborted) fail(408, 'request_cancelled', 'The request was cancelled before completion.');
  return { record: { contentType: 'application/json; charset=utf-8', body: JSON.stringify(output) },
    usage: { promptTokens: parsed.usage.prompt_tokens, completionTokens: 0 } };
}

function bridgeEnvelope(parsed, route) {
  if (!plain(parsed) || parsed.error || parsed.model !== route.bridge.model || !Array.isArray(parsed.choices)) {
    fail(502, 'invalid_bridge_response', 'The bridge did not return the selected model’s completion.');
  }
  return { id: typeof parsed.id === 'string' ? parsed.id.slice(0, 200) : `chatcmpl-${randomUUID()}`,
    created: integer(parsed.created, 0, Number.MAX_SAFE_INTEGER) ? parsed.created : Math.floor(Date.now() / 1000), model: route.id };
}

function bridgeFinish(reason) { return reason === 'stop' || reason === 'length'; }

async function gpuResponse(response, payload, route, signal, measuredUsage) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    fail(502, 'invalid_bridge_response', 'The GPU model returned an unexpected response type.');
  }
  const text = await bridgeText(response, signal);
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail(502, 'invalid_bridge_response', 'The GPU model returned invalid JSON.'); }
  const envelope = bridgeEnvelope(parsed, route);
  const choice = parsed.choices[0];
  const message = choice?.message;
  if (!plain(choice) || !plain(message)) {
    fail(502, 'invalid_bridge_response', 'The GPU model returned no chat message.');
  }
  // Models differ in content shape, reasoning fields and finish markers. Pass
  // their reply through; interpreting an answer or tool call belongs to the client.
  const hasOutput = ['content', 'reasoning_content', 'reasoning', 'thought', 'refusal', 'tool_calls', 'function_call']
    .some(key => {
      const value = message[key];
      return typeof value === 'string' ? !!value.trim() : Array.isArray(value) ? value.length > 0
        : plain(value) && Object.keys(value).length > 0;
    });
  if (!hasOutput) fail(502, 'empty_response', 'The GPU model returned an empty message.');
  // The selected private GPU route supplied this record. Validate native
  // counts without fabricating them or adding them to the customer's reply.
  const measured = providerUsage({ usage_source: 'provider', usage: plain(parsed.usage) ? {
    prompt_tokens: parsed.usage.prompt_tokens, completion_tokens: parsed.usage.completion_tokens, total_tokens: parsed.usage.total_tokens,
  } : null });
  if (measured) measuredUsage(measured);
  const safe = { ...envelope, object: 'chat.completion', choices: [{ index: 0,
    message: { role: 'assistant', ...message }, finish_reason: choice.finish_reason ?? null }] };
  if (plain(parsed.context_compression) && parsed.context_compression.applied === true
    && typeof parsed.context_compression.lossy === 'boolean'
    && ['lossless_repeated_lines', 'hierarchical_summary'].includes(parsed.context_compression.method)) {
    const info = parsed.context_compression;
    if (integer(info.original_prompt_tokens, 1, 10_000_000) && integer(info.compressed_prompt_tokens, 1, info.original_prompt_tokens))
      safe.context_compression = { applied: true, method: info.method, lossy: info.lossy,
        original_prompt_tokens: info.original_prompt_tokens, compressed_prompt_tokens: info.compressed_prompt_tokens };
  }
  return payload.stream ? jsonAsStream(safe)
    : { contentType: 'application/json; charset=utf-8', body: JSON.stringify(safe) };
}

async function bridgeResponse(response, payload, route, signal) {
  // Buffer the final bridge result before settlement. A partial answer, broken
  // stream, or cancellation releases the request hold without exposing an
  // uncharged completed answer. These bridges do not provide token billing.
  const type = (response.headers.get('content-type') || '').toLowerCase();
  const text = await bridgeText(response, signal);
  if (type.includes('text/event-stream')) {
    if (!payload.stream) fail(502, 'invalid_bridge_response', 'The bridge returned an unexpected stream.');
    return bridgeStream(text, route);
  }
  if (!/^application\/json(?:\s*;|$)/.test(type)) fail(502, 'invalid_bridge_response', 'The bridge must return a completion with its selected model identity.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail(502, 'invalid_bridge_response', 'The bridge returned invalid JSON.'); }
  const envelope = bridgeEnvelope(parsed, route);
  const choice = parsed.choices[0];
  if (parsed.choices.length !== 1 || !plain(choice) || (choice.index !== undefined && choice.index !== 0)
    || !plain(choice.message) || choice.message.role !== 'assistant'
    || typeof choice.message.content !== 'string' || !choice.message.content.trim()
    || Object.keys(choice.message).some(key => !['role', 'content'].includes(key)) || !bridgeFinish(choice.finish_reason)) {
    fail(502, 'incomplete_bridge_response', 'The bridge did not return a completed text answer.');
  }
  const safe = { ...envelope, object: 'chat.completion', choices: [{ index: 0,
    message: { role: 'assistant', content: choice.message.content }, finish_reason: choice.finish_reason }] };
  return payload.stream ? jsonAsStream(safe) : { contentType: 'application/json; charset=utf-8', body: JSON.stringify(safe) };
}

function bridgeStream(text, route) {
  let done = false;
  let finished = false;
  let answer = '';
  let body = '';
  for (const raw of text.replace(/\r\n/g, '\n').split('\n\n')) {
    if (Buffer.byteLength(raw) > MAX_EVENT) fail(502, 'event_too_large', 'The bridge stream event exceeded the service limit.');
    const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (done) fail(502, 'invalid_bridge_stream', 'The bridge sent data after completing the stream.');
    if (data.trim() === '[DONE]') { done = true; continue; }
    let parsed;
    try { parsed = JSON.parse(data); } catch { fail(502, 'invalid_bridge_stream', 'The bridge returned an invalid stream event.'); }
    const envelope = bridgeEnvelope(parsed, route);
    if (parsed.choices.length === 0) continue; // Token metadata is not request billing.
    const choice = parsed.choices[0];
    const delta = choice?.delta;
    if (parsed.choices.length !== 1 || !plain(choice) || (choice.index !== undefined && choice.index !== 0)
      || !plain(delta) || Object.keys(delta).some(key => !['role', 'content', 'reasoning_content'].includes(key))
      || (delta.role !== undefined && delta.role !== 'assistant')
      || (delta.content !== undefined && typeof delta.content !== 'string')
      || (delta.reasoning_content !== undefined && typeof delta.reasoning_content !== 'string')
      || finished || (choice.finish_reason != null && !bridgeFinish(choice.finish_reason))) {
      fail(502, 'invalid_bridge_stream', 'The bridge returned an unsupported or incomplete text stream.');
    }
    const safeDelta = {};
    if (delta.role !== undefined) safeDelta.role = delta.role;
    if (delta.content !== undefined) safeDelta.content = delta.content;
    answer += delta.content || '';
    if (bridgeFinish(choice.finish_reason)) finished = true;
    body += `data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: safeDelta, finish_reason: choice.finish_reason ?? null }] })}\n\n`;
    if (Buffer.byteLength(body) > MAX_RESPONSE - 64) fail(502, 'response_too_large', 'The bridge response exceeded the service size limit.');
  }
  if (!done || !finished || !answer.trim()) fail(502, 'incomplete_bridge_response', 'The bridge stream ended without a completed text answer.');
  return { contentType: 'text/event-stream', body: `${body}data: [DONE]\n\n` };
}

function completionOutput(parsed, model) {
  const result = { id: String(parsed.id || `chatcmpl-${randomUUID()}`).slice(0, 200), object: parsed.object,
    created: integer(parsed.created, 0, Number.MAX_SAFE_INTEGER) ? parsed.created : Math.floor(Date.now() / 1000),
    model, choices: parsed.choices };
  if (providerUsage(parsed)) {
    result.usage = parsed.usage;
    result.usage_source = 'provider';
  }
  return result;
}
function jsonAsStream(parsed) {
  const chunk = { ...parsed, object: 'chat.completion.chunk',
    choices: parsed.choices.map(choice => {
      const delta = { ...choice.message };
      if (Array.isArray(delta.tool_calls)) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
      return { index: choice.index ?? 0, delta, finish_reason: choice.finish_reason };
    }) };
  return { contentType: 'text/event-stream', body: `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` };
}

async function forwardStream(upstream, res, model, signal, strataRoute) {
  if (!upstream.body) fail(502, 'empty_response', 'The provider returned no stream.');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let bufferSize = 0;
  let doneReceived = false;
  let usage = null;
  const events = [];
  let replayBytes = 0;
  let deltaBytes = 0;
  const replayLimit = strataRoute ? MAX_STREAM_BYTES : MAX_RESPONSE;
  let seenFinish = false;
  let seenOutput = false;
  let terminal = '';
  const send = async (event) => {
    if (res.destroyed || signal.aborted) fail(502, 'stream_interrupted', 'The model stream was interrupted.');
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    if (!res.write(event)) await once(res, 'drain', { signal });
  };
  const processEvent = async (raw) => {
    const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) {
      // Keep the connection open during Strata prefill without storing transport comments in replays.
      if (strataRoute && !doneReceived && !seenFinish && raw.split('\n').some(line => line.startsWith(':'))) {
        await send(': keep-alive\n\n');
      }
      return;
    }
    if (doneReceived) fail(502, 'invalid_provider_stream', 'The provider sent data after stream completion.');
    if (data.trim() === '[DONE]') { doneReceived = true; return; }
    let parsed;
    try { parsed = JSON.parse(data); } catch { fail(502, 'invalid_provider_stream', 'The provider returned an invalid stream.'); }
    if (!plain(parsed) || parsed.error) fail(502, 'provider_stream_error', 'The provider could not complete the stream. Usage is pending reconciliation.');
    if (strataRoute) bridgeEnvelope(parsed, strataRoute);
    const reported = providerUsage(strataRoute ? { ...parsed, usage_source: 'provider' } : parsed);
    if (reported) {
      if (usage && canonical(usage) !== canonical(reported)) fail(502, 'ambiguous_usage', 'The provider reported conflicting usage records.');
      usage = reported;
    }
    if (!Array.isArray(parsed.choices)) fail(502, 'invalid_provider_stream', 'The provider returned an invalid stream event.');
    if (strataRoute && (parsed.choices.length > 1 || parsed.choices.some(choice =>
      !plain(choice) || (choice.index !== undefined && choice.index !== 0) || !plain(choice.delta) || seenFinish))) {
      fail(502, 'invalid_provider_stream', 'Strata returned an invalid stream choice.');
    }
    if (strataRoute) {
      // Count actual generated text and tool arguments separately from SSE framing.
      for (const { delta } of parsed.choices) {
        const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls.map(call => call?.function) : [];
        for (const part of [delta.content, delta.reasoning_content, delta.reasoning, delta.thought, delta.refusal,
          ...calls.concat(delta.function_call).flatMap(call => [call?.name, call?.arguments])]) {
          if (typeof part === 'string') deltaBytes += Buffer.byteLength(part);
        }
      }
      if (deltaBytes > MAX_RESPONSE) fail(502, 'response_too_large', 'The model output exceeded the service size limit.');
      seenOutput ||= parsed.choices.some(({ delta }) =>
        ['content', 'reasoning_content', 'reasoning', 'thought', 'refusal'].some(key =>
          typeof delta[key] === 'string' && !!delta[key].trim())
        || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
        || (plain(delta.function_call) && Object.keys(delta.function_call).length > 0));
    }
    if (parsed.choices.some(c => c.finish_reason !== null && c.finish_reason !== undefined)) seenFinish = true;
    const output = completionOutput(strataRoute ? { ...parsed, usage_source: 'provider' } : parsed, model);
    if (strataRoute && reported) {
      const rate = parsed.timings?.predicted_per_second;
      if (Number.isFinite(rate) && rate > 0) output.usage = { ...output.usage, generation_tokens_per_second: rate };
    }
    const event = `data: ${JSON.stringify(output)}\n\n`;
    replayBytes += Buffer.byteLength(event);
    if (replayBytes > replayLimit - 64) fail(502, 'response_too_large', 'The model response exceeded the service size limit.');
    events.push(event);
    // Finish and usage may reach the client only after settlement.
    if (strataRoute && seenFinish) terminal += event;
    else await send(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { pending += decoder.decode(); break; }
      bufferSize += value.byteLength;
      if (bufferSize > (strataRoute ? MAX_STREAM_BYTES : MAX_RESPONSE * 2)) fail(502, 'response_too_large', 'The model stream exceeded the service size limit.');
      pending += decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const raw = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (Buffer.byteLength(raw) > MAX_EVENT) fail(502, 'event_too_large', 'The model stream event exceeded the service limit.');
        await processEvent(raw);
      }
      if (Buffer.byteLength(pending) > MAX_EVENT) fail(502, 'event_too_large', 'The model stream event exceeded the service limit.');
    }
    if (pending.trim()) await processEvent(pending);
    if (!doneReceived || !seenFinish || !usage) fail(502, 'usage_unavailable', 'The provider stream ended without verified final usage. Your reservation is pending reconciliation.');
    if (strataRoute && !seenOutput) fail(502, 'empty_response', 'Strata returned an empty stream.');
    events.push('data: [DONE]\n\n');
    const body = events.join('');
    const record = strataRoute ? streamRecord(body) : { contentType: 'text/event-stream', body };
    return { record, usage, terminal };
  } finally { await reader.cancel().catch(() => {}); }
}

const GENERATION_FIELDS = new Set(['model', 'prompt', 'reference_image', 'duration_seconds',
  'width', 'height', 'seed', 'steps', 'turbo']);

function generationRequest(body, routes, operation) {
  if (!plain(body) || Buffer.byteLength(JSON.stringify(body)) > MAX_BODY)
    fail(400, 'invalid_request', 'Invalid generation request.');
  const route = routes.get(body.model);
  if (!route || route.metered !== true) fail(404, 'model_unavailable', 'This model is not available.');
  if (route.access !== 'requests' || gpuBridge(route.bridge)?.operation !== operation)
    fail(400, 'model_operation_mismatch', 'Choose a model that supports this endpoint.');
  if (Object.keys(body).some(key => !GENERATION_FIELDS.has(key)))
    fail(400, 'unsupported_field', 'Unsupported generation request fields.');
  if (operation === 'image' && ['duration_seconds', 'turbo', 'reference_image'].some(key => body[key] !== undefined))
    fail(400, 'unsupported_field', 'The image endpoint does not accept duration_seconds, turbo, or reference_image.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || Buffer.byteLength(body.prompt) > 16000)
    fail(400, 'invalid_prompt', 'Supply a nonempty prompt up to 16000 bytes.');
  if (body.duration_seconds !== undefined && !integer(body.duration_seconds, 1, 15))
    fail(400, 'invalid_parameter', 'duration_seconds must be between 1 and 15.');
  for (const dimension of ['width', 'height']) {
    if (body[dimension] !== undefined && (!integer(body[dimension], 256, 2048) || body[dimension] % 32 !== 0))
      fail(400, 'invalid_parameter', `${dimension} must be a multiple of 32 between 256 and 2048.`);
  }
  if (body.seed !== undefined && !integer(body.seed, 0, Number.MAX_SAFE_INTEGER))
    fail(400, 'invalid_parameter', 'seed must be a nonnegative integer.');
  if (body.steps !== undefined && !integer(body.steps, 1, 40))
    fail(400, 'invalid_parameter', 'steps must be between 1 and 40.');
  if (body.turbo !== undefined && typeof body.turbo !== 'boolean')
    fail(400, 'invalid_parameter', 'turbo must be true or false.');
  let reference = null;
  if (body.reference_image !== undefined) {
    const match = typeof body.reference_image === 'string'
      && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.reference_image);
    const bytes = match && Buffer.from(match[2], 'base64');
    if (!match || !bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== match[2])
      fail(400, 'invalid_reference_image', 'Supply a PNG, JPEG, or WebP data URL up to 8 MB.');
    reference = { ext: match[1] === 'jpeg' ? 'jpg' : match[1], bytes };
  }
  const payload = { prompt: body.prompt, duration: body.duration_seconds ?? 5,
    width: body.width ?? (operation === 'image' ? 1024 : 1344),
    height: body.height ?? (operation === 'image' ? 1024 : 768),
    seed: body.seed ?? null, steps: body.steps ?? null, turbo: body.turbo ?? true, reference };
  const fingerprint = createHash('sha256').update(canonical({ operation, model: route.id,
    prompt: payload.prompt, duration: payload.duration, width: payload.width, height: payload.height,
    seed: payload.seed, steps: payload.steps, turbo: payload.turbo,
    reference: reference ? createHash('sha256').update(reference.bytes).digest('hex') : null })).digest('hex');
  return { payload, route, fingerprint };
}

// MiniMax H3 reference-to-video graph, distilled from the shipped
// video_minimax_h3_r2v template with frontend helper nodes inlined.
function minimaxR2V({ prompt, width, height, duration, seed, steps, turbo, referenceName }) {
  const frames = Math.max(5, Math.round(duration * 24));
  const length = frames + ((5 - (frames % 17)) % 17);
  const model = turbo ? 'lora' : 'unet';
  const graph = {
    unet: { class_type: 'UnetLoaderGGUF', inputs: {
      unet_name: 'MiniMax-H3-Ref2VA-Pruned-Q4_K_M.gguf' } },
    clip: { class_type: 'CLIPLoader', inputs: {
      clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' } },
    audio_vae: { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0],
      lora_name: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', strength_model: 1 } },
    ref: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
      clip: ['clip', 0], vae: ['vae', 0], audio_vae: ['audio_vae', 0],
      prompt, width, height, length, ref_image_size: 'match' } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    guider: { class_type: 'BasicGuider', inputs: { model: [model, 0], conditioning: ['ref', 0] } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    schedule: { class_type: 'BasicScheduler', inputs: { model: ['unet', 0],
      steps: steps ?? (turbo ? 4 : 20), scheduler: 'simple', denoise: 1 } },
    sample: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0],
      guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['schedule', 0], latent_image: ['ref', 1] } },
    vdecode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    adecode: { class_type: 'VAEDecodeAudio', inputs: { samples: ['sample', 0], vae: ['audio_vae', 0] } },
    mkvid: { class_type: 'CreateVideo', inputs: { images: ['vdecode', 0], audio: ['adecode', 0], fps: 24, bit_depth: 8 } },
    save: { class_type: 'SaveVideo', inputs: { video: ['mkvid', 0], filename_prefix: 'reach/gen', format: 'auto', codec: 'auto' } },
  };
  if (referenceName) {
    graph.img = { class_type: 'LoadImage', inputs: { image: referenceName } };
    graph.ref.inputs['ref_images.ref_image_0'] = ['img', 0];
  }
  return graph;
}

// FLUX.1-schnell text-to-image graph, distilled from the shipped
// flux_schnell_full_text_to_image template.
function fluxT2I({ prompt, width, height, seed, steps }) {
  return {
    unet: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-schnell-Q4_K_S.gguf' } },
    clip: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors',
      clip_name2: 't5xxl_fp8_e4m3fn.safetensors', type: 'flux', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    enc: { class_type: 'CLIPTextEncodeFlux', inputs: { clip: ['clip', 0], clip_l: prompt,
      t5xxl: prompt, guidance: 3.5 } },
    neg: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['enc', 0] } },
    latent: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
    sample: { class_type: 'KSampler', inputs: { model: ['unet', 0], positive: ['enc', 0],
      negative: ['neg', 0], latent_image: ['latent', 0], seed, steps: steps ?? 4,
      cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    vdecode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['vdecode', 0], filename_prefix: 'reach/img' } },
  };
}

// A generation request is asynchronous work on the Comfy loopback service:
// upload the optional reference, queue the workflow, then poll history.
async function comfyGenerate(fetchImpl, payload, route, signal, requestId) {
  const base = gpuBridge(route.bridge).url;
  const client = async (path, options = {}) => {
    const response = await fetchImpl(`${base}${path}`, { redirect: 'error', signal, ...options });
    if (!response.ok) {
      let detail = '';
      try { detail = ` ${(await response.text()).slice(0, 300)}`; } catch { /* status alone */ }
      fail(502, 'comfy_error', `The generation backend rejected ${options.method ?? 'GET'} ${path} (${response.status}).${detail}`);
    }
    return response;
  };
  let referenceName;
  if (payload.reference) {
    const type = payload.reference.ext === 'jpg' ? 'image/jpeg' : `image/${payload.reference.ext}`;
    const form = new FormData();
    form.set('image', new Blob([payload.reference.bytes], { type }), `reach_${requestId}.${payload.reference.ext}`);
    form.set('overwrite', 'true');
    const uploaded = await (await client('/upload/image', { method: 'POST', body: form })).json().catch(() => null);
    if (!plain(uploaded) || typeof uploaded.name !== 'string' || !uploaded.name)
      fail(502, 'comfy_error', 'The generation backend refused the reference image.');
    referenceName = uploaded.name;
  }
  const builder = route.bridge.model === 'comfy/flux-schnell' ? fluxT2I : minimaxR2V;
  const workflow = builder({ ...payload, referenceName,
    seed: payload.seed ?? randomInt(0, (2 ** 48) - 1) });
  const submitted = await (await client('/prompt', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: requestId }) })).json().catch(() => null);
  if (!plain(submitted) || typeof submitted.prompt_id !== 'string' || !submitted.prompt_id)
    fail(502, 'comfy_error', 'The generation backend did not accept the workflow.');
  const promptId = submitted.prompt_id;
  const deadline = Date.now() + 15 * 60 * 1000;
  let entry = null;
  while (Date.now() < deadline) {
    if (signal.aborted) fail(408, 'request_cancelled', 'The request was cancelled.');
    const history = await (await client(`/history/${encodeURIComponent(promptId)}`)).json().catch(() => null);
    const record = plain(history) && plain(history[promptId]) ? history[promptId] : null;
    if (record) {
      const status = record.status ?? {};
      if (status.completed === true || status.status_str === 'success') { entry = record; break; }
      if (status.status_str === 'error' || plain(status.err))
        fail(502, 'generation_failed', `The generation backend failed: ${JSON.stringify(status.err ?? status.messages ?? status.status_str).slice(0, 300)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!entry) fail(504, 'generation_timeout', 'The generation did not finish in time.');
  const files = [];
  for (const node of Object.values(entry.outputs ?? {})) {
    for (const key of ['videos', 'gifs', 'images', 'audio']) {
      for (const file of node[key] ?? []) {
        if (plain(file) && typeof file.filename === 'string' && file.type === 'output')
          files.push(file.filename);
      }
    }
  }
  if (!files.length) fail(502, 'empty_response', 'The generation backend completed without producing media.');
  const data = files.map(filename => ({ filename,
    url: `/v1/media/${encodeURIComponent(promptId)}/${encodeURIComponent(filename)}` }));
  return { record: { contentType: 'application/json; charset=utf-8', body: JSON.stringify({
    id: promptId, object: `${gpuBridge(route.bridge).operation}.generation`,
    created: Math.floor(Date.now() / 1000), model: route.id, data }) } };
}

// Media reads re-verify that the file belongs to the generation record before
// streaming it out of the backend output folder.
async function comfyMedia(fetchImpl, routes, res, pathname) {
  const [, , , promptId, ...rest] = pathname.split('/');
  const filename = rest.join('/');
  const bridge = [...routes.values()].find(route => gpuBridge(route.bridge)?.media);
  if (!bridge || !/^[a-zA-Z0-9-]{8,128}$/.test(promptId ?? '') || !/^[\w][\w.-]{0,200}$/.test(filename))
    fail(404, 'media_not_found', 'The generated media is not available.');
  const base = gpuBridge(bridge.bridge).url;
  const history = await fetchImpl(`${base}/history/${encodeURIComponent(promptId)}`, { redirect: 'error' });
  let allowed = false;
  if (history.ok) {
    const record = await history.json().catch(() => null);
    const entry = plain(record?.[promptId]) ? record[promptId] : null;
    for (const node of Object.values(entry?.outputs ?? {})) {
      for (const key of ['videos', 'gifs', 'images', 'audio']) {
        for (const file of node[key] ?? []) {
          if (file?.filename === filename && file?.subfolder === 'reach' && file?.type === 'output') allowed = true;
        }
      }
    }
  }
  if (!allowed) fail(404, 'media_not_found', 'The generated media is not available.');
  const upstream = await fetchImpl(`${base}/view?filename=${encodeURIComponent(filename)}&subfolder=reach&type=output`, { redirect: 'error' });
  if (!upstream.ok) fail(404, 'media_not_found', 'The generated media is not available.');
  const body = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    'content-length': body.length, 'cache-control': 'private, max-age=3600' });
  res.end(body);
}
