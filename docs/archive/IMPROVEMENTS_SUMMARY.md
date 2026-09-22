> ⚠ **SUPERSEDED — archived 2026-09-22.** The single canonical improvement plan is now
> [`docs/IMPROVEMENTS.md`](../IMPROVEMENTS.md); its Executive Summary section supersedes the
> digest below (which stated stale line counts — e.g. `main.mjs` 3,636 / `app.js` 2,949 vs.
> 4,116 / 4,573 measured 2026-09-22). Do not cite it, do not work from it.

# REACH Studio — Improvement Summary (archived copy)

## What This Is

This is a consolidated, prioritized improvement plan for **SignalR.E.A.C.H** — a monorepo with four runtime surfaces (Python relay server, SimpleRAG plugin panel, VS Code extension + tray, and the REACH Studio Electron desktop app).

## Where We Stand

| Phase | Status | Key Result |
|-------|--------|------------|
| **0 — Process & Hygiene** | Mostly done | Tree cleaned, Studio in release-please, Windows CI partial |
| **1 — Quick Wins** | Mostly done | Test discovery, crash handlers, atomic writes, CSP cleanup, coverage baseline all landed |
| **2 — Security & Data** | Partially done | API key encryption, copilot token protection, browser:command guard, untrusted output handling done; IPC manifest and audit are partial |
| **3 — Architecture** | Partially done | Main.mjs split initiated (settings/endpoint/notifications extracted); renderer split, TypeScript contracts not started |
| **4 — Features & UX** | Mixed | Export/import, parse coverage, tray tests done; templates, local mode, model comparison still TODO |
| **5 — Reliability** | Not started | Crew message persistence, log levels, context visualizer, fallback model all pending |
| **6 — Distribution & DX** | Partially done | CONTRIBUTING.md, SECURITY.md, README entry points, npm dependabot done; Windows Store, API docs pending |

**Overall: ~18 DONE, ~10 PARTIAL, ~30 TODO**

## Top 10 Remaining Priorities

1. **Split `main.mjs`** (3,636+ lines) into domain modules
2. **Split `renderer/app.js`** (2,949+ lines) into concern-based modules
3. **Complete IPC manifest + set-equality test** — catch mismatches at build time
4. **Audit every IPC handler** for remaining input validation gaps (7 documented)
5. **Per-conversation byte limits** with append-only archive
6. **Rate-limit outbound agent requests** to avoid provider 429s
7. **Ship Windows installers** from CI fully
8. **Per-conversation storage** and durable team recovery
9. **Crew message persistence** (WAL for in-memory agent state)
10. **macOS notarization** (requires Apple Developer ID credentials)

## What Was Consolidated

This plan merges five source documents:
- `docs/IMPROVEMENTS_VERIFIED.md` — current verified status with evidence
- `docs/archive/IMPROVEMENTS.md` — the canonical improvement plan with evidence-based items
- `docs/archive/DESIGN_IMPROVEMENTS.md` — implementation design, interfaces, ownership
- `docs/archive/IMPROVEMENTS_REVIEW.md` — whole-repo review covering relay, extension, tray, panel
- `docs/archive/IMPROVEMENTS_PRIORITIZATION.md` — original phased prioritization
- `PROJECT_SUMMARY.md` — architecture overview and key metrics

The consolidated version (`docs/IMPROVEMENTS.md`) supersedes all of them.

## How to Use

1. Pick an item by ID (e.g., `3.1`) from the consolidated plan.
2. Follow the dependency graph — Phase 0 first, then 1, then 2, then 3.
3. One item per PR, use Conventional Commits with item ID in scope.
4. Every change needs a test in `studio/test/*.test.cjs`; `npm test` must be green.
5. Update this file when an item lands — flip status, fix evidence.

## Verification

```bash
bash docs/verify-improvements.sh   # Full re-verification
cd studio && npm test              # Must exit 0
```
