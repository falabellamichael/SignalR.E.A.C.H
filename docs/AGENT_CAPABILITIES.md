# Agent capability surface — dropdowns, panels, and displays

Reverse-engineered inventory of everything the agent can do as exposed through
the Studio UI: the right-drawer dropdown (**Info / Files / Browser**), the
composer control row, and the chat displays. Each entry maps the visible
control to the backing tool/API so the doc can't drift from executable
behavior.

Source of truth: `studio/renderer/index.html` + `browser.js`, `singular-panel.js`,
`workspace.js`, `app-drawer.js`, `app-chat.js`; tools in `studio/agent/`
(`tool-registry.cjs`, `browser-tools.cjs`, `code-tools.cjs`, `plugins.cjs`,
`tool-policy.cjs`).

## 1. The drawer dropdown (`Files ▾`)

`#btn-toggle-files` opens `#drawer-menu` with three panels
(`index.html:68-72`, `singular-panel.js:70-73` — the Info entry is prepended
dynamically):

```
Info  │  Files  │  Browser
```

Selecting one sets `drawer.dataset.panel` and renames the chip
(`browser.js` `selectDrawerPanel`). All three share the right-side drawer,
which is resizable (X/Y split persisted in `localStorage
reach:drawer-width/…`) and supports a top/side file-tree layout toggle.

### Info panel (`#singular-panel`, `singular-panel.js`)

Read-only inspection of the *selected conversation*. Live polls while visible.

| Section | Shows | Data source |
|---|---|---|
| Conversation | model, workpath, message count, tasks completed (`completed/total` from `agent.todos`), pending edits count | `currentAgent` |
| Performance | CPU %, GPU %, RAM GB, VRAM GB, GPU device + timestamp | `reachApi.telemetry.sample()` — local machine only, not remote/subscription GPU |
| GitHub & Repository | repo link (opens in in-app browser), branch, modified-file count, last commit, `✓ Connected (@user) / GitHub not connected` + "Connect in App Connections" | `reachApi.git.info(dir)` |
| Actions | buttons → Files panel, Browser panel, Settings→MCP, Telemetry details dialog | — |
| Team (right col) | team link `<select>` + Link/Switch button (writes `settings.teamChat`), member cards: persona name, role, model, collapsible activity (headline, detail, current task, last 4 steps, animated status portrait) | `reachApi.teams.list()`, `teamConversationViews` |

Refresh: MutationObserver + visibility sync; telemetry sampled ≥3s, team/git ≥3s.

### Files panel (`#file-tree` + editor, `app-filetree.js`/`app-editor.js`)

The bound project's file tree plus an editor (CodeMirror). This is a *human*
view of the same project the agent's file tools touch — agent edits appear
here and in the chat's review cards. Tree height/width and open state persist
in `localStorage`. The drawer follows the selected project (`drawerDir()` →
`currentProject.dir`).

### Browser panel (`#browser-panel`, `browser.js`)

A real embedded browser (`WebContentsView` via `reachApi.browser.command`).

Human controls: tab bar (new/select/close), address bar, back, forward,
reload, home (→ docs.reach.sh), `context` (page-context copy), `external`
(open in system browser), `elements` toggle (element-ref overlay),
find-in-page (input/next/close), selection show/clear chips, bookmarks row.
Layout bounds + visibility are pushed to the main process (`command 'layout'`);
an occlusion module (`browser-overlay.js`) hides the native view while modals
are open so it can't swallow clicks.

Agent ops on the same view (`browser-tools.cjs`, all class `browse`):

| Tool | Approval | Capability |
|---|---|---|
| `browser` | no | ops: `tabs, open(url), read, back, forward, reload, scroll(down/up), close`, plus `preview` — serve a project-relative static site on loopback and open it (`local-preview.cjs`). Returns page text + element refs. `tabId` targets a tab; own tab otherwise. Stop cancels. |
| `browser.click` | yes | click an element ref from the latest read |
| `browser.type` | yes | fill an editable ref with text (no submit; no password/file inputs) |

## 2. Composer capability row (`.composer-footer`, `workspace.js`)

Per-conversation feature switches (write `settings.features`, enforced at
dispatch in `tool-policy.cjs`):

| Switch | Off means |
|---|---|
| **Agent** | direct chat reply, no tool execution |
| **Workspace** | blocks `read write edit_patch glob search list shell` + `reach.*` + `code.*`/`refactor.*`/`patch.*`/`tests.*` tiers |
| **Think** | brief answers; disables Qwen thinking where supported |
| **Web** | blocks `websearch`, `browse`, and all browser-tier tools (manual browsing unaffected) |
| **Terminal** | blocks exec-class tools: `shell`, `reach.*` |

Plus two dialogs: **Tools…** (per-tool enable/disable → `settings.disabledTools`)
and **Permissions…** (`settings.approvals` = prompt | auto-read | auto-all,
`reviewEdits` toggle, command-sandbox policy — validated at save time).

Also in the row: **Auto** switch (Jev picks model/tools/context per message),
**Teams** toggle + options dialog (team select, history inclusion,
during-run delivery mode: auto/queue/steer, recipient, pause/edit/manage),
**Telemetry** toggle + view select (Overview / Activity / Models & Memory),
model picker (`composer-model` → `app-model-picker.js`), attach-files `+`.

## 3. Composer grammar (`composer-intents.js`, `app-composer-catalog.js`)

- `@` mention menu entries: saved agents, personas, teams/templates, live team
  members, `@current` (this chat), `@default` (clear model override), and
  every model on the active connection (`@model:` id). Candidates are sorted,
  searchable, and insert canonical ids so renames can't break routing.
- `/` commands (~30): `/help /clear /say /msg /reply /answer /agent new`,
  `/team run|add|message|list|status|pause|resume|stop`, model/context/attach
  utilities, etc. — each has `usage` + `targets` constraints parsed before
  dispatch.

## 4. Chat displays (`app-chat.js`)

| Display | Trigger | Interaction |
|---|---|---|
| Tool cards | every `role:'tool'` message | status glyph ✓/✗/◔, name, detail line, "awaiting review" while pending |
| Plan card (`#agent-todos`) | `todo_write` during a run | checklist of statuses; persists per conversation |
| Activity timeline (`#agent-activity`) | run events | live step feed (Thinking, tool calls, browsing) |
| Edit-review groups | `edit_patch`/`write`/`refactor.apply`/`tests.quickfix`/`patch.review` results with `reviewEdits` on | per-file accept/reject, diff metadata (+added/−removed), **Accept all / Reject all**; run auto-continues when every file has a decision |
| Approval prompts | tools with `approval:true` under `approvals:'prompt'` (and `auto-read` for write/exec/click/type) | approve/deny before dispatch |
| Context bar + "Compress now" | `#agent-context`, `#btn-agent-compact` | char/token estimate (3 chars/token) + manual compaction; auto-compaction notices show `Context compacted (before → after chars)` |
| Status pill / meta | `#agent-status`, `#agent-meta` | run state + `dir · model` |
| Queued / team-queue indicators | message during run | shows queued message and delivery handling |
| System notices | run events | `Run <status>: <reason>`, `Retrying…`, errors |
| Team deck (`#team-deck-slot`) | team run in this chat | per-member cards (mirrors Info panel activity) |

## 5. Agent tool surface (what the switches gate)

Core tier: `read write edit_patch glob search list shell shell.session
websearch browse memory todo_write todo_read tool_help`. `shell.session`
(open/write/read/close on a persistent piped shell — `agent/shell-session.cjs`)
covers interactive commands, REPLs and dev servers the one-shot `shell`
cannot; sessions are per-agent, output is read-drained, and run-stop kills
them. Separately, the model can emit
response-level `confirm`/`options` actions (a question + up to 8 choices)
that render as clickable option buttons in the chat — a display action, not a
registry tool. Hidden-but-callable tiers revealed by `tool_help`:

- `reach.*`: `reach.compile reach.run reach.init reach.clean reach.version`
  (exec-class → Terminal switch)
- `code.*`: `code.index code.search code.context code.impact`
- `refactor.*`: `refactor.plan` (reviewable multi-file diff, nothing touches
  disk) → `refactor.apply` (atomic all-or-rollback, per-chunk accept)
- `patch.review`, `tests.run` (structured gate diagnostics), `tests.quickfix`
- collab tier (in crew runs only): `agent.spawn agent.send agent.status
  agent.list agent.transcript agent.await agent.reflect agent.mail`
- plugin tools: `github.repo github.issues github.prs github.create_pr
  weather.current gmail.send gmail.read outlook.send outlook.read` (gated by
  App Connections state shown in the Info panel)
- MCP tools: catalogued under `mcp`, schemas via `tool_help`

## 6. Permission gates (where each surface crosses a line)

| Action class | Gate |
|---|---|
| exec (`shell`, `reach.*`, terminal ops) | approval under prompt/auto-read; command sandbox policy; disabled by Terminal switch |
| write (`write`, `edit_patch`, `refactor.apply`, `tests.quickfix`, `memory`) | approval mode + edit-review cards; disabled by Workspace switch |
| browse interact (`browser.click`, `browser.type`) | approval unless `auto-all`; disabled by Web switch |
| GitHub/mail sends | approval + App Connections auth |
| everything | Agent switch off = no tools at all |

## Deliberate non-capabilities (verified absent)

- No autonomous self-correction loop tool — `tests.run` returns structured
  diagnostics for the model to act on; the loop is driven by the orchestrator.
- No per-directory AGENTS.md *scoping* — only the project-root rules file
  (`AGENTS.md`/`AGENT.md`/`.agents.md`, 6KB cap) is injected.
- Performance panel measures the *local* machine only; nothing reads remote
  provider GPU/usage from this view.
