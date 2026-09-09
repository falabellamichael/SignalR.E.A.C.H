"""Bounded public web-page retrieval for the local REACH Browser reader.

Returned HTML is untrusted. Consumers must sanitize it and use a sandbox; this
module retrieves documents only, without scripts, cookies, or subresources.
"""

import base64
import concurrent.futures
import http.client
import ipaddress
import socket
import ssl
import threading
import time
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit, urlunsplit


MAX_PAGE_BYTES = 2 * 1024 * 1024
FETCH_TIMEOUT = 12
MAX_REDIRECTS = 5
_FETCH_SLOTS = threading.BoundedSemaphore(4)
_DNS_SLOTS = threading.BoundedSemaphore(4)
_DNS_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4,
                                                thread_name_prefix="reach-browser-dns")
_HTML_TYPES = {"text/html", "application/xhtml+xml"}
_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/x-icon", "image/vnd.microsoft.icon"}


class BrowserError(ValueError):
    def __init__(self, message, status=400, code="invalid_url"):
        super().__init__(message)
        self.status = status
        self.code = code


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise BrowserError("The page took too long to respond.", 504, "fetch_timeout")
    return remaining


def _parse_url(url):
    if not isinstance(url, str) or not url.strip() or len(url) > 8192:
        raise BrowserError("Enter an HTTP or HTTPS page URL (up to 8192 characters).")
    url = url.strip()
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in url) or "\\" in url:
        raise BrowserError("The page URL contains invalid characters.")
    try:
        parts = urlsplit(url)
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
            raise ValueError()
        if parts.username is not None or parts.password is not None:
            raise BrowserError("URLs containing usernames or passwords are not supported.")
        host = parts.hostname.encode("idna").decode("ascii")
        if "%" in host or len(host) > 253:
            raise ValueError()
        port = parts.port if parts.port is not None else (443 if parts.scheme.lower() == "https" else 80)
        if not 1 <= port <= 65535:
            raise ValueError()
    except BrowserError:
        raise
    except (ValueError, UnicodeError):
        raise BrowserError("Enter a valid HTTP or HTTPS page URL.") from None
    authority = "[%s]" % host if ":" in host else host
    if parts.port is not None:
        authority += ":%s" % parts.port
    path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parts.query, safe="/%?:@!$&'()*+,;=-._~")
    normalized = urlunsplit((parts.scheme.lower(), authority, path, query, ""))
    return normalized, host, port, parts.scheme.lower(), path + ("?" + query if query else "")


def _public_ip(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        # Do not allow transition mechanisms to smuggle an IPv4 destination.
        if address.ipv4_mapped or address.sixtofour or address.teredo:
            return False
        if address in ipaddress.ip_network("64:ff9b::/96"):
            return False
    return (address.is_global and not address.is_private and not address.is_loopback
            and not address.is_link_local and not address.is_multicast
            and not address.is_reserved and not address.is_unspecified)


_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"}


def _resolve_public(host, port, deadline, allow_loopback=False):
    # DNS is separately bounded: a timed-out system resolver keeps its slot
    # until it finishes, so repeated timeouts cannot create an unbounded queue.
    if not _DNS_SLOTS.acquire(blocking=False):
        raise BrowserError("Browser lookup is busy. Try again shortly.", 429, "browser_busy")
    try:
        future = _DNS_POOL.submit(socket.getaddrinfo, host, port, 0, socket.SOCK_STREAM)
    except Exception:
        _DNS_SLOTS.release()
        raise
    future.add_done_callback(lambda completed: _DNS_SLOTS.release())
    try:
        addresses = future.result(timeout=_remaining(deadline))
    except concurrent.futures.TimeoutError:
        raise BrowserError("The page address took too long to resolve.", 504,
                           "fetch_timeout") from None
    except OSError:
        raise BrowserError("The page address could not be resolved.", 502,
                           "fetch_failed") from None
    if not addresses:
        raise BrowserError("The page address could not be resolved.", 502,
                           "fetch_failed") from None

    def _ok(item):
        addr = item[4][0]
        if _public_ip(addr):
            return True
        if allow_loopback:
            try:
                return ipaddress.ip_address(addr).is_loopback
            except ValueError:
                return False
        return False

    if any(not _ok(item) for item in addresses):
        raise BrowserError("Only public websites can be opened. Local and private addresses are blocked.",
                           403, "blocked_address")
    if allow_loopback:
        # Local servers commonly bind IPv4 only; prefer it over ::1.
        addresses = sorted(addresses, key=lambda a: 0 if a[4][0].startswith("127.") else 1)
    return addresses


class _PinnedConnection(http.client.HTTPConnection):
    """Connect directly to an already-validated address, preserving TLS SNI.

    No proxy environment variables, secondary DNS lookup, or cookies are used.
    A watchdog shuts down the socket at the shared deadline, including during
    response headers, TLS, and slow trickle responses.
    """

    def __init__(self, host, port, address, secure, deadline):
        super().__init__(host, port, timeout=_remaining(deadline))
        self._address = address
        self._secure = secure
        self._deadline = deadline
        self._watchdog = None
        self._active_sock = None

    def connect(self):
        family, socktype, proto, _, sockaddr = self._address
        self.sock = socket.socket(family, socktype, proto)
        self._active_sock = self.sock
        self.sock.settimeout(_remaining(self._deadline))
        self._watchdog = threading.Timer(_remaining(self._deadline), self._expire)
        self._watchdog.daemon = True
        self._watchdog.start()
        self.sock.connect(sockaddr)
        if self._secure:
            context = ssl.create_default_context()
            self.sock = context.wrap_socket(self.sock, server_hostname=self.host,
                                            do_handshake_on_connect=False)
            self._active_sock = self.sock
            self.sock.do_handshake()

    def _expire(self):
        # HTTPConnection may set self.sock to None once it hands a closing
        # response to HTTPResponse. Its file still owns this socket until read.
        sock = self._active_sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()

    def finish(self):
        if self._watchdog is not None:
            self._watchdog.cancel()
        super().close()


class _PageText(HTMLParser):
    _HIDDEN = {"script", "style", "template", "noscript", "svg", "head"}
    _BLOCKS = {"p", "div", "article", "section", "main", "br", "li", "h1", "h2",
               "h3", "h4", "h5", "h6", "tr", "blockquote", "pre"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.in_title = False
        self.title = []
        self.text = []

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
        if tag in self._HIDDEN:
            self.hidden.append(tag)
        if tag in self._BLOCKS and not self.hidden:
            self.text.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag in self.hidden:
            self.hidden = self.hidden[:self.hidden.index(tag)]
        if tag in self._BLOCKS and not self.hidden:
            self.text.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        elif not self.hidden:
            self.text.append(data)


def fetch_page(url, kind="page"):
    """Fetch a public document, stylesheet, or raster image through the same gates.

    Resources return data (UTF-8 CSS or base64 raster bytes), never an executable
    response from the relay origin. SVG and HTML disguised as images are rejected.
    """
    if kind not in ("page", "image", "style"):
        raise BrowserError("Unsupported browser resource type.")
    limit = MAX_PAGE_BYTES if kind == "page" else 512 * 1024
    allowed_types = _HTML_TYPES | {"text/plain"} if kind == "page" else _IMAGE_TYPES if kind == "image" else {"text/css"}
    if not _FETCH_SLOTS.acquire(blocking=False):
        raise BrowserError("The browser is busy. Try again shortly.", 429, "browser_busy")
    deadline = time.monotonic() + FETCH_TIMEOUT
    try:
        for redirects in range(MAX_REDIRECTS + 1):
            url, host, port, scheme, target = _parse_url(url)
            # Local dev servers (localhost:PORT) are a first-class use case,
            # so the FIRST hop may be loopback-only; redirects stay strictly
            # public (SSRF guard for pages that bounce to internal hosts).
            allow_loopback = redirects == 0 and host.lower() in _LOOPBACK_HOSTS
            addresses = _resolve_public(host, port, deadline, allow_loopback)
            connection = _PinnedConnection(host, port, addresses[0], scheme == "https", deadline)
            response = None
            try:
                connection.request("GET", target, headers={
                    "User-Agent": "SignalREACH-Browser/1.0",
                    "Accept": ",".join(sorted(allowed_types)),
                    "Accept-Encoding": "identity",
                    "Connection": "close",
                })
                response = connection.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if not location or redirects == MAX_REDIRECTS:
                        raise BrowserError("The page redirected too many times or has no destination.",
                                           502, "redirect_failed")
                    url = urljoin(url, location)
                    continue
                if not 200 <= response.status < 300:
                    raise BrowserError("The website returned HTTP %s." % response.status,
                                       502, "fetch_failed")
                content_type = response.headers.get_content_type().lower()
                if content_type not in allowed_types:
                    raise BrowserError("This address did not return a supported " + kind + ". Open it externally to view or download it.",
                                       415, "unsupported_content")
                if (response.getheader("Content-Encoding") or "identity").lower() != "identity":
                    raise BrowserError("The website returned an unsupported compressed response.",
                                       415, "unsupported_content")
                chunks, size = [], 0
                while size <= limit:
                    _remaining(deadline)
                    chunk = response.read1(min(65536, limit + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                _remaining(deadline)
                data = b"".join(chunks)[:limit]
                if kind != "page" and size > limit:
                    raise BrowserError("The page resource is too large.", 415, "resource_too_large")
                if kind == "image":
                    signatures = {
                        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
                        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
                        "image/gif": data.startswith((b"GIF87a", b"GIF89a")),
                        "image/webp": data[:4] == b"RIFF" and data[8:12] == b"WEBP",
                        "image/avif": data[4:8] == b"ftyp" and (b"avif" in data[8:32] or b"avis" in data[8:32]),
                        "image/x-icon": data.startswith(b"\x00\x00\x01\x00"),
                        "image/vnd.microsoft.icon": data.startswith(b"\x00\x00\x01\x00"),
                    }
                    if not signatures.get(content_type):
                        raise BrowserError("The image format does not match its content type.", 415, "unsupported_content")
                    return {"url": url, "content_type": content_type, "encoding": "base64",
                            "data": base64.b64encode(data).decode("ascii")}
                charset = response.headers.get_content_charset() or "utf-8"
                try:
                    document = data.decode(charset, "replace")
                except (LookupError, UnicodeError):
                    document = data.decode("utf-8", "replace")
                if kind == "style":
                    return {"url": url, "content_type": content_type, "encoding": "utf-8", "data": document}
                html, title, text = "", host, document
                if content_type in _HTML_TYPES:
                    html = document
                    parser = _PageText()
                    parser.feed(document)
                    title = " ".join("".join(parser.title).split())[:512] or host
                    text = "\n".join(line for part in "".join(parser.text).splitlines()
                                     if (line := " ".join(part.split())))
                return {"url": url, "title": title, "html": html, "text": text,
                        "content_type": content_type, "truncated": size > MAX_PAGE_BYTES}
            finally:
                if response is not None:
                    response.close()
                connection.finish()
    except BrowserError:
        raise
    except (OSError, http.client.HTTPException):
        _remaining(deadline)
        raise BrowserError("The website could not be reached securely. Try again or open it externally.",
                           502, "fetch_failed") from None
    finally:
        _FETCH_SLOTS.release()
