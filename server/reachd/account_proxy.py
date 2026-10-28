"""Narrow loopback proxy for hosted wallet accounts and metered model requests.

The public tunnel continues to terminate on reachd. Customer sessions always go
through the account service and can never become local-owner relay requests.
"""
import http.client
import ipaddress
import json
import re
import select
import socket
import threading
import time
from urllib.parse import urlsplit

import reachd.core as core
from reachd.const import CLIENT_DISCONNECT_ERRORS
from reachd.account_telemetry import AccountTelemetry

ACCOUNT_PATHS = frozenset((
    "/wallet/connect", "/wallet/redeem", "/wallet/app.js", "/wallet/email.js", "/wallet/style.css",
    "/wallet/rch", "/wallet/rch-logo.png", "/wallet/rch-tokenlist.json", "/wallet/rch-add-token.js",
    "/v1/auth/start", "/v1/auth/challenge", "/v1/auth/verify", "/v1/auth/exchange", "/v1/auth/logout",
    "/v1/auth/email/start", "/v1/auth/email/verify",
    "/v1/account/api-keys", "/v1/account/api-keys/revoke", "/v1/account/link-wallet",
    "/v1/account/link-email/start", "/v1/account/link-email/verify",
    "/v1/account/config", "/v1/account", "/v1/redemptions/start", "/v1/redemptions/details", "/v1/redemptions/submit",
    "/v1/billing/checkout", "/v1/billing/portal", "/v1/billing/payments", "/v1/billing/stripe/webhook", "/billing/return",
    "/v1/billing/paypal/webhook", "/v1/billing/paypal/return",
    "/oauth/notion/start", "/oauth/notion/exchange", "/oauth/notion/refresh", "/oauth/notion/cancel", "/oauth/notion/callback",
    "/oauth/slack/start", "/oauth/slack/exchange", "/oauth/slack/refresh", "/oauth/slack/cancel", "/oauth/slack/callback",
    "/oauth/discord/start", "/oauth/discord/exchange", "/oauth/discord/refresh", "/oauth/discord/cancel", "/oauth/discord/callback", "/oauth/discord/read",
    "/oauth/discord/chat-poll", "/oauth/discord/chat-reply", "/oauth/discord/chat-close",
))
MODEL_PATHS = {"/v1/models": "/v1/models", "/models": "/v1/models", "/api/v1/models": "/v1/models",
               "/v1/decisions": "/v1/decisions", "/decisions": "/v1/decisions",
               "/v1/chat/completions": "/v1/chat/completions", "/chat/completions": "/v1/chat/completions",
               "/api/v1/chat/completions": "/v1/chat/completions"}
MAX_REQUEST = 512 * 1024
MAX_RESPONSE = 1024 * 1024
MAX_STREAM = 2 * 1024 * 1024
# Stripe-Signature and the PayPal transmission headers authenticate the payment
# webhooks; the account service verifies them against the unchanged body.
FORWARD_HEADERS = ("Authorization", "Content-Type", "Origin", "Idempotency-Key", "Stripe-Signature",
                   "PayPal-Auth-Algo", "PayPal-Cert-Url", "PayPal-Transmission-Id",
                   "PayPal-Transmission-Sig", "PayPal-Transmission-Time")
RESPONSE_HEADERS = ("Content-Type", "Cache-Control", "Content-Security-Policy", "Referrer-Policy",
                    "X-Content-Type-Options", "X-Frame-Options", "X-Request-Id", "X-Reach-Replayed", "Retry-After",
                    "Access-Control-Allow-Origin", "Vary")


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
    return bool(re.match(r"^\s*Bearer\s+rch_(?:session|key)_", authorization, re.I)
                or headers.get("X-Reach-Key", "").lower().startswith(("rch_session_", "rch_key_")))


def _error(h, status, code, message):
    h._json(status, {"error": {"code": code, "message": message, "type": "account_service_error"}})


def _watch_chat_disconnect(client, upstream, stopped, disconnected):
    """Cancel a buffered model request even while its headers/body are pending.

    The incoming body is already consumed. Peeking must not eat a subsequent
    keep-alive request. Shutdown interrupts the other thread's blocking HTTP
    read and makes the account gateway cancel its provider fetch immediately.
    """
    while not stopped.is_set():
        try:
            readable, _, _ = select.select([client], [], [], 0.05)
            if not readable:
                continue
            if client.recv(1, socket.MSG_PEEK):
                stopped.wait(0.05)
                continue
        except (OSError, ValueError):
            pass
        disconnected.set()
        try:
            upstream.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        return


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
    disconnect_watch = None
    watch_stopped = threading.Event()
    client_disconnected = threading.Event()
    sent_headers = False
    telemetry = None
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
        if customer and h.command == "POST" and MODEL_PATHS.get(path) == "/v1/chat/completions":
            telemetry = AccountTelemetry(h, body)
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
        if customer and h.command == "POST" and MODEL_PATHS.get(path) == "/v1/chat/completions":
            disconnect_watch = threading.Thread(target=_watch_chat_disconnect,
                args=(h.connection, connection.sock, watch_stopped, client_disconnected), daemon=True)
            disconnect_watch.start()
        upstream = connection.getresponse()
        if telemetry:
            telemetry.headers(upstream)
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
            if telemetry:
                telemetry.receive(data)
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
                if telemetry:
                    telemetry.receive(data)
                size += len(data)
                if size > MAX_STREAM or time.monotonic() > deadline:
                    raise OSError("Account stream limit")
                h._write_chunk(data)
            h._write_chunk(b"")
    except CLIENT_DISCONNECT_ERRORS:
        client_disconnected.set()
        h.close_connection = True
    except (OSError, ValueError, http.client.HTTPException, socket.timeout):
        if client_disconnected.is_set():
            h.close_connection = True
        elif sent_headers:
            # Closing the account connection also cancels its provider fetch.
            # That service retains the reservation for uncertain usage.
            h.close_connection = True
        else:
            _error(h, 503, "accounts_unavailable", "The REACH account service is unavailable. Try again shortly.")
    finally:
        if telemetry:
            telemetry.finish(client_disconnected.is_set())
        watch_stopped.set()
        if disconnect_watch is not None:
            disconnect_watch.join(timeout=0.2)
        if connection is not None:
            connection.close()
        try:
            h.connection.settimeout(previous_timeout)
        except OSError:
            pass
    return True


def account_operator_keys(h, offset=0):
    """Called only after the relay's existing operator authorization check."""
    connection = None
    try:
        offset = int(offset)
        if not 0 <= offset <= 1_000_000:
            raise ValueError("Invalid offset")
        target = core.STATE.cfg.get("account_service_url", "")
        if not target:
            return h._json(200, {"data": [], "hasMore": False, "configured": False})
        scheme, host, port = account_service_target(target)
        if port == h.server.server_address[1]:
            raise ValueError("Account service cannot point at relay")
        connection_class = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        connection = connection_class(host, port, timeout=20)
        connection.request("GET", "/_reach/operator/api-keys?offset=" + str(offset), headers={"Connection": "close"})
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE + 1)
        if response.status != 200 or len(data) > MAX_RESPONSE:
            raise OSError("Account metadata unavailable")
        value = json.loads(data)
        # Keep the relay boundary metadata-only even if the service adds fields.
        fields = ("id", "accountId", "name", "prefix", "createdAt", "expiresAt", "revokedAt")
        keys = [{name: row.get(name) for name in fields} for row in value["data"]]
        h._json(200, {"data": keys, "hasMore": value.get("hasMore") is True, "configured": True})
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        h._json(503, {"error": {"code": "account_keys_unavailable", "message": "Website API key metadata is temporarily unavailable."}})
    finally:
        if connection:
            connection.close()
