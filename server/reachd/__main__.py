"""The daemon entry point: config load, server bind, threads."""

import argparse
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

import reachd.core as core  # owns the live STATE / PORT globals
from reachd.const import DEFAULT_PORT, VERSION
from reachd.handler import RelayHandler
from reachd.publish import publish_url
from reachd.settings import config_dir, load_config
from reachd.state import RelayState


def main():
    parser = argparse.ArgumentParser(description="SignalR.E.A.C.H relay server")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--config-dir", default=None)
    args = parser.parse_args()

    base = Path(args.config_dir) if args.config_dir else config_dir()
    cfg_path = base / "config.json"
    cfg = load_config(cfg_path)
    core.STATE = RelayState(cfg, cfg_path)
    core.PORT = args.port or int(cfg.get("port", DEFAULT_PORT))
    host = cfg.get("host", "127.0.0.1")

    try:
        httpd = ThreadingHTTPServer((host, core.PORT), RelayHandler)
    except OSError as exc:
        print("SignalR.E.A.C.H: cannot bind %s:%d — %s" % (host, core.PORT, exc),
              file=sys.stderr)
        sys.exit(1)

    core.STATE.poll_public_url()
    core.STATE.analytics.prune(int(cfg.get("data", {}).get("log_retention_days", 7)))

    def poller():
        while True:
            time.sleep(20)
            core.STATE.poll_public_url()

    def pruner():
        while True:
            time.sleep(3600)
            core.STATE.analytics.prune(
                int(core.STATE.cfg.get("data", {}).get("log_retention_days", 7)))

    def publisher():
        interval = int(core.STATE.cfg.get("publish", {}).get("interval_min", 0)
                       or 0)
        if interval <= 0:
            return  # publishing happens on change only
        while True:
            time.sleep(interval * 60)
            if core.STATE.public_url:
                try:
                    publish_url(core.STATE)
                except Exception:
                    pass

    threading.Thread(target=poller, daemon=True).start()
    threading.Thread(target=pruner, daemon=True).start()
    threading.Thread(target=publisher, daemon=True).start()
    print("SignalR.E.A.C.H %s listening on http://%s:%d" % (VERSION, host, core.PORT),
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
