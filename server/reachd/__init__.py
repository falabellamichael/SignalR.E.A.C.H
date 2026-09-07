# x-release-please-start-version
"""SignalR.E.A.C.H relay daemon — package (v3.2.0).

The daemon runs from ``server/reachd.py`` (a thin launcher shim); all
implementation lives in this package. The monolith has been split
module-by-module across the commits of this refactor:

  const     shared module-level constants
  text      role-scrubbing + token counting
  settings  settings schema, validation, config I/O
  analytics SQLite request log + daily token counters
  cache     in-memory LRU response cache
  limits    token-bucket rate limiter + concurrency gate
  state     the live RelayState
  publish   pointer-gist publishing
  chat      the chat request pipeline (transform / relay / finalize)
  core      the HTTP handler + main()

``import reachd`` keeps exposing the public surface the test suite and
external importers rely on (``reachd.RelayHandler``, ``reachd.DEFAULT_SETTINGS``,
``reachd.validate_settings``, ...), re-exported below.

Note: ``STATE`` and ``PORT`` are intentionally NOT re-exported — they are
live globals owned by ``reachd.core`` and are only meaningful once
``main()`` has run.
"""
# x-release-please-end-version

from reachd.__main__ import main
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
from reachd.handler import RelayHandler
from reachd.limits import CounterGate, RateLimiter
from reachd.publish import publish_url
from reachd.settings import (
    DEFAULT_SETTINGS,
    MODEL_SPEC_DEFAULTS,
    SettingsError,
    find_omniroute_key,
    generate_client_key,
    key_preview,
    load_config,
    mask_key,
    merged_settings,
    restore_masked_client_keys,
    save_config,
    settings_public,
    validate_settings,
)
from reachd.state import RelayState
from reachd.text import count_tokens, scrub_trailing_roles

__all__ = [
    "VERSION",
    "SERVICE",
    "DEFAULT_PORT",
    "MAX_BODY_BYTES",
    "LATENCY_SAMPLE_LIMIT",
    "MAX_RATE_BUCKETS",
    "GIST_ID",
    "GIST_FILE",
    "MODEL_SPEC_DEFAULTS",
    "DEFAULT_SETTINGS",
    "SettingsError",
    "validate_settings",
    "merged_settings",
    "settings_public",
    "load_config",
    "save_config",
    "find_omniroute_key",
    "generate_client_key",
    "mask_key",
    "key_preview",
    "restore_masked_client_keys",
    "count_tokens",
    "scrub_trailing_roles",
    "Analytics",
    "ResponseCache",
    "RateLimiter",
    "CounterGate",
    "RelayState",
    "RelayHandler",
    "publish_url",
    "main",
]
