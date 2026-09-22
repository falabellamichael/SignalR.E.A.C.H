# BROWSER_ENGINE — relay-side Chromium engine, Python bridge, web panel, Reader fetcher

## 1. What & why

One relay process needs two very different ways to look at the web:

- **Interact** with a page (navigate, click, type, read frames/console/network) — that is
  the offscreen Chromium engine: an Electron subprocess the relay owns, reachable only on a
  random loopback port with a per-launch Bearer secret.
- **Read** a page (HTML/CSS/images, no scripts) — that is the stateless fetcher, pure stdlib,
  in the relay process.

They are fallbacks for each other: the fetcher escalates to a one-shot engine render when a
page is a script-rendered shell (`handler.py:_looks_script_shell` → `_browser_engine_render`,
`server/reachd/handler.py:729,739`), and the engine's URL validation reuses the fetcher's
`_parse_url` for scheme/credential gating (`server/reachd/browser_engine.py:21`).

Everything in this document is measured against the working tree on 2026-09-21 (commands in
§9). Line counts are `wc -l`; they exclude no trailing content — the last line of each file
ends in a newline.

## 2. File map

| File | Lines | Role |
| --- | --- | --- |
| `server/browser-engine/main.cjs` | 480 | Offscreen Chromium engine (Electron main process): tabs, HTTP command API, URL gate, paint, console/network rings |
| `server/reachd/browser_engine.py` | 387 | Python bridge: process lifecycle, sessions, command validation/transport |
| `server/reachd/browser.py` | 370 | Stateless fetcher (Reader mode) + `_parse_url` shared with the bridge |
| `src/browser-engine.js` | 181 | Web-panel client: canvas-painted interactive surface that drives the engine over `POST /_reach/browser/engine` |
| `server/reachd/handler.py` | 1227 | Relay HTTP surface: route `/_reach/browser/engine` (line 703), fetcher routes, script-shell escalation |

```bash
wc -l server/browser-engine/main.cjs server/reachd/browser_engine.py server/reachd/browser.py src/browser-engine.js server/reachd/handler.py
#  480 387 370 181 1227
```

## 3. Lifecycle & entry points

### 3.1 Engine startup (who starts it)

The engine is never started by a user. `BrowserEngine._ensure_process`
(`browser_engine.py:140`) does:

1. Single-writer startup under `_start_lock`; returns the live process if
   `poll() is None` (`:142-145`).
2. Resolves the Electron executable: installed
   `%LOCALAPPDATA%/SignalREACH/copilot/tray/node_modules/electron/dist/electron.exe`,
   else dev `copilot/tray/node_modules/electron/dist/electron.exe`; the engine script is
   `server/browser-engine/main.cjs`; either missing → `engine_missing` (503) (`:147-154`).
3. Creates `browser-profile/` (shared across restarts; the Chromium partition itself is
   per-PID: `signalreach-browser-<pid>`, `main.cjs:144`).
4. Generates credentials: port from a probe socket bound to `0` (ephemeral), secret
   `secrets.token_urlsafe(48)` (`:158-161`).
5. Launches with `stdin=DEVNULL, stdout=DEVNULL, stderr=PIPE`, `REACH_BROWSER_PORT`,
   `REACH_BROWSER_SECRET`, `REACH_BROWSER_PARENT_PID` (`:168-174`).
6. Starts two daemon threads: `_read_diagnostics` (stderr filter) and `_watch_process`
   (`process.wait()` → `_fail_process`, `:196-198`) (`:179-183`).
7. Polls `GET /status` every 100 ms until `ready: true` or 15 s → else
   `engine_unavailable` (503) (`:184-194`).

The engine side (`main.cjs:110-128`): validates `1 ≤ port ≤ 65535` and `secret ≥ 32` chars,
requires an absolute `--profile=`, sets `userData`, `app.disableHardwareAcceleration()`
(software rendering), then listens on `127.0.0.1` only. A 5-second interval quits the
process when the parent PID is dead or after 10 minutes without a command (`main.cjs:455-461`).

### 3.2 Failure & diagnostics

- `_watch_process` (`:196`) turns any engine death into `_fail_process`, which clears
  `_process`, `_bridge` and **all sessions** under `_lock` and terminates the process if
  still alive (`:251-261`).
- A per-command 20 s `threading.Timer` watchdog also calls `_fail_process`
  (`browser_engine.py:284`); it is cancelled in `finally` (`:307`) so a healthy engine is
  never killed late.
- `_read_diagnostics` (`:221-248`) keeps only fixed error categories
  (`SyntaxError|TypeError|ReferenceError|RangeError`), `main.cjs:LINE` locations, and
  "Cannot find module" / "Unable to find Electron app" reasons. Raw stderr is discarded:
  Chromium diagnostics can contain page URLs and DOM data, so the stored diagnostic is
  bounded to 160 chars of filtered text (`:246`).

### 3.3 Web panel entry points (`src/browser-engine.js`)

- One session token for the whole page: `request({action:'session'})` lazily, cached in
  `tokenPromise`; a `pagehide` beacon closes it (`:7-14, :24-31`).
- All requests: `POST <RELAY>/_reach/browser/engine`, `credentials: 'omit'`,
  `AbortSignal.timeout(20000)` (`:15-23`). On 401/403/410/503/504 the token is dropped and
  re-acquired (`:30`).
- Frames: `poll()` issues `frame` with `since` (delta-only JPEG) every **80 ms visible /
  500 ms hidden** (`:154`).
- Input: coalesced on a 16 ms timer, mouse-moves replace the pending move, batches flush at
  64 events (`:63-66`); viewport clamped to 160–2400 × 120–1800 from the host rect (`:42`).
- Keys: `keyNames` map for arrows/Space/Control/Escape (`:110`); printable chars send
  `keyDown` + `char`; paste goes through the `text` command sliced to 16384 chars
  (`:108`); find text sliced to 500 (`:175`).
- `Escape` → address bar; `Ctrl/Cmd+L` → address; `Ctrl/Cmd+F` → find; `Ctrl/Cmd+C/X` →
  `snapshot` then copy the selection (`:111-136`).

## 4. Protocol / API

### 4.1 Engine HTTP API (`main.cjs`)

- **Auth** (`main.cjs:410-418`): `Authorization: Bearer <secret>` compared with
  `crypto.timingSafeEqual` *and* `Host` must be `127.0.0.1:<port>` *and* `Origin` must be
  absent — otherwise 403 `Private browser connection required.`
- **Routes**: `GET /status` → `{ready, engine, version}`; `POST /command`; anything else 404.
- **Rate limits**: 64 pending commands → 429 (`:423`); `server.maxConnections = 32`
  (`:452`); `requestTimeout` 15 s, `headersTimeout` 10 s (`:450-451`); body capped at
  `MAX_LINE_BYTES = 256 * 1024` (`:12, :428-433`).
- **Request**: `{ id, action, tab, … }`; `id` is a safe integer or a string < 100 chars
  (`:434-436`). **Response**: `{ id, result }` or `{ id, error }` — always HTTP 200 for
  command-level failures.
- **Ordering** (`:440-443`): everything except `frame`, `snapshot`, `ping`, `stop`,
  `close` is serialized per tab through `tab.mutationQueue`.

**Actions — 17 dispatch paths** (`main.cjs:command`, `:196-302`):

| Action | Notes (bounds from code) |
| --- | --- |
| `ping` | `{ready, engine, version}`; global, no tab |
| `create` | tab id `^[A-Za-z0-9_-]{1,160}$`; max `MAX_TABS = 8` (`:11`); default viewport 1024×700; optional initial URL follows the `navigate` checks |
| `navigate` | `publicUrl()` gate (§5); load errors surfaced on `tab.error` |
| `frame` | `viewport` clamp: width 100–2400, height 120–1800 (`dimension`, `:66-70`); returns JPEG (q78) only when `since` ≠ current sequence; encoding memoized per sequence (`:171-186`) |
| `back` / `forward` / `reload` / `stop` | history controls |
| `input` | 1–64 events/batch; per-event validation in `inputEvent` (`:72-107`): mouse types `mouseDown|mouseUp|mouseMove|mouseEnter|mouseLeave|mouseWheel`, coords clamped to the viewport, button left/middle/right, clickCount 0–3, wheel delta ≤ 10000; key types `rawKeyDown|keyDown|keyUp|char` with **non-empty `keyCode` ≤ 32 chars, no NUL** (`:81-82`); modifiers ≤ 12 from `MODIFIERS` (`:13-15`) |
| `text` | ≤ 32768 chars, no NUL; `insertText` with a 3 s timeout (`:265-269`) |
| `snapshot` | `executeJavaScript` with a 5 s timeout; returns `url`, `title` (≤ 200), `text` (≤ 160000), `html` (≤ 2000000), `selection`, `contextText` (≤ 16000); active password/file inputs are excluded from the selection read (`:271-283`) |
| `find` | text ≤ 500; find-in-page with `forward`/`findNext`; empty text clears |
| `pause` / `resume` | stop/start painting; `pause` without a tab pauses all |
| `console` | per-tab ring, last 200 entries, text ≤ 1000 chars, source ≤ 200 (`:226-231`) |
| `network` | per-tab ring, last 100 entries, URL ≤ 500 (`:232-243`) |
| `close` | destroy tab; idempotent (`:213`) |

### 4.2 Bridge command pipeline (`browser_engine.py`)

`request(body)` (`:312`) — the only public entry, called by `handler.py` and the one-shot
renderer path:

1. **TTL sweep**: sessions idle > `SESSION_TTL = 30*60` (`:26`) are removed and their tabs
   closed best-effort (`:315-322`).
2. **`session`** → new token `token_urlsafe(32)` + tab prefix `token_hex(16)`; cap
   `MAX_SESSIONS = 32` → 429 `engine_busy` (`:323-331`).
3. **`close_session`** → close its tabs, drop the session; unknown token → 401
   `engine_session_expired` (`:332-345`).
4. **`_command_body`** (`:62-126`) normalizes + validates, raising 400
   `invalid_request` on any violation:
   - `action` ∈ `_ACTIONS` — **16 actions** (`:30-33`); `ping` is engine-only, not forwarded;
   - `tab` matches `^[A-Za-z0-9_-]{1,64}$` (`:29`) — narrower than the engine's 160;
   - `width`/`height` ints 160–2400 / 120–1800, defaults 1000/700 (`:67-70`);
   - `since` int 0–2⁵³−1 (`:71-72`);
   - `url` → `_parse_url` from `browser.py` (scheme/credential gate; DNS belongs to the
     engine) (`:73-76`);
   - `text` ≤ 16384 (text) / ≤ 4096 (find) (`:77-83`);
   - `input` events 1–64; types restricted to mouseDown/mouseUp/mouseWheel/keyDown/keyUp/char;
     numeric fields −10000…10000 (`_integer`, `:56-60`); `keyCode` **non-empty, ≤ 32 chars,
     no NUL** — matched to the engine's `inputEvent` bounds so over-long keys fail here with
     400 instead of 502 at the engine (`:104-112`); `modifiers` ≤ 12 from a whitelist kept in
     sync with `main.cjs MODIFIERS` (`isKeypad` accepted, `super` rejected) (`:113-121`);
     unrecognized fields are stripped (`:100`).
5. **Tab mapping**: client `tab` → `prefix-tab` under `_lock` (`:347-360`); unknown tab →
   404 `engine_tab_missing`; global cap `MAX_TABS = 8` across all sessions → 429
   `engine_tab_limit` (`:355`); a failed `create` releases the reservation (`:364-367`).
6. **`_command(command)`** (`:264-309`):
   1. build `{**command, "id": token_hex(16)}`;
   2. **size gate**: encoded payload > `MAX_BODY_BYTES = 128*1024` (`:24`) → 400
      `invalid_request` (`:267-272`) — the same bound `handler.py:715` enforces on
      `Content-Length`, now also held by direct `request()` callers (the engine's own gate
      is larger, `MAX_LINE_BYTES` 256 KB);
   3. acquire `_slots` (`BoundedSemaphore(16)`, `:133`) → else 429 `engine_busy`;
   4. snapshot process/bridge under `_lock`; dead process → 503 `engine_restarted`;
   5. start the 20 s watchdog; `POST /command` via `_http_request` (`:204-219`);
   6. response must echo the `id`; `error` → 502 `engine_command_failed` (message
      truncated to 1000); oversized reply > `MAX_REPLY_BYTES = 12 MiB` → 502
      `engine_protocol_error` (`:214-216`);
   7. timeout → 504 `engine_timeout`; connection error → 503 `engine_restarted` (both
      fail the process); `finally` cancels the watchdog and releases the slot.

### 4.3 Relay HTTP route (`handler.py`)

`POST /_reach/browser/engine` (`:617` → `:703-727`):

1. `_admin_local()` **and** `allowed_origin(Origin)` → else 403 `engine_forbidden`
   (`:705-708`). `allowed_origin` (`browser_engine.py:35-52`) accepts only a **missing**
   Origin (native clients) or literal `localhost`/loopback web origins; `null` is
   rejected (public sites can manufacture it with sandboxed frames).
2. `Content-Type` must be exactly `application/json` → else 415.
3. `0 < Content-Length ≤ 128 KB` → else 400.
4. `BROWSER_ENGINE.request(body)`; `BrowserError` → its status + code;
   `ValueError`/`UnicodeError` → 400.
5. 200 with the raw result, `Cache-Control: no-store`, connection closed when the body
   was unread.

### 4.4 One-shot engine render (escalation)

`_browser_engine_render` (`handler.py:739-…`): opens a throwaway session + tab,
navigates, waits up to 15 s, returns the `snapshot` DOM, closes the tab. Triggered from
the fetcher route when `_looks_script_shell` (`:729-737`) fires — little extracted text
(< 200 chars) or a `type="module"` script tag in the HTML (Vite/React shells render
blank without JS).

## 5. Security model

| Gate | Where | What it enforces |
| --- | --- | --- |
| `publicIp()` | `main.cjs:20-41` | IPv4: rejects 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224+/4, 240+/4. IPv6: only global unicast 2000::/3 family words, excludes Teredo (2001:0/23), 2001:db8::/32, 2002::/16, 3ff0::/20; rejects scoped/IPv4-dotted forms |
| `parseUrl()` | `main.cjs:51-63` | string ≤ 8192, no control chars/backslash; `http:`/`https:` only (plus `ws/wss` for subresource checks); no hostname, no username/password; host ≤ 253, no percent-encoding; non-loopback `.localhost`/`.local` and literal private IPs blocked |
| `publicUrl()` | `main.cjs:151-170` | parse → Chromium `resolveHost` (same resolver the request uses — no TOCTOU) → every endpoint `publicIp`-checked; 8 s timeout; in-flight lookups deduped, capped at 32 |
| Navigation intercept | `main.cjs:171-183` | `onBeforeRequest` re-checks *every* request (redirects, subresources) through `publicUrl`; `will-navigate`/`will-redirect` re-check via `parseUrl` |
| Window/permission lockdown | `main.cjs:131-149, 296-301` | `setWindowOpenHandler` denies all new windows (in-place navigation for plain links, error for postBody popups); webviews, bluetooth, certificate errors, login prompts, downloads, `will-prevent-unload`, `content-bounds-updated` all prevented; all session permissions denied; cache off; UA stripped of Electron/SignalREACH tokens (`:149`); WebRTC `disable_non_proxied_udp` (`:234`) |
| No debugger | `main.cjs:110` (no `--remote-debugging-port`) | DOM/JS cannot be inspected externally; only the authenticated loopback API exists |
| Auth | `main.cjs:410-418` | Bearer secret (≥ 32 chars) + exact loopback Host + no Origin, `timingSafeEqual` |
| Sessions | `browser_engine.py:312-360` | tokens unguessable, 30 min TTL, tab prefix isolation, global 8-tab cap |
| Origin | `browser_engine.py:35-52` | loopback-only web origins; `null` rejected |
| Diagnostics | `browser_engine.py:221-248` | stderr filtered to fixed categories + `main.cjs:LINE`; raw page data never stored |
| Sizing | `browser_engine.py:24,264-272`; `main.cjs:12,423` | 128 KB command cap (bridge + relay route), 256 KB engine gate, 64 pending, 16 slots, 16 connections cap per client, 12 MiB reply cap |

The engine does **not** sandbox: `snapshot`'s `executeJavaScript` runs with full DOM
access (it reads `innerText`/`outerHTML`/selection/element-at-point only, no network, no
`eval`/`require`), and console/network rings are captured unfiltered by origin.

## 6. The Reader fetcher (`server/reachd/browser.py`) — deep dive

Stateless: each `fetch_page(url, kind)` (`:255`) is independent; no browser APIs, no
rendering, no sessions. `kind` ∈ `page|image|style` (`:259`).

### 6.1 URL parsing — `_parse_url` (`:78-105`)

String ≤ 8192, no control chars (ord < 32 / 127) or backslash; `http/https` only; no
username/password; host IDNA-encoded, ≤ 253, no percent-encoding; port 1–65535 (default
80/443); path/query re-quoted; returns `(normalized, host, port, scheme, target)`.

### 6.2 DNS + SSRF gate — `_resolve_public` (`:128-167`)

- Bounded: `_DNS_SLOTS` (4) + `_DNS_POOL` (4 workers) (`:25-27`); a full queue → 429
  `browser_busy`; pool timeout → 504 `fetch_timeout`; `OSError` → 502 `fetch_failed`.
- **Every** resolved address must pass `_public_ip` (`:109-121`): `is_global` and not
  private/loopback/link-local/multicast/reserved/unspecified; IPv6 additionally rejects
  `ipv4_mapped`, `sixtofour`, `teredo`, and 64:ff9b::/96 (SIIT). One non-public address
  → 403 `blocked_address`.
- **Loopback exception, first hop only**: `allow_loopback` when `redirects == 0` and the
  host is literal `localhost/127.0.0.1/::1` (`:262, :155-160`) — local dev servers work;
  every redirect re-resolves strictly public (redirect-to-internal SSRF blocked).
- Loopback sort prefers `127.*` over `::1` (`:163-165`).

### 6.3 Connection — `_PinnedConnection` (`:171-217`)

Subclasses `http.client.HTTPConnection` and connects the **already-validated**
`sockaddr` directly: no second DNS lookup (no rebinding window), SNI preserved
(`server_hostname=self.host`), proxy env ignored, and a `threading.Timer` watchdog
closes the socket at the shared 12 s deadline — including during headers, TLS
(`do_handshake_on_connect=False` then explicit `do_handshake()`) and slow-trickle reads
(the deadline is also checked at every read boundary via `_remaining`, `:39-43`).

### 6.4 Body, compression, content

- Limits: `MAX_PAGE_BYTES = 2 MiB` pages, 512 KB images/stylesheets (`:21, :261`);
  `_FETCH_SLOTS = 4` concurrent fetches (`:24`); `FETCH_TIMEOUT = 12` s; `MAX_REDIRECTS = 5`
  (`:22-23`).
- The fetcher sends `Accept-Encoding: identity` (`:283`). If a server ignores it, the
  **already-bounded** body is decoded all at once by `_decode_compressed` (`:46-70`):
  gzip/x-gzip, zlib-wrapped deflate with a raw-DEFLATE retry, or optional `brotli`
  (missing package → 415). A failing decode → 415 `unsupported_content` — undecoded
  bytes never pass through. Compressed bodies get +64 KB of read slack (`:293-296`), so a
  compressed bomb cannot grow past the cap + 64 KB; no streaming inflater is needed.
- Content types (`:28-30`): page → `text/html`, `application/xhtml+xml`, `text/plain`;
  image → the 8 raster/`svg+xml`/icon types; style → `text/css`. Mismatch → 415.
- Images are signature-verified against the declared type (PNG/JPEG/GIF/WebP/AVIF/ICO
  magic bytes, `:311-319`); `_looks_svg` (`:73-74`) rejects SVG masquerading as an image
  (first 2048 bytes after BOM/whitespace).
- HTML → `_PageText` (`:220-251`): strips `script/style/template/noscript/svg/head`,
  newline per block tag, title ≤ 512 chars whitespace-normalized; pages over the cap are
  truncated with `truncated: true` (`:336-339`), resources are rejected (415
  `resource_too_large`).
- Redirects: 301/302/303/307/308, `Location` required, ≤ 5 hops, each hop re-parses and
  re-resolves through §6.2 (`:269-277`).

### 6.5 Returns & errors

- `page` → `{url, title, html, text, content_type, truncated}`; `image` →
  `{url, content_type, encoding: "base64", data}`; `style` → `{url, content_type,
  encoding: "utf-8", data}`.
- Errors: 400 `invalid_url` · 403 `blocked_address` · 415 `unsupported_content` /
  `resource_too_large` · 429 `browser_busy` · 502 `fetch_failed` / `redirect_failed` ·
  504 `fetch_timeout` (`BrowserError`, `:32-36`).

## 7. Limits & error taxonomy (engine + bridge together)

| Limit | Value | Enforced at |
| --- | --- | --- |
| Tabs | 8 global, shared across sessions | engine `:11`; bridge `:28, :355` |
| Pending engine commands | 64 | engine `:423` |
| Concurrent bridge commands | 16 slots | bridge `:133` |
| HTTP connections to engine | 32 | engine `:452` |
| Command body | 128 KB (bridge + relay route); 256 KB engine gate | bridge `:24, :267-272`; handler `:715`; engine `:12, :428-433` |
| Engine reply | 12 MiB | bridge `:25, :214-216` |
| Sessions | 32, TTL 30 min | bridge `:26-27, :327, :315-322` |
| Viewport | 100–2400 × 120–1800 (engine floor 100; bridge floor 160) | engine `:66-70`; bridge `:67-70` |
| Text input | 32768 chars (bridge 16384 for `text`… engine allows 32768; the panel sends 16384) | engine `:265`; bridge `:77-78`; panel `:108` |
| Input batch | 64 events | engine `:252`; bridge `:85-87` |
| keyCode | non-empty ≤ 32 chars, no NUL | engine `:81-82`; bridge `:104-112` |
| Modifiers | ≤ 12, whitelisted (synced) | engine `:13-15, :77-79`; bridge `:113-121` |
| Console / network rings | 200 / 100 entries per tab | engine `:226-243` |
| Command watchdog | 20 s | bridge `:284` |
| Idle engine | quits after 10 min; parent-death check every 5 s | engine `:455-461` |
| Engine HTTP timeouts | 15 s request / 10 s headers | engine `:450-451` |

| Status | Code | Origin |
| --- | --- | --- |
| 400 | `invalid_request` | bridge `_command_body`, size gate; handler route (empty/oversized/invalid JSON) |
| 401 | `engine_session_expired` | unknown/absent token |
| 403 | `engine_forbidden` | handler route: not local or bad Origin |
| 404 | `engine_tab_missing` | tab not in session |
| 415 | (route) | non-JSON `Content-Type` |
| 429 | `engine_busy` | 16 slots full, or session cap at 32 (bridge `:133, :327`). The engine's own 64-pending 429 comes back as a non-200, which the bridge maps to 503 `engine_unavailable` (`:212-213`) — it is not surfaced as a bridge-level 429 |
| 502 | `engine_command_failed` / `engine_protocol_error` | engine-level error / id mismatch / oversized reply |
| 503 | `engine_missing` / `engine_unavailable` / `engine_restarted` | no runtime / startup timeout / process died or disconnected |
| 504 | `engine_timeout` | 20 s watchdog |

## 8. Relationships

- **`handler.py`** — imports `ENGINE` (the singleton, `browser_engine.py:386`) plus
  `MAX_BODY_BYTES` and `allowed_origin` (`handler.py:22`); owns the route and the
  fetcher↔engine escalation (§4.4).
- **`src/browser-engine.js`** — the only human-facing client of the route; canvas-painted
  frames, coalesced input (§3.3).
- **`browser.py`** — fetcher (§6); also the source of `_parse_url` and `BrowserError`
  for the bridge (`browser_engine.py:21`).
- **Studio** — a *different* browser surface (in-process `WebContentsView`s,
  `studio/browser/`), documented in `STUDIO_BROWSER.md`; do not merge the two (§4 of the
  directory README, invariant 4).
- **Reach CLI** — another separate surface, `REACH_CLI.md`.
- `specs/AGENT_UPGRADE_PLAN.md` — exposes these verbs as agent tools (fifth surface).

## 9. Verified against

```bash
wc -l server/browser-engine/main.cjs server/reachd/browser_engine.py server/reachd/browser.py src/browser-engine.js
# 480 387 370 181
grep -n "MAX_LINE_BYTES" server/browser-engine/main.cjs            # :12 → 256 * 1024
grep -c "case '" server/browser-engine/main.cjs                     # 16 cases + pre-dispatch ping = 17 actions
grep -n "_ACTIONS = {" server/reachd/browser_engine.py              # :30-33 → 16 actions
grep -n "len(key_code) > 32" server/reachd/browser_engine.py        # :111 → bridge keyCode bound = engine bound
grep -n "isKeypad" server/reachd/browser_engine.py                  # :117 → modifier whitelist synced
grep -n "MAX_BODY_BYTES" server/reachd/browser_engine.py server/reachd/handler.py  # bridge :24,:271 / handler :22,:715
python3 -B -m unittest tests.test_browser tests.test_browser_engine # Ran 38 tests — OK
node --test tests/browser_engine.test.cjs                           # 4/4 pass
```
