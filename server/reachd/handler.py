"""The HTTP handler: routing, admin routes, and response helpers."""

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

import reachd.core as core  # core.STATE is read at call time (cycle-safe)
from reachd.chat import chat_execute, chat_finalize
from reachd.const import CLIENT_DISCONNECT_ERRORS, MAX_BODY_BYTES, VERSION
from reachd.publish import publish_url
from reachd.settings import (
    DEFAULT_SETTINGS,
    SettingsError,
    generate_client_key,
    key_preview,
    mask_key,
    merged_settings,
    restore_masked_client_keys,
    save_config,
    settings_public,
    validate_settings,
)


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
                and not core.STATE.cfg.get("system", {}).get("allow_remote_admin"):
            self._json(403, {"error": {"message": "admin API is local-only "
                                                  "(system.allow_remote_admin=false)",
                                       "type": "forbidden"}})
            return False
        return True

    def _check_access(self):
        access = core.STATE.cfg.get("access", {})
        key_required = access.get("key_required", False)
        keys = access.get("keys", [])
        legacy_key = access.get("access_key")

        presented = (self.headers.get("X-Reach-Key") or "").strip()
        if not presented:
            auth = (self.headers.get("Authorization") or "").strip()
            presented = auth[7:].strip() if auth.lower().startswith("bearer ") else auth

        matched_key = None
        if presented:
            for k in keys:
                if k.get("enabled", True) and hmac.compare_digest(k.get("key", ""), presented):
                    matched_key = k
                    break
            if not matched_key and legacy_key and hmac.compare_digest(legacy_key, presented):
                matched_key = {"id": "legacy", "name": "Legacy Key", "key": legacy_key}

        if matched_key:
            self._auth_key_name = matched_key.get("name", "Key")
            self._auth_key_id = matched_key.get("id", "")
            now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            matched_key["last_used_at"] = now_iso
            return True

        if not key_required:
            self._auth_key_name = "anonymous"
            self._auth_key_id = ""
            return True

        self._json(401, {"error": {"message": "Invalid SignalR.E.A.C.H API Key. Send 'Authorization: Bearer sk-reach-...' or 'X-Reach-Key'.",
                                    "type": "authentication_error",
                                    "code": "invalid_api_key"}},
                   {"WWW-Authenticate": "Bearer"})
        return False

    def _check_ip_lists(self):
        access = core.STATE.cfg.get("access", {})
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
                self._json(200, core.STATE.snapshot())
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
                safe_keys = []
                for k in keys:
                    sk = dict(k)
                    raw_k = sk.get("key", "")
                    sk["masked_key"] = mask_key(raw_k)
                    sk["preview"] = key_preview(raw_k)
                    safe_keys.append(sk)
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
                    for k in keys:
                        if k.get("id") == key_id or k.get("key") == key_id:
                            if "name" in patch:
                                k["name"] = str(patch["name"]).strip()
                            if "enabled" in patch:
                                val = patch["enabled"]
                                if isinstance(val, bool):
                                    k["enabled"] = val
                                else:
                                    k["enabled"] = str(val).lower() not in ("false", "0", "no", "off", "")
                            found = k
                            break
                    if found:
                        save_config(core.STATE.cfg, core.STATE.cfg_path)
                        safe_f = dict(found)
                        safe_f["masked_key"] = mask_key(safe_f.get("key", ""))
                        self._json(200, {"updated": True, "key": safe_f})
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
                core.STATE.cache.clear()
                self._json(200, {"cleared": True})
            elif path == "/_reach/keys":
                if not self._require_admin():
                    return
                self.handle_create_key()
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
            keep = {"omniroute_key": core.STATE.cfg.get("omniroute_key", ""),
                    "access": {"access_key": (core.STATE.cfg.get("access") or {})
                               .get("access_key", "")}}
            patch = {**keep}
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
        core.STATE.cfg = next_cfg
        core.STATE.poll_public_url()
        self._json(200, {"saved": True, "settings": settings_public(next_cfg)})

    def handle_reset(self):
        keep = {"omniroute_key": core.STATE.cfg.get("omniroute_key", ""),
                "access": {"access_key": (core.STATE.cfg.get("access") or {})
                           .get("access_key", "")}}
        next_cfg = merged_settings(DEFAULT_SETTINGS, keep)
        save_config(next_cfg, core.STATE.cfg_path)
        core.STATE.cfg = next_cfg
        core.STATE.poll_public_url()
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
        upstream_model = sorted(models.values())[0]
        payload = {"model": upstream_model,
                   "messages": [{"role": "user",
                                 "content": "Reply with exactly: REACH OK"}],
                   "max_tokens": 16}
        try:
            url = core.STATE.omniroute_url.rstrip("/") + "/chat/completions"
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode("utf-8"), method="POST",
                headers={"Content-Type": "application/json",
                         "Authorization": "Bearer " + core.STATE.key})
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
            core.STATE.cfg["public_url_override"] = url
            try:
                save_config(core.STATE.cfg, core.STATE.cfg_path)
            except (OSError, SettingsError):
                pass
        else:
            core.STATE.cfg.pop("public_url_override", None)
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
        upstream, ctx = chat_execute(self)
        if upstream is None:
            return
        chat_finalize(self, upstream, ctx)

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
