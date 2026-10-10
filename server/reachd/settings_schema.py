"""Static settings schema, default model aliases, and numeric limits."""

import re

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
    "client_timeout_s": 30,         # idle/stalled client socket is dropped (restart to apply)
    "max_connections": 64,          # open client connections / threads (restart to apply)
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
        # Gemini's consumer web UI is driven by the local tray. Keep this
        # route dormant until that dedicated browser session is signed in and
        # verified, then enable/public it in the saved relay settings.
        "gemini-chat": {
            **MODEL_SPEC_DEFAULTS,
            "upstream": "bridge/gemini-chat",
            "enabled": False,
            "public": False,
            "description": "Experimental Gemini web UI via local tray (sign in before enabling)",
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
        # client API keys: {"id", "name", "key", "created_at", "last_used_at",
        # "enabled", "rate_limit_rpm", "tokens_day", "expires_at"}.
        # rate_limit_rpm / tokens_day are per-key caps (0 = no cap of its own,
        # the shared rate_limits still apply); expires_at is an ISO-8601 UTC
        # instant or None for a key that never expires.
        "keys": [],
        "ip_allowlist": [],            # empty = everyone (loopback always ok)
        "ip_blocklist": [],
        "cors_origins": "",            # empty = local tools only (loopback pages, null, vscode-webview); "*" or a comma-separated list opts others in
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
    "client_timeout_s": (5, 600),
    "max_connections": (4, 1024),
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
