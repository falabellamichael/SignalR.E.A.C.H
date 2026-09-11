# SignalR.E.A.C.H

**REACH** = **R**AG **E**ndpoint & **A**I **C**hat **H**ost

A plugin for SimpleRAG — installable straight from this GitHub URL — that adds a hosted OpenAI-compatible endpoint with **unlimited gpt-4o for everyone**. No API key, no quotas, no signup. Requests are relayed through a local [OmniRoute](https://github.com/diegosouzapw/OmniRoute) instance's `codegpt` provider.

The plugin installs a full **control panel** into SimpleRAG's app bar — a menu panel with eight pages: **Dashboard, Browser, Endpoint, Models, Usage, Logs, Settings, About** — plus a dependency-free relay server, hosting tunnel, and a pointer URL that always resolves the live endpoint.

| | |
|---|---|
| **Endpoint pointer (always current URL)** | <https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt> |
| **Models** | `gpt-4o`, `gpt-4o-mini` (aliases → `codegpt/codegpt-gpt-4o[-mini]`, fully tunable per alias) |
| **CodeGPT economy models** | `deepseek-v4.1-flash`, `ox-alpha`, `gemini-3.8-flash`, `gpt-5.6-luna`, `glm-5.2`, `MiniMax-M3` — see [CodeGPT economy models](#codegpt-economy-models) |
| **Auth** | none by default (optional shared access key, IP allow/block lists) |
| **Streaming** | SSE, OpenAI wire format |
| **Caching** | optional response cache (LRU, TTL, temperature-aware keys) |
| **Version** | 26.9.2 <!-- x-release-please-version --> |

## CodeGPT economy models

CodeGPT's paid plans include an **economy tier** that costs no credits. The list is
**discovered live**, never hardcoded: the CodeGPT extension keeps a local sidecar
(`127.0.0.1:54112`) whose `/api/fetch-data/catalog` serves the same credits menu its
own model picker renders, and every entry carries a `pro` flag — the whole
economy/premium split is `pro ? 'premium' : 'economy'`. At the time of writing that
menu answers with:

| id | model | badge |
|---|---|---|
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash | New! |
| `ox-alpha` | GLM 5.3 Flash | Economy |
| `gemini-3.8-flash` | Gemini 3.8 Flash | Economy |
| `gpt-5.6-luna` | GPT 5.6 Luna | Economy |
| `glm-5.2` | GLM 5.2 | Economy |
| `MiniMax-M3` | MiniMax M3 | Economy |

`copilot/tray/economy-models.js` reads that menu every five minutes (falling back to
the last known good list when the sidecar is down) and exposes one bridge model per
entry as `codegpt-eco-<id>`. A bundled catalog also ships inside the extension, but
it drifts — it still flags `deepseek-v4-flash` and `gemini-3.6/3.7-flash` as economy
while the live menu offers `gpt-5.6-luna`, `glm-5.2` and `MiniMax-M3` instead, which
is why the sidecar wins whenever it answers.

They are served **through the local tray bridge**, not OmniRoute: an alias whose
upstream is prefixed `bridge/` (e.g. `bridge/codegpt-eco-ox-alpha`) is posted to
`bridge_url` (default `http://127.0.0.1:21302/v1`) without the OmniRoute bearer
token, because the bridge answers them from the host's own signed-in CodeGPT
session — the only place the economy tier exists. `server/reachd/settings.py`
(`CODEGPT_ECONOMY_MODELS`) owns the public aliases and mirrors that live menu; an
alias that is **already routed keeps its own upstream**, so the economy defaults
never steal a name that main already points somewhere else.

### Why not through CodeGPT's API

Verified against the live API, so this does not get re-litigated:

- `POST /api/v1/chat/completions` is **agent-bound**. A `model` field is accepted
  and ignored; the agent's own model answers.
- `POST /api/v1/agent` and `PATCH /api/v1/agent/{id}` both reject economy ids with
  `invalid_enum_value`; their enum is legacy-only (`gpt-4o`, `gpt-4o-mini`,
  `gpt-4-turbo`, `claude-3.5-sonnet[-google]`, `gemini-1.5-flash`,
  `gemini-1.5-pro-latest`, `claude-3-haiku`, `mistral-large-2`). Agents bound to
  newer models exist, but only the web app can create them.
- `/api/v1/chat/completion` (the extension's own commit-message route) is legacy
  too — `gpt-3.5-turbo`…`gpt-4o`, and even those now answer
  `OpenAI completion via Azure not available: Azure provider removed`.
- `/api/v1/chat/playground` answers `404 {"code":"plan_not_found"}` for both the API
  key and the sidecar's session token, whose signed identity carries
  `planName: "Free"`.
- The agent page's own model menu lists **premium models only** ("… – pro model"),
  so economy models are not selectable there.

### Working local route (REACH and SignalREACH)

Keep VS Code with CodeGPT running and signed in. In REACH or the SignalREACH tray,
choose **CodeGPT economy models** and select a model. The tray serves them at
`http://127.0.0.1:21302/v1` using `codegpt-eco-<id>` model IDs. The bare
`codegpt-eco` (and legacy `codegpt-eco-gpt-4o-mini`) selects the first economy
entry rather than an arbitrary page default.

The tray opens `http://localhost:54112/<driver>/`: **54112 is the Next web
server; `<driver>` in the path is the CodeGPT extension's API port**. The
extension re-allocates that port on every activation (it moved 54113 → 54114
across reloads), so the tray **discovers it live** by probing each candidate's
`/version` — the driver answers with its version string, the sidecar answers
HTML and is ignored. That is why the port is never pinned: opening `/54112/`
(or a stale driver port) renders the UI but sends chat to the wrong backend,
producing HTML instead of JSON — or no reply at all.
The tray confirms the requested model in the local picker, submits once, and
captures `/api/runs` NDJSON. Only the final assistant answer is returned, without
reasoning blocks, progress labels, or the old response-length truncation.
A failed model switch is an error, never a silent fallback. Invalid responses
and approval-required runs fail explicitly; a run that never answers is waited
for, not cut off.

The separately hosted public endpoint needs the updated tray on its own host;
updating a client machine does not update that host. Its relay uses the existing
`bridge/codegpt-eco-<id>` aliases described above.


## Use the endpoint

```bash
curl "$(curl -s https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt)/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="<URL from the pointer above>/v1", api_key="not-needed")
reply = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)
```

**In SimpleRAG:** open the REACH page → **Endpoint** → hit **Add to SimpleRAG** (one click), or do it manually: Endpoint settings → OpenAI-compatible → Base URL `<URL>/v1`, model `gpt-4o`, API key blank.

> The public URL is a tunnel that changes when the host restarts it — always resolve it through the pointer gist above (the REACH panel and README do this automatically).

## Install the plugin — one-click

```powershell
# Windows
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/falabellamichael/SimpleREACH/main/install.ps1 | iex"
```

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/falabellamichael/SimpleREACH/main/install.sh | sh
```

Or install manually:

```bash
git clone https://github.com/falabellamichael/SignalR.E.A.C.H.git
cd SignalR.E.A.C.H
python tools/reach.py install
```

`install` does everything:

1. **Plugin panel** — installs the REACH control panel into SimpleRAG's app bar via the *local-extension registry* (`%LOCALAPPDATA%\RAGWorkspace\extensions\`). **Zero SimpleRAG files are modified**; uninstall removes just the registry entry. Old plugin versions of SignalR.E.A.C.H are pruned on upgrade.
2. **Relay server v2** — copies a dependency-free relay to `%LOCALAPPDATA%\SignalREACH\` and auto-detects the OmniRoute API key from `~/.omniroute/storage.sqlite` (stored only in local `config.json` — never committed, never exposed). `install` restarts the relay so new server versions load immediately.
3. **Hosting** — starts the relay on `127.0.0.1:20777` and opens an **ngrok** tunnel (`--tunnel cloudflared` uses the cloudflared binary OmniRoute ships, no account needed). The public URL is published to the endpoint-pointer gist.
4. **VS Code extension** — side-loads the REACH chat extension into VS Code (`~/.vscode/extensions/`, no marketplace/vsce needed). Reload the window and click the **REACH icon** in the Activity Bar for a chat panel with model picker + streaming. Skip it with `--no-vscode`; manage it later with `python tools/reach.py vscode install|uninstall|status`.
5. **Control panel** — open SimpleRAG → Advanced → **REACH** for the full menu panel.

## Connect the SimpleRAG panel to the hosted endpoint

On a client machine without OmniRoute, run `node tools/endpoint-client.cjs` (Node.js 22+).
This loopback-only bridge serves the panel at `127.0.0.1:20777`, follows the published
endpoint pointer, and forwards status, models, and streaming chat to SignalREACH.
It does not start a public tunnel or publish a new endpoint. Hosting settings and
administrative actions remain on the host. Stop any local hosting relay before
starting this client bridge, since both use port 20777.

## VS Code

The bundled extension (`vscode/`) is a zero-dependency chat panel for VS Code:

- **Activity Bar icon** opens the REACH chat — model dropdown, streaming replies, conversation history.
- **Zero config by default** — follows the published endpoint pointer and loads its models. Existing `simplereach.endpoint` settings are preserved; additional providers can be added in the REACH settings panel.
- Installed automatically by `install` / `install.ps1`; standalone: `python tools/reach.py vscode install` (copy-based side-load, no vsce/npm build step).

Long agent conversations now compress automatically for every provider before
reaching the relay request cap. Older turns and tool output become a reusable
memory of the goal, constraints, decisions, and remaining work; recent source
stays verbatim when it fits. Oversized single reads are summarized with explicitly
labelled excerpts. The visible chat stays intact, and the memory carries across
tool rounds, follow-up turns, and reloads. Earlier source must be reread before
editing it. Compression progress appears in the chat; a lower advertised character
limit triggers one smaller-context retry.

The agent activity timeline keeps each action with its output underneath, including
workspace reads, searches, compression, and public assistant updates between tool
rounds. Failed and stopped actions remain visible. Large results expand during the
session; conversation history saves an explicitly labelled preview of up to 12,000
characters per result. Activity is stored separately from model context.

Every step is numbered and carries a one-line quip; the step the run is currently
on is highlighted, and the timeline header shows where the run is — "Step 5", or
"Plan 2/5" when the model maintains an Agent-plan checklist — over a progress bar
(determinate against the plan, indeterminate otherwise). With a plan, steps are
grouped under the plan item they belong to ("Plan 2/5 · Run the tests"). A finished
step keeps its result in a dropdown ("Result · N characters") beside its duration;
running steps render live inline, a dropdown you open stays open and keeps updating
as data arrives, and failures open on their own so the error is visible. Numbering,
quips and groups are deterministic and survive a window reload.
Agent runs have **no fixed limits**. Three settings decide the effort, all defaulting
to **0 = no limit**:

- `simplereach.agentMaxRounds` — model ↔ tool exchanges allowed per request. At 0 the
  agent keeps working until the task is done or you press Stop; a positive number
  pauses at that many rounds instead.
- `simplereach.agentUnfinishedRetries` — extra rounds given when a reply announces
  work it never starts. At 0 it keeps chasing the announced work; a positive number
  pauses with “continue” after that many nudges.
- `simplereach.toolResultBudgetKb` — how much of a tool result (KB) is kept in
  context (`read` always keeps the complete result). At 0 complete results are kept
  and automatic context compression protects the request size.

If a limit is set and reached, the pause is explicit; send “continue” to resume with
saved context. Stop prevents another tool round or queued follow-up from starting
automatically.

With **Workspace** and **Agent** enabled, REACH selects and reads relevant source
files, including closed files, before Think and the final answer. Complete files
are included within the workspace context budget; omitted files are listed so
further reads can retrieve them. The Workspace badge counts files actually read.
Copilot requests also preserve this context through older hosted shims that drop
system messages. Long Copilot requests are read in bounded parts to avoid the
hosted browser input limit; the final answer uses condensed reading notes. The
sidebar shows reading progress, and Stop cancels remaining parts.

With **Agent** enabled, the `read` tool returns complete workspace text files,
including unsaved editor changes. Open-file context is labelled when it is only
a preview. Reads over 1 MiB return an explicit error instead of truncated text;
the model can request inclusive `startLine` / `endLine` ranges. File results stay
available across tool rounds within the current response. Provider context limits
still apply.

### Agent tools
Every agent tool is declared once in `vscode/tools.js` — its class, whether it
needs approval, its result budget and its help line. The system prompt, the
client-side parser allow-list and the executor all read from that one registry,
so they cannot drift apart; `tests/vscode_tools_registry.test.cjs` fails if a
registered tool has no executor branch, or the parser accepts an unregistered one.

- **Planning.** `todo_write` replaces the structured checklist and `todo_read`
  reads it back. The plan renders as a live card in the activity timeline that is
  re-painted in place, and it is what "continue" resumes from after the 40-round
  pause. It is deliberately not persisted across a reload, so a stale checklist
  cannot outlive its task.
- **Browser.** Twelve stateful verbs — `browser_open`, `browser_snapshot`,
  `browser_click`, `browser_type`, `browser_press`, `browser_scroll`,
  `browser_wait`, `browser_back`, `browser_console`, `browser_network`,
  `browser_screenshot`, `browser_close` — drive the *same* Electron session the
  REACH Browser panel shows, so you can watch what the agent does. Snapshots list
  interactive elements as numbered refs. Console and network rings let the agent
  diagnose a broken page instead of guessing. The existing SSRF/public-address
  guards still apply.
- **Edits.** `edit_patch` applies a multi-hunk patch through `applyPatch()`,
  falling back to single-hunk search/replace so existing behaviour is unchanged.
- **Opt-in help.** The browser verbs are not injected into every turn. Core tools
  are always described; emit `tool_help` with `topic: "browser"` to receive the
  browser set. A normal coding turn stays as cheap as it was.

Tool dialects: the parser accepts REACH's own fenced ```tool blocks, `<tool>`, and
`<tool_call>` / `<invoke>` wrappers (Cline / Anthropic style), plus a `name` +
`arguments` object. Only explicit, complete wrappers execute — ordinary JSON in a
reply stays chat content. That is a safety property, not a formatting detail.

## Desktop tray: macOS, Windows, and Linux

The tray and VS Code extension both offer **Free endpoints** and **Microsoft 365 Copilot**.
Free endpoints follow the published URL pointer and load the available models. In the tray,
open **Controls** to set another endpoint. In VS Code, **Settings** keeps the original
**Free endpoints** URL locked; use **+** to add URLs and **−** to remove them.
Added URLs appear under **Other providers** in the provider selector. Selecting one
loads its own models and routes chat to that endpoint.

Each VS Code endpoint has a key button on its left. Click it to show or hide that
endpoint's access-key field. Keys save independently; changing an endpoint URL does
not copy its old key to the new address. The original endpoint keeps its existing
`simplereach.accessKey`; added keys are stored in `simplereach.endpointAccessKeys`.
Removing the selected endpoint returns the selector to **Free endpoints**.

Access-key fields are masked by default. The eye button reveals a key temporarily;
Enter, Escape, clicking away, or leaving the window hides it again. This changes
display behavior, not how VS Code settings store keys. Toolbar icons inherit the
active theme color. Web search falls back to the original question when the query
model returns an incomplete response or an output-limit warning.

```bash
cd copilot/tray
npm install
cd ../..
python tools/reach.py tray install
python tools/reach.py tray start
```

On macOS, click the menu-bar icon, use the Dock menu, or press Command+Shift+T
while SignalREACH is active. On Windows, left-click the tray icon for the panel;
on Linux, use the tray menu's **Open Tray Panel** if the desktop consumes clicks.
Linux desktops must provide an AppIndicator/StatusNotifier tray host.

For Copilot, use **Copilot window** to sign in to Microsoft 365. Closing that window
keeps its session available to the bridge. VS Code talks directly to the tray at
`http://127.0.0.1:21302/v1` using `copilot-chat`; a separate Python shim is optional.
The Copilot bridge accepts text and returns JSON or SSE (the completed answer arrives
as a single content event). Free endpoints use their normal OpenAI-compatible API.

VS Code's tray button opens/starts the tray on all three platforms. For a standalone
Windows executable or Linux AppImage, set `simplereach.trayExecutable` to its path.
Source installs are discovered automatically, as are macOS apps in Applications.

Build an installer on its target OS with `cd copilot/tray && npm run dist` (DMG,
NSIS, or AppImage). For tests, run `node --test tests/*.test.cjs`
and `python -m unittest discover -s tests` from the repository root.

The agent also connects to the editor through VS Code's public APIs. With **Workspace** enabled, each turn receives a fresh, bounded snapshot of the workspace roots, current editor and selections, unsaved buffers, Git repositories/branches/remotes, change counts, extension inventory, and available editor capabilities. **REACH: Inspect VS Code Context** opens the same metadata locally as a JSON document. `simplereach.ideContext` disables this additional connection independently of file context.

The agent can request details during a conversation:

- **Git and PRs:** status, staged or unstaged diffs, recent commits, branches, repository/branch/commit links, and PR list/search/compare locations. Live current-branch GitHub PR lookup uses an existing `gh` login; missing authentication, no matching PR, and unsupported providers are reported explicitly. GitLab, Bitbucket and Azure DevOps expose navigation links. Multiple repositories can be selected by their root path, unique name or index.
- **Editor and code:** open tabs, selections and dirty-buffer metadata; Problems diagnostics with locations; document symbols, definitions, references and hover information supplied by installed language extensions; opening a file at a specific line.
- **Extensions and workbench:** extension IDs, versions, activation state, installation and repository locations, contributed commands/settings schemas/languages/debuggers/tasks; safe editor settings; task inventory, terminal metadata, debug session and breakpoint metadata.
- **Actions:** propose existing file edits as before, open files, and request an existing VS Code task or public extension command. Task/command execution requires approval in VS Code. Dispatch is reported separately from completion; existing terminal scrollback and other extensions' private state are unavailable.

Context collection requires Workspace Trust and excludes credential files from automatic previews, credentials embedded in remote URLs, extension setting values outside a small editor allowlist, authentication tokens, environment variables, and task/debug/terminal launch configurations. Metadata and tool results go to the currently selected chat provider when a chat is sent. PR lookup is on demand; snapshot inspection itself does not contact GitHub or a model. The installer copies all runtime modules, preserves existing settings/dependencies during upgrades, and refuses to downgrade a newer installed extension.

For a quick check after reloading VS Code, run **REACH: Inspect VS Code Context**, then ask REACH: “Which repository and branch am I using, where are its pull requests, and which extensions are installed?” Focused automated coverage: `node --test tests/vscode_*context.test.cjs tests/vscode_agent_bridge.test.cjs tests/vscode_tool_transport.test.cjs tests/vscode_extension_integration.test.cjs` and `python -m unittest tests.test_vscode_install`.

## The panel

| Page | What it does |
|---|---|
| **Dashboard** | Live health: requests/tokens/errors today, avg + p95 latency, public URL, relay + upstream status, circuit state, quick actions (publish, clear log, refresh) |
| **Browser** | Interactive webpages and a separate Reader, up to eight research tabs, back/forward history, bookmarks, find, saved excerpts with source links, and context added to the SimpleRAG chat draft |
| **Endpoint** | Base URL, one-click **Add to SimpleRAG**, route table, curl/Python/JS/SimpleRAG snippets (auto-filled with the live URL) |
| **Models** | Alias table (public → upstream), enable/disable toggles, add/remove aliases — applied instantly |
| **Usage** | 24h request + token charts, by-model breakdown, top clients, error rate — auto-refreshes |
| **Logs** | Recent request log (IP, model, status, latency, tokens, error), filters, clear |
| **Settings** | The full endpoint suite — ten sections: Relay, Upstream & failover, Request handling, **Models (per-alias editors)**, Rate limits, Access & security, Caching, Observability, Hosting, System. Export/import/reset included. |
| **About** | Backronym, architecture, facts, privacy notes |

### Research browser

Open **SimpleRAG → Advanced → REACH → Browser** to browse public HTTP/HTTPS pages alongside your workspace. **Browser** mode runs a separate Chromium browser using the Electron runtime already bundled with SignalREACH. Websites can run JavaScript, render their normal images and styles, and respond to typing, clicks, and scrolling. The extension displays the locally rendered page and forwards your input through the local relay; website code runs in the separate browser process, outside the SimpleRAG page. The compact toolbar and fixed browser pane keep wide and long pages scrolling inside the webpage. Research starts collapsed and has its own scrolling area when opened.

**Reader** remains available as a separate, script-free reading view. Its pages are fetched through `POST /_reach/browser/fetch`; supported images and stylesheets use `POST /_reach/browser/resource`, with public-address, redirect, size, and type checks. Save excerpts with their source links and add context to the existing SimpleRAG chat draft. Adding context preserves your draft and leaves it for you to review and send. The interactive browser uses its own browser session rather than your external browser's signed-in sessions. Private/local network URLs remain unavailable.

The engine is packaged under `%LOCALAPPDATA%\SignalREACH\server\browser-engine\` and reuses `%LOCALAPPDATA%\SignalREACH\copilot\tray\node_modules\electron\dist\electron.exe`; there is no additional browser download when that bundled runtime is installed. To update only the SimpleRAG extension and relay while preserving the existing tray, relay settings, VS Code extension, tunnel, and published endpoint, run:

```powershell
python tools/reach.py install --extension-only
```

This scoped upgrade checks that the existing relay configuration and bundled Electron runtime are present before changing the installation. A normal full installation deploys the runtime from `copilot/tray` when it is available in the checkout. If Electron is missing there, run `npm install` in `copilot/tray` before the full installation. All browser files belong to SignalREACH; SimpleRAG source files are not modified.

To test the Browser without installing or changing SimpleRAG, run `python -B tests/browser_preview.py` from this repository and open `http://127.0.0.1:21887`. Browser mode uses the real engine and public websites; Reader mode also offers the clearly labeled fixture URLs for navigation, page isolation, saved excerpts, and the draft-only chat handoff. Backend regression tests: `python -B -m unittest tests.test_browser -v`.

### Per-model settings (the Models section)

Every alias carries its own spec: upstream id, enabled/public visibility, description, default temperature + clamp window, default/capped max tokens, injected system prompt, fallback alias (tried when the upstream fails), context window, streaming/tool-call toggles, and per-model rate limits (RPM + tokens/day, 0 = inherit global). The Models page deep-links into the editor.

### Request policy (Request handling)

`default_model`, `default_stream`, message/input-size caps, global max-tokens cap, temperature clamp window, global injected system prompt, tools/response_format/logprobs toggles, and blocked-field policy (strip silently or reject with 400).

## CLI

```bash
python tools/reach.py install [--no-start] [--no-restart] [--tunnel ngrok|cloudflared|none]
python tools/reach.py install --extension-only # existing install: preserve other components/settings
python tools/reach.py status                 # relay + tunnel + public URL
python tools/reach.py start|stop|restart     # manage relay + tunnel
python tools/reach.py publish                # push current URL to the pointer gist
python tools/reach.py register-autostart     # logon/startup: relay + tunnel + publish
python tools/reach.py settings [key [value]] # read/update settings live; keys may be
                                             # dotted: models.gpt-4o.temperature 0.7
python tools/reach.py models list|add|remove # manage model aliases live
python tools/reach.py stats [-v]             # today's usage + breakdowns
python tools/reach.py logs [--limit N] [--status 4*] [--model gpt-4o]
python tools/reach.py test                   # live upstream completion test
python tools/reach.py update                 # git pull + reinstall (upgrade path)
python tools/reach.py uninstall --all        # remove panel + stop everything

### The chat CLI (`tools/reach-cli.py`)

A terminal suite for using the endpoint — stdlib-only, keyless, streaming:

```bash
python tools/reach-cli.py chat                # interactive REPL (/help for commands)
python tools/reach-cli.py ask "question"      # one-shot answer
python tools/reach-cli.py ask "…" --web       # grounded in live web search
python tools/reach-cli.py web "question"      # search → read top pages → cited answer
python tools/reach-cli.py models              # list served aliases
# flags: --model gpt-4o | --base URL | --system "…" | --no-stream | --no-color
```

Web mode ports SimpleRAG's websearch: DuckDuckGo HTML scraping (lite
fallback), rotating user agents, rich answer modules, page excerpt fetch,
and a grounding prompt with `[n]` citations. Auto-discovers the endpoint
(local relay → public pointer gist).
```

## Architecture

```
any OpenAI client ──► https://<tunnel>/v1  (public · no auth · CORS *)
                          │
                 reachd.py  (127.0.0.1:20777, stdlib-only relay)
                          │  injects OmniRoute key server-side
                          │  alias → codegpt/codegpt-gpt-4o pinning
                          │  token-bucket rate limits (per-IP + global + daily)
                          │  optional shared access key
                          │  SQLite analytics (requests, tokens, latency)
                          │  upstream retry + circuit breaker + concurrency cap
                          ▼
             OmniRoute http://127.0.0.1:20128/v1
                          ▼
              codegpt free tier (gpt-4o)
```

- The relay binds **loopback only**; the tunnel exposes just the keyless relay surface. OmniRoute's dashboard and API keys are never reachable from outside, and the relay's admin API (`/_reach/*`) refuses non-loopback clients even if the bind host is widened.
- `/v1/models` serves exactly the enabled aliases; anything else returns `model_not_found`.
- Rate limiting protects the free upstream: per-IP requests/minute + daily token budget, a global cap, and burst headroom (all tunable in Settings).
- Requests are logged locally (IP, model, tokens, latency) for the Usage/Logs pages and pruned on the configured retention.

## Requirements (self-hosting)

- Python 3.8+ (stdlib only — no pip installs)
- A running local [OmniRoute](https://github.com/diegosouzapw/OmniRoute) with a codegpt connection (the installer auto-detects its API key)
- `ngrok` (winget) or the cloudflared binary that ships with OmniRoute, for public hosting

## Development

```bash
python -m unittest tests.test_reachd tests.test_reach_cli -v   # 48 tests, stdlib only
git config core.hooksPath .githooks                            # once per clone
```

`main` is the development branch: branch off it, open a PR, and merge with squash. The PR title is the only string release-please parses, so it must be a Conventional Commit (`feat:`, `fix:`, `fix!:`, …) — CI and the `commit-msg` hook both enforce that. Merging the release PR tags the version and rewrites every version string in the repo.

## License

MIT — © 2026 Michael Anthony Falabella
