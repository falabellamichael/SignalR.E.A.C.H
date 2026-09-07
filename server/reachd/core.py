#!/usr/bin/env python3
"""SimpleREACH relay v3 — OpenAI-compatible endpoint backed by OmniRoute's codegpt.

REACH = RAG Endpoint & AI Chat Host.

Public surface (CORS configurable, no auth by default):
  GET  /health, /status          liveness + rich status (never gated)
  GET  /public-url               {"public_url", "source"}
  GET  /v1/models                public, enabled model aliases
  POST /v1/chat/completions      proxied to OmniRoute via alias mapping
                                 (stream + non-stream) with the full request
                                 pipeline: field policy, clamps, system prompt
                                 injection, per-alias settings + fallbacks,
                                 caching, rate limits, access lists, logging

Admin surface (loopback-only unless system.allow_remote_admin):
  GET/PUT /_reach/settings       settings read (masked) / validated patch
  POST    /_reach/settings/test  validate a patch without persisting
  POST    /_reach/reset          reset to defaults (keeps upstream + access keys)
  POST    /_reach/test           live upstream completion test
  POST    /_reach/publish        push current public URL to the pointer gist
  POST    /_reach/cache/clear    flush the response cache
  GET     /_reach/stats          totals, 24h series, by-model, top clients
  GET/DELETE /_reach/logs        recent request log / clear

Settings schema: see DEFAULT_SETTINGS. Every field is validated and applied
live; per-alias model settings carry defaults, caps, rate limits, system
prompts, fallback chains, visibility, and streaming/tools toggles.
"""

import argparse
import collections
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from reachd.analytics import Analytics
from reachd.cache import ResponseCache
from reachd.const import (
    DEFAULT_PORT,
    GIST_FILE,
    GIST_ID,
    LATENCY_SAMPLE_LIMIT,
    MAX_BODY_BYTES,
    MAX_RATE_BUCKETS,
    SERVICE,
    VERSION,
)
from reachd.limits import CounterGate, RateLimiter
from reachd.state import RelayState
from reachd.settings import (
    DEFAULT_SETTINGS,
    SettingsError,
    config_dir,
    load_config,
    merged_settings,
    save_config,
    settings_public,
    validate_settings,
)
from reachd.text import count_tokens, scrub_trailing_roles

STATE = None          # RelayState, set in main()
PORT = DEFAULT_PORT

# ----------------------------------------------------------------------
# HTTP handler
# ----------------------------------------------------------------------

CLIENT_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


class RelayHandler(BaseHTTPRequestHandler):
    server_version = "SimpleREACH/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ------------------------------------------------------------------ helpers
    def _cors(self):
        origins = (STATE.cfg.get("access", {}).get("cors_origins") or "*").strip()
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
        self._cors()
        for key, value in (extra_headers or {}).items():
            self.send_header(key, str(value))
        self.end_headers()
        try:
            self.wfile.write(body)
        except CLIENT_DISCONNECT_ERRORS:
            pass

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        if length > MAX_BODY_BYTES:
            raise ValueError("request body too large")
        return self.rfile.read(length)

    def _client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()[:64]
        return (self.client_address[0] if self.client_address else "?")[:64]

    def _is_loopback(self):
        return self.client_address and self.client_address[0] in ("127.0.0.1", "::1")

    def _require_admin(self):
        """Admin surface is loopback-only unless system.allow_remote_admin."""
        if not self._is_loopback() \
                and not STATE.cfg.get("system", {}).get("allow_remote_admin"):
            self._json(403, {"error": {"message": "admin API is local-only "
                                                  "(system.allow_remote_admin=false)",
                                       "type": "forbidden"}})
            return False
        return True

    def _check_access(self):
        access = STATE.cfg.get("access", {})
        if not access.get("key_required") or not access.get("access_key"):
            return True
        presented = (self.headers.get("X-Reach-Key") or "").strip()
        if not presented:
            auth = self.headers.get("Authorization") or ""
            presented = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if presented == access.get("access_key"):
            return True
        self._json(401, {"error": {"message": "REACH access key required",
                                   "type": "authentication_error",
                                   "code": "invalid_api_key"}},
                   {"WWW-Authenticate": "Bearer"})
        return False

    def _check_ip_lists(self):
        access = STATE.cfg.get("access", {})
        ip = self._client_ip()
        if self._is_loopback():
            return True
        allowlist = access.get("ip_allowlist") or []
        blocklist = access.get("ip_blocklist") or []
        if allowlist and ip not in allowlist:
            self._json(403, {"error": {"message": "IP not allowed",
                                       "type": "forbidden", "code": "ip_denied"}})
            return False
        if blocklist and ip in blocklist:
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
                self._json(200, STATE.snapshot())
            elif path == "/public-url":
                self._json(200, {"public_url": STATE.public_url,
                                 "source": STATE.public_url_source})
            elif path in ("/v1/models", "/models"):
                if not self._check_access():
                    return
                data = [{"id": alias, "object": "model",
                         "created": 1715367049, "owned_by": "SimpleREACH"}
                        for alias in sorted(STATE.public_models())]
                self._json(200, {"object": "list", "data": data})
            elif path == "/_reach/settings":
                if not self._require_admin():
                    return
                self._json(200, settings_public(STATE.cfg))
            elif path == "/_reach/stats":
                if not self._require_admin():
                    return
                snapshot = STATE.snapshot()
                snapshot["stats"] = STATE.analytics.stats()
                self._json(200, snapshot)
            elif path == "/_reach/logs":
                if not self._require_admin():
                    return
                self._json(200, {"logs": STATE.analytics.logs(
                    limit=query.get("limit", 100),
                    status=query.get("status"),
                    model=query.get("model"))})
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
                STATE.analytics.clear()
                self._json(200, {"cleared": True})
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

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path == "/_reach/public-url":
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
            elif path == "/_reach/publish":
                if not self._require_admin():
                    return
                self.handle_publish()
            elif path == "/_reach/cache/clear":
                if not self._require_admin():
                    return
                STATE.cache.clear()
                self._json(200, {"cleared": True})
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
            try:
                self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})
            except Exception:
                pass

    # ------------------------------------------------------------- admin routes
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
            keep = {"omniroute_key": STATE.cfg.get("omniroute_key", ""),
                    "access": {"access_key": (STATE.cfg.get("access") or {})
                               .get("access_key", "")}}
            patch = {**keep}
        if "omniroute_key" in patch and not patch.get("omniroute_key"):
            patch.pop("omniroute_key")  # blank means keep the existing key
        if isinstance(patch.get("omniroute_key"), str) \
                and patch["omniroute_key"].startswith("set ("):
            patch.pop("omniroute_key")  # masked placeholder means keep it too
        access_patch = patch.get("access")
        if isinstance(access_patch, dict) \
                and isinstance(access_patch.get("access_key"), str) \
                and access_patch["access_key"].startswith("set ("):
            access_patch.pop("access_key")
        next_cfg = merged_settings(STATE.cfg, patch)
        try:
            validate_settings(next_cfg)
        except SettingsError as exc:
            return self._json(400, {"error": {"message": str(exc),
                                              "type": "invalid_settings"}})
        try:
            save_config(next_cfg, STATE.cfg_path)
        except (OSError, SettingsError) as exc:
            return self._json(500, {"error": {"message": "could not persist: %s" % exc,
                                              "type": "server_error"}})
        STATE.cfg = next_cfg
        STATE.poll_public_url()
        self._json(200, {"saved": True, "settings": settings_public(next_cfg)})

    def handle_reset(self):
        keep = {"omniroute_key": STATE.cfg.get("omniroute_key", ""),
                "access": {"access_key": (STATE.cfg.get("access") or {})
                           .get("access_key", "")}}
        next_cfg = merged_settings(DEFAULT_SETTINGS, keep)
        save_config(next_cfg, STATE.cfg_path)
        STATE.cfg = next_cfg
        STATE.poll_public_url()
        self._json(200, {"saved": True, "settings": settings_public(next_cfg)})

    def handle_settings_test(self):
        """Validate a patch WITHOUT persisting it (used by the settings UI)."""
        body = self._read_body()
        try:
            patch = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            return self._json(400, {"error": {"message": "invalid JSON",
                                              "type": "invalid_request"}})
        try:
            validate_settings(merged_settings(STATE.cfg, patch))
            self._json(200, {"valid": True})
        except SettingsError as exc:
            self._json(400, {"error": {"message": str(exc), "type": "invalid_settings"},
                             "valid": False})

    def handle_upstream_test(self):
        started = time.time()
        models = STATE.public_models() or STATE.enabled_models()
        if not models:
            return self._json(503, {"ok": False,
                                    "error": "no enabled models configured"})
        upstream_model = sorted(models.values())[0]
        payload = {"model": upstream_model,
                   "messages": [{"role": "user",
                                 "content": "Reply with exactly: REACH OK"}],
                   "max_tokens": 16}
        try:
            url = STATE.omniroute_url.rstrip("/") + "/chat/completions"
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode("utf-8"), method="POST",
                headers={"Content-Type": "application/json",
                         "Authorization": "Bearer " + STATE.key})
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
        ok, detail = publish_url(STATE)
        if ok:
            self._json(200, {"ok": True, "public_url": detail})
        else:
            self._json(400, {"ok": False, "error": detail})

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
                save_config(STATE.cfg, STATE.cfg_path)
            except (OSError, SettingsError):
                pass
        else:
            STATE.cfg.pop("public_url_override", None)
        STATE.poll_public_url()
        self._json(200, {"public_url": STATE.public_url,
                         "source": STATE.public_url_source})

    # ------------------------------------------------------------- chat route
    def _should_log(self, status):
        level = STATE.cfg.get("data", {}).get("log_level", "normal")
        if level == "none":
            return False
        if level == "errors":
            return status >= 400
        return True  # normal + verbose

    def _log_chat(self, **fields):
        if not self._should_log(fields.get("status", 0)):
            return
        verbose = STATE.cfg.get("data", {}).get("log_level") == "verbose"
        if not verbose:
            fields.pop("request_body", None)
            fields.pop("response_body", None)
        STATE.analytics.log_request(**fields)

    def handle_chat(self):
        ip = self._client_ip()
        if not self._check_ip_lists():
            return

        # ---- rate limit (global buckets; per-model applied after parsing) ----
        allowed, rl_headers, reason = STATE.limiter.check(ip, STATE.cfg)
        if not allowed:
            self._log_chat(model=None, upstream_model=None, ip=ip,
                           user_agent=self.headers.get("User-Agent"), status=429,
                           error="rate_limited:" + (reason or "?"), latency_ms=0,
                           tokens_in=0, tokens_out=0, stream=False)
            self._json(429, {
                "error": {"message": "Rate limit reached (%s). Slow down."
                                     % (reason or "limit"),
                          "type": "rate_limit_error", "code": "rate_limit"},
            }, rl_headers)
            return

        started = time.time()
        body = self._read_body()
        request_body = None
        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self._json(400, {"error": {"message": "invalid JSON body",
                                              "type": "invalid_request"}},
                              rl_headers)
        if not isinstance(payload, dict):
            return self._json(400, {"error": {"message": "invalid request body",
                                              "type": "invalid_request"}},
                              rl_headers)

        req_cfg = STATE.cfg.get("request", {})
        models = STATE.cfg.get("models", {})
        requested = payload.get("model") or req_cfg.get("default_model", "")
        spec = models.get(requested)

        # model visibility: unknown or disabled → 404; private + remote → 404
        if not spec or not spec.get("enabled"):
            self._json(404, {
                "error": {
                    "message": ("Unknown model %r. Served models: %s"
                                % (requested,
                                   ", ".join(sorted(STATE.public_models()))
                                   or "(none)")),
                    "type": "invalid_request_error", "param": "model",
                    "code": "model_not_found",
                },
            }, rl_headers)
            return
        if not spec.get("public", True) and not self._is_loopback():
            self._json(404, {
                "error": {"message": "Unknown model %r." % requested,
                          "type": "invalid_request_error", "param": "model",
                          "code": "model_not_found"},
            }, rl_headers)
            return

        # ---- per-model rate limit bucket ----
        allowed, rl_headers, reason = STATE.limiter.check(ip, STATE.cfg,
                                                          model=requested)
        if not allowed:
            self._log_chat(model=requested, upstream_model=None, ip=ip,
                           user_agent=self.headers.get("User-Agent"), status=429,
                           error="rate_limited:" + (reason or "?"), latency_ms=0,
                           tokens_in=0, tokens_out=0, stream=False)
            self._json(429, {
                "error": {"message": "Rate limit reached for model %r (%s)."
                                     % (requested, reason or "limit"),
                          "type": "rate_limit_error", "code": "rate_limit"},
            }, rl_headers)
            return

        # ---- field policy ----
        blocked = set(req_cfg.get("blocked_fields") or [])
        if req_cfg.get("allow_tools") is False or not spec.get("allow_tools", True):
            blocked |= {"tools", "tool_choice"}
        if not req_cfg.get("allow_response_format", True):
            blocked.add("response_format")
        if not req_cfg.get("allow_logprobs", False):
            blocked |= {"logprobs", "top_logprobs"}
        blocked = {f for f in blocked if isinstance(f, str) and f}
        if blocked:
            present = [f for f in blocked if f in payload]
            if present and req_cfg.get("reject_blocked"):
                return self._json(400, {
                    "error": {"message": "Field(s) not allowed: %s" % ", ".join(sorted(present)),
                              "type": "invalid_request_error",
                              "code": "blocked_field"},
                }, rl_headers)
            for field in present:
                payload.pop(field, None)

        # ---- input guards ----
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            return self._json(400, {"error": {"message": "messages must be a "
                                                          "non-empty array",
                                              "type": "invalid_request"}},
                              rl_headers)
        max_messages = int(req_cfg.get("max_messages", 100))
        if len(messages) > max_messages:
            return self._json(400, {"error": {"message": "too many messages "
                                                          "(max %d)" % max_messages,
                                              "type": "invalid_request"}},
                              rl_headers)
        total_chars = 0
        for message in messages:
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    total_chars += len(content)
        max_input_chars = int(req_cfg.get("max_input_chars", 400000))
        if total_chars > max_input_chars:
            return self._json(400, {"error": {"message": "input too large "
                                                          "(max %d chars)" % max_input_chars,
                                              "type": "invalid_request"}},
                              rl_headers)
        max_prompt_tokens = int(STATE.cfg.get("rate_limits", {})
                                .get("max_prompt_tokens", 0) or 0)
        if max_prompt_tokens and (total_chars // 4) > max_prompt_tokens:
            return self._json(400, {"error": {"message": "prompt exceeds %d "
                                                          "tokens (approx)" % max_prompt_tokens,
                                              "type": "invalid_request",
                                              "code": "prompt_too_long"}},
                              rl_headers)

        # ---- temperature: default + clamp ----
        t_min = max(float(req_cfg.get("temperature_min", 0.0)),
                    float(spec.get("temperature_min", 0.0) or 0.0))
        t_max = min(float(req_cfg.get("temperature_max", 2.0)),
                    float(spec.get("temperature_max", 2.0) or 2.0))
        if "temperature" in payload:
            temp = payload["temperature"]
            if isinstance(temp, (int, float)):
                payload["temperature"] = max(t_min, min(t_max, float(temp)))
        elif spec.get("temperature") is not None:
            payload["temperature"] = float(spec["temperature"])

        # ---- max_tokens: default + cap ----
        effective_cap = int(req_cfg.get("max_tokens_cap", 0) or 0)
        model_cap = int(spec.get("max_tokens_cap", 0) or 0)
        if effective_cap and model_cap:
            effective_cap = min(effective_cap, model_cap)
        else:
            effective_cap = effective_cap or model_cap
        if "max_tokens" in payload:
            requested_tokens = payload["max_tokens"]
            if isinstance(requested_tokens, int) and requested_tokens > 0 \
                    and effective_cap:
                payload["max_tokens"] = min(requested_tokens, effective_cap)
        elif spec.get("max_tokens") is not None:
            payload["max_tokens"] = int(spec["max_tokens"])

        # ---- stream ----
        stream = payload.get("stream")
        if stream is None:
            stream = bool(req_cfg.get("default_stream", False))
            payload["stream"] = stream
        else:
            stream = bool(stream)
        if stream and not spec.get("allow_stream", True):
            return self._json(400, {"error": {"message": "streaming is disabled "
                                                          "for model %r" % requested,
                                              "type": "invalid_request"}},
                              rl_headers)

        # ---- system prompt injection (model-level, then global) ----
        injected = (spec.get("system_prompt") or "").strip() \
            or (req_cfg.get("inject_system_prompt") or "").strip()
        if injected:
            first = messages[0] if messages else None
            already = isinstance(first, dict) and first.get("role") == "system" \
                and (first.get("content") or "").strip() == injected
            if not already:
                messages.insert(0, {"role": "system", "content": injected})

        # ---- upstream model + circuit + key ----
        upstream_model = spec["upstream"]
        if not STATE.key:
            return self._json(503, {"error": {"message": "SimpleREACH is not "
                                                          "configured yet (no "
                                                          "OmniRoute key).",
                                              "type": "server_error"}}, rl_headers)
        if STATE.circuit_open():
            return self._json(503, {"error": {"message": "Upstream is in a "
                                                          "failure cool-down — "
                                                          "retry shortly.",
                                              "type": "server_error",
                                              "code": "upstream_cooling_down"}},
                              rl_headers)

        # ---- cache lookup (non-stream) ----
        cache_cfg = STATE.cfg.get("cache", {})
        cache_key = None
        if cache_cfg.get("enabled") and not stream:
            cache_key = self._cache_key(payload, cache_cfg)
            cached_body = STATE.cache.get(cache_key)
            if cached_body is not None:
                latency_ms = int((time.time() - started) * 1000)
                self._log_chat(model=requested, upstream_model=upstream_model,
                               ip=ip, user_agent=self.headers.get("User-Agent"),
                               status=200, error=None, latency_ms=latency_ms,
                               tokens_in=None, tokens_out=None, stream=False,
                               cached=True)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(cached_body)))
                self._cors()
                self._rate_limit_headers(rl_headers)
                self.send_header("X-Reach-Cache", "HIT")
                self.end_headers()
                try:
                    self.wfile.write(cached_body)
                except CLIENT_DISCONNECT_ERRORS:
                    pass
                return

        # ---- concurrency gate ----
        if not STATE.gate.acquire(int(STATE.cfg.get("max_concurrency", 6)),
                                  timeout_s=15):
            return self._json(503, {"error": {"message": "Relay is at capacity "
                                                          "— retry shortly.",
                                              "type": "server_error",
                                              "code": "overloaded"}}, rl_headers)
        try:
            url = STATE.omniroute_url.rstrip("/") + "/chat/completions"
            payload["model"] = upstream_model
            encoded = json.dumps(payload).encode("utf-8")
            if STATE.cfg.get("data", {}).get("log_bodies"):
                request_body = body[:2048].decode("utf-8", "replace")
            retries = int(STATE.cfg.get("upstream_retries", 1))
            retry_delay = float(STATE.cfg.get("retry_delay_ms", 1000)) / 1000.0
            upstream = None
            attempts = retries + 1 if not stream else 1
            last_error = None
            fallback_used = False
            for attempt in range(attempts):
                try:
                    req = urllib.request.Request(
                        url, data=encoded, method="POST",
                        headers={"Content-Type": "application/json",
                                 "Authorization": "Bearer " + STATE.key})
                    upstream = urllib.request.urlopen(
                        req,
                        timeout=int(STATE.cfg.get("stream_timeout_s", 300)
                                    if stream
                                    else STATE.cfg.get("upstream_timeout_s", 600)))
                    break
                except urllib.error.HTTPError as exc:
                    if exc.code < 500 or attempt == attempts - 1:
                        last_error = exc
                        break
                    last_error = exc
                    time.sleep(retry_delay)
                except (urllib.error.URLError, OSError) as exc:
                    last_error = exc
                    if attempt == attempts - 1:
                        break
                    time.sleep(retry_delay)
            # fallback alias on total failure (streaming or non-streaming)
            if upstream is None:
                fallback_alias = spec.get("fallback")
                if fallback_alias and fallback_alias in models \
                        and models[fallback_alias].get("enabled"):
                    fb_upstream = models[fallback_alias]["upstream"]
                    try:
                        fb_payload = dict(payload)
                        fb_payload["model"] = fb_upstream
                        fb_req = urllib.request.Request(
                            url, data=json.dumps(fb_payload).encode("utf-8"),
                            method="POST",
                            headers={"Content-Type": "application/json",
                                     "Authorization": "Bearer " + STATE.key})
                        upstream = urllib.request.urlopen(
                            fb_req,
                            timeout=int(STATE.cfg.get("upstream_timeout_s", 600)))
                        upstream_model = fb_upstream
                        spec = models[fallback_alias]
                        fallback_used = True
                    except Exception as exc:
                        last_error = exc
            if upstream is None:
                if isinstance(last_error, urllib.error.HTTPError):
                    STATE.note_failure()
                    self._log_chat(model=requested, upstream_model=upstream_model,
                                   ip=ip,
                                   user_agent=self.headers.get("User-Agent"),
                                   status=last_error.code, error="upstream_http",
                                   latency_ms=int((time.time() - started) * 1000),
                                   tokens_in=0, tokens_out=0, stream=stream,
                                   request_body=request_body)
                    return self._relay_upstream_error(
                        last_error, "OmniRoute rejected the request")
                STATE.note_failure()
                self._log_chat(model=requested, upstream_model=upstream_model,
                               ip=ip, user_agent=self.headers.get("User-Agent"),
                               status=502, error="upstream_unreachable",
                               latency_ms=int((time.time() - started) * 1000),
                               tokens_in=0, tokens_out=0, stream=stream,
                               request_body=request_body)
                return self._relay_upstream_error(
                    last_error, "OmniRoute unreachable")
        finally:
            if not stream:
                STATE.gate.release()

        content_type = upstream.headers.get("Content-Type", "application/json")
        if stream:
            try:
                self.send_response(200)
                self.send_header("Content-Type", content_type or "text/event-stream")
                self._cors()
                self._rate_limit_headers(rl_headers)
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Transfer-Encoding", "chunked")
                if fallback_used:
                    self.send_header("X-Reach-Fallback", "used")
                self.end_headers()
                if spec.get("strip_trailing_roles"):
                    # Buffer the stream, scrub the assembled content, then
                    # emit a single clean completion.
                    buffered = b""
                    while True:
                        line = upstream.readline()
                        if not line:
                            break
                        buffered += line
                    assembled = []
                    for line in buffered.decode("utf-8", "replace").splitlines():
                        if not line.startswith("data:"):
                            continue
                        chunk = line[5:].strip()
                        if chunk == "[DONE]":
                            continue
                        try:
                            delta = (json.loads(chunk).get("choices")
                                     or [{}])[0].get("delta", {})
                            content = delta.get("content")
                            if isinstance(content, str):
                                assembled.append(content)
                        except json.JSONDecodeError:
                            pass
                    scrubbed = scrub_trailing_roles("".join(assembled))
                    now_end = time.time()
                    stream_duration = max(0.2, now_end - started)
                    latency_ms = int(stream_duration * 1000)
                    approx_in = max(1, total_chars // 4)
                    approx_out = count_tokens(scrubbed)
                    tps = round(approx_out / stream_duration, 1)
                    STATE.note_speed(tps)
                    created = int(time.time())
                    for payload_chunk in (
                        {"id": "chatcmpl-reach", "object": "chat.completion.chunk",
                         "created": created, "model": requested,
                         "choices": [{"index": 0, "delta": {"content": scrubbed},
                                      "finish_reason": None}]},
                        {"id": "chatcmpl-reach", "object": "chat.completion.chunk",
                         "created": created, "model": requested,
                         "choices": [{"index": 0, "delta": {},
                                      "finish_reason": "stop"}]},
                        {"id": "chatcmpl-reach", "object": "chat.completion.chunk",
                         "created": created, "model": requested,
                         "choices": [],
                         "usage": {"prompt_tokens": approx_in,
                                   "completion_tokens": approx_out,
                                   "total_tokens": approx_in + approx_out,
                                   "tokens_per_second": tps,
                                   "tokensPerSecond": tps,
                                   "completion_tokens_per_second": tps,
                                   "speed_tps": tps}}
                    ):
                        self._write_chunk(("data: " + json.dumps(payload_chunk)
                                           + "\n\n").encode("utf-8"))
                    try:
                        self._write_chunk(b"data: [DONE]\n\n")
                        self._write_chunk(b"")  # terminating chunk
                    except Exception:
                        pass
                else:
                    first_token_time = None
                    last_token_time = None
                    token_chunks_count = 0
                    streamed_tokens = 0
                    streamed_prompt_tokens = 0
                    assembled_chunks = []
                    last_chunk_id = "chatcmpl-reach"
                    try:
                        while True:
                            line = upstream.readline()
                            if not line:
                                break
                            if line.startswith(b"data:"):
                                text_line = line[5:].strip()
                                if text_line == b"[DONE]":
                                    break
                                try:
                                    parsed_chunk = json.loads(text_line.decode("utf-8", "replace"))
                                    if isinstance(parsed_chunk, dict):
                                        if parsed_chunk.get("id"):
                                            last_chunk_id = parsed_chunk["id"]
                                        usage_obj = parsed_chunk.get("usage")
                                        if isinstance(usage_obj, dict):
                                            if usage_obj.get("completion_tokens"):
                                                streamed_tokens = int(usage_obj["completion_tokens"])
                                            if usage_obj.get("prompt_tokens"):
                                                streamed_prompt_tokens = int(usage_obj["prompt_tokens"])
                                        choices = parsed_chunk.get("choices")
                                        if isinstance(choices, list) and choices:
                                            delta = choices[0].get("delta", {})
                                            content = delta.get("content")
                                            if isinstance(content, str) and content:
                                                now_t = time.time()
                                                token_chunks_count += 1
                                                if first_token_time is None:
                                                    first_token_time = now_t
                                                last_token_time = now_t
                                                assembled_chunks.append(content)
                                except Exception:
                                    pass
                            self._write_chunk(line)

                        full_streamed_text = "".join(assembled_chunks)
                        approx_out = streamed_tokens if streamed_tokens > 0 else count_tokens(full_streamed_text)
                        now_end = time.time()
                        total_elapsed = max(0.2, now_end - started)
                        latency_ms = int((now_end - started) * 1000)

                        # Genuine continuous stream: multiple chunks spread over at least 300ms
                        if (first_token_time and last_token_time and
                                (last_token_time - first_token_time) >= 0.3 and
                                token_chunks_count >= 3 and approx_out > 2):
                            decode_duration = last_token_time - first_token_time
                            tps = round((approx_out - 1) / decode_duration, 1)
                        else:
                            # Buffered burst: tokens arrived in 1-2 chunks, use elapsed request duration
                            tps = round(approx_out / total_elapsed, 1)

                        if streamed_prompt_tokens > 0:
                            approx_in = streamed_prompt_tokens
                        else:
                            approx_in = max(1, total_chars // 4)

                        STATE.note_speed(tps)

                        created_now = int(time.time())
                        usage_chunk = {
                            "id": last_chunk_id,
                            "object": "chat.completion.chunk",
                            "created": created_now,
                            "model": requested,
                            "choices": [],
                            "usage": {
                                "prompt_tokens": approx_in,
                                "completion_tokens": approx_out,
                                "total_tokens": approx_in + approx_out,
                                "tokens_per_second": tps,
                                "tokensPerSecond": tps,
                                "completion_tokens_per_second": tps,
                                "speed_tps": tps
                            }
                        }
                        self._write_chunk(("data: " + json.dumps(usage_chunk) + "\n\n").encode("utf-8"))
                        self._write_chunk(b"data: [DONE]\n\n")
                    finally:
                        try:
                            self._write_chunk(b"")
                        except Exception:
                            pass
                STATE.note_success()
                self._log_chat(model=requested, upstream_model=upstream_model,
                               ip=ip, user_agent=self.headers.get("User-Agent"),
                               status=200, error=None,
                               latency_ms=latency_ms,
                               tokens_in=approx_in, tokens_out=approx_out, stream=True,
                               request_body=request_body)
            finally:
                STATE.gate.release()
                try:
                    upstream.close()
                except Exception:
                    pass
            return

        data = upstream.read()
        tokens_in = tokens_out = None
        response_body = None
        parsed = None
        try:
            parsed = json.loads(data.decode("utf-8", "replace"))
            usage = parsed.get("usage") or {}
            tokens_in = usage.get("prompt_tokens")
            tokens_out = usage.get("completion_tokens")
        except Exception:
            parsed = None

        latency_ms = int((time.time() - started) * 1000)
        content_text = ""
        if isinstance(parsed, dict):
            choices = parsed.get("choices") or []
            if choices and isinstance(choices[0], dict):
                content_text = (choices[0].get("message") or {}).get("content") or ""

        if tokens_out is None or tokens_out == 0:
            tokens_out = count_tokens(content_text) if content_text else 1

        if tokens_in is None or tokens_in == 0:
            tokens_in = max(1, total_chars // 4)

        tps = round(tokens_out / max(0.2, latency_ms / 1000.0), 1)
        STATE.note_speed(tps)

        if isinstance(parsed, dict):
            usage = parsed.get("usage")
            if not isinstance(usage, dict):
                usage = {}
            usage["prompt_tokens"] = tokens_in
            usage["completion_tokens"] = tokens_out
            usage["total_tokens"] = tokens_in + tokens_out
            usage["tokens_per_second"] = tps
            usage["tokensPerSecond"] = tps
            usage["completion_tokens_per_second"] = tps
            usage["speed_tps"] = tps
            parsed["usage"] = usage

            if spec.get("strip_trailing_roles"):
                try:
                    choices = parsed.get("choices")
                    if isinstance(choices, list):
                        for choice in choices:
                            message = choice.get("message")
                            if isinstance(message, dict) \
                                    and isinstance(message.get("content"), str):
                                message["content"] = scrub_trailing_roles(
                                    message["content"])
                except Exception:
                    pass
            data = json.dumps(parsed).encode("utf-8")

        if STATE.cfg.get("data", {}).get("log_bodies"):
            response_body = data[:2048].decode("utf-8", "replace")
        STATE.note_success()
        with STATE._lock:
            STATE.latencies.append(latency_ms)

        # ---- daily token budgets: global, per-IP, per-model ----
        if tokens_out:
            rl = STATE.cfg.get("rate_limits", {})
            global_budget = int(rl.get("global_tokens_day", 0) or 0)
            if global_budget:
                if STATE.analytics.add_tokens("*", int(tokens_out)) > global_budget:
                    return self._json(429, {
                        "error": {"message": "Global daily token budget reached.",
                                  "type": "rate_limit_error",
                                  "code": "daily_token_limit"},
                    }, {**rl_headers, "Retry-After": "86400"})
            per_ip_budget = int(rl.get("per_ip_tokens_day", 0) or 0)
            if per_ip_budget:
                if STATE.analytics.add_tokens(ip, int(tokens_out)) > per_ip_budget:
                    return self._json(429, {
                        "error": {"message": "Daily token budget reached.",
                                  "type": "rate_limit_error",
                                  "code": "daily_token_limit"},
                    }, {**rl_headers, "Retry-After": "86400"})
            model_budget = int((spec.get("rate_limits") or {})
                               .get("tokens_day", 0) or 0)
            if model_budget:
                if STATE.analytics.add_tokens(ip + "::" + requested,
                                              int(tokens_out)) > model_budget:
                    return self._json(429, {
                        "error": {"message": "Daily token budget reached for "
                                             "model %r." % requested,
                                  "type": "rate_limit_error",
                                  "code": "daily_token_limit"},
                    }, {**rl_headers, "Retry-After": "86400"})

        # ---- cache store ----
        if cache_cfg.get("enabled") and not stream and cache_key:
            STATE.cache.put(cache_key, data, int(cache_cfg.get("ttl_s", 300)),
                            int(cache_cfg.get("max_entries", 1000)))

        self._log_chat(model=requested, upstream_model=upstream_model, ip=ip,
                       user_agent=self.headers.get("User-Agent"), status=200,
                       error=None, latency_ms=latency_ms, tokens_in=tokens_in,
                       tokens_out=tokens_out, stream=False,
                       request_body=request_body, response_body=response_body)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self._rate_limit_headers(rl_headers)
        if tps > 0:
            self.send_header("X-Tokens-Per-Second", str(tps))
            self.send_header("X-Reach-Tokens-Per-Second", str(tps))
        self.send_header("OpenAI-Processing-Ms", str(latency_ms))
        if fallback_used:
            self.send_header("X-Reach-Fallback", "used")
        self.end_headers()
        try:
            self.wfile.write(data)
        except CLIENT_DISCONNECT_ERRORS:
            pass

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


def publish_url(state):
    """Push the current public URL to the pointer gist. Returns (ok, detail)."""
    if not state.cfg.get("publish", {}).get("enabled"):
        return False, "publishing is disabled in settings"
    url = state.public_url
    if not url:
        return False, "no public URL available"
    import shutil as _shutil
    gh = _shutil.which("gh")
    if not gh:
        gh = str(Path(os.environ.get("PROGRAMFILES", "")) / "GitHub CLI"
                 / "gh.exe")
        if not Path(gh).is_file():
            return False, "gh CLI not found"
    tmp = state.cfg_path.parent / GIST_FILE
    tmp.write_text(url.strip(), encoding="utf-8")
    try:
        result = subprocess.run([gh, "gist", "edit", GIST_ID, str(tmp)],
                                capture_output=True, text=True, timeout=60,
                                creationflags=(subprocess.CREATE_NO_WINDOW
                                               if os.name == "nt" else 0))
        if result.returncode != 0:
            return False, (result.stderr or "")[:300]
        return True, url
    except Exception as exc:
        return False, str(exc)[:300]


# ----------------------------------------------------------------------
# main
# ----------------------------------------------------------------------

def main():
    global STATE, PORT
    parser = argparse.ArgumentParser(description="SimpleREACH relay server")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--config-dir", default=None)
    args = parser.parse_args()

    base = Path(args.config_dir) if args.config_dir else config_dir()
    cfg_path = base / "config.json"
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
    STATE.analytics.prune(int(cfg.get("data", {}).get("log_retention_days", 7)))

    def poller():
        while True:
            time.sleep(20)
            STATE.poll_public_url()

    def pruner():
        while True:
            time.sleep(3600)
            STATE.analytics.prune(
                int(STATE.cfg.get("data", {}).get("log_retention_days", 7)))

    def publisher():
        interval = int(STATE.cfg.get("publish", {}).get("interval_min", 0)
                       or 0)
        if interval <= 0:
            return  # publishing happens on change only
        while True:
            time.sleep(interval * 60)
            if STATE.public_url:
                try:
                    publish_url(STATE)
                except Exception:
                    pass

    threading.Thread(target=poller, daemon=True).start()
    threading.Thread(target=pruner, daemon=True).start()
    threading.Thread(target=publisher, daemon=True).start()
    print("SimpleREACH %s listening on http://%s:%d" % (VERSION, host, PORT),
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
