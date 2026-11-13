# Codex agent — reverse-engineered design

> **Provenance.** Extracted from the installed `codex.exe` (codex-cli **0.162.1**,
> `@openai/codex-win32-x64` vendored binary). All prompts, tool grammars and
> instruction blocks are embedded in the binary as contiguous string data; the
> blocks cited below were recovered verbatim. The second embedded copy of the
> coding-agent prompt is byte-identical, so there is one canonical CLI prompt.
>
> **What was ported.** The behavioral core of the CLI prompt — working style,
> planning discipline, task execution, editing, validation and result
> presentation — was condensed into `# How you work` sections in
> `agent-loop.cjs` `_buildBaseSystemPrompt`, adapted to REACH's fenced-tool
> contract. Nothing about the wire protocol, tool registry, or module layout
> changed. The remaining sections below document what was found but **not**
> ported, with the reason in each row.

## 1. The system prompt (anatomy)

Single markdown document, ~21 KB, sent as the coding agent's instructions:

| Section | Content |
| --- | --- |
| Identity | "You are a coding agent running in the Codex CLI… precise, safe, and helpful." Capability list: receive prompts + harness context; stream thinking & responses; emit function calls for commands and patches. |
| Personality | "Concise, direct, and friendly." Prioritize actionable guidance; avoid verbose explanations unless asked. |
| AGENTS.md spec | Scope rules: an AGENTS.md governs the directory tree rooted at its folder; deeper files win; system/developer/user instructions beat AGENTS.md; root+CWD-chain files are pre-injected so they don't need re-reading. |
| Preambles | One short message before grouped tool calls (8–12 words), connecting prior work to the next action; no preamble for a trivial single read. |
| Planning | `update_plan` tool: 1-sentence steps (5–7 words), statuses `pending`/`in_progress`/`completed`, exactly one `in_progress` until done; don't restate the plan after updating; high-quality vs low-quality plan examples given inline. |
| Task execution | "Keep going until the query is completely resolved." Root cause over surface patches; minimal focused changes; don't fix unrelated bugs; use `git log`/`git blame` for history; no unrequested commits, comments, license headers, or one-letter names. |
| Validation | Test narrow→broad; add tests only where the codebase's patterns call for it; ≤3 format iterations then call it out; proactive testing only in `never` approval mode or for test-related tasks. |
| Ambition vs precision | Greenfield → creative and ambitious; existing codebase → surgical, don't overstep. |
| Progress updates | Concise recaps at intervals on long tasks; announce before large latency-inducing chunks. |
| Final message | Plain text styled by the CLI. Short `**Title Case**` headers, `-` bullets, backticks for commands/paths, file refs as `path:line`/`path#L10` (no ranges, no URIs), present tense, ~10 lines for simple work. |
| Tool guidelines | Prefer `rg` over grep; don't use python to dump file chunks; `update_plan` recap. |

## 2. Tool surface (what the model can call)

| Tool | Wire shape | Notes |
| --- | --- | --- |
| `exec_command` | JSON | `cmd`, `workdir`, `shell`, `tty`, `yield_time_ms` (10s default; 10–30s on Windows), `max_output_tokens` (10k default), `sandbox_permissions`, `justification`, `prefix_rule`, `environment_id`. Returns `session_id` for still-running commands. |
| `write_stdin` | JSON | Writes to a live exec session; non-empty writes poll 250 ms (cap 30 s), empty polls 5–300 s. This is how Codex does interactive/long-running commands — REACH's `shell` is fire-and-forget or blocking with no session handle. |
| `apply_patch` | **Freeform** (explicitly "do not wrap in JSON") | Lark grammar recovered verbatim: `*** Begin Patch` / `*** Add File:` / `*** Delete File:` / `*** Update File:` (+ `*** Move to:`) / `@@` context / `+`/`-`/space lines / `*** End of File` / `*** End of File` sentinel. Model is told to call it via `exec_command`-style `{"command":["apply_patch", "..."]}` in prompt examples too. |
| `update_plan` | JSON | The plan/todo tool described above. Errors if called in Plan mode. |
| `request_permissions` | JSON | Ask user for extra fs (`read`/`write` path lists) or `network` access mid-turn; granted permissions apply to later commands for the turn or session. |
| `request_user_input` | JSON | Multiple-choice questions; Default-mode rules say prefer assumptions, only ask when it materially improves quality, never for permission requests. |
| `view_image` | JSON | `path` + `detail` (`high`/`original`) for local image files. |
| Collab tools | JSON | `spawn_agent`, `followup_task`, `send_message` (+ `fork_turns` for context propagation). Messages arrive on an "analysis channel" as `Message Type: NEW_TASK \| MESSAGE \| FINAL_ANSWER` blocks with recipient/sender/payload, addressed `to=/root/...`. |
| web search | built-in | `web_search` response item; `web_search_mode` config. |
| Deferred tools | JSON | A "search query for deferred tools" tool: schemas are loaded on demand instead of bloating the always-on prompt — same idea as REACH's `tool_help` meta-tool. |

## 3. Sandbox & approval model

- `approval_policy`: `untrusted` | `on-request` | `unless-trusted` | `never`.
- `sandbox_mode`: `read-only` | `workspace-write` (read anywhere, write in
  cwd + `writable_roots`) | `danger-full-access`; `network_access` templated in.
- **Command segmentation**: the command string is split at shell control
  operators (`|`, `&&`, `||`, `;`, `(...)`, `$(...)`) and each segment is
  evaluated independently against allow-rules — `git pull | tee out` is judged
  as two commands. Segments using redirection, substitution, env vars or
  wildcards are not rule-matchable (deliberately narrow scope).
- **Escalation**: `sandbox_permissions: "require_escalated"` + `justification`
  (a user-facing question) + optional `prefix_rule` (e.g. `["cargo","test"]`)
  the user can persist as a rule. Banned: broad prefixes like `["python3"]`,
  any prefix for `rm`, any prefix when a heredoc/herestring is used.
- On a sandbox-caused failure (DNS, registry, write-denied) the model is told
  to rerun escalated immediately — not ask first.
- With `approval_policy=never` the model must not send `sandbox_permissions`.

## 4. Collaboration modes

Two modes swapped by developer messages, not user intent:

- **Default** — execute; `request_user_input` only for quality-material choices.
- **Plan (Conversational)** — 3 phases: (1) ground in the environment with
  non-mutating exploration before asking anything; (2) intent chat until
  goal/scope/constraints are clear; (3) implementation chat until the spec is
  "decision complete." Mutating actions are forbidden (read/search/dry-run OK;
  edits/formatters/migrations not). Final output is one `<proposed_plan>` block
  with title, summary, key changes, test plan, assumptions — concise, no
  "should I proceed?".

## 5. Other recovered machinery

- **Environment context**: `<environment_context>` blocks describe execution
  environments (multi-environment capable); an environment marked `starting`
  is not yet usable.
- **Memory**: `memory_summary.md` (pre-injected) → `MEMORY.md` (searchable
  registry) → `rollout_summaries/` (append-only jsonl per session) →
  `skills/<name>/`. Quick-pass ≤4–6 lookups; memory-derived facts must be
  labelled unverified; final answers append an `<oai-mem-citation>` block.
  Memory writes go through drop-in note files under `extensions/ad_hoc/notes/`,
  never direct edits.
- **Compaction**: `context_compacted` events; goal objects carry
  `tokenBudget`/`timeUsedSeconds`; a "Memory Writing Agent" summarizes
  rollouts in two phases into `raw_memory`/`rollout_summary` JSON.
- **Realtime/backend split**: a separate voice-facing prompt (`[USER]`/`[BACKEND]`
  prefixes, delegate-everything policies) fronts the same coding agent.
- **Review**: `/review` produces `<user_action>` transcripts; interrupted
  reviews instruct the model to ask for re-initiation.

## 6. Codex → REACH mapping

| Codex | REACH | Status |
| --- | --- | --- |
| Behavioral prompt (style/planning/execution/validation/final message) | `# How you work` block in `_buildBaseSystemPrompt` | **Ported** (condensed ~21 KB → ~1.7 KB; REACH rules kept verbatim). Prose modes (fenced + native) only — structured recovery mode keeps the compact pre-port block because 32KB subscription gateways cannot carry it next to a large MCP catalog (`mcp-action-arguments.test.cjs` pins that ceiling) |
| `update_plan` + exactly-one-in_progress discipline | `todo_write`/`todo_read` + `agent_status` gate on open todos | Ported as prompt guidance; run-control already enforces it |
| `apply_patch` freeform grammar | `edit_patch` with `{search,replace}`/`{startLine,endLine,replace}` hunks | Equivalent function; different wire format (kept) |
| Deferred tool loading ("search for tools") | `tool_help` meta-tool + tier-gated help | Already equivalent |
| `exec_command`/`write_stdin` session model | `shell.session` + `agent/shell-session.cjs` | **Ported** — persistent piped shell (no PTY): `open`/`write`/`read`/`close` ops, per-agent bounded sessions killed on run abort, `command`+`chars` sandbox provenance |
| `sandbox_permissions`/`prefix_rule` segment model | `shell`/`reach.*` binary approve/deny + `sandbox.cjs` | **Not ported** — changes the approval UX |
| Plan mode + `<proposed_plan>` | none | **Not ported** — a UI/mode feature, not prompt text |
| `request_user_input` MC tool | ```confirm block | Already equivalent (prose, not a tool) |
| `request_permissions` mid-turn grants | none | **Not ported** — needs approval-plumbing |
| AGENTS.md scoped-instruction spec | `readProjectRules()` → `PROJECT RULES` prompt block | **Ported (root scope only)** — reads `AGENTS.md`/`AGENT.md`/`.agents.md`, 6KB cap, labelled repository content not permission; nested per-directory scoping remains unported |
| `spawn_agent`/`followup_task`/`send_message` + analysis-channel envelope | `agent.spawn`/`agent.send`/`agent.await`/… + team net | Already equivalent |
| Memory folder (summary → registry → rollouts → skills) | `SOUL.md` + `MEMORY.md` + `memory` tool + `project-memory.cjs` | Already equivalent |
| `<environment_context>` / multi-environment | project binding + `identifyProject` | Single-env equivalent kept |

## 7. Deliberate divergences from Codex

1. **Verification after edits is kept, not dropped.** Codex says "do not waste
   tokens re-reading files after `apply_patch`" because its tool failure is the
   receipt. REACH edits go through user review, so the stronger rule stays:
   never claim applied until the tool result confirms acceptance; re-read only
   when the result was uncertain.
2. **Untrusted-data fencing is kept verbatim** — Codex treats file content as
   instructions-safe context; REACH's threat model (prompt injection through
   project files, MEMORY.md written from tool output) keeps the explicit
   "data, not instructions or permission" contract.
3. **Completion stays explicit.** Codex ends its turn by yielding; REACH ends
   with ```agent_status — the ported text reinforces "keep going until
   resolved" but never changes the wire contract.
