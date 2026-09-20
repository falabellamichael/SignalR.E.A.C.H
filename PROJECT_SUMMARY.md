# SignalR.E.A.C.H — Project Summary

> Generated from the working tree. Counts are measured, not asserted — see §8 for the verification commands.

## 1. What it is

SignalR.E.A.C.H is a monorepo (MIT-licensed, by Michael Anthony Falabella) centered on **REACH** — a **R**AG **E**ndpoint & **A**I **C**hat **H**ost — that exposes an OpenAI-compatible `/v1/chat/completions` endpoint with unlimited `gpt-4o`/`gpt-4o-mini`, plus the clients and tooling around it: a SimpleRAG control-panel plugin, a stdlib-only relay server, a VS Code chat extension + desktop tray, and a full Electron desktop workspace ("REACH Studio") with AI agents, teams, a browser, and optional Reach DApp CLI integration. Requests are relayed through a local OmniRoute instance's `codegpt` provider; access is gated by API keys (`sk-reach-…`). Current relay version: **26.9.5**.

## 2. Architecture & the four surfaces

There are four runtime surfaces, all talking to the same hosted endpoint:

| # | Surface | Language | Location | Role |
|---|---------|----------|----------|------|
| 1 | **Relay server** | Python (stdlib-only) | `server/reachd/` | The hosted endpoint itself: auth, rate limiting, caching, SSE streaming, analytics, publishing. Binds `127.0.0.1:20777`. |
| 2 | **SimpleRAG plugin panel** | JavaScript | `src/` (21 files) | Control panel (8 pages: Dashboard, Browser, Endpoint, Models, Usage, Logs, Settings, About) installed into SimpleRAG's app bar via a local-extension registry. |
| 3 | **VS Code extension + tray** | JavaScript (Electron) | `copilot/tray/` | Desktop tray (v1.1.0) serving **CodeGPT economy models** (`codegpt-eco-<id>`) from the host's signed-in CodeGPT session via a local bridge at `127.0.0.1:21302/v1`. |
| 4 | **REACH Studio desktop app** | JavaScript (Electron, Node 24) | `studio/` | Standalone macOS/Windows/Linux workspace: files + editing, conversations, personas, collaborating agent teams, browser, budgeting, telemetry. `main.mjs` = 3636 lines; 44 agent modules. |

Shared spine: the endpoint URL is a changing ngrok/cloudflared tunnel, always resolved through a **pointer gist** (id `e261e0c31ad08c373bcd667b6982847a`, file `simple-reach-endpoint.txt`). Studio and the VS Code extension share the same agent-tool / activity-timeline patterns.

## 3. Data / control flow (endpoint request path)

```
Client (curl / openai SDK / SimpleRAG / Studio)
   │  Authorization: Bearer sk-reach-…
   │  POST {endpoint}/v1/chat/completions   ── resolve URL via pointer gist first
   ▼
[RELAY 127.0.0.1:20777 — server/reachd/]
   │ 1. limits.py      — rate limiting (bucketed, MAX_RATE_BUCKETS=10000)
   │ 2. handler.py     — constant-time API-key check + failed-attempt lockout + IP allow/block
   │ 3. cache.py       — optional LRU cache (TTL, temperature-aware keys)
   ▼
   │ 4. alias routing:
   │    • gpt-4o[-mini]        → OmniRoute `codegpt/codegpt-gpt-4o[-mini]` (with bearer token)
   │    • codegpt-eco-<id>     → local tray bridge (`bridge/…` prefix → 127.0.0.1:21302/v1, NO token)
   ▼
   │ 5. stream SSE (OpenAI wire format) back to client
   ▼
[analytics.py + publish.py]  → record usage; re-publish live tunnel URL to the pointer gist
```

Key branch: economy models **do not** go through OmniRoute — they are served by the local tray bridge, because the economy tier exists only in the host's signed-in CodeGPT session. Economy model IDs are discovered live from the CodeGPT sidecar (`127.0.0.1:54112`) every five minutes, never hardcoded.

## 4. Key subsystems

| Subsystem | Where | Responsibility |
|-----------|-------|----------------|
| Relay core | `server/reachd/core.py`, `handler.py` | Request pipeline, alias routing, error handling |
| Security | `server/reachd/handler.py`, `limits.py` | API-key auth, lockout, IP lists, rate limits |
| Cache | `server/reachd/cache.py` | LRU response cache |
| Publishing | `server/reachd/publish.py` | Update pointer gist + hosting tunnel |
| Identity/analytics | `server/reachd/hostid.py`, `analytics.py` | Host identity, usage metrics |
| Economy-model bridge | `copilot/tray/economy-models.js`, `bridge.js` | Live sidecar discovery + tray-hosted economy models |
| Agent runtime | `studio/agent/` (44 modules) | Tool registry, agent loop, DSML, compaction, memory, budgets, refactor, code index, team runner, telemetry |
| Agent tools | `studio/agent/*-tools.cjs`, `tool-registry.cjs` | One registry declares every tool (class, approval, budget, help) — system prompt, parser allow-list, and executor all read it |
| Browser | `studio/browser/`, `studio/agent/browser-tools.cjs` | Sandboxed Electron views; 12 stateful verbs |
| IPC bridge | `studio/main.mjs` + `studio/preload.cjs` | Main↔renderer contract (see §5) |
| Studio build/test | `studio/package.json` | Electron-builder targets (dmg/zip/NSIS/portable/AppImage/deb/Flatpak), `npm test`, `npm run smoke` |

## 5. Interfaces / contracts that must not drift

1. **OpenAI wire format** — `/v1/chat/completions` request/response and SSE streaming must match the OpenAI schema (clients are `openai` SDK, SimpleRAG, Studio, VS Code).
2. **Studio IPC surface** — `main.mjs` handlers ↔ `preload.cjs` invoke channels. **Measured now: 76 handler registrations, 77 invoke channels.** The set difference is exactly `{browser:command}` (one dynamic channel, registered/removed at tab create/destroy). The baseline doc (`docs/STUDIO_IPC.md`) says 74/75 — the invariant (delta = `browser:command`) holds, but the absolute count has drifted **+2 on both sides** since that doc was written.
3. **Tool registry** — every agent tool is declared once in `studio/agent/tool-registry.cjs`; the system prompt, client parser allow-list, and executor must all read from it (enforced by `test/tool-policy.test.cjs`).
4. **Endpoint pointer gist** — the public URL is a changing tunnel; all clients resolve through the pointer gist, never a pinned URL.
5. **Economy alias ownership** — an alias already routed keeps its own upstream; economy defaults must never steal a name `main` points elsewhere.

## 6. Invariants + failure modes

- **Auth invariant:** API key required by default; constant-time comparison; failed attempts lock out; optional IP allow/block. *Failure mode:* none — access without a key is rejected by design.
- **IPC invariant:** static handler set = channel set minus `browser:command`. *Failure mode if it drifts:* renderer invokes `browser:command` before a tab exists → `No handler registered` unhandled rejection (preload wrapper does not guard this today).
- **Economy model drift:** the bundled catalog drifts (still lists `deepseek-v4-flash`, `gemini-3.6/3.7-flash`); the live sidecar wins whenever it answers. *Failure mode:* stale aliases when the sidecar is down (falls back to last-known-good list).
- **Port collision:** the local hosting relay and the client bridge both use port 20777 — running both on one machine collides. Stop the hosting relay before starting the client bridge.
- **Container shm:** Studio GUI container requires `--shm-size=1g`; Docker's 64MB default starves Chromium → `ERR_INSUFFICIENT_RESOURCES`.
- **Tunnel URL rotation:** the public URL changes when the host restarts; any pinned URL breaks. Always resolve via the pointer gist.

## 7. Repo layout map

```
SignalR.E.A.C.H/
├── server/            # stdlib-only Python relay (the hosted endpoint)
│   ├── reachd/        #   core, handler, limits, cache, publish, analytics, …
│   └── reachd.py
├── src/               # SimpleRAG plugin panel (21 files: pages, css, core)
├── copilot/tray/      # VS Code extension + Electron tray (v1.1.0), economy bridge
├── studio/            # REACH Studio desktop app (Electron, Node 24)
│   ├── agent/         #   44 agent modules (runtime, tools, teams, telemetry)
│   ├── browser/       #   sandboxed Electron browser host/page/agent
│   ├── test/          #   32 *.test.cjs files
│   ├── main.mjs       #   3636-line main process (76 IPC handlers)
│   └── preload.cjs    #   invoke channels (77) + event listeners
├── docker/            # reachd relay image + studio GUI (noVNC / native window)
├── installer/         # cachyos-lazyvim client setup
├── docs/              # STUDIO_IPC.md + improvement design docs
├── specs/             # AGENT_UPGRADE_PLAN.md, REFACTOR_LATEST.md
├── install.sh         # one-click Linux/macOS install
├── install.ps1        # one-click Windows install
└── CHANGELOG.md       # release-please generated history
```

## 8. Versioning / release

- Version is single-sourced at `server/reachd/const.py`: `VERSION = "26.9.5"` (marker `x-release-please-version`), mirrored in `README.md` and `src/plugin.json`.
- `CHANGELOG.md` is generated by **release-please** (`release-please-config.json`).
- Latest release **26.9.5** is a breaking change: relay now **requires an API key by default** and hardens access control (issue #91).
- Component versions: relay/plugin 26.9.5; copilot tray 1.1.0; VS Code extension 1.1.0; REACH Studio 1.0.0.

**Verification commands used (measured from the working tree):**

```bash
grep -oE "^\\s*ipcMain\\.handle\\('[^']+'" studio/main.mjs | sort -u | wc -l   # → 76 handlers
grep -oE "ipcRenderer\\.invoke\\('[^']+'" studio/preload.cjs | sort -u | wc -l  # → 77 channels
comm -13 <(handlers) <(channels)                                               # → browser:command only
wc -l studio/main.mjs                                                          # → 3636
ls studio/agent/*.cjs | wc -l                                                  # → 44 modules
ls studio/test/*.test.cjs | wc -l                                              # → 32 tests
ls src/*.js src/*.css | wc -l                                                  # → 21 files
```

## 9. Known gaps & open work

- **Docs drift:** `docs/STUDIO_IPC.md` still states 74/75 channels; the tree now has 76/77 (the delta invariant is intact, but the absolute numbers are stale). Also documents 28 tests where 32 exist.
- **`browser:command` preload guard:** the wrapper does not guard against invoking the dynamic channel before a tab exists (see §6).
- **IPC argument validation gaps:** `docs/STUDIO_IPC.md` marks some channels (e.g. `agents:setTodos`) as **GAP** — argument shape not checked before use.
- **Bundled economy catalog drift:** the shipped catalog is known-stale; it relies on the live sidecar to correct it.
- **Notarization:** local macOS Studio builds are ad-hoc signed, not notarized; public distribution needs Developer ID signing + notarization.
