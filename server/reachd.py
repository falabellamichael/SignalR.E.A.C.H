#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SimpleREACH relay — OpenAI-compatible endpoint backed by OmniRoute's codegpt gpt-4o.

REACH = RAG Endpoint & AI Chat Host.

Routes (all CORS-open; the relay itself binds loopback by default):
  GET  /health                liveness + upstream status (never gated)
  GET  /status                health + stats + public URL
  GET  /public-url            {"public_url": ..., "source": ...}
  GET  /v1/models             pinned model list: gpt-4o
  POST /v1/chat/completions   proxied to OmniRoute with the model pinned to
                              codegpt/codegpt-gpt-4o (stream + non-stream)
  POST /_reach/public-url     manual public-URL override (used by the CLI for
                              cloudflared tunnels; loopback-only in practice)

The OmniRoute bearer key lives ONLY in config.json next to this server and is
injected server-side — public clients never see it and need no key at all.

Config: %LOCALAPPDATA%\\SimpleREACH\\config.json
  {omniroute_url, omniroute_key, port, host, tunnel, public_url_override}
"""

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0.0"
SERVICE = "simplereach"
UPSTREAM_MODEL = "codegpt/codegpt-gpt-4o"
PUBLIC_MODEL = "gpt-4o"
ALIASES = {PUBLIC_MODEL: UPSTREAM_MODEL, UPSTREAM_MODEL: UPSTREAM_MODEL}
DEFAULT_PORT = 20777
MAX_BODY_BYTES = 32 * 1024 * 1024

STATE = None          # RelayState, set in main()
PORT = DEFAULT_PORT   # resolved port, set in main()


def config_dir():
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "SimpleREACH"


def load_config(path):
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    return {}


class RelayState:
    def __init__(self, cfg, cfg_path):
        self.cfg = cfg
        self.cfg_path = cfg_path
        self.public_url = None
        self.public_url_source = None       # 'ngrok' | 'manual' | None
        self.requests_served = 0
        self.errors = 0
        self.started_at = time.time()
        self.upstream_ok = None
        self.upstream_checked = 0.0
        self._lock = threading.RLock()

    @property
    def omniroute_url(self):
        return self.cfg.get("omniroute_url", "http://127.0.0.1:20128/v1")

    @property
    def key(self):
        return self.cfg.get("omniroute_key", "")

    def upstream_alive(self):
        with self._lock:
            now = time.time()
            if self.upstream_checked and now - self.upstream_checked < 60:
                return self.upstream_ok
        ok = False
        if self.key:
            try:
                req = urllib.request.Request(
                    self.omniroute_url.rstrip("/") + "/models",
                    headers={"Authorization": "Bearer " + self.key})
                with urllib.request.urlopen(req, timeout=4) as resp:
                    ok = resp.status == 200
            except Exception:
                ok = False
        with self._lock:
            self.upstream_ok = ok
            self.upstream_checked = time.time()
        return ok

    def discover_public_url(self):
        """Read the public URL from ngrok's local API (127.0.0.1:4040)."""
        if self.cfg.get("tunnel", "ngrok") != "ngrok":
            return None, None
        try:
            req = urllib.request.Request("http://127.0.0.1:4040/api/tunnels")
            with urllib.request.urlopen(req, timeout=2) as resp:
                payload = json.loads(resp.read().decode("utf-8", "replace"))
            for tun in payload.get("tunnels", []):
                if tun.get("proto") == "https" and tun.get("public_url"):
                    return tun["public_url"], "ngrok"
        except Exception:
            pass
        return None, None

    def poll_public_url(self):
        manual = (self.cfg.get("public_url_override") or "").strip() or None
        if manual:
            with self._lock:
                self.public_url, self.public_url_source = manual, "manual"
            return
        url, source = self.discover_public_url()
        if url:
            with self._lock:
                self.public_url, self.public_url_source = url, source

    def snapshot(self):
        with self._lock:
            return {
                "service": SERVICE,
                "version": VERSION,
                "ok": True,
                "port": PORT,
                "upstream": self.omniroute_url,
                "upstream_ok": self.upstream_alive(),
                "model": PUBLIC_MODEL,
                "upstream_model": UPSTREAM_MODEL,
                "public_url": self.public_url,
                "public_url_source": self.public_url_source,
                "requests_served": self.requests_served,
                "errors": self.errors,
                "uptime_s": round(time.time() - self.started_at, 1),
            }


class RelayHandler(BaseHTTPRequestHandler):
    server_version = "SimpleREACH/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # counters above are the signal; keep the console clean

    # ------------------------------------------------------------------ helpers
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        if length > MAX_BODY_BYTES:
            raise ValueError("request body too large")
        return self.rfile.read(length)

    def _count_error(self):
        with STATE._lock:
            STATE.errors += 1

    def _relay_upstream_error(self, exc, default_message, default_status=502):
        self._count_error()
        status = getattr(exc, "code", default_status)
        try:
            raw = exc.read() if hasattr(exc, "read") else b""
            if raw:
                payload = json.loads(raw.decode("utf-8", "replace"))
                if isinstance(payload, dict):
                    return self._json(min(status, 599) or default_status, payload)
        except Exception:
            pass
        message = default_message
        reason = getattr(exc, "reason", None)
        if reason:
            message = "%s (%s)" % (default_message, reason)
        self._json(default_status, {
            "error": {"message": message, "type": "server_error", "code": "upstream_error"},
        })

    def _write_chunk(self, data):
        try:
            self.wfile.write(("%x\r\n" % len(data)).encode("ascii") + data + b"\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise

    # ------------------------------------------------------------------- routes
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path == "/health" or path == "/status":
                self._json(200, STATE.snapshot())
            elif path == "/public-url":
                self._json(200, {
                    "public_url": STATE.public_url,
                    "source": STATE.public_url_source,
                })
            elif path == "/v1/models":
                self._json(200, {
                    "object": "list",
                    "data": [{
                        "id": PUBLIC_MODEL,
                        "object": "model",
                        "created": 1715367049,
                        "owned_by": "SimpleREACH",
                    }],
                })
            else:
                self._json(404, {"error": {"message": "Not found: " + path,
                                           "type": "not_found"}})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # keep the server alive on handler bugs
            self._count_error()
            self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path == "/_reach/public-url":
                self.handle_public_url_override()
            elif path == "/v1/chat/completions":
                self.handle_chat()
            else:
                self._json(404, {"error": {"message": "Not found: " + path,
                                           "type": "not_found"}})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._count_error()
            self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})

    def handle_public_url_override(self):
        body = self._read_body()
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            return self._json(400, {"error": {"message": "invalid JSON",
                                              "type": "invalid_request"}})
        url = (data.get("public_url") or "").strip()
        if url:
            STATE.cfg["public_url_override"] = url
            try:
                STATE.cfg_path.write_text(json.dumps(STATE.cfg, indent=2),
                                          encoding="utf-8")
            except OSError:
                pass
        else:
            STATE.cfg.pop("public_url_override", None)
        STATE.poll_public_url()
        self._json(200, {"public_url": STATE.public_url,
                         "source": STATE.public_url_source})

    def handle_chat(self):
        body = self._read_body()
        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self._json(400, {"error": {"message": "invalid JSON body",
                                              "type": "invalid_request"}})
        if not isinstance(payload, dict):
            return self._json(400, {"error": {"message": "invalid request body",
                                              "type": "invalid_request"}})
        requested = payload.get("model") or ""
        if requested not in ALIASES:
            return self._json(404, {
                "error": {
                    "message": ("SimpleREACH serves model '%s' only (requested: %r)."
                                % (PUBLIC_MODEL, requested)),
                    "type": "invalid_request_error",
                    "param": "model",
                    "code": "model_not_found",
                },
            })
        if not STATE.key:
            return self._json(503, {
                "error": {"message": "SimpleREACH is not configured yet "
                                     "(no OmniRoute key in config.json).",
                          "type": "server_error"},
            })
        payload["model"] = UPSTREAM_MODEL
        stream = bool(payload.get("stream"))
        url = STATE.omniroute_url.rstrip("/") + "/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + STATE.key})
        with STATE._lock:
            STATE.requests_served += 1
        try:
            upstream = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as exc:
            return self._relay_upstream_error(exc, "OmniRoute rejected the request")
        except (urllib.error.URLError, OSError) as exc:
            return self._relay_upstream_error(exc, "OmniRoute unreachable")

        content_type = upstream.headers.get("Content-Type", "application/json")
        if stream:
            self.send_response(200)
            self.send_header("Content-Type", content_type or "text/event-stream")
            self._cors()
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                while True:
                    line = upstream.readline()
                    if not line:
                        break
                    self._write_chunk(line)
            finally:
                self._write_chunk(b"")
                try:
                    upstream.close()
                except Exception:
                    pass
        else:
            data = upstream.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self._cors()
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    global STATE, PORT
    parser = argparse.ArgumentParser(description="SimpleREACH relay server")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--config-dir", default=None)
    args = parser.parse_args()

    cfg_path = Path(args.config_dir) if args.config_dir else config_dir() / "config.json"
    cfg = load_config(cfg_path)
    STATE = RelayState(cfg, cfg_path)
    PORT = args.port or int(cfg.get("port", DEFAULT_PORT))
    host = cfg.get("host", "127.0.0.1")

    try:
        httpd = ThreadingHTTPServer((host, PORT), RelayHandler)
    except OSError as exc:
        print("SimpleREACH: cannot bind %s:%d — %s" % (host, PORT, exc),
              file=sys.stderr)
        sys.exit(1)

    STATE.poll_public_url()

    def poller():
        while True:
            time.sleep(20)
            STATE.poll_public_url()

    threading.Thread(target=poller, daemon=True).start()
    print("SimpleREACH %s listening on http://%s:%d" % (VERSION, host, PORT),
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
