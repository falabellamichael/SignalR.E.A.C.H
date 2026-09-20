# REACH Studio — Consolidated Improvement Plan

**This is the single source of truth.** It supersedes `docs/IMPROVEMENTS_PRIORITIZATION.md`
and the previous `docs/IMPROVEMENTS.md`. If anything here disagrees with them, this file wins.

| Field | Value |
| --- | --- |
| Audience | Team-workers shipping changes to this repo |
| Scope | `studio/` desktop app + the repo infrastructure around it |
| Baseline | Re-verified against the working tree while writing this (see §1, §2) |
| Re-verification command | `bash docs/verify-improvements.sh` (appendix C) |
| Status legend | `TODO` · `WIP` · `BLOCKED` · `DONE` |

---

## 0. How to use this document

Every item has the same five fields so you can pick one up cold:

- **ID** — stable, citable in PR titles and review comments (`fix(studio): 2.3 atomic settings writes`).
- **Evidence** — the exact command and the exact result measured on this baseline. If the
  command no longer produces that result, the item is probably already done — re-check before working.
- **Change** — the concrete edit, named by file. No "consider improving" hand-waving.
- **Done check** — the observable proof a reviewer will run. If you cannot demonstrate this,
  the item is not done.
- **Effort / Risk / Depends** — sizing so parallel workers don't collide.

### Working agreement for team-workers

1. **One item per PR.** The `pr-title` CI job enforces Conventional Commits; use the item ID in the scope.
2. **Never leave the tree dirty.** Item 0.1 exists because the tree had 11 modified files at
   baseline. Land or stash your work; don't hand the next worker a dirty tree.
3. **Every behavior change needs a test** in `studio/test/*.test.cjs`, and `npm test` must be green.
4. **Architecture items (Phase 3) are land-only-with-tests.** They move code, they don't change behavior;
   if a refactor PR changes observable behavior, it is two PRs.
5. **Update this file when you land an item** — flip the status and, if reality moved, fix the Evidence line.
   This document rotting is the failure mode it was written to prevent.

---

## 1. Verified baseline

Measured on the current working tree. These numbers are the anchors for every Evidence line below.

| Metric | Measured | Command |
| --- | --- | --- |
| `studio/main.mjs` | **3,481 lines** | `wc -l studio/main.mjs` |
| Registered IPC handlers | **74** (75 `ipcMain.handle` matches; 1 is a doc comment) | `grep -c "ipcMain.handle" studio/main.mjs` |
| `studio/preload.cjs` | 178 lines; **78 `ipcRenderer.invoke` channels** + event listeners + 1 `sendSync` | `grep -c ipcRenderer.invoke studio/preload.cjs` |
| `studio/renderer/app.js` | **2,714 lines** | `wc -l studio/renderer/app.js` |
| Renderer JS modules | 18 files in `studio/renderer/` | `ls studio/renderer/*.js \| wc -l` |
| Studio test files | **28** | `ls studio/test/*.test.cjs \| wc -l` |
| Studio `package.json` version | `1.0.0` (repo is at 26.9.5) | `node -p "require('./studio/package.json').version"` |
| release-please packages | **1** — only `"."` | `node -p "Object.keys(require('./release-please-config.json').packages)"` |
| CI workflows | `ci.yml`, `release-please.yml`, `monthly-version-roll.yml`, `dependabot.yml` | `ls .github/workflows` |
| Windows packaging in CI | **absent** (matrix runs `windows-latest`, but no `dist:win`) | `grep -n "dist:win" .github/workflows/ci.yml` |
| Renderer CSP | contains `script-src 'self' 'unsafe-inline'` | `grep -n unsafe-inline studio/renderer/index.html` |
| Crash handlers in main | **none** | `grep -rn "uncaughtException\|unhandledRejection" studio/` |
| `engines.node` | `>=22.12.0` | `node -p "require('./studio/package.json').engines.node"` |
| Node version claims | 3-way drift: `>=22.12.0` / README "Node.js 24 LTS" / CI `node-version: '24'` | see above |
| Dirty files at baseline | **11** | `git status --porcelain \| wc -l` |
| `studio/dist/` | physically present despite `studio/.gitignore` listing `dist/` | `du -sh studio/dist` |

**Baseline invariants that already hold — do not "fix" these:**

- `studio/agent/agent-store.cjs` already writes atomically (`fs.writeFileSync(tmp)` + `fs.renameSync`).
  Copy that pattern; don't invent a new one.
- `.github/` exists with three workflows and a dependabot config — CI is real and comprehensive
  (3-OS studio matrix, Python 3.8–3.13 matrix, docker build + boot assertions).
- `docker/studio/Dockerfile` bakes `HEALTHCHECK` into the image, so compose inherits it.
- `studio/scripts/check-syntax.cjs` already walks `main.mjs`, `preload.cjs`, `agent/`, `browser/`,
  `renderer/`, `test/`, `scripts/` and `node --check`s each file.

---

## 2. Corrections to the previous two drafts

The earlier drafts were directionally right but carried numbers that had drifted. Fix your mental model:

| Previous claim | Verified reality | Impact |
| --- | --- | --- |
| `main.mjs` is 3,389 lines | **3,481** | Sizing only; conclusion unchanged |
| `renderer/app.js` is 2,665 lines | **2,714** | Sizing only |
| `preload.cjs` exposes ~100 methods | **78 `invoke` channels** + listeners | The manifest item still stands; the surface is smaller than stated |
| "74 handlers" | **74 registered** (75 grep hits, one comment) | Confirmed — use 74 |
| `resolveEndpoint` is in `main.mjs` | It is referenced from the **agent/connections layer** (`agent/connections.cjs` documents that `resolveEndpoint()` owns pointer rewriting) | Item 3.7 re-scoped: test it where it lives; confirm the definition site first |
| "no `.github/` directory exists" | **False** — it exists and is thorough | Correctly dropped in the prior draft; kept dropped here |

> **Tooling caveat for workers:** the `glob` tool in this environment does **not** return dot-directories
> (`.github/**` returned an empty match list even though the directory exists). Verify dot-paths with
> `list` or `shell`, never with `glob` absence.

---

## 3. Phase 0 — Unblock (do first; < 1 hour total)

These gate everything. A dirty tree makes every other PR unreviewable.

### 0.1 Land or stash the dirty working tree

- **Status:** `TODO`
- **Evidence:** `git status --porcelain | wc -l` → **11**.
- **Change:** commit or stash all 11 entries. If any is a half-finished experiment, move it to a
  feature branch; do not leave it in the shared tree.
- **Done check:** `git status --porcelain` prints nothing on the working branch.
- **Effort:** 15 min · **Risk:** none · **Depends:** —

### 0.2 Give `studio/` a real version number

- **Status:** `DONE`
- **Evidence:** `studio/package.json` `version: "1.0.0"`; `release-please-config.json` has exactly one
  package (`"."`, `package-name: signal-reach`). Every `studio/dist/` artifact is `1.0.0` while the
  repo ships 26.9.5.
- **Change:** add a second package entry to `release-please-config.json` for `studio/`:

  ```json
  "studio": {
    "release-type": "node",
    "package-name": "reach-studio",
    "changelog-path": "studio/CHANGELOG.md",
    "extra-files": [{ "type": "json", "path": "studio/package.json", "jsonpath": "$.version" }]
  }
  ```

  Then create `studio/CHANGELOG.md` with a seeded `1.0.0` entry so release-please has a starting point.
- **Done check:** a `feat(studio): …` merge produces a studio release PR touching only `studio/package.json`
  and `studio/CHANGELOG.md`; the About page shows the bumped version.
- **Effort:** 1 h · **Risk:** low (release config) · **Depends:** —

### 0.3 Ship Windows installers from CI

- **Status:** `TODO`
- **Evidence:** `.github/workflows/ci.yml` studio job runs on `windows-latest` but only macOS
  (`dist:mac -- --dir`) and Linux (`dist:linux` + artifact upload) have packaging steps.
  `grep -n "dist:win" .github/workflows/ci.yml` → no match. `studio/package.json` already defines `dist:win`.
- **Change:** add, mirroring the Linux pair:

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

- **Done check:** a CI run on the Windows leg uploads a `reach-studio-windows` artifact containing the
  NSIS installer and the portable `.exe`.
- **Effort:** 45 min · **Risk:** low · **Depends:** —

---

## 4. Phase 1 — Quick wins (high signal, low risk)

### 1.1 Replace the 28-file `&&` test chain with test discovery

- **Status:** `DONE` · **Priority:** highest ROI in the document
- **Evidence:** `studio/package.json` `test` script is 28 `node --test …` invocations joined with `&&`.
  `ls studio/test/*.test.cjs | wc -l` → **28**. A failure at file #23 means #24–28 never run.
- **Change:**

  ```json
  "test": "node scripts/check-syntax.cjs && node --test \"test/**/*.test.cjs\""
  ```

  Keep `test/agent.test.cjs` (it is run as a plain script today, not via `node --test`) working — confirm
  whether it self-runs or needs `node test/agent.test.cjs` preserved before deleting the chain.
- **Done check:** `npm test` discovers all 28 files, runs to completion even with one failure, and exits
  non-zero when any fail. Adding a new `*.test.cjs` requires **no** edit to `package.json`.
- **Effort:** 30 min · **Risk:** low (verify the agent.test special case) · **Depends:** —

### 1.2 Add linting (ESLint flat config)

- **Status:** `TODO`
- **Evidence:** no `eslint.config.*` / `.eslintrc*` / `.prettierrc*` anywhere; CI runs `node --check`
  (parse only) plus `compileall`. `studio/scripts/check-syntax.cjs` confirms syntax-only.
- **Change:** add `eslint.config.mjs` covering `studio/**/*.{js,cjs,mjs}` with a minimal rule set
  (`no-unused-vars`, `no-undef`, `prefer-const`, `eqeqeq`, `no-floating-promises` if you adopt typescript-eslint).
  Add `"lint": "eslint ."` and wire it into the `studio` CI job **after** `npm run check`.
  Land it warning-only first (`--max-warnings=-1` equivalent), then promote to errors once the baseline is clean.
- **Done check:** `npm run lint` runs in CI; a PR introducing an unused variable fails.
- **Effort:** 2–3 h including first cleanup pass · **Risk:** medium (initial noise) · **Depends:** 1.1 (fast feedback)

### 1.3 Add the missing coverage baseline

- **Status:** `TODO`
- **Evidence:** no coverage config; no coverage output in CI. Largest untested-by-visibility modules:
  `agent/agent-loop.cjs`, `agent/team-runner.cjs`.
- **Change:** use Node's built-in coverage — zero new dependencies, matching the repo's dependency-light ethos:

  ```json
  "test:coverage": "node --test --experimental-test-coverage \"test/**/*.test.cjs\""
  ```

  Publish the baseline number in this file (update §1) and add a CI **warning** threshold, not a gate, initially.
- **Done check:** `npm run test:coverage` prints per-file coverage; the number is recorded in §1.
- **Effort:** 1 h · **Risk:** low · **Depends:** 1.1

### 1.4 Clean stray tracked artifacts

- **Status:** `DONE`
- **Evidence:** `studio/dist/` is physically present (100 MB+ of built apps, locale paks, `.dmg`, `.zip`)
  despite `studio/.gitignore` listing `dist/`; root carries `simplereach-1.0.0.vsix` and
  `copilot/tray/dist/{SignalREACH-1.1.0-arm64.dmg,simplereach-1.1.0.vsix}`; root `tests/` exists.
- **Change:** `git rm -r --cached` anything tracked under a gitignored path; add `__pycache__/` to the
  root `.gitignore` and verify no tracked copies remain (`git ls-files | grep __pycache__`). Move genuine
  debug HTML previews to `tests/fixtures/` with a README, or delete them.
- **Done check:** `git ls-files | grep -E 'dist/|\.vsix$|\.dmg$|__pycache__'` returns nothing tracked;
  `du -sh studio/dist` still works locally without git noise.
- **Effort:** 45 min · **Risk:** low (be careful with `--cached` vs `git rm`) · **Depends:** —

### 1.5 Add main-process crash handlers

- **Status:** `TODO`
- **Evidence:** `grep -rn "uncaughtException\|unhandledRejection" studio/` → no matches. One unhandled
  rejection in an agent loop can wedge the main process mid-run.
- **Change:** in `studio/main.mjs` (top of bootstrap, before window creation):

  ```js
  const crashLog = path.join(app.getPath('userData'), 'crash.log');
  process.on('uncaughtException', (err) => { appendCrashLog(crashLog, err); });
  process.on('unhandledRejection', (reason) => { appendCrashLog(crashLog, reason); });
  ```

  On a crash attributable to an agent run, mark that run failed in the store instead of leaving it
  `running`. Only call `app.quit()` for genuinely fatal errors — never lose conversation state.
- **Done check:** a test that throws inside a registered handler writes `crash.log` and the app stays
  alive; the affected conversation shows a failed rather than a stuck-running state.
- **Effort:** 1–2 h · **Risk:** low · **Depends:** 0.1

### 1.6 Atomic writes for settings and projects

- **Status:** `DONE`
- **Evidence:** `studio/main.mjs:160` writes `settings.json` with a bare
  `fs.writeFileSync(settingsFile(), …)`; line 170 does the same for `projects.json`. By contrast
  `agent/agent-store.cjs` uses `writeFileSync(tmp)` + `renameSync` and documents why. A crash mid-write
  corrupts settings, and the reader falls back to `{}` — silently losing every connection and key.
- **Change:** extract one `atomicWriteJson(file, value)` helper (mirroring the `agent-store` pattern) and
  use it for settings, projects, personas, teams, and the audit-log flush.
- **Done check:** a test truncates the `.tmp` file mid-write and asserts the previous `settings.json`
  survives intact.
- **Effort:** 2 h · **Risk:** low · **Depends:** —

### 1.7 Drop `'unsafe-inline'` from `script-src`

- **Status:** `DONE`
- **Evidence:** `studio/renderer/index.html:5` →
  `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'`, with an inline `<script>` in the file.
- **Change:** move the inline script to `renderer/boot.js` (loaded before the other scripts, like the
  existing `<script src="theme.js">` at line 7) and remove `'unsafe-inline'` from `script-src`. Keep it
  for `style-src` only if dynamic style injection needs it.
- **Done check:** the CSP meta tag no longer contains `script-src 'self' 'unsafe-inline'`; the app boots
  with no CSP violation in the console; `npm run smoke` is green.
- **Effort:** 1 h · **Risk:** medium (easy to break boot order — test both themes) · **Depends:** —

### 1.8 Pin one Node version

- **Status:** `DONE`
- **Evidence:** three claims — `studio/package.json` `engines.node: ">=22.12.0"`, `studio/README.md`
  "Use … Node.js 24 LTS", CI `node-version: '24'`.
- **Change:** adopt 24 LTS (the README is the user-facing promise). Set `engines.node: ">=24"`, add
  `studio/.nvmrc` with `24`, and update the preflight checks in `install.sh` / `install.ps1`.
- **Done check:** the three sources agree; a Node 22 run fails the engines check with a clear message.
- **Effort:** 45 min · **Risk:** low · **Depends:** —

---

## 5. Phase 2 — Security & data integrity

### 2.1 Encrypt API keys at rest

- **Status:** `TODO` · **Priority:** highest security item
- **Evidence:** `settings.json` in userData stores `connections[].accessKey` as plain JSON written by
  `saveSettings` (`studio/main.mjs:160`). Anyone with file access reads every provider key.
- **Change:** wrap key storage in Electron's built-in `safeStorage` (DPAPI / Keychain / libsecret) — no
  new dependency. Persist `safeStorage.encryptString(key).toString('base64')`; decrypt only at request
  time and keep plaintext in memory. Where `safeStorage.isEncryptionAvailable()` is false, fall back to
  plaintext **and surface a visible warning** in Settings.
- **Done check:** `settings.json` contains an encrypted blob, not a readable key; a live request still
  authenticates; the fallback path is exercised by a test with encryption stubbed unavailable.
- **Effort:** 3–4 h · **Risk:** medium (migration of existing plaintext keys) · **Depends:** 1.6
- **Migration note:** on first load, if a plaintext key is present, encrypt it, rewrite, and keep a
  one-time backup `settings.json.bak` so a failed migration isn't data loss.

### 2.2 Protect the Copilot shim token

- **Status:** `DONE`
- **Evidence:** `copilot/copilot_shim.py` reads and writes the Copilot web token as plaintext in
  `copilot_token.txt` next to the script.
- **Change:** move to the platform secret store, or — minimum viable — write with `chmod 600` and warn
  loudly when the file is group/world-readable on load.
- **Done check:** the file is `0600` after a write; a world-readable file produces a startup warning.
- **Effort:** 1 h · **Risk:** low · **Depends:** —

### 2.3 Audit every IPC handler for input validation

- **Status:** `TODO`
- **Evidence:** 74 `ipcMain.handle` calls in `main.mjs` with no manifest, no shared validation layer, and
  no documented invariant about what each accepts. Path containment is enforced in places
  (`resolveInProject`) but there is no systematic check.
- **Change:** walk all 74 handlers; for each, record the argument shape and whether it validates
  (path containment, URL scheme, numeric bounds, id existence). Produce `docs/STUDIO_IPC.md` (see 8.2)
  with a validation column and fix the ones that are missing guards.
- **Done check:** every handler has a documented argument shape and a validation verdict; each gap has a
  linked fix.
- **Effort:** 4–6 h · **Risk:** medium (touches many handlers) · **Depends:** 3.1 (splitting first makes
  this far easier — consider doing 3.1 first, then this)

### 2.4 Bound the audit log

- **Status:** `TODO`
- **Evidence:** `studio/agent/audit-log.cjs` hash-chains entries (good) into
  `security-audit.jsonl`, append-only, with no size policy.
- **Change:** add rotation by size (keep the last N MB) **without breaking the hash chain** — the first
  entry of the new file records the final hash of the previous file. Add a `verify` affordance
  (CLI command and/or an About-page button) that walks the chain and reports `ok` or the first bad link.
- **Done check:** rotating mid-chain keeps `verify` passing; a hand-edited line makes `verify` fail at
  the correct index.
- **Effort:** 3 h · **Risk:** medium (chain integrity) · **Depends:** 1.6

### 2.5 Per-conversation size limits

- **Status:** `TODO`
- **Evidence:** `agent/agent-store.cjs` already caps `MAX_AGENTS = 200` and `MAX_STORED_MESSAGES = 400`,
  but the on-disk history still grows with activity, todos and pending edits per conversation.
- **Change:** cap per-conversation serialized bytes; when exceeded, trim the oldest activity and
  archive trimmed messages to `agents/<id>.history.jsonl` rather than dropping them.
- **Done check:** a conversation with a forced 10 MB history stays under the cap on save and its archive
  is readable.
- **Effort:** 3 h · **Risk:** medium (data loss if done wrong — archive, never delete) · **Depends:** 1.6

### 2.6 Do not over-trust model input/output

- **Status:** `TODO` · **Priority:** low-medium (document, don't over-engineer)
- **Evidence:** conversation history is sent to the endpoint as-is; there is no sanitization pass.
- **Change:** this is **not** a request to "sanitize prompts" wholesale — that breaks legitimate use.
  Instead: (a) never let model output silently approve pending edits (the README already claims this —
  verify and add a regression test); (b) treat file/tool output as untrusted data in the prompt, with a
  clear delimiter, so a malicious file cannot impersonate a system instruction.
- **Done check:** a regression test where a fixture file contains text impersonating an approval
  directive cannot cause an edit to be applied without human approval.
- **Effort:** 2 h · **Risk:** low · **Depends:** —

### 2.7 Rate-limit outbound agent requests

- **Status:** `TODO`
- **Evidence:** the relay has `RateLimiter` / `CounterGate` in `server/reachd/limits.py`; nothing
  client-side caps requests per connection. An 8-member team can drive a limited endpoint into 429s.
- **Change:** a small per-connection gate (requests/min with a queue) in `agent/connections.cjs`; when
  held, surface "waiting on provider budget" in the activity header so it is visible, not silent.
- **Done check:** a test issues 2× the limit in a burst against a mock endpoint and observes queuing,
  not parallel 429s.
- **Effort:** 3 h · **Risk:** low · **Depends:** 3.3 (cleaner connection layer)

---

## 6. Phase 3 — Architecture (highest leverage, highest effort)

Precedent: `specs/REFACTOR_LATEST.md` ran exactly this "thin entry point + modules" split on the relay
(`server/reachd/`) and it worked. Do the same to Studio.

### 3.1 Split `studio/main.mjs` (3,481 lines, 74 handlers)

- **Status:** `TODO` · **Priority:** highest architectural item
- **Evidence:** `wc -l studio/main.mjs` → 3,481; 74 registered handlers. One module contains stores,
  settings normalization, endpoint resolution, the approval bus, the agent-loop cache, team-run
  bookkeeping, playground runs, and every IPC handler.
- **Change:** leave `main.mjs` as bootstrap (lifecycle + window + `registerIpc()`) and extract:

  | New module | Owns |
  | --- | --- |
  | `ipc/agents.cjs` | `agents:*` handlers (lines ~375–527) |
  | `ipc/teams.cjs` | `teams:*`, `personas:*`, `roles:*` (~528–755) |
  | `ipc/files.cjs` | `files:*`, `project:*` (~326–800) |
  | `ipc/settings.cjs` | `settings:*`, `connections:*`, `models:*` (~801–966) |
  | `ipc/workspace.cjs` | `workspace:*`, `playground:*` (~967–1198) |
  | `ipc/refactor.cjs` | `refactor:*` (~1306–1990) |
  | `stores.cjs` | settings/projects persistence + `atomicWriteJson` |
  | `agent-cache.cjs` | the `agentLoops` / `teamRuns` maps + invalidation rules |

- **Done check:** `main.mjs` under 200 lines; `ls studio/ipc/*.cjs` shows the domains; `npm test` and
  `npm run smoke` green at every step.
- **Effort:** 1–2 weeks · **Risk:** high (do it in small, individually-green commits) · **Depends:** 2.x safety net (1.5, 1.6, 2.1)
- **Method:** the smoke test in `main.mjs` (~lines 2000–3400) exercises the real IPC surface end to end.
  Use it as the safety net and change **one domain per commit**.

### 3.2 Split `studio/renderer/app.js` (2,714 lines)

- **Status:** `TODO`
- **Evidence:** one flat file holds tab switching, log/status, project list, agent tree, chat rendering
  (`appendChatMessage`, `renderChatHistory`, `renderTodos`, `renderPendingEdits`), composer send/stop,
  drawer resizing, and file-tree logic. There are already 18 renderer JS files, so a module convention exists.
- **Change:** one module per concern with the existing self-registration pattern (classic scripts, not ES
  modules — the renderer loads scripts with plain `<script src>`): `chat-render.js`, `drawer.js`,
  `filetree.js`, `projects.js`, `status.js`, leaving `app.js` as the wiring glue.
- **Done check:** `app.js` under 400 lines; `npm run smoke` captures all three telemetry views in both
  themes at desktop and minimum sizes without regression.
- **Effort:** 3–5 days · **Risk:** medium · **Depends:** 3.1 (manifest first so the contract is fixed)

### 3.3 Give the IPC surface a manifest

- **Status:** `TODO`
- **Evidence:** `preload.cjs` exposes 78 `invoke` channels plus listeners with no machine-checked link to
  the 74 `ipcMain.handle` channels. A typo on either side fails at runtime, not build time.
- **Change:** a `studio/ipc-manifest.json` (channel → owning module → arg/return shape) and a test that
  asserts the set of channels in `preload.cjs` equals the set registered by `main.mjs`, both directions.
  Same single-source-of-truth principle the VS Code side uses for its tool registry.
- **Done check:** adding a channel to `preload.cjs` without a handler fails `npm test` with a diff of the
  two sets.
- **Effort:** 1–2 days · **Risk:** medium · **Depends:** 3.1 (needs the split to attribute owners)

### 3.4 Consider a TypeScript layer for IPC contracts (optional)

- **Status:** `TODO` · **Priority:** lower — evaluate after 3.3
- **Evidence:** all IPC is stringly typed; 3.3 gives you the channel *set* but not the *shapes*.
- **Change:** evaluate `ipc.types.ts` shared between main and preload with a build check. **Do not start
  this** until 3.1–3.3 have landed — introducing TS to a 3,481-line untyped file is a trap.
- **Done check:** a shape mismatch fails the build.
- **Effort:** 1 week · **Risk:** high · **Depends:** 3.1, 3.3

### 3.5 Single owner for the code index

- **Status:** `TODO` (re-scoped — the previous draft's version of this was partly wrong)
- **Evidence:** `agent/code-context.cjs` owns a TTL cache with write-invalidation (`getIndex` /
  `invalidateIndex`) and `main.mjs` consumes it. `agent/code-index.cjs` is the largest agent module
  (~1,144 lines). The prior "rebuilt every round" claim was **false** and correctly dropped.
- **Change:** make `code-index.cjs` the single owner of build + cache + invalidation + TTL, with
  `code-context.cjs` and the workspace dashboard as pure consumers. Add a write-invalidation test that
  edits a file and asserts its stale symbols disappear.
- **Done check:** the invalidation test passes; only one module holds index state.
- **Effort:** 1–2 days · **Risk:** medium · **Depends:** 3.1

---

## 7. Phase 4 — Runtime value (data, teams, agent loop)

### 4.1 Per-conversation storage instead of one `agents.json`

- **Status:** `TODO`
- **Evidence:** `agent/agent-store.cjs` serializes `{ agents: [...] }` — every conversation with full
  message history, activity, todos and pending edits — into one document, rewritten wholesale per save.
- **Change:** `agents/<id>.json` per conversation plus a lightweight `agents/index.json`
  (id, name, dir, model, updatedAt, messageCount, status, parentChatId, forkIndex — exactly the fields
  `list()` already returns). Makes save O(one conversation), lets you prune/export one chat, and shrinks
  corruption blast radius from "all chats" to "one chat".
- **Done check:** a migration test loads an existing `agents.json`, writes per-conversation files, and
  every field round-trips; corruption of one file loses only that conversation.
- **Effort:** 1–2 days · **Risk:** medium (migration) · **Depends:** 1.6, 2.5

### 4.2 Persist team runs across reload

- **Status:** `TODO` · **Priority:** highest UX complaint in the codebase's own docs
- **Evidence:** `studio/README.md`: "Team sessions remain resumable while Studio stays open and until a
  new team task replaces them." Member stores are in-memory `MemoryStore`s; only pending edits live in
  main's maps. A reload mid-team loses the live session.
- **Change:** serialize team run state (member progress, message log, queue positions) to
  `userData/teams/<runId>.json` on each transition and restore on launch, feeding `teams:start`.
- **Done check:** kill the app mid-team-run, relaunch, `Start team` resumes unfinished members and does
  not rerun completed ones.
- **Effort:** 2–3 days · **Risk:** medium · **Depends:** 1.6

### 4.3 Capture failed crew members so retry is cheap

- **Status:** `TODO`
- **Evidence:** `agent/team-runner.cjs` (~744 lines) keeps the run going when a member fails, but the
  failure is only a live event; there is no persisted "why did this member die" snapshot beyond the
  audit log. Failure paths are untested.
- **Change:** on member failure persist a snapshot (last message, failed tool, error, round count) in the
  run record so `teams:start` can retry just that member instead of restarting the team.
- **Done check:** a test kills one member mid-run and asserts the failure surfaces with a snapshot while
  the other members complete.
- **Effort:** 1–2 days · **Risk:** medium · **Depends:** 4.2

### 4.4 Conversation export / import

- **Status:** `DONE`
- **Evidence:** conversations live only in userData; there is no export path in the IPC surface
  (`preload.cjs` has no export/import channel).
- **Change:** "Export conversation (.json or .md)" and import with schema validation — two IPC handlers
  plus a store method. Natural companion to Branch This Chat.
- **Done check:** export → import round-trips a conversation with activity, todos and pending edits
  intact; an invalid file is rejected with a clear error.
- **Effort:** 1 day · **Risk:** low · **Depends:** 4.1 (much easier with per-conversation files)

### 4.5 Notify on approval and edit-review requests

- **Status:** `TODO`
- **Evidence:** `requestApprovalFromRenderer` waits up to `approvalTimeoutMs` (default 300,000 ms = 5 min);
  if the user is in another app the agent silently times out to `false` (denied).
- **Change:** main-process `new Notification` + `shell.beep()` on approval and edit-review requests, plus
  a macOS dock badge. Small change, large effect for long-running agents.
- **Done check:** backgrounding the app during a pending approval fires an OS notification and the dock
  badge; clicking it focuses the window.
- **Effort:** 2 h · **Risk:** low · **Depends:** —

### 4.6 Persist budget telemetry

- **Status:** `TODO`
- **Evidence:** every model request already carries output allowance, answer reserve, rounds remaining and
  deadline (README "Budgeting"), but nothing is queryable afterward.
- **Change:** emit a per-request record to `userData/budgets.jsonl` and surface per-conversation spend in
  **Models & Memory**. Turns "what did this task cost" into a number.
- **Done check:** after a run, `budgets.jsonl` has one line per request and the telemetry tab shows a
  matching total.
- **Effort:** 1 day · **Risk:** low · **Depends:** 1.6

### 4.7 Test the endpoint-pointer resolver where it actually lives

- **Status:** `TODO` (re-scoped — the previous draft placed this in `main.mjs`)
- **Evidence:** `agent/connections.cjs` documents that `resolveEndpoint()` owns pointer rewriting with
  depth limits. It has no dedicated unit test (only indirect coverage).
- **Change:** confirm the definition site (`grep -rn "function resolveEndpoint\|resolveEndpoint =" studio/`),
  then add tests for: redirect loop detection, credential rejection, `.txt`/`/v1` normalization, and
  HTTP-failure propagation.
- **Done check:** four focused tests, each failing before the corresponding guard and passing after.
- **Effort:** 3 h · **Risk:** low · **Depends:** —

### 4.8 Close the remaining integration-test gaps

- **Status:** `TODO`
- **Evidence:** `agent-loop.cjs` has no dedicated integration test (only indirect coverage via
  `test/agent.test.cjs` and `test/budget-awareness.test.cjs`); browser tools have unit + Electron smoke
  coverage but no navigate → click → type → assert E2E; `team-runner.cjs` failure paths are untested.
- **Change:** (a) one integration test driving a full conversation against a mock endpoint (multi-round,
  tool call, compaction trigger, Stop); (b) a browser E2E against a stub page served by the existing
  smoke harness; (c) the team failure test in 4.3.
- **Done check:** all three exist in `studio/test/` and run in `npm test`.
- **Effort:** 2–3 days · **Risk:** medium · **Depends:** 1.1

---

## 8. Phase 5 — Release, distribution & observability

### 5.1 macOS notarization path

- **Status:** `TODO`
- **Evidence:** `studio/package.json` `build.mac.identity: "-"` (ad-hoc signed); README says "Local Mac
  builds are not notarized; public distribution needs Developer ID signing and notarization."
- **Change:** a CI path (or documented local path) consuming `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` from secrets to build a notarized DMG.
- **Done check:** a notarized DMG passes `spctl -a -vv` without the right-click → Open dance.
- **Effort:** 1 day (plus Apple account setup) · **Risk:** medium (external) · **Depends:** 0.2

### 5.2 Auto-update checker

- **Status:** `TODO`
- **Evidence:** no `autoUpdater` or update check anywhere in `studio/`.
- **Change:** Electron's `autoUpdater` against a generic feed pointing at the GitHub release feed
  (requires `latest.yml` in releases), or at minimum a "Check for updates" item on the About page
  comparing the feed version to `app.getVersion()`.
- **Done check:** with an older build installed, the checker reports a newer version and the download
  link resolves.
- **Effort:** 1–2 days · **Risk:** medium · **Depends:** 5.1 for the frictionless macOS path

### 5.3 Settings schema versioning

- **Status:** `TODO`
- **Evidence:** `settings.json` is normalized on read by `connections.normalizeSettings` (handles legacy
  endpoint / accessKey / model), but there is no `schemaVersion` field — migration is inferred from shape,
  which gets brittle as legacy fields accumulate.
- **Change:** write `schemaVersion` on save, bump it on migration, and branch normalization on it.
- **Done check:** loading a legacy settings file migrates it, stamps the current version, and a second
  load is a no-op.
- **Effort:** 3 h · **Risk:** low · **Depends:** 1.6

### 5.4 Bounded browser history + search

- **Status:** `TODO`
- **Evidence:** the browser panel persists tabs and bookmarks but has no searchable history.
- **Change:** persist a bounded history list (URL, title, visitedAt) and a searchable address-bar dropdown.
- **Done check:** typing in the address bar filters by URL and title; the list is capped and rotates.
- **Effort:** 1 day · **Risk:** low · **Depends:** —

### 5.5 Configurable log levels

- **Status:** `TODO`
- **Evidence:** Studio logs to the Electron console with no verbosity setting.
- **Change:** a `logLevel` setting (debug / verbose / off) gating console output, plus the crash log from 1.5.
- **Done check:** setting `off` silences console output; `debug` emits request lifecycle lines.
- **Effort:** 4 h · **Risk:** low · **Depends:** 1.5

### 5.6 Context-window visualizer

- **Status:** `TODO`
- **Evidence:** the Context bar shows an estimated token count and last reduction, but not which messages
  are in the window versus compressed away.
- **Change:** a "context contents" expander in the Context bar listing messages as verbatim vs
  memory-compressed, with per-message estimated contribution.
- **Done check:** the expander matches the actual working context on a compaction-triggered run.
- **Effort:** 1–2 days · **Risk:** low · **Depends:** —

### 5.7 Parity for non-Windows telemetry

- **Status:** `TODO`
- **Evidence:** README: "macOS and Linux have CPU, RAM and process readings; GPU, network and disk
  counters remain Windows-only." `agent/telemetry-windows.ps1` is the only collector script.
- **Change:** add `telemetry-macos.sh` / `telemetry-linux.sh` collectors (GPU via `system_profiler` /
  `nvidia-smi`; network via `netstat` / `/proc/net/dev`; disk via `iostat` / `diskutil`). The existing
  rule "missing counters display as unavailable rather than zero" makes partial data safe to ship.
- **Done check:** on macOS and Linux the dashboard shows network/disk rates or an explicit unavailable label.
- **Effort:** 2–3 days · **Risk:** medium (platform variance) · **Depends:** —

### 5.8 Network inspector (developer toggle)

- **Status:** `TODO` · **Priority:** low
- **Evidence:** Studio→endpoint traffic is only visible through provider errors.
- **Change:** a developer toggle recording the last N request/response pairs (headers + first/last chunk,
  bodies redacted) to `userData/dev-net.jsonl` with a viewer page.
- **Done check:** toggle on → run a chat → the viewer lists the exchange with the key redacted.
- **Effort:** 2 days · **Risk:** medium (must not leak keys) · **Depends:** 2.1

---

## 9. Phase 6 — Features & developer experience

| ID | Item | Evidence / why | Done check | Effort |
| --- | --- | --- | --- | --- |
| 6.1 | Command palette (`Ctrl/Cmd+K`) | The SimpleRAG panel got one; Studio has none — tab/project/settings switching is all menu clicks. Most actions already exist as renderer functions | Palette dispatches over the existing IPC surface | 1–2 days |
| 6.2 | Find-in-project panel | Agents get `search` (grep) as a tool; the human UI has no cross-file find | Results click-to-open with line jump in CodeMirror | 1–2 days |
| 6.3 | Minimal git surface | The app edits files but shows no diff and can't commit. `agent/diff.cjs` already exists as a diff engine | Modified/added list + diff view + commit with message via `runCommand` | 2–3 days |
| 6.4 | Restore last session on launch | `projects.json` remembers the project list, but not open files or the active conversation | `session.json` (active project, conversation, open tabs + scroll) restored on launch | 1 day |
| 6.5 | Search across conversations | Conversations are browsable but not searchable | "Find in chats" box over message content + activity | 1 day (trivial after 4.1) |
| 6.6 | Saved prompts / templates | Every chat starts from an empty composer | `templates.json` + "New from template" pre-filling composer and budget preset | 1 day |
| 6.7 | Local model chat (Ollama / LM Studio) | The connection layer is already OpenAI-compatible; telemetry sources are explicitly read-only inventory | Add `http://127.0.0.1:11434/v1` as a connection + a "local model" badge and sane small-model budgets | 2 days |
| 6.8 | Model comparison view | The playground runs one connection per run | Same prompt to N connections, N columns with per-column latency + estimated tokens | 2–3 days |
| 6.9 | Split editors / multiple windows | Single `BrowserWindow`; one active file at a time | Phase 1 split-view of the two most recent files; phase 2 a window per project | 3–5 days |
| 6.10 | Keyboard-shortcut customization | Shortcuts are hardcoded (`Ctrl/Cmd+L/F/T/W`, `Cmd+Enter`, rail `Cmd/Ctrl+1-6`) | Settings shortcut map with collision detection, defaults = current bindings | 2 days |
| 6.11 | Theme extensibility | Two themes on CSS variables; no user theme path | "Import theme" mapping a small variable set with live preview | 1–2 days |
| 6.12 | Team activity timeline | Individual activity is tracked; no unified team view | Combined timeline card in the conversation | 1 day |

---

## 10. Phase 7 — Documentation & onboarding

### 7.1 Root README as an index, not a novel

- **Status:** `TODO` · **Evidence:** root `README.md` (614 lines) covers relay, tray, VS Code and Docker,
  and barely points at `studio/`. A contributor asking "how do I build the desktop app" reads a relay README.
- **Change:** a short root section ("This repo ships 4 products…") with one-paragraph pointers; keep deep
  docs in per-product READMEs (`studio/README.md` is already good).
- **Done check:** a new contributor can reach the studio build steps in two clicks from the root README.
- **Effort:** 2 h · **Risk:** low

### 7.2 Generate `docs/STUDIO_IPC.md` from the manifest

- **Status:** `TODO` · **Evidence:** `preload.cjs` is the de-facto API contract; nothing lists it.
- **Change:** generate the doc from 3.3's manifest — free once the manifest exists.
- **Done check:** the doc lists all 74 channels with owners and argument shapes.
- **Effort:** 2 h (after 3.3) · **Risk:** low

### 7.3 `studio/CONTRIBUTING.md`

- **Status:** `TODO` · **Evidence:** `studio/README.md` documents running/building for users; "how do I
  add a tool / a page / an IPC handler" lives only in code comments.
- **Change:** document the three extension points (tool registry, page modules, IPC manifest), the test
  commands, and the phase conventions from §0.
- **Done check:** a first-time dev runs `npm ci && npm test` in under 5 minutes following the doc alone.
- **Effort:** 3 h · **Risk:** low · **Depends:** 1.1, 3.3

### 7.4 Relay endpoint documentation

- **Status:** `TODO` · **Evidence:** endpoints are undocumented beyond the README table.
- **Change:** an OpenAPI spec or `docs/endpoints.md` with request/response examples.
- **Done check:** every route in `server/reachd/handler.py` appears in the doc.
- **Effort:** 1 day · **Risk:** low

---

## 11. Sequencing, parallelism and the critical path

**Recommended order:**

1. **Phase 0 (0.1–0.3)** — < 3 h total. Nothing else is safe until the tree is clean.
2. **Phase 1 in parallel** — 1.1 and 1.4 and 1.8 are independent; 1.5/1.6 pair naturally; 1.7 is standalone.
   Two workers can run these without touching the same files.
3. **Phase 2** — do **1.6 before 2.1/2.4/2.5** (they all need `atomicWriteJson`).
   2.2 and 2.6 are independent and can run alongside.
4. **Phase 3** — strictly sequential within itself: **3.1 → 3.3 → 3.2**, then 3.5.
   This is the critical path; parallelizing it produces merge conflicts by construction.
5. **Phase 4** — 4.4 and 4.5 can start during Phase 3 (different files); 4.1/4.2/4.3 wait for 3.1.
6. **Phase 5–7** — as demand shows. 6.7 (local models) and 5.2 (auto-update) have the best effort-to-value.

**File-collision map** (two workers editing the same file in parallel = pain):

| File | Items that touch it | Rule |
| --- | --- | --- |
| `studio/main.mjs` | 1.5, 1.6, 2.1, 3.1, 3.3, 5.3 | One worker at a time until 3.1 lands |
| `studio/preload.cjs` | 3.3, 4.4 | Serialize |
| `studio/package.json` | 0.2, 1.1, 1.2, 1.3, 1.8 | Batch all script/version edits into one PR |
| `studio/agent/agent-store.cjs` | 2.5, 4.1, 4.4 | Serialize — 4.1 supersedes 2.5's shape |
| `studio/agent/connections.cjs` | 2.7, 4.7 | Can batch |
| `.github/workflows/ci.yml` | 0.3, 1.2, 1.3 | Batch into one CI PR |

---

## 12. Definition of Ready / Done

**Ready to start when:** the item's Evidence command reproduces on your branch, its dependencies are
`DONE`, and no other active worker is in the same file (see the collision map).

**Done when:** all of the following hold.

1. The **Done check** field is demonstrated (command output or screenshot in the PR).
2. `npm test` and — for anything touching the renderer or main — `npm run smoke` are green.
3. New behavior has a test in `studio/test/*.test.cjs` that fails without the change.
4. This document is updated: status flipped, Evidence line corrected if reality moved.
5. The PR is one item, Conventional-Commits titled, with the item ID in the scope.

---

## 13. Appendix A — Command cookbook

```bash
# Baseline metrics (regenerate §1)
wc -l studio/main.mjs studio/renderer/app.js
ls studio/test/*.test.cjs | wc -l
grep -c "ipcMain.handle" studio/main.mjs        # 75 matches, 74 handlers
node -p "require('./studio/package.json').version"
node -p "Object.keys(require('./release-please-config.json').packages)"
git status --porcelain | wc -l

# Evidence spot-checks
grep -n unsafe-inline studio/renderer/index.html
grep -rn "uncaughtException\|unhandledRejection" studio/
grep -n "dist:win" .github/workflows/ci.yml
grep -n "writeFileSync" studio/main.mjs | head
grep -rn "function resolveEndpoint\|resolveEndpoint =" studio/

# Verify
cd studio && npm ci && npm run check && npm test && npm run smoke
```

## 14. Appendix B — Where the code lives

| Concern | Path |
| --- | --- |
| Main process + all IPC handlers | `studio/main.mjs` (3,481) |
| Preload bridge (78 invoke channels) | `studio/preload.cjs` (178) |
| Renderer | `studio/renderer/` (18 JS modules; `app.js` is 2,714) |
| Agent runtime | `studio/agent/` (44 modules; `code-index.cjs` ~1,144, `team-runner.cjs` ~744, `agent-loop.cjs` ~557) |
| Browser automation | `studio/browser/{agent,host,page,smoke}.cjs` |
| Tests | `studio/test/*.test.cjs` (28 files) |
| Syntax gate | `studio/scripts/check-syntax.cjs` |
| Relay | `server/reachd/` (already modularized — the precedent) |
| VS Code panel | `src/` |
| Copilot shim + tray | `copilot/` |
| CI | `.github/workflows/ci.yml` (uses `list`, not `glob`, to inspect) |

## 15. Appendix C — Re-verification script

Save as `docs/verify-improvements.sh` and run before trusting any Evidence line:

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
check() { printf '%-42s' "$1"; shift; "$@"; }
echo "=== Baseline ==="
check 'main.mjs lines'    bash -c 'wc -l < studio/main.mjs'
check 'app.js lines'      bash -c 'wc -l < studio/renderer/app.js'
check 'ipc handlers'      bash -c 'grep -c "ipcMain.handle" studio/main.mjs'
check 'preload channels'  bash -c 'grep -c ipcRenderer.invoke studio/preload.cjs'
check 'test files'        bash -c 'ls studio/test/*.test.cjs | wc -l'
check 'studio version'    node -p "require('./studio/package.json').version"
check 'dirty files'       bash -c 'git status --porcelain | wc -l'
echo "=== Guards ==="
check 'csp unsafe-inline' bash -c 'grep -c unsafe-inline studio/renderer/index.html || true'
check 'crash handlers'    bash -c 'grep -rc "uncaughtException" studio/ | grep -v ":0" || echo none'
check 'windows dist'      bash -c 'grep -c "dist:win" .github/workflows/ci.yml || echo 0'
```

---

*End of plan. Keep this file honest: if a number in §1 stops matching reality, fix it in the same PR
that changed it.*
