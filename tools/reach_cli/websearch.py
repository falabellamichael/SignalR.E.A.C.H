"""Web search: DuckDuckGo scraping (SimpleRAG approach).

HTML endpoint first, the lite endpoint as fallback, rotating user
agents, rich answer modules, then page text extraction.
"""

import html.parser
import ipaddress
import random
import re
import socket
import urllib.error
import urllib.parse
import urllib.request

DDG_URL = "https://duckduckgo.com/html/"


def _host_is_safe(host):
    """Reject SSRF targets: only allow an http(s) host that resolves entirely
    to public addresses. Loopback, private, link-local, reserved, multicast,
    and unspecified addresses are blocked so a search result (or a redirect
    from one) can't reach the cloud metadata service or an intranet host."""
    if not host:
        return False
    host = host.strip("[]")
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError, OSError):
        return False
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (addr.is_loopback or addr.is_private or addr.is_link_local
                or addr.is_reserved or addr.is_multicast or addr.is_unspecified):
            return False
    return True


def _url_is_safe(url):
    parts = urllib.parse.urlsplit(url)
    return parts.scheme in ("http", "https") and _host_is_safe(parts.hostname)


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-run the SSRF host check on every redirect target, so a public page
    cannot 302 into the internal address range."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _url_is_safe(newurl):
            raise urllib.error.URLError("unsafe redirect target blocked")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_SAFE_OPENER = urllib.request.build_opener(_SafeRedirectHandler)


DDG_LITE_URL = "https://lite.duckduckgo.com/lite/"


MAX_PAGE_CHARS = 4000


PAGE_FETCH_LIMIT = 3


USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]




class DDGParser(html.parser.HTMLParser):
    """Parses both DDG endpoints:
    - html.duckduckgo.com/html: a.result__a links (uddg= redirect), result__snippet
    - lite.duckduckgo.com/lite: a.result-link links, td.result-snippet
    plus rich answer modules (module--answer etc.)."""

    ANSWER_CLASSES = (
        "module--answer",
        "module--about",
        "module--definition",
        "module--weather",
        "module--finance",
        "module--translation",
        "zci__result",
        "zci__main",
    )

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results = []
        self.rich_answer = []
        self._in_rich = 0
        self._in_title = False
        self._in_snippet = False
        self._url = None
        self._title = []
        self._snippet = []

    def handle_starttag(self, tag, attrs):
        attr = {k.lower(): (v or "") for k, v in attrs}
        cls = attr.get("class", "")
        tl = tag.lower()

        if self._in_rich:
            self._in_rich += 1
            return
        if any(a in cls for a in self.ANSWER_CLASSES):
            self._in_rich = 1
            return
        if tl == "a" and ("result__a" in cls or "result-link" in cls):
            href = attr.get("href", "")
            if "uddg=" in href:
                match = re.search(r"uddg=([^&]+)", href)
                self._url = urllib.parse.unquote(match.group(1)) if match else href
            else:
                self._url = href
            self._in_title = True
            self._title = []
        elif "result__snippet" in cls or "result-snippet" in cls:
            self._in_snippet = True
            self._snippet = []

    def handle_endtag(self, tag):
        tl = tag.lower()
        if self._in_rich:
            self._in_rich -= 1
            if self._in_rich <= 0:
                self._in_rich = 0
            return
        if tl == "a" and self._in_title:
            self._in_title = False
            title = " ".join(" ".join(self._title).split())
            # Scheme check only here (offline, no DNS); the real SSRF host gate
            # runs in fetch_text/_SafeRedirectHandler before anything is fetched.
            if title and self._url and \
                    urllib.parse.urlsplit(self._url).scheme in ("http", "https"):
                self.results.append({"title": title, "url": self._url, "snippet": ""})
            self._url = None
        elif self._in_snippet:
            self._in_snippet = False
            snippet = " ".join(" ".join(self._snippet).split())
            if snippet and self.results:
                self.results[-1]["snippet"] = snippet

    def handle_data(self, data):
        if self._in_rich:
            self.rich_answer.append(data)
        elif self._in_title:
            self._title.append(data)
        elif self._in_snippet:
            self._snippet.append(data)

    def rich_text(self):
        text = " ".join(" ".join(self.rich_answer).split())
        return text[:1200] if text else None




class TextExtractor(html.parser.HTMLParser):
    """Strips a fetched page down to readable text."""

    SKIP_TAGS = {
        "script",
        "style",
        "noscript",
        "svg",
        "header",
        "footer",
        "nav",
        "aside",
        "form",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag.lower() in self.SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag.lower() in self.SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data):
        if not self._skip_depth:
            self.parts.append(data)

    def text(self):
        text = re.sub(r"\s+", " ", " ".join(self.parts)).strip()
        return text[:MAX_PAGE_CHARS]




def _open(url, timeout=12, headers=None):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            **(headers or {}),
        },
    )
    # Route through the SSRF-checking opener so redirects are re-validated.
    return _SAFE_OPENER.open(request, timeout=timeout)




def search_web(query, count=6):
    """DuckDuckGo search; html endpoint first, lite as fallback."""
    params = urllib.parse.urlencode({"q": query})
    for base in (DDG_URL, DDG_LITE_URL):
        try:
            with _open(base + "?" + params, timeout=15) as resp:
                body = resp.read().decode("utf-8", "replace")
            parser = DDGParser()
            parser.feed(body)
            results = parser.results[:count]
            if results:
                return {
                    "results": results,
                    "rich": parser.rich_text(),
                    "engine": "duckduckgo",
                }
        except (urllib.error.URLError, OSError, ValueError):
            continue
    return {"results": [], "rich": None, "engine": None}




def fetch_text(url):
    """Readable text from a page, or None when unfetchable."""
    if not _url_is_safe(url):
        return None
    try:
        with _open(url, timeout=12) as resp:
            content_type = resp.headers.get("Content-Type", "")
            if "html" not in content_type and "text" not in content_type:
                return None
            body = resp.read(400_000).decode("utf-8", "replace")
        extractor = TextExtractor()
        extractor.feed(body)
        text = extractor.text()
        return text if len(text) > 120 else None
    except (urllib.error.URLError, OSError, ValueError, UnicodeDecodeError):
        return None
