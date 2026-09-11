# Plan: REACH Agent Capability Upgrade

## TL;DR

REACH's agent today is a **text-fenced tool protocol** with 12 hand-rolled verbs
(`read`, `search`, `list`, `shell`, `browse`, `websearch`, plus 6 VS Code
inspection actions). It works, but it is missing the things every serious 2026
coding agent has: a first-class **browser as a tool** (not just "fetch text"),
**todo/plan state**, **patch-based edits** with verification, **dialect-tolerant
tool parsing**, and a **structured tool registry** with per-tool approval and
capability negotiation. This plan adds those, borrowing patterns from
SWE-agent's Agent-Computer Interface, Cline/OpenCode's tool registry, and
Playwright-MCP / browser-mcp's browser tool surface — but implemented in REACH's
existing **zero-dependency, fenced-JSON, local-first** style so nothing about the
current install/uninstall model changes.

Recommended approach: introduce `vscode/tools.js` as a single **tool registry**
(schema + executor + approval class), wire the existing 12 actions into it,
then extend the browser from `browse` into a full **stateful browser session**
(`open / snapshot / click / type / press / scroll / back / screenshot /
console / network / close`), reusing the already-shipped Electron engine in
`server/browser-engine/main.cjs` and the Python `BrowserEngine` bridge.

---

## Current state (verified)

| Capability | Where | Status |
|---|---|---|
| Fenced ```` ```tool ```` JSON protocol | `vscode/media/chat.js` `extractTools()` L241-287 | works; single dialect |
| Tool execution | `vscode/extension.js` `case 'toolReq'` L701-782 | 12 actions, inline if/else |
| VS Code inspection actions | `vscode/agent-bridge.js` `ACTIONS` L7 | 6 actions |
| Agent loop / rounds | `vscode/media/chat.js` L78 `MAX_AGENT_ROUNDS = 40` | rounds + 2 retries + pause |
| Browser panel (human) | `vscode/extension.js` L1754-1869 | navigate/back/forward/reload |
| Browser engine (Electron) | `server/browser-engine/main.cjs` | tabs, navigate, frame, input, text, snapshot, find, back/forward/reload |
| Browser engine bridge | `server/reachd/browser_engine.py` `_ACTIONS` L30-31 | 14 actions, session TTL |
| Agent `browse` tool | `vscode/search.js` `browsePage()` L313 | text + optional screenshot; stateless |

## Gaps found

1. **No browser tool surface for the agent.** `browse` is one-shot
   (URL → text). The agent cannot click, type, press keys, scroll, wait for a
   selector, read console errors, or inspect network requests. The Electron
   engine already supports `input` / `frame` / `snapshot` / `find` — but only
   the *human* panel reaches it, never the agent.
2. **No todo / planning tool.** The agent announces a plan in prose only; there
   is no persisted task list the UI can render or the model can update. Round
   limit is a blunt pause with no state.
3. **Edits are search/replace only.** `vscode/edits.js` `locateEdit()` requires
   an exact unique match. No patch format, no multi-hunk, no
   "apply then re-read to verify".
4. **Tool parsing is brittle.** `extractTools` accepts exactly
   ```` ```tool ```` or `<tool>`; `repairJson` is the only tolerance. Models that
   emit `tool_calls` (native function calling) or `<tool_call>` / `<invoke>` XML
   are silently ignored.
5. **No per-tool capability/approval model.** `shell` and VS Code
   `runTask`/`vscodeCommand` prompt; everything else is silent. There is no
   declared read-only vs mutating class, no per-tool enable toggle.
6. **No tool result budget policy per tool.** One `slice(0, 40000)` for all
   non-read actions (L777); large search results and network logs get flattened.
7. **No browser ↔ editor bridge.** The agent cannot screenshot a running dev
   server and connect a console error back to the source file that caused it.
8. **No agent-visible test/verify loop.** `shell` sends text to a terminal the
   model explicitly "cannot read" (L745). There is no way to run a command and
   get its output back.

---

## Proposed design

### New file: `vscode/tools.js` — the tool registry

A single source of truth: each tool is
`{ name, class: 'read'|'write'|'exec'|'browse', approval, budget, schema, run(ctx) }`.
Exports:

- `TOOLS` — map of name → definition (name, class, approval, budget, help line)
- `toolHelp()` — generates the system-prompt help block from the registry
  (replaces the hardcoded string in `extension.js` L69-115)
- `allowedNames()` — drives `chat.js` `allowedTool` so the two lists can never
  drift again (today they are duplicated at `chat.js` L251 and `agent-bridge.js` L7)

The existing 12 actions become registry entries whose `run` bodies are the
current `case 'toolReq'` branches, moved verbatim. No behavior change in phase 1.

### Browser as a first-class tool set

Extend the **already-shipped** engine rather than adding Playwright:

- Bridge: `server/reachd/browser_engine.py` already forwards `input`, `frame`,
  `snapshot`, `find`. Add a thin agent-facing wrapper that opens a session per
  agent run and exposes:
  `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`,
  `browser_press`, `browser_scroll`, `browser_back`, `browser_wait`,
  `browser_console`, `browser_network`, `browser_screenshot`, `browser_close`.
- Transport: reuse the VS Code extension's existing `simplereach.openBrowser`
  webview panel state and the Python `BrowserEngine` HTTP bridge — the agent
  drives the **same** session the user can watch, so "show me what the agent
  sees" is free.
- Add `console` / `network` capture in `server/browser-engine/main.cjs` via
  `webContents.on('console-message')` and `webContents.session.webRequest`
  (currently absent — the engine has no log rings).
- Capability gating: reuse `browser_engine.py` `allowed_origin()` and the SSRF
  guards in `browser.py` (public-address-only, redirect re-check). Keep the
  existing loopback rule so an agent can screenshot a local dev server but
  cannot reach arbitrary private hosts.
- Reference surfaces studied: Playwright MCP (21 tools / ~13.7k tokens),
  Chrome DevTools MCP (26 tools / ~18k tokens), browser-mcp's 12 verbs, and
  mariozechner's argument for **few, composable tools over a large MCP schema** —
  which is why this plan adds ~12 verbs, not 25, and keeps them out of the
  always-on prompt (loaded on demand, see below).

### Todo / plan state

- New registry entries `todo_write` (replace list) and `todo_read`.
- State lives in the extension host (per conversation id), mirrored to the
  webview so the existing activity timeline can render a live checklist.
- On round-limit pause, the todo list is what "continue" resumes from — turns
  the blunt `MAX_AGENT_ROUNDS` pause into a resumable plan.

### Patch-based edits + verification

- Add an `edit_patch` tool: unified-diff-ish multi-hunk applied through a new
  `applyPatch()` in `vscode/edits.js`, falling back to today's
  `locateEdit()` for single-hunk edits so existing behavior is preserved.
- Add `read_after_edit` verification step: after `applyEdit`, re-read the
  changed range and return it to the model so it can confirm its own change
  (today `applyEdit` L622-661 applies and reports, but never re-reads).

### Parser hardening

- Extend `extractTools()` (`chat.js` L241) to also accept:
  - native `tool_calls` / `function_call` from the SSE stream,
  - `<tool_call>`, `<invoke>`, `<function_calls>` wrappers (Cline / Anthropic style),
  - ```json fenced blocks whose only key is `action` or `name`.
- Keep the rule "only explicit, complete wrappers are executable; ordinary JSON
  remains chat content" (comment at L244) — this is a safety property, not an
  accident.

### On-demand tool help (context discipline)

- The 12 browser verbs must not bloat every turn. Extend `agent-bridge.js`'s
  existing `TOOL_HELP` pattern (L8-24) with a **two-tier** help block: core
  tools always described, browser tools described only when the user or model
  signals a browser task, plus a `tool_help` meta-tool to pull the full schema.
  This is the mariozechner "read the README, don't inject 14k tokens" pattern.

---

## Steps

**Phase 1 — Registry, no behavior change**
1. Create `vscode/tools.js` with schema/executor/class/approval/budget for the
   existing 12 actions. *Parallel with step 2.*
2. Generate the system-prompt help from the registry; delete the hardcoded
   block in `extension.js` L69-115 and the duplicated allow-list in
   `chat.js` L251 / `agent-bridge.js` L7.

**Phase 2 — Parser + loop** *(depends on 1)*
3. Extend `extractTools()` for native `tool_calls` and XML wrappers.
4. Add `todo_write` / `todo_read`; render the checklist in the activity
   timeline and wire it into the round-limit "continue" path.

**Phase 3 — Edits** *(depends on 1)*
5. Add `applyPatch()` to `vscode/edits.js`; add the `edit_patch` tool.
6. Add post-edit re-read verification.

**Phase 4 — Browser tools** *(depends on 1; independent of 3-6)*
7. Add console + network ring buffers to `server/browser-engine/main.cjs`.
8. Expose the 12 browser verbs through the registry, driving the existing
   Electron session and the Python `BrowserEngine` bridge.
9. Add the two-tier help block + `tool_help` meta-tool.

**Phase 5 — Verify**
10. Tests (below), docs (`README.md` agent section), and a manual end-to-end
    browser task.

---

## Relevant files

- `vscode/tools.js` — **new**: tool registry (schema/executor/class/budget).
- `vscode/extension.js` — `case 'toolReq'` L701-782 moves into the registry;
  `DEFAULT_AGENT_PROMPT` L69-115 becomes registry-generated; `applyEdit` L622-661
  gains verification.
- `vscode/agent-bridge.js` — `ACTIONS` L7 / `TOOL_HELP` L8-24 fold into the
  registry; keeps the six VS Code inspection actions.
- `vscode/media/chat.js` — `extractTools()` L241-287 (parser), `beginToolRound()`
  L814 (new verb labels), `MAX_AGENT_ROUNDS` L78 + continuation L1850-1872 (todo
  resume).
- `vscode/edits.js` — add `applyPatch()` beside `locateEdit()` L5 / `repairWindow()` L19.
- `server/browser-engine/main.cjs` — add console/network capture; existing
  action set at L11-18 (`MAX_TABS`, input types) stays.
- `server/reachd/browser_engine.py` — `_ACTIONS` L30-31 gains the agent-facing
  verbs; `allowed_origin()` L34 and session TTL L26 unchanged.
- `server/reachd/browser.py` — SSRF/public-address gates reused verbatim
  (`fetch_page()` L221, `BrowserError` L30).
- `vscode/search.js` — `browsePage()` L313 becomes the fallback when the
  Electron engine is unavailable; `pageText()` L256 unchanged.
- `tests/` — new `vscode_tools_registry.test.cjs`, `vscode_tool_parsing.test.cjs`,
  `vscode_edits_patch.test.cjs`, `vscode_browser_tools.test.cjs`; patterns
  copied from `tests/vscode_header_parsing.test.cjs` (extract a function from
  `extension.js` via `vm`, no `vscode` module needed).

## Verification

1. `node --test tests/vscode_*.test.cjs` — all existing agent tests still pass
   (regression gate for the registry refactor).
2. New unit tests: registry round-trips every action name; parser accepts
   ```tool, `<tool>`, `<tool_call>`, `<invoke>`, and native `tool_calls`;
   `applyPatch()` on multi-hunk and CRLF inputs; browser verb → engine action
   mapping.
3. `python -B -m unittest tests.test_browser_engine tests.test_browser -v` —
   engine bridge still passes; new console/network capture covered.
4. Manual: open the REACH Browser, ask the agent to "open the local preview at
   `http://127.0.0.1:21887`, screenshot it, click a link, and report console
   errors" with `python -B tests/browser_preview.py` running.
5. Manual: a multi-step task that exceeds 40 rounds, confirming the todo list
   survives the pause and "continue" resumes from it.

## Decisions

- **Reuse the Electron engine, not Playwright.** Playwright is *optional* today
  (`vscode/search.js` `playwright` L15, `hasPlaywright()`), while the Electron
  engine ships with the tray and is already bridged by `browser_engine.py`.
  Adding a second browser stack would double the install surface for no gain.
- **~12 browser verbs, not the 21-26 that Playwright/DevTools MCP expose.**
  Tool count directly costs context; the cited comparison is 13.7k vs 18k tokens
  before the agent does any work.
- **Browser tools are opt-in help, not always-on prompt text.** Keeps a normal
  coding turn as cheap as it is today.
- **Registry first, features second.** Phase 1 changes no behavior, so a
  regression is unambiguous.
- **Out of scope:** MCP client support, sub-agents, multi-model routing,
  changes to the relay/endpoint (`server/reachd/chat.py`), and the tray UI.

## Further Considerations

1. **Browser session ownership.** Should the agent's browser session be the
   *same* panel the user watches (observable, shared history — my
   recommendation), or a separate headless session (cleaner, but "what the
   agent sees" needs a screenshot round-trip)? Option A: shared panel /
   Option B: separate session / Option C: shared by default, `browser_open`
   takes `headless: true` to opt out.
2. **Edit verification strictness.** After `edit_patch`, should a failed
   re-read *revert* the edit (safe, but surprising) or *report* the mismatch and
   let the model retry (my recommendation — matches the existing
   `repairWindow()` philosophy)? Option A: auto-revert / Option B: report and
   retry / Option C: report and stop the run.
3. **Todo persistence.** Should the todo list survive a VS Code reload like
   `conv.activity` does, or live only for the current run? Recommend surviving
   the run only, to avoid a stale checklist outliving its task.
