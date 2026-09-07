# Refactor Plan — SimpleREACH Modularization (v3.2.0)

Generated: 2026-07-09
Status: APPROVED — interview complete, all decisions recorded below.
Branch: `refactor/modular-v3.2.0` → PR to `main` (github.com/falabellamichael/SimpleREACH)

## Problem Statement

The codebase is organized as five monoliths that have grown with every release:

- **The relay server** is a single ~2200-line file. One HTTP handler class contains the
  routing, access control, admin endpoints, and a ~600-line chat request pipeline
  (field policy, clamps, prompt injection, alias resolution, fallback chains, caching,
  streaming, token accounting) all intermixed. Settings validation, the SQLite
  analytics store, the response cache, rate limiters, and circuit-breaker state sit in
  the same file.
- **The installer/manager CLI** is a single ~1140-line file holding registry logic,
  asset building, key discovery, process management, tunnel management, gist
  publishing, autostart registration, and ~15 commands in one flat namespace.
- **The control panel UI** renders all seven pages (Dashboard, Endpoint, Models,
  Usage, Logs, Settings, About) from one ~2613-line IIFE, with a ~2200-line
  single-file stylesheet.
- **The chat CLI** is a ~760-line single file mixing terminal rendering, DuckDuckGo
  scraping, HTTP client, grounding, and the REPL.

Why it is wrong: every small feature touches one of these files; a change to the Logs
page and a change to rate limiting land in the same file; there is no way to read,
review, or test one concern without loading all of the others. The single-file relay
also made "modularize without touching the installer" impossible to plan — the
installer's copy-one-file deploy assumption is the root of most of the friction.

**The one invariant that must be preserved (HARD GATE):** the installed system must
stay behavior-identical on the wire and on disk across the refactor — the same
OpenAI-compatible `/v1/*` responses, the same `/_reach/*` admin surface, the same
`config.json` schema and location (existing installs must keep working after upgrade),
the same extension-registry manifest format (only the asset list may grow), and the
same panel behavior. Every commit in this plan keeps the existing test suite green
and the relay bootable.

## Solution

Split all five monoliths into small, single-responsibility modules; keep the public
entry points (`reach.py`, `reachd.py`, `reach-cli.py`) as ~10-line thin shims so every
documented command, the autostart task, and existing user muscle memory keep working
unchanged. The installer deploys the packages as directories instead of single files
(old single-file runtime copies are pruned on upgrade). The panel is split into one
file per page that self-registers into a shared registry (classic scripts — the host
does not support ES modules), assembled by a slimmed-down `reach-pages.js`. Add
one-click installers (`install.ps1`, `install.sh`) that do the full setup: Python/git
check → clone → install (panel + relay + tunnel + publish) → autostart → print the
endpoint URL. Release as **v3.2.0** with a README rewrite that puts the one-click
path first.

### Target layout

```
server/
  reachd.py                  thin shim (loads the package, runs main)
  reachd/
    __init__.py              VERSION, SERVICE, shared constants
    __main__.py              argparse entry, poller/pruner/publisher threads
    text.py                  scrub_trailing_roles, count_tokens
    settings.py              DEFAULT_SETTINGS, validation, merge, public, config I/O
    analytics.py             Analytics (SQLite)
    cache.py                 ResponseCache
    limits.py                RateLimiter, CounterGate
    state.py                 RelayState (circuit, discovery, snapshots)
    publish.py               gist publish_url
    chat.py                  chat pipeline (transform, resolve/fallback, upstream, stream)
    handler.py               RelayHandler (routing, CORS, access, admin routes)
tools/
  reach.py                   thin shim
  reach/
    __init__.py, __main__.py
    config.py                config dir/paths, config load/save
    keys.py                  OmniRoute key discovery, masking
    registry.py              extension registry read/write/verify, package dirs
    build.py                 asset collection, validation, manifest building
    runtime.py               relay start/stop/restart, pid files, port checks
    tunnel.py                ngrok / cloudflared lifecycle, URL discovery
    publish.py               gist publishing
    autostart.py             startup-folder / scheduled-task registration
    http_admin.py            admin HTTP client, dotted-path get/set, coercion
    cli.py                   argparse + all cmd_* handlers
  reach-cli.py               thin shim
  reach_cli/
    __init__.py, __main__.py
    terminal.py              ANSI paint, spinners, status lines
    websearch.py             DDGParser, TextExtractor, search_web, fetch_text
    client.py                ReachClient, error types, URL discovery
    grounding.py             grounded message building
    chat.py                  REPL, one-shot ask, web answers, streaming output
src/
  reach.js                   unchanged (controller entrypoint)
  reach-core.js              unchanged
  pages-common.js            NEW: shared widgets (pageHeader, statTile, emptyNote) + registry
  pages-dashboard.js         NEW
  pages-endpoint.js          NEW
  pages-models.js            NEW
  pages-usage.js             NEW
  pages-logs.js              NEW
  pages-settings.js          NEW
  pages-about.js             NEW
  reach-pages.js             slimmed: assembles frozen window.__reachPages from the registry
  reach.css                  trimmed: tokens + shell + shared components
  reach-panels.css           NEW: dashboard/endpoint/models/usage/logs/about styles
  reach-settings.css         NEW: settings page styles
install.ps1                  NEW: Windows one-click (full setup)
install.sh                   NEW: Linux/macOS one-click (full setup)
```

Test files update their imports to the package modules as each module moves; test
assertions are never changed.

## Commits

Baseline (no commit): run `python -m unittest discover -s tests -v` on a clean `main`
and record the pass count; boot the relay once and curl `/health` + `/v1/models` to
confirm the starting point works.

### Phase 1 — Relay package (server/reachd.py → server/reachd/)

1. Scaffold `server/reachd/` package with `__init__.py` holding `VERSION`, `SERVICE`,
   and the shared module constants (ports, limits, gist ids). `server/reachd.py`
   imports them from the package instead of defining them.
   → verify: `python -m unittest discover -s tests` + `python -c "import sys; sys.path.insert(0,'server'); import reachd; print(reachd.VERSION)"`

2. Move `scrub_trailing_roles` and `count_tokens` into `reachd/text.py`; the old file
   re-exports them (keeps any direct references working); scrubber tests still import
   via the package.
   → verify: `python -m unittest discover -s tests`

3. Move the settings block (DEFAULT_SETTINGS, the `_expect`/`_int`/`_float`/…
   validators, `validate_settings`, `_validate_model_spec`, `merged_settings`,
   `settings_public`, `config_dir`, `load_config`, `save_config`) into
   `reachd/settings.py`; update test imports to `reachd.settings` in the same commit.
   → verify: `python -m unittest discover -s tests`

4. Move the `Analytics` class into `reachd/analytics.py`; update its test imports.
   → verify: `python -m unittest discover -s tests`

5. Move `ResponseCache` into `reachd/cache.py` and `RateLimiter` + `CounterGate` into
   `reachd/limits.py`; update test imports for both.
   → verify: `python -m unittest discover -s tests`

6. Move `RelayState` into `reachd/state.py` (imports settings/analytics from sibling
   modules).
   → verify: `python -m unittest discover -s tests`

7. Move `publish_url` (gist publishing) into `reachd/publish.py`.
   → verify: `python -m unittest discover -s tests` + `python -c "import sys; sys.path.insert(0,'server'); import reachd; reachd.main"` boots (import check only)

8. Extract the chat request **transform** half out of the handler into
   `reachd/chat.py`: blocked-field policy, size caps, temperature clamp, max-tokens
   cap, system-prompt injection, per-alias spec application, alias resolution +
   fallback selection, and the cache-key builder. The handler calls these functions;
   no behavior change (pure move).
   → verify: `python -m unittest discover -s tests` + manual: boot relay on scratch LOCALAPPDATA, `curl /health` and a non-stream `POST /v1/chat/completions` (expect a relayed answer or a well-formed 502 if the upstream is down)

9. Extract the chat **execution** half into `reachd/chat.py`: the upstream HTTP call,
   SSE stream relay (chunk teardown + client-abort handling), token/speed
   accounting, cache reads/writes, and logging hooks. `handle_chat` in the handler
   shrinks to a thin delegation.
   → verify: same manual smoke as commit 8, including a `stream: true` request and a
   mid-stream Ctrl-C (aborted client must not wedge the server)

10. Move the entire `RelayHandler` class into `reachd/handler.py` (routing, CORS,
    JSON helpers, access control, rate-limit headers, and all admin route handlers:
    settings get/put/test/reset, upstream test, publish, public-url override, cache
    clear, stats, logs).
    → verify: `python -m unittest discover -s tests` + manual: `curl` every admin
    route listed in the file docstring against the scratch relay

11. Move `main()` (argparse, server + poller/pruner/publisher threads) into
    `reachd/__main__.py`; `server/reachd.py` becomes the thin shim:
    add the package to the path, import `reachd.__main__.main`, call it under
    `__main__`.
    → verify: `python -m unittest discover -s tests` + `python server/reachd.py --help` + scratch boot

### Phase 2 — Installer package (tools/reach.py → tools/reach/) — DONE (commits 5ab4745..693c370)

 1. Scaffold `tools/reach/` package (`__init__.py` with shared constants: repo/urls,
    port, limits, paths) and turn `tools/reach.py` into a thin shim importing
    `reach.cli.main`. All existing code still lives in the shim temporarily? No —
    the shim imports from the package, and the package's `cli.py` is created with a
    `main` that (for now) is a re-export of the current body. Concretely: move the
    current body verbatim into `reach/cli.py`, leave the shim as two lines.
    → verify: `python -m unittest discover -s tests` + `python tools/reach.py status`

 2. Move config paths + config load/save into `reach/config.py`; move
    `find_omniroute_key` + `mask_key` into `reach/keys.py`.
    → verify: `python tools/reach.py status` + `python tools/reach.py settings` (read-only)

 3. Move the extension-registry logic (read/write/verify/upsert, package dir,
    registry entry) into `reach/registry.py`; move asset collection/validation and
    manifest building into `reach/build.py`.
    → verify: `python -m unittest discover -s tests` + scratch install
    (`LOCALAPPDATA=<tmp> python tools/reach.py install --no-start --tunnel none`)

 4. Move relay process management (`start_server`, `stop_server`, `restart`, pid
    read/kill, port checks, interpreter resolution) into `reach/runtime.py`.
    → verify: scratch `install --no-start` + `start` + `status` + `stop` cycle

 5. Move tunnel management (ngrok/cloudflared discovery and lifecycle,
    cloudflared URL wait, public-url override post) into `reach/tunnel.py` and gist
    `publish` into `reach/publish.py`.
    → verify: `python tools/reach.py start --tunnel none` + `status` + `stop`

 6. Move autostart (startup folder, scheduled task register/remove, `.bat`
    generation) into `reach/autostart.py`.
    → verify: `python tools/reach.py register-autostart` + `status` + `uninstall --all` in scratch env, then confirm removal

 7. Move the admin HTTP helpers (`admin_request`, `require_relay`, dotted-path
    get/set, value coercion) into `reach/http_admin.py`; `cli.py` keeps only
    argparse + `cmd_*` bodies.
    → verify: `python -m unittest discover -s tests` + `settings`, `models list`,
    `stats`, `logs`, `status` smoke against the running scratch relay

 8. **Deploy layout change:** the installer now copies the `server/reachd/` package
    directory and the `tools/reach/` package directory (plus their shims) into the
    runtime dir instead of the two single files; on upgrade it deletes any legacy
    single-file runtime copies; `start_server` launches the deployed shim. Update
    the install/uninstall/status messages that print paths.
    → verify: scratch full install with a pre-seeded "old layout" (single-file
    copies placed in the scratch runtime dir first) — after install, old files are
    gone, relay starts, `status` shows running, `settings` round-trips one key,
    `uninstall --all` cleans up

### Phase 3 — Chat CLI package (tools/reach-cli.py → tools/reach_cli/) — DONE (commits e0dfcbc..2ac52a6)

 1. Scaffold `tools/reach_cli/` package; move the current body verbatim into
    `reach_cli/chat.py` as a temporary home for `main`; `tools/reach-cli.py` becomes
    the thin shim.
    → verify: `python tools/reach-cli.py --help` (argparse wiring intact)

 2. Move terminal rendering (ANSI enable, Paint, color helpers, spinners, status
    lines) into `reach_cli/terminal.py`.
    → verify: `python -m unittest discover -s tests` + `--help`

 3. Move the web-search block (DDGParser, TextExtractor, `_open`, `search_web`,
    `fetch_text`) into `reach_cli/websearch.py`; update `tests/test_reach_cli.py` to
    import from the package (add `tools/` to the path, `import reach_cli.websearch`)
    in the same commit — assertions unchanged.
    → verify: `python -m unittest discover -s tests` (parser + extractor tests green)

 4. Move the client (`ReachClient`, `ReachApiError`, `_error_text`,
    `discover_public_url`) into `reach_cli/client.py` and grounding
    (`build_grounded_messages`) into `reach_cli/grounding.py`; update the grounding
    test imports.
    → verify: `python -m unittest discover -s tests` + `python tools/reach-cli.py ask --help`

 5. Move the REPL / one-shot ask / web answer / streaming output into
    `reach_cli/chat.py` (final home) and the entry into `reach_cli/__main__.py`; the
    shim delegates.
    → verify: `python -m unittest discover -s tests` + `python -m reach_cli --help`
    (from `tools/`) + manual `python tools/reach-cli.py ask "hi"` against the
    running scratch relay

### Phase 4 — Panel JS split (src/reach-pages.js → per-page registry)

 1. Add `src/pages-common.js`: defines `window.__reachPageRegistry = {}` (plus
    `defs` list) and the shared widgets (`pageHeader`, `statTile`, `emptyNote`) that
    move out of the pages IIFE; registers nothing itself. Add it to `SCRIPT_SOURCES`
    after `reach-core.js` in the same commit.
    → verify: `node --check` on every src/*.js + scratch install (asset validation +
    manifest hashing pass with the new asset list)

26-32. One commit per page — Dashboard, Endpoint, Models, Usage, Logs, Settings,
    About. Each: create `src/pages-<id>.js` as an IIFE that defines the renderer and
    registers it on `window.__reachPageRegistry` (reusing the shared widgets),
    removes the renderer from `reach-pages.js`, and adds the file to
    `SCRIPT_SOURCES` (before `reach-pages.js`) in the same commit. Pure code move —
    no rendering logic changes.
    → verify (each): `node --check` on all src/*.js + scratch install + node
    registry smoke: a tiny node script that stubs `window`/`document`-free globals,
    loads core → common → pages in order, and asserts the expected registry keys are
    populated

 1. Slim `reach-pages.js` to the assembly step: build and freeze
    `window.__reachPages` from `window.__reachPageRegistry` (fail with the existing
    boot-failure message if any of the seven pages is missing).
    → verify: full node registry smoke asserting all seven keys + scratch install

### Phase 5 — CSS split (src/reach.css → 3 files)

 1. Split the stylesheet: `reach.css` keeps the tokens, shell, and shared-component
    rules; add `src/reach-panels.css` (dashboard, endpoint, models, usage, logs,
    about rules) and `src/reach-settings.css` (settings-page rules), moving rule
    blocks verbatim. Add both to `STYLE_SOURCES` in the same commit.
    → verify: scratch install (style assets validate) + byte-level check that the
    union of the three files contains every selector that was in the old single file
    (a quick script diffing selector lists)

### Phase 6 — One-click installers + release

 1. Add `install.ps1` (Windows, `#Requires -Version 5.1`): check Python 3.9+ and git
    (friendly message + exit code if missing), clone the repo (or reuse an existing
    checkout in the install dir and `git pull`), run
    `python tools/reach.py install` (panel + relay + tunnel + publish), register
    autostart, and print the local + public endpoint URLs. Idempotent: re-running
    upgrades in place.
    → verify: run on this machine from a clean install dir; confirm registry entry,
    running relay, tunnel URL, autostart registration

 2. Add `install.sh` (bash, `set -euo pipefail`): same flow for Linux/macOS — Python
    3 + git check, clone/pull, install, autostart (startup-folder equivalent via the
    existing cross-platform path in the CLI), print URLs.
    → verify: `bash -n install.sh` (syntax) + full dry run where the platform
    permits; at minimum the Python-side steps are the same already-tested CLI path

 3. Update `README.md`: Install section leads with the one-click scripts
    (`irm …/install.ps1 | iex`-style or download-and-run for Windows;
    `curl … | bash` for Unix), the manual two-line path stays as the documented
    fallback; note the modularized layout; keep the CLI reference accurate.
    → verify: README links/commands match the actual script names and CLI surface
    (manual check)

 4. Bump the version to **3.2.0** in the plugin manifest and the relay package
    `__init__.py`; update the version row in the README table.
    → verify: `python -m unittest discover -s tests` + scratch install shows
    3.2.0 in `status`

### Phase 7 — Wrap-up

 1. Final end-to-end smoke on the real (non-scratch) machine: `install` (upgrade
    path from the currently-installed 3.1.1), `status`, restart, curl `/health`,
    `/v1/models`, one non-stream and one streaming chat completion, one admin
    settings round-trip, and open the REACH panel in SimpleRAG to eyeball all seven
    pages.
    → verify: all of the above pass; old 3.1.1 runtime files pruned from the
    runtime dir

 2. Push `refactor/modular-v3.2.0` to origin and open a PR to `main` with a summary
    of the layout, the invariant, and the smoke checklist.
    → verify: `gh pr view` shows the PR; CI/remote shows the pushed commits

## Decision Document

- **Scope:** all five monoliths are modularized (relay, installer, chat CLI, panel
  pages, stylesheet), per the developer's choice of "all 5 files".
- **Entry points:** `reach.py`, `reachd.py`, and `reach-cli.py` remain as thin shims
  (≈10 lines each) so every documented command, the autostart `.bat`, PID files, and
  existing user workflows keep working unchanged. Packages live alongside their
  shims: `server/reachd/`, `tools/reach/`, `tools/reach_cli/`.
- **Deploy layout (changed, approved):** the installer deploys the package
  directories (plus shims) into the local runtime dir instead of two single files;
  the installer prunes legacy single-file runtime copies on upgrade, so existing
  installs migrate automatically on the next `install`/`update`.
- **Installer behavior (changed):** the relay is started by running the deployed
  `reachd.py` shim (same command shape as today); nothing about the process model,
  PID handling, log files, or port changes.
- **Panel architecture:** classic scripts only (the host loads plain `<script>`-style
  assets in `SCRIPT_SOURCES` order — no ES modules). Pages self-register into
  `window.__reachPageRegistry`; `pages-common.js` owns shared widgets and the
  registry; slimmed `reach-pages.js` assembles the frozen `window.__reachPages`
  surface that `reach.js` already consumes (unchanged).
- **CSS:** split into three files (base, panels, settings) by adding entries to
  `STYLE_SOURCES`; order is base → panels → settings. No rule rewrites, only moves.
- **Config/protocol invariants:** `config.json` path + schema unchanged; `/v1/*` and
  `/_reach/*` wire behavior unchanged; extension-registry manifest format unchanged
  (the asset list grows, which the host already supports since it hashes each
  asset); the gist pointer contract unchanged.
- **New files (root):** `install.ps1` (Windows) and `install.sh` (Linux/macOS), both
  performing the full setup: Python/git preflight → clone-or-pull → `reach.py
  install` (panel + relay + tunnel + publish) → `register-autostart` → print URLs.
  Both are idempotent (re-run = upgrade).
- **Versioning:** released as v3.2.0 (plugin manifest + relay package + README),
  which signals the upgrade path that migrates the deploy layout.
- **No new dependencies:** everything stays stdlib-only (Python) and dependency-free
  (JS); no build step, no bundler.
- **Test files:** updated only for import paths as modules move; assertions are
  never edited. The chat CLI tests switch from loading the file by path to importing
  the package.
- **Delivery:** feature branch `refactor/modular-v3.2.0`, pushed to
  `github.com/falabellamichael/SimpleREACH`, PR opened to `main`.

## Testing Decisions

- **What makes a good test here:** tests assert external behavior — settings
  validation/merge outcomes, analytics queries against a real (temp) SQLite file,
  rate-limiter verdicts, cache hit/miss semantics, scrubber output, DDG/parser
  output on fixtures, grounded-message construction — never private internals of a
  module. The refactor must not require changing a single assertion.
- **Modules covered by existing tests (kept green every commit):** settings
  validation + merge, analytics, rate limiter, response cache, role scrubber, DDG
  parser, text extractor, grounding.
- **Prior art:** `tests/test_reachd.py` (unittest, temp dirs, direct import after a
  `sys.path` insert) and `tests/test_reach_cli.py` (importlib file-load, HTML
  fixtures) are the models for any new test file this refactor adds (none planned —
  see below).
- **Coverage gap (accepted by the developer):** the ~600-line chat pipeline and the
  installer have no automated tests. The agreed safety net is: (a) the existing suite
  green on every commit, (b) the manual smoke at the end of the chat-extraction
  commits (boot relay on a scratch LOCALAPPDATA, non-stream + streaming completions,
  client-abort, admin routes), and (c) the Phase-7 end-to-end smoke on a real
  install. Adding HTTP integration tests for the pipeline is a natural follow-up
  epic, explicitly out of scope here.

## Out of Scope

- No changes to the OpenAI wire format, the admin API, the settings schema, the
  config file location/format, the gist pointer, or the tunnel mechanics.
- No new automated tests for the chat pipeline or the installer (developer chose
  existing tests + manual smoke).
- No ES-module conversion of the panel JS (host constraint) and no bundler/build
  step (stays stdlib-only / dependency-free).
- No SimpleRAG host-side changes, no CI setup, no pip/npm packaging, no i18n.
- No rewrite of panel rendering logic or CSS rule rewrites — JS/CSS changes are
  pure moves (except the registry wiring itself).
- Nothing about the OmniRoute upstream integration beyond relocating it.

## Further Notes

- The registry-wiring commits (Phase 4) are the only JS commits that touch logic
  rather than moving code; they are the most likely source of a subtle panel bug.
  The node registry smoke (loading scripts in `SCRIPT_SOURCES` order with a stubbed
  `window`) plus the Phase-7 eyeball pass in real SimpleRAG cover this.
- The deploy-layout commit (commit 19) is the only commit that changes installed
  behavior at all (file locations under the local runtime dir). It is deliberately
  isolated, with a scratch-install verification that pre-seeds the old layout to
  prove the migration path.
- `reach-cli.py` is repo-only (never deployed); its shim exists purely for command
  compatibility.
- Suggested next skill after this plan is approved: `kickoff-branch` to create
  `refactor/modular-v3.2.0` and capture the test baseline.
