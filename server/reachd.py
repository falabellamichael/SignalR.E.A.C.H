#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SimpleREACH relay v2 — OpenAI-compatible endpoint backed by OmniRoute's codegpt.

REACH = RAG Endpoint & AI Chat Host.

Public surface (CORS-open, no auth by default):
  GET  /health, /status          liveness + rich status (never gated)
  GET  /public-url               {"public_url", "source"}
  GET  /v1/models                enabled model aliases from settings
  POST /v1/chat/completions      proxied to OmniRoute, model pinned via alias
                                 (stream + non-stream); rate-limited; logged

Admin surface (loopback clients only — the relay binds 127.0.0.1 by default,
and _reach/* refuses non-loopback callers even if `host` is widened):
  GET/PUT /_reach/settings       full settings (key masked on GET) + validation
  POST    /_reach/test           tiny live completion through the upstream
  POST    /_reach/publish        push current public URL to the pointer gist
  GET     /_reach/stats          today totals, 24h series, by-model, top clients
  GET/DELETE /_reach/logs        recent request log / clear

Robustness: settings schema validation, atomic config writes, SQLite analytics,
token-bucket rate limiting (per-IP + global), optional shared access key,
upstream retry + circuit breaker, concurrency semaphore, log rotation.
Config + data live in %LOCALAPPDATA%\\SimpleREACH\\ (config.json, data/reach.db).
"""

import argparse
import collections
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "2.0.0"
SERVICE = "simplereach"
DEFAULT_PORT = 20777
MAX_BODY_BYTES = 32 * 1024 * 1024
MAX_UPSTREAM_CONCURRENCY = 6
CIRCUIT_FAILURE_THRESHOLD = 5
CIRCUIT_OPEN_SECONDS = 30
LATENCY_SAMPLE_LIMIT = 1000

GIST_ID = "e261e0c31ad08c373bcd667b6982847a"
GIST_FILE = "simple-reach-endpoint.txt"

STATE = None          # RelayState, set in main()
PORT = DEFAULT_PORT

# ----------------------------------------------------------------------
# Settings schema + defaults
# ----------------------------------------------------------------------

ALIAS_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
UPSTREAM_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")

DEFAULT_SETTINGS = {
    "omniroute_url": "http://127.0.0.1:20128/v1",
    "omniroute_key": "",
    "port": 20777,
    "host": "127.0.0.1",
    "tunnel": "ngrok",                      # ngrok | cloudflared | none
    "public_url_override": None,
    "upstream_timeout_s": 600,
    "models": {
        "gpt-4o": {"upstream": "codegpt/codegpt-gpt-4o", "enabled": True},
        "gpt-4o-mini": {"upstream": "codegpt/codegpt-gpt-4o-mini", "enabled": True},
    },
    "rate_limits": {
        "enabled": True,
        "per_ip_rpm": 12,                   # requests per minute per client IP
        "per_ip_tokens_day": 400000,        # 0 disables
        "global_rpm": 60,
        "burst": 4,
    },
    "access": {"key_required": False, "access_key": ""},
    "data": {"log_retention_days": 7},
    "publish": {"enabled": True},
}

NUMERIC_FIELDS = {
    "port": (1024, 65535),
    "upstream_timeout_s": (10, 3600),
}

RATE_LIMIT_FIELDS = {
    "per_ip_rpm": (1, 1000),
    "per_ip_tokens_day": (0, 10000000),
    "global_rpm": (1, 10000),
    "burst": (0, 100),
}


class SettingsError(ValueError):
    pass


def _expect(cond, message):
    if not cond:
        raise SettingsError(message)


def validate_settings(cfg):
    """Validate a FULL settings dict in place; raises SettingsError."""
    allowed = set(DEFAULT_SETTINGS)
    unknown = sorted(set(cfg) - allowed)
    _expect(not unknown, "unknown settings key(s): " + ", ".join(unknown))
    for key in ("omniroute_url", "host", "tunnel"):
        _expect(isinstance(cfg.get(key), str), key + " must be a string")
    _expect(cfg.get("omniroute_url", "").startswith("http"),
            "omniroute_url must start with http(s)")
    _expect(cfg.get("host") in ("127.0.0.1", "localhost", "0.0.0.0"),
            "host must be 127.0.0.1, localhost or 0.0.0.0")
    _expect(cfg.get("tunnel") in ("ngrok", "cloudflared", "none"),
            "tunnel must be ngrok, cloudflared or none")
    for field, (lo, hi) in NUMERIC_FIELDS.items():
        value = cfg.get(field)
        _expect(isinstance(value, int) and not isinstance(value, bool),
                field + " must be an integer")
        _expect(lo <= value <= hi, "%s must be between %d and %d" % (field, lo, hi))
    override = cfg.get("public_url_override")
    _expect(override is None or (isinstance(override, str)
                                 and override.startswith("https://")),
            "public_url_override must be null or an https URL")
    _expect(isinstance(cfg.get("omniroute_key"), str),
            "omniroute_key must be a string")
    _expect(isinstance(cfg.get("upstream_timeout_s"), int)
            and not isinstance(cfg.get("upstream_timeout_s"), bool)
            and 10 <= cfg.get("upstream_timeout_s") <= 3600,
            "upstream_timeout_s must be an integer between 10 and 3600")

    models = cfg.get("models")
    _expect(isinstance(models, dict), "models must be an object")
    _expect(0 < len(models) <= 32, "models must hold 1..32 aliases")
    for alias, spec in models.items():
        _expect(ALIAS_PATTERN.fullmatch(alias),
                "invalid model alias %r (a-zA-Z0-9._-, max 64)" % alias)
        _expect(isinstance(spec, dict) and set(spec) <= {"upstream", "enabled"},
                "model %s: only upstream/enabled keys allowed" % alias)
        _expect(UPSTREAM_PATTERN.fullmatch(spec.get("upstream", "")),
                "model %s: invalid upstream id" % alias)
        _expect(type(spec.get("enabled")) is bool,
                "model %s: enabled must be a boolean" % alias)

    rl = cfg.get("rate_limits")
    _expect(isinstance(rl, dict) and set(rl) <= set(DEFAULT_SETTINGS["rate_limits"]),
            "rate_limits: unknown keys")
    _expect(type(rl.get("enabled")) is bool, "rate_limits.enabled must be a boolean")
    for field, (lo, hi) in RATE_LIMIT_FIELDS.items():
        value = rl.get(field)
        _expect(isinstance(value, int) and not isinstance(value, bool)
                and lo <= value <= hi,
                "rate_limits.%s must be an integer %d..%d" % (field, lo, hi))

    access = cfg.get("access")
    _expect(isinstance(access, dict) and set(access) <= {"key_required", "access_key"},
            "access: unknown keys")
    _expect(type(access.get("key_required")) is bool,
            "access.key_required must be a boolean")
    _expect(isinstance(access.get("access_key", ""), str)
            and len(access.get("access_key", "")) <= 128,
            "access.access_key must be a string of at most 128 chars")
    if access.get("key_required"):
        _expect(len(access.get("access_key", "")) >= 6,
                "access_key must be at least 6 chars when key_required is on")

    data = cfg.get("data")
    _expect(isinstance(data, dict) and set(data) <= {"log_retention_days"},
            "data: unknown keys")
    retention = data.get("log_retention_days")
    _expect(isinstance(retention, int) and not isinstance(retention, bool)
            and 1 <= retention <= 365,
            "data.log_retention_days must be an integer 1..365")

    publish = cfg.get("publish")
    _expect(isinstance(publish, dict) and set(publish) <= {"enabled"},
            "publish: unknown keys")
    _expect(type(publish.get("enabled")) is bool,
            "publish.enabled must be a boolean")


def merged_settings(base, patch):
    """Merge a partial patch into a full settings dict.
    - models entries merge per-alias; an alias mapped to null is REMOVED.
    - other dict sections merge shallowly; scalars replace."""
    result = json.loads(json.dumps(base))
    for key, value in (patch or {}).items():
        if key not in result:
            result[key] = value
            continue
        if key == "models" and isinstance(value, dict):
            for alias, spec in value.items():
                if spec is None:
                    result["models"].pop(alias, None)
                elif isinstance(spec, dict):
                    result["models"][alias] = {
                        **result["models"].get(alias, {}), **spec}
                else:
                    result["models"][alias] = spec
            continue
        if isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = {**result[key], **value}
        else:
            result[key] = value
    return result


def settings_public(cfg):
    """Settings for display: never leak the upstream key."""
    shown = json.loads(json.dumps(cfg))
    if shown.get("omniroute_key"):
        shown["omniroute_key"] = "set (" + shown["omniroute_key"][:6] + "…)"
    access = shown.get("access") or {}
    if access.get("access_key"):
        access["access_key"] = "set (" + access["access_key"][:4] + "…)"
    return shown


# ----------------------------------------------------------------------
# Paths + analytics DB
# ----------------------------------------------------------------------

def config_dir():
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "SimpleREACH"


def load_config(path):
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = {}
        if isinstance(raw, dict):
            cfg = {**DEFAULT_SETTINGS, **raw}
            cfg["models"] = {**DEFAULT_SETTINGS["models"], **(raw.get("models") or {})}
            cfg["rate_limits"] = {**DEFAULT_SETTINGS["rate_limits"], **(raw.get("rate_limits") or {})}
            cfg["access"] = {**DEFAULT_SETTINGS["access"], **(raw.get("access") or {})}
            cfg["data"] = {**DEFAULT_SETTINGS["data"], **(raw.get("data") or {})}
            cfg["publish"] = {**DEFAULT_SETTINGS["publish"], **(raw.get("publish") or {})}
            try:
                validate_settings(cfg)
                return cfg
            except SettingsError as exc:
                print("config warning: %s — using defaults where possible" % exc)
                cfg["_last_config_error"] = str(exc)
                return cfg
    return json.loads(json.dumps(DEFAULT_SETTINGS))


def save_config(cfg, cfg_path):
    validate_settings(cfg)
    cfg_dir = cfg_path.parent
    cfg_dir.mkdir(parents=True, exist_ok=True)
    tmp = cfg_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    os.replace(str(tmp), str(cfg_path))


class Analytics:
    """SQLite request log + daily token counters. Every connection is closed
    explicitly (Windows holds file locks on open handles)."""

    def __init__(self, db_path):
        self.db_path = db_path
        self._lock = threading.RLock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts TEXT NOT NULL,
                    model TEXT, upstream_model TEXT, ip TEXT, user_agent TEXT,
                    status INTEGER, error TEXT, latency_ms INTEGER,
                    tokens_in INTEGER, tokens_out INTEGER, stream INTEGER DEFAULT 0
                )""")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS rate_tokens (
                    ip TEXT PRIMARY KEY, day TEXT NOT NULL,
                    tokens INTEGER NOT NULL DEFAULT 0
                )""")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts)")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)")
            conn.commit()
        finally:
            conn.close()

    def _connect(self):
        conn = sqlite3.connect(str(self.db_path), timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _run(self, fn):
        """Run fn(conn) under the lock, committing if it writes; always close."""
        with self._lock:
            conn = self._connect()
            try:
                return fn(conn)
            finally:
                conn.close()

    def log_request(self, **fields):
        try:
            def _write(conn):
                conn.execute(
                    "INSERT INTO requests (ts, model, upstream_model, ip,"
                    " user_agent, status, error, latency_ms, tokens_in,"
                    " tokens_out, stream) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (time.strftime("%Y-%m-%dT%H:%M:%S"),
                     fields.get("model"), fields.get("upstream_model"),
                     fields.get("ip"), (fields.get("user_agent") or "")[:200],
                     fields.get("status"), fields.get("error"),
                     fields.get("latency_ms"), fields.get("tokens_in"),
                     fields.get("tokens_out"), 1 if fields.get("stream") else 0))
                conn.commit()
            self._run(_write)
        except sqlite3.Error:
            pass  # analytics must never break the relay

    def add_tokens(self, ip, tokens):
        if not tokens:
            return 0
        day = time.strftime("%Y-%m-%d")
        try:
            def _write(conn):
                conn.execute(
                    "INSERT INTO rate_tokens (ip, day, tokens) VALUES (?,?,?) "
                    "ON CONFLICT(ip) DO UPDATE SET tokens = CASE WHEN day = ? "
                    "THEN tokens + ? ELSE ? END, day = ?",
                    (ip, day, tokens, day, tokens, tokens, day))
                conn.commit()
                row = conn.execute("SELECT tokens FROM rate_tokens WHERE ip = ?",
                                   (ip,)).fetchone()
                return row[0] if row else tokens
            return self._run(_write)
        except sqlite3.Error:
            return 0

    def tokens_today(self, ip):
        day = time.strftime("%Y-%m-%d")
        try:
            def _read(conn):
                row = conn.execute(
                    "SELECT tokens FROM rate_tokens WHERE ip = ? AND day = ?",
                    (ip, day)).fetchone()
                return row[0] if row else 0
            return self._run(_read)
        except sqlite3.Error:
            return 0

    def prune(self, retention_days):
        try:
            cutoff = time.strftime("%Y-%m-%dT%H:%M:%S",
                                   time.localtime(time.time()
                                                  - retention_days * 86400))
            def _write(conn):
                conn.execute("DELETE FROM requests WHERE ts < ?", (cutoff,))
                conn.commit()
            self._run(_write)
        except sqlite3.Error:
            pass

    def stats(self):
        now = time.time()
        today = time.strftime("%Y-%m-%dT00:00:00")
        day_ago = time.strftime("%Y-%m-%dT%H:%M:%S",
                                time.localtime(now - 86400))
        out = {"today": {}, "hourly": [], "by_model": [], "top_clients": [],
               "db": str(self.db_path)}
        try:
            def _read(conn):
                conn.row_factory = sqlite3.Row
                row = conn.execute(
                    "SELECT COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_in),0) AS ti,"
                    " COALESCE(SUM(tokens_out),0) AS tout,"
                    " COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS err,"
                    " COALESCE(SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END),0) AS rl,"
                    " COALESCE(AVG(latency_ms),0) AS lat "
                    "FROM requests WHERE ts >= ?", (today,)).fetchone()
                out["today"] = {
                    "requests": row["n"], "tokens_in": row["ti"],
                    "tokens_out": row["tout"], "errors": row["err"],
                    "rate_limited": row["rl"], "avg_latency_ms": round(row["lat"], 1),
                }
                out["hourly"] = [{
                    "hour": r["h"], "requests": r["n"], "tokens_in": r["ti"],
                    "tokens_out": r["tout"], "errors": r["err"],
                } for r in conn.execute(
                    "SELECT substr(ts, 1, 13) || ':00' AS h, COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_in),0) AS ti,"
                    " COALESCE(SUM(tokens_out),0) AS tout,"
                    " COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS err "
                    "FROM requests WHERE ts >= ? GROUP BY h ORDER BY h", (day_ago,))]
                out["by_model"] = [{
                    "model": r["model"] or "(unknown)", "requests": r["n"],
                    "tokens_in": r["ti"], "tokens_out": r["tout"],
                } for r in conn.execute(
                    "SELECT model, COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_in),0) AS ti,"
                    " COALESCE(SUM(tokens_out),0) AS tout "
                    "FROM requests WHERE ts >= ? GROUP BY model ORDER BY n DESC",
                    (today,))]
                out["top_clients"] = [{
                    "ip": r["ip"] or "?", "requests": r["n"],
                    "tokens_out": r["tout"],
                } for r in conn.execute(
                    "SELECT ip, COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_out),0) AS tout "
                    "FROM requests WHERE ts >= ? AND ip IS NOT NULL "
                    "GROUP BY ip ORDER BY n DESC LIMIT 10", (today,))]
            self._run(_read)
        except sqlite3.Error:
            pass
        return out

    def logs(self, limit=100, status=None, model=None):
        query = ("SELECT id, ts, model, upstream_model, ip, user_agent, status,"
                 " error, latency_ms, tokens_in, tokens_out, stream "
                 "FROM requests")
        clauses, params = [], []
        if status:
            clauses.append("status LIKE ?")
            params.append(status.replace("*", "%"))
        if model:
            clauses.append("model LIKE ?")
            params.append(model.replace("*", "%"))
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        try:
            def _read(conn):
                conn.row_factory = sqlite3.Row
                return [dict(r) for r in conn.execute(query, params)]
            return self._run(_read)
        except sqlite3.Error:
            return []

    def clear(self):
        try:
            def _write(conn):
                conn.execute("DELETE FROM requests")
                conn.commit()
                return True
            return self._run(_write)
        except sqlite3.Error:
            return False


# ----------------------------------------------------------------------
# Rate limiter (token buckets: per-IP + global, plus daily token budget)
# ----------------------------------------------------------------------

class RateLimiter:
    def __init__(self):
        self._lock = threading.RLock()
        self._buckets = {}        # ip -> {"tokens": float, "updated": float}
        self._global = {"tokens": 0.0, "updated": 0.0}

    def check(self, ip, settings):
        """Returns (allowed, headers, reason) — headers are X-RateLimit-*."""
        rl = settings.get("rate_limits", {})
        headers = {}
        if not rl.get("enabled"):
            return True, headers, None
        with self._lock:
            now = time.time()

            def refill(bucket, rate, capacity, init=False):
                if init and bucket["updated"] == 0.0:
                    bucket["updated"] = now
                    bucket["tokens"] = float(capacity)
                    return
                bucket["tokens"] = min(capacity,
                                       bucket["tokens"] + (now - bucket["updated"]) * rate)
                bucket["updated"] = now

            per_ip_rpm = float(rl.get("per_ip_rpm", 12))
            burst = float(rl.get("burst", 4))
            global_rpm = float(rl.get("global_rpm", 60))

            bucket = self._buckets.setdefault(ip, {"tokens": 0.0, "updated": 0.0})
            refill(bucket, per_ip_rpm / 60.0, per_ip_rpm + burst,
                   init=bucket["updated"] == 0.0)
            refill(self._global, global_rpm / 60.0, global_rpm + burst,
                   init=self._global["updated"] == 0.0)

            headers["X-RateLimit-Limit"] = str(int(per_ip_rpm + burst))
            headers["X-RateLimit-Remaining"] = str(max(0, int(bucket["tokens"] - 1)))
            if bucket["tokens"] < 1:
                wait = (1.0 - bucket["tokens"]) * 60.0 / per_ip_rpm
                return False, {"X-RateLimit-Limit": str(int(per_ip_rpm + burst)),
                               "X-RateLimit-Remaining": "0",
                               "Retry-After": str(max(1, int(wait)) + 1)}, "per_ip_rpm"
            if self._global["tokens"] < 1:
                wait = (1.0 - self._global["tokens"]) * 60.0 / global_rpm
                return False, {"X-RateLimit-Limit": str(int(global_rpm + burst)),
                               "X-RateLimit-Remaining": "0",
                               "Retry-After": str(max(1, int(wait)) + 1)}, "global_rpm"
            bucket["tokens"] -= 1.0
            self._global["tokens"] -= 1.0
        return True, headers, None


# ----------------------------------------------------------------------
# Relay state
# ----------------------------------------------------------------------

class RelayState:
    def __init__(self, cfg, cfg_path):
        self.cfg = cfg
        self.cfg_path = cfg_path
        self.analytics = Analytics(config_dir() / "data" / "reach.db")
        self.limiter = RateLimiter()
        self.semaphore = threading.BoundedSemaphore(MAX_UPSTREAM_CONCURRENCY)
        self.latencies = collections.deque(maxlen=LATENCY_SAMPLE_LIMIT)
        self.public_url = None
        self.public_url_source = None
        self.started_at = time.time()
        self.upstream_ok = None
        self.upstream_checked = 0.0
        self.circuit_open_until = 0.0
        self.consecutive_failures = 0
        self._lock = threading.RLock()

    @property
    def omniroute_url(self):
        return self.cfg.get("omniroute_url", DEFAULT_SETTINGS["omniroute_url"])

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

    def note_failure(self):
        with self._lock:
            self.consecutive_failures += 1
            if self.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD:
                self.circuit_open_until = time.time() + CIRCUIT_OPEN_SECONDS
                self.consecutive_failures = 0

    def note_success(self):
        with self._lock:
            self.consecutive_failures = 0
            self.circuit_open_until = 0.0

    def circuit_open(self):
        with self._lock:
            return time.time() < self.circuit_open_until

    def discover_public_url(self):
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

    def enabled_models(self):
        return {alias: spec["upstream"] for alias, spec
                in self.cfg.get("models", {}).items() if spec.get("enabled")}

    def p95_latency_ms(self):
        with self._lock:
            if not self.latencies:
                return 0.0
            ordered = sorted(self.latencies)
            return round(ordered[int(len(ordered) * 0.95) - 1], 1)

    def snapshot(self):
        with self._lock:
            stats = self.analytics.stats()
            return {
                "service": SERVICE,
                "version": VERSION,
                "ok": True,
                "port": PORT,
                "upstream": self.omniroute_url,
                "upstream_ok": self.upstream_alive(),
                "circuit_open": self.circuit_open(),
                "models": list(self.enabled_models()),
                "public_url": self.public_url,
                "public_url_source": self.public_url_source,
                "uptime_s": round(time.time() - self.started_at, 1),
                "p95_latency_ms": self.p95_latency_ms(),
                "today": stats.get("today", {}),
                "rate_limits": {
                    "enabled": bool(self.cfg.get("rate_limits", {}).get("enabled")),
                },
                "access_required": bool(self.cfg.get("access", {})
                                       .get("key_required")),
            }

    def log_rotation(self, log_path):
        try:
            if log_path.is_file() and log_path.stat().st_size > 2 * 1024 * 1024:
                os.replace(str(log_path), str(log_path) + ".1")
        except OSError:
            pass


# ----------------------------------------------------------------------
# HTTP handler
# ----------------------------------------------------------------------

class RelayHandler(BaseHTTPRequestHandler):
    server_version = "SimpleREACH/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ------------------------------------------------------------------ helpers
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Authorization, X-Reach-Key")
        self.send_header("Access-Control-Expose-Headers",
                         "X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After")

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
        except (BrokenPipeError, ConnectionResetError):
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
        """Admin surface is loopback-only regardless of bind host."""
        if not self._is_loopback():
            self._json(403, {"error": {"message": "admin API is local-only",
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
        query = self._query_params()
        try:
            if path in ("/health", "/status"):
                self._json(200, STATE.snapshot())
            elif path == "/public-url":
                self._json(200, {"public_url": STATE.public_url,
                                 "source": STATE.public_url_source})
            elif path == "/v1/models":
                if not self._check_access():
                    return
                data = [{"id": alias, "object": "model",
                         "created": 1715367049, "owned_by": "SimpleREACH"}
                        for alias in sorted(STATE.enabled_models())]
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
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})

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
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})

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
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})

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
            elif path == "/_reach/test":
                if not self._require_admin():
                    return
                self.handle_upstream_test()
            elif path == "/_reach/publish":
                if not self._require_admin():
                    return
                self.handle_publish()
            elif path == "/v1/chat/completions":
                if not self._check_access():
                    return
                self.handle_chat()
            else:
                self._json(404, {"error": {"message": "Not found: " + path,
                                           "type": "not_found"}})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._json(500, {"error": {"message": str(exc), "type": "internal_error"}})

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
        if "omniroute_key" in patch and not patch.get("omniroute_key"):
            patch.pop("omniroute_key")  # blank means keep the existing key
        if isinstance(patch.get("omniroute_key"), str) \
                and patch["omniroute_key"].startswith("set ("):
            patch.pop("omniroute_key")  # masked placeholder means keep it too
        access_patch = patch.get("access")
        if isinstance(access_patch, dict) and isinstance(access_patch.get("access_key"), str) \
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
        models = STATE.enabled_models()
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
        if not STATE.cfg.get("publish", {}).get("enabled"):
            return self._json(400, {"ok": False,
                                    "error": "publishing is disabled in settings"})
        url = STATE.public_url
        if not url:
            return self._json(400, {"ok": False, "error": "no public URL available"})
        gh = shutil_which_or_none("gh")
        if not gh:
            gh = str(Path(os.environ.get("PROGRAMFILES", "")) / "GitHub CLI"
                     / "gh.exe")
            if not Path(gh).is_file():
                return self._json(500, {"ok": False, "error": "gh CLI not found"})
        tmp = STATE.cfg_path.parent / GIST_FILE
        tmp.write_text(url.strip(), encoding="utf-8")
        try:
            result = subprocess.run([gh, "gist", "edit", GIST_ID, str(tmp)],
                                    capture_output=True, text=True, timeout=60,
                                    creationflags=(subprocess.CREATE_NO_WINDOW
                                                   if os.name == "nt" else 0))
            if result.returncode != 0:
                return self._json(500, {"ok": False,
                                        "error": (result.stderr or "")[:300]})
            self._json(200, {"ok": True, "public_url": url})
        except Exception as exc:
            self._json(500, {"ok": False, "error": str(exc)[:300]})

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
    def handle_chat(self):
        ip = self._client_ip()
        rl_settings = STATE.cfg.get("rate_limits", {})
        allowed, rl_headers, reason = STATE.limiter.check(ip, STATE.cfg)
        if not allowed:
            STATE.analytics.log_request(
                model=None, upstream_model=None, ip=ip,
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
        requested = payload.get("model") or ""
        enabled = STATE.enabled_models()
        if requested not in enabled:
            self._json(404, {
                "error": {
                    "message": ("Unknown model %r. Served models: %s"
                                % (requested, ", ".join(sorted(enabled)) or "(none)")),
                    "type": "invalid_request_error", "param": "model",
                    "code": "model_not_found",
                },
            }, rl_headers)
            return
        if not STATE.key:
            self._json(503, {"error": {"message": "SimpleREACH is not configured "
                                                  "yet (no OmniRoute key).",
                                       "type": "server_error"}}, rl_headers)
            return
        if STATE.circuit_open():
            self._json(503, {"error": {"message": "Upstream is in a failure "
                                                  "cool-down — retry shortly.",
                                       "type": "server_error",
                                       "code": "upstream_cooling_down"}}, rl_headers)
            return

        payload["model"] = enabled[requested]
        stream = bool(payload.get("stream"))

        if not STATE.semaphore.acquire(timeout=15):
            self._json(503, {"error": {"message": "Relay is at capacity — "
                                                  "retry shortly.",
                                       "type": "server_error",
                                       "code": "overloaded"}}, rl_headers)
            return
        try:
            url = STATE.omniroute_url.rstrip("/") + "/chat/completions"
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode("utf-8"), method="POST",
                headers={"Content-Type": "application/json",
                         "Authorization": "Bearer " + STATE.key})
            try:
                upstream = urllib.request.urlopen(
                    req, timeout=int(STATE.cfg.get("upstream_timeout_s", 600)))
            except (urllib.error.URLError, OSError) as first:
                if stream:
                    raise
                time.sleep(1)  # one retry on non-stream transient failures
                upstream = urllib.request.urlopen(
                    req, timeout=int(STATE.cfg.get("upstream_timeout_s", 600)))
        except urllib.error.HTTPError as exc:
            STATE.note_failure()
            STATE.analytics.log_request(
                model=requested, upstream_model=payload["model"], ip=ip,
                user_agent=self.headers.get("User-Agent"), status=exc.code,
                error="upstream_http", latency_ms=int((time.time() - started) * 1000),
                tokens_in=0, tokens_out=0, stream=stream)
            return self._relay_upstream_error(exc, "OmniRoute rejected the request")
        except (urllib.error.URLError, OSError) as exc:
            STATE.note_failure()
            STATE.analytics.log_request(
                model=requested, upstream_model=payload["model"], ip=ip,
                user_agent=self.headers.get("User-Agent"), status=502,
                error="upstream_unreachable", latency_ms=int((time.time() - started) * 1000),
                tokens_in=0, tokens_out=0, stream=stream)
            return self._relay_upstream_error(exc, "OmniRoute unreachable")
        finally:
            if not stream:
                STATE.semaphore.release()

        content_type = upstream.headers.get("Content-Type", "application/json")
        if stream:
            try:
                self.send_response(200)
                self.send_header("Content-Type", content_type or "text/event-stream")
                self._cors()
                self._rate_limit_headers(rl_headers)
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
                STATE.note_success()
                STATE.analytics.log_request(
                    model=requested, upstream_model=payload["model"], ip=ip,
                    user_agent=self.headers.get("User-Agent"), status=200,
                    error=None, latency_ms=int((time.time() - started) * 1000),
                    tokens_in=None, tokens_out=None, stream=True)
            finally:
                STATE.semaphore.release()
                try:
                    upstream.close()
                except Exception:
                    pass
            return

        data = upstream.read()
        tokens_in = tokens_out = None
        try:
            parsed = json.loads(data.decode("utf-8", "replace"))
            usage = parsed.get("usage") or {}
            tokens_in = usage.get("prompt_tokens")
            tokens_out = usage.get("completion_tokens")
        except Exception:
            pass
        STATE.note_success()
        latency_ms = int((time.time() - started) * 1000)
        with STATE._lock:
            STATE.latencies.append(latency_ms)
        STATE.analytics.log_request(
            model=requested, upstream_model=payload["model"], ip=ip,
            user_agent=self.headers.get("User-Agent"), status=200, error=None,
            latency_ms=latency_ms, tokens_in=tokens_in, tokens_out=tokens_out,
            stream=False)
        if tokens_out:
            daily = STATE.analytics.add_tokens(ip, int(tokens_out or 0))
            limit = rl_settings.get("per_ip_tokens_day", 0)
            if limit and daily > limit:
                self._json(429, {
                    "error": {"message": "Daily token budget reached.",
                              "type": "rate_limit_error",
                              "code": "daily_token_limit"},
                }, {**rl_headers, "Retry-After": "86400"})
                return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self._rate_limit_headers(rl_headers)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def shutil_which_or_none(name):
    import shutil
    return shutil.which(name)


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

    threading.Thread(target=poller, daemon=True).start()
    threading.Thread(target=pruner, daemon=True).start()
    print("SimpleREACH %s listening on http://%s:%d" % (VERSION, host, PORT),
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
