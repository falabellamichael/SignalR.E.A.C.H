# REACH Studio — Verified Improvement List

This is the active plan. The four older improvement documents are preserved in
`docs/archive/` as historical proposals; their counts, worker assignments and
instructions to commit/stash are not current task instructions.

## Jev and conversation UI verification — 2026-09-21

- Optional TypeSafe Jev context selection and Auto routing are implemented for
  Studio and the VS Code extension. Routing remains bounded by existing enabled
  models, tools and permissions; missing keys, uncertainty and failures retain
  the selected setup. Authenticated TypeSafe calls and net token savings have
  not been verified; decision tests use mocked responses.
- Studio keeps a reusable New Chat draft until the first accepted prompt,
  restores it after deletion, and hides the empty message container. The Auto
  switch alignment and conversation information disclosure are compacted.
- Local verification: Studio unit suite passed with 521 passes and four skips;
  the integrated VS Code working-tree suite passed 276 tests. Isolated Electron
  Jev, settings, edit-resume and New Chat fixtures passed. Windows installer and
  portable builds succeeded; installed executable/archive hashes were verified.
- Full Electron smoke remains PARTIAL: chat layout and browser zoom checks
  passed, but the embedded-browser simulated right-click timed out. The compact
  header passed wide/narrow visual checks and is packaged; installation awaits
  completion of the user's active run.
- Publication snapshot verification: 521 Studio tests passed with four skips;
  all 273 VS Code tests passed. This snapshot excludes the unrelated tray and
  response-display changes present in the shared working tree.

## Current implementation snapshot — 2026-09-20

These changes are implemented in the local working tree based on HEAD
`895ec32`, **not committed, pushed, or installed**. Pre-existing audit/index fixes,
documentation reorganization and stalled-member restart work were preserved.
The status table below supersedes the older evidence paragraphs in each item,
which describe the baseline at the time the proposal was written.

| Item | Local status | Evidence / remaining scope |
| --- | --- | --- |
| 0.3 Green-suite gate | DONE locally | Studio: **478/478** tests. Electron full smoke and Agents scroll/restart UI pass. Existing CI runs the suite. |
| 1.1 Encrypt connection keys | DONE locally | `agent/settings-store.cjs`, five tests; real Electron credential smoke. OS vault encryption, explicit fallback warning, encrypted migration backup when available, locked-key write protection. |
| 1.2 IPC manifest | PARTIAL | All **81** invocation channels have owner/signature metadata; bidirectional set and owner tests pass. Return-shape validation and full IPC domain extraction remain. |
| 1.3 Browser command guard | DONE locally | Preload returns the established `{ok:false,err}` shape when unavailable; regression tests cover missing handler and ordinary failures. |
| 1.4 IPC validation audit | PARTIAL | Review decisions now require booleans and approvals require literal `true`. Other documented validation gaps remain. |
| 1.6 Untrusted output | DONE locally | Escaped delimiters around tool/source data; retrieved code uses a non-system role. Forged approval fixture cannot bypass edit review. Delimiters are not a sandbox. |
| 1.8 Approval notifications | PARTIAL | Background notifications, beep, Dock badge, click-to-focus and burst coalescing implemented; injected platform tests pass. Actual OS notification delivery/permissions still need manual verification. |
| 2.1 Main-process split | PARTIAL | Settings storage, endpoint resolution and notification policy extracted to independent tested modules. IPC/bootstrap/smoke extraction remains. |
| 2.6 Endpoint regression tests | DONE locally | `agent/endpoint.cjs`; local HTTP tests cover pointer chains, loop cap, credentials/schemes, normalization and HTTP errors. |
| 3.7 Settings schema | DONE locally | Version 1 migration, idempotent second load, unsupported-version refusal and preservation on failure. |
| 4.1 Windows installers | PARTIAL | CI packages NSIS/portable EXEs and uploads artifacts. A real Windows CI run is still required. |
| 4.4 Dependency monitoring | PARTIAL | npm added for Studio, VS Code and tray. No pip manifest exists, so no fictitious pip job was added. GitHub must verify/open the first update PR. |
| 5.3 VS Code contributor workflow | PARTIAL | `cd vscode && npm test`: **252/252** pass; local syntax command added. Large-module split remains. |
| 5.4 Tray test entry | DONE locally | `cd copilot/tray && npm test`: **31/31** pass. |
| 5.6 Parse coverage | DONE locally | CI checks tracked JS/CJS/MJS outside Studio recursively, including browser engine and endpoint client; **77** tracked files pass. Studio retains its recursive checker. |
| 7.1 / 7.6 Documentation consolidation | PARTIAL | Existing archive/index changes preserved; this plan and re-verification script updated. Old proposal evidence is historical, not live metrics. |
| 7.2 Product entry points | DONE locally | Root README links Studio, relay/panel, extension, tray, contribution guide and security policy. |
| 7.3 Contributor guide | DONE locally | `studio/CONTRIBUTING.md`: tools, pages, IPC, persistence, testing and platform checks. |
| 7.4 Security policy | DONE locally | `SECURITY.md` documents reporting, trust boundaries, credential fallback and backup handling without claiming conversations are encrypted. |
| Archived plan 1.3 Coverage baseline | DONE locally | Built-in Node coverage command and informational Linux CI step. Executed-module snapshot: **95.73% lines / 81.38% branches / 91.30% functions**; this excludes unexecuted Electron/UI modules, not whole-app coverage. |

The final suite also exposed a timing-sensitive existing synthesis test: its
75 ms deadline could expire during the initial successful requests under CPU
contention. It now allows 500 ms while still asserting failure of the deliberately
header-stalled synthesis and preservation of both members' evidence.

### Remaining substantial work

Conversation byte caps/archival and per-conversation storage, durable team recovery,
outbound provider rate limits, complete IPC validation, the larger main/renderer/relay
refactors, and the feature backlog remain open. They are not made DONE by scaffolding.
Notarization additionally needs the owner's Apple credentials. No release, GitHub
write, installed-app restart, or real-profile migration was performed in this batch.

## 1. Reproducible source snapshot

Run `bash docs/verify-improvements.sh` for current counts. It does not execute tests
or crawl dependencies/build output.

| Metric | Measured in this batch |
| --- | --- |
| `studio/main.mjs` | 3,746 lines |
| `studio/renderer/app.js` | 4,144 lines |
| `studio/preload.cjs` | 190 lines |
| Static handlers / preload invocation channels | 80 / 81; explicit dynamic channel: `browser:command` |
| Agent modules / renderer scripts / unit-test files | 49 / 21 / 46 |
| Node contract | `studio/.nvmrc`: 24; `engines.node`: >=24 |
| Endpoint resolver | `studio/agent/endpoint.cjs` |
| Index cache owner (unchanged) | `studio/agent/code-context.cjs` |
| Dirty paths | Intentionally not a fixed metric: includes preserved user changes; inspect `git status --short`. |

### 1.1 Already landed — do NOT re-propose these

Verified present. Each was on an older "to do" list and has since shipped:

- **Test discovery** — `"test": "node scripts/check-syntax.cjs && node --test \"test/**/*.test.cjs\""`.
  No `&&` chain; new test files need no `package.json` edit.
- **Crash handlers** — `main.mjs:117-118` (`uncaughtException`, `unhandledRejection` → `appendCrashLog`).
- **Atomic writes** — `agent/atomic-write.cjs`; `main.mjs:187,196` use it for settings + projects.
- **CSP** — `renderer/index.html:5` is `script-src 'self'`; no `'unsafe-inline'` for scripts.
- **Node pinned** — `engines.node: ">=24"` and `studio/.nvmrc` = `24`.
- **Audit-log rotation** — `agent/audit-log.cjs` has `maxBytes`, `keep`, `rotate()`, `verify()` and
  its tests are **green** (0.1). The link-record contract is `carry === prev` on the `rotate` marker;
  the achievable bound is `maxBytes + one record` — see §10.2 I3.
- **Export / import conversations** — `main.mjs` handlers + `preload.cjs` + `AgentStore.importConversation`.
- **Studio in release-please** — packages are `[".", "studio"]`.
- **Recursive syntax check** — `scripts/check-syntax.cjs` now walks recursively, not flat-per-dir.
- **Git hygiene** — `.gitignore` covers `/.reach/`, `.venv/`, `*.vsix`, `__pycache__/`, `*.dmg`.
- **Copilot shim token** — written `0600` with a loud warning on world-readable load.

> **Location correction.** Endpoint resolution now lives in `studio/agent/endpoint.cjs`
> with focused HTTP tests; it no longer needs to wait for the full main-process split.

---

## 2. Phase 0 — Correctness: make the suite green (do this first)

### 0.1 Fix the two audit-rotation test failures — `DONE` · **was the blocker**

- **Evidence (at baseline):** `cd studio && npm test` → `not ok 32` (in `test/audit-log.test.cjs`)
  and `not ok 38` (in `test/audit-rotation.test.cjs`).
- **Measured diagnosis — the tests were wrong, not the implementation.** Both assertions demanded
  a contract the rotation design cannot provide:

  ```
  not ok 32 - an explicit write-time cap rotates automatically
    error: 'no records are lost by rotation'   (test/audit-log.test.cjs:85)
  not ok 38 - rotation by size archives the active file and starts a chained marker record
    error: 'active file stays bounded (got 875)'   (test/audit-rotation.test.cjs:26)
  ```

  (a) `keep: 2` with 10+ writes *deliberately* drops the oldest archives — that is bounded
  retention, which is item 2.4's whole point. `read().length < 10` is the correct outcome, so the
  test was asserting data loss as a failure. **Fix:** the test now passes `keep: 20` so no archive
  is dropped, and asserts `read().length >= 10` against a retention bound the caller asked for.
  (b) Measured geometry: one record = **383 B**, the `rotate` link record = **463 B**. A pre-append
  rotation still leaves the active file at **846 B** (marker + the record just written), so a
  `< 512` byte assertion with `maxBytes: 256` is **arithmetically unsatisfiable**. The real
  invariant is that the active file never accumulates across writes: it holds at most **marker +
  one record**. **Fix:** the test asserts `activeLines.length <= 2`.
- **Contract now frozen (§10.2 I3):** rotate fires when the active file *reaches* the cap, checked
  **before** the next append; at rest after a rotation the active file holds only the link record
  (464 B measured). The honest bound is **`maxBytes + one record`**, verified at `maxBytes: 1024`
  (20 writes → active 845 B ≤ 1024 + 378 B, 9 archives, `verify().ok === true`, 29 records read).
- **Unchanged, and deliberately so:** `canonical()` still hashes `record.v` (invariant A2), and a
  `rotate` marker carries `carry === prev` so `verify()` treats a rotated file as a legal chain
  start (invariant A3). Neither edit alters an existing record's hash preimage.
- **Done check:** `cd studio && npm test` → **460 tests, 460 pass, 0 fail** (exit 0).
  `node --test test/audit-log.test.cjs test/audit-rotation.test.cjs` → 12/12 pass. Tamper tests
  still fail at the correct index.
- **Effort:** 2 h (spent) · **Risk:** medium (must not invalidate existing logs) · **Depends:** —

### 0.2 Stop the code index emitting phantom symbols — `DONE`

- **Evidence:** the `not ok 109 - indexing the real Studio tree produces no phantom symbols`
  failure recorded when this doc was first written **no longer reproduces** — the real-tree case in
  `test/code-index.test.cjs` now passes (`npm test` shows no test-109 failure; the whole suite is green).
- **Note:** the phantom-symbol root cause was addressed in the working tree. If a future change
  regresses it, the investigation path below still applies.
- **Change (if it ever reappears):** reproduce the failing case in isolation — run the indexer over
  `studio/` and diff the produced symbol list against `code_search`-style ground truth. Prime
  suspects: multi-line string or template literals, JSX-ish markup, and `.cjs` files using
  `module.exports = { ... }` object-literal shorthand the parser reads as declarations.
- **Done check:** `node --test test/code-index.test.cjs` passes; a diff of indexed symbols vs.
  exported names on `studio/agent/` shows no extras.
- **Effort:** 3–6 h (if it regresses) · **Risk:** medium (parser false-positives are easy to paper
  over with a narrower rule that then misses real symbols) · **Depends:** —

### 0.3 Adopt a green-suite gate — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** CI (`.github/workflows/ci.yml:78`) runs `npm test` on all three OSes. The suite is
  green locally now (460/460), which clears the blocker that previously made this gate ignorable.
- **Change:** no code change — but the rule stands in §10: an item is not `DONE` until `npm test`
  is green on the branch. The prior crew's own working agreement said this and then four members
  reported `DONE` on a red branch.
- **Done check:** `cd studio && npm test; echo $?` → `0`.
- **Effort:** 0 (policy) · **Risk:** none · **Depends:** 0.1 (done), 0.2 (done)

---

## 3. Phase 1 — Security & data integrity

### 1.1 Encrypt API keys at rest — `DONE` · **highest security item**

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `grep -rl safeStorage studio --include=*.cjs --include=*.mjs` → **0 files**.
  `settings.json` stores `connections[].accessKey` as plain JSON.
- **Change:** Electron's built-in `safeStorage` (DPAPI / Keychain / libsecret) — no new dependency.
  Persist `safeStorage.encryptString(k).toString('base64')`, decrypt only at request time, keep
  plaintext in memory. Where `isEncryptionAvailable()` is false, fall back to plaintext **and show
  a visible warning in Settings** — silent fallback is how this becomes a false sense of security.
- **Invariant:** after migration, no readable key exists in `settings.json`, and a live request
  still authenticates.
- **Migration:** on first load, encrypt any plaintext key, rewrite, keep a one-time
  `settings.json.bak`. A failed migration must be recoverable, never data loss.
- **Done check:** `settings.json` holds an opaque blob; a request still succeeds; a test with
  encryption stubbed unavailable exercises the warning path.
- **Effort:** 3–4 h · **Risk:** medium (migrating existing plaintext keys) · **Depends:** —

### 1.2 Give the IPC surface a manifest + set-equality test — `PARTIAL`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `studio/ipc-manifest.json` → **absent**. 80 handlers in `main.mjs` vs 81 preload
  channels, linked by nothing machine-checked. A typo on either side fails at runtime, not build
  time. `docs/STUDIO_IPC.md` is now corrected to 80/81 (item 1.4) but is maintained by hand and
  will drift again until the manifest test exists.
- **Change:** `studio/ipc-manifest.json` = `{ "<channel>": { module, args, returns } }`, plus a test
  asserting `set(preload channels) === set(manifest keys) === set(registered handlers)`
  **in both directions**, printing the diff on failure.
- **Invariant A5:** `browser:command` is **dynamic** (registered by `browser/host.cjs` on tab
  creation, removed on `destroyed`). The test must whitelist it **explicitly** — do not loosen the
  equality to make it pass.
- **Done check:** deleting a handler while leaving its preload method fails `npm test` and prints
  the two sets. Verified delta today is exactly `browser:command`, so the test is writable now.
- **Effort:** 1–2 days · **Risk:** medium · **Depends:** 4.1 (needs the split to attribute owners)

### 1.3 Guard the dynamic `browser:command` channel — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `preload.cjs:17` — `command: (action, args = {}) => ipcRenderer.invoke('browser:command', action, args)`.
  No guard. Invoking it before a tab exists produces an unhandled `No handler registered` rejection.
- **Change:** wrap in a try/catch (or check for an open tab) returning a clear error to the renderer;
  never let it become an unhandled rejection in the main process.
- **Done check:** a test invokes `browser:command` with no tab open and asserts a clean rejected
  promise with a readable message, not an unhandled rejection.
- **Effort:** 1 h · **Risk:** low · **Depends:** —

### 1.4 Audit every IPC handler for input validation — `PARTIAL`

- **Evidence:** `docs/STUDIO_IPC.md` exists with a validation column, **corrected to 80/81** and now
  covering `agents:export` / `agents:import`. It records **7 open gaps** (§3.1–3.7): `agents:setTodos`,
  `files:write` size, `project:create` parent, `project:list` listing, `shell:openDir` (accepted),
  `projects:save` shape, `reach:run` args. It is **hand-maintained** — nothing fails when it drifts.
- **Change:** walk all **80** handlers; record argument shape and whether path containment, URL
  scheme, numeric bounds and id existence are checked. Fix the gaps.
- **Done check:** every handler has a documented shape and a validation verdict; each gap links a fix.
- **Effort:** 4–6 h · **Risk:** medium · **Depends:** 1.2 (do the manifest first and this becomes
  mechanical)

### 1.5 Cap per-conversation size — `TODO`

- **Evidence:** `agent/agent-store.cjs:22-23` caps `MAX_AGENTS = 200` and `MAX_STORED_MESSAGES = 400`
  only. Activity, todos and pending edits per conversation are unbounded on disk.
- **Change:** `MAX_CONVERSATION_BYTES` enforced in `_save()`; overflow **archives** the oldest
  messages to `agents/<id>.history.jsonl`, append-only.
- **Invariant A4 — archive, never delete.** Trimmed messages must replay from the archive. This is
  the only acceptable direction of loss.
- **Done check:** a 10 MB conversation stays under cap on save and its archive replays reads back.
- **Effort:** 3 h · **Risk:** medium (silent data loss if done wrong) · **Depends:** —

### 1.6 Treat tool/file output as untrusted data — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** no delimiter or `untrusted` marker in `context.cjs` / `agent-loop.cjs`.
- **Change:** **not** wholesale prompt sanitization — that breaks legitimate use. Two targeted fixes:
  (a) verify and regression-test that no model output can silently approve a pending edit;
  (b) fence file/tool output with an explicit delimiter so a malicious file cannot impersonate a
  system instruction.
- **Done check:** a fixture file containing text that impersonates an approval directive cannot
  cause an edit to apply without human approval.
- **Effort:** 2 h · **Risk:** low · **Depends:** —

### 1.7 Rate-limit outbound agent requests — `TODO`

- **Evidence:** the relay has `RateLimiter` / `CounterGate` in `server/reachd/limits.py`; nothing
  client-side caps requests per connection. An 8-member team can drive a limited endpoint into 429s.
- **Change:** a small per-connection gate (requests/min with a queue) in `agent/connections.cjs`;
  when held, surface "waiting on provider budget" in the activity header so it is visible.
- **Done check:** a burst of 2× the limit against a mock endpoint queues instead of producing
  parallel 429s.
- **Effort:** 3 h · **Risk:** low · **Depends:** 4.1 (cleaner connection layer)

### 1.8 Notify on approval and edit-review requests — `PARTIAL`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `grep -c "new Notification" studio/main.mjs` → **0**. `requestApprovalFromRenderer`
  waits up to `approvalTimeoutMs` (default 300,000 ms); if the user is in another app the agent
  silently times out to `false` (denied).
- **Change:** main-process `new Notification` + `shell.beep()` on approval/edit-review requests, plus
  a macOS dock badge. Small change, large effect for long-running agents.
- **Done check:** backgrounding the app during a pending approval fires an OS notification; clicking
  it focuses the window.
- **Effort:** 2 h · **Risk:** low · **Depends:** —

---

## 4. Phase 2 — Architecture: the monoliths

These are the highest-leverage structural items and the reason several other items are blocked.

### 2.1 Split `studio/main.mjs` (3,748 lines, 80 handlers) — `PARTIAL` · **critical path**

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `wc -l studio/main.mjs` → **3,748**; `ls -d studio/ipc` → **absent**. One file owns
  stores, settings normalization, `resolveEndpoint` (`:285`), the approval bus, the agent-loop cache,
  team-run bookkeeping, playground runs, and every IPC handler. It is **larger than when the plan was
  written** — it is growing, not shrinking.
- **Change:** leave `main.mjs` as bootstrap (lifecycle + window + `registerIpc()`) and extract:

  | New module | Owns |
  | --- | --- |
  | `ipc/agents.cjs` | `agents:*` |
  | `ipc/teams.cjs` | `teams:*`, `personas:*`, `roles:*` |
  | `ipc/files.cjs` | `files:*`, `project:*`, `dialog:*` |
  | `ipc/settings.cjs` | `settings:*`, `connections:*`, `models:*` |
  | `ipc/workspace.cjs` | `workspace:*`, `playground:*`, `telemetry:*` |
  | `ipc/refactor.cjs` | `refactor:*`, `patch:*` |
  | `stores.cjs` | settings/projects persistence via `atomicWriteJson` |
  | `endpoint.cjs` | `resolveEndpoint` + pointer rewriting (unblocks 2.6) |
  | `agent-cache.cjs` | `agentLoops` / `teamRuns` maps + invalidation rules |

- **Method:** `npm run smoke` exercises the real IPC surface end to end — use it as the safety net
  and change **one domain per commit**. When `resolveEndpoint` has moved to `endpoint.cjs`, item 2.6
  becomes unblocked.
- **Done check:** `main.mjs` under 200 lines; `ls studio/ipc/*.cjs` shows the domains; `npm test` and
  `npm run smoke` green at every step.
- **Effort:** 1–2 weeks · **Risk:** high (small, individually-green commits only) · **Depends:** 1.1,
  1.2, 0.1

### 2.2 Split `studio/renderer/app.js` (4,137 lines) — `TODO`

- **Evidence:** `wc -l studio/renderer/app.js` → **4,137** — now the largest file in Studio, up from
  2,714 when the plan was written. It holds tab switching, log/status, project list, agent tree, chat
  rendering, composer send/stop, drawer resizing and file-tree logic. `renderer/` already has 21 JS
  files, so a module convention exists (`refactor.js` 892, `workspace-shell.js` 857 are already split).
- **Change:** one module per concern using the existing self-registration pattern (classic scripts,
  **not** ES modules — the renderer loads via plain `<script src>`): `chat-render.js`, `drawer.js`,
  `filetree.js`, `projects.js`, `status.js`, leaving `app.js` as wiring glue.
- **Done check:** `app.js` under 400 lines; `npm run test:workspace` and `npm run smoke` green in
  both themes at desktop and minimum sizes.
- **Effort:** 3–5 days · **Risk:** medium · **Depends:** 2.1 (manifest first so the contract is fixed)

### 2.3 Single owner for the code index — `TODO`

- **Evidence:** TTL and invalidation live in **`agent/code-context.cjs`** (`INDEX_TTL_MS` at `:42`,
  `getIndex` `:56`, `invalidateIndex` `:74`) — **not** in `code-index.cjs` as the old docs claimed.
  `code-index.cjs` is the largest agent module at 1,144 lines.
- **Change:** make `code-index.cjs` the single owner of build + cache + invalidation + TTL, with
  `code-context.cjs` and the workspace dashboard as pure consumers. Add a write-invalidation test
  that edits a file and asserts its stale symbols disappear.
- **Done check:** the invalidation test passes; only one module holds index state; and this lands
  **after** 0.2 so the phantom-symbol bug is not relocated mid-refactor.
- **Effort:** 1–2 days · **Risk:** medium · **Depends:** 0.2, 2.1

### 2.4 Split the remaining large agent modules — `TODO`

- **Evidence:** `agent/team-runner.cjs` **1,217** lines, `agent/test-loop.cjs` **1,075**,
  `agent/code-index.cjs` **1,144**, `agent/agent-net.cjs` **932**, `renderer/refactor.js` **892**.
- **Change:** apply the same thin-entry-point treatment as 2.1 to `team-runner.cjs` (member
  lifecycle / queue / supervision) — it is the module with the most untested failure paths (see 3.3).
- **Done check:** each split module under ~400 lines with unchanged public exports.
- **Effort:** 2–4 days · **Risk:** medium · **Depends:** 2.1

### 2.5 Optional: a TypeScript layer for IPC contracts — `TODO` · **do not start yet**

- **Evidence:** all IPC is stringly typed. 1.2 gives the channel *set*, not the *shapes*.
- **Change:** evaluate `ipc.types.ts` shared between main and preload with a build check. **Do not
  start this** until 2.1–2.3 land — introducing TS to a 3,748-line untyped file is a trap.
- **Done check:** a shape mismatch fails the build.
- **Effort:** 1 week · **Risk:** high · **Depends:** 2.1, 2.2

### 2.6 Test `resolveEndpoint` where it actually lives — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** **`studio/main.mjs:285`** — `async function resolveEndpoint(raw, depth = 0)`.
  `agent/connections.cjs:71` only *documents* that it owns pointer rewriting. Confirmed by grep.
  Both `IMPROVEMENTS.md` and every earlier draft placed it in the connections layer.
- **Change:** four focused tests — redirect-loop detection, credential rejection in the URL,
  `.txt` / `/v1` normalization, HTTP-failure propagation.
- **Done check:** four tests, each failing before its guard and passing after.
- **Effort:** 3 h · **Risk:** low · **Depends:** 2.1 (it lives in `main.mjs`, so it is *not*
  independent — extract it to `endpoint.cjs` first)

---

## 5. Phase 3 — Runtime value (teams, storage, agent loop)

### 3.1 Per-conversation storage instead of one `agents.json` — `TODO`

- **Evidence:** `agent/agent-store.cjs` serializes the whole `{ agents: [...] }` document — every
  conversation with full history, activity, todos and pending edits — and rewrites it wholesale.
- **Change:** `agents/<id>.json` per conversation plus a light `agents/index.json` holding exactly
  the fields `list()` already returns (id, name, dir, model, updatedAt, messageCount, status,
  parentChatId, forkIndex). Save becomes O(one conversation); corruption blast radius shrinks from
  "all chats" to "one chat".
- **Done check:** a migration test loads an existing `agents.json`, writes per-conversation files,
  every field round-trips, and corrupting one file loses exactly one conversation.
- **Effort:** 1–2 days · **Risk:** medium (migration) · **Depends:** 2.1, 1.5

### 3.2 Persist team runs across reload — `TODO` · **highest UX complaint in the project's own README**

- **Evidence:** `studio/README.md`: "Team sessions remain resumable while Studio stays open and until
  a new team task replaces them." Member stores are in-memory; a reload mid-team loses the run.
- **Change:** serialize team run state (member progress, message log, queue positions) to
  `userData/teams/<runId>.json` on each transition and restore on launch, feeding `teams:start`.
- **Done check:** kill the app mid-team-run, relaunch, **Start team** resumes unfinished members and
  does not rerun completed ones.
- **Effort:** 2–3 days · **Risk:** medium · **Depends:** 2.1 ("Persist team runs" needs the same
  store pattern; serialize atomic writes)

### 3.3 Capture failed crew members so retry is cheap — `TODO`

- **Evidence:** `agent/team-runner.cjs` (1,217 lines) keeps the run going when a member fails, but the
  failure is only a live event — no persisted "why did this member die" snapshot.
- **Change:** on member failure persist a snapshot (last message, failed tool, error, round count) in
  the run record so `teams:start` can retry just that member.
- **Done check:** a test kills one member mid-run; the failure surfaces with a snapshot and the other
  members complete.
- **Effort:** 1–2 days · **Risk:** medium · **Depends:** 3.2

### 3.4 Persist budget telemetry — `TODO`

- **Evidence:** `grep -rn budgets.jsonl studio` → **absent**. Every request already carries output
  allowance, answer reserve, rounds remaining and deadline; nothing is queryable afterward.
- **Change:** emit one record per request to `userData/budgets.jsonl`; surface per-conversation spend
  in **Models & Memory**. Turns "what did this task cost" into a number.
- **Done check:** after a run, `budgets.jsonl` has one line per request and the telemetry tab shows a
  matching total.
- **Effort:** 1 day · **Risk:** low · **Depends:** 2.1

### 3.5 Context-window visualizer — `TODO`

- **Evidence:** the **Context** bar shows an estimated token count and last reduction, but not which
  messages are in the window vs. compressed away.
- **Change:** a "context contents" expander listing messages as verbatim vs memory-compressed, with
  per-message estimated contribution.
- **Done check:** the expander matches the actual working context on a compaction-triggered run.
- **Effort:** 1–2 days · **Risk:** low · **Depends:** —

### 3.6 Close the integration-test gaps — `TODO`

- **Evidence:** `agent/agent-loop.cjs` has no dedicated integration test (only indirect coverage);
  browser tools have unit + Electron smoke coverage but no navigate → click → type → assert E2E;
  `team-runner.cjs` failure paths are untested (see 3.3). 40 test files exist but the agent loop,
  which is the heart of the product, is not directly driven end to end.
- **Change:** (a) one integration test driving a full conversation against a mock endpoint
  (multi-round, tool call, compaction trigger, Stop); (b) a browser E2E against a stub page served by
  the existing smoke harness; (c) the team failure test from 3.3.
- **Done check:** all three exist in `studio/test/` and run under `npm test`.
- **Effort:** 2–3 days · **Risk:** medium · **Depends:** 0.1, 0.2

### 3.7 Settings schema versioning — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `grep -rn schemaVersion studio` → **absent**. `settings.json` is normalized on read by
  shape, which gets brittle as legacy fields accumulate.
- **Change:** write `schemaVersion` on save, bump on migration, branch normalization on it.
- **Done check:** loading a legacy settings file migrates it, stamps the current version, and a second
  load is a no-op.
- **Effort:** 3 h · **Risk:** low · **Depends:** 2.1

---

## 6. Phase 4 — Release & distribution

### 4.1 Ship Windows installers from CI — `PARTIAL`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `grep -c "dist:win" .github/workflows/ci.yml` → **0**. The Windows leg of the studio
  matrix runs `npm ci`, `npm test`, `npm run smoke` and nothing else; macOS packages `--dir` and Linux
  packages + uploads AppImage/deb/zip/flatpak. `dist:win` and the NSIS + portable targets already
  exist in `studio/package.json`.
- **Change:** mirror the Linux pair:

  ```yaml
  - name: Package Windows installers
    if: runner.os == 'Windows'
    run: npm run dist:win
  - name: Upload Windows installers
    if: runner.os == 'Windows'
    uses: actions/upload-artifact@<pinned-sha>
    with:
      name: reach-studio-windows
      path: |
        studio/dist/*.exe
        studio/dist/*.exe.blockmap
      if-no-files-found: error
  ```

- **Done check:** a CI run on the Windows leg uploads `reach-studio-windows` containing the NSIS
  installer and portable `.exe`.
- **Effort:** 45 min · **Risk:** low · **Depends:** —

### 4.2 macOS notarization path — `TODO`

- **Evidence:** `studio/package.json` → `build.mac.identity: "-"` (ad-hoc signed).
  `grep -c "APPLE_ID\|notarize" .github/workflows/*.yml` → **0**.
  `studio/README.md`: "Local Mac builds are not notarized; public distribution needs Developer ID
  signing and notarization."
- **Change:** a CI path (or documented local path) consuming `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` from secrets to build a notarized DMG.
- **Done check:** a notarized DMG passes `spctl -a -vv` without the right-click → Open dance.
- **Effort:** 1 day plus Apple account setup · **Risk:** medium (external) · **Depends:** —

### 4.3 Auto-update checker — `TODO`

- **Evidence:** `grep -rn autoUpdater studio --include=*.mjs --include=*.cjs` → **absent**.
- **Change:** Electron `autoUpdater` against a generic feed pointing at the GitHub release feed
  (requires `latest.yml` in releases), or at minimum a "Check for updates" item on the About page
  comparing the feed version to `app.getVersion()`.
- **Done check:** with an older build installed, the checker reports a newer version and the download
  link resolves.
- **Effort:** 1–2 days · **Risk:** medium · **Depends:** 4.2 for the frictionless macOS path

### 4.4 Extend Dependabot beyond `github-actions` — `PARTIAL`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `.github/dependabot.yml` declares exactly one ecosystem: `github-actions`, `/`,
  weekly. Nothing bumps npm or pip. `studio/` depends on Electron 44, esbuild and 7 CodeMirror
  packages; CI runs `npm audit --audit-level=high`, which surfaces advisories but never moves a
  dependency forward.
- **Change:** add `npm` ecosystems for `/studio`, `/vscode`, `/copilot/tray` and `pip` for `/`.
- **Done check:** Dependabot opens a PR for an outdated `studio/` dependency.
- **Effort:** 30 min · **Risk:** low · **Depends:** —

### 4.5 Configurable log levels — `TODO`

- **Evidence:** Studio logs to the Electron console with no verbosity setting.
- **Change:** a `logLevel` setting (debug / verbose / off) gating console output, alongside the crash
  log.
- **Done check:** `off` silences console output; `debug` emits request-lifecycle lines.
- **Effort:** 4 h · **Risk:** low · **Depends:** —

### 4.6 Bounded browser history + search — `TODO`

- **Evidence:** the browser panel persists tabs and bookmarks but has no searchable history.
- **Change:** persist a bounded history list (URL, title, visitedAt) and a searchable address-bar
  dropdown.
- **Done check:** typing in the address bar filters by URL and title; the list is capped and rotates.
- **Effort:** 1 day · **Risk:** low · **Depends:** —

### 4.7 Parity for non-Windows telemetry — `TODO`

- **Evidence:** `studio/README.md`: "macOS and Linux have CPU, RAM and process readings; GPU, network
  and disk counters remain Windows-only." `agent/telemetry-windows.ps1` is the only collector script.
- **Change:** add `telemetry-macos.sh` / `telemetry-linux.sh` collectors (GPU via `system_profiler` /
  `nvidia-smi`; network via `netstat` / `/proc/net/dev`; disk via `iostat` / `diskutil`). The existing
  rule — missing counters display as **unavailable, never zero** — makes partial data safe to ship.
- **Done check:** on macOS and Linux the dashboard shows network/disk rates or an explicit
  unavailable label.
- **Effort:** 2–3 days · **Risk:** medium (platform variance) · **Depends:** —

### 4.8 Network inspector (developer toggle) — `TODO` · low priority

- **Evidence:** Studio→endpoint traffic is only visible through provider errors.
- **Change:** a developer toggle recording the last N request/response pairs (headers + first/last
  chunk, bodies redacted) to `userData/dev-net.jsonl`, with a viewer page.
- **Done check:** toggle on → run a chat → the viewer lists the exchange with the key redacted.
- **Effort:** 2 days · **Risk:** medium (must not leak keys) · **Depends:** 1.1

---

## 7. Phase 5 — Cross-surface & repo-wide

These are outside `studio/` but the same class of problem, and the repo review that found them is
still accurate on all of them.

### 5.1 `server/reachd/handler.py` — the relay's last God class — `TODO`

- **Evidence:** **1,227 lines**. `RelayHandler(BaseHTTPRequestHandler)` carries 52 methods:
  HTTP plumbing, CORS, auth + lockout, rate-limit headers, all `do_*` routing, audit, key management,
  browser-engine proxying, settings, publish, diagnostics and chat proxying. The relay was modularized
  into 16 modules — but its dispatcher was not, so it is now the largest file in `server/` and the one
  place every concern still meets.
- **Change:** split `RelayHandler` into concern modules behind a thin router. This is the same
  treatment `REFACTOR_LATEST.md` already applied successfully to the rest of the relay — the precedent
  exists in this repo.
- **Done check:** `handler.py` under ~300 lines, routing only; the relay's test suite still passes.
- **Effort:** 1–2 weeks · **Risk:** high (mirror `studio/main.mjs`) · **Depends:** —

### 5.2 Three browser engines coexist — `TODO`

- **Evidence:** `server/browser-engine/main.cjs` (Electron, 25,003 bytes),
  `server/reachd/browser_engine.py` (18,053), `src/browser-engine.js` (11,438) — plus Studio's own
  `studio/browser/{agent,host,page}.cjs`. Four implementations of one concept.
- **Change:** pick one engine per surface and make the others thin bridges, or share a single engine.
  Each independent copy is a behaviour-drift risk: a fix in one silently misses the others.
- **Done check:** one implementation of the frame/input/snapshot logic; the others forward to it.
- **Effort:** 1 week+ · **Risk:** high (cross-language) · **Depends:** —

### 5.3 VS Code extension has no module boundary and no local test entry — `PARTIAL`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `vscode/media/chat.js` is **3,217 lines** — the largest JavaScript file in the repo —
  and `vscode/extension.js` is **2,703**. `vscode/package.json` declares **no `scripts` at all** — no
  `test`, no `lint`, no `build`. Its 25 test files live in root `tests/vscode_*.test.cjs` and run only
  from the repo root, so an extension contributor inside `vscode/` has no entry point.
- **Change:** add a `scripts` block (`test`, `lint`) that delegates to the root tests; split `chat.js`
  the way Studio split its renderer.
- **Done check:** `cd vscode && npm test` runs the extension tests; `chat.js` under ~800 lines.
- **Effort:** 3–5 days · **Risk:** medium · **Depends:** —

### 5.4 Tray has no test script — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `copilot/tray/package.json` scripts are `{start, gen-icon, dist}` — no `test` — while 7
  `tray_*.test.cjs` files exist in root `tests/`.

### 5.5 Root `tests/` mixes four products in one flat directory — `TODO`

- **Evidence:** 49 entries: 11 Python (`test_reachd*.py`, `test_browser*.py`), 7 tray
  (`tray_*.test.cjs`), 25 VS Code (`vscode_*.test.cjs`), plus `browser_engine.test.cjs` and
  `endpoint_client.test.cjs`. Both `unittest discover -s tests` and
  `node --test tests/*.test.cjs` run against the whole pile.
- **Change:** split into `tests/reachd/`, `tests/vscode/`, `tests/tray/`, `tests/tools/` and update
  the two runners.
- **Done check:** each product's tests run from its own directory; the root runners point at
  subdirectories.
- **Effort:** half a day · **Risk:** low · **Depends:** 5.3

### 5.6 JavaScript parse coverage has holes — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** the CI `lint` job runs `node --check` over `src/*.js vscode/*.js vscode/media/*.js
  copilot/tray/*.js`. `server/browser-engine/main.cjs` and `tools/endpoint-client.cjs` fall outside
  every check in the repo. (`studio/scripts/check-syntax.cjs` is now recursive, which fixed the
  equivalent Studio hole.)

### 5.7 `src/reach.js` (1,243 lines) and flat page modules — `TODO`

- **Evidence:** `src/reach.js` = 1,243 lines; `src/pages-settings.js` = 978; 9 `pages-*.js` peers
  loaded as flat classic scripts with no module boundaries beyond file separation.

---

## 8. Phase 6 — Features & developer experience

All `TODO`. Effort estimates are from the prior plan and remain plausible; none was verified because
none exists.

| ID | Item | Why / evidence | Done check | Effort |
| --- | --- | --- | --- | --- |
| 6.1 | Command palette (`Ctrl/Cmd+K`) | The SimpleRAG panel has one; Studio has none. Most actions already exist as renderer functions | Palette dispatches over the existing IPC surface | 1–2 days |
| 6.2 | Find-in-project panel | Agents get `search` as a tool; the human UI has no cross-file find | Results click-to-open with line jump in CodeMirror | 1–2 days |
| 6.3 | Minimal git surface | The app edits files but shows no diff and cannot commit; `agent/diff.cjs` already exists as a diff engine | Modified/added list + diff view + commit with message | 2–3 days |
| 6.4 | Restore last session on launch | `projects.json` remembers the project list, not open files or the active conversation | `session.json` (project, conversation, tabs + scroll) restored | 1 day |
| 6.5 | Search across conversations | Conversations are browsable but not searchable | "Find in chats" over messages + activity | 1 day |
| 6.6 | Saved prompts / templates | Every chat starts from an empty composer | `templates.json` + "New from template" | 1 day |
| 6.7 | Local model chat (Ollama / LM Studio) | The connection layer is already OpenAI-compatible | Add `http://127.0.0.1:11434/v1` as a connection + a "local model" badge | 2 days |
| 6.8 | Model comparison view | The playground runs one connection per run | Same prompt to N connections, N columns with latency + tokens | 2–3 days |
| 6.9 | Split editors / multiple windows | Single `BrowserWindow`; one active file at a time | Phase 1 split-view; phase 2 window per project | 3–5 days |
| 6.10 | Keyboard-shortcut customization | Shortcuts are hardcoded (`Ctrl/Cmd+L/F/T/W`, `Cmd+Enter`, rail digits) | Settings shortcut map with collision detection | 2 days |
| 6.11 | Theme extensibility | Two themes on CSS variables; no user theme path | "Import theme" mapping a small variable set with live preview | 1–2 days |
| 6.12 | Unified team activity timeline | Individual activity is tracked; no combined team view | Combined timeline card in the conversation | 1 day |

**Only 6 source markers** (`TODO`/`FIXME`/`HACK`/`XXX`) exist across
`studio/agent`, `studio/renderer`, `main.mjs`, `src`, `vscode`, `server` — the codebase is not
secretly littered with abandonment; these gaps are structural, not debt markers.

---

## 9. Phase 7 — Documentation & hygiene

### 7.1 Reconcile the improvement docs — `PARTIAL` · **do this with this file**

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** four overlapping docs (`IMPROVEMENTS.md` 782 lines, `IMPROVEMENTS_PRIORITIZATION.md`,
  `IMPROVEMENTS_REVIEW.md` 206, `DESIGN_IMPROVEMENTS.md` 218) plus `STUDIO_IPC.md` (226), all stating
  different, stale numbers for the same files. `docs/STUDIO_IPC.md` says 74/75 channels; reality is
  80/81. `IMPROVEMENTS.md` says 3,481 lines; reality is 3,746.
- **Change:** keep **this** file as the single source of truth; reduce the other four to a one-line
  pointer each (or delete them). Move the stale ones under `docs/archive/`.
- **Done check:** exactly one improvement doc states numbers, and `bash docs/verify-improvements.sh`
  reproduces them (§11).
- **Effort:** 1 h · **Risk:** low · **Depends:** —

### 7.2 Root README is a relay README — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** root `README.md` is ~614 lines across many headings, covers relay, tray, VS Code and
  Docker, and barely points at `studio/`. A contributor asking "how do I build the desktop app" reads
  a relay README.
- **Change:** a short root section ("this repo ships four products…") with one-paragraph pointers;
  keep deep docs per product (`studio/README.md` is already good). Note the README is itself a
  release-please `extra-file`, so it is rewritten on every release — keep it stable.
- **Done check:** two clicks from the root README to the studio build steps.
- **Effort:** 2 h · **Risk:** low · **Depends:** —

### 7.3 `studio/CONTRIBUTING.md` — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `studio/README.md` documents running/building for *users*; "how do I add a tool / a
  page / an IPC handler" lives only in code comments.
- **Change:** document the three extension points (tool registry, page modules, IPC manifest), the
  test commands, and the status conventions in §10.
- **Done check:** a first-time dev reaches `npm ci && npm test` in under 5 minutes from the doc alone.
- **Effort:** 3 h · **Risk:** low · **Depends:** 1.2

### 7.4 No `SECURITY.md` — `DONE`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** no `CONTRIBUTING.md`, `SECURITY.md` or `CODE_OF_CONDUCT.md` anywhere — notable given
  the project ships an SSH-tunnel/key-minting access model and actively accepts PRs.
- **Change:** add `SECURITY.md` with the disclosure address and the threat model (keys at rest,
  tunnel URL rotation, IP allow/block, lockout).
- **Effort:** 2 h · **Risk:** low · **Depends:** 1.1 (so the doc can state the real key story)

### 7.5 Relay endpoint documentation — `TODO`

- **Evidence:** endpoints are undocumented beyond the README table; `handler.py` routes are the only
  specification.
- **Change:** an OpenAPI spec or `docs/endpoints.md` with request/response examples, generated from
  the route table if possible.
- **Done check:** every route in `server/reachd/handler.py` appears in the doc.
- **Effort:** 1 day · **Risk:** low · **Depends:** 5.1 (a thinner router makes this mechanical)

### 7.6 `docs/` has no index and mixes genres — `PARTIAL`

Current implementation and verification: see the table at the top; evidence below is the original baseline.

- **Evidence:** `CODEGPT_ECONOMY_HANDOFF.md` (a handoff note) sits beside review documents and the
  improvement plans.

---

## 10. Sequencing, interfaces & invariants

### 10.1 Recommended order

```
0.1  0.2            ← make the suite green. Nothing else is verifiable until then.
 ↓
1.1  1.3  1.4  1.5  1.6  1.7  1.8    ← security/integrity; mostly independent files
 ↓
2.1 (main.mjs split)                  ← CRITICAL PATH. One worker, one domain per commit.
 ↓
1.2  2.6  2.2  2.3                    ← all unblocked by 2.1
 ↓
3.1  3.2  3.3  3.4  3.7               ← storage/teams; need 2.1's store pattern
 ↓
4.1  4.4  4.5  4.6          5.1–5.7   ← release + cross-surface (parallel, different repos)
 ↓
6.x  7.x                              ← features + docs, anytime
```

**Collision map — two workers in one file is how a crew ships a broken whole:**

| File | Items that touch it | Rule |
| --- | --- | --- |
| `studio/main.mjs` | 1.1, 1.8, 2.1, 2.6, 3.2, 3.4, 3.7 | **One writer until 2.1 lands** |
| `studio/renderer/app.js` | 2.2, 6.1, 6.2, 6.4 | Serialize behind 2.2 |
| `studio/preload.cjs` | 1.2, 1.3 | One writer (manifest touches every channel) |
| `studio/agent/agent-store.cjs` | 1.5, 3.1 | Serialize — 3.1 supersedes 1.5's shape |
| `studio/agent/audit-log.cjs` | 0.1 | Single owner |
| `studio/agent/code-index.cjs` + `code-context.cjs` | 0.2, 2.3 | Serialize — 0.2 **before** 2.3 |
| `.github/workflows/ci.yml` | 4.1 | Batch |
| `.github/dependabot.yml` | 4.4 | Batch |

### 10.2 Frozen interfaces (if reality contradicts one, amend this section FIRST)

- **I1 · `atomicWriteJson(file, value)` / `atomicWriteText(file, text)`** — `agent/atomic-write.cjs`.
  Contract: same directory, sibling `.tmp`, `renameSync` over target, parent dirs created.
  **Invariant A1:** after success no `*.tmp` survives; the target is old or new, never partial.
  All new persistence (1.5, 3.1, 3.2, 3.4, 3.7) goes through this. **Never** a bare `fs.writeFileSync`
  on a user-data JSON file.
- **I2 · Audit record versioning** — `agent/audit-log.cjs`. **Invariant A2:** `canonical()` must hash
  `record.v`, **never** the module constant, or every existing log is invalidated. This is the one
  edit that can silently destroy history — do not "tidy" it.
- **I3 · Rotation chain** — **Invariant A3:** a rotated file's first record is a legal chain start,
  and `verify()` must seed its expected counter from that record rather than resetting to 1. The
  first record of a rotated file is a `rotate` **link record** with `carry === prev`, which is what
  makes it a legal anchor. **Lands in 0.1 (DONE), 12/12 green.**
  **Bound (measured, do not restate tighter):** rotation fires when the active file *reaches*
  `maxBytes`, checked **before** the next append. The achievable ceiling on the active file is
  **`maxBytes + one record`** — not `maxBytes` — because the record that triggered the rotation is
  appended after it. At rest following a rotation the active file holds only the link record
  (**464 B** measured). One record is **383 B**; the link record is **463 B**. A test asserting the
  active file is under `maxBytes` is unsatisfiable and must not be reintroduced.
- **I4 · Archive, never delete** — **Invariant A4:** trimmed conversation messages must replay from
  `agents/<id>.history.jsonl`.
- **I5 · IPC set equality** — **Invariant A5:** `set(preload) == set(manifest) == set(handlers)`,
  with `browser:command` whitelisted **explicitly**. Verified delta today is exactly `browser:command`.
- **I6 · `resolveEndpoint` guards hold in `agent/endpoint.cjs`**, shared by main-process consumers.

### 10.3 Invariant → check (for a verifier)

| # | Invariant | One check |
| --- | --- | --- |
| A1 | Atomic writes leave no partial file or `.tmp` | `test/atomic-write.test.cjs` truncation case |
| A2 | Audit hashes keep `record.v`, never the constant | legacy `v:1` fixture still verifies |
| A3 | Rotation preserves the chain across files | `node --test test/audit-log.test.cjs test/audit-rotation.test.cjs` (GREEN: 12/12) |
| A4 | Conversation trimming archives, never deletes | archive replays trimmed messages |
| A5 | Channel sets agree in both directions | delete a handler → `npm test` prints the set diff |
| A6 | `resolveEndpoint` guards hold in `main.mjs` | 4 tests, each red before its guard |
| A7 | `npm test` fully green | `cd studio && npm test; echo $?` → `0` (GREEN: 460/460) |
| A8 | Code index has no phantom symbols | `node --test test/code-index.test.cjs` (GREEN today) |
| A9 | Tree is clean | `git status --porcelain \| wc -l` → 0 (currently 8) |

### 10.4 Working agreement

1. **One item per PR**, Conventional Commits, item ID in the scope.
2. **Never leave the tree dirty.** Land or stash before handing off.
3. **Every behavior change needs a test** in `studio/test/*.test.cjs`, and `npm test` must be green.
4. **Architecture items (2.x) are land-only-with-tests** — they move code, they don't change behavior.
   If a refactor PR changes observable behavior, it is two PRs.
5. **Flip the status here when you land an item** and fix the evidence line if reality moved. This
   document rotting is the failure mode it was written to prevent.
6. **Do not mark an item `DONE` on a branch where `npm test` is red.** The previous crew did this
   four times.

---

## 11. Re-verification

Use Node.js 24+, then run from the repository root:

```sh
bash docs/verify-improvements.sh
(cd studio && npm test)
(cd studio && npm run test:coverage)
(cd studio && npm run smoke)
(cd studio && npm run test:agents-ui)
(cd vscode && npm test)
(cd copilot/tray && npm test)
node tools/check-javascript.cjs
```

Studio smoke/UI tests require a graphical session and create isolated temporary
profiles. Windows installer generation and actual OS notification presentation
cannot be certified by unit tests on macOS. Keep those items PARTIAL until their
platform checks run.
