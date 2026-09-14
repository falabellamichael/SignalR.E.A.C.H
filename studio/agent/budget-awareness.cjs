'use strict';

// Tokenization is provider-specific. This is a soft planning/streaming reserve;
// max_tokens remains the actual per-request cap sent to the endpoint.
function budgetPolicy({ maxTokens, purpose, budgets, round = 1, contextChars = 0, concise = false }) {
  const lines = ['REQUEST BUDGET:'];
  if (maxTokens > 0) {
    const answer = Math.max(1, Math.ceil(maxTokens * .4));
    lines.push(`Hard output allowance: ${maxTokens} tokens for this request, including hidden reasoning when the provider shares that allowance.`,
      `Reserve at least ${answer} tokens for the visible ${purpose === 'summary' ? 'memory' : 'response and complete response-format JSON'}. Spend at most ${maxTokens - answer} tokens on reasoning; stop reasoning sooner when you can answer.`,
      'Use the available budget for useful substance and verification. Fit the complete response inside it; do not pad text merely to consume tokens. Put the result first, then the most useful evidence.');
  } else lines.push('No application output cap is set. The provider chooses its own limit; do not assume unlimited output. Reserve space for a complete visible response.');
  if (purpose !== 'summary') {
    lines.push('Prefer a small executable action batch over lengthy planning. Never truncate JSON, code edits, or tool arguments. Use smaller edits and reread source as needed.');
    if (budgets.maxRounds > 0) {
      const remaining = Math.max(0, budgets.maxRounds - round + 1);
      lines.push(`Round ${round} of ${budgets.maxRounds}; ${remaining} request round(s) remain, including this one.`);
      if (remaining <= 1) lines.push('This is the last permitted round. Report verified results now. If unfinished, return blocked with completed work and concrete remaining steps. Do not begin a tool batch that needs another round; never falsely claim completion.');
    }
    lines.push(`Current input size is approximately ${contextChars} characters; this is not an exact provider token count.`,
      budgets.autoCompact ? 'Older context may be compressed between requests. Keep exact paths, decisions, results and unfinished work in your plan and reports.' : 'Automatic context compression is off. Avoid redundant tool output.');
  }
  if (budgets.requestTimeoutMs > 0) lines.push(`The request deadline is ${Math.ceil(budgets.requestTimeoutMs / 1000)} seconds. Produce the answer promptly rather than prolonged silent reasoning.`);
  if (concise || maxTokens > 0 && maxTokens <= 1024) lines.push('Use minimal reasoning. Return a short complete response immediately; skip introductions and repeated analysis.');
  return lines.join('\n');
}
function reserveGuard(maxTokens) {
  // Only interrupt an unfinished reasoning-only stream; an answer or native
  // action already arriving, and complete JSON responses, are never cut off here.
  const threshold = maxTokens > 0 ? Math.max(1, Math.floor(maxTokens * .6 * 3)) : Infinity;
  return progress => {
    if (!progress.finishReason && !progress.contentChars && !progress.toolCalls && progress.reasoningChars >= threshold) {
      const error = new Error('Reasoning reached the estimated output reserve.');
      error.code = 'REACH_OUTPUT_RESERVE';
      error.reasoningChars = progress.reasoningChars;
      throw error;
    }
  };
}
function checkpoint({ maxTokens, results = [], todos = [], pendingEdits = {}, cause = 'output' }) {
  const allowance = maxTokens > 0 ? `${maxTokens.toLocaleString()}-token per-request allowance` : 'provider output allowance';
  const lines = ['REACH budget checkpoint', '', cause === 'round'
    ? 'The configured round budget has been reached. The task is saved and remains unfinished.'
    : `The model could not finish a usable response within the ${allowance}, including one concise retry. The unfinished response was not executed.`];
  if (results.length) {
    lines.push('', 'Actions actually recorded this turn:');
    for (const entry of results.slice(-8)) {
      const target = entry.path ? ` (${entry.path})` : '';
      lines.push(`- ${entry.tool}${target}: ${entry.pending ? 'awaiting review; not applied' : entry.ok ? 'succeeded' : 'failed'}.`);
    }
    if (results.length > 8) lines.push(`${results.length - 8} earlier actions are retained in the chat history.`);
  } else lines.push('', 'No tools were executed in this turn.');
  const open = todos.filter(t => !['completed', 'cancelled'].includes(t.status));
  if (open.length) lines.push('', 'Remaining plan:', ...open.slice(0, 8).map(t => '- ' + t.text));
  const pending = Object.keys(pendingEdits).length;
  if (pending) lines.push('', `${pending} proposed edit(s) still require review.`);
  lines.push('', 'Your conversation and tool results are saved. Continue to resume, or adjust the budget in Settings → Budgeting.');
  return { content: JSON.stringify({ status: 'blocked', message: lines.join('\n'), actions: [], options: [] }), budgetFallback: true };
}
module.exports = { budgetPolicy, reserveGuard, checkpoint };
