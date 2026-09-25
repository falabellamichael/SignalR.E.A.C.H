# REACH Studio

REACH Studio is the standalone macOS, Windows, and Linux desktop app in this repository. It combines
project files and editing, AI conversations, custom personas, and collaborating
agent teams. It connects to a configured OpenAI-compatible endpoint, including
SignalREACH. It also provides optional Reach DApp CLI integration through a
native executable on macOS and Linux, or WSL on Windows.

Built by Michael Anthony Falabella. Licensed under the repository's [MIT license](../LICENSE).

## Run from source

Use macOS, Windows, or Linux and Node.js 24 LTS. From the repository root:

```bash
cd studio
npm ci
npm start
```

`npm start` builds the CodeMirror editor bundle before launching Electron.
Configure the endpoint, access key if required, and default model in
**Settings ▾ → Connection & default model**. Settings and conversations are stored
in Electron's user-data directory, normally `%APPDATA%\Reach Studio` on
Windows, `~/Library/Application Support/Reach Studio` on macOS, and
`~/.config/Reach Studio` on Linux.

Connection keys use the OS credential vault when available. Settings displays a
warning if encryption is unavailable; locked saved keys are protected from being
overwritten. See the [security policy](../SECURITY.md) for migration backups and
what is—and is not—encrypted. For development and tests, see
[CONTRIBUTING.md](CONTRIBUTING.md).

**Settings → Connection → TypeSafe Jev context selection** optionally judges
whether Studio should include automatically retrieved code symbols in an answer
request. Enter a TypeSafe API key and enable the checkbox, then save. A key can
also come from `TYPESAFE_API_KEY` in the Studio process environment. The saved key
uses the same credential storage as connection keys; Settings shows only whether
it is configured. A blank key field preserves it, and **Clear saved key** removes
it on the next save. Studio sends the current short user request plus up to 12
symbol names, paths, and kinds to TypeSafe. It does not send source snippets for
this judgment. Explicit symbol requests, long or vague requests, uncertain
judgments, and API failures keep the usual code context. The selected answer
model, tool permissions, edit reviews, and Stop behavior remain in force. The
Activity trail reports the decision and Jev input tokens when the API reports
usage. This feature is off by default; its calls consume tokens and may not
reduce total cost on every request.

**Auto** beside the composer adds prompt-based model, team, and tool selection.
Enable **Auto mode by default** under **Settings → Connection** to start with it
on; the conversation's switch overrides that default. It also enables Jev's
context selection. Auto chooses from enabled connections with configured models
and saved teams, using at most 32 candidates. It sends a self-contained request
of at most 1,500 characters plus bounded model labels, team names/member roles,
and permitted feature names to TypeSafe. Endpoint credentials, source contents,
and persona prompts are excluded.

Selections apply to one submitted prompt and its continuing work. They do not
overwrite the conversation's saved model or leave Teams enabled. Tool selections
can only narrow the currently allowed features; existing disabled tools,
approvals, sandbox, and edit-review policies remain effective. Explicit `@` and
slash routes and a manually selected team take priority. Follow-ups needing
conversation context, unavailable keys, uncertain results, oversized candidate
pools, and service failures use your selected setup. Stop cancels routing. The
composer and Activity show the chosen route; repeated decisions are cached.

Use **Open Folder** to work with an existing project. **New Project → General project**
creates an empty folder without Docker or a Reach compiler. **New Project → Reach DApp**
initializes a Reach scaffold using the configured native compiler; it does not
import another project's files.
The Files panel loads the selected directory and expands folders on demand.
Compiled Python bytecode (`.pyc`) and other binary files are not editable source.

The **Projects** command bar has two explicit modes. **Project command** runs a
program in the selected directory, such as `git status`,
`npm --prefix studio test`, or `python3 -m unittest discover -s tests -q`
when this repository is selected. It launches the program directly, without a
shell; single or double quotes group arguments, but pipes, redirects, and shell
expansion are not interpreted. **Native Reach** runs Reach DApp subcommands
such as `version`,
`compile index.rsh`, `init`, `clean`, and `info` through the locally built
`reachc` compiler or Studio filesystem helpers. Select a Reach DApp project
containing `index.rsh`, or run `init` in the intended folder before compiling.
`run index.rsh` launches the compiled Node frontend using local Ganache at
`http://127.0.0.1:8545` by default; start Ganache separately. The Reach
Compile, Reach Clean, and Reach Info buttons use this native integration.
Both modes show output and exit status in the log. Reach Compile requires
`index.rsh` at the selected project's root.

Projects and the Home mini Projects panel have terminal-style command tabs. The
main **Run** button or Enter starts the current command; if its tab is busy,
Studio opens a new tab so the existing process continues. **+** opens a blank
tab. The arrow attached to Run only opens its menu; choose **Run in new tab**
there to start a separate session explicitly. Each tab keeps its own output and
exit status. **Stop** targets the selected tab's process tree. Switch tabs or
views while Ganache runs; stop a running command before closing its tab. Closing
the final Studio window or quitting the app stops active commands.

### RCH commands in Projects and Home

Choose **Project command** mode. From the SignalR.E.A.C.H repository, install the
CLI once with `npm --prefix RCH ci`, followed by
`npm --prefix RCH run install:cli`. On macOS/Linux Studio already includes
`~/.local/bin` in the command PATH. Windows users must add that directory to
their user PATH; `npm run rch -- help` from the repository is also available.

| Command | Result |
| --- | --- |
| `rch connect` | Connect MetaMask and save its public address |
| `rch browser opera` | Choose the browser used for wallet review |
| `rch status` | Verify the deployed RCH token and sale state |
| `rch balance` | Show the selected address's ETH and RCH |
| `rch quote 0.0005` | Read-only purchase quote with gas allowance |
| `rch open-sale` | Owner's sale-activation review in MetaMask |
| `rch buy 0.0005` | Purchase review with the chosen ETH amount |
| `rch tx 0xHASH` | Receipt status and actual gas charged |
| `rch help` | Full command list |

Purchase amounts are ETH and exclude gas. `--max-fee` sets a separate gas ceiling.
These commands use the verified Ethereum Mainnet RCH deployment; they never
ask for a private key or seed phrase. Quotes do not send transactions. Write
commands start a local approval page and keep that terminal tab running for up
to 15 minutes; review and confirm the transaction yourself in MetaMask. Use a
second Projects tab for `rch tx` while the approval page is open. **Stop** closes
the local service, not an already submitted Ethereum transaction. Transaction
records persist outside the repository for recovery after a restart.

## Home

Open **Home** from the top ribbon or left rail for a compact workspace overview.
Its mini Projects CLI runs commands in the chosen saved project, and its mini chat
tests the chosen configured endpoint without saving a conversation. Command output
and endpoint responses stay in their respective panels.

The Subscription and Top Up sections preview planned account and token features.
They do not create subscriptions, charge cards, move crypto, mint tokens, or place
private trades. The proposed blockchain, crypto, credit card, and debit card
top-up methods need separate service and contract work before they can be used.

**New Chat** stays at the top of conversation history. The **+ New Chat** button
returns to that starting view; opening it does not save an empty conversation.
Choose a model, adjust controls, or attach files before sending. The first message
saves the conversation beneath New Chat and names it from the prompt. Deleting
the selected conversation returns to New Chat with the composer ready. Each
project keeps its unsent draft while Studio is open; unsent drafts are not saved
across app restarts. If no project is selected, the first message asks for a folder.

## Files and Browser

The top-right dropdown selects **Files** or **Browser** in the same resizable
panel. Switching views preserves the selected project, open files, and browser tabs.
The browser supports website addresses and searches, localhost projects, multiple
tabs, back/forward/reload, bookmarks, find, and opening a page externally.
Tabs and bookmarks are remembered between sessions.

Use **Add page to chat**, or enable **Elements** beside **Find** and right-click
a page to add an element or selected text. Elements is off by default, preserving
the website's normal right-click behavior.
Studio appends the source URL and quoted text to your draft; it does not send a
message automatically. Browser pages run in sandboxed Electron views without
Node.js or Studio's file/agent bridge. Dialogs and menus remain above the page.
Keyboard shortcuts while browsing: **Ctrl+L** address, **Ctrl+F** find,
**Ctrl+T** new tab, and **Ctrl+W** close tab. On macOS use **Cmd** instead of Ctrl; Cmd+S saves files and Cmd+Enter sends messages.

Regular agents, team members, and their spawned workers can use this same browser.
`browse` opens a URL and reads the rendered page; `websearch` opens search results.
`browser` supports tabs, open/read, history, reload, scrolling, and closing tabs.
`browser.click` and `browser.type` act on element references returned by a read,
using the conversation's existing action approval setting. Each agent gets its
own tab by default; an explicit `tabId` lets it inspect a tab you already opened.
Stop cancels pending browser work, and Start can resume using the same tab.
The request timeout follows the agent's budget setting, including zero for no timeout.

With Elements enabled, right-clicking a page outlines the selected element in gold and labels it.
A **Selected element** panel identifies its selector and text, with controls to
show its tab or clear the highlight. **Add element to chat** includes the tab ID,
element reference, selector, and source text in your draft so the agent can work
with that specific element. References expire after document navigation; the
agent must read the new page before interacting. Password/file inputs and arbitrary
page JavaScript execution are not exposed as agent tools.
Left-clicking away from the selected element or outside the page clears the
highlight and selection panel. Clicking the selected element itself retains it.
Turning Elements off clears highlights as well. Text already added to your chat
draft is preserved.

## Conversations and teams

- Conversations are bound to project folders and can be branched.
- Configure each conversation's model, command approvals, and edit review under
  **Settings ▾ → Conversation & permissions**.
- Create personas and teams on the **Create** page, then dispatch a team from a
  conversation. Teams support parallel reviews and sequential handoffs.
- Every custom agent has its own **SOUL.md** (who it is) and **MEMORY.md** (what
  it has learned), stored as plain markdown at
  `userData/agents/<agent id>/` and editable from the agent's card on the Create
  page. They are copied from the templates in `studio/agent/`, so a new agent
  starts with a working identity and you can change the baseline for every agent
  you create afterwards by editing those two files. Saving an agent writes only
  the boxes you changed, and an existing agent's files are never overwritten by a
  template edit. SOUL text is treated as authoritative instructions; MEMORY text
  is injected as untrusted data, so a note recorded during a run can never act
  like approval. Deleting an agent keeps its two files on disk.
- Team members and the workers they spawn each own their own pair. A spawned
  worker is keyed by the agent that spawned it plus its name, so the same
  helper's notes are still there next run while a differently-named helper is a
  different agent. A helper adopted from a saved persona joins with that
  persona's own files. An agent that has its own pair can read and append it
  during a run with the `memory` tool; a run with no identity of its own
  reports that instead of pretending to have recorded anything.
- Team members can create background workers, send messages, inspect progress,
  and await peers. Stop cancels active model requests and filesystem scans.
- Links teams include a silent, event-driven Team Nurse. It coalesces peer mail,
  hands completed evidence to stalled members, and refills a free team slot on
  each settlement or mailbox arrival instead of waiting for the slowest member.
  Independent recoveries run in parallel; active workers finish before synthesis;
  supervision itself never spends a model call. Provider/transport failures and
  user input/edit gates are not retried; every automatic wake requires new
  evidence and is strictly capped.
- **Send becomes Stop** while agents or a team are active. It stops all active
  regular chats and the team without sending or clearing the composer draft.
- Each team member and spawned worker has its own **Stop / Start** control.
  **Start team** resumes unfinished members with their saved context; completed
  members are not rerun. A stopped regular chat exposes **Start** in its header.
  Team sessions remain resumable while Studio stays open and until a new team
  task replaces them. Starting a queued chain member still respects chain order.
- File edits can be reviewed before writing. Ordinary completion text cannot
  silently approve pending edits or finish an incomplete plan.

## Agents workspace and telemetry

An empty conversation opens a telemetry dashboard. Use the dropdown beside
**Telemetry** in the composer footer to switch between **Overview**, **Activity**,
and **Models & Memory**. The view is remembered, and all three layouts share the
same measurements. Telemetry can also be opened over an existing conversation;
**Back to chat** returns to its messages. Sampling pauses when the dashboard is hidden.

On Windows, readings include CPU, physical RAM, GPU engine utilization, dedicated
and shared GPU memory, the largest 30 process working sets, network and disk rates,
and uptime. Activity charts retain up to 60 seconds of measured history. macOS
and Linux have CPU, RAM and process readings; GPU, network and disk counters remain Windows-only.
Missing counters display as unavailable rather than zero.

**Sources…** configures up to eight Ollama, LM Studio, or Lemonade servers. These
are read-only inventory requests: telemetry does not load models or send chat
prompts. Only provider-reported loaded models are listed. Disk model size is not
treated as resident RAM, unknown memory is labeled **Not reported**, and remote
models are identified separately from this machine. Process working sets can
include shared pages and do not sum to either model weights or total system RAM.

The message field starts at one line and automatically grows to two.
Longer drafts scroll inside the field and reveal a lower-right resize grip for
manual expansion; shortening or clearing the draft collapses it again. The model
picker and Send/Stop share the message row, keeping the footer compact.

The composer offers **Agent**, **Workspace**, **Think**, **Web**, and **Terminal**
switches. **Tools…** selects individual tools, while **Permissions…** manages
command approval and edit review. These settings follow the conversation into
team members and spawned workers; disabled tools are blocked at execution as
well as removed from the model's tool list. Turning a switch off blocks subsequent
tool dispatches; use **Stop** to interrupt a command already executing. **Think**
off requests concise answers and disables Qwen thinking where the provider
supports it. Previously shared conversation context remains available.

**Clear Chat**, immediately below **Branch This Chat**, confirms before removing
that conversation's messages, plan, pending edits and compressed context. It
starts fresh in the same conversation with telemetry exposed, keeping its
project, model, settings, and independent branches. Active agent/team runs must
finish before clearing.

Run `npm test` for policy, inventory and persistence regressions, and
`npm run test:workspace` for an isolated native Electron UI check. The latter
creates a temporary profile, exercises the real preload/IPC bridge, and captures
all three views in both themes at desktop and minimum window sizes. Its labeled
preview data is confined to that test process.

## Budgeting

**Settings ▾ → Budgeting** is a separate scrollable page. It controls output tokens,
request deadlines, rounds, review/question waits, team concurrency, worker
population and nesting, context compression, handoffs, and retained history.
Global defaults apply to conversations and teams; a conversation can override
them for itself and its teams or return to inheritance. Saved execution budgets
apply to new runs without orphaning or interrupting an active run.

| Preset | Purpose |
| --- | --- |
| Balanced | Conservative defaults, including 16,384 output tokens and 40 rounds. |
| Heavy use | 32,768 output tokens, longer runs, larger context/team budgets, and no saved-history or chat-count cap. |
| Unrestricted testing | Removes configurable application caps and disables automatic context compression. |

Zero removes the indicated REACH Studio cap. **For output tokens, zero omits
`max_tokens`; the provider chooses its default, which may still be small.** Use an
explicit larger allowance when a reasoning model reaches its output limit before
producing an answer, within the model/server's supported capacity. Provider
context-window, generation and rate limits still apply. These settings do not
change command approvals, edit review, path containment, or bounded file previews.

Compression runs automatically above 96,000 estimated characters or 48 messages
in the Balanced preset, aiming for 48,000 characters (and always below the trigger).
It reads the entire archived text in bounded segments and carries forward memory
of goals, constraints, completed work, exact file identifiers, pending actions,
review state, and failures. The original and latest user requests, system
instructions, and recent tool exchanges stay in the working context. Current
plan and pending-edit state are supplied on every request.

The **Context** bar shows an approximate token count, automatic-compression status,
and the last reduction. **Compress now** prepares a smaller context for an idle or
paused chat without running its task or tools. Segment progress, streamed memory
character counts, and Stop remain visible. The token display is a character-based
estimate, not the provider's tokenizer or a guaranteed context-window limit.

Saved chat history stays separate from compressed model context. A checkpoint
survives reloads, appends new messages, and invalidates when its source history is
edited or trimmed. Balanced keeps all saved messages by default; explicit history
retention limits still apply. Failed, cancelled, empty, or over-budget summaries
leave the previous checkpoint intact. Compression has its own output allowance;
complete oversized summaries are recompressed, never silently cut off.

Recognized provider context-overflow errors trigger one smaller compression and
retry when automatic compression is enabled.

Every model request includes its actual output allowance, an answer reserve,
remaining rounds, request deadline, and context guidance. The model is asked to
reserve at least 40% of its output allowance for a complete visible response and
to spend the rest on useful reasoning without padding. Summary requests receive
their separate compression allowance. Zero keeps the provider-selected limit.

A soft stream guard uses a character estimate to interrupt unfinished,
reasoning-only output once it reaches the estimated reasoning share. It never
interrupts an answer already arriving or treats the estimate as exact token
usage. Output truncation and reasoning-only empty responses get one concise
retry using the **same per-request cap**. A retry is an additional request, not
part of a cumulative per-turn token limit. Qwen requests ask to disable thinking
for tight caps, recovery and summaries, with fallback when a provider rejects it.
Truncated responses never execute actions, even if their JSON looks complete.

If the provider still cannot supply a usable response, Studio saves and displays
a clearly labelled **REACH budget checkpoint** with recorded actions and pending
work. It pauses without claiming completion; Continue resumes the saved task.
The last allowed round also requests a final progress report instead of starting
another tool batch. Models cannot guarantee an exact token count or a successful
answer within every cap; transport, authentication and other provider errors
remain visible. Existing explicit output settings are preserved.

## Live activity

Studio uses the VS Code extension’s activity timeline pattern: numbered steps,
expandable results, animated current-step markers, and a moving activity bar.
The header counts active agents; individual chats, team members and spawned
workers show elapsed time and the time since their last reported activity.
Reasoning and response character counts come from provider events. After 30
seconds without an update, the UI explicitly says it is waiting; elapsed time
is not proof of provider progress. Approval waits, retries, compression, Stop
and completion have distinct states. Completed chat traces are saved, with the
latest 80 steps and bounded result previews. Completed activity starts collapsed
and shows a short completion label instead of duplicating the final answer.
The context and activity header stays stationary above the scrolling plan and
messages, with the composer fixed below. Expanded activity scrolls within its
own bounded area. Narrow chat panels and short windows automatically use a
compact header with smaller controls and a shorter activity list. Animations respect
reduced motion.

## Appearance

Use the **Light / Dark** toggle in the header to switch between the original
charcoal theme and a warm Solarized light theme with ivory backgrounds, white
writing surfaces, and amber accents. The preference persists across launches and
updates open editors without losing edits, selections, or undo history.

## Native Reach compiler integration (Docker-free)

Projects and the Home mini Projects panel run ordinary project commands directly
in the selected folder without Docker. The **Native Reach** mode compiles Reach
DApps with `reachc`, not the Docker-backed `reach` launcher. Build the official
Reach compiler from source and set **Settings → Connection → Native Reach
compiler (reachc) executable** to the resulting binary. On macOS and Linux,
Studio also searches PATH, including `/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin`, and `~/bin`. The environment variable `REACH_STUDIO_REACHC`
provides a fallback. A setting pointing to an executable named `reach` is
rejected because the official launcher still probes Docker in native mode.

`compile index.rsh` maps to `reachc --disable-reporting index.rsh`; `version`
uses `reachc --version`. `init` writes `index.rsh` and `index.mjs` starter files
without overwriting existing files. `clean` removes `build/index.main.mjs`,
matching the upstream default. `info` shows the native compiler and project
source files. `run index.rsh` launches its already-compiled `index.mjs` with Node
using `ETH-devnet` and `http://127.0.0.1:8545` by default. Start Ganache on that
address first. `--connector` and `--node` override these defaults;
`--connector` also accepts `ETH-live`, `ALGO-live`, or `ALGO-devnet`.
`--node` currently supports Ethereum only. Install the frontend
dependency in the selected project, using a version compatible with the compiler.
For the native `reachc` 0.1.13 build, this Docker-free local Ethereum workflow
has been verified with Ganache 7.9.2 and `@reach-sh/stdlib@0.1.13-rc.3`:

Select a Reach DApp project with `index.rsh`, create one through **New Project →
Reach DApp**, or run `init` in the intended project folder. Then:

1. In the project folder, run `npm install @reach-sh/stdlib@0.1.13-rc.3` in
   **Project command** mode.
2. Start Ganache in the **Home mini Projects** panel's **Project command** mode:
   `ganache --server.host 127.0.0.1 --server.port 8545 --chain.chainId 1337 --logging.quiet`.
   Keep that command running while testing the frontend.
3. In **Projects → Native Reach**, run `compile index.rsh`, then
   `run index.rsh`.

Install Ganache with `npm install --global ganache@7.9.2` if it is not already
available. Studio does not start Ganache for you. `clean`
works even before reachc is installed. Native
compilation gives Algorand's `goal` a temporary data directory when none is
configured. On Windows, the compiler path is interpreted inside WSL Ubuntu.

The installer does not bundle the Reach compiler, Z3, Solidity compiler, Node
frontend dependencies, or a blockchain connector. AI conversations, browser
tools and file editing work independently. Missing compiler installations show
a configuration hint. Stop terminates native compiler or frontend processes.
Shell tools use the native platform shell. macOS keeps the app in the Dock when
its last window closes; clicking the Dock icon reopens the workspace.

## Test and build

```powershell
npm test
npm run bench:nurse
npm run smoke
npm run dist
```

- `npm test` runs the agent, protocol, file handling, team/network, and budgeting
  tests against temporary fixtures and local mock endpoints. It does not require
  a live AI provider or WSL.
- `npm run bench:nurse` runs the deterministic virtual-time Nurse policy search.
  Its result is the fastest feasible policy on the declared scenario corpus,
  not a claim of universal scheduler optimality.
- `npm run smoke` runs the actual Electron renderer, IPC, team, settings,
  editor and keyboard checks in an isolated temporary profile. It also checks the
  optional CLI status without requiring the external toolchain. An
  intentional invalid-budget rejection is logged during validation testing.
- `npm run dist` builds for the current platform. `npm run dist:mac` produces
  an ad-hoc signed macOS app, DMG and ZIP; `npm run dist:win` produces NSIS and
  portable Windows executables under `dist/`. On macOS, add `-- --arm64`,
  `-- --x64`, or `-- --universal` to select the architecture. Copy the built
  `Reach Studio.app` into `/Applications` to install. Local Mac builds are not
  notarized; public distribution needs Developer ID signing and notarization. Generated bundles, installers, dependencies, logs and local
  credentials are excluded from Git.
- `npm run dist:linux` produces an **AppImage**, a **deb** package, a portable
  **zip**, and a sandboxed **Flatpak** under `dist/`. Install the AppImage with
  `chmod +x` and run it directly; install the deb with
  `sudo apt install ./reach-studio_*.deb` (Debian/Ubuntu); extract the zip and
  run its `reach-studio` binary — no package manager needed, on any distro
  (including Arch/pacman); or install the Flatpak bundle with
  `flatpak install --user reach-studio-*.flatpak` and launch it as
  `com.falab.reachstudio` (it needs the `org.freedesktop.Platform//25.08`
  runtime and the `org.electronjs.Electron2.BaseApp//25.08` base from Flathub,
  pulled automatically). Linux
  desktops need a GUI session; on headless servers run the smoke check with
  `xvfb-run -a npm run smoke`.

The root CI workflow includes Windows, macOS, and Linux jobs that install the
locked dependencies, build the editor, check JavaScript syntax, and run
`npm test`. macOS runs the Electron smoke test and packages the app; Linux runs
the smoke test headless and packages the AppImage and deb installers.
