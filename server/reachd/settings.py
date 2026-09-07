"""Settings schema, defaults, validation and config persistence."""

import json
import os
import re
from pathlib import Path

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
# Paths + config I/O
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
