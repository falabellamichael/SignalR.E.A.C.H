'use strict';

// Measure the actual normalized wire envelope, including JSON escaping. The
// byte allowance is a gateway fact, separate from a model's token window.
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
function measureRequest(body) {
  const messagesBytes = bytes(body.messages || []);
  const toolBytes = body.tools ? bytes(body.tools) : 0;
  const formatBytes = body.response_format ? bytes(body.response_format) : 0;
  // Without a provider tokenizer UTF-8 bytes are a deliberately conservative
  // estimate, not a claim about the provider's exact token count.
  return { messagesBytes, requestFieldsBytes: bytes({ messages: body.messages, tools: body.tools, response_format: body.response_format }), requestBytes: bytes(body), inputTokens: messagesBytes + toolBytes + formatBytes,
    outputTokens: Math.max(0, body.max_tokens || 0) };
}
function inputLimitFromError(text, status) {
  if (![400, 413, 422].includes(status)) return null;
  let value;
  try { value = JSON.parse(text); } catch { value = {}; }
  const detail = value.error && typeof value.error === 'object' ? value.error : value;
  const field = key => detail[key] ?? value[key];
  const positive = key => Number.isSafeInteger(field(key)) && field(key) > 0 ? field(key) : undefined;
  const maxInputBytes = positive('max_input_bytes');
  const maxInputTokens = positive('max_input_tokens');
  const contextTokens = positive('context_window') || positive('context_length');
  const overflow = maxInputBytes || maxInputTokens || contextTokens
    || /context[_ ](length[_ ]exceeded|window|limit)|maximum context|too many (input )?tokens|input.*(too long|token limit|exceeds.*(?:text size|input|context).*limit)|(?:text size|input size).*limit/i.test(String(text));
  if (!overflow) return null;
  // A byte error without scope does not justify assuming it measures messages.
  const scope = field('input_limit_scope');
  return { ...(maxInputBytes && ['messages', 'request_fields', 'request', 'body'].includes(scope) ? { maxInputBytes, inputLimitScope: scope === 'body' ? 'request' : scope } : {}),
    ...(maxInputTokens ? { maxInputTokens } : {}), ...(contextTokens ? { contextTokens } : {}) };
}
function budgetUsage(body, limits = {}) {
  const measured = measureRequest(body);
  const checks = [];
  const byteLimits = limits.inputByteLimits || [{ limit: limits.maxInputBytes, scope: limits.inputLimitScope }];
  for (const { limit, scope } of byteLimits) {
    if (limit > 0 && ['messages', 'request_fields', 'request'].includes(scope)) checks.push({ unit: 'UTF-8 bytes', used: scope === 'request' ? measured.requestBytes : scope === 'request_fields' ? measured.requestFieldsBytes : measured.messagesBytes, limit });
  }
  if (limits.maxInputTokens > 0) checks.push({ unit: 'estimated input tokens', used: measured.inputTokens, limit: limits.maxInputTokens });
  if (limits.contextTokens > 0) checks.push({ unit: 'estimated context tokens including output reserve', used: measured.inputTokens + measured.outputTokens, limit: limits.contextTokens });
  return checks;
}
function budgetExceeded(body, limits) { return budgetUsage(body, limits).find(check => check.used > check.limit) || null; }
function budgetRatio(body, limits) { return Math.max(0, ...budgetUsage(body, limits).map(check => check.used / check.limit)); }
function fitError(message = 'Pinned instructions and the original/latest request cannot fit the endpoint input allowance.') {
  const error = new Error(message + ' Saved conversation and tool results are intact. Shorten the latest request or choose a connection with a larger input allowance, then resume.');
  error.code = 'REACH_INPUT_BUDGET';
  return error;
}
module.exports = { measureRequest, inputLimitFromError, budgetUsage, budgetExceeded, budgetRatio, fitError };
