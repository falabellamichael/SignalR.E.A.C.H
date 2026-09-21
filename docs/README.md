# `docs/` — index

This directory holds the improvement plan, the interfaces it freezes, and two handoff notes.
It previously held **six** overlapping improvement documents that disagreed with each other
*and* with the tree (three different line counts for `studio/main.mjs`, three different IPC
channel counts). Item 7.1/7.6 of the plan fixed that: there is now exactly **one** document
that states numbers.

## Start here

| If you want to… | Read |
| --- | --- |
| Know what to work on next, with measured evidence | [`IMPROVEMENTS_VERIFIED.md`](./IMPROVEMENTS_VERIFIED.md) *— the single source of truth* |
| Re-measure the baseline before trusting any number | `bash docs/verify-improvements.sh` |
| Know the main↔renderer channel surface today | [`STUDIO_IPC.md`](./STUDIO_IPC.md) |
| Understand the CodeGPT economy tier (two upstreams, the `127.0.0.1` trap, the 503s) | [`CODEGPT_ECONOMY_HANDOFF.md`](./CODEGPT_ECONOMY_HANDOFF.md) |
| Understand the three engine systems (Chromium, bridge, fetcher) | [`engine/overview.md`](./engine/overview.md) |

## The one rule

**`IMPROVEMENTS_VERIFIED.md` wins.** Every number in it was produced by a command printed
beside it. If a number stops matching the tree, fix it in the same PR that changed it — five
documents rotted precisely because nobody did.

Do **not** add a second improvement plan. Add items to the existing one.

## Active documents

| File | What it is | Status |
| --- | --- | --- |
| `IMPROVEMENTS_VERIFIED.md` | The plan: verified baseline, phased items, frozen interfaces, invariant→check table | **source of truth** |
| `STUDIO_IPC.md` | The readable half of the IPC contract (the machine-checked half is item 1.2's manifest test) | maintained |
| `CODEGPT_ECONOMY_HANDOFF.md` | Operating notes for the economy tier: why it 503s, how routing/auth follow the model | maintained |
| `engine/overview.md` | Architecture overview of all three engine systems | maintained |
| `engine/browser-engine.md` | Deep dive: offscreen Chromium process (`server/browser-engine/main.cjs`) | maintained |
| `engine/browser-bridge.md` | Deep dive: Python HTTP bridge to Chromium (`server/reachd/browser_engine.py`) | maintained |
| `engine/browser-fetcher.md` | Deep dive: stateless page retriever for Reader mode (`server/reachd/browser.py`) | maintained |
| `verify-improvements.sh` | Re-measures the baseline; run it before trusting §1 | maintained |
| `README.md` | This index | maintained |

## Superseded documents → `archive/`

These are kept for history only. They state numbers that were wrong when they were written and
are wrong now. **Do not cite them, do not work from them.**

| Archived file | Superseded by | What it got wrong |
| --- | --- | --- |
| `archive/IMPROVEMENTS.md` | `IMPROVEMENTS_VERIFIED.md` | `main.mjs` 3,481 (now 3,748); placed `resolveEndpoint` in `agent/connections.cjs` — it is in `main.mjs` |
| `archive/IMPROVEMENTS_PRIORITIZATION.md` | `IMPROVEMENTS_VERIFIED.md` | `main.mjs` 3,389; claimed no `.github/` directory exists (it does) |
| `archive/IMPROVEMENTS_REVIEW.md` | `IMPROVEMENTS_VERIFIED.md` | `main.mjs` 3,481; claimed tracked `__pycache__` (there is none) |
| `archive/DESIGN_IMPROVEMENTS.md` | `IMPROVEMENTS_VERIFIED.md` §10.2 | `main.mjs` 3,636; stated the pre-append rotation contract, which is unsatisfiable (see §0.1) |

The frozen interfaces (`I1`–`I6`) and the invariant→check table (`A1`–`A9`) that used to live in
`DESIGN_IMPROVEMENTS.md` now live in `IMPROVEMENTS_VERIFIED.md` §10.2 and §10.3. That file is the
only place they are stated.
