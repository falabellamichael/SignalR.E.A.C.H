# REACH Engine Architecture

SignalREACH ships three distinct engine systems, each solving a different problem:

| Engine | Language | Role | Location |
|--------|----------|------|----------|
| **Browser Engine** | JavaScript (Electron/Chromium) | Interactive offscreen browser with tab management, rendering, input, and snapshot | `server/browser-engine/main.cjs` |
| **Browser Engine Bridge** | Python | HTTP bridge + session management that exposes the Chromium engine to the relay | `server/reachd/browser_engine.py` |
| **Browser Fetcher** | Python | Stateless public page retrieval for the Reader mode (HTML/CSS/raster images only) | `server/reachd/browser.py` |

```
                    ┌─────────────────────────────────────────────────────────────────┐
                    │                          RELAY (Python)                          │
                    │                                                                  │
                    │  ┌─────────────────────────┐     ┌──────────────────────────┐   │
                    │  │ Browser Fetcher          │     │ Browser Engine Bridge    │   │
                    │  │ (browser.py)             │     │ (browser_engine.py)      │   │
                    │  │                          │     │                          │   │
                    │  │ fetch_page()             │     │ BrowserEngine.request()  │   │
                    │  │ • DNS + public IP guard  │     │ • Session management     │   │
                    │  │ • Content-type filter    │     │ • Tab ownership          │   │
                    │  │ • Compression handling   │     │ • Command validation     │   │
                    │  │ • Redirect chain (max 5) │     │ • Process lifecycle      │   │
                    │  └──────────────────────────┘     └──────────┬───────────────┘   │
                    │                                              │                   │
                    │                                          _ensure_process()      │
                    └──────────────────────────────────────────────┼───────────────────┘
                                                                   │
                                                    ┌──────────────┴───────────────┐
                                                    │  Browser Bridge HTTP API    │
                                                    │  (loopback, authenticated)  │
                                                    └──────────────┬───────────────┘
                                                                   │
                                                    ┌──────────────┴───────────────┐
                                                    │  Browser Engine (Chromium)   │
                                                    │  (server/browser-engine/)    │
                                                    │                               │
                                                    │  • 8-tab limit                │
                                                    │  • Offscreen rendering (15fps)│
                                                    │  • Input events (mouse/keys)  │
                                                    │  • DOM snapshot               │
                                                    │  • Console + network capture  │
                                                    │  • SSRF + navigation guards   │
                                                    │  • Software rendering (no GPU)│
                                                    └───────────────────────────────┘
```

## Quick reference

| System | When to read |
|--------|-------------|
| [`browser-engine.md`](./browser-engine.md) | "How does the interactive browser work? Tabs, rendering, input, navigation" |
| [`browser-bridge.md`](./browser-bridge.md) | "How does Python talk to Chromium? Sessions, commands, process management" |
| [`browser-fetcher.md`](./browser-fetcher.md) | "How does Reader mode fetch pages? DNS guards, content types, compression" |
| [AGENT_UPGRADE_PLAN.md](../specs/AGENT_UPGRADE_PLAN.md) | "How will the browser become an agent tool? `browser_open`, `browser_click`, etc." |

## Key design decisions

1. **Chromium is offscreen, not visible.** `show: false, frame: false, offscreen: true` in BrowserWindow options. The relay paints frames to the UI; the browser never appears as a native window.

2. **Loopback only.** All communication with the engine is on `127.0.0.1` with a random secret. The bridge never exposes a public API. This is intentional — the interactive browser is a desktop tool, not a server.

3. **Public-address enforced.** The fetcher validates DNS resolution before fetching. The Chromium engine validates URLs against a `publicIp()` check + Chromium's own `resolveHost()` call. Local-only URLs are blocked except for `localhost`.

4. **No debugger endpoint.** The engine starts without `--remote-debugging-port`. DevTools access would expose DOM contents and allow arbitrary JS execution — incompatible with the isolation model.

5. **Software rendering.** `app.disableHardwareAcceleration()` eliminates GPU memory leaks, driver crashes, and GPU process security surfaces. Frame capture uses Chromium's offscreen painting (`paint` event) + `Image.toJPEG()`.

## Related

- `docs/CODEGPT_ECONOMY_HANDOFF.md` — Economy model routing (not an engine, but uses the bridge for economy models)
- `docs/STUDIO_IPC.md` — Studio↔renderer IPC channels (the UI that displays browser frames)
- `specs/AGENT_UPGRADE_PLAN.md` — Plan to expose browser verbs as agent tools
