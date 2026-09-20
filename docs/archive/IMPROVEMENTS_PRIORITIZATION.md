# Prioritization: REACH Studio Improvements

Organized as a phased plan. Each phase contains items that can be done in parallel, with explicit dependencies noted.

---

## Phase 0 — Fix (blockers & process)

**Owner: Any Builder | Effort: < 1 hour | Blocks: everything**

| # | Item | Why | Done check |
|---|------|-----|------------|
| 0.1 | Commit/unstash the dirty working tree (`agent-loop.cjs`, `context.js`) or create tracking branches | CI is running against stale state; any new PRs will have noise | `git status` clean on the branch the doc targets |
| 0.2 | Pin studio/package.json `version` to match release-please (26.9.x) or add `studio` to release-please-config.json | Currently all dist zips report 1.0.0 while the repo is at 26.9.5 — confuses users and CI `npm audit` | `npm view reach-studio version` matches repo |
| 0.3 | Add Windows packaging to CI (`npm run dist:win`) | CI builds macOS + Linux artifacts but silently drops Windows | Windows artifacts appear in CI upload step |

---

## Phase 1 — Quick wins (high signal, low risk)

**Owner: Any Builder | Effort: 1–3 hours each | No dependencies**

| # | Item | Why | Done check |
|---|------|-----|------------|
| 1.1 | Convert `npm test` from 28-file `&&` chain to `node --test "test/**/*.test.cjs"` | Current chain fails fast on first error, wastes CI minutes on subsequent failures, and is unmaintainable | `npm test` runs all 29 test files; exit 0 on clean tree |
| 1.2 | Add ESLint (or Biome) with auto-fix + commit to CI | Zero lint configs repo-wide — `node --check` only verifies syntax, not style or common bugs | CI passes eslint/biome; `tests.quickfix` handles auto-fixes |
| 1.3 | Cover the two stray tracked HTML files in `tests/` — either remove or add to `.gitignore` | Stray files indicate low hygiene; `_chat_panel_preview.html` is a test artifact | Files gone or explicitly tracked with purpose comment |
| 1.4 | Add `uncaughtException` + `unhandledRejection` handlers to `main.mjs` | No crash recovery in main process — a single rejected promise kills the app silently | Crash logs written to `~/.config/Reach Studio/crash.log` |
| 1.5 | Atomize `saveSettings` in `main.mjs` | Currently writes `settings.json` directly while `agent-store.cjs` already uses tmp+rename — risk of corrupt settings on crash | Settings survive a kill -9 mid-write |
| 1.6 | Remove `'unsafe-inline'` from renderer CSP and move the inline script to a file | Inline scripts violate CSP best practices and enable XSS vectors | `Content-Security-Policy` header no longer contains `unsafe-inline` |

---

## Phase 2 — Security & data integrity

**Owner: Security-minded Builder | Effort: 3–6 hours each | Depends on: 1.5 (atomic writes)**

| # | Item | Why | Done check |
|---|------|-----|------------|
| 2.1 | Encrypt API keys at rest using Electron's `safeStorage` API | Keys stored plaintext in `settings.json`; anyone with file access can read them | `settings.json` contains encrypted blobs; `accessKey` decrypted only at request time |
| 2.2 | Audit all IPC handlers for SSRF / path-traversal | `main.mjs` has 74 stringly-typed `ipcMain.handle` calls with no manifest — easy to miss a guard | Each handler validates inputs; audit report documents the findings |
| 2.3 | Create an IPC method manifest in `preload.cjs` | 100+ stringly-typed methods with no source-of-truth makes code review impossible | One `MANIFEST` object in preload matches all handlers in main.mjs; CI fails if there's a mismatch |
| 2.4 | Add per-conversation data limits to `agents.json` | One JSON file with all conversations growing unbounded — memory and crash risk with large agents | Per-conversation size cap enforced; old messages archived or trimmed |
| 2.5 | Sanitize model input/output for prompt injection | No input sanitization before sending to endpoint — user can inject system prompt content via conversation history | Malicious prompt content stripped or escaped |

---

## Phase 3 — Architecture (the big refactor)

**Owner: Senior Builder | Effort: 1–2 weeks | Depends on: Phase 2 (safety net)**

| # | Item | Why | Done check |
|---|------|-----|------------|
| 3.1 | Split `main.mjs` (3,389 lines, 74 handlers) into IPC domains | Same monolith pattern REFACTOR_LATEST.md killed for the relay — `server/reachd/` split worked; studio needs it too | `main.mjs` < 200 lines; handlers distributed to `ipc/chat.cjs`, `ipc/files.cjs`, `ipc/browser.cjs`, etc. |
| 3.2 | Split `renderer/app.js` (2,665 lines) into concerns | Mixed chat, drawer, tree, composer logic in one file — unmaintainable | `renderer/chat/`, `renderer/files/`, `renderer/composer/` modules |
| 3.3 | Extract `agent-loop.cjs` (558 lines) into smaller modules | Handles conversation state, tool dispatch, compaction, streaming, edit review, budgets, code context, and event emission | `agent-loop`, `agent-tool-runner`, `agent-compact`, `agent-budget`, `agent-stream` — each independently testable |
| 3.4 | Add a TypeScript layer for IPC contracts | Stringly-typed IPC is the #0 source of bugs; types catch mismatches at compile time | `ipc.types.ts` shared between main and preload; build fails on mismatch |

---

## Phase 4 — Feature & UX

**Owner: UX-minded Builder | Effort: varies | No hard dependencies**

| # | Item | Why | Done check |
|---|------|-----|------------|
| 4.1 | Conversation export/import (JSON/Markdown) | No way to share or backup agent workflows | Export button in conversation menu; import validates schema |
| 4.2 | Conversation templates/saved prompts | Users type everything from scratch | Templates page; one-click insert into composer |
| 4.3 | Local/offline mode (chat to Ollama/LM Studio sources) | Telemetry sources are read-only — can discover but not chat | Chat panel sends messages to selected local source |
| 4.4 | Model comparison view | Can't see two models' responses side-by-side | Two-panel layout for same prompt |
| 4.5 | Keyboard shortcut customization | Only hardcoded shortcuts; no settings page | Settings page with shortcut binding editor |
| 4.6 | Theme extensibility / custom CSS | Only two built-in themes | Theme editor with live preview |
| 4.7 | Browser panel history search | Can navigate but can't search previous snapshots | Search bar in browser panel filtering tab history |
| 4.8 | Network inspector | Can't see raw HTTP between Studio and endpoint | DevTools-style panel showing request/response pairs |

---

## Phase 5 — Reliability & observability

**Owner: Platform Builder | Effort: varies | Depends on: Phase 3 (cleaner architecture)**

| # | Item | Why | Done check |
|---|------|-----|------------|
| 5.1 | Crew message persistence | Agent messages are in-memory only — app crash loses all inter-agent state | Messages written to `crew-<id>.json` with WAL |
| 5.2 | Configurable log levels | Studio logs to Electron console with no verbosity control | Settings page with debug/verbose/off toggles |
| 5.3 | Context window visualizer | Estimated token count visible but no breakdown of which messages are in-context | Expandable chart showing per-message token contribution |
| 5.4 | Automatic fallback model | Relay has fallback chains but Studio doesn't — model unavailable means hard failure | Studio tries next model in list when current fails |
| 5.5 | Team activity timeline aggregation | Individual activity tracked but no unified team view | Combined timeline card in conversation |
| 5.6 | Automatic update checker | No built-in update mechanism | Menu item "Check for updates" with download + relaunch |

---

## Phase 6 — Distribution & dev experience

**Owner: DevEx Builder | Effort: varies | No hard dependencies**

| # | Item | Why | Done check |
|---|------|-----|------------|
| 6.1 | `CONTRIBUTING.md` guide | No developer onboarding doc | First-time dev can run `npm test` in < 5 minutes |
| 6.2 | Windows Store publishing | Only NSIS/portable for Windows; Microsoft Store for discoverability | App submitted to Microsoft Store |
| 6.3 | Docker healthcheck wiring | `healthcheck.sh` exists but compose doesn't reference it | `docker compose up --build` healthchecks pass |
| 6.4 | Flatpak bundle size optimization | Runtime adds significant download size | AppImage as documented alternative with size comparison |
| 6.5 | API documentation for relay endpoints | Endpoints undocumented beyond README table | OpenAPI spec or `docs/endpoints.md` with examples |
| 6.6 | Test coverage baseline + reporting | Zero coverage metrics | `npm test -- --coverage` generates report; CI gates at 60% |

---

## Summary: Recommended immediate sequence

1. **Phase 0** (fix blockers) — 1 hour total. Commit dirty tree, align version, add Windows CI.
2. **Phase 1** (quick wins) — 2–3 hours each. These are high-signal, low-risk changes that immediately improve developer experience and stability. Do 1.1–1.6 in parallel where possible.
3. **Phase 2** (security) — After Phase 1, the codebase is cleaner and easier to audit.
4. **Phase 3** (architecture) — The biggest lift but highest ROI. Mirrors the successful `server/reachd/` refactor.
5. **Phase 4+** — Feature work that benefits from the cleaner architecture.
