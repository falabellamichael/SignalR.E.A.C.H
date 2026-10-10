"""Settings validation shared by the public facade and config repair."""

import ipaddress
import time

from reachd import hostid
from reachd.settings_schema import (
    ALIAS_PATTERN,
    CACHE_FIELDS,
    MODEL_NUMERIC,
    MODEL_SPEC_DEFAULTS,
    NUMERIC_FIELDS,
    RATE_LIMIT_FIELDS,
    REQUEST_NUMERIC,
    UPSTREAM_PATTERN,
)


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


def validate_settings(cfg, *, defaults, require_local_url, validate_model_spec):
    """Validate a FULL settings dict; raises SettingsError on the first issue."""
    allowed = set(defaults)
    unknown = sorted(set(cfg) - allowed - {k for k in cfg if str(k).startswith("_")})
    _expect(not unknown, "unknown settings key(s): " + ", ".join(unknown))
    require_local_url(cfg.get("omniroute_url", ""), "omniroute_url")
    require_local_url(cfg.get("bridge_url", defaults["bridge_url"]),
                       "bridge_url")
    account_service_url = cfg.get("account_service_url", "")
    _str(account_service_url, "account_service_url", 0, 500)
    if account_service_url:
        from reachd.account_proxy import account_service_target
        try:
            _scheme, _host, account_port = account_service_target(account_service_url)
            _expect(account_port != cfg.get("port", defaults["port"]),
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
        _int(cfg.get(field, defaults[field]), lo, hi, field)
    override = cfg.get("public_url_override")
    _expect(override is None or (isinstance(override, str)
                                 and override.startswith("https://")),
            "public_url_override must be null or an https URL")

    # request
    _section_keys(cfg, "request", set(defaults["request"]), "request")
    req = cfg["request"]
    for key in ("default_model", "inject_system_prompt"):
        _str(req.get(key, ""), "request." + key, 0, 8000)
    _bool(req.get("default_stream", False), "request.default_stream")
    for field, (lo, hi) in REQUEST_NUMERIC.items():
        _int(req.get(field, defaults["request"][field]), lo, hi,
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
            validate_model_spec(alias, spec, aliases, errors)
        except SettingsError as exc:
            errors.append(str(exc))
    _expect(not errors, "; ".join(errors))

    # rate limits
    _section_keys(cfg, "rate_limits", set(defaults["rate_limits"]),
                  "rate_limits")
    rl = cfg["rate_limits"]
    _bool(rl.get("enabled", True), "rate_limits.enabled")
    for field, (lo, hi) in RATE_LIMIT_FIELDS.items():
        _int(rl.get(field, defaults["rate_limits"][field]), lo, hi,
             "rate_limits." + field)

    # access
    _section_keys(cfg, "access", set(defaults["access"]), "access")
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
        _int(k.get("rate_limit_rpm", 0), 0, 100000, "access.keys rate_limit_rpm")
        _int(k.get("tokens_day", 0), 0, 1000000000, "access.keys tokens_day")
        expires = k.get("expires_at", None)
        _expect(expires is None or isinstance(expires, str),
                "access.keys expires_at must be an ISO-8601 string or null")
        if isinstance(expires, str) and expires.strip():
            try:
                time.strptime(expires.strip(), "%Y-%m-%dT%H:%M:%SZ")
            except ValueError:
                raise SettingsError(
                    "access.keys expires_at must look like 2026-12-31T23:59:59Z")
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
    _str(access.get("cors_origins", ""), "access.cors_origins", 0, 2000)
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
    _section_keys(cfg, "cache", set(defaults["cache"]), "cache")
    cache = cfg["cache"]
    _bool(cache.get("enabled", False), "cache.enabled")
    for field, (lo, hi) in CACHE_FIELDS.items():
        _int(cache.get(field, defaults["cache"][field]), lo, hi,
             "cache." + field)
    _bool(cache.get("match_temperature", True), "cache.match_temperature")

    # data
    _section_keys(cfg, "data", set(defaults["data"]), "data")
    data = cfg["data"]
    _int(data.get("log_retention_days", 7), 1, 365,
         "data.log_retention_days")
    _expect(data.get("log_level") in ("none", "errors", "normal", "verbose"),
            "data.log_level must be none, errors, normal or verbose")
    _bool(data.get("log_bodies", False), "data.log_bodies")

    # publish + system
    _section_keys(cfg, "publish", set(defaults["publish"]), "publish")
    _bool(cfg["publish"].get("enabled", True), "publish.enabled")
    _int(cfg["publish"].get("interval_min", 0), 0, 1440,
         "publish.interval_min")
    _section_keys(cfg, "system", set(defaults["system"]), "system")
    _bool(cfg["system"].get("allow_remote_admin", False),
          "system.allow_remote_admin")
    _int(cfg["system"].get("log_rotation_mb", 2), 1, 100,
         "system.log_rotation_mb")
    _str(cfg["system"].get("admin_token", ""), "system.admin_token", 0, 128)
    _int(cfg["system"].get("security_revision", 0), 0, 1000,
         "system.security_revision")
    _bool(cfg["system"].get("host_bind", True), "system.host_bind")
    salt = cfg["system"].get("host_salt", "")
    _str(salt, "system.host_salt", 0, 64)
    if salt:
        # hostid._derive_key() feeds the salt to bytes.fromhex(); a non-hex
        # value would not fail here but crash inside hostid.seal on save.
        try:
            bytes.fromhex(salt)
        except ValueError:
            raise SettingsError("system.host_salt must be hex")
    _str(cfg["system"].get("host_machine_hint", ""),
         "system.host_machine_hint", 0, 200)
