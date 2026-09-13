# REACH Studio

REACH Studio is the standalone Windows desktop app in this repository. It combines
project files and editing, AI conversations, custom personas, and collaborating
agent teams. It connects to a configured OpenAI-compatible endpoint, including
SignalREACH. It also provides optional Reach DApp CLI integration through WSL.

Built by Michael Anthony Falabella. Licensed under the repository's [MIT license](../LICENSE).

## Run from source

Use Windows and Node.js 24 LTS. From the repository root:

```powershell
cd studio
npm ci
npm start
```

`npm start` builds the CodeMirror editor bundle before launching Electron.
Configure the endpoint, access key if required, and default model in
**Settings ▾ → Connection & default model**. Settings and conversations are stored
in Electron's user-data directory, normally `%APPDATA%\Reach Studio`.

Use **Open Folder** to work with an existing project. **New Project → Create & Init**
creates a new Reach DApp scaffold; it does not import another project's files.
The Files panel loads the selected directory and expands folders on demand.
Compiled Python bytecode (`.pyc`) and other binary files are not editable source.

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
**Ctrl+T** new tab, and **Ctrl+W** close tab.

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
- Team members can create background workers, send messages, inspect progress,
  and await peers. Stop cancels active model requests and filesystem scans.
- **Send becomes Stop** while agents or a team are active. It stops all active
  regular chats and the team without sending or clearing the composer draft.
- Each team member and spawned worker has its own **Stop / Start** control.
  **Start team** resumes unfinished members with their saved context; completed
  members are not rerun. A stopped regular chat exposes **Start** in its header.
  Team sessions remain resumable while Studio stays open and until a new team
  task replaces them. Starting a queued chain member still respects chain order.
- File edits can be reviewed before writing. Ordinary completion text cannot
  silently approve pending edits or finish an incomplete plan.

## Budgeting

**Settings ▾ → Budgeting** is a separate scrollable page. It controls output tokens,
request deadlines, rounds, review/question waits, team concurrency, worker
population and nesting, context compression, handoffs, and retained history.
Global defaults apply to conversations and teams; a conversation can override
them for itself and its teams or return to inheritance. Saved execution budgets
apply to new runs without orphaning or interrupting an active run.

| Preset | Purpose |
| --- | --- |
| Balanced | Conservative defaults, including 4,096 output tokens and 40 rounds. |
| Heavy use | 32,768 output tokens, longer runs, larger context/team budgets, and no saved-history or chat-count cap. |
| Unrestricted testing | Removes configurable application caps and disables automatic context compression. |

Zero removes the indicated REACH Studio cap. **For output tokens, zero omits
`max_tokens`; the provider chooses its default, which may still be small.** Use an
explicit larger allowance when a reasoning model reaches its output limit before
producing an answer, within the model/server's supported capacity. Provider
context-window, generation and rate limits still apply. These settings do not
change command approvals, edit review, path containment, or bounded file previews.

Compression has its own output allowance. A failed or empty summary preserves
the original history and points to the relevant settings instead of replacing it.

## Optional Reach CLI integration

The Projects command bar invokes:

```text
wsl.exe -d Ubuntu -- /usr/local/bin/reach <arguments>
```

This expects an existing WSL Ubuntu installation with that wrapper and its Reach
toolchain configured. The Electron installer does not install WSL, the compiler,
Solidity/Z3 tools, or blockchain devnets. AI conversations and file editing are
available independently; without the toolchain, the Reach status reports an error.

The developer's configured environment uses Reach 0.1.13 and supports native
`version`, `init`, `compile`, `clean`, and `info`. Devnet commands require their
separate blockchain/container prerequisites.

## Test and build

```powershell
npm test
npm run smoke
npm run dist
```

- `npm test` runs the agent, protocol, file handling, team/network, and budgeting
  tests against temporary fixtures and local mock endpoints. It does not require
  a live AI provider or WSL.
- `npm run smoke` runs the actual Electron renderer, IPC, team, settings,
  editor and keyboard checks in an isolated temporary profile. It also checks the
  WSL Reach toolchain, so it requires the integration described above. An
  intentional invalid-budget rejection is logged during validation testing.
- `npm run dist` builds the editor, NSIS installer, and portable Windows executable
  under `dist/`. Generated bundles, installers, dependencies, logs and local
  credentials are excluded from Git.

The root CI workflow includes a Windows job that installs the locked dependencies,
builds the editor, checks JavaScript syntax, and runs `npm test`.
