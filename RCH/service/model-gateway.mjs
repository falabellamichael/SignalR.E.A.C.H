import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { modelUsdPricing, requestReplay } from './store.mjs';

const MAX_BODY = 512 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_EVENT = 256 * 1024;
const FIELDS = new Set(['model', 'messages', 'stream', 'stream_options', 'max_tokens',
  'max_completion_tokens', 'temperature', 'top_p', 'stop', 'presence_penalty',
  'frequency_penalty', 'seed', 'n', 'tools', 'tool_choice', 'parallel_tool_calls',
  'response_format']);
const REQUEST_FIELDS = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens']);
const BRIDGE_URLS = Object.freeze({
  tray: 'http://127.0.0.1:21302/v1/chat/completions',
  codegpt: 'http://127.0.0.1:21300/v1/chat/completions',
});

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
    message: safe ? error.message : 'The model request could not be completed.', type: 'reach_service_error' } };
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
        || !integer(model.maxInputBytes, 1, MAX_BODY) || !validModel
        || Object.keys(bridge).some(key => !['kind', 'model'].includes(key))
        || model.pricing !== undefined || model.upstreamModel !== undefined) {
        throw new Error('Invalid subscription bridge model configuration.');
      }
      routes.set(model.id, Object.freeze({ ...model, bridge: Object.freeze({ ...bridge }) }));
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
    routes.set(model.id, Object.freeze({ ...model }));
  }
  return routes;
}

function completionRequest(body, routes) {
  if (!plain(body) || Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) fail(400, 'invalid_request', 'Invalid completion request.');
  if (Object.keys(body).some(k => !FIELDS.has(k))) fail(400, 'unsupported_field', 'This request includes unsupported fields.');
  const route = routes.get(body.model);
  if (!route || route.metered !== true) fail(404, 'model_unavailable', 'This model is not available for metered access.');
  if (route.access === 'requests') return bridgeRequest(body, route);
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

function bridgeRequest(body, route) {
  if (Object.keys(body).some(key => !REQUEST_FIELDS.has(key))) {
    fail(400, 'unsupported_field', 'Subscription bridges support text messages and streaming; other generation controls are unsupported.');
  }
  const roles = route.bridge.kind === 'codegpt' ? ['system', 'user', 'assistant'] : ['system', 'developer', 'user', 'assistant'];
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 100
    || body.messages.some(message => !plain(message) || !roles.includes(message.role)
      || typeof message.content !== 'string' || Object.keys(message).some(key => !['role', 'content'].includes(key)))
    || !body.messages.some(message => message.content.trim())) {
    fail(400, 'text_only', 'Subscription bridges accept text messages only, without tools or hosted actions.');
  }
  if (Buffer.byteLength(JSON.stringify(body.messages)) > route.maxInputBytes) {
    fail(400, 'input_too_large', 'Input exceeds this model’s configured text size limit.');
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
  fetchImpl = globalThis.fetch, timeoutMs = 120_000, maxConcurrency = 6 }) {
  const routes = configureModels(models);
  const requestRoutes = [...routes.values()].some(route => route.access === 'requests');
  if (requestRoutes && (!plain(subscription) || !plain(subscription.basic)
    || !integer(subscription.basic.includedRequests, 1, Number.MAX_SAFE_INTEGER)
    || !integer(subscription.overageUsdMicrosPerRequest, 0, Number.MAX_SAFE_INTEGER)
    || ['reserveRequest', 'settleRequest', 'releaseRequest', 'markRequestUncertain'].some(name => typeof store?.[name] !== 'function'))) {
    throw new Error('Subscription request pricing and durable request store methods are required.');
  }
  const legacyRoutes = routes.size === 0 || [...routes.values()].some(route => route.access !== 'requests');
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
  if (!integer(timeoutMs, 100, 600_000) || !integer(maxConcurrency, 1, 100)) throw new Error('Invalid gateway limits.');
  let active = 0;
  const eligible = account => new Set((account.allowedModels || []).map(m => typeof m === 'string' ? m : m.id));
  const catalog = account => ({ object: 'list', data: [...routes.values()]
    .filter(m => m.metered === true && eligible(account).has(m.id))
    .map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'reach', name: m.name || m.id, provider: m.provider,
      ...(m.access === 'requests' ? { access: 'requests', capabilities: { outputTokenLimit: false },
        pricing: { unit: 'request', includedRequests: subscription.basic.includedRequests,
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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      const { payload, route, amount, reserveUsage, fingerprint } = completionRequest(body ?? await readJson(req), routes);
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
      const upstream = await fetchImpl(requestMode ? BRIDGE_URLS[route.bridge.kind] : completionUrl, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: requestMode ? { 'content-type': 'application/json', 'cache-control': 'no-store' }
          : { 'content-type': 'application/json', authorization: `Bearer ${upstreamKey}`,
            'x-reach-metered': 'provider-v1', 'cache-control': 'no-store' }, body: JSON.stringify(payload),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
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
        record = await bridgeResponse(upstream, payload, route, controller.signal);
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
      controller.abort();
      if (counted) active -= 1;
    }
  }
  return { handle, catalog };
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
    choices: parsed.choices.map(choice => ({ index: choice.index ?? 0, delta: choice.message || {}, finish_reason: choice.finish_reason })) };
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
