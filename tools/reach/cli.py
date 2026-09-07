#!/usr/bin/env python3
"""SignalR.E.A.C.H installer + runtime manager.

REACH = RAG Endpoint & AI Chat Host — a SimpleRAG plugin that adds a hosted
OpenAI-compatible endpoint with unlimited gpt-4o (no key required), relayed
through a local OmniRoute instance's codegpt provider.

Install (the GitHub URL way):

    git clone https://github.com/falabellamichael/SignalR.E.A.C.H.git
    cd SignalR.E.A.C.H
    python tools/reach.py install

`install` writes ONLY outside SimpleRAG's own files:
  * %LOCALAPPDATA%\\RAGWorkspace\\extensions\\   registry.json + packages/signal-reach/
    (the same local-extension registry the app's frontend server injects from)
  * %LOCALAPPDATA%\\SignalREACH\\                 relay server, config, logs, pids
    (config.json holds the OmniRoute key, auto-detected from ~/.omniroute)

Commands:
  reach.py install            build + install plugin page, copy runtime,
                              start relay + tunnel, publish endpoint pointer
  reach.py uninstall [--all]  remove plugin page (+ stop everything with --all)
  reach.py status             relay/tunnel/public-URL status
  reach.py start|stop|restart relay + tunnel
  reach.py publish            push the current public URL to the pointer gist
  reach.py register-autostart create a logon task that restarts relay+tunnel
"""

import argparse
import json
import shutil
import subprocess
import time

from . import (
    DEFAULT_PORT,
    GIST_RAW,
    IS_FULL_REPO,
    PLUGIN_ID,
    REPO_ROOT,
    REPO_URL,
)
from .autostart import register_autostart, remove_autostart
from .build import (
    build_extension_manifest,
    collect_assets,
    load_plugin_manifest,
    validate_assets,
)
from .config import (
    CONFIG_DIR,
    CONFIG_PATH,
    load_config,
    runtime_port,
    save_config,
)
from .http_admin import (
    admin_request,
    coerce_value,
    get_dotted,
    require_relay,
    set_dotted_patch,
)
from .keys import find_omniroute_key, mask_key
from .publish import publish
from .registry import (
    STASH_DIR,
    extension_home,
    package_dir,
    read_registry,
    registry_entry,
    stash_extension,
    upsert_registry,
    verify_registry_entry,
    write_registry,
)
from .runtime import (
    port_open,
    public_url_from_server,
    start_server,
    stop_server,
)
from .tunnel import start_tunnel, stop_tunnel



















# ----------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------


def cmd_reassert(_args):
    """Rewrite the extension package + registry entry from the install stash."""
    if not (STASH_DIR / "entry.json").is_file():
        raise SystemExit("error: no extension stash — run `reach.py install` "
                         "once from a checkout first")
    entry = json.loads((STASH_DIR / "entry.json").read_text(encoding="utf-8"))
    home = extension_home(None)
    pkg = package_dir(home, entry["version"])
    pkg.mkdir(parents=True, exist_ok=True)
    for path in STASH_DIR.iterdir():
        if path.is_file() and path.name != "entry.json":
            (pkg / path.name).write_bytes(path.read_bytes())
    upsert_registry(home, entry)
    if verify_registry_entry(home, PLUGIN_ID):
        print("  registry entry re-asserted (%s)" % entry["version"])
    else:
        print("  warning: entry clobbered again — re-run `reach.py reassert`")


def cmd_install(args):
    if not IS_FULL_REPO:
        raise SystemExit("error: 'install' must run from a full SignalR.E.A.C.H "
                         "checkout (src/ missing)")
    print("SignalR.E.A.C.H installer — REACH: RAG Endpoint & AI Chat Host")
    print("repo: " + REPO_URL)
    # 1. plugin page -> local-extension registry (never touches SimpleRAG files)
    plugin = load_plugin_manifest()
    version = plugin["version"]
    assets = collect_assets(plugin)
    validate_assets(assets)
    manifest = build_extension_manifest(plugin, assets)
    home = extension_home(args.extension_home)
    pkg = package_dir(home, version)
    pkg.mkdir(parents=True, exist_ok=True)
    for name, data in assets:
        (pkg / name).write_bytes(data)
    (pkg / "manifest.json").write_bytes(manifest)
    entry = registry_entry(plugin, assets, manifest)
    upsert_registry(home, entry)
    # Peers (Blueprint, gradient-studio installers) rewrite the shared
    # registry concurrently — verify our entry landed and retry if clobbered.
    for attempt in range(3):
        if verify_registry_entry(home, PLUGIN_ID):
            break
        time.sleep(1)
        upsert_registry(home, entry)
    if not verify_registry_entry(home, PLUGIN_ID):
        print("  warning: registry entry was clobbered by a concurrent "
              "installer — re-run install to restore it")
    stash_extension(entry, assets, manifest)
    # prune stale versions of OUR package (never other extensions')
    pkg_root = home / "packages" / PLUGIN_ID
    if pkg_root.is_dir():
        for entry in pkg_root.iterdir():
            if entry.is_dir() and entry.name != version:
                shutil.rmtree(entry, ignore_errors=True)
    print("  plugin page installed -> " + str(pkg))

    # 2. runtime copy + config
    (CONFIG_DIR / "server").mkdir(parents=True, exist_ok=True)
    (CONFIG_DIR / "tools").mkdir(parents=True, exist_ok=True)
    ignore = shutil.ignore_patterns("__pycache__")
    shutil.copy2(REPO_ROOT / "server" / "reachd.py",
                 CONFIG_DIR / "server" / "reachd.py")
    shutil.copytree(REPO_ROOT / "server" / "reachd",
                    CONFIG_DIR / "server" / "reachd",
                    dirs_exist_ok=True, ignore=ignore)
    shutil.copy2(REPO_ROOT / "tools" / "reach.py",
                 CONFIG_DIR / "tools" / "reach.py")
    shutil.copytree(REPO_ROOT / "tools" / "reach",
                    CONFIG_DIR / "tools" / "reach",
                    dirs_exist_ok=True, ignore=ignore)
    cfg = load_config()
    if not cfg.get("omniroute_key"):
        key = find_omniroute_key()
        if key:
            cfg["omniroute_key"] = key
            print("  OmniRoute key auto-detected (%s)" % mask_key(key))
        else:
            print("  warning: no OmniRoute key found in ~/.omniroute — add "
                  "omniroute_key to config.json manually")
    cfg.setdefault("omniroute_url", "http://127.0.0.1:20128/v1")
    cfg.setdefault("port", DEFAULT_PORT)
    cfg.setdefault("host", "127.0.0.1")
    cfg.setdefault("tunnel", args.tunnel if args.tunnel != "none" else "ngrok")
    save_config(cfg)
    print("  runtime + config -> " + str(CONFIG_DIR))

    # 3. (re)start + host + publish
    if not args.no_start:
        if args.restart and port_open(runtime_port()):
            print("  restarting relay to load the new server version…")
            stop_server()
            time.sleep(1)
        start_server()
        if args.tunnel != "none":
            start_tunnel(args.tunnel, runtime_port())
        if not args.no_publish:
            publish()
    print()
    print("Done. Local endpoint: http://127.0.0.1:%d/v1" % runtime_port())
    print("Endpoint pointer:  " + GIST_RAW)
    print("Plugin page: open SimpleRAG -> Advanced -> REACH (app bar).")
    print("Run `python tools/reach.py register-autostart` to survive reboots.")


def cmd_uninstall(args):
    home = extension_home(None)
    registry = read_registry(home)
    before = len(registry["extensions"])
    registry["extensions"] = [e for e in registry["extensions"]
                              if e.get("id") != PLUGIN_ID]
    if len(registry["extensions"]) == before:
        print("  not registered (nothing to remove)")
    else:
        write_registry(home, registry)
        pkg_root = home / "packages" / PLUGIN_ID
        if pkg_root.is_dir():
            shutil.rmtree(pkg_root, ignore_errors=True)
            print("  removed " + str(pkg_root))
    if args.all:
        stop_server()
        stop_tunnel()
        remove_autostart()
        print("  stopped relay + tunnel, removed autostart task")
        print("  config kept at " + str(CONFIG_PATH)
              + " (delete it to fully clean up)")


def cmd_status(_args):
    cfg = load_config()
    port = runtime_port()
    print("SignalR.E.A.C.H status")
    print("  relay:      %s" % ("running (port %d)" % port if port_open(port)
                               else "stopped"))
    url = public_url_from_server(port)
    if url:
        print("  public URL: %s" % url)
        print("  models:     %s/v1/models" % url)
    else:
        print("  public URL: (no tunnel up — run `reach.py start`)")
    print("  pointer:    " + GIST_RAW)
    print("  config:     " + str(CONFIG_PATH))
    print("  key:        %s" % mask_key(cfg.get("omniroute_key")))


def cmd_start(args):
    start_server()
    start_tunnel(args.tunnel, runtime_port())
    if not args.no_publish:
        publish()


def cmd_stop(_args):
    stop_server()
    stop_tunnel()


def cmd_restart(args):
    stop_server()
    stop_tunnel()
    time.sleep(1)
    start_server()
    start_tunnel(args.tunnel, runtime_port())
    if not args.no_publish:
        publish()


# ----------------------------------------------------------------------
# v2 admin commands (talk to the running relay's _reach API)
# ----------------------------------------------------------------------


def cmd_settings(args):
    require_relay()
    if not args.key:
        _, cfg = admin_request("/_reach/settings")
        print(json.dumps(cfg, indent=2))
        return
    dotted = "." in args.key
    value = args.value
    if value is None:
        _, cfg = admin_request("/_reach/settings")
        current = get_dotted(cfg, args.key) if dotted else cfg.get(args.key)
        if isinstance(current, (dict, list)):
            print(json.dumps(current, indent=2))
        else:
            print(current if current is not None else "(unset)")
        return
    _, cfg = admin_request("/_reach/settings")
    current = get_dotted(cfg, args.key) if dotted else cfg.get(args.key)
    try:
        typed = coerce_value(current, value)
    except ValueError as exc:
        raise SystemExit("error: %s" % exc)
    patch = set_dotted_patch(args.key, typed) if dotted else {args.key: typed}
    _, result = admin_request("/_reach/settings", "PUT", patch)
    if result.get("saved"):
        print("saved: %s = %r" % (args.key, typed))
    else:
        raise SystemExit("error: %s"
                         % (result.get("error") or {}).get("message"))


def cmd_models(args):
    require_relay()
    if args.action == "list":
        _, cfg = admin_request("/_reach/settings")
        for alias, spec in sorted(cfg["models"].items()):
            print("%-18s %-34s %s" % (alias, spec["upstream"],
                                      "enabled" if spec["enabled"] else "disabled"))
        return
    if args.action == "add":
        _, cfg = admin_request("/_reach/settings")
        models = dict(cfg["models"])
        models[args.alias] = {"upstream": args.upstream, "enabled": True}
        _, result = admin_request("/_reach/settings", "PUT", {"models": models})
        if result.get("saved"):
            print("added alias %s -> %s" % (args.alias, args.upstream))
        else:
            raise SystemExit("error: %s" % (result.get("error") or {}).get("message"))
        return
    if args.action == "remove":
        _, cfg = admin_request("/_reach/settings")
        models = dict(cfg["models"])
        if args.alias not in models:
            raise SystemExit("error: unknown alias " + args.alias)
        if len(models) <= 1:
            raise SystemExit("error: keep at least one alias")
        # alias -> null is the removal sentinel in the settings merge
        _, result = admin_request("/_reach/settings", "PUT",
                                  {"models": {args.alias: None}})
        if result.get("saved"):
            print("removed alias " + args.alias)
        else:
            raise SystemExit("error: %s" % (result.get("error") or {}).get("message"))


def cmd_stats(args):
    require_relay()
    _, snap = admin_request("/_reach/stats")
    stats = snap.get("stats", {})
    today = stats.get("today", {})
    print("SignalR.E.A.C.H stats (today)")
    print("  requests:      %d" % today.get("requests", 0))
    print("  tokens in/out: %d / %d" % (today.get("tokens_in", 0),
                                       today.get("tokens_out", 0)))
    print("  errors:        %d (rate-limited %d)"
          % (today.get("errors", 0), today.get("rate_limited", 0)))
    print("  avg latency:   %s ms | p95 %s ms"
          % (today.get("avg_latency_ms", 0), snap.get("p95_latency_ms", 0)))
    print("  uptime:        %.0fs | version %s" % (snap.get("uptime_s", 0),
                                                     snap.get("version")))
    if args.verbose:
        print("\nBy model:")
        for m in stats.get("by_model", []):
            print("  %-16s %5d req  %s/%s tokens"
                  % (m["model"], m["requests"], m["tokens_in"], m["tokens_out"]))
        print("\nTop clients:")
        for c in stats.get("top_clients", []):
            print("  %-20s %5d req  %s tokens out"
                  % (c["ip"], c["requests"], c["tokens_out"]))


def cmd_logs(args):
    require_relay()
    query = "limit=%d" % max(1, min(args.limit, 500))
    if args.status:
        query += "&status=" + args.status
    if args.model:
        query += "&model=" + args.model
    _, data = admin_request("/_reach/logs?" + query)
    logs = data.get("logs", [])
    print("%-19s %-18s %-12s %6s %9s %8s %8s  %s"
          % ("time", "ip", "model", "status", "latency", "in", "out", "error"))
    for entry in logs:
        print("%-19s %-18s %-12s %6s %9s %8s %8s  %s"
              % (entry.get("ts", "")[:19], entry.get("ip") or "?",
                 (entry.get("model") or "—")[:12], entry.get("status"),
                 entry.get("latency_ms") or "—",
                 entry.get("tokens_in") if entry.get("tokens_in") is not None else "·",
                 entry.get("tokens_out") if entry.get("tokens_out") is not None else "·",
                 entry.get("error") or ""))


def cmd_test(args):
    require_relay()
    _, result = admin_request("/_reach/test", "POST")
    if result.get("ok"):
        print("upstream OK in %s ms via %s: %r"
              % (result.get("latency_ms"), result.get("model"),
                 result.get("reply")))
    else:
        raise SystemExit("upstream test failed: " + result.get("error", "?"))


def cmd_update(args):
    if not IS_FULL_REPO:
        raise SystemExit("error: 'update' must run from a SignalR.E.A.C.H checkout")
    print("pulling latest from " + REPO_URL + " …")
    result = subprocess.run(["git", "pull", "--ff-only"], cwd=str(REPO_ROOT),
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit("git pull failed: " + (result.stderr or "").strip()[:300])
    print(result.stdout.strip() or "  already up to date")
    cmd_install(args)


def main():
    parser = argparse.ArgumentParser(
        description="SignalR.E.A.C.H installer + runtime manager",
        prog="reach.py")
    sub = parser.add_subparsers(dest="command")

    p_install = sub.add_parser("install", help="install plugin + runtime, "
                                               "start relay + tunnel")
    p_install.add_argument("--no-start", action="store_true",
                           help="install files only")
    p_install.add_argument("--no-restart", action="store_true",
                           help="don't restart a running relay")
    p_install.add_argument("--tunnel", choices=["ngrok", "cloudflared", "none"],
                           default="ngrok")
    p_install.add_argument("--no-publish", action="store_true")
    p_install.add_argument("--extension-home", default=None)
    p_install.set_defaults(func=cmd_install, restart=True)

    p_un = sub.add_parser("uninstall", help="remove the plugin page")
    p_un.add_argument("--all", action="store_true",
                      help="also stop relay/tunnel and remove autostart")
    p_un.set_defaults(func=cmd_uninstall)

    sub.add_parser("status", help="show relay/tunnel/public-URL status") \
       .set_defaults(func=cmd_status)

    p_start = sub.add_parser("start", help="start relay + tunnel")
    p_start.add_argument("--tunnel", choices=["ngrok", "cloudflared", "none"],
                         default="ngrok")
    p_start.add_argument("--no-publish", action="store_true")
    p_start.set_defaults(func=cmd_start)

    sub.add_parser("stop", help="stop relay + tunnel") \
       .set_defaults(func=cmd_stop)

    p_restart = sub.add_parser("restart", help="restart relay + tunnel")
    p_restart.add_argument("--tunnel", choices=["ngrok", "cloudflared", "none"],
                           default="ngrok")
    p_restart.add_argument("--no-publish", action="store_true")
    p_restart.set_defaults(func=cmd_restart)

    p_pub = sub.add_parser("publish",
                           help="push the current public URL to the pointer gist")
    p_pub.add_argument("--quiet", action="store_true")
    p_pub.set_defaults(func=lambda a: publish(quiet=a.quiet))

    sub.add_parser("register-autostart",
                   help="create a Windows logon task (relay + tunnel + publish)") \
       .set_defaults(func=lambda _a: register_autostart())

    sub.add_parser("reassert",
                   help="restore the registry entry from the install stash "
                        "(peer installers clobber the shared registry.json)") \
       .set_defaults(func=cmd_reassert)

    p_settings = sub.add_parser("settings",
                                help="read/update relay settings (v2)")
    p_settings.add_argument("key", nargs="?", default=None)
    p_settings.add_argument("value", nargs="?", default=None)
    p_settings.set_defaults(func=cmd_settings)

    p_models = sub.add_parser("models", help="manage model aliases (v2)")
    p_models.add_argument("action", choices=["list", "add", "remove"])
    p_models.add_argument("alias", nargs="?", default=None)
    p_models.add_argument("upstream", nargs="?", default=None)
    p_models.set_defaults(func=cmd_models)

    p_stats = sub.add_parser("stats", help="usage statistics (v2)")
    p_stats.add_argument("--verbose", "-v", action="store_true")
    p_stats.set_defaults(func=cmd_stats)

    p_logs = sub.add_parser("logs", help="recent request log (v2)")
    p_logs.add_argument("--limit", type=int, default=50)
    p_logs.add_argument("--status", default=None)
    p_logs.add_argument("--model", default=None)
    p_logs.set_defaults(func=cmd_logs)

    sub.add_parser("test", help="live upstream test (v2)") \
       .set_defaults(func=cmd_test)

    p_update = sub.add_parser("update",
                              help="git pull + reinstall (v2)")
    p_update.add_argument("--no-start", action="store_true")
    p_update.add_argument("--no-restart", action="store_true")
    p_update.add_argument("--tunnel", choices=["ngrok", "cloudflared", "none"],
                          default="ngrok")
    p_update.add_argument("--no-publish", action="store_true")
    p_update.add_argument("--extension-home", default=None)
    p_update.set_defaults(func=cmd_update, restart=True)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        raise SystemExit(1)
    if getattr(args, "no_restart", False):
        args.restart = False
    args.func(args)


