# `docs/` — index

This directory holds the improvement plan, the IPC contract, engine deep dives, and
handoff notes. It previously held **six** overlapping improvement documents that
disagreed with each other *and* with the tree (three different line counts for
`studio/main.mjs`, three different IPC channel counts). The 2026-09-22 consolidation
finished the job: there is now exactly **one** document that states plan numbers.

## Start here

| If you want to… | Read |
| --- | --- |
| Know what to work on next, with measured evidence | [`IMPROVEMENTS.md`](./IMPROVEMENTS.md) *— the single canonical plan* |
| Trust a number in the plan | read its generated **BASELINE** block — `node tools/check-plan-baseline.cjs` verifies it, and CI fails if it drifts (item 6.10) |
| Re-measure the baseline by hand | `bash docs/verify-improvements.sh` (human-readable snapshot) |
| Recount the status table | `node tools/count-plan-status.cjs` |
| Know the main↔renderer channel surface today | [`STUDIO_IPC.md`](./STUDIO_IPC.md) |
| Understand the CodeGPT economy tier (two upstreams, the `127.0.0.1` trap, the 503s) | [`CODEGPT_ECONOMY_HANDOFF.md`](./CODEGPT_ECONOMY_HANDOFF.md) |
| Understand the engine surfaces (relay Chromium + bridge, web panel, fetcher, Studio browser, Reach CLI) | [`engines/README.md`](./engines/README.md) |
| Improve the **agent engine** (`studio/agent/*.cjs`) specifically | [`AGENT_ENGINE_IMPROVEMENTS.md`](./AGENT_ENGINE_IMPROVEMENTS.md) *— engine-scoped annex to the plan* |

## The one rule

**`IMPROVEMENTS.md` wins.** Every number in it was produced by a command printed
beside it. If a number stops matching the tree, fix it in the same change that moved
the number — documents rotted precisely because nobody did.

Since item 6.10 that rule is not a promise, it is a gate. The plan's **BASELINE** block
and its Status-at-a-Glance counts are *generated*, and CI runs the checkers, so a
measured file moving by one line without regenerating the table fails the build:

```bash
node tools/check-plan-baseline.cjs          # verify (what CI runs)
node tools/check-plan-baseline.cjs --write  # regenerate after landing a change
node tools/count-plan-status.cjs            # the DONE/PARTIAL/TODO counts
```

Do **not** add a second repo-wide improvement plan. Add items to the existing one — or to the engine-scoped annex, which owns only `studio/agent/*.cjs`, states no repo-wide numbers, renumbers nothing, and defers to `IMPROVEMENTS.md` on any conflict. Any engine item that grows beyond the engine moves into `IMPROVEMENTS.md` and leaves a pointer behind.

## Active documents

| File | What it is | Status |
| --- | --- | --- |
| `IMPROVEMENTS.md` | The plan: measured baseline, phased items 0–7, collision map, frozen interfaces I1–I6, invariants A1–A9, ID crosswalk to the old plan | **canonical** |
| `STUDIO_IPC.md` | The readable half of the IPC contract (the machine-checked half is item 2.3's manifest test) | maintained |
| `CODEGPT_ECONOMY_HANDOFF.md` | Operating notes for the economy tier: why it 503s, how routing/auth follow the model | maintained |
| `engines/README.md` | The engine surfaces: map, invariants, document contract | maintained |
| `engines/BROWSER_ENGINE.md` | Deep dive: relay-side Chromium engine + Python bridge + web panel + Reader fetcher | maintained |
| `AGENT_ENGINE_IMPROVEMENTS.md` | Engine-scoped annex to the plan: `studio/agent/*.cjs`, items `E1`–`E19` | **annex** |
| `verify-agent-engine.sh` | Re-measures the engine baseline (module/line counts, require cycles, un-homed policy constants, dead constants) | maintained |
| `engines/STUDIO_BROWSER.md` | Deep dive: Studio in-app browser (`studio/browser/{host,agent,page}.cjs`) | **missing — item 6.11** |
| `engines/REACH_CLI.md` | Deep dive: Reach CLI surface (`studio/agent/{platform,reach-process,reach-tool-executor}.cjs`) | **missing — item 6.11** |
| `verify-improvements.sh` | Re-measures the baseline; run it before trusting the plan's numbers | maintained |
| `README.md` | This index | maintained |

`engines/STUDIO_BROWSER.md` and `engines/REACH_CLI.md` are **not written yet**; item
6.11 of the plan covers completing or removing them. The deep-dive sections of
`engines/README.md` (in-process browser refs, Reach CLI sandboxing) stand in for now.

## Superseded documents → `archive/`

These are kept for history only. They state numbers that were wrong when they were
written and are wrong now. **Do not cite them, do not work from them.**

| Archived file | Superseded by | What it got wrong |
| --- | --- | --- |
| `archive/IMPROVEMENTS_VERIFIED.md` | `IMPROVEMENTS.md` | Correct *when it was written*; the 2026-09-22 consolidation merged its phased detail, frozen interfaces and invariants into the canonical plan and re-measured the baseline (it still shows 3,746 lines / 80 handlers vs. 4,116 / 86 measured) |
| `archive/STUDIO_IMPROVEMENTS.md` | `IMPROVEMENTS.md` | §2 baseline (main.mjs 4,041, app.js 4,443) already stale the day after it was measured; its new findings A1–A4, N2–N3 were merged in as items 6.10, 6.11, 1.9 and inside 2.3 |
| `archive/IMPROVEMENTS_SUMMARY.md` | `IMPROVEMENTS.md` (Executive Summary) | Stale counts (`main.mjs` 3,636 / `app.js` 2,949 vs. 4,116 / 4,573 measured) |
| `archive/IMPROVEMENTS.md` | `IMPROVEMENTS.md` | `main.mjs` 3,481 (now 4,116); placed `resolveEndpoint` in `agent/connections.cjs` — it is in `agent/endpoint.cjs` |
| `archive/IMPROVEMENTS_PRIORITIZATION.md` | `IMPROVEMENTS.md` | `main.mjs` 3,389; claimed no `.github/` directory exists (it does) |
| `archive/IMPROVEMENTS_REVIEW.md` | `IMPROVEMENTS.md` | `main.mjs` 3,481; claimed tracked `__pycache__` (there is none) |
| `archive/DESIGN_IMPROVEMENTS.md` | `IMPROVEMENTS.md` (Frozen Interfaces) | `main.mjs` 3,636; stated the pre-append rotation contract, which is unsatisfiable (see I3 in the canonical plan) |

The frozen interfaces (`I1`–`I6`) and the invariant→check table (`A1`–`A9`) that used
to live in `DESIGN_IMPROVEMENTS.md`, then in `IMPROVEMENTS_VERIFIED.md` §10.2–10.3,
now live in `IMPROVEMENTS.md`. That file is the only place they are stated.
