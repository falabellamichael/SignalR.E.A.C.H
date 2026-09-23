'use strict';

/* Reach Studio — OpenAI-compatible chat response reader, ported from the VS
 * Code extension's chat-response.js. Keeps provider reasoning separate from
 * the answer: reasoning must never become an executable fenced tool/edit
 * block or a supposedly completed assistant reply.
 */

function textContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('');
}

function providerErrorDetails(value) {
  let current = value, code = '', status = null, retryAfterSeconds = null, retryable = null;
  const finish = message => ({ message, code, status, retryAfterSeconds, retryable });
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current === 'string') {
      const text = current.trim();
      const jsonAt = text.indexOf('{');
      if (jsonAt >= 0 && jsonAt < 32) {
        try { current = JSON.parse(text.slice(jsonAt)); continue; } catch { /* plain error text */ }
      }
      if (code === 'ECONOMY_CONCURRENCY_LIMIT') return {
        message: 'CodeGPT Economy already has an active stream on this account. Wait for it to finish or choose another configured connection for parallel team work.',
        code, status: status || 429, retryAfterSeconds, retryable: retryable ?? true,
      };
      return finish(text.replace(/\s+/g, ' ').slice(0, 400) || 'Provider request failed.');
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) break;
    if (typeof current.code === 'string') code = current.code.slice(0, 80);
    if (Number.isInteger(current.status)) status = current.status;
    if (Number.isInteger(current.retryAfterSeconds) && current.retryAfterSeconds >= 0) retryAfterSeconds = current.retryAfterSeconds;
    if (typeof current.retryable === 'boolean') retryable = current.retryable;
    if (current.error && typeof current.error === 'object') { current = current.error; continue; }
    const message = current.errorMessage || current.aiErrorMessage || current.message || current.error || current.detail;
    if (message && message !== current) { current = message; continue; }
    break;
  }
  if (code === 'ECONOMY_CONCURRENCY_LIMIT') return {
    message: 'CodeGPT Economy already has an active stream on this account. Wait for it to finish or choose another configured connection for parallel team work.',
    code, status: status || 429, retryAfterSeconds, retryable: retryable ?? true,
  };
  return finish('Provider request failed.');
}

async function readChatResponse(response, { stream = false, onText = () => {}, onReasoning = () => {}, onProgress = () => {}, signal } = {}) {
  const result = { content: '', reasoning: '', reasoningChars: 0, finishReason: null, usage: null, error: null, errorDetails: null, toolCalls: false };
  const native = new Map();
  const accept = data => {
    if (data.error) {
      result.errorDetails = providerErrorDetails(data.error);
      result.error = result.errorDetails.message;
      return;
    }
    if (data.usage) result.usage = data.usage;
    const choice = data.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    const message = choice.delta || choice.message || {};
    const reasoning = textContent(message.reasoning_content) || textContent(message.reasoning);
    if (reasoning) {
      result.reasoning += reasoning;
      result.reasoningChars += reasoning.length;
      onReasoning(result.reasoningChars);
    }
    if (message.tool_calls?.length || message.function_call) {
      result.toolCalls = true;
      if (message.tool_calls?.length && message.function_call) result.error = 'Conflicting native tool-call formats. No action was executed.';
      const calls = message.tool_calls || [{type:'function',function:message.function_call}];
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i], index = call.index ?? i;
        if (!Number.isInteger(index) || index < 0 || index >= 8 || (call.type && call.type !== 'function')) {
          result.error = 'Invalid native tool-call index or type. No action was executed.';
          continue;
        }
        const previous = native.get(index) || {type:'function',function:{name:'',arguments:''}};
        const fn = call.function || {};
        if (typeof fn.name === 'string') previous.function.name += fn.name;
        if (typeof fn.arguments === 'string' && typeof previous.function.arguments === 'string') previous.function.arguments += fn.arguments;
        else if (fn.arguments !== undefined) {
          if (previous.function.arguments !== '') result.error = 'Conflicting native arguments. No action was executed.';
          previous.function.arguments = fn.arguments;
        }
        native.set(index, previous);
      }
      result.nativeActions = [...native.entries()].sort((a,b) => a[0]-b[0]).map(([,call]) => call);
    }
    if (message.refusal) result.error = 'The provider declined this request. No action was executed.';
    const text = textContent(message.content) || textContent(message.refusal);
    if (text) { result.content += text; onText(text); }
    onProgress({ reasoningChars: result.reasoningChars, contentChars: result.content.length, toolCalls: result.toolCalls, finishReason: result.finishReason });
  };
  signal?.throwIfAborted();
  if (!stream && !/text\/event-stream/i.test(response.headers?.get('content-type') || '')) {
    const data = await response.json();
    signal?.throwIfAborted();
    accept(data);
    return result;
  }
  if (!response.body) return result;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', raw = '', sawSse = false, completed = false;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, {once:true});
  const feed = line => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    sawSse = true;
    raw = '';
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { completed = true; return; }
    if (!payload) return;
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    accept(data);
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!sawSse) raw += text;
      buffer += text;
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        feed(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 1);
        if (completed) break;
      }
      if (completed) { await reader.cancel(); break; }
    }
    const tail = decoder.decode();
    buffer += tail;
    if (!sawSse) raw += tail;
    if (buffer && !completed) feed(buffer); // An EOF without a final newline is still data.
    if (!sawSse && raw.trim()) {
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('The endpoint returned an unreadable response instead of chat data.'); }
      accept(data); // Some endpoints ignore stream:true and return ordinary JSON.
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    error.partialResponse = !!result.content || result.toolCalls;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  return result;
}

function transportErrorCode(error) {
  const pending = [error], seen = new Set();
  while (pending.length) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(item.code)) return item.code;
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors);
  }
  return '';
}

function isTransientTransportError(error) {
  if (error?.name === 'AbortError') return false;
  const code = transportErrorCode(error);
  return ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
    'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(code)
    || (!code && ['fetch failed', 'terminated'].includes(error?.message));
}

function transportDiagnostic(error, url) {
  const code = transportErrorCode(error);
  const details = {
    UND_ERR_HEADERS_TIMEOUT: 'Timed out waiting for the endpoint to begin its HTTP response',
    UND_ERR_BODY_TIMEOUT: 'Timed out waiting for more response data from the endpoint',
    UND_ERR_CONNECT_TIMEOUT: 'Timed out establishing the connection',
    UND_ERR_SOCKET: 'The connection closed before the response finished',
    ECONNRESET: 'The connection was reset before the response finished',
    ECONNREFUSED: 'The endpoint refused the connection',
    ETIMEDOUT: 'The network connection timed out',
    EAI_AGAIN: 'DNS lookup temporarily failed',
    ENOTFOUND: 'The endpoint hostname could not be resolved',
  };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* URL is optional. */ }
  return (details[code] || 'The request connection failed') + (host ? ' (' + host + ')' : '')
    + (code ? ' [' + code + ']' : '') + '.';
}

function waitForRetry(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function emptyReplyDiagnostic(reply, model) {
  const name = model || 'The selected model';
  if (reply.toolCalls) return `${name} returned native tool calls without an answer. REACH requested text tool blocks; this model's tool format is incompatible.`;
  if (reply.finishReason === 'content_filter') return `${name} returned no answer because the provider filtered the response.`;
  const limit = reply.finishReason === 'length' ? ' The provider reached its output token limit before finishing.' : '';
  if (reply.reasoningChars) return `${name} returned reasoning (${reply.reasoningChars} characters) but no final answer.${limit}`;
  const generated = Number(reply.usage?.completion_tokens);
  if (generated > 0) return `${name}: the provider reported ${generated} generated tokens but delivered no answer text.${limit}`;
  return `${name} returned no answer.${limit || (reply.finishReason ? ' Finish reason: ' + reply.finishReason + '.' : ' The response ended without any answer text.')}`;
}

module.exports = { readChatResponse, emptyReplyDiagnostic, providerErrorDetails, transportErrorCode, isTransientTransportError, transportDiagnostic, waitForRetry };
