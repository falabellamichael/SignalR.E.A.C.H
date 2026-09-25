"""The HTTP handler: routing, admin routes, and response helpers."""

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import reachd.core as core  # core.STATE is read at call time (cycle-safe)
from reachd.browser import BrowserError, fetch_page
from reachd.browser_engine import ENGINE as BROWSER_ENGINE, MAX_BODY_BYTES as BROWSER_ENGINE_MAX_BODY, allowed_origin
from reachd.chat import chat_execute, chat_finalize
from reachd.const import CLIENT_DISCONNECT_ERRORS, MAX_BODY_BYTES, VERSION
from reachd.publish import publish_url, revoke_url
from reachd.settings import (
    DEFAULT_SETTINGS,
    key_expired,
    SettingsError,
    generate_client_key,
    merged_settings,
    public_key_view,
    restore_masked_client_keys,
    save_config,
    settings_public,
    validate_settings,
)

# Headers a reverse proxy / tunnel (ngrok, cloudflared) injects. Their
# presence means the request was forwarded, not made by a genuine local
# client, so it must never qualify for the loopback-only admin surface.
_FORWARD_HEADERS = (
    "X-Forwarded-For",
    "X-Forwarded-Proto",
    "X-Forwarded-Host",
    "Forwarded",
    "Cf-Connecting-Ip",
)


def _ip_in_list(ip, entries):
    """Match a client IP against allow/block entries, each of which may be a
    plain address or a CIDR range. Parsing both sides as ipaddress objects
    means formatting differences can't dodge a match; unparseable entries fall
    back to exact string equality so a hostname-ish entry still works."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip in entries
    for entry in entries:
        entry = (entry or "").strip()
        try:
            if addr in ipaddress.ip_network(entry, strict=False):
                return True
        except ValueError:
            if ip == entry:
                return True
    return False


def _is_loopback_ip(ip):
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    mapped = getattr(addr, "ipv4_mapped", None)
    return (mapped or addr).is_loopback


def _host_is_loopback(host):
    """True when a Host header names this machine (any port). A missing header
    passes — a bare HTTP/1.0 client — because every browser sends one, and a
    DNS-rebinding page's Host is its own domain, which fails here."""
    if not host:
        return True
    host = host.strip()
    if host.startswith("["):
        name = host[1:].split("]", 1)[0]
    elif host.count(":") == 1:
        name = host.rsplit(":", 1)[0]
    else:
        name = host
    name = name.strip().lower()
    return name == "localhost" or _is_loopback_ip(name)


def _trusted_proxy(peer):
    """May we believe the forwarding headers this peer sent? Loopback is the
    local tunnel process; anything else must be listed in
    access.trusted_proxies. Otherwise a direct client could write its own
    X-Forwarded-For and pick which IP the allow/block lists and the rate
    limiter see."""
    if _is_loopback_ip(peer):
        return True
    state = core.STATE
    if state is None:
        return False
    entries = (state.cfg.get("access") or {}).get("trusted_proxies") or []
    return bool(entries) and _ip_in_list(peer, entries)


def _secret_equal(known, presented):
    """Constant-time secret comparison that cannot be crashed by the caller.
    hmac.compare_digest on str raises for non-ASCII input, and an HTTP header
    can carry latin-1 bytes, so compare encoded bytes instead. Empty or
    non-string values never match: a blanked key placeholder must not be
    satisfiable."""
    if not isinstance(known, str) or not known:
        return False
    if not isinstance(presented, str) or not presented:
        return False
    return hmac.compare_digest(known.encode("utf-8"), presented.encode("utf-8"))


class RelayHandler(BaseHTTPRequestHandler):
    server_version = "SignalR.E.A.C.H/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ------------------------------------------------------------------ helpers
    def _cors(self):
        origins = (core.STATE.cfg.get("access", {}).get("cors_origins") or "*").strip()
        origin = self.headers.get("Origin", "")
        if origins == "*":
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin and origin in [o.strip() for o in origins.split(",")]:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Authorization, X-Reach-Key")
        self.send_header("Access-Control-Expose-Headers",
                         "X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After,"
                         " X-Reach-Cache, X-Tokens-Per-Second, X-Reach-Tokens-Per-Second,"
                         " OpenAI-Processing-Ms")

    def _json(self, status, payload, extra_headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if "Cache-Control" not in (extra_headers or {}):
            self.send_header("Cache-Control", "no-store")
        if self._request_body_unread():
            self.close_connection = True
            self.send_header("Connection", "close")
        self._cors()
        for key, value in (extra_headers or {}).items():
            self.send_header(key, str(value))
        self.end_headers()
        try:
            self.wfile.write(body)
        except CLIENT_DISCONNECT_ERRORS:
            pass

    def parse_request(self):
        # One handler serves every request on a keep-alive connection, so the
        # "body consumed" flag has to be reset for each new request.
        self._body_read = False
        return super().parse_request()

    def _read_exact(self, length):
        data = self.rfile.read(length)
        self._body_read = True
        return data

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._body_read = True
            return b""
        if length > MAX_BODY_BYTES:
            raise ValueError("request body too large")
        return self._read_exact(length)

    def _request_body_unread(self):
        """True when the client sent a body we have not read. Answering without
        reading it leaves those bytes on a keep-alive connection, where they are
        parsed as the next request line and the client gets an HTML 400 for a
        request that was fine. Every early refusal (rate limit, no key) hits
        this, so the connection is closed instead."""
        if getattr(self, "_body_read", False):
            return False
        try:
            return int(self.headers.get("Content-Length") or 0) > 0                 or bool(self.headers.get("Transfer-Encoding"))
        except ValueError:
            return True

    def _client_ip(self):
        # The tunnel/proxy sets the trustworthy client IP; an attacker can only
        # PREPEND to X-Forwarded-For, so take the value the proxy itself added:
        # Cf-Connecting-Ip (cloudflared) or the LAST X-Forwarded-For hop, never
        # the first (finding: block/allow lists were bypassable via a spoofed
        # first XFF entry). Falls back to the socket peer for direct clients.
        peer = (self.client_address[0] if self.client_address else "?")[:64]
        if not _trusted_proxy(peer):
            return peer
        cf = self.headers.get("Cf-Connecting-Ip")
        if cf:
            return cf.strip()[:64]
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[-1].strip()[:64]
        return peer

    def _is_loopback(self):
        return bool(self.client_address) and _is_loopback_ip(self.client_address[0])

    def _admin_local(self):
        """A genuine local admin client: connected over loopback AND carrying
        no proxy/forwarding headers. Tunnels (ngrok, cloudflared) always inject
        those headers and an attacker cannot strip them, so a tunnel-forwarded
        request — which also arrives from 127.0.0.1 — is correctly rejected.

        Loopback is not enough on its own: the owner's browser also connects
        from 127.0.0.1, so any web page they visit could otherwise drive this
        relay as "local". A browser cannot forge its Host or Origin, so a
        request that names a foreign host (DNS rebinding) or comes from a
        foreign page is not a local client."""
        if not self._is_loopback():
            return False
        if any(self.headers.get(h) for h in _FORWARD_HEADERS):
            return False
        if not _host_is_loopback(self.headers.get("Host")):
            return False
        return allowed_origin(self.headers.get("Origin"))

    def _admin_token_ok(self):
        """Constant-time check of the X-Reach-Admin header against the
        per-install admin token. Only satisfiable when a token is set."""
        token = (core.STATE.cfg.get("system", {}) or {}).get("admin_token") or ""
        if not token:
            return False
        presented = (self.headers.get("X-Reach-Admin") or "").strip()
        return _secret_equal(token, presented)

    def _require_admin(self):
        """Gate on /_reach/*: a genuine local client, OR a valid admin token.
        The token is the only way a non-local (remote-admin) request passes —
        peer address alone is never sufficient, because the tunnel makes every
        forwarded request look like loopback."""
        if self._admin_local():
            return True
        ip = self._guard_id()
        guard = core.STATE.auth_guard
        if self._deny_if_locked_out(ip):
            return False
        if self._admin_token_ok():
            guard.record_success(ip)
            return True
        self._note_auth_failure(ip, "admin")
        if self._deny_if_locked_out(ip):
            return False
        self._json(403, {"error": {"message": "admin API requires a local client "
                                              "or a valid X-Reach-Admin token",
                                   "type": "forbidden"}})
        return False

    def _guard_id(self):
        """The identity lockouts are tracked under. A web page in the owner's
        browser reaches this relay from the owner's own address, so its
        failures must not be booked against that address, or a hostile page
        could lock the owner's local tools out by spamming bad requests. It gets
        its own bucket instead. Tunnel clients keep their real address."""
        ip = self._client_ip()
        if _is_loopback_ip(ip) and not self._admin_local():
            return "web:" + ip
        return ip

    def _deny_if_locked_out(self, ip):
        """Refuse a locked-out client before its credential is even compared."""
        wait = core.STATE.auth_guard.retry_after(ip, core.STATE.cfg)
        if not wait:
            return False
        self._json(429, {"error": {"message": "Too many failed attempts. Try again later.",
                                    "type": "rate_limit_error", "code": "auth_locked"}},
                   {"Retry-After": wait})
        return True

    def _note_auth_failure(self, ip, surface):
        tripped = core.STATE.auth_guard.record_failure(ip, core.STATE.cfg)
        if tripped:
            core.log_error("auth lockout: %s locked out for %ds after repeated "
                           "failed %s attempts" % (ip, tripped, surface))
            try:
                core.STATE.analytics.log_audit("auth.lockout", "system",
                                               "ip=%s surface=%s seconds=%d"
                                               % (ip, surface, tripped))
            except Exception:
                pass

    def _admin_actor(self):
        """Human-readable actor name for audit-trail entries: the local panel
        or the remote admin token (never the token value itself)."""
        if self._admin_local():
            return "local-admin"
        return "remote-admin-token"

    def _audit(self, action, detail=""):
        """Record a destructive admin action (timestamp + actor) without ever
        letting an analytics failure break the request."""
        try:
            core.STATE.analytics.log_audit(action, self._admin_actor(), detail)
        except Exception:
            pass

    def _check_access(self):
        """Gate for the public surface (models + chat). Order matters:
        address lists first, so a denied address learns nothing; then the
        lockout, so a locked-out client cannot keep guessing; then the key."""
        if not self._check_ip_lists():
            return False
        cfg = core.STATE.cfg
        access = cfg.get("access", {})
        ip = self._client_ip()
        gid = self._guard_id()
        if self._deny_if_locked_out(gid):
            return False

        presented = (self.headers.get("X-Reach-Key") or "").strip()
        if not presented:
            auth = (self.headers.get("Authorization") or "").strip()
            presented = auth[7:].strip() if auth.lower().startswith("bearer ") else auth

        matched_key = None
        if presented:
            for k in access.get("keys", []):
                if k.get("enabled", True) and _secret_equal(k.get("key"), presented):
                    matched_key = k
                    break
            legacy_key = access.get("access_key")
            if not matched_key and _secret_equal(legacy_key, presented):
                matched_key = {"id": "legacy", "name": "Legacy Key", "key": legacy_key}

        if matched_key:
            # An expired key is a real key whose term ended, not a guess, so it
            # never counts toward the lockout: locking someone out for holding a
            # lapsed key would punish the one person we can positively identify.
            if key_expired(matched_key):
                core.STATE.auth_guard.record_success(gid)
                self._log_auth_refusal(ip, "key_expired")
                self._json(401, {"error": {
                    "message": "This SignalR.E.A.C.H API key expired on %s."
                               % matched_key.get("expires_at"),
                    "type": "authentication_error",
                    "code": "key_expired"}}, {"WWW-Authenticate": "Bearer"})
                return False
            self._auth_key_name = matched_key.get("name", "Key")
            self._auth_key_id = matched_key.get("id", "")
            # The request pipeline meters this key, so it has to travel with the
            # request rather than be looked up again by a token comparison.
            self._auth_key = matched_key
            matched_key["last_used_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            core.STATE.auth_guard.record_success(gid)
            return True

        if not access.get("key_required", False):
            self._auth_key_name = "anonymous"
            self._auth_key_id = ""
            return True

        # The owner's own tools on this machine skip the key; see _admin_local
        # for what "on this machine" has to prove.
        if access.get("local_bypass", True) and self._admin_local():
            self._auth_key_name = "local"
            self._auth_key_id = ""
            return True

        self._note_auth_failure(gid, "key")
        self._log_auth_refusal(ip, "auth_failed" if presented else "auth_missing")
        if self._deny_if_locked_out(gid):
            return False
        self._json(401, {"error": {"message": "Invalid SignalR.E.A.C.H API Key. Send 'Authorization: Bearer sk-reach-...' or 'X-Reach-Key'.",
                                    "type": "authentication_error",
                                    "code": "invalid_api_key"}},
                   {"WWW-Authenticate": "Bearer"})
        return False

    def _log_auth_refusal(self, ip, reason):
        """One record per refused request, whatever refused it. Analytics must
        never be able to break the gate, so it is best effort."""
        try:
            self._log_chat(model=None, upstream_model=None, ip=ip,
                           user_agent=self.headers.get("User-Agent"), status=401,
                           error=reason, latency_ms=0, tokens_in=0,
                           tokens_out=0, stream=False)
        except Exception:
            pass

    def key_limits(self):
        """The caps carried by the key that authenticated this request.

        Returns (bucket_id, rpm, tokens_day) with bucket_id None when nothing
        should be metered per key — an anonymous or local-bypass request, or a
        key that sets no caps of its own. The shared rate_limits.* budgets are
        applied separately and always."""
        key = getattr(self, "_auth_key", None)
        if not key:
            return None, 0, 0
        try:
            rpm = int(key.get("rate_limit_rpm", 0) or 0)
            tokens = int(key.get("tokens_day", 0) or 0)
        except (TypeError, ValueError):
            return None, 0, 0
        if rpm <= 0 and tokens <= 0:
            return None, 0, 0
        return "key::" + str(key.get("id") or key.get("name") or "?"), max(0, rpm), max(0, tokens)

    def _check_ip_lists(self):
        access = core.STATE.cfg.get("access", {})
        # Exempt only genuine local clients — NOT all loopback traffic, since
        # tunnel-forwarded requests also arrive from 127.0.0.1 (that blanket
        # exemption made the lists inert for every public request).
        if self._admin_local():
            return True
        ip = self._client_ip()
        allowlist = access.get("ip_allowlist") or []
        blocklist = access.get("ip_blocklist") or []
        if allowlist and not _ip_in_list(ip, allowlist):
            self._json(403, {"error": {"message": "IP not allowed",
                                       "type": "forbidden", "code": "ip_denied"}})
            return False
        if blocklist and _ip_in_list(ip, blocklist):
            self._json(403, {"error": {"message": "IP blocked",
                                       "type": "forbidden", "code": "ip_denied"}})
            return False
        return True

    def _rate_limit_headers(self, headers):
        for key, value in (headers or {}).items():
            self.send_header(key, str(value))

    def _relay_upstream_error(self, exc, default_message, default_status=502):
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
            "error": {"message": message, "type": "server_error",
                      "code": "upstream_error"},
        })

    def _write_chunk(self, data):
        try:
            self.wfile.write(("%x\r\n" % len(data)).encode("ascii") + data + b"\r\n")
            self.wfile.flush()
        except CLIENT_DISCONNECT_ERRORS:
            raise

    # ------------------------------------------------------------------- routes
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        query = self._query_params()
        try:
            if path in ("/health", "/status"):
                self._json(200, core.STATE.snapshot(redact=not self._admin_local()))
            elif path == "/public-url":
                self._json(200, {"public_url": core.STATE.public_url,
                                 "source": core.STATE.public_url_source})
            elif path in ("/v1/models", "/models"):
                if not self._check_access():
                    return
                data = [{"id": alias, "object": "model",
                         "created": 1715367049, "owned_by": "SignalR.E.A.C.H"}
                        for alias in sorted(core.STATE.public_models())]
                self._json(200, {"object": "list", "data": data})
            elif path == "/_reach/settings":
                if not self._require_admin():
                    return
                self._json(200, settings_public(core.STATE.cfg))
            elif path == "/_reach/keys":
                if not self._require_admin():
                    return
                keys = (core.STATE.cfg.get("access") or {}).get("keys", [])
                safe_keys = [public_key_view(k) for k in keys]
                self._json(200, {"keys": safe_keys})
            elif path == "/_reach/stats":
                if not self._require_admin():
                    return
                snapshot = core.STATE.snapshot()
                snapshot["stats"] = core.STATE.analytics.stats()
                self._json(200, snapshot)
            elif path == "/_reach/logs":
                if not self._require_admin():
                    return
                self._json(200, {"logs": core.STATE.analytics.logs(
                    limit=query.get("limit", 100),
                    status=query.get("status"),
                    model=query.get("model"))})
            elif path.startswith("/_reach/logs/"):
                if not self._require_admin():
                    return
                log_id = path[len("/_reach/logs/"):]
                record = core.STATE.analytics.log_detail(log_id)
                if record is None:
                    self._json(404, {"error": {"message": "Log entry not found",
                                               "type": "not_found"}})
                else:
                    self._json(200, record)
            elif path == "/_reach/audit":
                if not self._require_admin():
                    return
                self._json(200, {"events": core.STATE.analytics.audit_events(
                    limit=query.get("limit", 50))})
            else:
                self._json(404, {"error": {"message": "Not found: " + path,
                                           "type": "not_found"}})
        except CLIENT_DISCONNECT_ERRORS:
            pass
        except Exception as exc:
            try:
                self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})
            except Exception:
                pass

    def _query_params(self):
        from urllib.parse import parse_qs, urlsplit
        return {key: values[0] for key, values in
                parse_qs(urlsplit(self.path).query).items()}

    def do_PUT(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path == "/_reach/settings":
                if not self._require_admin():
                    return
                self.handle_settings_update()
            else:
                self._json(404, {"error": {"message": "Not found: " + path,
                                           "type": "not_found"}})
        except CLIENT_DISCONNECT_ERRORS:
            pass
        except Exception as exc:
            try:
                self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})
            except Exception:
                pass

    def do_DELETE(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path == "/_reach/logs":
                if not self._require_admin():
                    return
                core.STATE.analytics.clear()
                self._audit("logs.purge")
                self._json(200, {"cleared": True})
            elif path.startswith("/_reach/keys/"):
                if not self._require_admin():
                    return
                key_id = path[len("/_reach/keys/"):]
                with core.STATE._lock:
                    access = core.STATE.cfg.setdefault("access", {})
                    keys = access.setdefault("keys", [])
                    orig_len = len(keys)
                    access["keys"] = [k for k in keys
                                      if k.get("id") != key_id and k.get("key") != key_id]
                    if len(access["keys"]) < orig_len:
                        save_config(core.STATE.cfg, core.STATE.cfg_path)
                        self._audit("keys.revoke", "id=%s" % key_id)
                        self._json(200, {"deleted": True, "id": key_id})
                    else:
                        self._json(404, {"error": {"message": "Key not found", "type": "not_found"}})
            else:
                self._json(404, {"error": {"message": "Not found: " + path,
                                           "type": "not_found"}})
        except CLIENT_DISCONNECT_ERRORS:
            pass
        except Exception as exc:
            try:
                self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})
            except Exception:
                pass

    def do_PATCH(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path.startswith("/_reach/keys/"):
                if not self._require_admin():
                    return
                key_id = path[len("/_reach/keys/"):]
                raw_b = self._read_body()
                try:
                    patch = json.loads(raw_b.decode("utf-8")) if raw_b else {}
                except Exception:
                    patch = {}
                with core.STATE._lock:
                    access = core.STATE.cfg.setdefault("access", {})
                    keys = access.setdefault("keys", [])
                    found = None
                    for index, k in enumerate(keys):
                        if k.get("id") == key_id or k.get("key") == key_id:
                            updated = dict(k)
                            if "name" in patch:
                                updated["name"] = str(patch["name"]).strip()
                            if "enabled" in patch:
                                val = patch["enabled"]
                                if isinstance(val, bool):
                                    updated["enabled"] = val
                                else:
                                    updated["enabled"] = str(val).lower() not in ("false", "0", "no", "off", "")
                            # Per-key caps, so a plan can be changed without a
                            # whole-settings PUT. Keep the live key unchanged
                            # until the candidate config validates and saves.
                            for field in ("rate_limit_rpm", "tokens_day"):
                                if field in patch:
                                    value = patch[field]
                                    if isinstance(value, bool) or not isinstance(value, int):
                                        return self._json(400, {"error": {
                                            "message": "%s must be a whole number" % field,
                                            "type": "invalid_request"}})
                                    updated[field] = value
                            if "expires_at" in patch:
                                value = patch["expires_at"]
                                if value is not None and not isinstance(value, str):
                                    return self._json(400, {"error": {
                                        "message": "expires_at must be an ISO-8601 string or null",
                                        "type": "invalid_request"}})
                                updated["expires_at"] = value.strip() or None if isinstance(value, str) else None
                            candidate = json.loads(json.dumps(core.STATE.cfg))
                            candidate["access"]["keys"][index] = updated
                            try:
                                save_config(candidate, core.STATE.cfg_path)
                            except SettingsError as exc:
                                return self._json(400, {"error": {
                                    "message": str(exc), "type": "invalid_request"}})
                            k.clear()
                            k.update(updated)
                            found = k
                            break
                    if found:
                        self._json(200, {"updated": True, "key": public_key_view(found)})
                    else:
                        self._json(404, {"error": {"message": "Key not found", "type": "not_found"}})
            else:
                self._json(404, {"error": {"message": "Not found: " + path,
                                           "type": "not_found"}})
        except CLIENT_DISCONNECT_ERRORS:
            pass
        except Exception as exc:
            import traceback
            try:
                core.log_error("500 on %s: %s\n%s" % (self.path, exc,
                                                      traceback.format_exc(limit=12)))
            except Exception:
                pass
            try:
                self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})
            except Exception:
                pass

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path == "/_reach/browser/engine":
                self.handle_browser_engine()
            elif path in ("/_reach/browser/fetch", "/_reach/browser/resource"):
                # This network capability is local-only, even with a valid
                # remote admin token. Tunnel requests carry forwarding headers.
                if not self._admin_local():
                    return self._json(403, {"error": {"message": "The browser requires a direct local connection.",
                                                      "type": "forbidden"}})
                self.handle_browser_fetch(resource=path.endswith("/resource"))
            elif path == "/_reach/public-url":
                if not self._require_admin():
                    return
                self.handle_public_url_override()
            elif path == "/_reach/settings/test":
                if not self._require_admin():
                    return
                self.handle_settings_test()
            elif path == "/_reach/reset":
                if not self._require_admin():
                    return
                self.handle_reset()
            elif path == "/_reach/test":
                if not self._require_admin():
                    return
                self.handle_upstream_test()
            elif path == "/_reach/diagnose":
                if not self._require_admin():
                    return
                self.handle_diagnose()
            elif path == "/_reach/publish":
                if not self._require_admin():
                    return
                self.handle_publish()
            elif path == "/_reach/publish/revoke":
                if not self._require_admin():
                    return
                ok, detail = revoke_url(core.STATE)
                if ok:
                    self._audit("pointer.revoke")
                    self._json(200, {"ok": True, "detail": detail})
                else:
                    self._json(400, {"ok": False, "error": detail})
            elif path == "/_reach/cache/clear":
                if not self._require_admin():
                    return
                entries = len(core.STATE.cache)
                core.STATE.cache.clear()
                self._audit("cache.flush", "entries=%d" % entries)
                self._json(200, {"cleared": True, "entries": entries})
            elif path == "/_reach/keys":
                if not self._require_admin():
                    return
                self.handle_create_key()
            elif path == "/_reach/keys/ensure":
                # Hands out a live secret, so a remote admin token is not
                # enough: only the operator at this machine may ask.
                if not self._admin_local():
                    return self._json(403, {"error": {"message": "key hand-out requires a local client",
                                                      "type": "forbidden"}})
                self.handle_ensure_key()
            elif path == "/_reach/tray":
                if not self._require_admin():
                    return
                self.handle_tray()
            elif path in ("/v1/chat/completions", "/chat/completions"):
                if not self._check_access():
                    return
                self.handle_chat()
            else:
                self._json(404, {"error": {"message": "Not found: " + path,
                                           "type": "not_found"}})
        except CLIENT_DISCONNECT_ERRORS:
            pass
        except Exception as exc:
            import traceback
            try:
                core.log_error("500(POST) on %s: %s\n%s" % (self.path, exc,
                                                            traceback.format_exc(limit=12)))
            except Exception:
                pass
            try:
                self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})
            except Exception:
                pass

    # ------------------------------------------------------------- admin routes
    def handle_browser_engine(self):
        headers = {"Cache-Control": "no-store"}
        if not self._admin_local() or not allowed_origin(self.headers.get("Origin")):
            self.close_connection = True
            return self._json(403, {"error": {"message": "The interactive browser requires a direct local application connection.",
                                              "type": "forbidden", "code": "engine_forbidden"}}, headers)
        if (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower() != "application/json":
            self.close_connection = True
            return self._json(415, {"error": {"message": "Send browser commands as application/json.",
                                              "type": "browser_error", "code": "invalid_request"}}, headers)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= BROWSER_ENGINE_MAX_BODY:
                self.close_connection = True
                raise BrowserError("Browser command is empty or too large.", code="invalid_request")
            body = json.loads(self._read_exact(length).decode("utf-8"))
            result = BROWSER_ENGINE.request(body)
        except BrowserError as exc:
            return self._json(exc.status, {"error": {"message": str(exc), "type": "browser_error", "code": exc.code}}, headers)
        except (ValueError, UnicodeError):
            self.close_connection = True
            return self._json(400, {"error": {"message": "Send a valid JSON browser command.",
                                              "type": "browser_error", "code": "invalid_request"}}, headers)
        self._json(200, result, headers)

    @staticmethod
    def _looks_script_shell(result):
        """JS-rendered pages come back as bare shells from a script-free fetch
        (Vite/React: <div id=root> + <script type=module>), which the Reader
        would show blank. Rendering them with the engine fixes that."""
        html = (result or {}).get("html") or ""
        text = ((result or {}).get("text") or "").strip()
        if len(text) < 200:
            return True
        return bool(re.search(r'<script[^>]+type\s*=\s*["\']module', html, re.I))

    def _browser_engine_render(self, url, timeout_ms=15000):
        """One-shot: load `url` in the interactive engine and return a rendered
        DOM snapshot (html + text) so script-heavy pages aren't blank."""
        session = BROWSER_ENGINE.request({"action": "session"})
        token = session["token"]
        tab = secrets.token_hex(8)
        try:
            BROWSER_ENGINE.request({"action": "create", "tab": tab, "token": token,
                                    "url": url, "width": 1280, "height": 900})
            deadline = time.monotonic() + timeout_ms / 1000.0
            while time.monotonic() < deadline:
                state = BROWSER_ENGINE.request({"action": "frame", "tab": tab,
                                                "token": token, "since": 0})
                if not state.get("loading"):
                    break
                time.sleep(0.25)
            snap = BROWSER_ENGINE.request({"action": "snapshot", "tab": tab, "token": token})
            rendered_url = snap.get("url") or url
            html = snap.get("html") or ""
            text = (snap.get("text") or "").strip()
            return {"url": rendered_url,
                    "title": (snap.get("title") or rendered_url)[:200],
                    "html": html[:2_000_000],
                    "text": text[:160_000],
                    "content_type": "text/html",
                    "truncated": False,
                    "rendered": True}
        finally:
            try:
                BROWSER_ENGINE.request({"action": "close", "tab": tab, "token": token})
            except BrowserError:
                pass

    def handle_browser_fetch(self, resource=False):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 16 * 1024:
                self.close_connection = True
                raise BrowserError("Send a JSON object containing a page URL (maximum 16 KB).")
            body = json.loads(self._read_exact(length).decode("utf-8"))
            if not isinstance(body, dict):
                raise BrowserError("Send a JSON object containing a page URL.")
            if resource:
                if body.get("kind") not in ("image", "style"):
                    raise BrowserError("Request an image or stylesheet.")
                result = fetch_page(body.get("url"), kind=body["kind"])
            else:
                result = fetch_page(body.get("url"))
                # Script-rendered pages (Vite/React/etc.) come back as bare
                # shells; render them with the engine so the Reader shows the
                # real page instead of a blank frame.
                if self._looks_script_shell(result):
                    try:
                        rendered = self._browser_engine_render(body.get("url"))
                        if rendered and (rendered.get("text") or "").strip():
                            result = rendered
                    except (BrowserError, Exception):
                        pass  # keep the raw snapshot; the page still opens
        except BrowserError as exc:
            return self._json(exc.status, {"error": {"message": str(exc),
                                                    "type": "browser_error", "code": exc.code}})
        except (ValueError, UnicodeError):
            return self._json(400, {"error": {"message": "Send valid JSON containing a page URL.",
                                            "type": "browser_error", "code": "invalid_request"}})
        self._json(200, result, {"Cache-Control": "no-store"})

    def handle_create_key(self):
        raw = self._read_body()
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            body = {}
        name = (body.get("name") or "Client").strip()
        new_key = generate_client_key(name)
        with core.STATE._lock:
            access = core.STATE.cfg.setdefault("access", {})
            keys = access.setdefault("keys", [])
            keys.append(new_key)
            save_config(core.STATE.cfg, core.STATE.cfg_path)
        self._json(201, {"created": True, "key": new_key})

    def handle_ensure_key(self):
        """Return the enabled client key with the given name, minting it on
        first use. Lets a local tool (the panel's SimpleRAG hookup) obtain its
        own key without the operator pasting one, and re-running it reuses the
        key instead of piling up new ones."""
        raw = self._read_body()
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            body = {}
        name = str((body or {}).get("name") or "SimpleRAG").strip()[:64] or "SimpleRAG"
        created = False
        with core.STATE._lock:
            access = core.STATE.cfg.setdefault("access", {})
            keys = access.setdefault("keys", [])
            found = next((k for k in keys if k.get("name") == name
                          and k.get("enabled", True) and k.get("key")), None)
            if found is None:
                found = generate_client_key(name)
                keys.append(found)
                save_config(core.STATE.cfg, core.STATE.cfg_path)
                created = True
        if created:
            self._audit("key.create", "name=%s (local hookup)" % name)
        self._json(200, {"name": found.get("name"), "key": found.get("key"),
                         "created": created})

    def handle_tray(self):
        """Start the Copilot 365 system tray (invisible browser + in-process
        bridge on 127.0.0.1:21302) when it is not already running. The tray
        lives in %LOCALAPPDATA%\\SignalREACH\\copilot\\tray; its Electron app
        holds a single-instance lock, so a redundant spawn simply exits."""
        if self._tray_running():
            return self._json(200, {"tray": "running", "started": False})
        if sys.platform == "win32":
            base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        elif sys.platform == "darwin":
            base = Path.home() / "Library" / "Application Support"
        else:
            base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        tray_dir = base / "SignalREACH" / "copilot" / "tray"
        dist = tray_dir / "node_modules" / "electron" / "dist"
        if sys.platform == "darwin":
            electron = dist / "Electron.app" / "Contents" / "MacOS" / "Electron"
        elif sys.platform == "win32":
            electron = dist / "electron.exe"
        else:
            electron = dist / "electron"
        if not (electron.is_file() and (tray_dir / "main.js").is_file()):
            return self._json(404, {"tray": "missing", "started": False,
                                    "error": "tray not installed"})
        try:
            flags = 0
            if os.name == "nt":
                flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
            subprocess.Popen([str(electron), str(tray_dir)],
                             cwd=str(tray_dir),
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, close_fds=True,
                             creationflags=flags)
            core.log_error("tray start requested via /_reach/tray")
            return self._json(200, {"tray": "starting", "started": True})
        except Exception as exc:  # pragma: no cover - environment-specific
            core.log_error("tray start failed: %s" % exc)
            return self._json(500, {"tray": "error", "started": False,
                                    "error": str(exc)})

    def _tray_running(self):
        try:
            with socket.create_connection(("127.0.0.1", 21302), timeout=0.6):
                return True
        except OSError:
            return False

    def handle_settings_update(self):
        body = self._read_body()
        try:
            patch = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            return self._json(400, {"error": {"message": "invalid JSON",
                                              "type": "invalid_request"}})
        if not isinstance(patch, dict):
            return self._json(400, {"error": {"message": "settings must be an object",
                                              "type": "invalid_request"}})
        if patch.get("reset") is True:
            patch = self._reset_keep()
        if "omniroute_key" in patch and not patch.get("omniroute_key"):
            patch.pop("omniroute_key")  # blank means keep the existing key
        if isinstance(patch.get("omniroute_key"), str) \
                and patch["omniroute_key"].startswith("set ("):
            patch.pop("omniroute_key")  # masked placeholder means keep it too
        access_patch = patch.get("access")
        if isinstance(access_patch, dict):
            if isinstance(access_patch.get("access_key"), str) \
                    and access_patch["access_key"].startswith("set ("):
                access_patch.pop("access_key")
            restore_masked_client_keys(core.STATE.cfg.get("access"), access_patch)
        next_cfg = merged_settings(core.STATE.cfg, patch)
        try:
            validate_settings(next_cfg)
        except SettingsError as exc:
            return self._json(400, {"error": {"message": str(exc),
                                              "type": "invalid_settings"}})
        try:
            save_config(next_cfg, core.STATE.cfg_path)
        except (OSError, SettingsError) as exc:
            return self._json(500, {"error": {"message": "could not persist: %s" % exc,
                                              "type": "server_error"}})
        self._audit_access_change(core.STATE.cfg, next_cfg)
        core.STATE.cfg = next_cfg
        core.STATE.poll_public_url()
        self._json(200, {"saved": True, "settings": settings_public(next_cfg)})

    def _audit_access_change(self, old_cfg, new_cfg):
        """Leave a trail whenever the access posture changes, most of all when
        it is loosened. Never records a key value."""
        old = old_cfg.get("access") or {}
        new = new_cfg.get("access") or {}
        changes = []
        for field in ("key_required", "local_bypass", "auth_fail_limit",
                      "auth_lockout_s", "cors_origins"):
            if old.get(field) != new.get(field):
                changes.append("%s %r->%r" % (field, old.get(field), new.get(field)))
        for field in ("ip_allowlist", "ip_blocklist", "trusted_proxies"):
            if (old.get(field) or []) != (new.get(field) or []):
                changes.append("%s %d->%d entries" % (field, len(old.get(field) or []),
                                                      len(new.get(field) or [])))
        if changes:
            self._audit("access.change", "; ".join(changes))

    def handle_reset(self):
        keep = self._reset_keep()
        next_cfg = merged_settings(DEFAULT_SETTINGS, keep)
        save_config(next_cfg, core.STATE.cfg_path)
        core.STATE.cfg = next_cfg
        core.STATE.poll_public_url()
        self._audit("settings.reset", "access control preserved")
        self._json(200, {"saved": True, "settings": settings_public(next_cfg)})

    @staticmethod
    def _reset_keep():
        """What survives a reset to defaults: the upstream credential and the
        whole access section (keys, key_required, IP lists, trusted proxies).
        Resetting model aliases and tuning must never re-open a relay the
        operator locked down — the previous version kept only the legacy key
        and silently switched key_required back off."""
        cfg = core.STATE.cfg
        system = cfg.get("system") or {}
        return {
            "omniroute_key": cfg.get("omniroute_key", ""),
            "access": json.loads(json.dumps(cfg.get("access") or {})),
            "system": {"admin_token": system.get("admin_token", ""),
                       "security_revision": system.get("security_revision", 0)},
        }

    def handle_settings_test(self):
        """Validate a patch WITHOUT persisting it (used by the settings UI)."""
        body = self._read_body()
        try:
            patch = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            return self._json(400, {"error": {"message": "invalid JSON",
                                              "type": "invalid_request"}})
        try:
            validate_settings(merged_settings(core.STATE.cfg, patch))
            self._json(200, {"valid": True})
        except SettingsError as exc:
            self._json(400, {"error": {"message": str(exc), "type": "invalid_settings"},
                             "valid": False})

    def handle_upstream_test(self):
        started = time.time()
        models = core.STATE.public_models() or core.STATE.enabled_models()
        if not models:
            return self._json(503, {"ok": False,
                                    "error": "no enabled models configured"})
        # Prefer an OmniRoute alias — this is the OmniRoute connectivity probe.
        # Only when nothing but bridge aliases exists does it test the bridge.
        upstreams = sorted(models.values())
        upstream_model = next((u for u in upstreams
                               if not u.startswith("bridge/")), upstreams[0])
        use_bridge = upstream_model.startswith("bridge/")
        payload = {"model": upstream_model[len("bridge/"):] if use_bridge
                   else upstream_model,
                   "messages": [{"role": "user",
                                 "content": "Reply with exactly: REACH OK"}],
                   "max_tokens": 16}
        try:
            url = (core.STATE.bridge_url if use_bridge
                   else core.STATE.omniroute_url).rstrip("/") + "/chat/completions"
            headers = {"Content-Type": "application/json"}
            if not use_bridge:
                headers["Authorization"] = "Bearer " + core.STATE.key
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode("utf-8"), method="POST",
                headers=headers)
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            reply = (data.get("choices") or [{}])[0].get("message", {}).get("content")
            self._json(200, {"ok": True, "reply": reply,
                             "latency_ms": round((time.time() - started) * 1000),
                             "model": upstream_model})
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            self._json(502, {"ok": False, "error": body[:300],
                             "status": exc.code})
        except Exception as exc:
            self._json(502, {"ok": False, "error": str(exc)[:300]})

    def handle_publish(self):
        ok, detail = publish_url(core.STATE)
        if ok:
            self._audit("pointer.publish", detail)
            self._json(200, {"ok": True, "public_url": detail,
                             "published_at": core.STATE.last_published_at})
        else:
            self._json(400, {"ok": False, "error": detail})

    def handle_diagnose(self):
        """PRD 'Test Public Endpoint Reachability': probe the relay's own
        public pointer URL from the outside — TLS handshake, headers, and a
        sample chat payload with round-trip timing. Server-side (not the
        browser) so CORS/opaque responses can't fake a pass."""
        url = (core.STATE.public_url or "").strip()
        if not url:
            return self._json(409, {"ok": False,
                                    "error": "no public URL — start a tunnel "
                                             "or set an override first"})
        if not url.lower().startswith("https://"):
            return self._json(409, {"ok": False,
                                    "error": "public URL is not https"})
        checks = []
        started = time.time()
        # ngrok free tier serves a browser-warning interstitial (HTTP 502 to
        # plain clients) unless this header is present — a diagnostics probe
        # must see the real endpoint, not the interstitial.
        probe_headers = {"User-Agent": "SignalR.E.A.C.H-diagnose",
                         "ngrok-skip-browser-warning": "1"}
        try:
            # Plain GET /health through the public URL. ssl context is the
            # default (verifies certificate + hostname) — a bad cert raises.
            req = urllib.request.Request(url.rstrip("/") + "/health",
                                         headers=probe_headers)
            with urllib.request.urlopen(req, timeout=20) as resp:
                health_ms = round((time.time() - started) * 1000)
                body = resp.read(4096).decode("utf-8", "replace")
                try:
                    health = json.loads(body)
                except ValueError:
                    health = {}
                checks.append({"name": "tls_and_headers", "ok": True,
                               "detail": "certificate verified; HTTP %d in %d ms"
                                         % (resp.status, health_ms),
                               "status": resp.status, "latency_ms": health_ms})
                checks.append({"name": "relay_health",
                               "ok": bool(health.get("ok")),
                               "detail": "service=%s version=%s"
                                         % (health.get("service", "?"),
                                            health.get("version", "?"))})
        except urllib.error.HTTPError as exc:
            return self._json(502, {"ok": False, "url": url, "checks": checks,
                                    "error": "HTTP %d from public endpoint"
                                             % exc.code})
        except Exception as exc:
            # ssl.SSLCertVerificationError, DNS failures, timeouts, connection
            # refused (firewall) all land here with the real message.
            return self._json(502, {"ok": False, "url": url, "checks": checks,
                                    "error": str(exc)[:300]})

        # Sample chat payload through the public route (tiny, cheap).
        probe_started = time.time()
        access = core.STATE.cfg.get("access", {}) or {}
        headers = {"Content-Type": "application/json",
                   "ngrok-skip-browser-warning": "1"}
        legacy_key = access.get("access_key")
        if access.get("key_required") and legacy_key:
            headers["Authorization"] = "Bearer " + legacy_key
        payload = {"model": sorted(core.STATE.public_models() or ["gpt-4o"])[0],
                   "messages": [{"role": "user",
                                 "content": "Reply with exactly: REACH OK"}],
                   "max_tokens": 16, "stream": False}
        try:
            req = urllib.request.Request(
                url.rstrip("/") + "/v1/chat/completions",
                data=json.dumps(payload).encode("utf-8"), method="POST",
                headers=headers)
            with urllib.request.urlopen(req, timeout=60) as resp:
                chat_ms = round((time.time() - probe_started) * 1000)
                data = json.loads(resp.read().decode("utf-8", "replace"))
                reply = (data.get("choices") or [{}])[0].get("message", {}).get("content")
                checks.append({"name": "chat_completion", "ok": True,
                               "detail": "HTTP %d in %d ms — %r"
                                         % (resp.status, chat_ms,
                                            (reply or "")[:40]),
                               "status": resp.status, "latency_ms": chat_ms})
        except urllib.error.HTTPError as exc:
            detail = exc.read(512).decode("utf-8", "replace")
            checks.append({"name": "chat_completion", "ok": False,
                           "detail": "HTTP %d — %s" % (exc.code, detail[:200]),
                           "status": exc.code,
                           "latency_ms": round((time.time() - probe_started) * 1000)})
        except Exception as exc:
            checks.append({"name": "chat_completion", "ok": False,
                           "detail": str(exc)[:200],
                           "latency_ms": round((time.time() - probe_started) * 1000)})
        ok = all(c.get("ok") for c in checks)
        self._json(200 if ok else 502,
                   {"ok": ok, "url": url, "checks": checks,
                    "total_ms": round((time.time() - started) * 1000)})

    def handle_public_url_override(self):
        body = self._read_body()
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            return self._json(400, {"error": {"message": "invalid JSON",
                                              "type": "invalid_request"}})
        url = (data.get("public_url") or "").strip()
        # Validate a candidate copy BEFORE mutating live config, and never
        # swallow a rejected value (finding: an invalid override slipped through
        # the bare `except: pass` and was published to the discovery gist).
        candidate = {**core.STATE.cfg}
        if url:
            candidate["public_url_override"] = url
        else:
            candidate.pop("public_url_override", None)
        try:
            validate_settings(candidate)
        except SettingsError as exc:
            return self._json(400, {"error": {"message": str(exc),
                                              "type": "invalid_settings"}})
        try:
            save_config(candidate, core.STATE.cfg_path)
        except OSError as exc:
            return self._json(500, {"error": {"message": "could not persist: %s" % exc,
                                              "type": "server_error"}})
        core.STATE.cfg = candidate
        core.STATE.poll_public_url()
        self._json(200, {"public_url": core.STATE.public_url,
                         "source": core.STATE.public_url_source})

    # ------------------------------------------------------------- chat route
    def _should_log(self, status):
        level = core.STATE.cfg.get("data", {}).get("log_level", "normal")
        if level == "none":
            return False
        if level == "errors":
            return status >= 400
        return True  # normal + verbose

    def _log_chat(self, **fields):
        if not self._should_log(fields.get("status", 0)):
            return
        fields.setdefault("key_name", getattr(self, "_auth_key_name", ""))
        verbose = core.STATE.cfg.get("data", {}).get("log_level") == "verbose"
        if not verbose:
            fields.pop("request_body", None)
            fields.pop("response_body", None)
        core.STATE.analytics.log_request(**fields)

    def handle_chat(self):
        # One record per request, live for as long as it runs: /status shows it
        # and the log line at each end says how long it took. There is no
        # timeout — a slow generation is meant to be watched, not killed.
        record = core.STATE.begin_request()
        self._reach_request = record
        try:
            # chat_execute answers the client itself on every early exit (rate
            # limit, bad body, unknown model, upstream down) and returns None.
            # Unpacking that used to raise, so the error handler then wrote a
            # second 500 onto a connection that had already been answered.
            result = chat_execute(self)
            if result is None:
                return
            upstream, ctx = result
            if upstream is None:
                return
            chat_finalize(self, upstream, ctx)
        finally:
            elapsed = core.STATE.end_request(record)
            model = record.get("model") or "(unresolved)"
            if core.STATE.cfg.get("data", {}).get("log_level") != "none":
                self._reach_log("chat end model=%s upstream=%s %.1fs stream=%s"
                                % (model, record.get("upstream") or "-", elapsed,
                                   "yes" if record.get("stream") else "no"))

    @staticmethod
    def _reach_log(line):
        """Relay timeline on stdout, which the runtime redirects into
        reach.log — so an in-progress request is observable while it runs."""
        try:
            print("[reach] " + line, flush=True)
        except Exception:
            pass

    def handle_chat_placeholder(self):
        return None

    @staticmethod
    def _cache_key(payload, cache_cfg):
        key_payload = {"model": payload.get("model"), "messages": payload.get("messages"),
                       "tools": payload.get("tools"),
                       "response_format": payload.get("response_format")}
        if cache_cfg.get("match_temperature"):
            key_payload["temperature"] = payload.get("temperature")
        raw = json.dumps(key_payload, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()
