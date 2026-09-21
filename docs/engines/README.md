# `docs/engines/` — the four engine surfaces

Every "engine" in this repo is a process boundary or an execution surface that runs
code the user (or the agent) cannot fully control. There are **four**, and this
directory holds exactly one deep-dive document per surface. Line counts below were
measured with `wc -l` in this round; `docs/verify-improvements.sh` re-measures them
on every run (`<file> lines` + `Engine docs N/4`).

## The four surfaces

| Doc | Surface | Files (measured lines) | Runs | Talks to |
| --- | --- | --- | --- | --- |
| [`BROWSER_ENGINE.md`](./BROWSER_ENGINE.md) | **Offscreen Chromium engine** — relay-side interactive browser | `server/browser-engine/main.cjs` (480), `server/reachd/browser_engine.py` (372), `server/reachd/browser.py` (436), `src/browser-engine.js` (181) | One Electron subprocess, spawned by the relay | HTTP `127.0.0.1:<random>`, Bearer secret; relay web panel via `POST /_reach/browser/engine` |
| [`STUDIO_BROWSER.md`](./STUDIO_BROWSER.md) | **Studio in-app browser** — Electron `WebContentsView` tabs inside the desktop app | `studio/browser/host.cjs` (223), `studio/browser/agent.cjs` (63), `studio/browser/page.cjs` (85) | In-process, in the Studio main process | Renderer via IPC `browser:command` (dynamic channel, item 1.2/1.3 of the plan) |
| [`REACH_CLI.md`](./REACH_CLI.md) | **Reach CLI surface** — `reach` compile/run/init/clean/version as agent tools | `studio/agent/platform.cjs` (59), `studio/agent/reach-process.cjs` (67), `studio/agent/reach-tool-executor.cjs` (106) | Subprocess (`reach` directly, or `wsl.exe -d Ubuntu -- reach` on Windows) | Main-process run-event bus (`onRunEvent`); agent tool registry |
| [`README.md`](./README.md) *(this file)* | **Relay Reader fetcher** — stateless public-page retrieval (documented inline, §4) | `server/reachd/browser.py` (436) | In the relay process, stdlib only | Public web (pinned connections, public-IP-only) |

The fetcher shares `browser.py` with the Chromium surface (it is imported by
`browser_engine.py` for `_parse_url`), so its deep dive lives in
[BROWSER_ENGINE.md §6](./BROWSER_ENGINE.md) and is summarized here in §4.

## Architecture map

```
                         RELAY (Python, server/reachd/)
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  handler.py                                                              │
│   ├─ POST /_reach/browser/engine  ─────────────┐                         │
│   ├─ POST /_reach/browser/fetch  ──┐           │                         │
│   └─ POST /_reach/browser/resource │           │                         │
│                                    ▼           ▼                         │
│   browser.py (fetch_page)    browser_engine.py (ENGINE singleton)        │
│   • DNS + public-IP gate     • session tokens, tab prefix isolation      │
│   • pinned connections       • process lifecycle + watchdog (20 s)       │
│   • content-type gates       • 16 actions, 16 concurrent slots           │
│   • ≤ 5 redirects, 12 s      • MAX 32 sessions / 8 tabs                  │
│   • script-shell fallback → engine one-shot render (handler.py)          │
│                                    │ HTTP 127.0.0.1, Bearer secret       │
└────────────────────────────────────┼─────────────────────────────────────┘
                                     ▼
                       main.cjs (Electron, offscreen Chromium)
                       • 17 dispatch cases, 8 tabs, 64 pending commands
                       • publicUrl(): parseUrl → resolveHost → publicIp
                       • console ring (200) + network ring (100) per tab
                       • no debugger port, software rendering, 15 fps

   Web panel (src/browser-engine.js, 181) ──▶ /_reach/browser/engine
   Canvas-painted interactive surface; polls `frame` every 80 ms (500 ms
   hidden); input coalesced into ≤ 64-event batches.

   STUDIO (Electron main process)  ── not the relay, a separate surface
   host.cjs (WebContentsView tabs) + agent.cjs (agent ops) + page.cjs
   (isolated-world DOM action, world id 999)
        ▲ IPC browser:command (guarded, item 1.3)
   Renderer app.js + agent tools (browser-tools.cjs)

   REACH CLI  ── another separate surface
   reach-tool-executor.cjs → reach-process.cjs (run bus) → platform.cjs
   (spawn/kill; WSL on Windows; PATH enrichment for Finder-launched apps)
```

## Key invariants (each is checked by a document)

1. **One Chromium process per relay.** `ENGINE = BrowserEngine()` is a module
   singleton; `handler.py` imports it, it is never re-instantiated. Any second
   `BrowserEngine()` would launch a second engine. *(BROWSER_ENGINE.md §2)*
2. **The engine is only reachable at `127.0.0.1` with a per-launch random
   Bearer secret** (≥ 32 chars, `secrets.token_urlsafe(48)`); the port is
   ephemeral (bound to `0` at launch). No debugger port exists.
   *(BROWSER_ENGINE.md §3)*
3. **Public-address enforcement is per-hop, not per-URL.** The fetcher
   re-resolves and re-checks every redirect (max 5); the engine checks
   navigation, redirects, *and* `window.open` targets via `publicUrl()`, which
   uses Chromium's own `resolveHost()` so check and connect resolve the same
   address. *(BROWSER_ENGINE.md §5, §7)*
4. **Studio and the relay are separate browser surfaces and must not be
   merged silently.** Studio uses in-process `WebContentsView`s (item 5.2 of
   `IMPROVEMENTS_VERIFIED.md` tracks consolidating the four implementations);
   docs must keep the boundary explicit. *(STUDIO_BROWSER.md §1)*
5. **Studio agent ops are ref-based, not coordinate-based.** The agent reads
   the page, gets element `ref`s from `page.cjs`, and acts on refs; refs are
   `documentId`-scoped and go stale when the document changes. Password/file
   inputs are refused. *(STUDIO_BROWSER.md §4)*
6. **Reach CLI commands run in the bound project directory only.**
   `safeProjectPath` rejects absolute paths, drive letters, `~`, and `..`;
   the executor defaults to `index.rsh`; a 10-minute timeout kills the whole
   process tree. *(REACH_CLI.md §3)*
7. **Numbers are measured, never remembered.** Every line count, limit and
   action list in these docs is re-checkable with the command printed next to
   it. If the tree changes, fix the doc in the same change.

## 4. The Reader fetcher, in one screen (full deep dive: BROWSER_ENGINE.md §6)

`fetch_page(url, kind)` — `kind` ∈ `page | image | style`.

- **Gates:** `http/https` only, no credentials, host ≤ 253, port 1–65535;
  DNS via a 4-worker pool; **every** returned address must be globally
  routable (no private/loopback/link-local/multicast/reserved, no
  Teredo/6to4/IPv4-mapped/SIIT). Loopback is allowed **only** on the first
  hop for literal `localhost`-family hosts (local dev servers).
- **Transport:** `_PinnedConnection` connects to the pre-validated address
  (no second DNS lookup → no rebinding), keeps SNI, ignores proxy env, and
  runs a `threading.Timer` watchdog against a 12 s deadline checked on every
  read.
- **Body:** 2 MB pages / 512 KB resources; gzip/deflate/brotli decode with a
  +64 KB slack for compressed bodies; image signatures verified against the
  declared content type; `_looks_svg()` stops SVG masquerading as an image.
- **Output:** `page` → `{url,title,html,text,content_type,truncated}`
  (scripts/styles/svg/head stripped by `_PageText`); `image` → base64;
  `style` → raw CSS text.
- **Escalation:** when a fetched page looks like a script-rendered shell
  (Vite/React: little text + `type=module`), `handler.py`
  `_browser_engine_render()` does a one-shot engine render and returns the
  DOM snapshot instead — the fetcher and the engine are fallbacks for each
  other, and that relationship is the point of this directory existing.

## Document contract for this directory

Each deep dive is organized the same way, so a reader can jump to any claim:

1. **What & why** — one paragraph; the surface's role and its boundary.
2. **File map** — every file with measured line count (`wc -l` command printed).
3. **Lifecycle / entry points** — who starts it, what it speaks, with the
   exact constants (ports, tokens, timeouts, limits) and the source line.
4. **Protocol / API** — request and response shapes, field-by-field.
5. **Security model** — every gate, in order, with the code that enforces it.
6. **Limits & error taxonomy** — table of caps and the error/status codes
   each layer emits.
7. **Relationships** — which other surface it touches, and through what.
8. **Verified against** — the commands run in this round and their output.

Rules: cite `path:line` for every non-obvious claim; state limits as
`measured` numbers; never copy a number from another doc without re-running
the command; keep cross-links inside `docs/engines/` and to
`IMPROVEMENTS_VERIFIED.md` (the one file allowed to state plan numbers).

## Related

- [`../IMPROVEMENTS_VERIFIED.md`](../IMPROVEMENTS_VERIFIED.md) — item 5.2
  ("Three browser engines coexist") is the open consolidation work this
  directory is structured for; item 1.3 (guard `browser:command`) and
  5.6 (parse coverage over the engine files).
- [`../STUDIO_IPC.md`](../STUDIO_IPC.md) — the `browser:command` channel in
  the IPC surface table.
- [`../../specs/AGENT_UPGRADE_PLAN.md`](../../specs/AGENT_UPGRADE_PLAN.md) —
  the VS Code extension's browser-verb tools (a fifth surface, documented
  there, not here).
- [`../README.md`](../README.md) — the docs index.
