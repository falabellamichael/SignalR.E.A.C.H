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
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

from reachd.const import (
    DEFAULT_PORT,
    VERSION,
)
from reachd.handler import RelayHandler
from reachd.publish import publish_url
from reachd.settings import (
    config_dir,
    load_config,
)
from reachd.state import RelayState

STATE = None          # RelayState, set in main()
PORT = DEFAULT_PORT

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
