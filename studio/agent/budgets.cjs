'use strict';

// One schema for validation, the settings form, and every execution path.
// Zero is an explicit absence of an application cap, never a missing value.
const fields = [
  ['maxTokens', 'Output tokens per request', 16384, 'Generation', 'Includes shared reasoning tokens. Studio reserves room for a response and may make one concise retry with the same per-request cap. 0 omits max_tokens; the provider chooses its default, which may still be small.'],
  ['requestTimeoutMs', 'Request timeout (milliseconds)', 180000, 'Generation', 'Covers connection and streaming. 0 waits until completion or Stop.'],
  ['maxRounds', 'Rounds per conversation / team member', 40, 'Execution', 'A round is a model request plus its actions. 0 continues until completion, input, failure, or Stop.'],
  ['subagentMaxRounds', 'Rounds per spawned agent', 12, 'Execution', '0 removes the spawned worker round cap.'],
  ['resumeCycles', 'Review / question resumptions per team member', 6, 'Execution', '0 allows any number of user review and question pauses.'],
  ['approvalTimeoutMs', 'Action approval wait (milliseconds)', 300000, 'Execution', '0 keeps the approval request pending until you respond or stop the run.'],
  ['questionTimeoutMs', 'Team question wait (milliseconds)', 300000, 'Execution', '0 lets team members wait for your answer until you stop the run.'],
  ['teamConcurrency', 'Parallel roster members', 3, 'Teams', '0 starts the whole roster concurrently. Spawned agents run independently.'],
  ['maxAgents', 'Total agents per team run', 12, 'Teams', 'Counts roster and spawned agents, including finished agents. 0 removes the population cap.'],
  ['maxDepth', 'Subagent nesting depth', 2, 'Teams', '0 allows unlimited nesting. Circular waits remain blocked.'],
  ['awaitTimeoutMs', 'Default peer wait (milliseconds)', 120000, 'Teams', '0 waits until completion or Stop. An agent can still request a shorter wait.'],
  ['relayChars', 'Chain handoff characters', 24000, 'Teams', '0 relays all completed member reports. Display previews remain bounded for responsiveness.'],
  ['autoCompact', 'Automatically compress conversation context', true, 'Context', 'Turn off to send the full retained conversation. The provider context window still applies.'],
  ['contextTrigger', 'Compress above this many characters', 96000, 'Context', 'Character estimate, not tokens. 0 disables this trigger.'],
  ['contextMessages', 'Compress above this many messages', 48, 'Context', '0 disables the message-count trigger.'],
  ['contextTarget', 'Target characters after compression', 48000, 'Context', 'Must be at least 8,000; automatically kept below a nonzero character trigger.', 8000],
  ['summaryTokens', 'Output tokens for context compression', 16384, 'Context', 'Separate budget so reasoning can finish before writing memory. 0 uses the provider default.'],
  ['codeContext', 'Inject codebase context into prompts', true, 'Context', 'Retrieves the most relevant symbol definitions from the local project index and adds them to each request. Off sends only the conversation.'],
  ['codeContextChars', 'Codebase context characters per request', 6000, 'Context', 'Upper bound on injected source text. Skipped entirely once the conversation is at the compression trigger. 0 disables injection.', 0],
  ['storedMessages', 'Retained messages per conversation', 0, 'History', '0 keeps the complete chat. Context compression never replaces saved history. Lowering this applies on the next appended message.'],
  ['maxConversations', 'Saved conversations', 200, 'History', '0 removes the saved-chat count cap. Existing chats are never deleted by this setting.'],
].map(([key, label, value, group, help, min = 0]) => ({ key, label, value, group, help, min, globalOnly: key === 'maxConversations', type: typeof value === 'boolean' ? 'boolean' : 'number' }));
const defaults = Object.fromEntries(fields.map(f => [f.key, f.value]));
const presets = {
  balanced: { ...defaults },
  heavy: { ...defaults, maxTokens: 32768, requestTimeoutMs: 900000, maxRounds: 200, subagentMaxRounds: 100, resumeCycles: 30, maxAgents: 32, maxDepth: 8, relayChars: 120000, contextTrigger: 480000, contextTarget: 240000, contextMessages: 144, storedMessages: 0, maxConversations: 0, codeContextChars: 12000 },
  unrestricted: { ...Object.fromEntries(fields.map(f => [f.key, f.type === 'boolean' ? false : f.min])), contextTarget: 120000 },
};
function validateBudgets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Budgets must be an object.');
  const result = {};
  for (const f of fields) {
    if (!Object.hasOwn(value, f.key)) continue;
    const v = value[f.key];
    if (f.type === 'boolean' ? typeof v !== 'boolean' : !Number.isSafeInteger(v) || v < f.min || v > 2147483647) {
      throw new Error(`${f.label}: enter ${f.type === 'boolean' ? 'true or false' : `a whole number from ${f.min} to 2147483647`}.`);
    }
    result[f.key] = v;
  }
  return result;
}
function resolveBudgets(global = {}, settings = {}) {
  // Legacy chat caps remain effective until global budgeting is configured.
  const legacy = global.budgets ? {} : Object.fromEntries(['maxTokens', 'maxRounds'].filter(k => Number.isSafeInteger(settings[k]) && settings[k] >= 0).map(k => [k, settings[k]]));
  return { ...defaults, ...legacy, ...validateBudgets(global.budgets || {}), ...validateBudgets(settings.budgetOverrides || {}) };
}
const cap = value => value === 0 ? Infinity : value;
module.exports = { fields, defaults, presets, validateBudgets, resolveBudgets, cap };
