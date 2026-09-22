# REACH Studio — Improvement Plan & Status

> **Consolidated from**: `docs/IMPROVEMENTS_VERIFIED.md`, `docs/archive/IMPROVEMENTS.md`,  
> `docs/archive/DESIGN_IMPROVEMENTS.md`, `docs/archive/IMPROVEMENTS_REVIEW.md`,  
> `docs/archive/IMPROVEMENTS_PRIORITIZATION.md`, `PROJECT_SUMMARY.md`  
> **Last verified**: Working tree at HEAD | **Re-verify**: `bash docs/verify-improvements.sh`

---

## Executive Summary

SignalR.E.A.C.H is a monorepo with four runtime surfaces — a Python relay server, a SimpleRAG plugin panel, a VS Code extension + desktop tray, and the REACH Studio Electron desktop app. The improvement plan below tracks **correctness, security, architecture, features, reliability, and distribution** across all surfaces.

### Status at a Glance

| Status | Count | What it means |
|--------|-------|---------------|
| **DONE** | ~18 | Implemented, tested, verified in working tree |
| **PARTIAL** | ~10 | Partially implemented; evidence or tests remain |
| **TODO** | ~30 | Not yet started; ordered by dependency and priority |

### Top 10 Highest-Impact Remaining Items

1. **Split `main.mjs`** (3,636+ lines, 76+ IPC handlers) into domain modules
2. **Split `renderer/app.js`** (2,949+ lines) into concern-based modules
3. **IPC manifest + set-equality test** — catch handler/channel mismatches at build time
4. **Encrypt API keys at rest** using Electron `safeStorage`
5. **Per-conversation size limits** with archive, never-delete
6. **Audit every IPC handler** for input validation gaps
7. **Rate-limit outbound agent requests** to avoid provider 429s
8. **Add Windows installers to CI**
9. **Add ESLint + coverage baseline**
10. **Ship CONTRIBUTING.md + SECURITY.md**

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
| 1.3 | Add coverage baseline (`--experimental-test-coverage`) | DONE | **95.73% lines / 81.38% branches / 91.30% functions** (excludes Electron/UI modules) |
| 1.4 | Clean stray tracked artifacts (debug HTML, probe scripts, `.vsix` files) | PARTIAL | Probe scripts still committed; stray `.vsix` files gitignored but present |
| 1.5 | Add main-process crash handlers | DONE | `uncaughtException` + `unhandledRejection` → `crash.log` |
| 1.6 | Atomic writes for settings and projects | DONE | `agent/atomic-write.cjs`; used for settings + projects |
| 1.7 | Drop `'unsafe-inline'` from CSP `script-src` | DONE | Inline script moved to `boot.js`; CSP uses `'self'` only |
| 1.8 | Pin Node 24 LTS consistently | PARTIAL | `engines.node: >=24` and `.nvmrc: 24` set; install scripts not updated |

---

## Phase 2 — Security & Data Integrity

| # | Item | Status | Evidence / Notes |
|---|------|--------|-----------------|
| 2.1 | **Encrypt API keys at rest** (`safeStorage`) | DONE | Settings store encrypts keys; OS vault used; explicit fallback warning when unavailable |
| 2.2 | Protect Copilot shim token | DONE | `chmod 0600` + loud warning on world-readable load |
| 2.3 | **IPC manifest + set-equality test** | PARTIAL | All 81 channels have owner/signature metadata; bidirectional tests pass; return-shape validation and full domain extraction remain |
| 2.4 | **Audit every IPC handler** for input validation | PARTIAL | 7 open gaps documented (`agents:setTodos`, `files:write` size, `project:create` parent, etc.); booleans required for review decisions |
| 2.5 | Guard `browser:command` dynamic channel | DONE | Preload returns `{ok:false, err}` when no tab; regression tests cover missing handler |
| 2.6 | **Per-conversation size limits** (archive, never delete) | TODO | `MAX_AGENTS=200`, `MAX_STORED_MESSAGES=400` exist but serialized bytes unbounded; needs `.history.jsonl` archive |
| 2.7 | Treat tool/file output as untrusted data | DONE | Escaped delimiters around tool/source data; forged approval fixture cannot bypass edit review |
| 2.8 | **Rate-limit outbound agent requests** | TODO | Per-connection gate needed; relay already has `RateLimiter`; client-side missing |
| 2.9 | Approval notifications | PARTIAL | Background notifications, beep, Dock badge, click-to-focus, burst coalescing; OS delivery needs manual verification |

---

## Phase 3 — Architecture (Big Refactors)

| # | Item | Status | Impact |
|---|------|--------|--------|
| 3.1 | **Split `main.mjs`** (3,636 lines → domain modules) | PARTIAL | Settings, endpoint, notifications extracted to independent modules; IPC/bootstrap/smoke extraction remains |
| 3.2 | **Split `renderer/app.js`** (2,949 lines) | TODO | Mixed chat, drawer, tree, composer logic |
| 3.3 | Extract `agent-loop.cjs` into smaller testable modules | PARTIAL | Many sub-modules exist; full loop still monolithic |
| 3.4 | IPC TypeScript contracts (or equivalent runtime schema) | TODO | Stringly-typed IPC is the #0 source of bugs |
| 3.5 | Resolve code-index ownership (`code-context.cjs` → `code-index.cjs`) | TODO | TTL + invalidation still in wrong module |

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
| 4.8 | Network inspector | TODO |
| 4.9 | VS Code contributor workflow (large-module split) | PARTIAL |
| 4.10 | Parse coverage (JS/CJS/MJS, all surfaces) | DONE | **77 tracked files pass** |
| 4.11 | Tray test entry point | DONE | `copilot/tray && npm test`: **31/31 pass** |

---

## Phase 5 — Reliability & Observability

| # | Item | Status |
|---|------|--------|
| 5.1 | Crew message persistence (WAL) | TODO |
| 5.2 | Configurable log levels | TODO |
| 5.3 | Context window visualizer | TODO |
| 5.4 | Automatic fallback model | TODO |
| 5.5 | Team activity timeline aggregation | TODO |
| 5.6 | Automatic update checker | TODO |
| 5.7 | macOS notarization | TODO (needs Apple Developer ID credentials) |
| 5.8 | Per-conversation storage (durable team recovery) | TODO |

---

## Phase 6 — Distribution & Developer Experience

| # | Item | Status |
|---|------|--------|
| 6.1 | **CONTRIBUTING.md** guide | DONE | `studio/CONTRIBUTING.md`: tools, pages, IPC, persistence, testing, platform checks |
| 6.2 | **SECURITY.md** policy | DONE | Documents reporting, trust boundaries, credential fallback, backup handling |
| 6.3 | Product entry points in root README | DONE | Links Studio, relay/panel, extension, tray, contribution guide, security policy |
| 6.4 | Documentation consolidation | PARTIAL | Archive/index changes preserved; plan and re-verification script updated |
| 6.5 | Dependabot: npm + pip | PARTIAL | npm added for Studio, VS Code, tray; no pip manifest exists; first update PR pending |
| 6.6 | Windows Store publishing | TODO |
| 6.7 | Flatpak bundle size optimization | TODO |
| 6.8 | API documentation for relay endpoints | TODO |
| 6.9 | Test coverage baseline + CI gate | DONE | CI checks coverage; **95.73%** lines covered |

---

## Dependency Graph

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4/5/6
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
                 └─ TypeScript IPC (3.4)
```

---

## Working Agreements

1. **One item per PR.** Use Conventional Commits with item ID in scope.
2. **Never leave the tree dirty.** Land or stash work; don't hand the next worker a dirty tree.
3. **Every behavior change needs a test** in `studio/test/*.test.cjs`; `npm test` must be green.
4. **Architecture items are land-only-with-tests.** A refactor PR that changes observable behavior must be two PRs.
5. **Update this file when you land an item** — flip status and fix Evidence lines. This document rotting is the failure mode it was written to prevent.

---

## Verification Commands

```bash
# Full re-verification
bash docs/verify-improvements.sh

# Key metrics
wc -l studio/main.mjs                          # → 3,636+ lines
grep -c "ipcMain.handle" studio/main.mjs       # → 76+ handlers
grep -c "ipcRenderer.invoke" studio/preload.cjs # → 80+ channels
ls studio/agent/*.cjs | wc -l                  # → 44 modules
ls studio/test/*.test.cjs | wc -l              # → 52+ tests (521 with skips in latest suite)
cd studio && npm test                           # → must exit 0
```

---

## Key Invariants (Must Not Break)

| # | Invariant | How to Verify |
|---|-----------|---------------|
| I1 | Atomic writes: no `.tmp` survives, target is old or new (never partial) | `test/atomic-write.test.cjs` |
| I2 | Audit log hash chain: `canonical()` hashes `record.v`, never the constant | Legacy `v:1` fixture still verifies |
| I3 | Audit rotation: active file holds at most `marker + one record` | Measured ≤ `maxBytes + one record` |
| I4 | Conversation trimming: archives, never deletes | Archive replays trimmed messages |
| I5 | Channel sets agree: `preload === manifest === handlers` (minus dynamic `browser:command`) | Delete a handler → `npm test` prints set diff |
| I6 | `resolveEndpoint` guards live in `main.mjs` | 4 tests for loop detection, credentials, normalization, HTTP failure |

---

*This file consolidates and supersedes all older improvement documents in `docs/archive/`. If any entry disagrees with them, this file wins.*
