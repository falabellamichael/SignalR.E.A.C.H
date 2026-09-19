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


def _report_access_posture(cfg, host):
    """Say plainly, at startup, who can reach this relay. A relay that is quietly
    open to everyone is the failure this exists to prevent."""
    access = cfg.get("access") or {}
    exposed = host not in ("127.0.0.1", "::1", "localhost") \
        or cfg.get("tunnel", "ngrok") != "none" or cfg.get("public_url_override")
    if access.get("key_required"):
        active = sum(1 for k in access.get("keys") or []
                     if k.get("enabled", True) and k.get("key"))
        print("  access: API key required (%d active key%s)%s"
              % (active, "" if active == 1 else "s",
                 "; local tools bypass" if access.get("local_bypass", True) else ""),
              flush=True)
        if cfg.get("public_url_override") and access.get("local_bypass", True):
            print("  WARNING: public_url_override is set. If a reverse proxy in front of "
                  "this relay does not add X-Forwarded-For, its requests look local and "
                  "skip the key. Set access.local_bypass to false.",
                  file=sys.stderr, flush=True)
    elif exposed:
        print("  WARNING: this relay is reachable from outside but access.key_required "
              "is OFF - anyone with the URL can use it.",
              file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description="SignalR.E.A.C.H relay server")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--config-dir", default=None)
    parser.add_argument(
        "--ignore-host-bind", action="store_true",
        help="start even if this install is bound to a different machine "
             "(diagnostics only)")
    args = parser.parse_args()

    base = Path(args.config_dir) if args.config_dir else config_dir()
    cfg_path = base / "config.json"
    cfg = load_config(cfg_path)

    # Host binding gate. The relay owns the signed-in CodeGPT session and the
    # upstream credentials, so it only runs on the machine it was installed on.
    # A copied install fails here, loudly, instead of quietly serving another
    # machine's traffic under this account.
    _host_error = cfg.get("_host_error")
    if _host_error and not args.ignore_host_bind:
        print("SignalR.E.A.C.H: HOST MISMATCH", file=sys.stderr)
        print("  " + _host_error, file=sys.stderr)
        print("  This install is bound to a different machine. If you moved "
              "to new hardware,", file=sys.stderr)
        print("  recover with the code in host-recovery.json, or re-run the "
              "installer here.", file=sys.stderr)
        sys.exit(3)

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
    _report_access_posture(cfg, host)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
