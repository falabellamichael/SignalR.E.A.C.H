# Browser Fetcher — `server/reachd/browser.py`

**The stateless public page retriever for Reader mode.** This module fetches HTML documents,
CSS stylesheets, and raster images from the public web through a series of DNS, address,
and content-type gates. It returns text or base64-encoded binary data — never executable content.

**File:** `server/reachd/browser.py` (437 lines)
**Used by:** Relay's Reader mode endpoint, Studio's browser preview
**Contrast with:** The Chromium engine (`browser-engine/main.cjs`) which is interactive and stateful

---

## 1. Architecture

The fetcher is a **stateless HTTP client** that sits between the relay and the public web.
Unlike the Chromium engine, it makes no browser API calls, renders nothing, and maintains
no session state. Each `fetch_page()` call is completely independent.

```
┌──────────────────────────────────────────────────────────────┐
│  Relay / Studio                                               │
│  fetch_page(url, kind="page")                                │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  fetch_page()                                                 │
│                                                              │
│  ┌──────────────────┐    ┌───────────────────┐              │
│  │ _parse_url()     │    │ _resolve_public() │              │
│  │ • scheme check   │    │ • DNS lookup      │              │
│  │ • credential     │    │ • public IP guard │              │
│  │   rejection      │    │ • redirect guard  │              │
│  │ • host validation│    └────────┬──────────┘              │
│  │ • normalization  │             │                          │
│  └──────────────────┘             │                          │
│                                   │                          │
│  ┌──────────────────┐    ┌────────▼───────────┐              │
│  │ _PinnedConnection│    │ Redirect loop       │              │
│  │ • Direct connect │    │ • max 5 redirects   │              │
│  │ • Pinned address │    │ • public check on   │              │
│  │ • SNI preservation│    │   each redirect     │              │
│  │ • Deadline watchdog│   └────────────────────┘              │
│  └──────────────────┘                                         │
│                                                              │
│  ┌──────────────────┐    ┌───────────────────┐              │
│  │ _decode_compressed│   │ _looks_svg()       │              │
│  │ • gzip/deflate/  │    │ SVG-in-image       │              │
│  │   brotli         │    │ detection          │              │
│  └──────────────────┘    └───────────────────┘              │
│                                                              │
│  ┌──────────────────┐                                       │
│  │ _PageText        │                                       │
│  │ • HTML parser    │                                       │
│  │ • Text extractor │                                       │
│  │ • Title extractor│                                       │
│  └──────────────────┘                                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Entry point: `fetch_page(url, kind)`

**Parameters:**
| Param | Values | Purpose |
|-------|--------|---------|
| `url` | String, ≤ 8192 chars | The page to fetch |
| `kind` | `"page"`, `"image"`, `"style"` | Content type filter |

**Returns:**
- **`kind="page"`**: `{ url, title, html, text, content_type, truncated }` — the document plus extracted text
- **`kind="image"`**: `{ url, content_type, encoding: "base64", data }` — base64-encoded raster bytes
- **`kind="style"`**: `{ url, content_type, encoding: "utf-8", data }` — raw CSS text

**Limits:**
| Resource | Max bytes |
|----------|-----------|
| HTML pages | 2 MB (`MAX_PAGE_BYTES`) |
| Images/Stylesheets | 512 KB |

---

## 3. Parsing: `_parse_url(url)`

Validates and normalizes URLs before any network activity:

1. **Format check:** string, non-empty, ≤ 8192 chars, no control characters or backslashes
2. **Scheme check:** `http` or `https` only (via `urlsplit`)
3. **Credential rejection:** usernames or passwords in the URL → error
4. **Host validation:** IDNA encoding, length ≤ 253, no percent-encoding
5. **Port validation:** 1–65535 (defaults to 80/443)
6. **Normalization:** lowercase scheme, IDNA-encoded host, percent-encoded path and query

**Returns:** `(normalized_url, host, port, scheme, path_with_query)`

**Error codes:** `invalid_url` (400), `fetch_failed` (502)

---

## 4. DNS resolution: `_resolve_public(host, port, deadline, allow_loopback)`

This is the **SSRF defense** — it resolves DNS and verifies every returned address
is globally routable before any connection is made.

**Slot management:**
- `_DNS_SLOTS` (BoundedSemaphore, 4 workers): prevents unbounded DNS queues
- `_DNS_POOL` (ThreadPoolExecutor, max_workers=4): parallel DNS lookups

**Resolution process:**
1. Acquire a DNS slot (non-blocking, 429 if full)
2. Submit `socket.getaddrinfo(host, port)` to the pool
3. Wait up to `deadline - time.monotonic()` (enforced by remaining budget)
4. **For each address:** check via `_public_ip()` — must be `is_global` and not any of:
   - `is_private`, `is_loopback`, `is_link_local`, `is_multicast`, `is_reserved`, `is_unspecified`
   - IPv6 transition mechanisms: `ipv4_mapped`, `sixtofour`, `teredo`
   - 64:ff9b::/96 (SIIT translation)

**Loopback exception:** The first hop (redirects == 0) allows `localhost` addresses.
All subsequent redirects enforce strict public-address-only. This lets Reader mode
work with local dev servers while preventing redirect-based SSRF.

---

## 5. Connection: `_PinnedConnection`

A custom `http.client.HTTPConnection` that pins to a pre-resolved address:

| Feature | Why |
|---------|-----|
| **Pinned address** | No second DNS lookup during connect — the address is already validated |
| **SNI preservation** | `server_hostname=self.host` ensures TLS SNI matches the original host |
| **No proxy vars** | Inherits from HTTPConnection but connects directly, ignoring proxy environment |
| **Deadline watchdog** | `threading.Timer` closes the socket if the deadline expires |
| **Early handshake** | For HTTPS: `do_handshake_on_connect=False` then explicit `do_handshake()` |

---

## 6. Content handling

### Compression

Three decompression strategies:
1. **gzip/x-gzip:** `gzip.decompress()`
2. **deflate:** `zlib.decompress()` (first try wrapped), fallback to raw DEFLATE
3. **brotli:** optional `brotli` package; ImportError → 415 error

A failing decode → `unsupported_content` (415). Undecoded bytes never pass through.

### Incremental deflation

`_DeflateReader` and `_BrotliReader` handle streaming decompression chunk by chunk:
- Read 64 KB chunks from the response
- Incrementally inflate into a buffer
- Return requested amounts from the buffer

This prevents loading entire compressed bodies into memory before decompression.

### SVG-in-image detection

`_looks_svg(data)` checks the first 2048 bytes (after BOM/whitespace strip) for
`<svg` — preventing SVG files from masquerading as PNG/JPEG icons and executing in
browser contexts.

---

## 7. HTML text extraction: `_PageText`

An `HTMLParser` that strips scripts, styles, templates, noscript, svg, and head elements
while preserving readable text and paragraph structure:

| Tag | Treatment |
|-----|-----------|
| `script`, `style`, `template`, `noscript`, `svg`, `head` | Hidden — all content stripped |
| `p`, `div`, `article`, `section`, `main`, `br`, `li`, `h1`–`h6`, `tr`, `blockquote`, `pre` | Block — newline inserted |
| `title` | Captured separately as the page title |
| All other text | Included with whitespace normalized |

**Title:** concatenated from `title` element, ≤ 512 chars, whitespace-normalized
**Text:** all visible text, collapsed to single spaces, each original line preserved

---

## 8. Content-type enforcement

| Kind | Allowed types |
|------|--------------|
| `page` | `text/html`, `application/xhtml+xml`, `text/plain` |
| `image` | `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `image/svg+xml`, `image/x-icon`, `image/vnd.microsoft.icon` |
| `style` | `text/css` |

After fetching, the `Content-Type` header is checked. A mismatch → `unsupported_content` (415).
For images, the **file signature** is also verified against the declared content type
(e.g., PNG must start with `\x89PNG\r\n\x1a\n`).

---

## 9. Redirect chain

| Parameter | Value |
|-----------|-------|
| MAX_REDIRECTS | 5 |
| Redirect codes | 301, 302, 303, 307, 308 |
| Loop detection | Max redirects exceeded → 502 |
| SSRF guard | Each redirect URL passes the same `_resolve_public()` check |
| First hop | Localhost addresses allowed for initial request |

The redirect loop runs at most 6 times (initial + 5 redirects). Each step validates
the new URL through the same parse → resolve → verify pipeline.

---

## 10. Concurrency and limits

| Resource | Limit | Type |
|----------|-------|------|
| `_FETCH_SLOTS` | 4 concurrent fetches | BoundedSemaphore |
| `_DNS_SLOTS` | 4 concurrent DNS lookups | BoundedSemaphore |
| `_DNS_POOL` | 4 max workers | ThreadPoolExecutor |
| Per-request timeout | 12 seconds (FETCH_TIMEOUT) | Wall clock |
| Response size | 2 MB (pages) / 512 KB (resources) | Hard cap |
| Decompressed size | Cap + 64 KB for compressed bodies | Slack for decode |

The semaphore-based approach prevents a burst of requests from overwhelming the system.
The timeout thread (`_remaining()`) is checked at every read boundary, not just at the start.

---

## 11. Error taxonomy

| HTTP Status | Error code | Meaning |
|-------------|-----------|---------|
| 400 | `invalid_url` | Malformed or disallowed URL |
| 403 | `blocked_address` | Address resolved to a private/local IP |
| 415 | `unsupported_content` | Wrong content type or compression |
| 415 | `resource_too_large` | Body exceeds kind-specific limit |
| 502 | `fetch_failed` | Connection error, wrong content type, or bad decode |
| 502 | `redirect_failed` | Too many redirects or no Location header |
| 502 | `engine_protocol_error` | (Bridge layer, not fetcher) |
| 504 | `fetch_timeout` | DNS lookup or HTTP fetch exceeded deadline |

---

## 12. Security model

| Threat | Defense |
|--------|---------|
| SSRF | DNS resolution → public IP check before every connection and redirect |
| DNS rebinding | Address is **pinned** at connection time; no re-resolution during the request |
| Slowloris / slow trickle | `_remaining(deadline)` checked on every `read1()` call |
| Response amplification | Hard byte limits per kind; oversized compressed bodies get decode-only slack |
| SVG execution in image context | `_looks_svg()` rejects SVG masquerading as image content |
| Credential leakage | URLs with `user:pass@` are rejected at parse time |
| Proxy hijacking | `_PinnedConnection.connect()` opens a raw socket to the pinned address |
| Unbounded concurrency | `BoundedSemaphore(4)` on both fetches and DNS |
| Compressed bombs | Decompression bounded by `cap = limit + (64 KB if compressed)` |

---

## 13. File structure

```
server/reachd/browser.py
├── BrowserError          — ValueError subclass (message, status, code)
├── _remaining()          — Deadline calculator with enforcement
├── _decode_compressed()  — gzip/deflate/brotli decoder
├── _looks_svg()          — SVG-in-image detector
├── _parse_url()          — URL validation + normalization
├── _public_ip()          — IPv4/IPv6 global-address checker
├── _resolve_public()     — DNS lookup + public address enforcement
├── _PinnedConnection     — Custom HTTPConnection with pinned address
├── _DeflateReader        — Incremental zlib deflator
├── _BrotliReader         — Incremental brotli decompressor
├── _PageText             — HTML parser (text + title extraction)
├── fetch_page()          — Main entry point (parse → resolve → connect → decode → extract)
```

---

## 14. Comparison: Fetcher vs. Chromium engine

| Aspect | Fetcher (`browser.py`) | Chromium engine (`main.cjs`) |
|--------|----------------------|------------------------------|
| **State** | Stateless — each call independent | Stateful — tabs, sessions, history |
| **Rendering** | None — returns text/HTML | Offscreen painting at 15 fps |
| **JS execution** | None | `executeJavaScript()` for snapshots |
| **Navigation** | Single request per URL | Full browser navigation (back/forward/stop) |
| **Input** | None | Mouse + keyboard events |
| **Content types** | HTML, CSS, raster images | Any web page (but strips JS execution) |
| **SSRF** | DNS-resolve + public IP check | Parse URL + Chromium resolveHost + publicIp |
| **Concurrency** | 4 fetch slots + 4 DNS slots | 8 tabs + 64 pending commands |
| **Use case** | Reader mode (text extraction) | Interactive browser + agent browsing |
| **Install requirement** | None (stdlib only) | Electron runtime required |

The fetcher is for **reading content**. The engine is for **interacting with pages**.

---

## Related

- [`browser-engine.md`](./browser-engine.md) — The interactive Chromium engine
- [`browser-bridge.md`](./browser-bridge.md) — How Python talks to the Chromium engine
- [`overview.md`](./overview.md) — All three engines in one view
- `server/reachd/browser_engine.py` — Uses `_parse_url()` from this module for validation
- `specs/AGENT_UPGRADE_PLAN.md` — Browser tools (not fetcher, but shares SSRF patterns)
