"""Settings schema, defaults, validation and config persistence."""

import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit
from reachd import hostid

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
    "min_output_tokens": 0,         # floor for upstream max_tokens (reasoning models need headroom)
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

# Bump when load_config() gains another one-time security migration.
SECURITY_REVISION = 1

DEFAULT_SETTINGS = {
    # ---- relay core / upstream ----
    "omniroute_url": "http://127.0.0.1:20128/v1",
    "omniroute_key": "",
    # Local tray bridge. Serves the CodeGPT economy models through the host's
    # own signed-in CodeGPT session — the only place CodeGPT's unlimited tier
    # exists (its public API binds agents to legacy, credit-metered models
    # only). An alias whose upstream starts with "bridge/" is sent here instead
    # of OmniRoute and never carries the OmniRoute bearer token.
    "bridge_url": "http://127.0.0.1:21302/v1",
    "account_service_url": "",  # optional hosted accounts service, literal loopback origin
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
        # NOTE: there is deliberately no `chatgpt-chat` alias here. That id is a
        # TRAY BRIDGE model, served by the Electron tray on 127.0.0.1:21302 —
        # not by OmniRoute. Routing it through the relay made /v1/models
        # advertise a model the relay could never serve (the "copilot/" prefix
        # is not an OmniRoute provider), so every call to it failed. Clients
        # that want it must select the ChatGPT provider and talk to the bridge
        # directly. Add one here by hand only against a real OmniRoute upstream.
        "gemini-2.5-flash": {
            **MODEL_SPEC_DEFAULTS,
            "upstream": "codegpt/codegpt-gemini-2.5-flash",
            "description": "Google Gemini 2.5 Flash (CodeGPT free tier)",
            "min_output_tokens": 1024,
        },
        "gemini-3.7-flash": {
            **MODEL_SPEC_DEFAULTS,
            "upstream": "gemini/gemini-3.7-flash",
            "description": "Google Gemini 3.7 Flash (via OmniRoute)",
            "min_output_tokens": 1024,
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
        # False only in the raw schema default, because a config with no keys
        # cannot validate as "required". load_config() turns it on for every new
        # install and migrates old ones (system.security_revision).
        "key_required": False,
        "access_key": "",
        "keys": [],                    # client API keys: list of {"id", "name", "key", "created_at", "last_used_at", "enabled", "rate_limit_rpm"}
        "ip_allowlist": [],            # empty = everyone (loopback always ok)
        "ip_blocklist": [],
        "cors_origins": "*",           # "*" or comma-separated origins
        # A genuine same-machine client (loopback, no proxy headers, loopback
        # Host, no foreign Origin) may skip the key. Turn off to make even the
        # owner's local tools present one.
        "local_bypass": True,
        # Peers whose X-Forwarded-For / Cf-Connecting-Ip is believed. Loopback
        # (the local tunnel process) is always trusted; add a reverse proxy's
        # address here. Anyone else's forwarding headers are ignored, so they
        # cannot forge a client IP to dodge the allow/block lists.
        "trusted_proxies": [],
        # Failed key / admin-token attempts per client IP before it is locked
        # out for auth_lockout_s seconds. 0 disables the lockout.
        "auth_fail_limit": 8,
        "auth_lockout_s": 300,
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
        # Bumped when load_config() applies a one-time security migration, so
        # each migration runs once per install and never fights a later choice.
        "security_revision": 0,
        "log_rotation_mb": 2,
        # Per-install secret for the admin API. Minted on first load; a
        # non-local /_reach/* request must present it as X-Reach-Admin.
        "admin_token": "",
        # Host binding: seal host secrets against THIS machine. "host_salt"
        # is a per-install random value minted on first load; it is what makes
        # the derived key unique per install rather than per machine.
        "host_bind": True,
        "host_salt": "",
        # Non-secret "who owns this install" marker the tray compares against.
        "host_machine_hint": "",
    },
}

# ----------------------------------------------------------------------
# CodeGPT economy models
# ----------------------------------------------------------------------
# The unlimited tier of the host's CodeGPT plan, mirroring the LIVE credits menu
# CodeGPT itself serves (each entry with `pro: false`; see
# copilot/tray/economy-models.js, which discovers that menu from the CodeGPT
# sidecar and owns the matching bridge ids). These are served by the local tray
# bridge because CodeGPT's public API refuses to bind these models: create and
# patch both reject anything outside a legacy, credit-metered enum.
CODEGPT_ECONOMY_MODELS = [
    ("deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
    ("ox-alpha", "GLM 5.3 Flash"),
    ("gemini-3.8-flash", "Gemini 3.8 Flash"),
    ("gpt-5.6-luna", "GPT 5.6 Luna"),
    ("glm-5.2", "GLM 5.2"),
    ("MiniMax-M3", "MiniMax M3"),
]

DEFAULT_SETTINGS["models"].update({
    alias: {
        **MODEL_SPEC_DEFAULTS,
        "upstream": "bridge/codegpt-eco-" + alias,
        "description": label + " — CodeGPT economy (unlimited on the host's plan)",
    }
    for alias, label in CODEGPT_ECONOMY_MODELS
    # Only fill in aliases that are not already routed. `gemini-3.7-flash` is
    # defined above against OmniRoute, and silently re-pointing an existing
    # alias at the bridge would change behaviour for everyone who uses it.
    # The bridge still serves that model's economy variant, addressable as
    # `codegpt-eco-gemini-3.7-flash` if you add an alias for it by hand.
    if alias not in DEFAULT_SETTINGS["models"]
})

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


def _host_is_local(host):
    """True if host is loopback/localhost or resolves only to loopback or
    RFC1918-private addresses. Used to keep the relay from carrying the
    OmniRoute bearer token to a public server (SSRF/credential exfil)."""
    if not host:
        return False
    host = host.strip("[]")  # bracketed IPv6 literal
    if host.lower() == "localhost":
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError, OSError):
        # Unresolvable host: treat a bare IP literal directly, else reject.
        try:
            infos = [(None, None, None, None, (host, 0))]
        except Exception:
            return False
    addrs = []
    for info in infos:
        sockaddr = info[4]
        try:
            addrs.append(ipaddress.ip_address(sockaddr[0]))
        except ValueError:
            return False
    if not addrs:
        return False
    return all(a.is_loopback or a.is_private for a in addrs)


def _require_local_url(value, name):
    """Require an http(s) URL whose host is loopback or private (never public,
    link-local, or reserved). Raises SettingsError otherwise."""
    _str(value, name, 8, 500)
    parts = urlsplit(value)
    _expect(parts.scheme in ("http", "https"), name + " must be http(s)")
    _expect(bool(parts.hostname), name + " must include a host")
    _expect(_host_is_local(parts.hostname),
            name + " host must be loopback or a private address")


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
    _int(spec.get("min_output_tokens", 0), 0, 1000000,
         path + ".min_output_tokens")
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


# ----------------------------------------------------------------------
# Client API keys + OmniRoute key discovery
# ----------------------------------------------------------------------

def find_omniroute_key():
    """Auto-detect the OmniRoute API key from local storage on the fly."""
    db = Path.home() / ".omniroute" / "storage.sqlite"
    if not db.is_file():
        return None
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
        rows = conn.execute(
            "SELECT name, key FROM api_keys "
            "WHERE revoked_at IS NULL AND is_active = 1").fetchall()
        conn.close()
    except sqlite3.Error:
        return None
    preferred = [k for name, k in rows if name == "SimpleRAG"]
    if preferred:
        return preferred[0]
    return rows[0][1] if rows else None


def mask_key(key):
    """Mask key for safe display in logs and UI (prefix only — no secret chars)."""
    if not key or not isinstance(key, str):
        return "(none)"
    if len(key) <= 12:
        return "set (short)"
    if key.startswith("sk-reach-"):
        return "sk-reach-…"
    return key[:8] + "…" + key[-4:]


def key_preview(key):
    """Tight display preview: no secret characters leak."""
    if not key or not isinstance(key, str):
        return "—"
    if key.startswith("sk-reach-"):
        return "sk-reach-…"
    return key[:2] + "…" if len(key) > 4 else "…"


def generate_client_key(name="Default"):
    """Generate a clean, secure sk-reach-... API key for external clients."""
    token = "sk-reach-" + secrets.token_hex(16)
    key_id = "key_" + secrets.token_hex(4)
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "id": key_id,
        "name": (name or "Key").strip(),
        "key": token,
        "created_at": now_iso,
        "last_used_at": None,
        "enabled": True,
        "rate_limit_rpm": 0,
    }


def generate_admin_token():
    """Per-install admin-API secret. 192 bits, mirrors generate_client_key."""
    return "rt-" + secrets.token_hex(24)


def public_key_view(k):
    """Redacted copy of a client-key record: never carries the raw token.
    Single masking path shared by settings_public and the /_reach/keys routes."""
    raw = k.get("key", "")
    view = dict(k)
    view["masked_key"] = mask_key(raw)
    view["preview"] = key_preview(raw)
    view["key"] = view["masked_key"]
    return view


def restore_masked_client_keys(existing_access, access_patch):
    """When a settings patch carries access.keys whose entries hold masked
    or empty token strings (the panel round-trips the public view),
    restore the raw tokens from the live config by key id. Returns True
    if it touched the patch."""
    if not isinstance(access_patch, dict):
        return False
    if "keys" not in access_patch or not isinstance(access_patch["keys"], list):
        return False
    existing_by_id = {k.get("id"): k.get("key")
                      for k in (existing_access or {}).get("keys", [])}
    touched = False
    for k in access_patch["keys"]:
        if isinstance(k, dict) and k.get("id") in existing_by_id:
            raw_val = k.get("key", "")
            if not raw_val or raw_val.startswith("set (") or "…" in raw_val:
                k["key"] = existing_by_id[k["id"]]
                touched = True
    return touched


def validate_settings(cfg):
    """Validate a FULL settings dict; raises SettingsError on the first issue."""
    allowed = set(DEFAULT_SETTINGS)
    unknown = sorted(set(cfg) - allowed - {k for k in cfg if str(k).startswith("_")})
    _expect(not unknown, "unknown settings key(s): " + ", ".join(unknown))
    _require_local_url(cfg.get("omniroute_url", ""), "omniroute_url")
    _require_local_url(cfg.get("bridge_url", DEFAULT_SETTINGS["bridge_url"]),
                       "bridge_url")
    account_service_url = cfg.get("account_service_url", "")
    _str(account_service_url, "account_service_url", 0, 500)
    if account_service_url:
        from reachd.account_proxy import account_service_target
        try:
            _scheme, _host, account_port = account_service_target(account_service_url)
            _expect(account_port != cfg.get("port", DEFAULT_SETTINGS["port"]),
                    "account_service_url must use a different port than the relay")
        except ValueError as exc:
            raise SettingsError(str(exc)) from exc
    # A sealed value is a dict envelope, so accept either shape: validation
    # may see plaintext (in memory) or ciphertext (straight off disk).
    _omniroute_key = cfg.get("omniroute_key", "")
    if not hostid.is_sealed(_omniroute_key):
        _str(_omniroute_key, "omniroute_key", 0, 500)
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
    keys_list = access.get("keys", [])
    _expect(isinstance(keys_list, list) and len(keys_list) <= 100,
            "access.keys must be a list of at most 100 keys")
    for k in keys_list:
        _expect(isinstance(k, dict), "access.keys entries must be objects")
        key_value = k.get("key")
        # An empty key means "this entry's secret could not be recovered" (a
        # host mismatch blanked it). It is kept as a visible placeholder so the
        # operator can see and re-issue it, rather than silently vanishing.
        _expect(key_value == "" or (isinstance(key_value, str)
                                    and len(key_value) >= 6),
                "access.keys key must be empty or at least 6 chars")
        _expect(isinstance(k.get("name", "Key"), str), "access.keys name must be string")
    if access.get("key_required"):
        has_key = len(access.get("access_key", "") or "") >= 6 \
            or any(k.get("enabled", True) and k.get("key")
                   for k in keys_list)
        _expect(has_key,
                "access_key or at least one active client key required when key_required is on")
    for key in ("ip_allowlist", "ip_blocklist"):
        value = access.get(key, [])
        _expect(isinstance(value, list) and len(value) <= 256,
                "access.%s must be a list of at most 256 IPs" % key)
        for item in value:
            _expect(isinstance(item, str) and 1 <= len(item) <= 64,
                    "access.%s entries must be strings" % key)
    _str(access.get("cors_origins", "*"), "access.cors_origins", 1, 2000)
    _bool(access.get("local_bypass", True), "access.local_bypass")
    _int(access.get("auth_fail_limit", 8), 0, 1000, "access.auth_fail_limit")
    _int(access.get("auth_lockout_s", 300), 1, 86400, "access.auth_lockout_s")
    proxies = access.get("trusted_proxies", [])
    _expect(isinstance(proxies, list) and len(proxies) <= 64,
            "access.trusted_proxies must be a list of at most 64 addresses")
    for item in proxies:
        _expect(isinstance(item, str) and 1 <= len(item) <= 64,
                "access.trusted_proxies entries must be strings")
        try:
            ipaddress.ip_network(item.strip(), strict=False)
        except ValueError:
            raise SettingsError(
                "access.trusted_proxies entry %r is not an IP address or CIDR" % item)

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
    _str(cfg["system"].get("admin_token", ""), "system.admin_token", 0, 128)
    _int(cfg["system"].get("security_revision", 0), 0, 1000,
         "system.security_revision")
    _bool(cfg["system"].get("host_bind", True), "system.host_bind")
    _str(cfg["system"].get("host_salt", ""), "system.host_salt", 0, 64)
    _str(cfg["system"].get("host_machine_hint", ""),
         "system.host_machine_hint", 0, 200)


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
            removed = list(result.get("_removed_models") or [])
            for alias, spec in value.items():
                if spec is None:
                    result["models"].pop(alias, None)
                    # Remember the removal, or the default alias would be
                    # merged straight back in on the next load.
                    if alias not in removed:
                        removed.append(alias)
                elif isinstance(spec, dict):
                    existing = result["models"].get(alias, {})
                    if not isinstance(existing, dict):
                        existing = dict(MODEL_SPEC_DEFAULTS)
                    result["models"][alias] = {**MODEL_SPEC_DEFAULTS,
                                               **existing, **spec}
                    if alias in removed:
                        removed.remove(alias)
                else:
                    result["models"][alias] = spec
            if removed:
                result["_removed_models"] = removed
            continue
        if isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = {**result[key], **value}
        else:
            result[key] = value
    return result


def settings_public(cfg):
    """Settings for display: never leak upstream/access keys."""
    shown = json.loads(json.dumps(cfg))
    upstream = shown.get("omniroute_key")
    if isinstance(upstream, str) and upstream:
        shown["omniroute_key"] = "set (" + upstream[:6] + "…)"
    elif hostid.is_sealed(upstream):
        shown["omniroute_key"] = "set (sealed to this host)"
    system = shown.setdefault("system", {})
    if system.get("admin_token"):
        system["admin_token"] = "set"
    if system.get("host_salt"):
        system["host_salt"] = "set"
    access = shown.get("access") or {}
    legacy = access.get("access_key")
    if isinstance(legacy, str) and legacy:
        access["access_key"] = "set (" + legacy[:4] + "…)"
    elif hostid.is_sealed(legacy):
        access["access_key"] = "set (sealed to this host)"
    if access.get("keys"):
        access["keys"] = [public_key_view(k) for k in access["keys"]]
    return shown


# ----------------------------------------------------------------------
# Paths + config I/O
# ----------------------------------------------------------------------

def config_dir():
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    new_dir = base / "SignalREACH"
    old_dir = base / "SimpleREACH"
    legacy_appdata = Path.home() / "AppData" / "Local" / "SignalREACH"
    if not new_dir.exists() and legacy_appdata.exists():
        try:
            shutil.copytree(legacy_appdata, new_dir)
        except Exception:
            pass
    if not new_dir.exists() and old_dir.exists():
        try:
            shutil.copytree(old_dir, new_dir)
        except Exception:
            pass
    return new_dir


def _host_secret_material(cfg, path):
    """The host-bound material that seals/unseals this install's secrets.

    Returns ``None`` when host binding is off/unavailable, in which case
    secrets are stored as plaintext (the pre-existing behaviour) so an
    install never bricks itself just because a fingerprint could not be read.
    """
    system = cfg.get("system") or {}
    if not system.get("host_bind", True):
        return None
    salt = system.get("host_salt")
    if not salt:
        return None
    machine = hostid.raw_machine_id()
    if not machine:
        return None
    return machine + "\x00" + salt
# Secrets that belong to the host and must never sit in plaintext on disk.
_SEALED_FIELDS = ("omniroute_key",)


def _seal_config(cfg, material):
    """Encrypt host secrets in a config copy. Returns the copy to persist."""
    if not material:
        return cfg
    salt = (cfg.get("system") or {}).get("host_salt")
    out = json.loads(json.dumps(cfg))
    for field in _SEALED_FIELDS:
        value = out.get(field)
        if isinstance(value, str) and value and not hostid.is_sealed(value):
            out[field] = hostid.seal(value, material, salt)
    system = out.setdefault("system", {})
    token = system.get("admin_token")
    if isinstance(token, str) and token and not hostid.is_sealed(token):
        system["admin_token"] = hostid.seal(token, material, salt)
    access = out.setdefault("access", {})
    legacy = access.get("access_key")
    if isinstance(legacy, str) and legacy and not hostid.is_sealed(legacy):
        access["access_key"] = hostid.seal(legacy, material, salt)
    keys = access.get("keys")
    if isinstance(keys, list):
        for entry in keys:
            if not isinstance(entry, dict):
                continue
            raw = entry.get("key")
            if isinstance(raw, str) and raw and not hostid.is_sealed(raw):
                entry["key"] = hostid.seal(raw, material, salt)
    return out

def _unseal_config(cfg, material, path):
    """Decrypt host secrets in place. Returns ``(cfg, error_or_None)``.

    A sealed value that will not open means this config was copied from
    another host (or was tampered with). That is a hard stop for the secrets,
    but NOT for the whole config: we blank them and report, so the panel still
    loads and the operator sees a clear message instead of a dead relay.
    """
    if not material:
        return cfg, None
    def _open(value):
        if hostid.is_sealed(value):
            return hostid.open_sealed(value, material)
        return value
    try:
        for field in _SEALED_FIELDS:
            if field in cfg:
                cfg[field] = _open(cfg[field])
        system = cfg.setdefault("system", {})
        if "admin_token" in system:
            system["admin_token"] = _open(system["admin_token"])
        access = cfg.setdefault("access", {})
        if "access_key" in access:
            access["access_key"] = _open(access["access_key"])
        keys = access.get("keys")
        if isinstance(keys, list):
            for entry in keys:
                if isinstance(entry, dict) and "key" in entry:
                    entry["key"] = _open(entry["key"])
    except hostid.HostIdentityError as exc:
        # Copied to another host (or tampered with). Blank the unopenable
        # secrets so nothing downstream can accidentally use ciphertext as a
        # key, and leave the config loadable so the operator sees the reason.
        for field in _SEALED_FIELDS:
            cfg[field] = ""
        system = cfg.setdefault("system", {})
        system["admin_token"] = ""
        access = cfg.setdefault("access", {})
        access["access_key"] = ""
        keys = access.get("keys")
        if isinstance(keys, list):
            for entry in keys:
                if isinstance(entry, dict) and hostid.is_sealed(entry.get("key")):
                    entry["key"] = ""
        return cfg, str(exc)
    return cfg, None

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
            saved_models = {
                alias: {**MODEL_SPEC_DEFAULTS,
                        **(spec if isinstance(spec, dict) else {})}
                for alias, spec in raw_models.items()
            }
            # Default aliases are ADDITIVE: a saved config predates any alias
            # added since it was written, and letting the saved list replace the
            # defaults wholesale would hide new models (the CodeGPT economy
            # set) from every existing install. A saved alias still wins, and an
            # alias the user deleted stays deleted via _removed_models.
            removed_models = {alias for alias in (raw.get("_removed_models") or [])
                              if isinstance(alias, str)}
            cfg["models"] = {
                alias: spec
                for alias, spec in DEFAULT_SETTINGS["models"].items()
                if alias not in saved_models and alias not in removed_models
            }
            cfg["models"].update(saved_models)
            if not cfg["models"]:
                cfg["models"] = dict(DEFAULT_SETTINGS["models"])

            access = cfg.setdefault("access", {})
            keys = list(access.get("keys") or [])
            dirty = False
            if not keys:
                legacy_key = access.get("access_key")
                if legacy_key and len(legacy_key) >= 6:
                    keys.append({
                        "id": "key_legacy",
                        "name": "Legacy Key",
                        "key": legacy_key,
                        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "last_used_at": None,
                        "enabled": True,
                        "rate_limit_rpm": 0,
                    })
                else:
                    def_k = generate_client_key("Default")
                    keys.append(def_k)
                    if not access.get("access_key"):
                        access["access_key"] = def_k["key"]
                access["keys"] = keys
                dirty = True

            if not cfg.get("omniroute_key"):
                detected = find_omniroute_key()
                if detected:
                    cfg["omniroute_key"] = detected
                    dirty = True

            if not cfg.setdefault("system", {}).get("admin_token"):
                cfg["system"]["admin_token"] = generate_admin_token()
                dirty = True
            # Security migration 1: installs from before keys were enforced
            # served anyone who found the tunnel URL. Every install already has
            # a minted key by this point, so requiring one locks out strangers
            # without locking out the owner. Runs once; the operator can turn it
            # back off afterwards and it will stay off.
            if int(cfg["system"].get("security_revision") or 0) < SECURITY_REVISION:
                access["key_required"] = True
                cfg["system"]["security_revision"] = SECURITY_REVISION
                dirty = True
            # Host binding: mint the per-install salt once. Every host secret
            # is sealed against (machine id + this salt), so the salt is what
            # makes two installs on the same machine independent.
            system = cfg.setdefault("system", {})
            if system.get("host_bind", True) and not system.get("host_salt"):
                system["host_salt"] = hostid.new_salt()
                dirty = True
            # A non-secret marker the tray can compare against, so the tray and
            # relay agree on which machine this install belongs to without
            # duplicating the fingerprint logic in JavaScript.
            if system.get("host_bind", True):
                hint = hostid.machine_hint()
                if hint and system.get("host_machine_hint") != hint:
                    system["host_machine_hint"] = hint
                    dirty = True

            if dirty:
                try:
                    save_config(cfg, path)
                except Exception:
                    pass

            # Unseal BEFORE validating: validators expect plain strings, and a
            # config read straight off disk carries dict envelopes for its
            # secrets. Unsealing first keeps every validator untouched.
            cfg, unseal_error = _unseal_config(
                cfg, _host_secret_material(cfg, path), path)
            # Surface a host mismatch even if the blanked secrets then fail
            # validation: the mismatch is the real cause and the operator needs
            # to see it, not a downstream "key must be at least 6 chars".
            if unseal_error:
                cfg["_host_error"] = unseal_error
            try:
                validate_settings(cfg)
                return cfg
            except SettingsError as exc:
                print("config warning: %s — using defaults where possible" % exc)
                cfg["_last_config_error"] = str(exc)
                return cfg
    init_cfg = json.loads(json.dumps(DEFAULT_SETTINGS))
    def_k = generate_client_key("Default")
    init_cfg["access"]["keys"] = [def_k]
    init_cfg["access"]["access_key"] = def_k["key"]
    init_cfg["access"]["key_required"] = True
    init_cfg["system"]["security_revision"] = SECURITY_REVISION
    init_cfg["system"]["admin_token"] = generate_admin_token()
    # Mint the host-binding salt here too: a brand-new install must seal its
    # secrets on the FIRST save, not only after an existing config is touched.
    if init_cfg["system"].get("host_bind", True):
        init_cfg["system"]["host_salt"] = hostid.new_salt()
        hint = hostid.machine_hint()
        if hint:
            init_cfg["system"]["host_machine_hint"] = hint
    detected = find_omniroute_key()
    if detected:
        init_cfg["omniroute_key"] = detected
    return init_cfg


def save_config(cfg, cfg_path):
    cfg_dir = cfg_path.parent
    cfg_dir.mkdir(parents=True, exist_ok=True)
    # Validate the UNSEALED view. A caller may hand us a config straight off
    # disk (rekey does exactly this), where secrets are dict envelopes that
    # the string validators would reject even though the values are fine.
    material = _host_secret_material(cfg, cfg_path)
    if material:
        check, _err = _unseal_config(json.loads(json.dumps(cfg)), material, cfg_path)
    else:
        check = cfg
    validate_settings(check)
    tmp = cfg_path.with_suffix(".tmp")
    # Seal host secrets on the way out. A copied config.json is then useless
    # on any other machine: the ciphertext only opens on this host.
    persist = _seal_config(cfg, material) if material else cfg
    tmp.write_text(json.dumps(persist, indent=2), encoding="utf-8")
    os.replace(str(tmp), str(cfg_path))
    try:
        os.chmod(cfg_path, 0o600)
    except OSError:
        pass
