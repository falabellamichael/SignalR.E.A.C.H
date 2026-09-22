> ⚠ **SUPERSEDED — archived 2026-09-22.** The single canonical improvement plan is now
> [`docs/IMPROVEMENTS.md`](../IMPROVEMENTS.md). The new findings from this digest (A1 baseline
> rot, A2 missing engine docs, A3 half-done rename, A4 `.DS_Store`, N2 return shapes, N3 Node
> version) were merged into it as items 6.10, 6.11, 1.9 and inside 2.3. Its §2 numbers are
> stale. Do not cite it, do not work from it.

# REACH Studio — Prioritized Improvement Digest (archived copy)

> **Read this first — where this document sits in the repo.**
> `docs/README.md` states the rule: *"Do not add a second improvement plan. Add items to the
> existing one."* This file respects that rule. It is **not** a competing plan. It is a
> **re-measured, prioritized digest** of the existing plan
> ([`IMPROVEMENTS_VERIFIED.md`](./IMPROVEMENTS_VERIFIED.md)) plus a small set of **new findings**
> that the existing plan does not cover. Where the two disagree, **`IMPROVEMENTS_VERIFIED.md` is the
> working plan and this file is the short list** — but its numbers are now stale, and §2 shows by how
> much, so a reader must not trust its baseline without re-measuring.

| Field | Value |
| --- | --- |
| Scope | REACH Studio (`studio/`) desktop app, and the repo plumbing that supports it |
| Baseline commit | `0061b12` — *fix(tray): resume CodeGPT runs the upstream cut mid-stream* (`main`) |
| Measured | 2026-09-21, by direct command — every number below is reproducible from §7 |
| Method | `bash docs/verify-improvements.sh` plus targeted `wc` / `grep` / `node --test` runs |
| Test suite at time of writing | **525 tests, 525 pass, 0 fail, exit 0** (`cd studio && npm test`) |
| Status legend | `DONE` · `PARTIAL` · `TODO` · `BLOCKED` (external) · `NEW` (added by this digest) |

---

## 1. Why this digest exists

REACH Studio is the largest surface in this monorepo and the one where the plan's own warnings have
started to come true. Two facts drove this document:

1. **The plan is right about its own failure mode, and it is happening again.** `IMPROVEMENTS_VERIFIED.md`
   §6 was written because five improvement documents rotted and disagreed. Today, the two documents
   that *do* state numbers — `IMPROVEMENTS_VERIFIED.md` §1 and the root `PROJECT_SUMMARY.md` — disagree
   with each other *and* with the tree. §2 quantifies it.
2. **The structural items are getting worse, not better.** `studio/main.mjs` grew from the plan's
   recorded 3,748 lines to **4,041**, and `studio/renderer/app.js` from 4,137 to **4,443**. The two
   critical-path refactors are losing ground while every other item waits behind them.

So the value here is not "another list of ideas" — it is **a re-measured ranking** that tells a crew
which items are genuinely urgent now, and which items the plan still lists as open but are in fact
already done.

---

## 2. Measured baseline — and the drift from the plan

Measured 2026-09-21 at `0061b12`. The plan's recorded values are from its own §1.

| Metric | Plan records | **Measured today** | Drift | Source of truth command |
| --- | --- | --- | --- | --- |
| `studio/main.mjs` | 3,748 | **4,041** | **+293** | `wc -l studio/main.mjs` |
| `studio/renderer/app.js` | 4,137 | **4,443** | **+306** | `wc -l studio/renderer/app.js` |
| `studio/preload.cjs` | 190 | **193** | +3 | `wc -l studio/preload.cjs` |
| Static IPC handlers | 80 | **83** | +3 | `grep -cE "^\s*ipcMain\.handle\('" studio/main.mjs` |
| Preload invoke channels | 81 | **84** | +3 | `grep -oE "ipcRenderer\.invoke\('[^']+'" studio/preload.cjs \| sort -u \| wc -l` |
| `studio/ipc-manifest.json` | absent (§3, item 1.2) | **present, 84 entries** | landed | `node -p "Object.keys(require('./studio/ipc-manifest.json')).length"` |
| Agent modules | 49 | **52** | +3 | `ls studio/agent/*.cjs \| wc -l` |
| Renderer scripts | 21 | **22** | +1 | `ls studio/renderer/*.js \| wc -l` |
| Unit test files | 46 | **53** | +7 | `ls studio/test/*.test.cjs \| wc -l` |
| `studio/ipc/` (item 2.1 target) | absent | **still absent** | none | `ls -d studio/ipc` |
| `agent/team-runner.cjs` | 1,217 | **1,250** | +33 | `wc -l studio/agent/team-runner.cjs` |
| `agent/code-index.cjs` | 1,144 | **1,156** | +12 | `wc -l studio/agent/code-index.cjs` |
| `server/reachd/handler.py` | 1,227 | **1,227** | 0 | `wc -l server/reachd/handler.py` |
| `vscode/media/chat.js` | 3,217 | **3,239** | +22 | `wc -l vscode/media/chat.js` |
| `vscode/extension.js` | 2,703 | **2,893** | +190 | `wc -l vscode/extension.js` |
| Source markers (`TODO`/`FIXME`/`HACK`/`XXX`) | 6 | **6** | 0 | grep over `studio/agent studio/renderer main.mjs src vscode server` |

**The invariant still holds.** Handlers 83, channels 84, and the set difference is exactly
`browser:command` — the one explicitly dynamic channel. Checked in both directions, and against the
manifest:

```
handlers 83  channels 84
preload-only:   browser:command
handler-only:   none
manifest 84
manifest-not-channel:  none
channel-not-manifest:  none
```

**Second drift, independent of the first.** The root `PROJECT_SUMMARY.md` opens with *"Generated from
the working tree. Counts are measured, not asserted"* — yet its §4/§5 numbers (76 handlers / 77
channels, 44 agent modules, 32 test files, `main.mjs` 3,636) were stale the moment they were written
with respect to today's tree. A document that advertises measurement must be **generated**, not
hand-edited. That is item **N1** in §5.

---

## 3. The short list — ranked

Ranking rule: **unblocking power first, then risk × blast radius, then effort**. An item that makes
other items verifiable outranks an item that is merely valuable.

### Priority 0 — do these first

| # | Item | Status | Why it ranks here |
| --- | --- | --- | --- |
| **2.1** | Split `studio/main.mjs` (4,041 lines, 83 handlers) | `PARTIAL` | **Critical path.** 1.2's owner attribution, 2.2, 2.3, 3.2, 3.4 and 3.7 all name it as a dependency. It is also *growing* (+293 since the plan). Every week it waits, the eventual split gets harder. |
| **A1** | Stop the plan's baseline from rotting | `NEW` | The drift in §2 is not cosmetic: three documents now disagree, which is the exact failure the archive was created to end. One script + one rule fixes it permanently. |
| **2.2** | Split `studio/renderer/app.js` (4,443 lines) | `TODO` | Now the single largest file in Studio and still rising (+306). Blocks 6.1, 6.2, 6.4. |
| **3.2** | Persist team runs across reload | `TODO` | The plan calls this "highest UX complaint in the project's own README", and it still is: a reload mid-team-run loses the run. |

### Priority 1 — security, integrity, and the last unverified gates

| # | Item | Status | Evidence measured today |
| --- | --- | --- | --- |
| **1.5** | Cap per-conversation size | `TODO` | `studio/agent/agent-store.cjs:22-23` still caps only `MAX_AGENTS = 200` / `MAX_STORED_MESSAGES = 400`. `MAX_CONVERSATION_BYTES` → absent. Activity, todos and pending edits remain unbounded. |
| **1.7** | Rate-limit outbound agent requests | `TODO` | Still no client-side per-connection gate; an 8-member team can still drive a limited endpoint into parallel 429s. |
| **3.1** | Per-conversation storage instead of one `agents.json` | `TODO` | `agent-store.cjs` still documents "the whole thing lives in one JSON document under `userData/agents.json`". Corruption blast radius is still *all chats*. |
| **3.3** | Capture failed crew members so retry is cheap | `TODO` | Depends on 3.2; `team-runner.cjs` is now 1,250 lines with the most untested failure paths. |
| **3.6** | Close the integration-test gaps | `TODO` | 53 test files, 525 green tests — but the agent loop, the heart of the product, still has no direct end-to-end driver. |
| **2.3** | Single owner for the code index | `TODO` | TTL/invalidation still split from `code-index.cjs`. Must land **after** the phantom-symbol item. |

### Priority 2 — runtime value and release

| # | Item | Status | Note |
| --- | --- | --- | --- |
| **3.4** | Persist budget telemetry | `TODO` | `budgets.jsonl` → absent. Every request already carries its allowance; nothing is queryable. |
| **3.5** | Context-window visualizer | `TODO` | Low risk, visible payoff. |
| **4.1** | Ship Windows installers from CI | `PARTIAL` | Improved: `npm run dist:win` is now present in CI (was absent). A real Windows CI run is still the gate. |
| **4.2** | macOS notarization | `BLOCKED` | `build.mac.identity` is still `"-"`; needs the owner's Apple credentials. |
| **4.3** | Auto-update checker | `TODO` | `autoUpdater` → absent. |
| **4.4** | Extend Dependabot | `PARTIAL` | Improved: npm ecosystems now declared for `/studio`, `/vscode`, `/copilot/tray`. No pip manifest exists, so no pip job was invented — correct. |
| **4.5–4.7** | Log levels · browser history search · non-Windows telemetry | `TODO` | Independent, low-risk. 4.7 makes partial data safe by the existing "unavailable, never zero" rule. |

### Priority 3 — cross-surface and features

`5.1` (relay God class, 1,227 lines), `5.2` (four browser engines), `5.3` (`vscode/media/chat.js` 3,239
lines), `5.5` (flat `tests/`, now 52 entries), `5.7`, then the `6.x` feature table and `7.x` docs.
None of these is urgent; all are real. Treat `5.2` as the highest-risk of the group because a fix in
one browser engine silently misses the other three.

---

## 4. Items the plan lists as open that are now DONE

Recorded so a crew does not re-do finished work. Each was re-verified today.

| Item | Plan says | Measured today | Verdict |
| --- | --- | --- | --- |
| **1.2** IPC manifest + set-equality | `PARTIAL` — "`studio/ipc-manifest.json` → absent" | Manifest **present with 84 entries**; `test/ipc-manifest.test.cjs` exists; sets agree **in both directions** against handlers *and* the manifest; delta is exactly `browser:command` | **Set-equality half is `DONE`.** Residual = return-shape validation, which the manifest itself declares per-entry |
| **1.3** Guard `browser:command` | `DONE` | `preload.cjs:18-22` returns `{ok:false,err}` with a readable *"The browser is not ready"* message instead of an unhandled rejection | `DONE` confirmed |
| **3.7** Settings schema versioning | `DONE` | `schemaVersion` present in `settings-store.cjs`, `main.mjs` and tests | `DONE` confirmed |
| **5.4** Tray test entry | `DONE` | `copilot/tray` test entry present | `DONE` confirmed |
| **4.1** Windows packaging in CI | `PARTIAL` | `verify-improvements.sh` reports **Windows packaging in CI: true** | Advanced from absent → present; still needs a real Windows run |
| **7.4** `SECURITY.md` | `DONE` | `SECURITY.md` present at root | `DONE` confirmed |

**The one caveat on 1.2.** Every manifest entry still carries
`"returns": "... result shapes are not yet runtime-validated"`. The *channel set* is now
machine-checked; the *argument and return shapes* are still documentation. That residual is real and
is item **N2** in §5 — it is the difference between "the channel exists" and "the channel is safe to
call".

---

## 5. New findings — not in the existing plan

Each was measured today, and each is small.

### A1 · The baseline rots because it is hand-copied — `NEW`

**Evidence.** `IMPROVEMENTS_VERIFIED.md` §1, root `PROJECT_SUMMARY.md` §4/§5 and the tree now give
three different values for the same quantities (§2). The verify script already computes the truth;
the prose is copied from it by hand.

**Change.** Make the numbers generated. Two options, cheapest first:
(a) extend `docs/verify-improvements.sh` to emit a Markdown table, and reference it from both
documents with a `<!-- generated -->` block a reviewer can diff;
(b) add a `docs/verify-prose.sh` that greps the numbers out of the prose and fails on mismatch, wired
into CI beside the existing lint job.

**Done check.** Changing `studio/main.mjs` by one line without updating the prose fails a check.
*Effort: 2–3 h · Risk: low.*

### A2 · `docs/README.md` promises engine docs that do not exist — `NEW`

**Evidence.** The active-documents table lists `engines/STUDIO_BROWSER.md` and `engines/REACH_CLI.md`
as **maintained**. Both are **MISSING**. `verify-improvements.sh` itself reports
`Engine docs 2/4`.

**Change.** Either write the two documents or remove their rows. A "maintained" label on a missing
file is worse than no index at all — it sends a reader looking for something that was never written.

**Done check.** Every path in that table resolves, or is not in the table. *Effort: 15 min to fix the
index · Risk: none.*

### A3 · An in-flight `docs/engine/` → `docs/engines/` rename was left half-done — `NEW`

**Evidence.** `git status` shows four **deleted** files under `docs/engine/` (singular) —
`overview.md`, `browser-engine.md`, `browser-bridge.md`, `browser-fetcher.md` — while
`docs/engines/BROWSER_ENGINE.md` sits **untracked** and `docs/engines/README.md` is modified. The
directory was renamed; the move was never committed.

**Change.** Finish the rename as one commit: the four deletions, the new `BROWSER_ENGINE.md`, the
`engines/README.md` edit, and any inbound links. Leaving it open means every `git status` is noisy
and A2's confusion persists.

**Done check.** `git status --porcelain` shows no `docs/engine/*` deletions. *Effort: 20 min · Risk:
low — but it is someone else's in-flight work, so confirm before committing.*

### A4 · `.DS_Store` files are tracked-adjacent noise — `NEW`

**Evidence.** `git status --porcelain` reports `?? .DS_Store` and `?? docs/.DS_Store`. They are
neither ignored nor committed — they just re-appear in every status and diff.

**Change.** Add `.DS_Store` to `.gitignore`. *Done check:* the files stop appearing in
`git status --porcelain`. *Effort: 1 min · Risk: none.*

### N2 · Runtime return-shape validation for the 84 IPC channels — `NEW`

**Evidence.** `studio/ipc-manifest.json` has 84 entries and every one declares
`"returns": "See handler implementation; result shapes are not yet runtime-validated"`. The channel
*set* is enforced; the *shapes* are not. This is the residual of item 1.2 and the reason 1.4's
argument-validation gaps stay hand-maintained.

**Change.** Give each manifest entry a testable `returns` shape and validate it in one harness test
that invokes each channel with a valid fixture and asserts the returned key set. Keep
`browser:command` explicitly excluded, exactly as the set-equality test does.

**Done check.** A handler that starts returning a different key set fails `npm test` and names the
channel. *Effort: 1–2 days · Risk: medium (needs fixtures) · Depends: 2.1.*

### N3 · The documented Node version and the tested Node version differ — `NEW`

**Evidence.** `studio/.nvmrc` = `24`, `engines.node` = `">=24"`, and `studio/README.md` says "Node.js
24 LTS". The suite was executed today on **Node v22.23.0** and passed **525/525**. The repo is
therefore either over-constrained in its manifest, or under-verified in CI.

**Change.** Decide which, and make it true: widen `engines.node` to the actually-supported floor, or
pin CI/runners to 24 and treat 22 as unsupported. Do not leave it ambiguous — a contributor reading
`README.md` will install 24, and a CI runner may use something else.

**Done check.** The version in `README.md`, `.nvmrc` and `engines.node` agrees, and CI asserts it.
*Effort: 30 min · Risk: low.*

---

## 6. Collision map — one writer per file

Unchanged in substance from the plan's §10.1, still valid, with today's line counts:

| File | Items touching it | Rule |
| --- | --- | --- |
| `studio/main.mjs` (4,041) | 1.1, 1.8, 2.1, 2.6, 3.2, 3.4, 3.7 | **One writer until 2.1 lands** |
| `studio/renderer/app.js` (4,443) | 2.2, 6.1, 6.2, 6.4 | Serialize behind 2.2 |
| `studio/preload.cjs` (193) | 1.2, 1.3, N2 | One writer |
| `studio/ipc-manifest.json` (84 entries) | 1.2, 1.4, N2 | One writer |
| `studio/agent/agent-store.cjs` | 1.5, 3.1 | Serialize — 3.1 supersedes 1.5's shape |
| `studio/agent/code-index.cjs` (1,156) | 2.3, 0.2 | 0.2 **before** 2.3 |
| `docs/*.md` baselines | A1, A2, A3 | Land A1 **first**, then the prose edits become mechanical |

The frozen interfaces (`I1`–`I6`) and the invariant→check table (`A1`–`A9`) in
`IMPROVEMENTS_VERIFIED.md` §10.2–10.3 are **not restated here** — by that document's own rule they
live in exactly one place. This digest is careful not to become a second copy.

---

## 7. Verification — reproduce every number above

Run from the repository root on Node 24+ (see **N3** if your runner differs):

```sh
bash docs/verify-improvements.sh          # the baseline table in §2
(cd studio && npm test)                   # → 525 tests, 525 pass, 0 fail, exit 0
(cd studio && npm run test:coverage)
(cd studio && npm run smoke)              # needs a graphical session
(cd vscode && npm test)
(cd copilot/tray && npm test)
node tools/check-javascript.cjs
```

The IPC set-equality claim in §2 and §4 is reproduced by:

```sh
node -e "
const fs=require('fs');
const h=new Set([...fs.readFileSync('studio/main.mjs','utf8').matchAll(/^\s*ipcMain\.handle\('([^']+)'/gm)].map(m=>m[1]));
const p=new Set([...fs.readFileSync('studio/preload.cjs','utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m=>m[1]));
const m=Object.keys(JSON.parse(fs.readFileSync('studio/ipc-manifest.json','utf8')));
console.log('handlers',h.size,'channels',p.size,'manifest',m.length);
console.log('preload-only:',[...p].filter(c=>!h.has(c)).join(',')||'none');
console.log('handler-only:',[...h].filter(c=>!p.has(c)).join(',')||'none');
console.log('channel-not-manifest:',[...p].filter(c=>!m.includes(c)).join(',')||'none');"
```

### What this digest did **not** verify

Stated plainly, because a digest that overclaims is the problem it was written to fix:

- **Only the Studio unit suite was executed** (525/525, green). `npm run smoke`, `npm run
  test:coverage`, the VS Code suite, the tray suite and `tools/check-javascript.cjs` are listed as
  commands but were **not run here**.
- **No OS-level behaviour was tested**: notification delivery, Windows packaging, notarization and
  the container `--shm-size=1g` path all need their own platform runs. Items 1.8 and 4.1 stay
  `PARTIAL` for exactly this reason.
- **No file in this repository was modified by this digest**, other than the creation of this
  document — the `docs/engine/` deletions in **A3** and the `docs/README.md` modification were
  already present in the working tree.
- **Line counts are a proxy, not a judgement.** 4,041 lines is evidence of where the risk sits, not
  proof that a split is safe; `npm run smoke` is the safety net for 2.1 and 2.2.
