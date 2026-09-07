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

from reachd.text import count_tokens, scrub_trailing_roles

VERSION = "3.1.1"
SERVICE = "simplereach"
DEFAULT_PORT = 20777
MAX_BODY_BYTES = 32 * 1024 * 1024
LATENCY_SAMPLE_LIMIT = 1000
MAX_RATE_BUCKETS = 10000

GIST_ID = "e261e0c31ad08c373bcd667b6982847a"
GIST_FILE = "simple-reach-endpoint.txt"

STATE = None          # RelayState, set in main()
PORT = DEFAULT_PORT

# ----------------------------------------------------------------------
# Settings schema + defaults
# ----------------------------------------------------------------------

ALIAS_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
UPSTREAM_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")

MODEL_SPEC_DEFAULTS = {
    "upstream": "",                 # OmniRoute model id
    "enabled": True,                # servable at all
    "public": True,                 # listed in /v1/models + callable externally
    "description": "",              # shown in the panel
    "temperature": None,            # default temperature (null = passthrough)
    "max_tokens": None,             # default max_tokens (null = passthrough)
    "max_tokens_cap": 16384,        # hard cap on requested max_tokens (0 = off)
    "temperature_min": 0.0,         # clamp window
    "temperature_max": 2.0,
    "system_prompt": "",            # injected system message (model-level)
    "fallback": None,               # alias to try when upstream fails
    "allow_stream": True,
    "allow_tools": True,
    "context_window": 128000,       # informational + input guard
    "strip_trailing_roles": False,  # truncate fake "User:" transcript continuations
    "rate_limits": {"rpm": 0, "tokens_day": 0},   # 0 = inherit global
}

DEFAULT_SETTINGS = {
    # ---- relay core / upstream ----
    "omniroute_url": "http://127.0.0.1:20128/v1",
    "omniroute_key": "",
    "port": 20777,
    "host": "127.0.0.1",
    "upstream_timeout_s": 600,
    "stream_timeout_s": 300,       # hung keepalive streams free their slot sooner
    "upstream_retries": 1,          # extra attempts on URLError/5xx (non-stream)
    "retry_delay_ms": 1000,
    "circuit_threshold": 5,         # consecutive failures before cool-down
    "circuit_cooldown_s": 30,
    "max_concurrency": 12,          # simultaneous upstream calls
    "health_check_interval_s": 60,
    # ---- request handling ----
    "request": {
        "default_model": "gpt-4o",  # used when the client omits model
        "default_stream": False,    # stream mode when the client omits stream
        "max_messages": 100,
        "max_input_chars": 400000,
        "max_tokens_cap": 16384,    # global hard cap (0 = off)
        "inject_system_prompt": "",  # global system message prepended
        "allow_tools": True,
        "allow_response_format": True,
        "allow_logprobs": False,
        "blocked_fields": [],       # request fields to reject/strip
        "reject_blocked": False,    # True → 400 on blocked fields, else strip
        "temperature_min": 0.0,
        "temperature_max": 2.0,
    },
    # ---- model aliases (per-alias specs, see MODEL_SPEC_DEFAULTS) ----
    "models": {
        "gpt-4o": {
            **MODEL_SPEC_DEFAULTS,
            "upstream": "codegpt/codegpt-gpt-4o",
            "description": "Flagship free gpt-4o (codegpt tier)",
        },
        "gpt-4o-mini": {
            **MODEL_SPEC_DEFAULTS,
            "upstream": "codegpt/codegpt-gpt-4o-mini",
            "description": "Cheaper, faster gpt-4o-mini",
        },
    },
    # ---- rate limits ----
    "rate_limits": {
        "enabled": True,
        "per_ip_rpm": 12,
        "per_ip_tokens_day": 400000,   # 0 disables
        "global_rpm": 60,
        "global_tokens_day": 0,        # 0 disables
        "burst": 4,
        "max_prompt_tokens": 0,        # reject prompts over N tokens (0 = off)
    },
    # ---- access & security ----
    "access": {
        "key_required": False,
        "access_key": "",
        "ip_allowlist": [],            # empty = everyone (loopback always ok)
        "ip_blocklist": [],
        "cors_origins": "*",           # "*" or comma-separated origins
    },
    # ---- response caching ----
    "cache": {
        "enabled": False,
        "ttl_s": 300,
        "max_entries": 1000,
        "match_temperature": True,
    },
    # ---- observability ----
    "data": {
        "log_retention_days": 7,
        "log_level": "normal",         # none | errors | normal | verbose
        "log_bodies": False,           # store truncated body snippets
    },
    # ---- hosting ----
    "tunnel": "ngrok",                 # ngrok | cloudflared | none
    "public_url_override": None,
    "publish": {"enabled": True, "interval_min": 0},   # 0 = on change only
    # ---- system ----
    "system": {
        "allow_remote_admin": False,   # _reach/* beyond loopback (DANGER)
        "log_rotation_mb": 2,
    },
}

NUMERIC_FIELDS = {
    "port": (1024, 65535),
    "upstream_timeout_s": (10, 3600),
    "stream_timeout_s": (10, 3600),
    "upstream_retries": (0, 5),
    "retry_delay_ms": (0, 30000),
    "circuit_threshold": (1, 100),
    "circuit_cooldown_s": (5, 3600),
    "max_concurrency": (1, 64),
    "health_check_interval_s": (10, 3600),
}

REQUEST_NUMERIC = {
    "max_messages": (1, 1000),
    "max_input_chars": (1, 20000000),
    "max_tokens_cap": (0, 1000000),
}

RATE_LIMIT_FIELDS = {
    "per_ip_rpm": (1, 10000),
    "per_ip_tokens_day": (0, 100000000),
    "global_rpm": (1, 100000),
    "global_tokens_day": (0, 1000000000),
    "burst": (0, 1000),
    "max_prompt_tokens": (0, 1000000),
}

CACHE_FIELDS = {
    "ttl_s": (1, 86400),
    "max_entries": (1, 100000),
}

MODEL_NUMERIC = {
    "max_tokens_cap": (0, 1000000),
    "context_window": (1, 10000000),
    "rate_limits.rpm": (0, 10000),
    "rate_limits.tokens_day": (0, 100000000),
}


class SettingsError(ValueError):
    pass


def _expect(cond, message):
    if not cond:
        raise SettingsError(message)


def _int(value, lo, hi, name):
    _expect(isinstance(value, int) and not isinstance(value, bool),
            name + " must be an integer")
    _expect(lo <= value <= hi, "%s must be between %d and %d" % (name, lo, hi))


def _float(value, lo, hi, name):
    _expect(isinstance(value, (int, float)) and not isinstance(value, bool),
            name + " must be a number")
    _expect(lo <= float(value) <= hi,
            "%s must be between %s and %s" % (name, lo, hi))


def _bool(value, name):
    _expect(type(value) is bool, name + " must be a boolean")


def _str(value, name, lo=0, hi=2000):
    _expect(isinstance(value, str) and lo <= len(value) <= hi,
            "%s must be a string of %d..%d chars" % (name, lo, hi))


def _opt_str(value, name, hi=2000):
    _expect(value is None or (isinstance(value, str) and len(value) <= hi),
            name + " must be null or a string (max %d)" % hi)


def _section_keys(cfg, section, allowed, path):
    sec = cfg.get(section)
    _expect(isinstance(sec, dict), path + " must be an object")
    _expect(set(sec) <= allowed, "%s: unknown keys: %s"
            % (path, ", ".join(sorted(set(sec) - allowed))))


def _validate_model_spec(alias, spec, all_aliases, errors):
    path = "models." + alias
    if not isinstance(spec, dict):
        errors.append(path + " must be an object")
        return
    allowed = set(MODEL_SPEC_DEFAULTS)
    unknown = sorted(set(spec) - allowed)
    if unknown:
        errors.append(path + ": unknown keys " + ", ".join(unknown))
    _expect(UPSTREAM_PATTERN.fullmatch(spec.get("upstream", "")),
            path + ".upstream is invalid")
    _bool(spec.get("enabled", True), path + ".enabled")
    _bool(spec.get("public", True), path + ".public")
    _str(spec.get("description", ""), path + ".description", 0, 300)
    temp = spec.get("temperature")
    _expect(temp is None or (isinstance(temp, (int, float))
                             and not isinstance(temp, bool)),
            path + ".temperature must be null or a number")
    if temp is not None:
        _float(temp, 0, 2, path + ".temperature")
    max_tokens = spec.get("max_tokens")
    _expect(max_tokens is None or (isinstance(max_tokens, int)
                                   and not isinstance(max_tokens, bool)),
            path + ".max_tokens must be null or an integer")
    if max_tokens is not None:
        _int(max_tokens, 1, 1000000, path + ".max_tokens")
    _int(spec.get("max_tokens_cap", 16384), *MODEL_NUMERIC["max_tokens_cap"],
         path + ".max_tokens_cap")
    _float(spec.get("temperature_min", 0.0), 0, 2, path + ".temperature_min")
    _float(spec.get("temperature_max", 2.0), 0, 2, path + ".temperature_max")
    _expect(spec.get("temperature_min", 0) <= spec.get("temperature_max", 2),
            path + ".temperature_min must be <= temperature_max")
    _str(spec.get("system_prompt", ""), path + ".system_prompt", 0, 8000)
    _opt_str(spec.get("fallback"), path + ".fallback", 64)
    if spec.get("fallback"):
        _expect(spec["fallback"] in all_aliases and spec["fallback"] != alias,
                path + ".fallback must name a different alias")
    _bool(spec.get("allow_stream", True), path + ".allow_stream")
    _bool(spec.get("allow_tools", True), path + ".allow_tools")
    _bool(spec.get("strip_trailing_roles", False), path + ".strip_trailing_roles")
    _int(spec.get("context_window", 128000), *MODEL_NUMERIC["context_window"],
         path + ".context_window")
    rl = spec.get("rate_limits", {})
    _expect(isinstance(rl, dict) and set(rl) <= {"rpm", "tokens_day"},
            path + ".rate_limits: only rpm/tokens_day allowed")
    _int(rl.get("rpm", 0), *MODEL_NUMERIC["rate_limits.rpm"],
         path + ".rate_limits.rpm")
    _int(rl.get("tokens_day", 0), *MODEL_NUMERIC["rate_limits.tokens_day"],
         path + ".rate_limits.tokens_day")


def validate_settings(cfg):
    """Validate a FULL settings dict; raises SettingsError on the first issue."""
    allowed = set(DEFAULT_SETTINGS)
    unknown = sorted(set(cfg) - allowed)
    _expect(not unknown, "unknown settings key(s): " + ", ".join(unknown))
    _expect(cfg.get("omniroute_url", "").startswith("http"),
            "omniroute_url must start with http(s)")
    _str(cfg.get("omniroute_url", ""), "omniroute_url", 8, 500)
    _str(cfg.get("omniroute_key", ""), "omniroute_key", 0, 500)
    _expect(cfg.get("host") in ("127.0.0.1", "localhost", "0.0.0.0"),
            "host must be 127.0.0.1, localhost or 0.0.0.0")
    _expect(cfg.get("tunnel") in ("ngrok", "cloudflared", "none"),
            "tunnel must be ngrok, cloudflared or none")
    for field, (lo, hi) in NUMERIC_FIELDS.items():
        _int(cfg.get(field, DEFAULT_SETTINGS[field]), lo, hi, field)
    override = cfg.get("public_url_override")
    _expect(override is None or (isinstance(override, str)
                                 and override.startswith("https://")),
            "public_url_override must be null or an https URL")

    # request
    _section_keys(cfg, "request", set(DEFAULT_SETTINGS["request"]), "request")
    req = cfg["request"]
    for key in ("default_model", "inject_system_prompt"):
        _str(req.get(key, ""), "request." + key, 0, 8000)
    _bool(req.get("default_stream", False), "request.default_stream")
    for field, (lo, hi) in REQUEST_NUMERIC.items():
        _int(req.get(field, DEFAULT_SETTINGS["request"][field]), lo, hi,
             "request." + field)
    for key in ("allow_tools", "allow_response_format", "allow_logprobs",
                "reject_blocked"):
        _bool(req.get(key, False), "request." + key)
    blocked = req.get("blocked_fields", [])
    _expect(isinstance(blocked, list) and len(blocked) <= 64,
            "request.blocked_fields must be a list of at most 64 names")
    for item in blocked:
        _expect(isinstance(item, str) and 1 <= len(item) <= 64,
                "request.blocked_fields entries must be strings (max 64)")
    _float(req.get("temperature_min", 0.0), 0, 2, "request.temperature_min")
    _float(req.get("temperature_max", 2.0), 0, 2, "request.temperature_max")
    _expect(req["temperature_min"] <= req["temperature_max"],
            "request.temperature_min must be <= temperature_max")

    # models
    models = cfg.get("models")
    _expect(isinstance(models, dict), "models must be an object")
    _expect(0 < len(models) <= 32, "models must hold 1..32 aliases")
    aliases = set(models)
    errors = []
    for alias, spec in models.items():
        _expect(ALIAS_PATTERN.fullmatch(alias),
                "invalid model alias %r (a-zA-Z0-9._-, max 64)" % alias)
        try:
            _validate_model_spec(alias, spec, aliases, errors)
        except SettingsError as exc:
            errors.append(str(exc))
    _expect(not errors, "; ".join(errors))

    # rate limits
    _section_keys(cfg, "rate_limits", set(DEFAULT_SETTINGS["rate_limits"]),
                  "rate_limits")
    rl = cfg["rate_limits"]
    _bool(rl.get("enabled", True), "rate_limits.enabled")
    for field, (lo, hi) in RATE_LIMIT_FIELDS.items():
        _int(rl.get(field, DEFAULT_SETTINGS["rate_limits"][field]), lo, hi,
             "rate_limits." + field)

    # access
    _section_keys(cfg, "access", set(DEFAULT_SETTINGS["access"]), "access")
    access = cfg["access"]
    _bool(access.get("key_required", False), "access.key_required")
    _str(access.get("access_key", ""), "access.access_key", 0, 128)
    if access.get("key_required"):
        _expect(len(access.get("access_key", "")) >= 6,
                "access_key must be at least 6 chars when key_required is on")
    for key in ("ip_allowlist", "ip_blocklist"):
        value = access.get(key, [])
        _expect(isinstance(value, list) and len(value) <= 256,
                "access.%s must be a list of at most 256 IPs" % key)
        for item in value:
            _expect(isinstance(item, str) and 1 <= len(item) <= 64,
                    "access.%s entries must be strings" % key)
    _str(access.get("cors_origins", "*"), "access.cors_origins", 1, 2000)

    # cache
    _section_keys(cfg, "cache", set(DEFAULT_SETTINGS["cache"]), "cache")
    cache = cfg["cache"]
    _bool(cache.get("enabled", False), "cache.enabled")
    for field, (lo, hi) in CACHE_FIELDS.items():
        _int(cache.get(field, DEFAULT_SETTINGS["cache"][field]), lo, hi,
             "cache." + field)
    _bool(cache.get("match_temperature", True), "cache.match_temperature")

    # data
    _section_keys(cfg, "data", set(DEFAULT_SETTINGS["data"]), "data")
    data = cfg["data"]
    _int(data.get("log_retention_days", 7), 1, 365,
         "data.log_retention_days")
    _expect(data.get("log_level") in ("none", "errors", "normal", "verbose"),
            "data.log_level must be none, errors, normal or verbose")
    _bool(data.get("log_bodies", False), "data.log_bodies")

    # publish + system
    _section_keys(cfg, "publish", set(DEFAULT_SETTINGS["publish"]), "publish")
    _bool(cfg["publish"].get("enabled", True), "publish.enabled")
    _int(cfg["publish"].get("interval_min", 0), 0, 1440,
         "publish.interval_min")
    _section_keys(cfg, "system", set(DEFAULT_SETTINGS["system"]), "system")
    _bool(cfg["system"].get("allow_remote_admin", False),
          "system.allow_remote_admin")
    _int(cfg["system"].get("log_rotation_mb", 2), 1, 100,
         "system.log_rotation_mb")


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
                    existing = result["models"].get(alias, {})
                    if not isinstance(existing, dict):
                        existing = dict(MODEL_SPEC_DEFAULTS)
                    result["models"][alias] = {**MODEL_SPEC_DEFAULTS,
                                               **existing, **spec}
                else:
                    result["models"][alias] = spec
            continue
        if isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = {**result[key], **value}
        else:
            result[key] = value
    return result


def settings_public(cfg):
    """Settings for display: never leak upstream/access keys."""
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
            for section in ("request", "rate_limits", "access", "cache",
                            "data", "publish", "system"):
                cfg[section] = {**DEFAULT_SETTINGS[section],
                                **(raw.get(section) or {})}
            raw_models = raw.get("models") or {}
            cfg["models"] = {
                alias: {**MODEL_SPEC_DEFAULTS,
                        **(spec if isinstance(spec, dict) else {})}
                for alias, spec in raw_models.items()
            } or dict(DEFAULT_SETTINGS["models"])
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

    COLUMNS = [
        ("cached", "INTEGER DEFAULT 0"),
        ("request_body", "TEXT"),
        ("response_body", "TEXT"),
    ]

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
            existing = {row[1] for row in conn.execute(
                "PRAGMA table_info(requests)").fetchall()}
            for name, decl in self.COLUMNS:
                if name not in existing:
                    conn.execute("ALTER TABLE requests ADD COLUMN %s %s"
                                 % (name, decl))
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
        """Run fn(conn) under the lock; always close the connection."""
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
                    " tokens_out, stream, cached, request_body, response_body)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (time.strftime("%Y-%m-%dT%H:%M:%S"),
                     fields.get("model"), fields.get("upstream_model"),
                     fields.get("ip"), (fields.get("user_agent") or "")[:200],
                     fields.get("status"), fields.get("error"),
                     fields.get("latency_ms"), fields.get("tokens_in"),
                     fields.get("tokens_out"), 1 if fields.get("stream") else 0,
                     1 if fields.get("cached") else 0,
                     fields.get("request_body"), fields.get("response_body")))
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

    def tokens_today(self, key):
        day = time.strftime("%Y-%m-%d")
        try:
            def _read(conn):
                row = conn.execute(
                    "SELECT tokens FROM rate_tokens WHERE ip = ? AND day = ?",
                    (key, day)).fetchone()
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
               "cache_hits": 0, "db": str(self.db_path)}
        try:
            def _read(conn):
                conn.row_factory = sqlite3.Row
                row = conn.execute(
                    "SELECT COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_in),0) AS ti,"
                    " COALESCE(SUM(tokens_out),0) AS tout,"
                    " COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS err,"
                    " COALESCE(SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END),0) AS rl,"
                    " COALESCE(AVG(latency_ms),0) AS lat,"
                    " COALESCE(ROUND(SUM(CASE WHEN tokens_out > 0 THEN tokens_out ELSE 0 END) * 1000.0 / NULLIF(SUM(CASE WHEN tokens_out > 0 THEN latency_ms ELSE 0 END), 0), 1), 0.0) AS tps "
                    "FROM requests WHERE ts >= ?", (today,)).fetchone()
                out["today"] = {
                    "requests": row["n"], "tokens_in": row["ti"],
                    "tokens_out": row["tout"], "errors": row["err"],
                    "rate_limited": row["rl"],
                    "avg_latency_ms": round(row["lat"], 1),
                    "tokens_per_sec": row["tps"] or 0.0,
                }
                out["cache_hits"] = conn.execute(
                    "SELECT COUNT(*) FROM requests WHERE ts >= ? AND cached = 1",
                    (today,)).fetchone()[0]
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
                    "ip": r["ip"] or "?",
                    "requests": r["n"],
                    "tokens_in": r["ti"],
                    "tokens_out": r["tout"],
                    "errors": r["err"],
                    "last_seen": r["last_seen"],
                    "last_model": r["last_model"] or "—",
                    "user_agent": r["user_agent"] or "",
                } for r in conn.execute(
                    "SELECT ip, COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_in),0) AS ti,"
                    " COALESCE(SUM(tokens_out),0) AS tout,"
                    " COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS err,"
                    " MAX(ts) AS last_seen,"
                    " (SELECT model FROM requests r2 WHERE r2.ip = requests.ip AND r2.ts >= ? ORDER BY r2.id DESC LIMIT 1) AS last_model,"
                    " (SELECT user_agent FROM requests r3 WHERE r3.ip = requests.ip AND r3.ts >= ? ORDER BY r3.id DESC LIMIT 1) AS user_agent "
                    "FROM requests WHERE ts >= ? AND ip IS NOT NULL "
                    "GROUP BY ip ORDER BY last_seen DESC LIMIT 25", (today, today, today))]
            self._run(_read)
        except sqlite3.Error:
            pass
        return out

    def logs(self, limit=100, status=None, model=None):
        query = ("SELECT id, ts, model, upstream_model, ip, user_agent, status,"
                 " error, latency_ms, tokens_in, tokens_out, stream, cached "
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
# Response cache (in-memory LRU)
# ----------------------------------------------------------------------

class ResponseCache:
    def __init__(self):
        self._lock = threading.RLock()
        self._entries = collections.OrderedDict()   # key -> (expires, body)
        self.hits = 0
        self.misses = 0

    def get(self, key):
        with self._lock:
            entry = self._entries.get(key)
            if not entry:
                self.misses += 1
                return None
            expires, body = entry
            if time.time() > expires:
                self._entries.pop(key, None)
                self.misses += 1
                return None
            self._entries.move_to_end(key)
            self.hits += 1
            return body

    def put(self, key, body, ttl_s, max_entries):
        with self._lock:
            while len(self._entries) >= max_entries:
                self._entries.popitem(last=False)
            self._entries[key] = (time.time() + ttl_s, body)

    def clear(self):
        with self._lock:
            self._entries.clear()

    def snapshot(self):
        with self._lock:
            return {"entries": len(self._entries), "hits": self.hits,
                    "misses": self.misses}


# ----------------------------------------------------------------------
# Rate limiter (token buckets: per-IP, per-IP+model, global)
# ----------------------------------------------------------------------

class RateLimiter:
    def __init__(self):
        self._lock = threading.RLock()
        self._buckets = {}        # key -> {"tokens": float, "updated": float}
        self._global = {"tokens": 0.0, "updated": 0.0}

    def _refill(self, bucket, rate, capacity, now):
        if bucket["updated"] == 0.0:
            bucket["updated"] = now
            bucket["tokens"] = float(capacity)
            return
        bucket["tokens"] = min(capacity,
                               bucket["tokens"] + (now - bucket["updated"]) * rate)
        bucket["updated"] = now

    def check(self, ip, settings, model=None):
        """Returns (allowed, headers, reason). Optionally enforces a per-model
        bucket (rate_limits.rpm on the alias)."""
        rl = settings.get("rate_limits", {})
        if not rl.get("enabled"):
            return True, {}, None
        with self._lock:
            if len(self._buckets) > MAX_RATE_BUCKETS:
                self._buckets.clear()
            now = time.time()
            per_ip_rpm = float(rl.get("per_ip_rpm", 12))
            burst = float(rl.get("burst", 4))
            global_rpm = float(rl.get("global_rpm", 60))

            self._refill(self._global, global_rpm / 60.0,
                         global_rpm + burst, now)
            if self._global["tokens"] < 1:
                wait = (1.0 - self._global["tokens"]) * 60.0 / global_rpm
                return False, {"X-RateLimit-Limit": str(int(global_rpm + burst)),
                               "X-RateLimit-Remaining": "0",
                               "Retry-After": str(max(1, int(wait)) + 1)}, \
                    "global_rpm"

            def bucket_for(key, rpm):
                bucket = self._buckets.setdefault(
                    key, {"tokens": 0.0, "updated": 0.0})
                self._refill(bucket, float(rpm) / 60.0, float(rpm) + burst, now)
                return bucket

            ip_bucket = bucket_for(ip, per_ip_rpm)
            headers = {"X-RateLimit-Limit": str(int(per_ip_rpm + burst)),
                       "X-RateLimit-Remaining": str(max(0, int(ip_bucket["tokens"] - 1)))}
            if ip_bucket["tokens"] < 1:
                wait = (1.0 - ip_bucket["tokens"]) * 60.0 / per_ip_rpm
                return False, {**headers, "X-RateLimit-Remaining": "0",
                               "Retry-After": str(max(1, int(wait)) + 1)}, \
                    "per_ip_rpm"

            model_rpm = None
            if model:
                model_rpm = settings.get("models", {}).get(model, {}) \
                    .get("rate_limits", {}).get("rpm", 0)
            if model_rpm:
                m_bucket = bucket_for(ip + "::" + model, model_rpm)
                if m_bucket["tokens"] < 1:
                    wait = (1.0 - m_bucket["tokens"]) * 60.0 / float(model_rpm)
                    return False, {**headers, "X-RateLimit-Limit": str(int(model_rpm + burst)),
                                   "X-RateLimit-Remaining": "0",
                                   "Retry-After": str(max(1, int(wait)) + 1)}, \
                        "model_rpm"

            ip_bucket["tokens"] -= 1.0
            self._global["tokens"] -= 1.0
            if model_rpm:
                self._buckets[ip + "::" + model]["tokens"] -= 1.0
        return True, headers, None


# ----------------------------------------------------------------------
# Relay state
# ----------------------------------------------------------------------

class CounterGate:
    """Configurable concurrency limit (live-updatable, unlike BoundedSemaphore)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._active = 0

    def acquire(self, limit, timeout_s):
        deadline = time.time() + timeout_s
        while True:
            with self._lock:
                if self._active < limit:
                    self._active += 1
                    return True
            if time.time() >= deadline:
                return False
            time.sleep(0.05)

    def release(self):
        with self._lock:
            self._active = max(0, self._active - 1)


class RelayState:
    def __init__(self, cfg, cfg_path):
        self.cfg = cfg
        self.cfg_path = cfg_path
        self.analytics = Analytics(config_dir() / "data" / "reach.db")
        self.limiter = RateLimiter()
        self.cache = ResponseCache()
        self.gate = CounterGate()
        self.latencies = collections.deque(maxlen=LATENCY_SAMPLE_LIMIT)
        self.speeds = collections.deque(maxlen=LATENCY_SAMPLE_LIMIT)
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
        interval = int(self.cfg.get("health_check_interval_s", 60))
        with self._lock:
            now = time.time()
            if self.upstream_checked and now - self.upstream_checked < interval:
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
        threshold = int(self.cfg.get("circuit_threshold", 5))
        cooldown = int(self.cfg.get("circuit_cooldown_s", 30))
        with self._lock:
            self.consecutive_failures += 1
            if self.consecutive_failures >= threshold:
                self.circuit_open_until = time.time() + cooldown
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

    def public_models(self):
        return {alias: spec["upstream"] for alias, spec
                in self.cfg.get("models", {}).items()
                if spec.get("enabled") and spec.get("public", True)}

    def p95_latency_ms(self):
        with self._lock:
            if not self.latencies:
                return 0.0
            ordered = sorted(self.latencies)
            return round(ordered[int(len(ordered) * 0.95) - 1], 1)

    def note_speed(self, tps):
        if tps and tps > 0:
            with self._lock:
                self.speeds.append(float(tps))

    def current_speed(self):
        with self._lock:
            if not self.speeds:
                return 0.0
            return round(sum(self.speeds) / len(self.speeds), 1)

    def snapshot(self):
        with self._lock:
            stats = self.analytics.stats()
            today = stats.get("today", {})
            speed = self.current_speed() or today.get("tokens_per_sec", 0.0)
            today["tokens_per_sec"] = speed
            today["live_tps"] = speed
            return {
                "service": SERVICE,
                "version": VERSION,
                "ok": True,
                "port": PORT,
                "upstream": self.omniroute_url,
                "upstream_ok": self.upstream_alive(),
                "circuit_open": self.circuit_open(),
                "models": list(self.public_models()),
                "model_count": len(self.cfg.get("models", {})),
                "public_url": self.public_url,
                "public_url_source": self.public_url_source,
                "uptime_s": round(time.time() - self.started_at, 1),
                "p95_latency_ms": self.p95_latency_ms(),
                "tokens_per_sec": speed,
                "today": today,
                "cache": self.cache.snapshot(),
                "rate_limits": {
                    "enabled": bool(self.cfg.get("rate_limits", {})
                                   .get("enabled")),
                },
                "access_required": bool(self.cfg.get("access", {})
                                       .get("key_required")),
                "config_error": self.cfg.get("_last_config_error"),
            }

    def log_rotation(self, log_path):
        try:
            limit_mb = int(self.cfg.get("system", {}).get("log_rotation_mb", 2))
            if log_path.is_file() and log_path.stat().st_size > limit_mb * 1024 * 1024:
                os.replace(str(log_path), str(log_path) + ".1")
        except OSError:
            pass


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
