# Agent engine — E1–E19 completion record

> **Scope.** The **agent engine** is `studio/agent/*.cjs` — the runtime that turns a
> conversation into model requests, tool calls, sandbox decisions, crew coordination and
> durable memory. This document is an **annex**, not a second plan: `IMPROVEMENTS.md` stays
> the single canonical plan and nothing here renumbers it. Every item below either carries
> an **`E<n>`** id of its own (engine-internal work) or **cites the canonical id** it belongs
> to (`3.3`, `5.1`, `5.8`, `2.4`, `2.8`, …). When an `E<n>` item becomes repo-wide work, it
> moves into `IMPROVEMENTS.md` and this file keeps the pointer.
>
> E6 also exposes interrupted crew journals through IPC and a partial-results card on the
> Teams page so recovered work is visible after a restart.
>
> **Original audit:** working tree at `6d4e1e0`, 2026-09-22. The detailed evidence and
> line references below describe that starting state. All actionable items E1–E14 and
> E16–E19 are implemented; E15 was explicitly context, not an item. Run
> `bash docs/verify-agent-engine.sh` for the current measurements.

## Current verification (2026-09-23)

| Check | Result |
| --- | --- |
| Engine modules and lines | 72 modules, 16,057 lines |
| Largest modules | `code-index.cjs` 1,203; `test-loop.cjs` 1,099; `agent-loop.cjs` 785 |
| E11 target files | `team-runner.cjs` 681; `agent-net.cjs` 632 |
| Registered tools with argument schemas | 37 / 37 |
| Live policy constants in budgets schema | 23 / 23 |
| Static require cycles; engine imports from renderer | 0; 0 |
| Unit tests | `npm test`: 621 passed, 0 failed |

The crew journal uses atomic replacement for each append, retains finished files, and
offers a recovery listing plus a harvest view for incomplete runs. Tool evidence is
journaled with argument and result digests; edit verdicts update the effective ledger.
Provider facts are persisted per connection and endpoint/model, including observed
reasoning, tool, streaming, and output-token limits.

---

## 1. Original measured baseline (2026-09-22)

| Metric | Measured | Command |
| --- | --- | --- |
| Engine modules | **54** `.cjs` | `ls studio/agent/*.cjs \| wc -l` |
| Engine lines | **14,730** | `wc -l studio/agent/*.cjs \| tail -1` |
| Largest module | `team-runner.cjs` **1,282** | `wc -l studio/agent/*.cjs \| sort -rn \| head` |
| Next four | `code-index.cjs` 1,156 · `test-loop.cjs` 1,075 · `agent-net.cjs` 1,032 · `agent-loop.cjs` 670 | same |
| Registered tools | **37** | `node -e "console.log(Object.keys(require('./studio/agent/tool-registry.cjs').TOOLS).length)"` |
| Budgets schema fields | **21** | `grep -c "^  \['" studio/agent/budgets.cjs` |
| Tests | **58** `studio/test/*.test.cjs` | `ls studio/test/*.test.cjs \| wc -l` |
| Test files touching ≥1 engine module | **52 / 58** | `docs/verify-agent-engine.sh` |
| Engine modules no test file requires directly | **4** — `browser-tools`, `file-scan`, `file-scan-worker`, `run-control` (all four are live, see §5) | same |
| `TODO`/`FIXME`/`HACK`/`XXX` markers in the engine | **0** | `grep -rn "TODO\|FIXME\|HACK\|XXX" studio/agent/*.cjs \| wc -l` |
| `console.*` calls in the engine | **0** | `grep -rn "console\." studio/agent/*.cjs \| wc -l` |
| Policy constants with a budgets-schema home | **8 of 23** live constants (§4, E14) | `docs/verify-agent-engine.sh` |

The items below preserve the original problem statements and done checks. Their evidence
describes the initial audit; the current verification above reports the implemented state.

---

## 2. Ranked items

Effort is calendar estimate for one developer. `Risk` is the chance of changing observable
behaviour.

### E1 · Honour `Retry-After`; stop classifying 429 as a permanent failure — **highest value**

- **Status:** `DONE` (canonical `2.8`)
- **Evidence:** the engine has **no `Retry-After` handling anywhere** (`grep -ri "retry-after"
  studio/agent/*.cjs` → 0 hits). `chat-response.cjs` exposes only `waitForRetry(ms, signal)`,
  a bare timer, and both call sites pass a **fixed 1500 ms** (`agent-loop.cjs:384`, `:518`) with
  `RETRY_LIMIT = 2` (`agent-loop.cjs:32`). Worse, `team-nurse.cjs:21` `HARD_FAILURE_RE` matches
  `\b(...|429|500|502|503|504)\b` and therefore resolves to `hard-provider`, which
  `recoveryScore()` scores `-Infinity` and `stageRecoveries()` moves straight to
  `quarantined`. **A provider rate limit currently kills a crew member permanently instead of
  pausing it.**
- **Change:** parse `Retry-After` and replace the fixed delay with exponential backoff + jitter.
  HTTP 429 and 503 responses with `Retry-After` use the shared adaptive provider gate (E2);
  a bare 503 remains a hard provider failure, while retryable transport and HTTP failures use
  the bounded retry path.
- **New budgets:** `retryLimit` (2), `retryBaseMs` (1500), `retryMaxMs` (60000),
  `retryAfterCapMs` (300000).
- **Done check:** a test that feeds a `429` with `Retry-After: 5` and asserts the second
  request is not issued before the header's delay and not after the cap; and a nurse test
  asserting a `429` stages a recovery instead of a quarantine.
- **Effort:** 1 day · **Risk:** medium (changes retry timing for every run)

### E2 · Adaptive outbound pace shared per provider

- **Status:** `DONE` (canonical `2.8`)
- **Evidence:** there is **no time-based outbound gate in the engine** —
  `grep -rE "Semaphore|tokenBucket|RateLimiter|concurrencyGate" studio/agent` returns only
  prose comments (`agent-net.cjs:19`, `:509`; `team-runner.cjs:187`). The relay has one
  (`server/reachd/limits.py`), but the engine cannot reach it. Meanwhile the engine is
  deliberately concurrent: `team-runner.cjs:45` `PARALLEL_CONCURRENCY = 3`, `:53`
  `LINKS_RATE = 3`, `:840` a links budget of `LINKS_RATE × (members − 1)`, and
  `agent-net.cjs:170` up to `budgets.maxAgents` live agents. An 8-member Links crew plus
  spawned workers can put a dozen simultaneous requests on one provider connection.
- **Change:** `agent/rate-limit.cjs` shares one adaptive gate per provider origin across every
  `AgentLoop`. Healthy requests pass immediately. A 429, or a 503 with `Retry-After`, sets one
  shared provider deadline and slows subsequent requests; the pace releases after a quiet window
  and three clean responses. Waiting remains interruptible by Stop.
- **New budgets:** `requestPacing` (default on; no delay until a provider limits the crew) and
  `requestPacingRpm` (minimum pace after a limit). Both are global-only so loops cannot race to
  reconfigure a shared provider gate. Turning off app pacing still honors the provider's
  `Retry-After`.
- **Done check:** `rate-limit.test.cjs` covers the shared gate, bounded `Retry-After`, recovery,
  Stop, and the hard-failure contract for a bare 503.
- **Effort:** 1–2 days · **Risk:** medium (adapts after a provider rate limit)

### E3 · Tool results are not actually bounded

- **Status:** `DONE` (canonical `2.4`)
- **Evidence:** `agent-tool-runner.cjs` truncates only **top-level string fields**, each to
  `budget / 2`:

  ```js
  for (const key of Object.keys(truncated)) {
    if (typeof truncated[key] === 'string') truncated[key] = truncate(truncated[key], Math.floor(budget / 2));
  }
  ```

  Three consequences, all measured from that code: (1) a top-level **array or object is never
  touched**, so `list` on a large directory, `search` with many matches, `code.index` output
  and `tests.run` gate output can be arbitrarily large; (2) a result with ten string fields
  may occupy **5× its stated budget**; (3) truncation is applied to the copy, not the message,
  so `persistToolResult` can write the full shape.
- **Change:** one recursive byte-budget serializer (`agent/bounded-result.cjs`) that walks the
  structure in a fixed key order, elides collections with an explicit
  `"[+N more items elided]"` marker, and enforces a single total budget for both the returned
  value and the persisted message. Errors are never elided.
- **Done check:** a test with a 10 MB array result asserting the persisted message and the
  returned object are each under the budget and that the elision marker names how much was
  dropped.
- **Effort:** half a day · **Risk:** low

### E4 · Declarative argument schema per tool, validated at the one choke point

- **Status:** `DONE` (canonical `2.4`)
- **Evidence:** `tool-registry.cjs` has **no `schema`, `params` or `validate` key at all**
  (`grep -c "schema\|params\|validate"` → 0 per key). All 37 tools describe their arguments in
  prompt prose plus an `example` object, and each executor validates ad hoc — which is exactly
  why canonical `2.4` lists seven named argument gaps (`agents:setTodos`, `files:write` size,
  `project:create` path, …).
- **Change:** add `params` to every registry entry (name, type, required, max length, default)
  and validate/coerce **inside `runToolCall`**, before sandbox evaluation and before the
  approval prompt, returning a structured `{ok:false, error}` naming the offending field. One
  implementation, 37 declarations; no executor changes required on day one, and ad-hoc checks
  are removed as each tool is migrated. This also feeds E8 and E3 (declared max sizes).
- **Done check:** a registry test asserting every tool declares `params`; a runner test
  asserting a call with a wrong-typed required field is refused *before* `requestApproval` is
  invoked.
- **Effort:** 2–3 days · **Risk:** medium (a schema stricter than reality refuses valid calls —
  migrate tool by tool, schema-absent tools keep today's behaviour)

### E5 · Three dead constants are cited as evidence by the canonical plan

- **Status:** `DONE` (corrects the evidence line in canonical `2.6`)
- **Evidence:** `agent-store.cjs:28` `MAX_AGENTS = 200` and `:29` `MAX_STORED_MESSAGES = 400`
  are **declared and never read** — a repo-wide grep finds them only at those declaration lines
  and in the prose of `IMPROVEMENTS.md` §2.6 and four archived plans. The live caps are
  different modules/values: `budgets.storedMessages` (applied in `appendMessage`) and
  `MAX_CONVERSATION_BYTES = 8 MiB` (applied in `_enforceByteCap`, with the archive in
  `_appendArchive` / `readArchive`). The same class of dead constant is
  `agent-loop.cjs:31` `MAX_ROUNDS = 40` (never read; the live cap is `budgets.maxRounds`).
- **Change:** delete all three, or make them the documented defaults of their budget fields.
  Then fix the evidence line in `IMPROVEMENTS.md` §2.6 so the canonical plan stops pointing
  readers at constants with no effect.
- **Done check:** `grep -rn "MAX_STORED_MESSAGES" studio/` → 0 hits; `npm test` green.
- **Effort:** 20 minutes · **Risk:** none

### E6 · A crash loses the entire crew run

- **Status:** `DONE` (canonical `5.1`, `5.8`)
- **Evidence:** crew state is **in-memory only**. `main.mjs:99` holds `teamRuns = new Map()`;
  `team-runner.cjs:163` holds `memberStores` (a Map of `MemoryStore`s) for resume; members run
  on `MemoryStore` objects (`memory-store.cjs`) that by construction write nothing to disk
  (`agent-net.cjs:333`, `team-runner.cjs:546`). A window close, a crash, or an app update
  during a 6-member Links run discards every member transcript, the inbox, the nurse's
  recovery state and the pending crew mail — the run cannot be recovered, and the user's paid
  inference is gone.
- **Change:** an append-only crew journal under `userData/agents/<id>.team.jsonl`, written
  through **`atomicWriteJson`'s sibling discipline (frozen interface I1 — no bare
  `writeFileSync` on user data)**, holding: run manifest (team, personas, models, mode), one
  record per member turn completion, one per crew message, one per nurse action. On startup a
  run whose manifest has no `complete` record is surfaced as recoverable and can be re-entered
  or harvested for its partial results. Archive, never delete (invariant **A4**) — this is the
  same policy `agent-store` already applies to trimmed messages.
- **Done check:** a test that runs a 2-member crew against a stub endpoint, kills the runner
  mid-run, re-reads the journal and asserts each completed member's output and every crew
  message survive.
- **Effort:** 3–4 days (canonical `5.8` was already scoped this way) · **Risk:** medium —
  **one wiring line in `studio/main.mjs`** (construct the journal next to `teamRuns`)

### E7 · The audit log records exactly one kind of event

- **Status:** `DONE`
- **Evidence:** in production code the **only** `auditLog.write` call in the repository is
  `agent-tool-runner.cjs:80`, `event: 'sandbox.deny'` — the verifier's audit-event scan returns
  exactly `agent-tool-runner.cjs:sandbox.deny` and `audit-log.cjs:rotate`, and the latter is the
  log's own rotation marker record, not a caller. Every other hit in the repo is a test. Approvals and
  declined approvals, edit reviews and their verdicts, `write`/`edit_patch` applications,
  `refactor.apply` rollbacks, and crew handoffs are recorded nowhere durable. The one thing
  that could not be dropped from that record — the tool name — had to ride inside `detail`
  precisely because `canonical()` is frozen (invariant **A2**: it must keep hashing
  `record.v`, and changing the hashed shape invalidates every existing log).
- **Change:** add events `approval.request`, `approval.decision`, `edit.review`,
  `edit.apply`, `tool.allow` (write class), `crew.handoff`, `crew.stop` — all placing extra
  fields in `detail` and never touching `canonical()`. Add a read path that leaves the entry
  count and chain verification unchanged, so `audit-log.test.cjs` and
  `audit-rotation.test.cjs` keep passing untouched.
- **Done check:** the existing chain/rotation tests still pass **without edits**, and a new
  test asserts a declined approval produces exactly one chained record naming the tool and the
  reason.
- **Effort:** 1 day · **Risk:** low if A2 is respected; **high** if anyone "tidies"
  `canonical()` — that edit is forbidden

### E8 · Sandbox command discovery is a hardcoded shape list

- **Status:** `DONE` (canonical `2.4`)
- **Evidence:** `agent-tool-runner.cjs:113` `collectCommands()` scans only three shapes:
  `args.command`, `args.gates[].command`, `args.commands[].command`. The module says so
  itself: *"A tool that adds a new command shape must extend this function."* That is a policy
  hole waiting for the next exec tool. Separately, `enforceSandbox` returns `null` unless
  `settings.sandbox.enabled === true`, so the sandbox is **off by default** and nothing records
  that a command ran outside it.
- **Change:** once E4 lands, mark exec-class command fields in the tool schema and derive
  `collectCommands` from the registry, then add a test that walks every `class: 'exec'` tool
  and asserts it declares at least one command path. Keep the opt-in default (changing it is a
  product decision), but emit an audit event (`sandbox.disabled`) the first time a write/exec
  tool runs with the sandbox off, so the operator can see the exposure.
- **Done check:** the registry-walk test fails if a new exec tool forgets to declare its
  command path.
- **Effort:** 1 day (after E4) · **Risk:** low

### E9 · The engine depends on the renderer

- **Status:** `DONE`
- **Evidence:** exactly two sites, both engine → UI:
  `agent-loop.cjs:139` `require('../renderer/activity-state.js')` and
  `agent-store.cjs:55` the same. The pure reducer that folds run events into activity state
  lives in the **renderer**, so the engine cannot be unit-tested, reused headlessly, or
  packaged without pulling a UI module, and a renderer refactor can break a run.
- **Change:** move the pure reducer to `agent/activity.cjs` (engine-owned, dependency-free),
  and make `renderer/activity-state.js` a one-line re-export. The UI file keeps its path and
  its API, so **no renderer behaviour and no CSS/DOM changes**; the engine stops importing the
  UI, and the existing `activity.test.cjs` keeps passing.
- **Done check:** `grep -rn "require('../renderer" studio/agent/` → 0 hits, `npm test` green.
- **Effort:** half a day · **Risk:** low

### E10 · Every require cycle is survived only by a lazy require

- **Status:** `DONE`
- **Evidence:** `docs/verify-agent-engine.sh` reports the cycle set. There are **8 static
  require cycles** in the engine, of which **exactly one edge in every cycle is lazy**
  (8 lazy / 21 top-level cycle edges; **0 cycles have no lazy edge**). Two are 2-node cycles —
  `agent-net.cjs` ↔ `agent-loop.cjs` and `tool-registry.cjs` ↔ `code-tools.cjs` — and six run
  3–5 nodes, all through `tool-registry` → `agent-net` → `agent-loop` (→ `agent-response` /
  `agent-action` / `agent-tool-runner`) → back. The fatal direction is avoided only because one
  edge is a `require` **inside a function** (`agent-loop.cjs:122`, `tool-registry.cjs:420`,
  `code-tools.cjs:372/459/480`), while the opposite edges are top-level (`agent-net.cjs:30`,
  `tool-registry.cjs:504`). Load order is therefore load-bearing and undocumented: moving a
  `require` to the top of a file "for tidiness" would produce a partial-module bug at runtime
  with no test catching it.
- **Note:** the verifier strips comments before building the graph. A naive scan additionally
  reports `code-tools.cjs -> code-tools.cjs`, which is only the module's own doc-comment
  mentioning `require('./code-tools.cjs')` — not an edge. Do not "fix" it.
- **Change:** break the two 2-node cycles structurally — extract the `NET_BY_AGENT` registry
  into a leaf module (`agent/net-registry.cjs`) that both `agent-net` and `agent-loop` require,
  and move `resolveInProject` (the only thing `code-tools` needs from the registry) into
  `agent/paths.cjs`. Then add a test that walks the static require graph and **fails on any
  cycle whose edges are all top-level**, so the invariant is enforced rather than remembered.
- **Done check:** the new cycle test passes with 0 top-level cycles; `npm test` green.
- **Effort:** 1–2 days · **Risk:** medium (require-order changes are exactly where a subtle
  break hides — land it with the graph test in the same change)

### E11 · `team-runner.cjs` and `agent-net.cjs` are the two largest engine files

- **Status:** `DONE` (canonical `3.3`)
- **Evidence:** `team-runner.cjs` **1,282** lines and `agent-net.cjs` **1,032** — 16% of the
  engine between them, and each mixes concerns that change for different reasons: the runner
  holds run orchestration, the parallel driver, the Links loop, member prompting, inbox
  take/restore, operator-tool handling and synthesis selection; the net holds agent records,
  spawn, await with cycle detection, transcripts, worker lifecycle and crew messaging.
- **Change:** extract in pure-refactor steps, one PR each, no behaviour change:
  `team-runner` → `team-links-loop.cjs` (the Links state machine), `team-member-driver.cjs`
  (`_drive` / `_runMember` / `_harvest`), `team-inbox.cjs` (`_takeLinkInbox` /
  `_restoreLinkInbox` / `_wakeMember` / handoff bounding); `agent-net` →
  `team-records.cjs` (record shape + status transitions), `team-transcript.cjs`.
  `team-runner-links-send-completion.test.cjs`, the two `team-nurse-*` suites and
  `team-runtime-routing.test.cjs` are the safety net — they must pass **unmodified**.
- **Done check:** each file under ~700 lines; the four suites above unchanged and green.
- **Effort:** 3–5 days · **Risk:** medium (mechanical but broad; one file per PR)

### E12 · Code-index cache ownership is in the wrong module

- **Status:** `DONE` (canonical `3.5`)
- **Evidence:** `code-index.cjs` (1,156 lines) is the declared owner of the index, but the
  cache lives in `code-context.cjs`: `indexCache` + `MAX_INDEX_CACHE = 4`,
  `INDEX_TTL_MS` at `:42`, `getIndex` at `:56`, `invalidateIndex` at `:74`, and
  `invalidateForFile` with the `onFileWrite` self-registration at the bottom of the file.
  Two modules therefore reason about one cache, and `code-tools.cjs:45` imports the accessors
  from `code-context` while `code-tools.cjs:29` imports the engine from `code-index`.
- **Change:** move the cache, TTL and invalidation into `code-index.cjs` (which already knows
  file contents and is the only thing that can decide staleness); `code-context.cjs` keeps
  `buildCodeContext` / `formatInjection` and becomes a thin consumer. The write-observer hook
  stays registered from the owner, so `code-context.test.cjs` and `code-tools.test.cjs` remain
  the check.
- **Done check:** `grep -n "INDEX_TTL_MS\|indexCache" studio/agent/code-context.cjs` → 0 hits;
  both suites green.
- **Effort:** 1 day · **Risk:** low

### E13 · Each tool result is persisted twice

- **Status:** `DONE`
- **Evidence:** two independent appends of the same content. `runToolCall` calls
  `persistToolResult` (`agent-tool-runner.cjs:223`), which appends a `role: 'tool'` message
  carrying `JSON.stringify(result, null, 2)`; then the tool-dispatch branch of
  `agent-loop.cjs` builds `resultText` from the same results and appends it again as a
  `role: 'user'` message with `_reachMeta.source = 'tool-summary'`. Both are stored in the
  conversation, both count toward `contextChars`, and both are summarised by compaction — so
  every tool call costs roughly twice the context it should, and a long agentic run reaches
  the compaction trigger sooner than its real content warrants.
- **Change:** persist once. Keep the fenced `tool-summary` message (it is what the model reads
  and it is the untrusted-data boundary), and reduce the `role: 'tool'` record to a
  provenance stub (tool name, ok, elapsed, result pointer) rather than a second full copy.
  Verify against `context-injection.test.cjs` and `compaction.test.cjs` that the model still
  sees every result exactly as before.
- **Done check:** a test asserting one tool call produces one full result body in the
  conversation, and `contextStatus().chars` is materially smaller for a fixed tool result.
- **Effort:** 1 day · **Risk:** medium (the transcript shape is what the model reads; the
  fencing must not regress)

### E14 · Fifteen policy numbers have no budgets home

- **Status:** `DONE`
- **Evidence:** the budgets schema has **21 fields**; these engine constants are read as policy
  and are **not** in it, so they can only be changed by editing engine source:

  | Module | Constant | Value |
  | --- | --- | --- |
  | `agent-loop.cjs` | `RETRY_LIMIT` :32 | 2 |
  | `agent-loop.cjs` | retry delay :384, :518 | 1500 ms |
  | `agent-net.cjs` | `TRANSCRIPT_MESSAGES` :42 | 40 |
  | `agent-net.cjs` | `TRANSCRIPT_CHARS` :43 | 4000 |
  | `agent-net.cjs` | `OUTPUT_PREVIEW` :44 | 4000 |
  | `agent-net.cjs` | `MAX_OPERATOR_MESSAGES_PER_AGENT` :45 | 20 |
  | `agent-net.cjs` | `MAX_OPERATOR_CHARS_PER_AGENT` :46 | 40 000 |
  | `agent-net.cjs` | `MAX_WORKER_KEY_CHARS` :48 | 64 |
  | `team-runner.cjs` | `LINKS_RATE` :53 | 3 |
  | `team-runner.cjs` | `MAX_LINK_ROUNDS` :54 | 12 |
  | `team-runner.cjs` | `MEMBER_LINK_TURNS` :55 | 4 |
  | `team-runner.cjs` | `LINKS_COMPLETION_GRACE_MS` :56 | 250 |
  | `test-loop.cjs` | `DEFAULT_MAX_ATTEMPTS` :35 | 10 |
  | `test-loop.cjs` | `DEFAULT_NO_PROGRESS_LIMIT` :43 | 2 |
  | `test-loop.cjs` | `MAX_OUTPUT_CHARS` :44 | 24 000 |

  Note the asymmetry that makes this a real defect and not a style point: `team-runner` reads
  `budgets.teamConcurrency` (`:161`) and `budgets.resumeCycles` (`:515`) but **not**
  `LINKS_RATE`/`MAX_LINK_ROUNDS`/`MEMBER_LINK_TURNS`, so a user who sets "heavy" budgets still
  gets the Links-round cap of 12 and 4 turns per member. `agent-net` reads
  `budgets.maxAgents`/`maxDepth`/`awaitTimeoutMs` (`:170-172`) but not the transcript or
  operator-nudge caps.
- **Change:** add the schema rows (each constant becomes the field's default, so existing
  behaviour is byte-identical until a user changes something), then consume them at the read
  sites. The validation already exists (`budgets.checkpoint` pattern).
- **Done check:** `docs/verify-agent-engine.sh` reports 0 un-homed constants; a test asserts a
  `budgets` override of `maxLinkRounds` actually bounds a Links run.
- **Effort:** 1–2 days · **Risk:** low (defaults preserve behaviour)

### E15 · Pervasive control-flow literals in the engine — no item, recorded as context

Measured while auditing E14, not worth an item: 55 lines in the engine carry a bare numeric
literal of 3+ digits, used as lengths, timeouts and caps (`code-index.cjs:64`
`DEFAULT_MAX_FILES = 4000`, `patch-manager.cjs:29` `MAX_DIFF_LINES = 20000`,
`refactor.cjs:28` `MAX_PLAN_FILES = 200`, `sandbox.cjs:98` `MAX_COMMAND_LENGTH = 4000`,
`agent-soul.cjs:39-52` the `MAX_*` family, …). Most are internal defensive bounds rather than
user policy and are correctly local. The named `MAX_*` exports read as policy, and the ones a
user would plausibly want to tune are already proposed in E14. Do **not** bulk-migrate these;
the schema is a user-facing contract and inflating it to 60 fields makes it unusable.

### E16 · No observability seam for headless runs

- **Status:** `DONE`
- **Evidence:** the engine makes **0 `console.*` calls** (deliberate — everything flows through
  the injected `sendEvent`). That is right for the app, but a spawned subagent turn, a
  `node --test` harness, and any future CLI or CI use have no way to observe a run: nothing is
  logged unless a renderer is attached. Diagnosing a stalled crew member therefore requires
  reproducing it in the app.
- **Change:** an optional `logger` injected exactly like `auditLog` (default no-op), with the
  loop and the net emitting structured events (`round`, `request-start`, `tool-call`,
  `tool-result`, `compact`, `handoff`, `stall`). No new global, no `console` in the engine, and
  the app passes nothing — behaviour unchanged there.
- **Done check:** a test that injects a capturing logger and asserts one structured record per
  model round and per tool call.
- **Effort:** 1 day · **Risk:** low

### E17 · Feature: a durable per-run evidence ledger

- **Status:** `DONE` (canonical `5.2` observability scope)
- **Depends:** E6 (the ledger is written into E6's journal)
- **Evidence:** the raw material already exists and is thrown away. `agent-loop` builds
  `this.turnResults` as `{tool, path, ok, pending}` per call and passes it and the todo list
  into `budget-awareness.checkpoint()` (`_budgetCheckpoint`, `agent-loop.cjs:252-254`), and
  `team-nurse` reconstructs completed-member evidence from `results[]` on every pulse. None of
  it is durable, so a synthesis pass — and worse, a resumed run — can only re-derive what was
  verified by re-reading the transcript or re-running tools.
- **Change:** promote `turnResults` into a per-run ledger (tool, arguments digest, ok, path,
  elapsed, result digest) written with E6's journal and readable by the loop, the nurse's
  `synthesisHandoff` and the budget checkpoint. A coordinator's final synthesis can then cite
  *verified* results — "read this file, wrote that one, command exited 0" — instead of prose
  the members may have invented.
- **Done check:** a test asserting the ledger of a run that read a file, ran `npm test` and had
  a write declined contains exactly those three entries with `ok` values matching reality.
- **Effort:** 2 days (overlaps E6) · **Risk:** low

### E18 · Feature: memoize read-class tool results within a run

- **Status:** `DONE`
- **Evidence:** a long crew re-reads the same files repeatedly. `text-files.cjs` already
  publishes an `onFileWrite` hook, and `code-context.cjs` already uses it to invalidate the
  index (self-registration at the bottom of the file) — so the invalidation contract this needs
  **already exists and is already tested**.
- **Change:** a per-run memo for read-class tools (`read`, `list`, `glob`, `search`,
  `code.*` reads) keyed by `(absolute path, mtimeMs, size)` plus the arguments digest, dropped
  on any `onFileWrite` for that path. Emit a `cache` event so the effect is visible, and make it
  opt-out through a budget field.
- **Done check:** a test asserting a second identical `read` does not touch disk, and that
  writing the file invalidates the entry.
- **Effort:** 2 days · **Risk:** medium (a stale cache that serves outdated file contents is
  worse than a slow run — the mtime+size key and the write hook are the whole safety argument)

### E19 · Feature: remember provider capabilities per connection

- **Status:** `DONE`
- **Evidence:** the engine already learns model facts at runtime and then forgets them.
  `agent-loop._fetchChat` sets `this.noThinkingHint = true` after a provider rejects
  `chat_template_kwargs` with a 400/422, then retries — a heuristic keyed on
  `/qwen/i.test(this.model)` plus a token threshold. It lives on one loop instance, so **every
  new conversation and every crew member re-learns the same rejection with a wasted request**.
- **Change:** a small per-connection capability cache (endpoint + model → `{toolCalling,
  reasoningParam, streaming, maxTokensCeiling}`) populated from real responses and persisted
  next to the connection record. Never a hardcoded model list: only facts observed from the
  provider's own response.
- **Done check:** a test with a stub endpoint that rejects the reasoning parameter once and
  asserts the second loop on the same connection issues no rejected request.
- **Effort:** 1–2 days · **Risk:** low

---

## 3. Ordering

```
E5 (20 min, zero risk) ──┐
E9 (½ day, zero UI risk) ├─► hygiene, land first
E10 cycle test ──────────┘
        │
E1 Retry-After ──► E2 token bucket          (provider-facing reliability)
        │
E4 schema ──► E8 command discovery ──► E3 bounded results   (the tool-call path, in order)
        │
E6 journal ──► E17 evidence ledger          (durability)
        │
E11 splits · E12 cache ownership · E13 single persistence   (architecture, one PR each)
        │
E14 budgets rows · E16 logger · E18 memo · E19 capabilities  (features)
```

Dependency notes: **E8 depends on E4** (schema-driven command discovery). **E17 depends on
E6** (it writes into the journal). **E13 should land before E3** is declared done — both
change what a tool result costs in the transcript, and doing them together avoids two
conversation-shape changes. **E16 should land before E11**'s splits, so the refactors can be
observed headlessly.

---

## 4. Collision map — one writer per file

| File | Items that touch it | Rule |
| --- | --- | --- |
| `studio/agent/agent-loop.cjs` (670) | E1, E2, E9, E10, E13, E14, E16, E17, E19 | **One writer.** Also the file canonical `3.3` refactors — serialize behind `3.3` or take it first |
| `studio/agent/team-runner.cjs` (1,282) | E6, E11, E14, E17 | **One writer**; E11's splits and E14's reads conflict |
| `studio/agent/agent-net.cjs` (1,032) | E6, E10, E11, E14, E16 | **One writer** |
| `studio/agent/agent-tool-runner.cjs` | E3, E4, E7, E8, E13 | **One writer** — it is the choke point for all five |
| `studio/agent/tool-registry.cjs` | E4, E8, E10 | Land E10's `paths.cjs` extraction **before** E4 adds 37 `params` blocks |
| `studio/agent/team-nurse.cjs` | E1 | Single owner |
| `studio/agent/code-context.cjs` ↔ `code-index.cjs` | E12 | Single owner for both |
| `studio/agent/budgets.cjs` | E1, E2, E14, E18 | Batch — one schema change |
| `studio/agent/audit-log.cjs` | E7 | **`canonical()` is frozen (A2). Do not edit it** |
| `docs/IMPROVEMENTS.md` | E5's evidence-line correction, and any `E<n>` promoted to canonical | Land after the code change, in the same commit |

---

## 5. Measured facts that are *not* defects

Recorded so the next reader does not "fix" them:

- **4 engine modules are not `require`d by any other module or test file** —
  `browser-tools.cjs`, `file-scan.cjs`, `file-scan-worker.cjs`, `run-control.cjs`. All four are
  **live**: `browser-tools` is spread into the registry (`tool-registry.cjs:504`),
  `file-scan` is required by the registry (`:20`), `file-scan-worker.cjs` is loaded as a
  `worker_threads` worker by path (`file-scan.cjs:11`), and `run-control` is required by
  `agent-net.cjs` and `team-runner.cjs`. **A require-graph liveness check produces false
  positives here** — liveness must be asserted by tests, not by grep.
- **`soul-store.cjs` (193 lines) has exactly one consumer: `studio/test/soul-store.test.cjs`.**
  Production uses `agent-soul.cjs` (`main.mjs`, `agent-loop.cjs`). Two modules implement the
  SOUL/MEMORY contract with independent `MAX_MEMORY_ENTRY_CHARS` copies
  (`agent-soul.cjs:41`, `soul-store.cjs:32`). Not a defect yet, but the next change to the
  memory contract must decide which one is canonical or the two will diverge.
- **The engine binds no socket, server or timer loop of its own**; `team-runner`'s 35
  `setTimeout`/`setInterval` hits are per-run waits and watches, all cleared with the run.
  `team-nurse` is deliberately event-driven with zero polling.
- **There is no `TODO` marker in the engine**, and this document is the intended replacement
  for that marker convention at engine scope.
- **`budgets.unrestricted`** intentionally maps every numeric field to its `min` (often 0 =
  "no application cap"), so "0" must never be read as "missing value" — the schema says so at
  the top of `budgets.cjs`.

---

## 6. Verification

```bash
# Engine baseline + cycle graph + un-homed constant count
bash docs/verify-agent-engine.sh

# The engine-relevant suites (fast)
cd studio && node --test test/agent.test.cjs test/agent-net.test.cjs test/team-nurse.test.cjs \
  test/team-runner-links-send-completion.test.cjs test/team-runner-stale-output.test.cjs \
  test/team-runtime-routing.test.cjs test/audit-log.test.cjs test/audit-rotation.test.cjs \
  test/sandbox.test.cjs test/sandbox-gating.test.cjs test/compaction.test.cjs \
  test/context-injection.test.cjs test/budgets.test.cjs

# Whole gate — required before any item is marked DONE
cd studio && npm test            # syntax gate + every *.test.cjs
cd studio && npm run test:coverage
```

Invariant checks this document relies on, unchanged from canonical `IMPROVEMENTS.md` §A1–A9:
`A1` (no partial file, no surviving `.tmp`), `A2` (`canonical()` keeps `record.v`), `A3`
(rotation chain), `A4` (archive, never delete), `A7` (`npm test` green), `A9` (clean tree).

---

## 7. Crosswalk to the canonical plan

| Canonical | This file | What this file adds |
| --- | --- | --- |
| `2.4` IPC/tool argument validation | **E3**, **E4**, **E8** | the engine-side mechanism: a schema validated at the single `runToolCall` choke point, recursive result bounding, schema-driven command discovery |
| `2.6` per-conversation size limits | **E5** | **both** constants the canonical evidence cites are dead (plus `agent-loop.cjs:31` `MAX_ROUNDS`); the live caps are `budgets.storedMessages` and `MAX_CONVERSATION_BYTES` |
| `2.8` rate-limit outbound requests | **E1**, **E2** | `Retry-After`, backoff, and the finding that `429` is currently a *permanent* nurse quarantine |
| `3.3` extract `agent-loop` | **E11** | the engine-wide picture: `team-runner` 1,282 and `agent-net` 1,032 are larger than `agent-loop` 670 |
| `3.5` code-index ownership | **E12** | exact locations: TTL, cache and invalidation live in `code-context.cjs` |
| `5.1` crew message persistence | **E6**, **E17** | the journal + evidence ledger design and the test that proves recovery |
| `5.2` observability scope | **E16**, **E17** | a real logger seam and a run ledger (no `console` in the engine) |
| `5.8` durable team recovery | **E6** | in-memory-only evidence (`main.mjs:99`, `team-runner.cjs:163`) and the recovery contract |
| — | **E7**, **E9**, **E10**, **E13**, **E14**, **E18**, **E19** | engine-internal, no canonical counterpart |

---

*Engine scope only. `IMPROVEMENTS.md` remains the single canonical plan and wins on any
conflict; this file states no repo-wide numbers and renumbers nothing. Do not add a third plan:
promote an item into `IMPROVEMENTS.md` and leave the pointer here.*
