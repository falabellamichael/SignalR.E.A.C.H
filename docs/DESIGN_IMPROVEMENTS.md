# REACH Studio — Implementation Design & Verified Status

**Author:** Seeker (Architect) · **Source of truth for scope:** `docs/IMPROVEMENTS.md`
**Re-verification:** `bash docs/verify-improvements.sh` (every number below came from a run of this)

This file does three things `IMPROVEMENTS.md` does not:

1. **A verified status matrix** — what is actually landed vs. claimed. It corrects reality.
2. **The interfaces** each remaining item must honor, so two workers cannot build
   against different pictures.
3. **Ownership + collision resolution** so parallel workers stop editing the same files.

---

## 1. Verified status matrix (measured, not inherited)

Legend: `DONE` verified by command · `PARTIAL` half-landed · `TODO` absent · `!` correction

### Corrections to the baseline in `IMPROVEMENTS.md §1`

The document has rotted exactly as its own working agreement warns. Anchors moved:

| Metric | §1 claims | **Measured now** | Drift |
| --- | --- | --- | --- |
| `studio/main.mjs` | 3,481 | **3,636** | +155 |
| `studio/renderer/app.js` | 2,714 | **2,949** | +235 |
| `ipcMain.handle` grep hits | 75 (74 registered) | **77** (74 + `agents:export` + `agents:import`) | +3 |
| `preload.cjs` invoke channels | 78 | **80** | +2 |
| Studio test files | 28 | **30** | +2 |
| `engines.node` | `>=22.12.0` | **`>=24`** | 1.8 landed |
| `release-please` packages | 1 (`"."`) | **`[".", "studio"]`** | 0.2 landed |
| Dirty files | 11 | **30** | grew |

> **! Correction to `IMPROVEMENTS.md §2`.** §2 states "`resolveEndpoint` is referenced from the
> **agent/connections layer**" and tells 3.7/4.7 to test it *there*. **That is false.**
> `resolveEndpoint` is defined at **`studio/main.mjs:281`** (`async function resolveEndpoint(raw, depth = 0)`).
> `agent/connections.cjs:71` only *documents* that it owns pointer rewriting. **4.7 must be
> tested in `main.mjs`** — and it is therefore blocked behind 3.1, not independent. Anyone who
> followed §2 would have written a test against a function that does not live there.

### Phase 0 — Unblock

| ID | Status | Evidence |
| --- | --- | --- |
| 0.1 Land/stash dirty tree | **`TODO` — NOT done** | `git status --porcelain \| wc -l` → **30**. 19 modified + 11 untracked. |
| 0.2 Studio in release-please | `DONE` | `Object.keys(config.packages)` → `[".", "studio"]`; `studio/CHANGELOG.md` seeded. |
| 0.3 Windows installers in CI | `TODO` | `grep dist:win .github/workflows/ci.yml` → 0 matches. `dist:win` exists in `package.json`. |

> **! 0.1 is the blocking item and two crew members recorded it as done.** Nothing else is
> reviewable until it lands. See §4 for the exact disposition — the 11 untracked files are
> *this task's own deliverables*, so "stash everything" would delete the work.

### Phase 1 — Quick wins

| ID | Status | Evidence |
| --- | --- | --- |
| 1.1 Test discovery | `TODO` | `scripts.test` is still the 30-file `&&` chain; `grep "test/\*\*"` → 0. |
| 1.2 ESLint flat config | `TODO` | no `eslint.config.*` / `.eslintrc*` / `.prettierrc*`. |
| 1.3 Coverage baseline | `TODO` | no `test:coverage` script. |
| 1.4 Clean stray artifacts | `PARTIAL` | root `.gitignore` now covers `.reach/`, `.venv/`, `*.vsix`, `*.dmg`. Still tracked: `tests/browser_preview.py`, `tools/_probe_all_models.py`, `tools/_probe_send.js`, `tools/_probe_slash.js`, `tools/_probe_stream_read.py`. |
| 1.5 Crash handlers | **`DONE`** | `main.mjs:117-118` — `uncaughtException` + `unhandledRejection` → `appendCrashLog`. |
| 1.6 Atomic writes | **`DONE`** | `agent/atomic-write.cjs` exports `atomicWriteJson`/`atomicWriteText`; `main.mjs:187,196` use it for settings + projects. |
| 1.7 Drop `'unsafe-inline'` | **`DONE`** | `index.html:5` → `script-src 'self'`; inline script moved to `renderer/boot.js`. |
| 1.8 Pin Node | `PARTIAL` | `engines.node` → `>=24`, `studio/.nvmrc` → `24`. **Not done:** `install.sh` / `install.ps1` preflight not updated; `IMPROVEMENTS.md §1` still claims `>=22.12.0`. |

### Phase 2 — Security & data integrity

| ID | Status | Evidence |
| --- | --- | --- |
| 2.1 Encrypt keys at rest | `TODO` | no `safeStorage` in any source file (only Electron binary matches). |
| 2.2 Copilot shim token | **`DONE`** | `copilot_shim.py:84` `os.chmod(TOKEN_PATH, 0o600)` + `:44` loud warning. |
| 2.3 IPC validation audit | `PARTIAL` | `docs/STUDIO_IPC.md` exists (226 lines) with a validation column. Its counts are **stale** (says 74/75; now 76 registered/80 preload) and it predates `agents:export`/`agents:import`. |
| 2.4 Bound the audit log | `TODO` | `audit-log.cjs` has `verify()` but **no rotation**, no size cap. |
| 2.5 Conversation size cap | `TODO` | `MAX_AGENTS=200`, `MAX_STORED_MESSAGES=400` only; no serialized-byte cap, no `.history.jsonl` archive. |
| 2.6 Untrusted tool output | `TODO` | no delimiter/`untrusted` marker in `context.cjs` / `agent-loop.cjs`. |
| 2.7 Rate-limit outbound | `TODO` | no gate in `connections.cjs`. |

### Phase 3 — Architecture

| ID | Status | Evidence |
| --- | --- | --- |
| 3.1 Split `main.mjs` | `TODO` | `studio/ipc/` does not exist. Now **3,636** lines — worse than baseline. |
| 3.2 Split `renderer/app.js` | `TODO` | still flat; now **2,949** lines. |
| 3.3 IPC manifest | `TODO` | `studio/ipc-manifest.json` absent. |
| 3.4 TypeScript IPC contracts | `TODO` (blocked by 3.1+3.3 by design) | — |
| 3.5 Single owner for code index | `TODO` | TTL + invalidation still live in **`code-context.cjs`** (`INDEX_TTL_MS`, `getIndex`, `invalidateIndex`, `invalidateForFile`), not `code-index.cjs`. |

### Phase 4–7

| ID | Status | Evidence |
| --- | --- | --- |
| 4.1 Per-conversation storage | `TODO` | still one `agents.json` written wholesale. |
| 4.2 Persist team runs | `TODO` | no `teams/` writes in `team-runner.cjs`. |
| 4.3 Capture failed members | `TODO` | — |
| 4.4 Export / import | **`DONE`** | `main.mjs:425,439` + `preload.cjs:55,56` + `AgentStore.importConversation` (whitelists fields, mints a fresh id) + `test/export-import.test.cjs`. |
| 4.5 Approval notifications | `TODO` | no `new Notification` in `main.mjs`. |
| 4.6 Budget telemetry | `TODO` | no `budgets.jsonl`. |
| 4.7 Test `resolveEndpoint` | `TODO` | lives at `main.mjs:281` — see the §1 correction; blocked by 3.1. |
| 4.8 Integration-test gaps | `TODO` | — |
| 5.1–5.8 | `TODO` | mac notarization, auto-update, `schemaVersion`, browser history search, `logLevel`, context visualizer, non-Windows telemetry (`telemetry-windows.ps1` is still the only collector), network inspector. |
| 6.1–6.12 | `TODO` | command palette, find-in-project, git surface, session restore, chat search, templates, local models, model comparison, split editors, shortcut map, themes, team timeline. |
| 7.1–7.4 | `PARTIAL` | 7.2 has `docs/STUDIO_IPC.md` (needs regenerating against 3.3's manifest once it exists). 7.1/7.3/7.4 absent. |

**Net:** 6 items `DONE` (0.2, 1.5, 1.6, 1.7, 2.2, 4.4), 4 `PARTIAL` (1.4, 1.8, 2.3, 7.2),
1 blocking `TODO` (0.1), and ~40 genuinely open.

---

## 2. Interfaces the remaining work must honor

These are frozen. If reality contradicts one, **amend this section first and tell the
crew** — two members building against different pictures is how a crew ships a broken whole.

### I1 · `atomicWriteJson(file, value)` / `atomicWriteText(file, text)` — `agent/atomic-write.cjs`
- Contract: same directory, sibling `.tmp`, `fs.renameSync` over the target. Parent dirs created.
- **Invariant A1:** after a successful call no `*.tmp` survives; the target is either the old
  contents or the new contents, never a partial write.
- **Check:** `test/atomic-write.test.cjs` (exists, 3 tests) — extend it with the truncation case.
- All new persistence (2.4, 2.5, 4.1, 4.2, 4.6, 5.3) goes through this. **Never** a bare
  `fs.writeFileSync` on a user-data JSON file.

### I2 · `AuditLog` rotation (item 2.4) — `agent/audit-log.cjs`
- **Add:** `rotate({ maxBytes = 5 * 1024 * 1024, keep = 3 } = {})` → rotates only when the
  file exceeds `maxBytes`; archives to `<file>.<n>`, newest `.1`.
- **First record of the new file is a link record:** `seq` continues (no reset),
  `prev` = the archived file's tip hash, and `carry` = that same hash.
- **Invariant A2 (backward compatibility):** `canonical()` must hash `v: record.v`, **not** the
  module constant. Old records carry `v: 1`; new ones `v: 2`. Changing the constant in the
  hash preimage would invalidate every existing log. This is the one edit that can silently
  destroy history — do not "tidy" it.
- **Invariant A3:** a link record is a legal chain start. `verify()` treats a first record
  with `carry === prev` as anchored, so a rotated file verifies standalone; a file with no
  `carry` still anchors at `GENESIS` exactly as today.
- **Failure modes:** rotation under a crash leaves both files (never a lost chain); a
  hand-edited line must still fail with the correct 0-based index.
- **Check:** four tests — rotate-then-verify ok; verify rejects an edited line at the right
  index; a legacy `v:1` log still verifies after the upgrade; rotation is a no-op below the cap.

### I3 · Per-conversation byte cap (item 2.5) — `agent/agent-store.cjs`
- **Add:** `MAX_CONVERSATION_BYTES` cap enforced in `_save()`; overflow archives the oldest
  messages to `agents/<id>.history.jsonl` **append-only**.
- **Invariant A4 — archive, never delete.** Trimmed messages must be readable back from the
  archive. This is the only acceptable direction of loss.
- **Check:** a conversation forced to 10 MB stays under cap on save; its archive replays.

### I4 · IPC manifest (item 3.3) — `studio/ipc-manifest.json`
- **Shape:** `{ "<channel>": { "module": "<owning ipc/*.cjs>", "args": [...], "returns": "..." } }`
- **Add:** a test asserting `set(preload channels) === set(manifest keys) === set(registered handlers)`
  **in both directions** — a channel in one set and not another fails with a diff.
- **Invariant A5:** `browser:command` is **dynamic** — registered by `browser/host.cjs` on tab
  creation and removed on `destroyed`. The test must whitelist it explicitly rather than loosen
  the equality.
- **Check:** deleting a handler while leaving the preload method fails `npm test` with the
  two sets printed.

### I5 · Build order (unchanged from §11, now with owners)
`0.1 → (0.3 ∥ 1.1–1.4 ∥ 1.8-finish) → 1.6-based 2.x → 3.1 → 3.3 → 3.2 → 3.5 → 4.x → 5–7`

### I6 · `resolveEndpoint` (item 4.7)
- **Definition site: `studio/main.mjs:281`.** Four tests needed there: redirect-loop
  detection, credential rejection, `.txt`/`/v1` normalization, HTTP-failure propagation.
- Because it lives in `main.mjs`, it is **blocked by 3.1**, not independent. `IMPROVEMENTS.md §2`
  says otherwise; it is wrong.

---

## 3. Ownership (no two workers in one file)

| Owner | Items | Files |
| --- | --- | --- |
| **Thinker** | 0.3, 1.1, 1.2, 1.3, 1.4 | `.github/workflows/ci.yml`, `studio/package.json`, new `eslint.config.mjs`, `tools/_probe_*`, `tests/browser_preview.py` |
| **Builder** | 0.1, 2.1, 4.5, 4.6 | `studio/main.mjs`, `studio/preload.cjs`, `studio/agent/connections.cjs` |
| **Seeker** (me) | 2.4, 2.5, 3.3-design, 3.5 | `studio/agent/audit-log.cjs`, `studio/agent/agent-store.cjs`, `studio/agent/code-{index,context}.cjs` |

**Resolved collisions:** both Thinker and Builder reached for `ci.yml` and `package.json`,
and both reached for `audit-log.cjs`. Per the §11 collision map, `package.json` batches all
script/version edits into **one** PR → **Thinker only**. `main.mjs` is single-writer until 3.1
lands → **Builder only**. `audit-log.cjs` → **Seeker only**.

---

## 4. Item 0.1 — exact disposition (do not "stash everything")

`git status` splits into three genuinely different buckets. Deleting or blanket-stashing
bucket C destroys this task's own output:

- **A. Tracked modifications that ARE the improvements (19):** `main.mjs`, `preload.cjs`,
  `agent/*.cjs`, `renderer/*`, `scripts/check-syntax.cjs`, `test/*`, `.gitignore`,
  `release-please-config.json`, `copilot/copilot_shim.py`, `vscode/context.js`.
  → **Commit** as `feat(studio): land IMPROVEMENTS 1.5-1.8, 2.2, 4.4`.
- **B. Unrelated pre-existing drift:** `vscode/context.js` (untouched by this plan).
  → **Commit separately** or revert; do not bury it in the studio commit.
- **C. Untracked deliverables (11):** `docs/IMPROVEMENTS*.md`, `docs/STUDIO_IPC.md`,
  `docs/verify-improvements.sh`, `docs/DESIGN_IMPROVEMENTS.md`, `studio/.nvmrc`,
  `studio/CHANGELOG.md`, `studio/agent/atomic-write.cjs`, `studio/renderer/boot.js`,
  `studio/test/atomic-write.test.cjs`, `studio/test/export-import.test.cjs`.
  → **Commit** as `docs(studio): add improvement plan, verification script and design`.
- **D. Genuinely disposable (`git rm --cached`, item 1.4):** `tests/browser_preview.py`,
  `tools/_probe_all_models.py`, `tools/_probe_send.js`, `tools/_probe_slash.js`,
  `tools/_probe_stream_read.py`.

**Done check:** `git status --porcelain` prints nothing once A/B/C are committed and D untracked.

---

## 5. Invariant → check (for the verifier)

| # | Invariant | One check |
| --- | --- | --- |
| A1 | Atomic writes leave no partial file or `.tmp` | `atomic-write.test.cjs` truncation case |
| A2 | Audit hashes keep `record.v`, never the constant | legacy `v:1` fixture still `verify().ok` |
| A3 | Rotation preserves the chain across files | rotate → `verify()` ok; edit a line → fails at correct index |
| A4 | Conversation trimming archives, never deletes | archive replays trimmed messages |
| A5 | Channel sets agree in both directions | delete a handler → `npm test` prints the set diff |
| A6 | `resolveEndpoint` guards hold **in `main.mjs`** | 4 tests, each red before its guard |
| A7 | Tree is clean | `git status --porcelain \| wc -l` → 0 |
| A8 | `npm test` fully green | `cd studio && npm test` (409 tests at time of writing) |
