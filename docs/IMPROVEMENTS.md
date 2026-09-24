# REACH Studio — Improvement Plan & Status

> **Canonical.** This is the single improvement plan for this repository. Exactly one
> document states plan numbers — this one. If a number stops matching the tree, fix it in
> the same change that moved the number; five earlier documents rotted precisely because
> nobody did.
>
> **Consolidated from:** `docs/IMPROVEMENTS_VERIFIED.md` (phased detail, frozen interfaces,
> invariants), `docs/STUDIO_IMPROVEMENTS.md` (re-measured digest + new findings A1–A4, N2–N3),
> `docs/archive/IMPROVEMENTS.md`, `docs/archive/DESIGN_IMPROVEMENTS.md`,
> `docs/archive/IMPROVEMENTS_REVIEW.md`, `docs/archive/IMPROVEMENTS_PRIORITIZATION.md`,
> `PROJECT_SUMMARY.md`. The first two were moved into `docs/archive/` on 2026-09-22.
> **Last measured:** the **BASELINE** block below is GENERATED from the working tree by
> `node tools/check-plan-baseline.cjs` (item 6.10) and CI fails if it drifts, so it is always
> current. The human-readable snapshot is `bash docs/verify-improvements.sh`. The
> date-stamped prose below is historical: where it disagrees with the BASELINE block,
> the BASELINE block wins.

---

## Executive Summary

SignalR.E.A.C.H is a monorepo with four runtime surfaces — a Python relay server, a SimpleRAG plugin panel, a VS Code extension + desktop tray, and the REACH Studio Electron desktop app. The improvement plan below tracks **correctness, security, architecture, features, reliability, distribution, and cross-surface debt** across all surfaces.

### Status at a Glance

| Status | Count | What it means |
|--------|-------|---------------|
| **DONE** | 25 | Implemented, tested, verified in working tree |
| **PARTIAL** | 13 | Partially implemented; evidence or tests remain |
| **TODO** | 26 | Not yet started; ordered by dependency and priority |

> Counts are generated, not hand-written: `node tools/count-plan-status.cjs`
> (64 item rows: 25 DONE / 13 PARTIAL / 26 TODO). Re-run it after flipping a status.

### Top 10 Highest-Impact Remaining Items

1. **Split `main.mjs`** (4,145 lines, 88 static handlers — see BASELINE) into domain modules
2. **Split `renderer/app.js`** (4,628 lines — see BASELINE) into concern-based modules
3. **IPC manifest: runtime return-shape validation** — channel set is machine-checked (89 entries); argument/return shapes are still documentation (item 2.3, finding N2)
4. **Audit every IPC handler** for input validation gaps (7 documented)
5. **Ship Windows installers** from CI fully
6. **Per-conversation storage** and durable team recovery (the README's top UX complaint)
7. **Document the Node version floor and test matrix consistently** (item 1.9)
8. **macOS notarization** (item 5.7; requires Apple Developer ID credentials)
9. **Finish extracting `agent-loop.cjs` into testable modules** (item 3.3)
10. **Verify OS delivery for approval notifications** (item 2.9)

---

## Phase 0 — Process & Hygiene (Do First)

| # | Item | Status | Owner | Effort |
|---|------|--------|-------|--------|
| 0.1 | Clean the working tree — commit improvements, stash drift | DONE | Any | 15 min |
| 0.2 | Add Studio to release-please | DONE | — | 1 h |
| 0.3 | Ship Windows installers from CI | PARTIAL | CI | 45 min |
| 0.4 | Pin Node version consistently (`.nvmrc`, `engines`, install scripts) | PARTIAL | — | 45 min |

**Why first:** A dirty tree makes every PR unreviewable; without Windows CI the platform gap grows.

---

## Phase 1 — Quick Wins (High Signal, Low Risk)

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1.1 | Convert `npm test` from `&&` chain to `node --test "test/**/*.test.cjs"` | DONE | Test discovery runs all files; adding new `*.test.cjs` needs no `package.json` edit |
| 1.2 | Add ESLint (flat config, warning-only first) | PARTIAL | No lint config existed; baseline clean-up needed |
| 1.3 | Add coverage baseline (`--experimental-test-coverage`) | DONE | `npm run test:coverage` wired; suite excludes Electron UI harnesses (`*-ui.cjs`) |
| 1.4 | Clean stray tracked artifacts (debug HTML, probe scripts, `.vsix` files) | PARTIAL | Probe scripts still committed; stray `.vsix` files gitignored but present in tree |
| 1.5 | Add main-process crash handlers | DONE | `uncaughtException` + `unhandledRejection` → `crash.log` |
| 1.6 | Atomic writes for settings and projects | DONE | `agent/atomic-write.cjs`; used for settings + projects |
| 1.7 | Drop `'unsafe-inline'` from CSP `script-src` | DONE | Inline script moved to `boot.js`; CSP uses `'self'` only |
| 1.8 | Pin Node 24 LTS consistently | PARTIAL | `engines.node: >=24` and `.nvmrc: 24` set; install scripts not updated |
| 1.9 | Documented Node version vs tested Node version (finding N3) | TODO | `.nvmrc`=24, `engines.node`=`>=24`, README says 24 LTS, yet the suite also passes on Node 22 runners. Decide the real floor and make CI assert it |

---

## Phase 2 — Security & Data Integrity

| # | Item | Status | Evidence / Notes |
|---|------|--------|-----------------|
| 2.1 | **Encrypt API keys at rest** (`safeStorage`) | DONE | Settings store encrypts keys; OS vault used; explicit fallback warning when unavailable |
| 2.2 | Protect Copilot shim token | DONE | `chmod 0600` + loud warning on world-readable load |
| 2.3 | **IPC manifest + set-equality test** | PARTIAL | All 89 channels have owner/signature metadata; bidirectional set tests pass (`preload` == `manifest` == `handlers`, delta exactly the dynamic `browser:command`). Return-shape validation (finding N2) and full domain extraction remain |
| 2.4 | **Audit every IPC handler** for input validation | PARTIAL | 7 open gaps documented (`agents:setTodos`, `files:write` size, `project:create` path, …) |
| 2.5 | Guard `browser:command` dynamic channel | DONE | Preload returns `{ok:false, err}` when no tab; regression tests cover missing handler |
| 2.6 | **Per-conversation size limits** (archive, never delete) | DONE | `budgets.storedMessages` is enforced by `AgentStore.appendMessage`; an 8 MiB serialized cap archives excess messages to append-only `userData/agents/<id>.history.jsonl`, which is replayed by `readArchive`. Guard: `studio/test/conversation-cap.test.cjs`. |
| 2.7 | Treat tool/file output as untrusted data | DONE | Escaped delimiters around tool/source data; forged approval fixture cannot bypass edit review |
| 2.8 | **Rate-limit outbound agent requests** | DONE | `agent/rate-limit.cjs`: one adaptive token-bucket pace per provider ORIGIN, shared by every `AgentLoop` (single chat, team members, spawned workers), so a 14-agent crew cannot burst a provider into 429s. A 429/`Retry-After` becomes an absolute deadline every waiter shares (one window, not one per waiter) and engages a pace that tightens toward `requestPacingRpm` (floor 6, first limit 4×); the pace releases only after `recoverMs` quiet **and** 3 successes after that window. Happy path is free — `acquire()` resolves immediately while unpaced, so a crew that never sees a 429 pays nothing. `agent-loop.cjs` retries a rate limit (bounded, `RATE_LIMIT_RETRIES`) instead of throwing; a `rate-limit` activity step + one deduped transcript line render it as *waiting*, never as failure. New: `test/rate-limit.test.cjs` (20 tests). **Preserved contract:** a bare `503` stays a HARD failure so the Nurse still quarantines a dead provider route (`test/agent.test.cjs` links-hard-provider case; guard asserted in the new suite); `503` *with* `Retry-After` is a load shedder and is paced. Off switch `requestPacing` removes the app-imposed rate only — a provider `Retry-After` is still honored. Both are global-only fields, enforced in `resolveBudgets`, not just hidden in the UI |
| 2.9 | Approval notifications | PARTIAL | Background notifications, beep, Dock badge, click-to-focus, burst coalescing; OS delivery needs manual verification |

---

## Phase 3 — Architecture (Big Refactors)

| # | Item | Status | Impact |
|---|------|--------|--------|
| 3.1 | **Split `main.mjs`** (4,145 lines → domain modules, see BASELINE) | PARTIAL | Settings, endpoint, notifications extracted to independent modules; IPC/bootstrap/smoke extraction remains |
| 3.2 | **Split `renderer/app.js`** (4,628 lines, see BASELINE) | TODO | Mixed chat, drawer, tree, composer, persona/crew logic — now the single largest file in Studio |
| 3.3 | Extract `agent-loop.cjs` into smaller testable modules | PARTIAL | Many sub-modules exist; full loop still monolithic |
| 3.4 | IPC TypeScript contracts (or equivalent runtime schema) | TODO | Stringly-typed IPC is the #0 source of bugs; depends on 3.1 |
| 3.5 | Resolve code-index ownership (`code-context.cjs` → `code-index.cjs`) | DONE | Index cache, TTL and write invalidation are owned by `code-index.cjs`; context and tools consume its accessors. |

---

## Phase 4 — Features & UX

| # | Item | Status |
|---|------|--------|
| 4.1 | Conversation export/import (JSON/Markdown) | DONE |
| 4.2 | Conversation templates / saved prompts | TODO |
| 4.3 | Local/offline mode (Ollama/LM Studio) | TODO |
| 4.4 | Model comparison view | TODO |
| 4.5 | Keyboard shortcut customization | TODO |
| 4.6 | Theme extensibility / custom CSS | TODO |
| 4.7 | Browser panel history search | TODO |
| 4.8 | Network inspector (developer toggle) | TODO |
| 4.9 | VS Code contributor workflow (large-module split) | PARTIAL |
| 4.10 | Parse coverage (JS/CJS/MJS, all surfaces) | DONE | `studio/scripts/check-syntax.cjs` recursive; run it for the current count (it prints its own total) |
| 4.11 | Tray test entry point | DONE | `copilot/tray && npm test` |
| 4.12 | Persona Modal & Soul/Memory UI responsiveness | DONE | See evidence below |
| 4.13 | Command palette (`Ctrl/Cmd+K`) | TODO | The SimpleRAG panel has one; Studio has none. Most actions already exist as renderer functions |
| 4.14 | Find-in-project panel | TODO | Agents get `search` as a tool; the human UI has no cross-file find. Results click-to-open with line jump |
| 4.15 | Minimal git surface | TODO | The app edits files but shows no diff and cannot commit; `agent/diff.cjs` already exists as a diff engine |
| 4.16 | Restore last session on launch | TODO | `projects.json` remembers the project list, not open files or the active conversation |
| 4.17 | Search across conversations | TODO | Conversations are browsable but not searchable |
| 4.18 | Split editors / multiple windows | TODO | Single `BrowserWindow`; one active file at a time. Phase 1 split-view, phase 2 window per project |

**4.12 evidence (measured 2026-09-22, `npm run test:persona-ui`, PASS at 1440x900@1, 1000x640@1, 860x560@1, 1280x800@1.25):** the persona modal is a pinned frame — title and Delete/Cancel/Save stay put, only `.persona-modal-body` scrolls. Agent options sit side by side (Name|Connection, Model|Connection Policy) and the SOUL.md / MEMORY.md editors sit side by side in `.agent-files-grid` (`1fr 1fr`, `min-width: 0` on the editors, both pairs collapsing to one column under 640px). Before the fix the whole `.modal-box` scrolled, so at 1000x640 the Save button sat at y=616–649 in a 640px window and drifted out of reach. The test also proves Save still writes `SOUL.md` from the re-laid-out editor, and that nothing scrolls horizontally. Guard: `studio/test/persona-modal-ui.cjs`.

---

## Phase 5 — Reliability & Observability

| # | Item | Status |
|---|------|--------|
| 5.1 | Crew message persistence (WAL) | DONE | Atomic per-run JSONL journal records manifests, member turns, crew messages and nurse actions; crash recovery is covered by `studio/test/crew-journal.test.cjs`. |
| 5.2 | Configurable log levels | TODO |
| 5.3 | Context window visualizer | TODO |
| 5.4 | Automatic fallback model | TODO |
| 5.5 | Team activity timeline aggregation | TODO |
| 5.6 | Automatic update checker | TODO |
| 5.7 | macOS notarization | TODO (needs Apple Developer ID credentials) |
| 5.8 | Per-conversation storage (durable team recovery) | PARTIAL | Incomplete journals appear on the Teams page and partial results can be harvested; automatic re-entry of unfinished members remains. |

---

## Phase 6 — Distribution & Developer Experience

| # | Item | Status |
|---|------|--------|
| 6.1 | **CONTRIBUTING.md** guide | DONE | `studio/CONTRIBUTING.md`: tools, pages, IPC, persistence, testing, platform checks |
| 6.2 | **SECURITY.md** policy | DONE | Documents reporting, trust boundaries, credential fallback, backup handling |
| 6.3 | Product entry points in root README | DONE | Links Studio, relay/panel, extension, tray, contribution guide, security policy |
| 6.4 | Documentation consolidation | DONE (this change) | `docs/IMPROVEMENTS.md` is now the single canonical plan; the three other plan-like docs (`IMPROVEMENTS_VERIFIED.md`, `STUDIO_IMPROVEMENTS.md`, `IMPROVEMENTS_SUMMARY.md`) moved to `docs/archive/` with superseded banners; `docs/README.md` index fixed; `docs/engines/` cross-links repointed. Residual: the root `PROJECT_SUMMARY.md` still states its own numbers and is not in the one-file rule — regenerate or archive it with 6.10 |
| 6.5 | Dependabot: npm + pip | PARTIAL | npm added for Studio, VS Code, tray; no pip manifest exists; first update PR pending |
| 6.6 | Windows Store publishing | TODO |
| 6.7 | Flatpak bundle size optimization | TODO |
| 6.8 | API documentation for relay endpoints | TODO | Every route in `server/reachd/handler.py` must appear in the doc; a thinner router (7.1) makes this mechanical |
| 6.9 | Test coverage baseline + CI gate | DONE | CI checks coverage (`npm run test:coverage`) |
| 6.10 | Generate the plan's baseline instead of hand-copying it (finding A1) | DONE | `tools/check-plan-baseline.cjs` measures 10 metrics from the tree and generates the **BASELINE** block below; CI runs the checker (no `--write`), so drift fails the build. **Done check — verified by executing it, not by inspection:** appending one line to `studio/main.mjs` printed `plan says 4,115, tree has 4,117` and exited 1; restoring the file made it green again. The generator re-renders the committed block byte-for-byte, so a hand-edit is detected too. New: `studio/test/plan-baseline.test.cjs` (11 tests). `docs/verify-improvements.sh` remains as the human-readable snapshot; this is the machine-checked half |
| 6.11 | Complete or remove the two missing engine docs (finding A2) | TODO | `docs/engines/README.md` lists `STUDIO_BROWSER.md` and `REACH_CLI.md` as maintained; both are absent (engine docs 2/4). Either write them or drop the rows — a "maintained" label on a missing file is worse than no index |

---

## Phase 7 — Cross-Surface & Repo-Wide

These are outside `studio/` but the same class of problem. (Carried over from the old
`IMPROVEMENTS_VERIFIED.md` §5, renumbered 7.x — see the ID crosswalk at the bottom.)

### 7.1 `server/reachd/handler.py` — the relay's last God class — `TODO`

- **Evidence:** **1,228 lines** (measured 2026-09-22). `RelayHandler(BaseHTTPRequestHandler)` carries ~52 methods: HTTP plumbing, CORS, auth + lockout, rate-limit headers, all `do_*` routing, audit, key management, browser-engine proxying, settings, publish, diagnostics and chat proxying. The relay was modularized into 16 modules — but its dispatcher was not, so it is now the largest file in `server/` and the one place every concern still meets.
- **Change:** split `RelayHandler` into concern modules behind a thin router — the same treatment `REFACTOR_LATEST.md` already applied to the rest of the relay.
- **Done check:** `handler.py` under ~300 lines, routing only; the relay's test suite still passes.
- **Effort:** 1–2 weeks · **Risk:** high (mirror of 3.1) · **Depends:** —

### 7.2 Three browser engines coexist — `TODO`

- **Evidence:** `server/browser-engine/main.cjs` (Electron), `server/reachd/browser_engine.py`, `src/browser-engine.js` — plus Studio's own `studio/browser/{agent,host,page}.cjs`. Four implementations of one concept; a fix in one silently misses the others.
- **Change:** pick one engine per surface and make the others thin bridges, or share a single engine.
- **Done check:** one implementation of the frame/input/snapshot logic; the others forward to it.
- **Effort:** 1 week+ · **Risk:** high (cross-language) · **Depends:** —

### 7.3 VS Code extension: module boundary — `PARTIAL`

- **Evidence:** `vscode/media/chat.js` is **3,240 lines** and `vscode/extension.js` **2,894** (measured 2026-09-22) — still the largest JavaScript files in the repo. The local entry point now exists: `vscode/package.json` has `test` (`node ../tools/test-product.cjs vscode`) and `lint` (finding 5.3's first half is done); the `chat.js` split is not.
- **Change:** split `chat.js` the way Studio is splitting its renderer.
- **Done check:** `cd vscode && npm test` green; `chat.js` under ~800 lines.
- **Effort:** 3–5 days · **Risk:** medium · **Depends:** —

### 7.4 Root `tests/` mixes four products in one flat directory — `TODO`

- **Evidence:** 52 entries (measured 2026-09-22): Python relay tests, tray `*.test.cjs`, VS Code `vscode_*.test.cjs`, plus tool tests. Both runners execute against the whole pile.
- **Change:** split into `tests/reachd/`, `tests/vscode/`, `tests/tray/`, `tests/tools/` and update the two runners.
- **Done check:** each product's tests run from its own directory.
- **Effort:** half a day · **Risk:** low · **Depends:** 7.3

### 7.5 `src/reach.js` (1,244 lines) and flat page modules — `TODO`

- **Evidence:** `src/reach.js` = 1,244 lines (measured 2026-09-22); 9 `pages-*.js` peers loaded as flat classic scripts with no module boundaries beyond file separation.
- **Change:** apply the same concern-based split as 3.2, smaller blast radius first.
- **Done check:** `src/reach.js` under ~400 lines; pages are real modules.

---

## Dependency Graph

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4/5/6/7
  │            │            │            │
  ├─ Dirty tree cleanup
  ├─ Release-please config
  ├─ Windows CI
  └─ Node pin
        │
        ├─ Test discovery (1.1)
        ├─ Crash handlers (1.5)
        ├─ Atomic writes (1.6)
        ├─ CSP cleanup (1.7)
        └─ Coverage baseline (1.3)
             │
             ├─ Encrypt keys (2.1) [depends on 1.6]
             ├─ IPC manifest (2.3)
             ├─ IPC audit (2.4) [depends on 2.3]
             ├─ Per-conversation limits (2.6)
             └─ Rate-limit requests (2.8)
                  │
                  ├─ Split main.mjs (3.1)
                  ├─ Split renderer/app.js (3.2)
                  └─ TypeScript IPC (3.4) [depends on 3.1]
```

### Collision map — two workers in one file is how a crew ships a broken whole

| File | Items that touch it | Rule |
| --- | --- | --- |
| `studio/main.mjs` (4,145) | 2.3, 2.4, 3.1, 3.4, 2.6, 5.8 | **One writer until 3.1 lands** |
| `studio/renderer/app.js` (4,628) | 3.2, 4.12, 4.13–4.18 | Serialize behind 3.2 |
| `studio/preload.cjs` (199) | 2.3, 2.5 | One writer (manifest touches every channel) |
| `studio/agent/agent-store.cjs` | 2.6, 5.8 | Serialize — 5.8 supersedes 2.6's shape |
| `studio/agent/code-index.cjs` + `code-context.cjs` (1,157) | 3.5 | Single owner |
| `.github/workflows/ci.yml` | 0.3, 1.9, 6.9, 6.10 | Batch |
| `.github/dependabot.yml` | 6.5 | Batch |
| `docs/*.md` baseline prose | 6.4, 6.10, 6.11 | Land 6.10 **first**, then the prose edits become mechanical |

---

## Working Agreements

1. **One item per PR.** Use Conventional Commits with item ID in scope.
2. **Never leave the tree dirty.** Land or stash work; don't hand the next worker a dirty tree.
3. **Every behavior change needs a test** in `studio/test/*.test.cjs`; `npm test` must be green.
4. **Architecture items are land-only-with-tests.** A refactor PR that changes observable behavior must be two PRs.
5. **Update this file when you land an item** — flip status and fix the evidence line. This document rotting is the failure mode it was written to prevent.
6. **Do not mark an item `DONE` on a branch where `npm test` is red.**
7. **Do not add a second improvement plan.** Add items to this file.

---

<!-- BASELINE:START -->
| Metric | Value |
| --- | --- |
| `studio/main.mjs lines` | 4,464 |
| `studio/renderer/app.js lines` | 5,270 |
| `studio/preload.cjs lines` | 207 |
| `studio/agent modules` | 75 |
| `studio/renderer scripts` | 23 |
| `studio/test files` | 77 |
| `static IPC handlers` | 93 |
| `preload invoke channels` | 94 |
| `IPC manifest entries` | 94 |
| `SimpleRAG plugin files` | 21 |
<!-- BASELINE:END -->

## Verification

The **BASELINE** block above is generated and CI-gated (item 6.10) — read it, do not
memorise it. To re-measure it by hand, and to check what it guards:

```bash
# The generated numbers, and the check that keeps them true
node tools/check-plan-baseline.cjs            # verify (what CI runs)
node tools/check-plan-baseline.cjs --write    # regenerate after landing a change
node tools/count-plan-status.cjs              # the Status-at-a-Glance counts

# Full human-readable re-verification
bash docs/verify-improvements.sh

# Then the behavioural gates (these are the numbers that matter most)
cd studio && npm test                              # green is the requirement; count it, don't quote it
cd studio && npm run test:persona-ui               # → persona modal fits the window; SOUL.md/MEMORY.md side by side
(cd vscode && npm test)
(cd copilot/tray && npm test)
node tools/check-javascript.cjs
```

---

## Frozen Interfaces (if reality contradicts one, amend this section FIRST)

- **I1 · `atomicWriteJson(file, value)` / `atomicWriteText(file, text)`** — `agent/atomic-write.cjs`.
  Contract: same directory, sibling `.tmp`, `renameSync` over target, parent dirs created.
  **Invariant A1:** after success no `*.tmp` survives; the target is old or new, never partial.
  All new persistence (2.6, 5.1, 5.8) goes through this. **Never** a bare `fs.writeFileSync`
  on a user-data JSON file.
- **I2 · Audit record versioning** — `agent/audit-log.cjs`. **Invariant A2:** `canonical()` must hash
  `record.v`, **never** the module constant, or every existing log is invalidated. This is the one
  edit that can silently destroy history — do not "tidy" it.
- **I3 · Audit rotation chain** — **Invariant A3:** a rotated file's first record is a legal chain
  start (a `rotate` link record with `carry === prev`), and `verify()` seeds its expected counter
  from that record rather than resetting to 1.
  **Bound (measured, do not restate tighter):** rotation fires when the active file *reaches*
  `maxBytes`, checked **before** the next append. The achievable ceiling on the active file is
  **`maxBytes + one record`** — not `maxBytes` — because the record that triggered the rotation is
  appended after it. At rest following a rotation the active file holds only the link record
  (464 B measured); one record is 383 B; the link record 463 B. A test asserting the active file
  is under `maxBytes` is unsatisfiable and must not be reintroduced.
- **I4 · Archive, never delete** — **Invariant A4:** trimmed conversation messages must replay from
  `agents/<id>.history.jsonl`.
- **I5 · IPC set equality** — **Invariant A5:** `set(preload) == set(manifest) == set(handlers)`,
  with `browser:command` whitelisted **explicitly**. Measured delta on 2026-09-22: exactly
  `browser:command` (88 handlers / 89 channels / 89 manifest entries, both directions clean).
- **I6 · `resolveEndpoint` guards live in `agent/endpoint.cjs`**, shared by main-process consumers.
  4 tests: loop detection, credentials, normalization, HTTP failure. (Earlier docs placed this in
  `main.mjs` — that was wrong; the split happened in the 2.1/3.1 work.)

## Invariant → Check (for a verifier)

| # | Invariant | One check |
| --- | --- | --- |
| A1 | Atomic writes leave no partial file or `.tmp` | `test/atomic-write.test.cjs` truncation case |
| A2 | Audit hashes keep `record.v`, never the constant | legacy `v:1` fixture still verifies |
| A3 | Rotation preserves the chain across files | `node --test test/audit-log.test.cjs test/audit-rotation.test.cjs` |
| A4 | Conversation trimming archives, never deletes | archive replays trimmed messages |
| A5 | Channel sets agree in both directions | delete a handler → `npm test` prints the set diff |
| A6 | `resolveEndpoint` guards hold in `agent/endpoint.cjs` | 4 tests, each red before its guard |
| A7 | `npm test` fully green | `cd studio && npm test; echo $?` → `0` (counts grow as tests are added — the invariant is `0` failures, not a fixed total) |
| A10 | The plan's own numbers match the tree | `node tools/check-plan-baseline.cjs` → exit `0` (CI-gated, item 6.10) |
| A8 | Code index has no phantom symbols | `node --test test/code-index.test.cjs` |
| A9 | Tree is clean | `git status --porcelain` → 0 lines (measure at re-verification; dirty paths are intentionally not a fixed number) |

---

## ID Crosswalk (old `IMPROVEMENTS_VERIFIED.md` → this file)

| Old ID | This file | Old ID | This file |
| --- | --- | --- | --- |
| 0.1 audit rotation | 1.5 / I3 / A3 | 3.1 per-conversation storage | 5.8 |
| 0.2 phantom symbols | 3.5 + A8 | 3.2 persist team runs | 5.8 |
| 1.1 encrypt keys | 2.1 | 3.3 capture failed crew members | 5.1 |
| 1.2 IPC manifest | 2.3 | 3.4 budget telemetry | 5.2 (closest) — see note |
| 1.3 browser:command guard | 2.5 | 3.5 context visualizer | 5.3 |
| 1.4 IPC audit | 2.4 | 3.6 integration-test gaps | 2.4 / 6.9 |
| 1.5 per-conversation limits | 2.6 | 3.7 settings schema versioning | 1.8-adjacent (shipped; no open item) |
| 1.6 untrusted output | 2.7 | 4.1–4.7 release items | 0.3, 5.7, 5.6, 6.5, 5.2, 4.7, 5.2 |
| 1.7 rate limit | 2.8 | 5.1–5.7 cross-surface | **7.1–7.5** |
| 1.8 approval notify | 2.9 | 6.1–6.12 features | 4.13–4.18 + existing 4.2–4.8 |
| 2.1 split main.mjs | 3.1 | 6.12 team timeline | 5.5 |
| 2.2 split app.js | 3.2 | 7.1–7.6 docs | 6.4, 6.3, 6.1, 6.2, 6.8, 6.4/6.11 |
| 2.3 code index ownership | 3.5 | (digest A1) baseline rot | **6.10** |
| 2.6 resolveEndpoint tests | I6 / A6 | (digest A2) engine docs | **6.11** |
| (digest N2) return shapes | 2.3 | (digest N3) Node version | **1.9** |

Note: the old plan's budget-telemetry item (3.4, `budgets.jsonl` absent) has no dedicated row
here; it is tracked as part of 5.2's observability scope until it gets its own PR.

---

*This file consolidates and supersedes all older improvement documents. The archived originals in
`docs/archive/` are kept for history only — they state numbers that were wrong when written and are
wrong now; do not cite them, do not work from them. If any entry disagrees with this file, this
file wins.*
