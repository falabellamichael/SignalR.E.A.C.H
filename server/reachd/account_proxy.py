"""Narrow loopback proxy for hosted wallet accounts and metered model requests.

The public tunnel continues to terminate on reachd. Customer sessions always go
through the account service and can never become local-owner relay requests.
"""
import http.client
import ipaddress
import re
import socket
import time
from urllib.parse import urlsplit

import reachd.core as core
from reachd.const import CLIENT_DISCONNECT_ERRORS

ACCOUNT_PATHS = frozenset((
    "/wallet/connect", "/wallet/redeem", "/wallet/app.js", "/wallet/style.css",
    "/v1/auth/start", "/v1/auth/challenge", "/v1/auth/verify", "/v1/auth/exchange", "/v1/auth/logout",
    "/v1/account/config", "/v1/account", "/v1/redemptions/start", "/v1/redemptions/details", "/v1/redemptions/submit",
))
MODEL_PATHS = {"/v1/models": "/v1/models", "/models": "/v1/models",
               "/v1/chat/completions": "/v1/chat/completions", "/chat/completions": "/v1/chat/completions"}
MAX_REQUEST = 512 * 1024
MAX_RESPONSE = 1024 * 1024
MAX_STREAM = 2 * 1024 * 1024
FORWARD_HEADERS = ("Authorization", "Content-Type", "Origin", "Idempotency-Key")
RESPONSE_HEADERS = ("Content-Type", "Cache-Control", "Content-Security-Policy", "Referrer-Policy",
                    "X-Content-Type-Options", "X-Frame-Options", "X-Request-Id", "X-Reach-Replayed", "Retry-After")


def account_service_target(value):
    """Only literal loopback destinations, so a hostname cannot rebind remotely."""
    if not isinstance(value, str) or len(value) > 500:
        raise ValueError("account_service_url must be a loopback HTTP(S) origin")
    parts = urlsplit(value)
    try:
        host = ipaddress.ip_address(parts.hostname or "")
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError("account_service_url must use a literal loopback address") from exc
    if (parts.scheme not in ("http", "https") or not host.is_loopback
            or parts.username or parts.password or parts.path not in ("", "/")
            or parts.query or parts.fragment or not 1 <= port <= 65535):
        raise ValueError("account_service_url must be a loopback HTTP(S) origin without credentials or a path")
    return parts.scheme, str(host), port


def customer_session(headers):
    # Malformed/case-varied session credentials still enter the account service,
    # whose strict parser rejects them. They must never inherit local bypass.
    authorization = headers.get("Authorization", "")
    return bool(re.match(r"^\s*Bearer\s+rch_session_", authorization, re.I)
                or headers.get("X-Reach-Key", "").lower().startswith("rch_session_"))


def _error(h, status, code, message):
    h._json(status, {"error": {"code": code, "message": message, "type": "account_service_error"}})


def try_account_proxy(h):
    """Return True once a request belongs to accounts, including failed proxies."""
    try:
        parts = urlsplit(h.path)
    except ValueError:
        if customer_session(h.headers):
            _error(h, 400, "invalid_url", "Invalid account request URL.")
            return True
        return False
    path = parts.path
    customer = customer_session(h.headers)
    if path not in ACCOUNT_PATHS and not (customer and path in MODEL_PATHS):
        return False
    # The route allowlist is intentionally exact; no prefix-based access to
    # account health, admin APIs, private files, or arbitrary upstream URLs.
    target = core.STATE.cfg.get("account_service_url", "")
    if not target:
        _error(h, 503, "accounts_unconfigured", "REACH wallet access is not configured on this host.")
        return True
    connection = None
    sent_headers = False
    previous_timeout = h.connection.gettimeout()
    try:
        scheme, host, port = account_service_target(target)
        if port == h.server.server_address[1]:
            raise ValueError("Account service cannot point at the relay itself")
        if len(h.path) > 8192:
            _error(h, 414, "url_too_long", "Request URL is too long.")
            return True
        if h.command not in ("GET", "POST"):
            _error(h, 405, "method_not_allowed", "Use GET or POST for this account route.")
            return True
        if h.headers.get("Transfer-Encoding"):
            _error(h, 400, "unsupported_transfer", "Supply a Content-Length for account requests.")
            return True
        lengths = h.headers.get_all("Content-Length", [])
        if len(lengths) > 1:
            _error(h, 400, "invalid_length", "Invalid request length.")
            return True
        try:
            length = int(lengths[0]) if lengths else 0
        except ValueError:
            length = -1
        if length < 0 or length > MAX_REQUEST:
            _error(h, 413 if length > MAX_REQUEST else 400, "body_limit", "Invalid account request size.")
            return True
        if h.command == "GET" and length:
            _error(h, 400, "unexpected_body", "GET requests cannot contain a body.")
            return True
        h.connection.settimeout(15)
        body = h._read_exact(length) if length else None
        if body is not None and len(body) != length:
            _error(h, 400, "incomplete_body", "The account request body was incomplete.")
            return True
        h.connection.settimeout(135)
        connection_class = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        connection = connection_class(host, port, timeout=125)
        headers = {key: h.headers[key] for key in FORWARD_HEADERS if h.headers.get(key) is not None}
        headers["X-Reach-Client-IP"] = h._client_ip()
        headers["Content-Length"] = str(length)
        headers["Cache-Control"] = "no-store"
        headers["Connection"] = "close"
        # Never copy forwarded Host, cookies, owner keys, or customer-controlled
        # proxy headers. The account service's configured origin binds SIWE.
        forward_path = MODEL_PATHS[path] if customer and path in MODEL_PATHS else path
        if parts.query:
            forward_path += "?" + parts.query
        connection.request(h.command, forward_path, body=body, headers=headers)
        upstream = connection.getresponse()
        if 300 <= upstream.status < 400:
            _error(h, 502, "account_redirect", "The account service returned an unexpected redirect.")
            return True
        response_headers = {key: upstream.getheader(key) for key in RESPONSE_HEADERS if upstream.getheader(key) is not None}
        response_headers.setdefault("Cache-Control", "no-store")
        response_headers.setdefault("X-Content-Type-Options", "nosniff")
        response_headers.setdefault("Content-Type", "application/json; charset=utf-8")
        streaming = "text/event-stream" in response_headers["Content-Type"].lower()
        if not streaming:
            data = upstream.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                _error(h, 502, "account_response_limit", "The account response exceeded the size limit.")
                return True
            h.send_response(upstream.status)
            for name, value in response_headers.items():
                h.send_header(name, value)
            h.send_header("Content-Length", str(len(data)))
            h.end_headers()
            sent_headers = True
            h.wfile.write(data)
        else:
            h.send_response(upstream.status)
            for name, value in response_headers.items():
                h.send_header(name, value)
            h.send_header("Transfer-Encoding", "chunked")
            h.end_headers()
            sent_headers = True
            size, deadline = 0, time.monotonic() + 130
            while True:
                data = upstream.read1(16384)
                if not data:
                    break
                size += len(data)
                if size > MAX_STREAM or time.monotonic() > deadline:
                    raise OSError("Account stream limit")
                h._write_chunk(data)
            h._write_chunk(b"")
    except CLIENT_DISCONNECT_ERRORS:
        h.close_connection = True
    except (OSError, ValueError, http.client.HTTPException, socket.timeout):
        if sent_headers:
            # Closing the account connection also cancels its provider fetch.
            # That service retains the reservation for uncertain usage.
            h.close_connection = True
        else:
            _error(h, 503, "accounts_unavailable", "The REACH account service is unavailable. Try again shortly.")
    finally:
        if connection is not None:
            connection.close()
        try:
            h.connection.settimeout(previous_timeout)
        except OSError:
            pass
    return True
