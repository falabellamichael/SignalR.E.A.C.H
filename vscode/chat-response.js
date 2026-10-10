'use strict';

// Keep provider reasoning separate from the answer: it must never become an
// executable fenced tool/edit block or a supposedly completed assistant reply.
function textContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('');
}

/* The body's BYTES decide the wire format — never the stream hint or the
 * content-type header, which providers lie about. Three shapes are accepted:
 *   SSE     `data:` events; consecutive data lines join into one record (a
 *           malformed event must not swallow the next valid record, so the
 *           joined parse falls back to line-by-line)
 *   NDJSON  one JSON record per line (record-by-record until EOF)
 *   JSON    an ordinary document, reassembled across newlines and resolved as
 *           soon as its braces balance — without waiting for EOF
 * A complete answer (balanced JSON, a [DONE], or a JSON error document)
 * resolves and cancels the still-open body; Stop rejects with the signal's
 * AbortError and flags whatever had already arrived. */
async function readChatResponse(response, { stream = false, onText = () => {}, onReasoning = () => {}, signal } = {}) {
  const result = { content: '', reasoningChars: 0, finishReason: null, usage: null, error: null, toolCalls: false };
  const native = new Map();
  const accept = data => {
    if (data.error) {
      result.error = typeof data.error === 'string' ? data.error : data.error.message || 'Provider request failed.';
      return;
    }
    if (data.usage) result.usage = data.usage;
    const choice = data.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    const message = choice.delta || choice.message || {};
    const reasoning = textContent(message.reasoning_content) || textContent(message.reasoning);
    if (reasoning) {
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
  };
  signal?.throwIfAborted();
  if (!response.body) {
    const data = await response.json(); // Legacy adapters expose only .json().
    signal?.throwIfAborted();
    accept(data);
    return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = '', jsonText = '', jsonState = { depth: 0, inString: false, escaped: false };
  let sawSse = false, sseLines = [], completed = false, firstChunk = true;
  const scanJson = (text, state) => {
    let { depth, inString, escaped } = state;
    for (const ch of text) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
    return { depth, inString, escaped };
  };
  const cancelBody = () => { reader.cancel().catch(() => {}); };
  const onAbort = () => cancelBody();
  signal?.addEventListener('abort', onAbort, {once:true});
  const readChunk = () => new Promise((resolve, reject) => {
    const onChunkAbort = () => reject(signal.reason);
    signal?.addEventListener('abort', onChunkAbort, { once: true });
    reader.read().then(
      value => { signal?.removeEventListener('abort', onChunkAbort); resolve(value); },
      error => { signal?.removeEventListener('abort', onChunkAbort); reject(error); },
    );
  });
  const finishSseEvent = () => {
    const lines = sseLines; sseLines = [];
    if (!lines.length) return;
    let data = null, parsed = false;
    try { data = JSON.parse(lines.join('\n')); parsed = true; } catch { /* split event */ }
    if (parsed) { accept(data); return; } // A guard rejection here must propagate.
    for (const line of lines) {
      let single = null, singleParsed = false;
      try { single = JSON.parse(line); singleParsed = true; } catch { /* provider chatter */ }
      if (singleParsed) accept(single);
    }
  };
  const feedLine = line => {
    line = line.replace(/^\uFEFF/, '').replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      sawSse = true;
      let payload = trimmed.slice(5);
      if (payload.startsWith(' ')) payload = payload.slice(1);
      if (payload === '[DONE]') { finishSseEvent(); completed = true; return; }
      sseLines.push(payload);
      return;
    }
    if (sawSse) {
      if (!trimmed) finishSseEvent(); // A blank line ends the current event.
      return; // event:/id:/retry: fields and comments carry no payload.
    }
    if (!trimmed) { jsonText += '\n'; return; }
    if (jsonText === '' && (trimmed[0] === '{' || trimmed[0] === '[')) {
      let data = null, parsed = false;
      try { data = JSON.parse(trimmed); parsed = true; } catch { /* a document start: accumulate */ }
      if (parsed) {
        accept(data);
        // A standalone error document ends the exchange; a record stream (NDJSON)
        // keeps flowing until EOF.
        if (data.error) completed = true;
        return;
      }
    }
    jsonText += (jsonText ? '\n' : '') + line;
    jsonState = scanJson(line, jsonState);
    if (jsonState.depth <= 0 && !jsonState.inString) {
      let data;
      try { data = JSON.parse(jsonText); } catch { return; }
      jsonText = '';
      jsonState = { depth: 0, inString: false, escaped: false };
      accept(data);
      completed = true; // A balanced document is complete without EOF.
    }
  };
  /* A provider may deliver the final line of a JSON document without its
   * trailing newline and leave the body open. Probe the pending tail: a
   * genuinely partial line simply fails to parse and keeps waiting. */
  const probeTail = () => {
    if (completed || sawSse || lineBuffer.trim() === '') return;
    if (jsonText !== '') {
      const probe = scanJson('\n' + lineBuffer, jsonState);
      if (probe.depth <= 0 && !probe.inString) {
        let data = null;
        try { data = JSON.parse(jsonText + '\n' + lineBuffer); } catch { /* still partial */ }
        if (data !== null) {
          jsonText = '';
          jsonState = { depth: 0, inString: false, escaped: false };
          lineBuffer = '';
          accept(data);
          completed = true;
        }
      }
      return;
    }
    let data = null, parsed = false;
    try { data = JSON.parse(lineBuffer.trim()); parsed = true; } catch { /* still writing */ }
    if (parsed && data.error) { // A lone error document ends the exchange.
      jsonState = { depth: 0, inString: false, escaped: false };
      lineBuffer = '';
      accept(data);
      completed = true;
    }
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await readChunk();
      signal?.throwIfAborted();
      if (done) break;
      let text = decoder.decode(value, { stream: true });
      if (firstChunk) { firstChunk = false; text = text.replace(/^\uFEFF/, ''); }
      lineBuffer += text;
      let cut;
      while ((cut = lineBuffer.indexOf('\n')) >= 0) {
        feedLine(lineBuffer.slice(0, cut));
        lineBuffer = lineBuffer.slice(cut + 1);
        if (completed) break;
      }
      probeTail();
      if (completed) { await reader.cancel().catch(() => {}); break; }
    }
    // Once the answer completed ([DONE], a balanced document or an error
    // document), anything still buffered after it is not part of the answer.
    if (!completed) {
      const tail = decoder.decode();
      if (tail || lineBuffer) { lineBuffer += tail; feedLine(lineBuffer); lineBuffer = ''; }
      finishSseEvent(); // An unterminated event ends with the body.
    }
    if (!completed && !sawSse && jsonText.trim()) {
      let data;
      try { data = JSON.parse(jsonText); }
      catch { throw new Error('The endpoint returned an unreadable response instead of chat data.'); }
      accept(data); // Ordinary JSON that only completed at EOF.
    }
  } catch (error) {
    // A partial answer or tool call must never be automatically replayed.
    if (signal?.aborted) error = signal.reason;
    await reader.cancel().catch(() => {});
    error.partialResponse = !!result.content || result.toolCalls;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return result;
}

// Fetch wraps useful socket/parser errors in TypeError("fetch failed"). Keep
// diagnostics to known codes: nested messages can contain URLs or credentials.
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

module.exports = { readChatResponse, emptyReplyDiagnostic, transportErrorCode, isTransientTransportError, transportDiagnostic, waitForRetry };
