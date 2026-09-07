"""SimpleREACH relay daemon — package (v3.2.0).

The daemon runs from ``server/reachd.py`` (a thin launcher shim); all
implementation lives in this package. ``reachd.core`` currently holds the
monolith body and is being split module-by-module across the commits of
this refactor.

``import reachd`` keeps exposing the public surface the test suite and
external importers rely on (``reachd.RelayHandler``, ``reachd.DEFAULT_SETTINGS``,
``reachd.validate_settings``, ...), re-exported below.

Note: ``STATE`` and ``PORT`` are intentionally NOT re-exported — they are
live globals owned by ``reachd.core`` and are only meaningful once
``main()`` has run.
"""

from reachd.settings import MODEL_SPEC_DEFAULTS

from reachd.core import (
    DEFAULT_PORT,
    DEFAULT_SETTINGS,
    GIST_FILE,
    GIST_ID,
    LATENCY_SAMPLE_LIMIT,
    MAX_BODY_BYTES,
    MAX_RATE_BUCKETS,
    SERVICE,
    VERSION,
    Analytics,
    CounterGate,
    RateLimiter,
    RelayHandler,
    RelayState,
    ResponseCache,
    SettingsError,
    count_tokens,
    load_config,
    main,
    merged_settings,
    publish_url,
    save_config,
    scrub_trailing_roles,
    settings_public,
    validate_settings,
)

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
