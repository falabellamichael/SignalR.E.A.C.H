'use strict';

// Jev only judges whether the already selected local symbols are worth adding
// to this answer. It never chooses a model, grants tools, or receives source.
const API_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_QUERY_CHARS = 500;

function recentQuery(messages) {
  const user = (Array.isArray(messages) ? messages : []).slice().reverse()
    .find(m => m.role === 'user' && !m._reachMeta?.source && typeof m.content === 'string');
  const content = user?.content?.trim() || '';
  // A long request may contain pasted code or private documents. Its first
  // fragment is also a poor basis for safely omitting code context.
  return content.length <= MAX_QUERY_CHARS ? content : '';
}

function explicitlyRequested(query, symbols) {
  const lower = query.toLowerCase();
  return symbols.some(symbol => {
    const name = String(symbol.name || '').toLowerCase();
    const shortName = name.split('.').pop();
    const file = String(symbol.path || '').replace(/\\/g, '/').toLowerCase();
    const basename = file.split('/').pop();
    return (name.length >= 4 && lower.includes(name)) || (shortName?.length >= 4 && lower.includes(shortName))
      || (basename?.length >= 5 && lower.includes(basename)) || (file.length >= 5 && lower.includes(file));
  });
}

async function decideContext({ apiKey, query, symbols, signal, fetchImpl = fetch }) {
  if (!apiKey) return { inject: true, reason: 'missing-key' };
  if (!query) return { inject: true, reason: 'unusable-request' };
  if (!symbols?.length) return { inject: true, reason: 'no-candidates' };
  // Follow-ups need conversation context which this small request deliberately
  // does not include. Keep source available without spending a Jev call.
  const followup = /^(?:please\s+)?(?:yes|no|ok(?:ay)?|continue|proceed|go ahead|do (?:it|that)|try again)\b/i.test(query.trim());
  if (query.trim().length < 20 || followup || explicitlyRequested(query, symbols)) return { inject: true, reason: 'explicit-or-vague' };
  const state = {
    conversation: query.slice(0, MAX_QUERY_CHARS),
    candidate_symbols: symbols.slice(0, 12).map(s => ({ name: String(s.name || '').slice(0, 100), path: String(s.path || '').slice(0, 180), kind: String(s.kind || '').slice(0, 40) })),
  };
  const deadline = AbortSignal.timeout(2500);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest', state,
        questions: { use_code_context: {
          type: 'noul',
          instructions: 'Will the candidate code symbols help answer or carry out the current user request? Answer true when code context may be useful, including implementation, debugging, and questions about project behavior. Answer false only for clear non-code requests such as greetings or general knowledge.',
          criteria: { true: 'The candidate code symbols could help this request.', false: 'The candidate code symbols have no useful connection to this request.' },
        } },
      }),
      signal: requestSignal,
    });
    if (!response.ok) return { inject: true, reason: `http-${response.status}` };
    const data = await response.json();
    const answer = data?.answers?.use_code_context;
    const probability = answer?.noul;
    const validCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const inputTokens = validCount(data?.usage?.input_tokens);
    const outputTokens = validCount(data?.usage?.output_tokens);
    const usage = inputTokens !== null && outputTokens !== null
      ? { inputTokens, outputTokens } : null;
    if (answer?.type !== 'noul' || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { inject: true, reason: 'invalid-response', usage };
    }
    return { inject: probability > 0.1, reason: probability <= 0.1 ? 'jev-skip' : 'jev-keep', probability, usage };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { inject: true, reason: 'request-failed' };
  }
}

module.exports = { decideContext, recentQuery, explicitlyRequested };
