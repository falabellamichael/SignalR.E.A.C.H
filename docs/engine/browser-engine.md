# Browser Engine — `server/browser-engine/main.cjs`

**The interactive offscreen Chromium browser.** This is the Electron process that runs
a headless Chromium instance with up to 8 tabs, handling navigation, input, rendering,
and DOM snapshots. The relay talks to it exclusively via a private loopback HTTP API.

**File:** `server/browser-engine/main.cjs` (481 lines)
**Transport:** HTTP on `127.0.0.1` with `REACH_BROWSER_SECRET` Bearer auth
**Owner:** `server/reachd/browser_engine.py` (Python bridge)

---

## 1. Startup contract

The engine is never started directly by a user. It is launched by `BrowserEngine._ensure_process()`
in the Python bridge with these environment variables and arguments:

| Variable | Purpose | Validation |
|----------|---------|------------|
| `REACH_BROWSER_PORT` | Random ephemeral port | Integer 1–65535 |
| `REACH_BROWSER_SECRET` | HTTP auth secret | ≥ 32 chars, `secrets.token_urlsafe(48)` |
| `REACH_BROWSER_PARENT_PID` | Parent process for health check | Integer > 0 |
| `--profile=<path>` | Chromium user-data directory | Absolute path |

**Startup sequence:**

1. Parse and validate environment variables
2. Set `app.setPath('userData')` to the profile directory
3. Disable hardware acceleration → software rendering
4. Create a partitioned `BrowserSession` (cache disabled, all permissions denied)
5. Start HTTP server on the ephemeral port bound to `127.0.0.1`
6. Return `{ ready: true, engine: 'Chromium', version: <chrome_version> }` on `/status`

The process monitors its parent PID every 5 seconds and quits if the parent dies. It also
quits after 10 minutes of no commands.

---

## 2. HTTP API

Only one public endpoint: `POST /command`. The `/status` GET is a health check.

### Authentication

```
Authorization: Bearer <REACH_BROWSER_SECRET>
Host: 127.0.0.1:<port>
Origin: (must be absent — rejected if present)
```

Any missing, extra, or mismatched auth → **403** `Private browser connection required.`

### Command format

**Request:**
```json
{ "id": "<string_or_integer>", "action": "navigate", "tab": "abc123", "url": "https://..." }
```

- `id`: Request identifier echoed in the response (string ≤ 99 chars, or safe integer)
- `action`: One of 15 supported actions (see §3)
- `tab`: Tab ID matching `^[A-Za-z0-9_-]{1,160}$`

**Response:**
```json
{ "id": "<same_id>", "result": { ... } }   // success
{ "id": "<same_id>", "error": "message" }  // failure
```

### Rate limiting

- Max **64** pending commands (`pendingCommands >= 64` → 429)
- Max **32** concurrent HTTP connections
- Request timeout: 15s; header timeout: 10s
- Max request body: 128 KB (`MAX_LINE_BYTES`)

---

## 3. Supported actions

| Action | Requires URL? | Key behavior |
|--------|--------------|--------------|
| `ping` | No | Returns `{ ready: true, engine: 'Chromium', version }` |
| `create` | No (or initial URL) | Opens a new tab (max 8). If URL provided, navigates immediately |
| `navigate` | Yes | Validates URL via `publicUrl()`, loads it asynchronously |
| `frame` | No | Sets viewport size (w: 100–2400, h: 120–1800). Returns diff image if `since` given |
| `back` | No | Goes back if possible |
| `forward` | No | Goes forward if possible |
| `reload` | No | Reloads current page |
| `stop` | No | Stops navigation |
| `input` | No | Sends mouse/keyboard events (batch ≤ 64 events) |
| `text` | No | Types text into focused element (≤ 32768 chars) |
| `snapshot` | No | Extracts DOM text, HTML, title, selection, context via JS execution |
| `find` | No | Find-in-page search (≤ 500 chars) |
| `pause` | No | Stops painting for all tabs (or a single tab) |
| `resume` | No | Resumes painting |
| `console` | No | Returns console log ring (≤ 200 entries, ≤ 1000 chars each) |
| `network` | No | Returns network request ring (≤ 100 entries) |
| `close` | No | Destroys the tab; no error if tab already closed |

### Ordered vs. unordered commands

Mutations (everything except `frame`, `snapshot`, `ping`, `stop`, `close`) are serialized
through `tab.mutationQueue` to prevent race conditions when the agent issues rapid sequential
actions.

---

## 4. URL validation — the `publicUrl()` gate

Every navigation (including redirects and new-window links) passes through `publicUrl()`:

1. **Parse** via `parseUrl()` — checks scheme (http/https only), no credentials, URL length ≤ 8192
2. **Resolve** via `browserSession.resolveHost()` — uses Chromium's DNS cache, not the OS resolver
3. **Verify** via `publicIp()` — the resolved IP must be globally routable (or localhost/loopback)

This prevents SSRF by ensuring the engine never connects to private, link-local, or
documentation-range addresses. Chromium's own DNS resolution means the check and the
actual request use the same address, eliminating TOCTOU.

### `publicIp()` logic

For IPv4: rejects 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24 (TEST-NET), 192.88.99.0/24, 192.168.0.0/16,
198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24 (DOCUMENTATION), 224.0.0.0/4 (multicast),
240.0.0.0/4 (reserved).

For IPv6: rejects embedders (Teredo, 6to4, IPv4-mapped), requires global unicast range
0x2000–0x3fff, excludes 2001:db8::/32.

---

## 5. Tab lifecycle

Each tab is a `BrowserWindow` with `offscreen: true, show: false, frame: false`.

**Per-tab state:**
- `sequence`: incrementing frame counter
- `image`: last `CCTexturePaintImage` from the `paint` event
- `cursor`: last known mouse cursor type
- `error`: last navigation error message (cleared on navigation start)
- `find`: last find-in-page result
- `paused`: whether painting is stopped
- `contextText`: last context-menu selection text
- `consoleRing` / `networkRing`: bounded log buffers
- `pointer`: last known mouse position (used in snapshot for element-at-point)
- `navigation`: incrementing counter to correlate error callbacks with the active load

**Tab limits:**
- Maximum 8 tabs (`MAX_TABS`)
- Each tab gets a unique ID (≤ 160 chars, alphanumeric + `_` + `-`)
- New tabs start at `about:blank`

**Paint pipeline:**
1. Chromium fires `webContents.on('paint', ...)` with a `NativeImage`
2. The image is stored in `tab.image` and `tab.sequence` increments
3. On `frame` requests, the image is resized (if dimensions changed) and encoded to JPEG at 78% quality
4. Encoding is memoized: `encodedImage` is only recomputed when `encodedSequence !== sequence`

---

## 6. Security model

### What the engine protects against

| Threat | Defense |
|--------|---------|
| SSRF | `publicUrl()` + Chromium `resolveHost()` + `publicIp()` on every navigation/redirect |
| XSS via popups | `setWindowOpenHandler` denies all `action: 'deny'`; new-window links navigate in-place |
| Web view embedding | `will-attach-webview` always prevented |
| Bluetooth pairing | `select-bluetooth-device` always prevented |
| Certificate errors | Always rejected (callback `false`) — no "trust anyway" option |
| Authentication dialogs | Always prevented — no credential prompts |
| Downloads | Always prevented — user gets an error message |
| GPU attacks | `disableHardwareAcceleration()` — no GPU process, no driver surface |
| DevTools access | No `--remote-debugging-port` flag; no debugger endpoint |
| Cookie/trackers | Partitioned session with `cache: false`, all permissions denied |
| Product fingerprinting | User-Agent stripped of Electron/SignalREACH identifiers |
| WebRTC leaks | `disable_non_proxied_udp` policy |
| Pop-up forms | PostBody new-window triggers an error rather than creating a native window |

### What the engine does NOT sandbox

- The agent's JavaScript `executeJavaScript()` in `snapshot` runs with full DOM access
  (but only `innerText`, `outerHTML`, `getSelection`, and `elementFromPoint` — no
  network, no `eval`, no `require`)
- Console messages and network logs are captured but not filtered by origin
- The `context-menu` handler captures up to 16 KB of selection/link text

---

## 7. Timeout boundaries

| Operation | Timeout | After timeout |
|-----------|---------|---------------|
| `publicUrl()` DNS resolve | 8 s | Error returned to tab; navigation cancelled |
| `contents.loadURL()` | None (async, errors captured via callback) | Stale page state |
| `insertText()` (text input) | 3 s | Input silently dropped |
| `executeJavaScript()` (snapshot) | 5 s | Error returned; tab shows stale content |
| HTTP request to engine | 15 s | Server closes connection; client gets error |
| Python bridge command | 20 s | Watchdog terminates the engine process |

---

## 8. Console and network capture

**Console** (`contents.on('console-message')`):
- Captures: level, text (≤ 1000 chars), line number, source (≤ 200 chars), timestamp
- Buffer: last 200 entries (ring buffer, oldest evicted)
- Access: `console` action returns `{ ok: true, logs: [...] }`

**Network** (`webRequest.onCompleted` + `onErrorOccurred`):
- Captures: URL (≤ 500 chars), method, status/error, resource type, timestamp
- Buffer: last 100 entries (ring buffer)
- Access: `network` action returns `{ ok: true, requests: [...] }`

Both are scoped to the specific tab's `webContents` via `webContentsId` filtering.

---

## 9. File structure

```
server/browser-engine/main.cjs
├── publicIp()          — IPv4/IPv6 global-address checker
├── parseUrl()          — URL validation (scheme, credentials, host reachability)
├── dimension()         — viewport dimension clamping
├── inputEvent()        — mouse/keyboard event validation
├── startEngine()       — Electron app bootstrap + HTTP server
│   ├── publicUrl()     — navigation URL gate (parse + resolve + verify)
│   ├── state()         — tab state serialization (+ optional diff image)
│   ├── viewport()      — viewport resize logic
│   ├── create()        — tab creation + event handlers
│   ├── command()       — action dispatch + validation
│   │   ├── create, navigate, back, forward, reload, stop
│   │   ├── frame, input, text, snapshot, find
│   │   ├── pause, resume, console, network, close
│   │   └── ping (global)
│   └── HTTP server     — auth, routing, rate limit, request parsing
└── timeout()           — promise race wrapper
```

---

## 10. Operational notes

### Finding the engine process

```bash
# Check if the browser engine is running
lsof -nP -iTCP:21887 -sTCP:LISTEN    # port is random, find it via the bridge

# Or check the bridge itself
curl -s http://127.0.0.1:<bridge_port>/status -H "Authorization: Bearer <secret>"
```

### Profile directory

The engine stores its Chromium profile at `browser-profile/` relative to the project root.
This is shared across restarts, so any cookies/caches from one session persist in the next
(but the session partition is per-PID, so the relay's sessions remain isolated).

### Crash diagnostics

When the engine crashes, the Python bridge's `_read_diagnostics()` thread parses stderr for:
- SyntaxError, TypeError, ReferenceError, RangeError
- "Cannot find module" or "Unable to find Electron app"
- Source locations (`main.cjs:LINE`)

These are stored in `self._diagnostic` and surfaced to the user via
`BrowserError(self._stopped_message("stopped"))`.

---

## Related

- [`browser-bridge.md`](./browser-bridge.md) — How Python talks to this engine
- [`overview.md`](./overview.md) — All three engines in one view
- [`browser-fetcher.md`](./browser-fetcher.md) — The stateless alternative (Reader mode)
- `specs/AGENT_UPGRADE_PLAN.md` — Plan to expose this engine as agent tools
