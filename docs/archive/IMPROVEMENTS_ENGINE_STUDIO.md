# Agent Engine — Improvement Plan

**Scope:** Engine improvements only. No UI changes. Feature additions are ok; existing style and architecture must be preserved.

---

## 1. Model-Adaptive Context Compaction

**Severity:** Medium

**Files:** `budgets.cjs`, `agent-loop.cjs`, `context.cjs`

### Problem
Every conversation uses the same 96K character trigger regardless of the model's actual context window. An agent on a 128K-model wastes tokens running compaction too early; an agent on a 4K-model crashes on the same trigger.

### Improvement
Add a `contextWindow` field to budgets (or derive from `model` at startup):

```js
// In budgets.cjs — add to the fields array
['contextWindow', 'Model context window (characters)', 0, 'Context',
 '0 auto-detects from model name; >0 sets an explicit window. Compaction trigger defaults to 60% of this.'],
```

Then in the agent loop, compute:

```js
function contextWindowFor(model) {
  if (model && /gpt-4o-mini/i.test(model)) return 128_000;
  if (model && /gpt-4o/i.test(model)) return 128_000;
  if (model && /claude/i.test(model)) return 200_000;
  if (model && /qwen/i.test(model)) return 131_072;
  return 32_768; // safe fallback
}
```

Set `contextTrigger` default to `Math.floor(contextWindow * 0.6)` when the user hasn't explicitly set it.

---

## 2. Per-Turn Token Accounting & Feedback

**Severity:** Medium

**Files:** `agent-loop.cjs`, `chat-response.cjs`, `budget-awareness.cjs`

### Problem
The agent never sees how many tokens (or characters) its own response consumed. It cannot self-regulate verbosity or learn that a 500-token answer was sufficient when a 5000-token one was attempted.

### Improvement
Pass `usage` metadata from `chat-response.cjs` back into the loop and inject it into subsequent system prompts:

```js
// In agent-loop._fetchChat response handling:
reply.usage = response.usage || null; // { prompt_tokens, completion_tokens, total }

// In budgetPolicy, append:
if (reply.usage) {
  lines.push(`Previous turn used ${reply.usage.prompt_tokens} input + ${reply.usage.completion_tokens} output tokens (${reply.usage.total} total). Fit the response within available budget.`);
}
```

Store the last 3 usage samples in the loop and report the average at compaction time, so the model learns the "budget density" of its own outputs.

---

## 3. Structured Output Enforcement

**Severity:** High

**Files:** `agent-action.cjs`, `agent-loop.cjs`, `chat-response.cjs`

### Problem
Model dialect drift is handled reactively: DSML recovery is byte-exact capture, the legacy fenced-block parser is manual, and malformed JSON gets one retry then a recovery message. There is no proactive enforcement.

### Improvement
Add a per-model format hint that is sent as a system prompt override:

```js
// In agent-loop._fetchChat, before building the request:
const formatHint = formatInstructionForModel(this.model);
if (formatHint) headers['X-Studio-Format'] = formatHint; // provider-agnostic hint
```

And a `chat_template_kwargs` or response_format equivalent where supported:

```js
// Where the endpoint supports it:
if (/qwen/i.test(this.model) && !this.nativeTools) {
  body.response_format = { type: 'json_object' };
}
```

For the JSON contract, validate the response shape *before* counting it as a round — a completely unparseable response should re-request without consuming a round (similar to the transport retry pattern).

---

## 4. Tool Result Caching / Deduplication

**Severity:** Low

**Files:** `agent-tool-runner.cjs`, `agent-loop.cjs`

### Problem
If the agent calls `read(path)` twice in the same turn with identical arguments (or across turns within the same session), the file is read twice. No caching layer exists.

### Improvement
Add a small LRU cache to the tool runner context:

```js
// In agent-loop, when building the tool context:
const toolCache = new Map(); // key → { result, at }
const CACHE_TTL = 300_000; // 5 min
const CACHE_MAX = 64;

// In tool-runner.execute wrappers for read/glob/search/list:
const cacheKey = `${call.name}:${JSON.stringify(call.args)}`;
const hit = toolCache.get(cacheKey);
if (hit && Date.now() - hit.at < CACHE_TTL) return { cached: true, ...hit.result };
```

This is transparent — the result includes `cached: true` so the model knows it didn't do the work.

---

## 5. Tool Timeout Enforcement

**Severity:** Medium

**Files:** `agent-tool-runner.cjs`

### Problem
A slow tool (e.g., `glob` on a huge tree, `shell` on a hanging process) can hang a round indefinitely. There's a per-request timeout but no per-tool timeout.

### Improvement
Add a `timeoutMs` to each tool definition and enforce it in `runToolCall`:

```js
// In tool-registry, tools get a timeout field:
read: { timeoutMs: 30_000, ... },
glob: { timeoutMs: 30_000, ... },
search: { timeoutMs: 60_000, ... },
shell: { timeoutMs: 120_000, ... }, // already has approval gate
```

```js
// In runToolCall, wrap execute:
const toolTimeout = tool.timeoutMs || 60_000;
const timeoutSignal = AbortSignal.timeout(toolTimeout);
try {
  result = await Promise.race([
    tool.execute(args, ctx),
    new Promise((_, reject) => timeoutSignal.addEventListener('abort', () => reject(new Error(`Tool ${name} timed out after ${toolTimeout}ms`)))).then(() => { throw new Error(...) }),
  ]);
} catch
```

---

## 6. Compaction Progression: From Text Summary to Structured Memory

**Severity:** Medium

**Files:** `compaction.cjs`, `context.cjs`

### Problem
Current compaction produces a single text blob. The agent gets back a narrative summary but loses structured state: what files were changed, what bugs were found, what decisions were made. The next prompt must re-read everything.

### Improvement
Extend the compaction output format to carry structured fields alongside the prose summary:

```js
// In compaction.cjs summarizeSegments output:
{
  _memoryType: 'structured',
  text: '...',           // the prose summary (unchanged, keeps backwards compat)
  files: ['src/main.cjs', 'src/util.cjs'],
  decisions: [
    { when: 'round 3', what: 'Switched to edit_patch over write', why: 'Preserved existing structure' }
  ],
  openIssues: [
    'Test suite fails on node 22'
  ],
  verifiedResults: [
    'relay compiles clean',
    '86 IPC handlers verified against manifest'
  ]
}
```

The compaction prompt already requests this structure — extend it to output JSON alongside prose. The agent loop stores both and injects the structured fields as a separate block before the prose, so the model can scan quickly.

---

## 7. Sequential-Only Compaction for Speed

**Severity:** Low

**Files:** `compaction.cjs`

### Problem
`summarizeSegments` processes segments sequentially — segment 2 cannot start until segment 1 finishes. With a 200K conversation, that's N sequential API calls.

### Improvement
Run segments in parallel with bounded concurrency (3 at a time, matching `PARALLEL_CONCURRENCY`), then merge results:

```js
// In compaction.cjs summarizeSegments:
async function summarizeSegments(messages, { maxChars, chunkSize, request, progress, signal }) {
  const segments = transcriptSegments(messages, chunkSize);
  // Run 3 at a time
  const results = await mapWithConcurrency(segments, 3, async (seg, i) => {
    progress('compaction-start', { segment: i + 1, total: segments.length });
    return summarizeSegment(seg, { request, signal, maxChars: Math.ceil(maxChars / 3) });
  });
  // Merge the N partial summaries into one
  return mergeSummaries(results, { maxChars, request, signal, progress });
}
```

This can halve compaction time on large conversations.

---

## 8. Round Efficiency Score

**Severity:** Low

**Files:** `agent-loop.cjs`, `budget-awareness.cjs`

### Problem
The agent has no metric for how efficiently it uses rounds. A task could take 15 rounds when 5 would suffice, but the model never learns.

### Improvement
Track a simple score each round:

```js
// In agent-loop._runConversation, at end of each round:
this.roundScores.push({
  round,
  toolCalls: parsed.actions.length,
  resultOk: this.turnResults.every(r => r.ok),
  pendingEdits: Object.keys(this._agent()?.pendingEdits || {}).length,
  textLength: (reply.content || '').length,
});
```

Inject the average into the budget policy prompt when rounds remaining < 10:

```js
const avgTools = this.roundScores.reduce((s, r) => s + r.toolCalls, 0) / this.roundScores.length;
if (avgTools < 2 && round > 5) {
  lines.push(`Average ${avgTools.toFixed(1)} tool calls per round over ${this.roundScores.length} rounds. Batch independent reads and use fewer, broader tools when possible.`);
}
```

---

## 9. Native Tool-Call Dialect Auto-Selection

**Severity:** Low

**Files:** `agent-loop.cjs`, `agent-action.cjs`

### Problem
The system hardcodes the response contract (JSON structured or native tool_calls) based on `nativeTools` flag. Some models produce much better JSON; others produce much better native calls. There's no per-model preference.

### Improvement
After 3 rounds, evaluate the model's response quality for each format and switch if one is clearly superior:

```js
// In agent-loop, per-round evaluation:
function evaluateFormat(round, response) {
  // How parseable was the response?
  const parsed = parseAgentResponse(response.content || '', response.nativeActions || []);
  return {
    parsed: !parsed.invalid,
    actionsExecuted: parsed.actions.length > 0 || response.nativeActions?.length > 0,
    completed: parsed.control?.status === 'complete',
  };
}
```

If the JSON contract consistently fails (invalid > 50%) while native succeeds, switch (or vice-versa). This is a learning loop, not a static switch.

---

## 10. Cross-Agent Memory Federation

**Severity:** Low

**Files:** `agent-soul.cjs`, `agent-net.cjs`, `tool-registry.cjs`

### Problem
Agents can only read and append their own `MEMORY.md`. In a crew, when one agent discovers a project convention, the others cannot learn from it. Each agent starts with a blank slate.

### Improvement
Add a `memory.federation` setting and a new tool `agent.memory_share`:

```js
// tool-registry: new tool
'agent.memory_share': {
  class: 'write', tier: 'collab', approval: false, budget: 40000,
  help: 'Share a memory entry with all crew members. This appends to a shared crew journal that every member reads at the start of their next turn.',
  async execute(args, ctx) {
    const net = netFromCtx(ctx);
    if (!net) return noNet();
    const entry = String(args.entry || '').trim().slice(0, 2000);
    if (!entry) return { ok: false, error: 'An entry is required.' };
    const sharedKey = `crew-${net.teamRunId}-shared`;
    const res = net.soulStore?.append(sharedKey, 'memory', `[${net.agents.get(ctx.agentId)?.name}] ${new Date().toISOString()} — ${entry}`);
    return res?.ok ? { ok: true, shared: true } : { ok: false, error: 'Cannot write shared memory.' };
  },
},
```

Each member reads the shared journal block at the start of its prompt, appended after SOUL but before the system role.

---

## 11. Conversation-Level History Pruning

**Severity:** Medium

**Files:** `agent-loop.cjs`, `memory-store.cjs`

### Problem
The `storedMessages` budget exists in budgets.cjs but is never enforced at the persistence layer. The agent's store keeps every message indefinitely, which means even "idle" conversations grow without bound.

### Improvement
Enforce `storedMessages` at the store level:

```js
// In memory-store.appendMessage, after appending:
const storedMax = this.get(agentId)?.settings?.budgets?.storedMessages ?? 0;
if (storedMax > 0) {
  const msgs = this.get(agentId).messages;
  if (msgs.length > storedMax) {
    const toRemove = msgs.slice(0, msgs.length - storedMax);
    // Prune them from the array (do not touch the checkpoint, which guards them)
    this.get(agentId).messages = msgs.slice(msgs.length - storedMax);
  }
}
```

This ensures the saved history actually respects the configured cap.

---

## 12. Automatic Team Dissolution

**Severity:** Low

**Files:** `agent-net.cjs`, `team-runner.cjs`

### Problem
When a Links-mode crew declares completion, other members that are mid-flight or waiting on peers keep running until their rounds expire. This wastes endpoint budget.

### Improvement
When `linksCompleteIn` fires, immediately abort all in-flight peers:

```js
// In agent-net, when LINKS: COMPLETE is detected:
function onLinksComplete(from) {
  // Cancel all active background tasks except the declarer
  for (const [id, task] of this.activeTasks) {
    if (id !== from) {
      const agent = this.agents.get(id);
      if (agent?.loop?.stop) {
        agent.loop.stop();
        this._linksSuperseded.set(id, { completedBy: from, at: Date.now() });
      }
    }
  }
  this.linksComplete = { from, fromName: this.agents.get(from)?.name, at: Date.now() };
}
```

Give a 250ms grace period (already defined as `LINKS_COMPLETION_GRACE_MS`) for any in-flight tool results to finish, then stop all.

---

## 13. Partial Message Recovery on Stream Abort

**Severity:** Medium

**Files:** `chat-response.cjs`, `agent-loop.cjs`

### Problem
When a stream is interrupted mid-response (network drop, timeout), the content received so far is discarded entirely. The agent must redo all reasoning.

### Improvement
Capture partial content and feed it back as context in the retry:

```js
// In agent-loop._fetchChat retry handler:
try {
  reply = await this._readAnswer(messages);
} catch (error) {
  if (error.code !== 'REACH_OUTPUT_RESERVE' && !isTransientTransportError(error)) throw error;
  // Include what was received so far
  const partial = this._lastPartialContent || '';
  if (partial) {
    messages = [...messages, { role: 'user', content: `The previous response was interrupted. Here is what was received so far:\n${partial}\n\nContinue from where you left off.` }];
  }
  // retry...
}
```

This preserves the agent's partial reasoning instead of throwing it away.

---

## 14. Tool Call Result Summarization (Long Results)

**Severity:** Low

**Files:** `agent-tool-runner.cjs`

### Problem
When a tool returns a very large result (e.g., `search` on a large project), the result is truncated at the tool's budget but the truncation marker (`… [truncated at N characters]`) is just text — the model must reason about what was cut.

### Improvement
When truncation happens, inject a summary of what was truncated:

```js
// In agent-tool-runner.truncate, enhanced:
function truncate(text, budget, name) {
  const s = String(text === undefined ? '' : text);
  if (s.length <= budget) return s;
  const first = Math.floor(budget / 3);
  const last = budget - first;
  return s.slice(0, first)
    + `\n\n[TRUNCATED: ${s.length - first - last} characters removed. Tool: ${name}. Reread source before making changes based on the full result.]\n\n`
    + s.slice(-last);
}
```

The model gets a stronger signal that data was omitted, plus a directive to re-read.

---

## 15. Fingerprint-Based Context Deduplication

**Severity:** Low

**Files:** `agent-loop.cjs`, `context.cjs`

### Problem
The compaction fingerprint (SHA256 of `JSON.stringify(messages)`) is correct but only checked at compaction time. If the agent produces the same tool result twice (e.g., calling `list` on the same directory twice), the conversation contains duplicate information that inflates context without adding value.

### Improvement
Deduplicate consecutive identical tool results before appending them to the message history:

```js
// In agent-loop, before appending tool results:
const lastMsg = this._agent()?.messages?.slice(-1)?.[0];
if (lastMsg?.role === 'user' && String(lastMsg.content).startsWith('TOOL RESULTS') &&
    lastMsg.content === newContent) {
  // Skip duplicate — model already has this result
  return;
}
```

Combined with the tool cache (Improvement #4), this prevents duplicate tool output from ever entering the conversation.

---

## Implementation Priority

| Priority | Improvement | Estimated Effort | Risk |
|----------|------------|------------------|------|
| 1 | #3 Structured Output Enforcement | Medium | Low |
| 2 | #1 Model-Adaptive Context Compaction | Small | Low |
| 3 | #13 Partial Message Recovery | Small | Low |
| 4 | #11 Conversation History Pruning | Small | Low |
| 5 | #5 Tool Timeout Enforcement | Small | Low |
| 6 | #2 Per-Turn Token Accounting | Small | Low |
| 7 | #6 Structured Compaction Memory | Medium | Low |
| 8 | #4 Tool Result Caching | Small | Low |
| 9 | #7 Sequential-Only Compaction (parallelize) | Medium | Medium |
| 10 | #8 Round Efficiency Score | Small | Low |
| 11 | #12 Automatic Team Dissolution | Small | Low |
| 12 | #14 Long Result Summarization | Small | Low |
| 13 | #15 Fingerprint-Based Dedup | Small | Low |
| 14 | #9 Native Dialect Auto-Selection | Medium | Medium |
| 15 | #10 Cross-Agent Memory Federation | Medium | Low |

All improvements are additive — they introduce new features, new settings, and new internal state. None modify existing file styles or require UI changes.
