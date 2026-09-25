"""Loopback control and watchdog for the installed REACH relay and tunnel."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from .config import runtime_port
from .publish import publish
from .runtime import port_open, public_url_from_server, start_server
from .tunnel import start_tunnel

CONTROL_PORT = 20778
_lock = threading.Lock()
_last_published_url = None
_last_publish_attempt = 0.0


def ensure_endpoint():
    """Start only the missing components; leave a healthy relay untouched."""
    global _last_published_url, _last_publish_attempt
    with _lock:
        port = runtime_port()
        if not port_open(port) and not start_server():
            return {"ok": False, "error": "Relay did not start; check reach.log"}
        url = public_url_from_server(port)
        if not url:
            if not start_tunnel("ngrok", port):
                return {"ok": False, "error": "Tunnel did not start; check tunnel.log"}
            url = public_url_from_server(port)
        if not url:
            return {"ok": False, "error": "Tunnel has no public URL"}
        if url != _last_published_url and time.monotonic() - _last_publish_attempt >= 300:
            _last_publish_attempt = time.monotonic()
            if publish(quiet=True):
                _last_published_url = url
        return {"ok": True, "public_url": url, "local_url": "http://127.0.0.1:%d/v1" % port}


def _allowed_origin(origin):
    if not origin:
        return True  # local CLI callers; browser calls must include an Origin
    parsed = urlsplit(origin)
    return (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")
            and parsed.port is not None and not parsed.username and not parsed.password)


class ControlHandler(BaseHTTPRequestHandler):
    def _reply(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        origin = self.headers.get("Origin", "")
        if origin and _allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-Reach-Action")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not _allowed_origin(self.headers.get("Origin", "")):
            self._reply(403, {"ok": False})
        else:
            self._reply(200, {"ok": True})

    def do_GET(self):
        if self.path != "/status" or not _allowed_origin(self.headers.get("Origin", "")):
            self._reply(404, {"ok": False})
            return
        port = runtime_port()
        url = public_url_from_server(port) if port_open(port) else None
        self._reply(200, {"ok": bool(url), "relay": port_open(port), "public_url": url})

    def do_POST(self):
        if (self.path != "/start" or self.headers.get("X-Reach-Action") != "start"
                or not _allowed_origin(self.headers.get("Origin", ""))):
            self._reply(403, {"ok": False, "error": "Start request not allowed"})
            return
        result = ensure_endpoint()
        self._reply(200 if result["ok"] else 503, result)

    def log_message(self, format_string, *args):
        pass


def run():
    def watch():
        while True:
            try:
                ensure_endpoint()
            except Exception as exc:
                print("supervisor: %s" % exc, flush=True)
            time.sleep(20)

    server = ThreadingHTTPServer(("127.0.0.1", CONTROL_PORT), ControlHandler)
    threading.Thread(target=watch, daemon=True).start()
    server.serve_forever()
