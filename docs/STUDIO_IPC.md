# Studio IPC contract

**Generated from the working tree, item 1.4 of
[`IMPROVEMENTS_VERIFIED.md`](./IMPROVEMENTS_VERIFIED.md) — the source of truth for the plan.**

This is the authoritative list of the main↔renderer channel surface. `studio/preload.cjs`
is the de-facto API contract; this document is the readable half of it. The machine-checked
half is item 1.2's manifest test.

**Implementation update (2026-09-20):** `studio/ipc-manifest.json` and
`studio/test/ipc-manifest.test.cjs` now check invocation/handler set equality,
duplicate registration, module ownership, and the explicit dynamic exception.
Argument entries record current handler signatures; result shapes are still
untyped. This is a coverage check, not a claim that every input is validated.
Edit-review handlers now reject non-boolean decisions; approval is granted only
for literal `true`. Other gaps listed below remain open.

| Field | Value | Command |
| --- | --- | --- |
| Registered handlers | **86** | `grep -oE "ipcMain\.handle\('[^']+'" studio/main.mjs \| sort -u \| wc -l` |
| Preload invoke channels | **87** (86 static + 1 dynamic) | `grep -oE "ipcRenderer\.invoke\('[^']+'" studio/preload.cjs \| sort -u \| wc -l` |
| Event listeners (main→renderer) | 16 | `grep -c "ipcRenderer.on(" studio/preload.cjs` |
| Synchronous channels | 1 (`theme:get`) | `grep -c "sendSync" studio/preload.cjs` |

> **Counting caution.** A bare `grep -c "ipcMain.handle"` over-counts, because a *doc comment*
> in `main.mjs` contains the literal string. Count registrations, not mentions:
>
> ```bash
> grep -oE "ipcMain\.handle\('[^']+'" studio/main.mjs | sort -u | wc -l              # → 86
> grep -oE "ipcRenderer\.invoke\('[^']+'" studio/preload.cjs | sort -u | wc -l       # → 87
> ```
>
> Earlier revisions of this file said 74/75 and 14 listeners. Those numbers had drifted by six
> handlers and two listeners; the invariant (delta = `{browser:command}`) never moved. If you
> re-measure and get something else, **fix the table**, do not trust the prose.

## 1. The one dynamic channel

`browser:command` is **not** registered at module load. `browser/host.cjs:33` registers it
when a browser tab is created and `browser/host.cjs:39` removes it on `destroyed`:

```js
// studio/browser/host.cjs
ipcMain.handle('browser:command', async (event, action, args = {}) => { … });
win.webContents.once('destroyed', () => { ipcMain.removeHandler('browser:command'); this.dispose(); });
```

**Invariant the manifest test must honor:** the static handler set is 80 and the channel set
is 81. A naive set-equality test (item 1.2) will false-fail on this unless `browser:command`
is whitelisted as `dynamic: true`. The inverse check — every registered handler has a
channel — must exempt it too. Verified today: `comm -13 handlers channels` returns exactly
`browser:command` and `comm -23 handlers channels` returns nothing.

**Handled failure:** invoking `browser:command` before its handler exists now
returns `{ok:false, err:'The browser is not ready. Open a browser tab and try again.'}`.
Other command failures also use the established `err` field. The preload regression
test verifies that callers receive a resolved failure object rather than an
unhandled missing-handler rejection.

## 2. Validation verdict by channel

Legend — **OK**: shape is checked before use. **PAREN**: the handler validates indirectly
because its callee does. **GAP**: no check on this argument; see §3.

### Agents

| Channel | Argument shape | Verdict |
| --- | --- | --- |
| `agents:list` | (none) | OK |
| `agents:get` | `id: string` | PAREN (store lookup; `null` when absent) |
| `agents:tree` | `dir: string` | PAREN (`tree()` returns `[]` for unknown dir) |
| `agents:create` | `{name, dir, model}` | PAREN (`create()` throws → `{ok:false,err}`) |
| `agents:fork` | `{id, upToIndex, name}` | PAREN (`fork()` throws on unknown id) |
| `agents:update` | `{id, ...patch}` | **OK** — `validatePolicy(patch.settings, TOOLS)` + `validateBudgets` |
| `agents:delete` | `id: string` | PAREN (stops any loop, removes state) |
| `agents:clear` | `id: string` | **OK** — refuses while a run is active |
| `agents:send` | `{id, text, attachmentIds?}` | PAREN (`getAgentLoop(id)` throws on unknown id) |
| `agents:context` | `id: string` | PAREN |
| `agents:compact` | `id: string` | PAREN |
| `agents:stop` | `id: string` | **OK** — no-op when no loop exists |
| `agents:setTodos` | `{id, todos}` | **GAP** — `todos` is not shape-checked (§3.1) |
| `agents:appendNote` | `{id, content}` | **OK** — `String(content).slice(0, 20000)` |
| `agents:respondApproval` | `{requestId, approved}` | PAREN (unknown `requestId` ignores) |
| `agents:resolveEdit` | `{id, editId, accepted}` | **OK** — edit resolved from the store by id |
| `agents:toolSchema` | (none) | OK |
| `agents:pickAttachments` | `id: string` | **OK** — `String(id)`, agent must exist, ≤20 files |
| `agents:export` | `id: string` | PAREN (unknown id → `{ok:false,err}`) |
| `agents:import` | `payload: object` | **OK** — `importConversation` whitelists fields and mints a fresh id |

### Teams, personas, roles

| Channel | Argument shape | Verdict |
| --- | --- | --- |
| `teams:list` / `teams:get` | (none) / `id` | OK / PAREN |
| `teams:create` / `teams:update` | `team` / `{id, ...patch}` | PAREN (wrapped in try/catch) |
| `teams:delete` | `id: string` | PAREN |
| `teams:run` | `{teamId, task, dir?, agentId?}` | **OK** — `task` must be non-empty |
| `teams:stop` / `teams:start` | `{teamRunId}` | PAREN (unknown id → `{ok:false,err}`) |
| `teams:controlMember` | `{teamRunId, index, agentId, start}` | PAREN |
| `teams:resolveEdit` | `{editId, accepted}` | PAREN |
| `teams:answerQuestion` | `{questionId, answer}` | PAREN |
| `runs:stop` | (none) | OK |
| `personas:*` | `id` / `persona` / `{id,...patch}` |
| `soul:get` | `{key, kind}` |
| `soul:set` | `{key, kind, text}` |
| `soul:defaults` | `{name, role}` | PAREN (store throws→caught) |
| `roles:list` | (none) | OK |

### Files, project, shell

| Channel | Argument shape | Verdict |
| --- | --- | --- |
| `files:tree` | `{agentId?, projectDir?, directory?, offset?}` | **OK** — root required, `listDirectory` bounded |
| `files:read` | `{agentId?, projectDir?, path, }` | **OK** — `resolveInProject` containment + **2 MB cap** |
| `files:write` | `{agentId?, projectDir?, path, content}` | **OK** containment; **GAP** no size cap (§3.2) |
| `project:create` | `{name, parent}` | **OK** name `/^[A-Za-z0-9 _-]+$/`, existing-dir refused; **GAP** `parent` (§3.3) |
| `project:list` | `dir: string` | **GAP** — bare `fs.readdirSync(dir)` (§3.4) |
| `dialog:pickDir` | (none) | OK — OS-mediated picker |
| `shell:openDir` | `dir: string` | **GAP by design** — opens any path in the OS file manager (§3.5) |

### Settings, connections, models, telemetry, theme

| Channel | Argument shape | Verdict |
| --- | --- | --- |
| `settings:get` | (none) | OK |
| `settings:save` | `patch: object` | **OK** — non-object coalesced to `{}`; budgets validated; connections authoritative only when the patch carries them |
| `settings:budgetSchema` | (none) | OK |
| `projects:get` | (none) | OK |
| `projects:save` | `ps: Array` | **GAP** — array not shape-checked (§3.6) |
| `connections:list` | (none) | OK |
| `connections:save` | `{action, id?, …}` | **OK** — switch with a `default` that refuses; mutations are pure until write |
| `connections:ping` | `{connectionId?}` | **OK** — falls back to active; `resolveEndpoint` validates |
| `models:list` | `{endpoint?, accessKey?, connectionId?}` | **OK** — `normalizeEndpoint` + `resolveEndpoint` reject non-HTTP and embedded credentials |
| `telemetry:sample` / `sources` | (none) | OK |
| `telemetry:saveSources` | `sources` | **OK** — `validateSources` |
| `theme:set` | `'light' \| 'dark'` | **OK** — whitelist, else throws |
| `theme:get` (`sendSync`) | (none) | OK |

### Workspace, playground, refactor, about

| Channel | Argument shape | Verdict |
| --- | --- | --- |
| `workspace:indexCode` | `{projectDir?}` | **OK** — `resolveIndexableDir` |
| `workspace:searchSymbols` | `{projectDir?, query, limit?}` | **OK** — `limit` clamped 1–100 |
| `workspace:extractContext` | `{projectDir?, query, maxChars?, maxSymbols?}` | **OK** — `maxChars` 500–24000, `maxSymbols` 1–40 |
| `workspace:pingEndpoint` | (none) | OK |
| `playground:run` | `{connectionId?, model, prompt, system?, maxTokens?, temperature?, stream?}` | **OK** — model+prompt required, temperature clamped 0–2, `maxTokens` must be a positive integer, runs bounded |
| `playground:stop` | `runId: string` | **OK** — `String(runId)`, unknown → `{ok:false,err}` |
| `refactor:plan` | `{projectDir?, edits, context?}` | **OK** — edits required and capped at 60, `context` clamped 0–40 |
| `refactor:apply` | `{planId, projectDir?}` | **OK** — unknown/expired `planId` refused |
| `refactor:generate` | `{projectDir?, task, model?, gates?, files?}` | **OK** — `files` capped at 12 |
| `refactor:gates` | `{projectDir?, gates?}` | **OK** — at most 8 gates, command must be non-empty |
| `refactor:defaultGates` | `{projectDir?}` | **OK** — `resolveIndexableDir` |
| `refactor:selfCorrect` | `{projectDir?, …}` | **OK** — same gate caps |
| `refactor:revert` | `{projectDir?}` | **OK** — requires a `.git` dir; `git checkout -- .`, never `clean -fd` |
| `refactor:stop` | `runId: string` | **OK** — `String(runId)` |
| `about:info` | (none) | OK |

## 3. Open gaps (each has a named fix)

These are the handlers where the plan's "every handler has a documented argument shape and a
validation verdict" (§2.3) resolves to *no guard today*. They are recorded, not hidden.

### 3.1 `agents:setTodos` — `todos` shape unchecked

`main.mjs:489` forwards `todos` straight to `store.setTodos(id, todos)`. A non-array or an
array of non-objects is persisted and then rendered by `renderTodos()`, which assumes
`{text|content, status}`.
**Fix:** `Array.isArray(todos) ? todos.slice(0, 200).filter(t => t && typeof t === 'object') : []`.
**Check:** posting `todos: "nope"` leaves the stored plan unchanged.

### 3.2 `files:write` — no size cap

`files:read` refuses over 2 MB; `files:write` has no matching ceiling, so a renderer bug can
write an arbitrarily large file (and `writeTextFile` is synchronous).
**Fix:** reject `String(content).length > 8 * 1024 * 1024` with `{ok:false,err}`.
**Check:** a 9 MB write returns `ok:false` and the file on disk is unchanged.

### 3.3 `project:create` — `parent` unchecked

`name` is validated by regex, but `parent` is joined with it unchecked:
`path.join(parent, name)`. A relative `parent` resolves against the process CWD.
**Fix:** require `path.isAbsolute(parent)` and `fs.existsSync(parent)`.
**Check:** a relative `parent` returns `ok:false`.

### 3.4 `project:list` — arbitrary directory listing

`main.mjs:366` runs `fs.readdirSync(dir)` on a renderer-supplied absolute path with no
containment against any known project. It is read-only, so the impact is information
disclosure of file *names*, not file *contents*.
**Fix:** require `dir` to match a remembered project in `projects.json`.
**Check:** listing `/` returns `[]`.

### 3.5 `shell:openDir` — opens any path (accepted)

`shell.openPath(dir)` hands the path to the OS file manager. This is the deliberate
"Open Folder" / "reveal" affordance, and the renderer is first-party local code — but it is
still the widest-reaching channel in the surface, so it is documented rather than assumed.
**Decision:** accepted as-is. Constraining it to known projects would break "Open Folder…"
on a path the user just picked and has not yet saved as a project.
**Check:** none required; revisit if the renderer ever loads remote content.

### 3.6 `projects:save` — array shape unchecked

`main.mjs:297` passes `ps` straight to `saveProjects`, which `JSON.stringify`s it. A non-array
write makes the next `loadProjects()` return a non-array to UI code that iterates it.
**Fix:** `Array.isArray(ps) ? ps.slice(0, 20).filter(p => p && typeof p.dir === 'string') : []`.
**Check:** `saveProjects("x")` leaves the previous list intact.

### 3.7 `reach:run` — `cwd`/`args` unchecked

`main.mjs:293` forwards `{cwd, args}` to `reachProcess.runReach`. `args` is passed to the
spawn call; `cwd` is not resolved against a known project. The process is the *reach* CLI,
not a shell, so there is no shell-injection path — but a bad `cwd` spawns in an unexpected
directory.
**Fix:** require `Array.isArray(args) && args.every(a => typeof a === 'string')`, and treat a
missing `cwd` as a hard error rather than inheriting the process CWD.
**Check:** `args: "clean"` (a string) returns `ok:false`.

## 4. Invariants a reviewer can check cheaply

1. **Count discipline.** `80` unique registered handlers, `81` unique invoke channels,
   difference exactly `{browser:command}`. (Item 1.2)
2. **Containment.** Every channel that turns a renderer string into a filesystem path either
   calls `resolveInProject`/`resolveIndexableDir` or appears in §3. (`files:read`,
   `files:write`, `workspace:*`, `refactor:*` are the conforming set.)
3. **No secrets to the renderer except settings.** `connections:list` deliberately returns
   access keys (local desktop app, its own form must redisplay them). No other channel
   returns a key, and no channel returns one to the *sandboxed browser panel*.
4. **Pure-until-write.** `connections:save` and `settings:save` mutate a copy and persist
   once; a validation error leaves `settings.json` byte-identical.
5. **Bounded payloads.** Every list-returning channel caps its size: `files:tree` (offset
   window), `workspace:searchSymbols` (`limit` ≤ 100), `workspace:indexCode` (warnings ≤ 40),
   `refactor:*` (files ≤ 60 / gates ≤ 8), `agents:pickAttachments` (≤ 20).

## 5. Regenerating this document

```bash
# Every registration, one per line
grep -oE "^\s*ipcMain\.handle\('[^']+'" studio/main.mjs | sed "s/.*('//;s/'//" | sort -u
# Every preload channel, one per line
grep -oE "ipcRenderer\.invoke\('[^']+'" studio/preload.cjs | sed "s/.*('//;s/'//" | sort -u
```

Once item 1.2 lands, `docs/STUDIO_IPC.md` becomes a generated artifact — the manifest is the
source and this file is its rendering. Until then this file is **maintained by hand** and is
the only place the argument shapes are written down.
