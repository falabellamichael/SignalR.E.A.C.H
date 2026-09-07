#!/usr/bin/env python3
"""SignalR.E.A.C.H relay v3 — OpenAI-compatible endpoint backed by OmniRoute's codegpt.

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


from reachd.const import (
    DEFAULT_PORT,
)

STATE = None          # RelayState, set in main()
PORT = DEFAULT_PORT
