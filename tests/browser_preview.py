"""Local browser UI fixture: python -B tests/browser_preview.py (no relay state).

Serves the preview and extension assets. Reader fixture fetches never use the
network; other Reader URLs use the production public-page fetcher. Interactive
commands use the production local Chromium transport and public-address rules.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from reachd.browser import BrowserError, fetch_page
from reachd.browser_engine import ENGINE, MAX_BODY_BYTES, allowed_origin

ARTICLE = """<!doctype html><html><head><title>Research with sources</title>
<style>body { border-top: 4px solid #cc9838; } .reach-browser { display:none; }</style>
<meta http-equiv="refresh" content="0;url=https://unexpected.example/">
</head><body><article><h1>Research with sources</h1><p>Good research starts with a clear question.
Keep the evidence close, compare what you read, and keep a source for each claim.</p>
<p>Research becomes useful when the source is easy to revisit.</p>
<h2 id="evidence">Collect the evidence</h2><p>Select a passage or right-click this paragraph to save an excerpt.</p>
<a href="/next">Next research note</a> · <a href="#evidence">Jump to evidence</a>
<p><a href="javascript:parent.document.body.replaceChildren()">Unsafe link (inert)</a></p>
<img src="http://127.0.0.1:1/private" onerror="parent.document.body.replaceChildren()" alt="Example image">
<iframe src="https://unexpected.example/"></iframe><form action="https://unexpected.example/"><input value="Hidden form"></form>
<script>parent.document.getElementById('test-submit').textContent='UNSAFE SCRIPT';</script>
</article></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body, kind="application/json"):
        if isinstance(body, dict):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/tests/browser-preview.html"):
            return self.reply(200, (ROOT / "tests/browser-preview.html").read_bytes(), "text/html; charset=utf-8")
        if path.startswith("/src/"):
            target = (ROOT / path.lstrip("/")).resolve()
            if target.parent == (ROOT / "src") and target.suffix in (".js", ".css") and target.is_file():
                return self.reply(200, target.read_bytes(), "text/javascript" if target.suffix == ".js" else "text/css")
        self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if self.path == "/_reach/browser/engine":
            return self.browser_engine()
        if self.path not in ("/_reach/browser/fetch", "/_reach/browser/resource"):
            return self.reply(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 16384:
                return self.reply(400, {"error": "Invalid request size"})
            payload = json.loads(self.rfile.read(length))
            url = payload["url"]
            parts = urlsplit(url)
            if self.path.endswith('/resource'):
                if parts.hostname != 'fixture.example':
                    return self.reply(200, fetch_page(url, kind=payload.get('kind')))
                if payload.get('kind') == 'image':
                    return self.reply(200, {'url': url, 'content_type': 'image/png', 'encoding': 'base64',
                        'data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII='})
                return self.reply(200, {'url': url, 'content_type': 'text/css', 'encoding': 'utf-8',
                    'data': '.fixture-search {max-width:620px;margin:50px auto;text-align:center;} .fixture-search h1{font-size:42px;color:#1764a5;} .fixture-search input[type=search]{width:65%;} .external-style-proof{border:3px solid rgb(24,120,80);} </style><script>parent.document.body.replaceChildren()</script>'})
            if parts.hostname != "fixture.example":
                return self.reply(200, fetch_page(url))
            if parts.path == "/error":
                return self.reply(502, {"error": {"message": "Fixture website is unavailable. Try another page."}})
            if parts.path == "/slow":
                time.sleep(3)
            title = "Next research note" if parts.path == "/next" else "Research with sources"
            html = "<article><h1>Next research note</h1><p>Compare the evidence across sources.</p><a href='/article'>First research note</a></article>" if parts.path == "/next" else ARTICLE
            text = title + "\nGood research starts with a clear question. Keep a source for each claim."
            if parts.path == "/plain":
                html, text, title = "", "Plain text <script>must remain text</script>.", "Plain text document"
            if parts.path == '/search':
                import html as html_module
                query = parse_qs(parts.query).get('q', [''])[0]
                title = 'Search fixture'
                html = '<link rel="stylesheet" href="/search.css"><main class="fixture-search"><h1>Search fixture</h1><img src="/logo.png" alt="Search logo" width="48" height="48"><form action="/search" method="get"><label for="q">Search the web</label><input id="q" name="q" type="search" aria-label="Search the web"><input type="hidden" name="hl" value="en"><input type="submit" value="Search"><button name="mode" value="lucky">Feeling lucky</button></form><p class="external-style-proof">Stylesheet loaded</p><p>Query: ' + html_module.escape(query) + '</p></main>'
                text = 'Search fixture. Query: ' + query
            if parts.path == '/overflow':
                title = 'Overflow fixture'
                html = '<h1>Wide and long webpage</h1><div style="width:2400px;height:3000px;background:linear-gradient(90deg,#d9eef9,#f3e0ab)">Only this webpage should scroll.</div>'
                text = 'Wide and long webpage'
            self.reply(200, {"url": url, "title": title, "html": html, "text": text,
                             "content_type": "text/plain" if parts.path == "/plain" else "text/html", "truncated": False})
        except BrowserError as exc:
            self.reply(exc.status, {"error": {"message": str(exc)}})
        except (ValueError, KeyError, TypeError):
            self.reply(400, {"error": "Invalid request"})

    def browser_engine(self):
        # Keep the production engine's origin, body and session validation in
        # this local preview too. Reader fixtures never bypass Chromium rules.
        if (not allowed_origin(self.headers.get("Origin")) or any(
                self.headers.get(name) for name in
                ("Forwarded", "X-Forwarded-For", "X-Forwarded-Proto",
                 "X-Forwarded-Host", "Cf-Connecting-Ip", "X-Real-IP"))):
            self.close_connection = True
            return self.reply(403, {"error": {"message": "Use the direct local preview."}})
        if (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower() != "application/json":
            self.close_connection = True
            return self.reply(415, {"error": {"message": "Send browser commands as application/json."}})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= MAX_BODY_BYTES:
                self.close_connection = True
                return self.reply(400, {"error": {"message": "Invalid browser command size."}})
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            self.reply(200, ENGINE.request(body))
        except BrowserError as exc:
            self.reply(exc.status, {"error": {"message": str(exc), "code": exc.code}})
        except (ValueError, UnicodeError):
            self.close_connection = True
            self.reply(400, {"error": {"message": "Send a valid JSON browser command."}})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("Local preview: http://127.0.0.1:21887", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 21887), Handler).serve_forever()
