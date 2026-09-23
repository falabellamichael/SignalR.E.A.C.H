'use strict';

// One schema for validation, the settings form, and every execution path.
// Zero is an explicit absence of an application cap, never a missing value.
//
// GLOBAL-ONLY FIELDS. A budget field is either per-conversation or app-wide,
// and the difference is not cosmetic.
//
// Most fields describe ONE agent's run, so overriding them per conversation is
// the point. These do not:
//
//   maxConversations  the saved-chat limit is a property of the history store
//   requestPacing     the pace is shared per provider ORIGIN (agent/rate-limit.cjs),
//   requestPacingRpm  so it belongs to the endpoint, not to one of the agents using it
//
// A per-conversation override of a shared setting is not a preference, it is a
// race: two conversations writing different values into one shared gate, last
// writer winning per request. So 'global only' is enforced HERE, in the one
// resolver every execution path reads, not only in the settings UI — a
// hand-written IPC call must not be able to reach around it either.
//
// Declared before `fields` because the schema's globalOnly flag is derived from
// it at module load (a later const would be in the temporal dead zone).
const GLOBAL_ONLY_KEYS = new Set(['maxConversations', 'requestPacing', 'requestPacingRpm']);

const fields = [
  ['maxTokens', 'Output tokens per request', 16384, 'Generation', 'Includes shared reasoning tokens. Studio reserves room for a response and may make one concise retry with the same per-request cap. 0 omits max_tokens; the provider chooses its default, which may still be small.'],
  ['requestTimeoutMs', 'Request timeout (milliseconds)', 180000, 'Generation', 'Covers connection and streaming. 0 waits until completion or Stop.'],
  ['requestPacing', 'Pace outbound provider requests', true, 'Generation', 'One request pace per provider, shared by the whole crew, so a team cannot burst a provider into HTTP 429. After a rate limit Studio honors the provider Retry-After, then resumes slower until three clean requests. Off removes the app-imposed pace only; a provider Retry-After is still honored, because that instruction comes from the server rather than from Studio.'],
  ['requestPacingRpm', 'Slowest pace after a rate limit (requests per minute)', 6, 'Generation', 'The floor Studio paces down to after a provider rate limit. Lower is gentler; the first limit engages 4x this value.', 1],
  ['retryLimit', 'Retry attempts per request', 2, 'Reliability', 'Transport failures and retryable provider responses are retried this many times before the failure reaches the team Nurse. 0 disables transport retries.'],
  ['retryBaseMs', 'First retry wait (milliseconds)', 1500, 'Reliability', 'Start of the exponential backoff. Jitter is applied so a crew does not retry in lockstep.', 1],
  ['retryMaxMs', 'Longest backoff wait (milliseconds)', 60000, 'Reliability', 'Ceiling for the computed backoff. A provider Retry-After is governed by retryAfterCapMs instead.', 1],
  ['retryAfterCapMs', 'Longest honoured Retry-After (milliseconds)', 300000, 'Reliability', 'A provider Retry-After is clamped to this value, so an hour-long reset window becomes a bounded wait rather than a stalled run. 0 honours the header exactly.'],
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
  ['memoizeReads', 'Memoize repeated reads within a run', true, 'Context', 'Reuse identical read, search and code-index tool results briefly. Project writes invalidate matching entries. Turn off to always re-read.'],
  ['storedMessages', 'Retained messages per conversation', 0, 'History', '0 keeps the complete chat. Context compression never replaces saved history. Lowering this applies on the next appended message.'],
  ['transcriptMessages', 'Peer transcript messages', 40, 'Team visibility', 'How many recent messages agent.transcript returns to a peer. 0 returns the provider default set.'],
  ['transcriptChars', 'Peer transcript characters per message', 4000, 'Team visibility', 'Each relayed transcript message is truncated to this many characters, so one long turn cannot flood a peer request.'],
  ['outputPreviewChars', 'Agent status output preview characters', 4000, 'Team visibility', 'How much of a member answer agent.status and the team deck show. Display only: the full result still reaches synthesis.'],
  ['operatorMessagesPerAgent', 'Operator messages per agent', 20, 'Team visibility', 'Queued guidance a single crew member may hold before further sends are refused. 0 removes the count cap.'],
  ['operatorCharsPerAgent', 'Operator characters per agent', 40000, 'Team visibility', 'Total queued guidance characters a single crew member may hold. 0 removes the character cap.'],
  ['workerKeyChars', 'Spawned agent identity key characters', 64, 'Teams', 'Maximum length of a spawned worker identity key; longer keys are shortened with a digest. Must match the soul store key cap.'],
  ['linksRate', 'Crew exchange rate multiplier', 3, 'Teams', 'Links mode allows this many crew messages per chain handoff (rate × (members − 1)), which is how "triple the chain rate" is configured.'],
  ['maxLinkRounds', 'Links-mode rounds', 12, 'Teams', 'Hard safety stop on Links rounds, on top of the per-member turn allowance. 0 removes the round cap.'],
  ['memberLinkTurns', 'Extra Links turns per member', 4, 'Teams', 'How many times a member may be re-woken in Links mode to answer its inbox. 0 removes the extra-turn allowance.'],
  ['linksCompletionGraceMs', 'Links completion grace (milliseconds)', 250, 'Teams', 'Short window after LINKS: COMPLETE that lets an already-running peer finish its final response before it is stopped.'],
  ['maxAttempts', 'Self-correction attempts', 10, 'Execution', 'Fix attempts against the project test/lint/type gates before the loop pauses for you. 0 uses the built-in default of 10.'],
  ['noProgressLimit', 'Identical failures before stopping', 2, 'Execution', 'Consecutive attempts that produce no change in the failure set before the self-correction loop gives up. 0 uses the built-in default of 2.'],
  ['gateOutputChars', 'Gate output characters per stream', 24000, 'Execution', 'Standard output and standard error from each test gate are each truncated to this many characters before parsing.'],
  ['maxConversations', 'Saved conversations', 200, 'History', '0 removes the saved-chat count cap. Existing chats are never deleted by this setting.'],
].map(([key, label, value, group, help, min = 0]) => ({ key, label, value, group, help, min, globalOnly: GLOBAL_ONLY_KEYS.has(key), type: typeof value === 'boolean' ? 'boolean' : 'number' }));
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
  const overrides = Object.fromEntries(Object.entries(validateBudgets(settings.budgetOverrides || {}))
    .filter(([key]) => !GLOBAL_ONLY_KEYS.has(key)));
  return { ...defaults, ...legacy, ...validateBudgets(global.budgets || {}), ...overrides };
}
const cap = value => value === 0 ? Infinity : value;
module.exports = { fields, defaults, presets, validateBudgets, resolveBudgets, cap, GLOBAL_ONLY_KEYS };
