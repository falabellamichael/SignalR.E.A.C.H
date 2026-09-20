# Whole-Repo Improvement Review

Generated: 2026-09-19
Scope: the entire repository — relay (`server/`), VS Code extension (`vscode/`), panel
(`src/`), desktop tray (`copilot/`), Studio (`studio/`), CLI (`tools/`), CI, Docker,
and repo hygiene.
Method: every item below was verified against the working tree at commit `0749309`
on `main`. Nothing here is inferred from older documents.

The earlier review ([`IMPROVEMENTS.md`](./IMPROVEMENTS.md) + [`IMPROVEMENTS_PRIORITIZATION.md`](./IMPROVEMENTS_PRIORITIZATION.md))
covered `studio/` plus repo infrastructure. Section 1 re-checks its claims; Section 2
covers the areas it never looked at.

---

## 1. Status of the earlier studio review

### 1.1 Re-verified as still open

| Earlier item | Current evidence |
|---|---|
| `studio/main.mjs` is a monolith | **3,481 lines**, **75** `ipcMain.handle` calls (was 3,389 / 74 — it grew) |
| `studio/renderer/app.js` is a monolith | **2,714 lines**, flat |
| No crash handlers in the main process | `grep uncaughtException\|unhandledRejection studio/main.mjs` → **no matches** |
| Access keys stored in plaintext | `grep -rl safeStorage studio/` → **no matches** |
| Non-atomic settings writes | `saveSettings` (line 158) and `saveProjects` (line 168) use plain `fs.writeFileSync`; only `agent/agent-store.cjs:52` does `renameSync` |
| Renderer CSP allows inline script | `script-src 'self' 'unsafe-inline'` in `renderer/index.html` |
| No linting / version pin | No ESLint, Prettier, or Biome config; no `.nvmrc`; no `.editorconfig` |
| Fragile `npm test` chain | Still **28 files joined by `&&`** in `studio/package.json` |
| Stray debug artifacts tracked in `tests/` | `tests/_chat_panel_preview.html`, `tests/browser-preview.html` |
| Windows installers not built in CI | Windows leg runs tests + smoke only; macOS and Linux have packaging steps |
| Node version story disagrees with itself | `engines.node: ">=22.12.0"`, `studio/README.md` says Node 24 LTS, CI uses `24`, this machine runs `v22.23.0` |
| Studio not under release-please | `studio/package.json` still `1.0.0` |
| Dirty working tree | 8 modified files across `studio/` and `vscode/context.js`, plus 2 untracked docs |

### 1.2 Corrections to the earlier review

Two claims in the earlier documents do not hold up:

- **No tracked `__pycache__`.** `git ls-files | grep pycache` returns nothing — only
  the two HTML files are tracked. `__pycache__/` is correctly gitignored.
- **Docker healthchecks *are* wired.** The earlier prioritization listed
  "`healthcheck.sh` exists but compose doesn't reference it". In fact
  `docker/studio/Dockerfile:62` and `docker/reachd/Dockerfile:37` both declare
  `HEALTHCHECK ... CMD ["/healthcheck.sh"]`, and Compose inherits image health
  checks automatically. This item should be dropped.

---

## 2. New findings

### 2.1 Relay (`server/reachd/`) — the dispatcher is the last monolith

1. **`handler.py` is a 1,227-line God class.** `RelayHandler(BaseHTTPRequestHandler)`
   starts at line 124 and carries **52 methods**. It mixes HTTP plumbing
   (`_read_body`, `_write_chunk`), CORS, auth and lockout (`_check_access`,
   `_note_auth_failure`, `_admin_token_ok`), rate-limit headers, routing
   (`do_GET`/`do_POST`/`do_PUT`/`do_DELETE`/`do_PATCH`), audit, key management
   (`handle_create_key`, `handle_ensure_key`), browser-engine proxying, settings,
   publish, diagnostics, and chat proxying. The relay was modularized into 16
   modules — but its dispatcher was not, so it is now the largest file in `server/`
   and the one place every concern still meets.

2. **`settings.py` (987) and `chat.py` (908)** are the next two largest relay
   modules. Worth confirming they are cohesive and not just "the other two big
   files".

3. **Three browser-engine implementations coexist**:
   `server/browser-engine/main.cjs`, `server/reachd/browser_engine.py`, and
   `src/browser-engine.js`. Each surface having its own engine is a
   behaviour-drift risk (a fix in one silently misses the other two).

### 2.2 VS Code extension (`vscode/`)

4. **`media/chat.js` is 3,217 lines** — the largest JavaScript file in the repo —
   and `extension.js` is 2,703 lines. Unlike Studio's `agent/` directory, the
   extension has no equivalent module split for its webview.

5. **`vscode/package.json` declares no `scripts` at all** — no `test`, no `lint`,
   no `build`. The extension's 25 test files live in root `tests/vscode_*.test.cjs`
   and are only runnable from the repo root, so an extension contributor working
   inside `vscode/` has no local entry point.

### 2.3 Desktop tray (`copilot/tray/`)

6. **`main.js` is 2,595 lines** in a single file (`package.json` and gen-icon
   script aside).
7. **No `test` script** in `copilot/tray/package.json`, despite 7
   `tray_*.test.cjs` files existing in root `tests/`.

### 2.4 Panel (`src/`)

8. **`reach.js` is 1,243 lines** with 9 `pages-*.js` peers loaded as flat classic
   scripts; there are no module boundaries between pages beyond file separation.

### 2.5 Release & versioning — wider than studio alone

9. **Three user-facing products are frozen outside release-please.**
   `release-please-config.json` has exactly one package (`"."`, at `26.9.5`), and
   its `extra-files` list covers `src/plugin.json`, `server/reachd/const.py`,
   `server/reachd.py`, `server/reachd/__init__.py`, `src/reach-core.js`, and
   `README.md` — but **not** any of:

   | Manifest | Version | Should track |
   |---|---|---|
   | `studio/package.json` | `1.0.0` | Studio releases |
   | `vscode/package.json` | `1.1.0` | VS Code extension releases |
   | `copilot/tray/package.json` | `1.1.0` | Tray releases |

   The earlier doc flagged only Studio. The same defect applies to all three, and
   because the manifests are not in `extra-files`, even a manual bump is not
   automated.

10. **`studio/scripts/check-syntax.cjs` does not recurse.** It does a flat
    `fs.readdirSync(dir)` per directory for `agent`, `browser`, `renderer`, `test`,
    `scripts`. Today those are flat, but the moment anyone adds a subdirectory,
    those files are silently unchecked with no warning.

### 2.6 CI & quality gates

11. **JavaScript parse coverage has holes.** The CI `lint` job runs
    `node --check` over `src/*.js vscode/*.js vscode/media/*.js copilot/tray/*.js`.
    Two tracked JS/CJS files fall outside every check in the repo:
    `server/browser-engine/main.cjs` and `tools/endpoint-client.cjs`.

12. **Dependabot only watches `github-actions`.** Nothing bumps npm or pip.
    `studio/` depends on Electron 44, esbuild, and 7 CodeMirror packages; CI runs
    `npm audit --audit-level=high`, but that surfaces advisories only — it never
    moves a dependency forward.

13. **Root `tests/` mixes four products with no separation** — Python relay tests
    (`test_reachd*.py`, `test_browser*.py`), tray tests (`tray_*.test.cjs`), VS Code
    tests (`vscode_*.test.cjs`), plus `browser_engine.test.cjs` and
    `endpoint_client.test.cjs`, all in one flat directory. `unittest discover -s tests`
    and `node --test tests/*.test.cjs` both run against the whole pile.

### 2.7 Repo & git hygiene

14. **Four throwaway probe scripts are committed**:
    `tools/_probe_all_models.py`, `tools/_probe_send.js`, `tools/_probe_slash.js`,
    `tools/_probe_stream_read.py`. These are one-off debugging harnesses, not tools.
15. **`tests/browser_preview.py`** is a preview/render helper sitting beside the two
    tracked HTML previews in the test directory.
16. **`.reach/` is untracked *and* unignored.** It currently holds
    `attachments/agent-…/` copies of the improvement docs — local runtime state
    generated by the app. Because `.gitignore` doesn't cover it, it shows up as
    noise in every `git status` and can be staged by accident.
17. **`.venv/` is not ignored as a directory.** `git check-ignore .venv` → not
    ignored; it only stays clean because the virtualenv ships its own `.gitignore`
    containing `*`. Delete that one file and the entire virtualenv becomes
    stageable.
18. **654 MB of build output sits in the working tree** at `studio/dist/`
    (gitignored, but present), against a tracked pack of only **2.59 MiB**.
19. **Three prunable worktrees** are still registered under `/private/tmp`:
    `reach-agent-pr`, `reach-github-9fdcb0e`, `signalreach-pr64`.
20. **Stale extension binaries** are lying around:
    `simplereach-1.0.0.vsix` (repo root), `vscode/simplereach-1.0.0.vsix`, and
    `vscode/simplereach-1.1.0.vsix`. Gitignored, but confusing next to the 1.1.0
    manifest.
21. **`installer/cachyos-lazyvim/` is unreferenced.** It ships a LazyVim/Neovim
    config (`install.sh`, `reach.lua`, `README.md`) for one Linux distribution. It
    is not mentioned in the root README and is unrelated to the relay, extension,
    panel, and Studio surfaces.

### 2.8 Docs & process

22. **No `CONTRIBUTING.md`, `SECURITY.md`, or `CODE_OF_CONDUCT.md`** anywhere in the
    repo — notable given the project ships an SSH-tunnel/key-minting access model
    and actively accepts PRs (release-please, PR-title checks, Dependabot are all
    configured).
23. **`README.md` is ~40 KB across 27 headings** and is itself a release-please
    `extra-file`, meaning it is rewritten on every release.
24. **`docs/` has no index and mixes genres** —
    `CODEGPT_ECONOMY_HANDOFF.md` (a handoff note) sits beside review documents, and
    this review makes three improvement docs total.

---

## 3. Suggested ordering

**Highest value, lowest risk (hours)**
- Convert `studio` `npm test` to `node --test "test/**/*.test.cjs"` (§1.1).
- Add the missing `node --check` targets (§11).
- Extend Dependabot to `npm` (`/studio`, `/vscode`, `/copilot/tray`) and `pip` (§12).
- Add `.gitignore` entries for `.reach/` and `.venv/` (§16, §17).
- `git worktree prune` and delete the stale `.vsix` files (§19, §20).

**Correctness and safety (days)**
- Crash handlers + atomic writes + `safeStorage` in Studio (§1.1).
- Resolve the Node version contradiction and add `.nvmrc` (§1.1).
- Add a `studio` package (and decide on `vscode` / `tray`) in
  `release-please-config.json` (§9).
- Add packaging for Windows in CI (§1.1).

**Structural (weeks, staged)**
- Split `RelayHandler` into concern modules behind a thin router (§1) — the same
  treatment `server/reachd/` already received, applied to the one file left behind.
- Split `studio/main.mjs` and `studio/renderer/app.js` (§1.1).
- Give `vscode/media/chat.js` and `copilot/tray/main.js` module boundaries (§4, §6).
- Consolidate the three browser engines (§3).

**Hygiene and docs (parallel, anytime)**
- Remove or relocate the `_probe_*` scripts and `browser_preview.py` (§14, §15).
- Add `CONTRIBUTING.md` and `SECURITY.md` (§22).
- Split root `tests/` into per-product subdirectories (§13).
