import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { modelUsdPricing, requestReplay } from './store.mjs';
import { gpuBridge, hostedGpuModel, requestCapabilities } from './gpu-bridge.mjs';
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

export class GatewayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new GatewayError(status, code, message); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
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
  if (Object.keys(body).some(k => !FIELDS.has(k))) fail(400, 'unsupported_field', 'This request includes unsupported fields.');
  const route = routes.get(body.model);
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
  const result = bridgeRequest(textBody, route);
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
    ...generation };
  if (route.bridge.model === 'google/gemma-4-12B-it-qat-q4_0-unquantized' && result.payload.tools !== undefined) {
    result.payload.tools = compatibleGemmaTools(result.payload.tools);
  }
  // A hidden thinking trace is generated before message content. Action calls
  // need that content to be the JSON object, so those requests answer directly.
  const actionReply = format !== undefined || result.payload.messages.some(message => message.role === 'system'
    && message.content.includes('EXECUTABLE ACTION RESPONSE:'));
  if (actionReply) result.payload.chat_template_kwargs = { ...generation.chat_template_kwargs, enable_thinking: false };
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
    const pathname = new URL(req.url, 'http://gateway.invalid').pathname;
    if (req.method === 'GET' && pathname === '/v1/models') { responseJson(res, 200, catalog(account)); return; }
    if (req.method !== 'POST' || pathname !== '/v1/chat/completions') { responseJson(res, 404, errorBody(new GatewayError(404, 'not_found', 'Route not found.'))); return; }
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
      const { payload, route, amount, reserveUsage, fingerprint } = completionRequest(body ?? await readJson(req), routes);
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
          res.writeHead(200, { 'content-type': reservation.replay.contentType, 'cache-control': 'no-store', 'x-reach-replayed': 'true' });
          res.end(reservation.replay.body);
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
      const upstream = await fetchImpl(requestMode ? gpuBridge(route.bridge).url : completionUrl, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: requestMode ? { 'content-type': 'application/json', 'cache-control': 'no-store' }
          : { 'content-type': 'application/json', authorization: `Bearer ${upstreamKey}`,
            'x-reach-metered': 'provider-v1', 'cache-control': 'no-store' },
        body: JSON.stringify(gpuBridge(route.bridge) ? { ...payload, stream: false } : payload),
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
      let record;
      let usage;
      if (requestMode) {
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
      if (res.headersSent) { res.end('data: [DONE]\n\n'); }
      else {
        res.writeHead(200, { 'content-type': record.contentType, 'cache-control': 'no-store' });
        res.end(record.body);
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

async function forwardStream(upstream, res, model, signal) {
  if (!upstream.body) fail(502, 'empty_response', 'The provider returned no stream.');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let bufferSize = 0;
  let doneReceived = false;
  let usage = null;
  let body = '';
  let seenFinish = false;
  const send = async (event) => {
    if (res.destroyed || signal.aborted) fail(502, 'stream_interrupted', 'The model stream was interrupted.');
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    body += event;
    if (Buffer.byteLength(body) > MAX_RESPONSE - 64) fail(502, 'response_too_large', 'The model response exceeded the service size limit.');
    if (!res.write(event)) await once(res, 'drain', { signal });
  };
  const processEvent = async (raw) => {
    const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (doneReceived) fail(502, 'invalid_provider_stream', 'The provider sent data after stream completion.');
    if (data.trim() === '[DONE]') { doneReceived = true; return; }
    let parsed;
    try { parsed = JSON.parse(data); } catch { fail(502, 'invalid_provider_stream', 'The provider returned an invalid stream.'); }
    if (!plain(parsed) || parsed.error) fail(502, 'provider_stream_error', 'The provider could not complete the stream. Usage is pending reconciliation.');
    const reported = providerUsage(parsed);
    if (reported) {
      if (usage && canonical(usage) !== canonical(reported)) fail(502, 'ambiguous_usage', 'The provider reported conflicting usage records.');
      usage = reported;
    }
    if (Array.isArray(parsed.choices) && parsed.choices.some(c => c.finish_reason !== null && c.finish_reason !== undefined)) seenFinish = true;
    if (!Array.isArray(parsed.choices)) fail(502, 'invalid_provider_stream', 'The provider returned an invalid stream event.');
    await send(`data: ${JSON.stringify(completionOutput(parsed, model))}\n\n`);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { pending += decoder.decode(); break; }
      bufferSize += value.byteLength;
      if (bufferSize > MAX_RESPONSE * 2) fail(502, 'response_too_large', 'The model stream exceeded the service size limit.');
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
    return { record: { contentType: 'text/event-stream', body: `${body}data: [DONE]\n\n` }, usage };
  } finally { await reader.cancel().catch(() => {}); }
}
