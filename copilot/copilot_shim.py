#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Copilot shim: OpenAI-compatible local endpoint bridging OmniRoute -> Microsoft Copilot chat.

- GET  /v1/models                    -> model ids this shim serves
- POST /v1/chat/completions          -> bridges to the Copilot backend chat API,
  wrapping the SSE stream into OpenAI chat.completion.chunk shape.

Auth: reads the Copilot web token from copilot_token.txt next to this script
(extracted from copilot.microsoft.com after login — see README below). The
token is NOT validated here; Microsoft returns 401 when it expires.

Stdlib only. Run with pythonw; watchdog cron checks port 21301.
"""
import json
import logging
import os
import threading
import time
import urllib.request
import urllib.error
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 21301
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "copilot_shim.log")
TOKEN_PATH = os.path.join(HERE, "copilot_token.txt")
UPSTREAM = "https://copilot.microsoft.com/backend-api/v1"

MODEL_ID = "copilot-chat"

logging.basicConfig(filename=LOG, level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("copilot_shim")

try:
    TOKEN = open(TOKEN_PATH, encoding="utf-8").read().strip()
except OSError:
    TOKEN = ""
log.info("copilot token %s", "present" if TOKEN else "MISSING")

TOKEN_LOCK = __import__("threading").Lock()


def _jwt_exp(token):
    """Decode the exp claim (no signature check — just for expiry timing)."""
    try:
        import base64
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
        return data.get("exp")
    except Exception:
        return None


def _save_token(token):
    global TOKEN
    TOKEN = token
    try:
        with open(TOKEN_PATH, "w", encoding="utf-8") as handle:
            handle.write(token)
        log.info("refreshed copilot token persisted (%d chars)", len(token))
    except OSError as exc:
        log.warning("could not persist refreshed token: %s", exc)


def refresh_token():
    """Exchange the current token for a fresh one (the same endpoint the
    Copilot web app uses to extend its session). Best-effort; Microsoft may
    change this surface, in which case the 401 path asks for a re-grab."""
    import time as _time
    global TOKEN
    if not TOKEN:
        return False
    request = urllib.request.Request(
        UPSTREAM + "/token", method="POST",
        headers={"Authorization": "Bearer " + TOKEN,
                 "Content-Type": "application/json",
                 "x-client": "copilot"})
    try:
        with urllib.request.urlopen(request) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        new_token = data.get("token") or data.get("access_token") \
            or (data.get("data") or {}).get("token")
        if new_token and new_token != TOKEN:
            _save_token(new_token)
            return True
        log.info("token endpoint returned no new token (still valid?)")
        return True
    except urllib.error.HTTPError as exc:
        log.warning("token refresh HTTP %d: %s", exc.code,
                    exc.read().decode("utf-8", "replace")[:160])
        return False
    except Exception as exc:
        log.warning("token refresh failed: %s", exc)
        return False


def ensure_fresh_token():
    """Refresh when the JWT is close to expiry (or already expired)."""
    exp = _jwt_exp(TOKEN)
    if exp and exp - 300 < int(time.time()):
        with TOKEN_LOCK:
            refreshed = refresh_token()
        log.info("token auto-refresh %s", "ok" if refreshed else "failed")
    return bool(TOKEN)


def flatten_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            p.get("text", "") for p in content
            if isinstance(p, dict) and p.get("type") == "text")
    return str(content)


BRIDGE_URL = "http://127.0.0.1:21302"


def copilot_chat(messages, max_tokens=None, timeout=None):
    """Call Copilot through the local bridge (browser-context fetch).
    Returns (status, [content deltas], error)."""
    user_messages = [{"role": m.get("role", "user"),
                      "content": flatten_content(m.get("content", ""))}
                     for m in messages
                     if m.get("role") in ("system", "developer", "user", "assistant", "tool")]
    if not user_messages:
        user_messages = [{"role": "user", "content": "Hello"}]
    request = urllib.request.Request(
        BRIDGE_URL, data=json.dumps({"messages": user_messages}).encode(),
        method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return exc.code, [], exc.read().decode("utf-8", "replace")[:300]
    except Exception as exc:
        return 502, [], str(exc)[:200]
    if not data.get("ok"):
        error = data.get("error") or "bridge failure"
        log.warning("bridge error: %s", error[:200])
        if "no page target" in error or "ECONNREFUSED" in error or "no Copilot page" in error:
            return 503, [], ("Copilot bridge unavailable — the M365 Copilot "
                             "browser session is not running. (%s)" % error[:120])
        if "not signed in" in error:
            return 503, [], ("Microsoft 365 Copilot is signed out — sign in "
                             "once in the bridge browser window, then retry.")
        return 502, [], error
    content = data.get("content") or ""
    return 200, [content], None


def _legacy_copilot_chat(messages, max_tokens=None, timeout=None):
    """Direct backend call (Cloudflare-blocked for non-browser clients; kept
    for reference — the bridge path is the live one)."""
    ensure_fresh_token()
    if not TOKEN:
        return 401, [], "no Copilot token configured"
    user_messages = [{"role": m.get("role", "user"),
                      "content": flatten_content(m.get("content", ""))}
                     for m in messages
                     if m.get("role") in ("user", "assistant")]
    if not user_messages:
        user_messages = [{"role": "user", "content": "Hello"}]
    payload = {"message": user_messages[-1], "conversationId": None,
               "stream": True}
    request = urllib.request.Request(
        UPSTREAM + "/chat",
        data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + TOKEN,
                 "x-client": "copilot"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            if resp.headers.get("Content-Type", "").startswith("text/event-stream"):
                deltas = []
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        event = json.loads(chunk)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") == "content":
                        body = event.get("body") or {}
                        text = body.get("text")
                        if text:
                            deltas.append(text)
                return 200, deltas, None
            data = json.loads(resp.read().decode("utf-8", "replace"))
            # non-stream shape (some backends): pull content directly
            choices = data.get("choices") or []
            if choices and isinstance(choices[0].get("message", {}).get("content"), str):
                return 200, [choices[0]["message"]["content"]], None
            return 200, [json.dumps(data)], None
    except urllib.error.HTTPError as exc:
        return exc.code, [], exc.read().decode("utf-8", "replace")[:300]
    except Exception as exc:
        return 502, [], str(exc)[:200]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info("http %s", fmt % args)

    def _send_json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            self._send_json(200, {"object": "list", "data": [
                {"id": MODEL_ID, "object": "model", "owned_by": "copilot"}]})
            return
        self._send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send_json(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode() or "{}")
        except Exception as exc:
            self._send_json(400, {"error": {"message": "bad request: %s" % exc}})
            return
        messages = body.get("messages", [])
        stream = bool(body.get("stream", False))
        created = int(time.time())
        # Always respond as SSE: send headers immediately (beats upstream
        # first-byte budgets) and keepalive while the bridge waits on Copilot.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def chunk(payload):
            line = "data: " + json.dumps(payload) + "\n\n"
            self.wfile.write(("%x\r\n" % len(line.encode())).encode()
                             + line.encode() + b"\r\n")

        keep = {"go": True}

        def keepalive():
            while keep["go"]:
                time.sleep(4)
                if not keep["go"]:
                    break
                try:
                    chunk({"id": "chatcmpl-" + uuid.uuid4().hex[:24],
                           "object": "chat.completion.chunk", "created": created,
                           "model": MODEL_ID,
                           "choices": [{"index": 0, "delta": {},
                                        "finish_reason": None}]})
                except Exception:
                    break

        t = threading.Thread(target=keepalive, daemon=True)
        t.start()
        try:
            status, deltas, error = copilot_chat(messages)
        finally:
            keep["go"] = False
        if status != 200:
            message = error or "copilot upstream error"
            chunk({"error": {"message": message, "type": "upstream_error",
                             "code": "upstream_unavailable"}})
            chunk({"id": "chatcmpl-" + uuid.uuid4().hex[:24],
                   "object": "chat.completion.chunk", "created": created,
                   "model": MODEL_ID,
                   "choices": [{"index": 0, "delta": {},
                                "finish_reason": "stop"}]})
            self.wfile.write(b"0\r\n\r\n")
            return
        content = "".join(deltas)
        if stream:
            chunk({"id": "chatcmpl-" + uuid.uuid4().hex[:24],
                   "object": "chat.completion.chunk", "created": created,
                   "model": MODEL_ID,
                   "choices": [{"index": 0, "delta": {"content": content},
                                "finish_reason": None}]})
            chunk({"id": "chatcmpl-" + uuid.uuid4().hex[:24],
                   "object": "chat.completion.chunk", "created": created,
                   "model": MODEL_ID,
                   "choices": [{"index": 0, "delta": {},
                                "finish_reason": "stop"}]})
            self.wfile.write(b"0\r\n\r\n")
            return
        # non-stream client: single content chunk then end (still SSE-wrapped;
        # gateways that requested JSON will convert)
        chunk({"id": "chatcmpl-" + uuid.uuid4().hex[:24],
               "object": "chat.completion.chunk", "created": created,
               "model": MODEL_ID,
               "choices": [{"index": 0, "delta": {"content": content},
                            "finish_reason": "stop"}]})
        self.wfile.write(b"0\r\n\r\n")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log.info("Copilot shim listening on 127.0.0.1:%d (token: %s)",
             PORT, "present" if TOKEN else "MISSING")
    server.serve_forever()
