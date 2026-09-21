# Browser Engine Bridge — `server/reachd/browser_engine.py`

**The Python HTTP bridge to the Chromium engine.** This module manages the lifecycle of the
offscreen Chromium process, validates commands, handles session ownership, and enforces
rate limits — all while keeping the engine process alive and responsive.

**File:** `server/reachd/browser_engine.py` (373 lines)
**Talks to:** `server/browser-engine/main.cjs` (HTTP on `127.0.0.1`)
**Talked by:** `server/reachd/browser.py` (reader mode uses the engine for screenshots) and
  the Studio renderer IPC handlers (browser tab UI)

---

## 1. Architecture

The bridge is a **stateful singleton** (`ENGINE = BrowserEngine()`) registered at module load.
It sits between the relay (Python) and the Chromium engine (Electron/Node.js):

```
┌──────────────────────────────────────────────────────────────┐
│  Relay / Studio (Python)                                     │
│  BrowserEngine.request(body)                                 │
└──────────────────────────┬───────────────────────────────────┘
                           │  Python method call
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  BrowserEngine (browser_engine.py)                           │
│                                                              │
│  ┌─────────────────┐    ┌──────────────────┐                │
│  │ Session mgmt    │    │ Command pipeline │                │
│  │ • token→tabs    │    │ • _command_body()│                │
│  │ • SESSION_TTL   │    │ • _command()     │                │
│  │ • MAX_SESSIONS  │    │ • watchdog       │                │
│  │ • stale cleanup │    │                  │                │
│  └─────────────────┘    └────────┬─────────┘                │
│                                  │                           │
│  ┌───────────────────────────────┴─────────┐                │
│  │ Process lifecycle                       │                │
│  │ • _ensure_process()                     │                │
│  │ • _watch_process()                      │                │
│  │ • _fail_process()                       │                │
│  │ • _read_diagnostics()                   │                │
│  └─────────────────────────────────────────┘                │
└──────────────────────────┬───────────────────────────────────┘
                           │  HTTP (127.0.0.1, Bearer auth)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Browser Engine (Chromium)                                   │
│  server/browser-engine/main.cjs                              │
│  POST /command  →  { id, result/error }                      │
│  GET  /status   →  { ready, engine, version }                │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Process lifecycle

### Startup (`_ensure_process`)

1. **Acquire** the `_start_lock` (single-writer)
2. If a process is already running (`poll() is None`), return it immediately
3. If an existing process died, call `_fail_process()` to clean up
4. **Resolve the Electron executable:**
   - Try `%LOCALAPPDATA%\SignalREACH\copilot\tray\node_modules\electron\dist\electron.exe` (installed)
   - Fall back to `copilot/tray/node_modules/electron/dist/electron.exe` (dev)
5. **Resolve the engine script:** `server/browser-engine/main.cjs`
6. If either is missing → `BrowserError` (503, `engine_missing`)
7. **Create profile directory:** `browser-profile/` (mkdir_existent_ok)
8. **Generate ephemeral credentials:** random port + `secrets.token_urlsafe(48)`
9. **Launch subprocess** with `stdin=DEVNULL, stdout=DEVNULL, stderr=PIPE`
10. **Start two daemon threads:** `_read_diagnostics()` and `_watch_process()`
11. **Poll `/status`** every 100 ms until `{ ready: true }` or 15-second timeout
12. If timeout → `_fail_process()` + `BrowserError` (503, `engine_unavailable`)

### Watchdog (`_watch_process`)

- Blocks on `process.wait()`, then calls `_fail_process()` when the engine dies
- This ensures sessions are cleaned up when the engine crashes

### Diagnostics (`_read_diagnostics`)

Reads `stderr` line-by-line and extracts only **error categories and source locations**:

| Pattern | Diagnostic value |
|---------|-----------------|
| "Cannot find module" / "Unable to find Electron app" | "a browser runtime module is missing" |
| `SyntaxError`, `TypeError`, `ReferenceError`, `RangeError` | Error category |
| `main.cjs:LINE` | Source location |

This is critical: raw stderr could contain page URLs or DOM content. The regex filter
keeps only engine-level errors for diagnostic display.

### Failure (`_fail_process`)

- Clears `_process`, `_bridge`, and `_sessions` under `_lock`
- If the process is still alive, calls `process.terminate()`
- All subsequent `request()` calls will hit the `engine_restarted` error path

---

## 3. Session management

Sessions are the bridge's isolation layer. Each session gets:
- A **token**: `secrets.token_urlsafe(32)` — presented to the client
- A **prefix**: `secrets.token_hex(16)` — prepended to tab IDs for namespace isolation
- A **tab registry**: `{ client_tab_id: engine_tab_id }` mapping

### Tab ID isolation

The client assigns tab IDs (e.g., `"abc123"`), but the engine needs unique IDs across
all sessions. The bridge maps them:

```
client tab "abc123" in session "tok1" → engine tab "f3a2b1c4-abc123"
client tab "abc123" in session "tok2" → engine tab "d7e8f9a0-abc123"
```

This prevents one session from accidentally controlling another session's tabs.

### Session limits

| Limit | Value | Location |
|-------|-------|----------|
| MAX_SESSIONS | 32 | `_sessions` dict size check |
| SESSION_TTL | 30 min (1800 s) | `time.monotonic()` comparison |
| MAX_TABS | 8 (global) | Sum across all sessions |

### Stale session cleanup

Every `request()` call runs a stale-session sweep:
1. Find tokens where `time.monotonic() - session["touched"] > SESSION_TTL`
2. Remove them from `_sessions`
3. Issue `close` commands for all their tabs (best-effort, breaks on first error)

This prevents tab leaks from abandoned sessions.

---

## 4. Command pipeline

### Entry: `request(body)`

1. Validate `body` is a dict
2. Handle `session` action (create a new session, return token)
3. Handle `close_session` action (close all tabs, remove session)
4. Call `_command_body(body)` to validate and normalize the command
5. Resolve the tab ID through the session's mapping
6. Call `self._command(command)` to send to the engine
7. On success, translate engine tab ID back to client tab ID if present

### Validation: `_command_body(body)`

This function is a **schema validator + normalizer**:

| Field | Rules |
|-------|-------|
| `action` | Must be one of 14 actions in `_ACTIONS` |
| `tab` | Must match `^[A-Za-z0-9_-]{1,64}$` |
| `width` | Integer 160–2400 (default 1000 for create) |
| `height` | Integer 120–1800 (default 700 for create) |
| `since` | Integer 0–2⁵³-1 (for frame diff) |
| `url` | Delegated to `_parse_url()` from `browser.py` |
| `text` (text/find) | String ≤ 16384 / ≤ 4096 |
| `event`/`events` | Array 1–64, each validated for type, coords, modifiers |
| `keyCode` | String ≤ 64 chars |
| `modifiers` | Array ≤ 12, values from fixed whitelist |

All validation failures raise `BrowserError` with code `"invalid_request"` (400).

### Execution: `_command(command)`

1. **Acquire** `_slots` semaphore (max 16 concurrent commands)
2. If unavailable → `BrowserError` (429, `engine_busy`)
3. Generate a unique `identifier = secrets.token_hex(16)`
4. Under `_lock`, snapshot `process`, `bridge`, and `_sessions`
5. If process is dead/None → `_fail_process()` + `BrowserError` (503, `engine_restarted`)
6. **Start a 20-second watchdog timer** that calls `_fail_process()` on timeout
7. Send HTTP POST to `127.0.0.1:\u003cport>/command` with the authenticated request
8. Validate the response: must have matching `id`
9. If response has `error` → raise `BrowserError` with the message
10. On timeout → `_fail_process()` + `BrowserError` (504, `engine_timeout`)
11. On connection error → `_fail_process()` + `BrowserError` (503, `engine_restarted`)
12. **Finally:** cancel watchdog and release semaphore

---

## 5. Transport details

### HTTP request format

```python
headers = {
    "Authorization": "Bearer " + secret,
    "Content-Type": "application/json"
}
body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
```

### Response size limit

`MAX_REPLY_BYTES = 12 * 1024 * 1024` (12 MB). This protects against a runaway
snapshot or encoded image that exceeds the response size.

### Error response format

The engine always returns `{ id, result }` or `{ id, error }` (never HTTP error codes
except for auth/rate-limit). The bridge translates engine errors to `BrowserError`
with appropriate HTTP status codes:

| Status | Code | When |
|--------|------|------|
| 400 | `invalid_request` | Command validation failed |
| 401 | `engine_session_expired` | Invalid or expired session token |
| 404 | `engine_tab_missing` | Tab doesn't exist in session |
| 429 | `engine_busy` / `engine_tab_limit` | Too many slots or tabs |
| 502 | `engine_protocol_error` / `engine_command_failed` | Engine responded with error or bad format |
| 503 | `engine_missing` / `engine_unavailable` / `engine_restarted` | Process not started, crashed, or died |
| 504 | `engine_timeout` | 20-second watchdog expired |

---

## 6. Concurrency model

```
                    _lock (RLock)
                       │
          ┌────────────┼────────────┐
          │            │            │
    request()   _fail_process()  _read_diagnostics()
          │            │            │
          │            │            │
                    _start_lock (Lock)
                       │
                  _ensure_process()
```

- `_lock` (RLock): Protects `_sessions`, `_diagnostic`, and the process/bridge snapshot
  in `_command()`. Can be re-entered by the same thread.
- `_start_lock` (Lock): Serializes process startup — only one `_ensure_process()` at a time
- `_slots` (BoundedSemaphore): Limits concurrent engine commands to 16
- Two daemon threads: `_read_diagnostics()` (stderr) and `_watch_process()` (wait)

---

## 7. Invariants

1. **One process per instance.** `ENGINE = BrowserEngine()` is created once at module import.
   A second instance would start a second Chromium process — a configuration error.
2. **Session tokens are opaque.** They are never interpreted or derived from other data.
   A client that loses its token can create a new session (up to MAX_SESSIONS).
3. **Tab IDs are scoped to sessions.** The prefix mapping prevents cross-session tab
   confusion. A client from session A cannot close a tab from session B.
4. **Commands are authenticated.** Every HTTP request to the engine must present the
   correct Bearer token. The bridge generates it at startup and never exposes it to
   clients.
5. **The watchdog is always cancelled.** The `finally` block in `_command()` guarantees
   the watchdog is cancelled on success, error, or timeout. A missed cancellation would
   cause a spurious `_fail_process()` call.

---

## 8. File structure

```
server/reachd/browser_engine.py
├── BrowserError      — Re-exported from browser.py (ValueError subclass)
├── allowed_origin()  — Origin header validation for web clients
├── _integer()        — Integer range validator (used in _command_body)
├── _command_body()   — Schema validator + normalizer for commands
├── BrowserEngine
│   ├── __init__()           — Initialize state, lock, semaphore
│   ├── _ensure_process()    — Start/verify the Chromium process
│   ├── _watch_process()     — Block on process.wait() → _fail_process
│   ├── _read_diagnostics()  — Parse stderr for error categories
│   ├── _fail_process()      — Clean up process + sessions
│   ├── _stopped_message()   — Human-readable error string
│   ├── _http_request()      — Send authenticated HTTP request to engine
│   ├── _command()           — Acquire slot → send → validate → release
│   ├── request()            — Session management + command dispatch
│   └── close()              — Force-terminate and clean up
└── ENGINE                — Module-level singleton
    └── atexit.register(ENGINE.close)
```

---

## 9. Related

- [`browser-engine.md`](./browser-engine.md) — The Chromium process the bridge talks to
- [`overview.md`](./overview.md) — All three engines in one view
- `server/reachd/browser.py` — `_parse_url()` used for URL validation in commands
- `specs/AGENT_UPGRADE_PLAN.md` — Plan to add agent-facing browser verbs
