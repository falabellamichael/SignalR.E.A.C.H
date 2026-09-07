#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SimpleREACH installer + runtime manager.

REACH = RAG Endpoint & AI Chat Host — a SimpleRAG plugin that adds a hosted
OpenAI-compatible endpoint with unlimited gpt-4o (no key required), relayed
through a local OmniRoute instance's codegpt provider.

Install (the GitHub URL way):

    git clone https://github.com/falabellamichael/SimpleREACH.git
    cd SimpleREACH
    python tools/reach.py install

`install` writes ONLY outside SimpleRAG's own files:
  * %LOCALAPPDATA%\\RAGWorkspace\\extensions\\   registry.json + packages/simple-reach/
    (the same local-extension registry the app's frontend server injects from)
  * %LOCALAPPDATA%\\SimpleREACH\\                 relay server, config, logs, pids
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
import hashlib
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PLUGIN_ID = "simple-reach"
SCHEMA_VERSION = 1
SURFACES = ["advanced"]
SCRIPT_SOURCES = ["manifest.js", "reach.js"]
STYLE_SOURCES = ["reach.css"]
MANIFEST_PLACEHOLDER = "__REACH_MANIFEST_JSON__"
DEFAULT_PORT = 20777

GIST_ID = "e261e0c31ad08c373bcd667b6982847a"
GIST_FILE = "simple-reach-endpoint.txt"
GIST_RAW = ("https://gist.githubusercontent.com/falabellamichael/"
            + GIST_ID + "/raw/" + GIST_FILE)
REPO_URL = "https://github.com/falabellamichael/SimpleREACH"

MAX_ASSETS = 32
MAX_ASSET_BYTES = 8 * 1024 * 1024
MAX_EXTENSION_BYTES = 16 * 1024 * 1024
CONFLICT_MARKERS = (b"<<<<<<<", b">>>>>>>", b"\n=======")

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
PLUGIN_JSON = SRC_DIR / "plugin.json"
MANIFEST_TEMPLATE = SRC_DIR / "manifest.template.js"
IS_FULL_REPO = SRC_DIR.is_dir() and PLUGIN_JSON.is_file()


def config_dir():
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "SimpleREACH"


CONFIG_DIR = config_dir()
CONFIG_PATH = CONFIG_DIR / "config.json"
PID_PATH = CONFIG_DIR / "reach.pid"
TUNNEL_PID_PATH = CONFIG_DIR / "tunnel.pid"
LOG_PATH = CONFIG_DIR / "reach.log"
TUNNEL_LOG = CONFIG_DIR / "tunnel.log"
BAT_PATH = CONFIG_DIR / "start_reach.bat"


# ----------------------------------------------------------------------
# Registry location — mirrors chat_frontend_server.local_extension_root()
# ----------------------------------------------------------------------

def extension_home(override=None):
    if override:
        return Path(override).expanduser().resolve()
    configured = os.environ.get("PYMU_RAG_EXTENSION_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    runtime_home = os.environ.get("PYMU_RAG_HOME")
    if runtime_home:
        return Path(runtime_home).expanduser().resolve().parent / "extensions"
    local_app_data = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local_app_data).expanduser().resolve() / "RAGWorkspace" / "extensions"


def package_dir(home, version):
    return home / "packages" / PLUGIN_ID / version


# ----------------------------------------------------------------------
# Build (asset collection + registry manifests)
# ----------------------------------------------------------------------

def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def load_plugin_manifest():
    if not PLUGIN_JSON.is_file():
        raise SystemExit("error: missing " + str(PLUGIN_JSON))
    return json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))


def build_manifest_js(plugin):
    if not MANIFEST_TEMPLATE.is_file():
        raise SystemExit("error: missing " + str(MANIFEST_TEMPLATE))
    template = MANIFEST_TEMPLATE.read_text(encoding="utf-8")
    if MANIFEST_PLACEHOLDER not in template:
        raise SystemExit("error: manifest template lost its placeholder")
    payload = json.dumps(plugin, separators=(",", ":"), ensure_ascii=False)
    payload = payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return template.replace(MANIFEST_PLACEHOLDER, payload).encode("utf-8")


def collect_assets(plugin):
    assets = []
    for name in STYLE_SOURCES:
        path = SRC_DIR / name
        if not path.is_file():
            raise SystemExit("error: missing style source " + str(path))
        assets.append((name, path.read_bytes()))
    for name in SCRIPT_SOURCES:
        if name == "manifest.js":
            assets.append((name, build_manifest_js(plugin)))
            continue
        path = SRC_DIR / name
        if not path.is_file():
            raise SystemExit("error: missing script source " + str(path))
        assets.append((name, path.read_bytes()))
    return assets


def validate_assets(assets):
    if len(assets) > MAX_ASSETS:
        raise SystemExit("error: %d assets exceeds the host limit of %d"
                         % (len(assets), MAX_ASSETS))
    total = 0
    for name, data in assets:
        if not data:
            raise SystemExit("error: asset %s is empty" % name)
        if len(data) > MAX_ASSET_BYTES:
            raise SystemExit("error: asset %s exceeds the %d-byte host limit"
                             % (name, MAX_ASSET_BYTES))
        if any(marker in data for marker in CONFLICT_MARKERS):
            raise SystemExit("error: unresolved merge-conflict markers in %s "
                             "— refusing to install a bundle that would not "
                             "parse" % name)
        total += len(data)
    if total > MAX_EXTENSION_BYTES:
        raise SystemExit("error: total payload %d bytes exceeds the %d-byte "
                         "host limit" % (total, MAX_EXTENSION_BYTES))


def build_extension_manifest(plugin, assets):
    scripts = [{"path": name, "sha256": sha256_bytes(data), "size": len(data)}
               for name, data in assets if name.endswith(".js")]
    order = {name: index for index, name in enumerate(SCRIPT_SOURCES)}
    scripts.sort(key=lambda item: order.get(item["path"], 999))
    styles = [{"path": name, "sha256": sha256_bytes(data), "size": len(data)}
              for name, data in assets if name.endswith(".css")]
    return json.dumps({
        "schema_version": SCHEMA_VERSION,
        "id": PLUGIN_ID,
        "version": plugin["version"],
        "enabled": True,
        "surfaces": SURFACES,
        "scripts": scripts,
        "styles": styles,
    }, separators=(",", ":")).encode("utf-8")


# ----------------------------------------------------------------------
# Registry read/write
# ----------------------------------------------------------------------

def read_registry(home):
    path = home / "registry.json"
    if not path.is_file():
        return {"schema_version": SCHEMA_VERSION, "extensions": []}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print("warning: could not read %s (%s); starting a fresh registry" % (path, exc))
        return {"schema_version": SCHEMA_VERSION, "extensions": []}
    if not isinstance(parsed, dict) or parsed.get("schema_version") != SCHEMA_VERSION:
        print("warning: %s is not a schema-v1 registry; starting a fresh one" % path)
        return {"schema_version": SCHEMA_VERSION, "extensions": []}
    entries = parsed.get("extensions")
    if not isinstance(entries, list):
        entries = []
    parsed["extensions"] = [e for e in entries if isinstance(e, dict)]
    return parsed


def write_registry(home, registry):
    home.mkdir(parents=True, exist_ok=True)
    (home / "registry.json").write_text(
        json.dumps(registry, separators=(",", ":")), encoding="utf-8")


def upsert_registry(home, version, manifest_bytes):
    registry = read_registry(home)
    entries = [e for e in registry["extensions"] if e.get("id") != PLUGIN_ID]
    entries.append({
        "id": PLUGIN_ID,
        "version": version,
        "enabled": True,
        "manifest_sha256": sha256_bytes(manifest_bytes),
    })
    entries.sort(key=lambda e: e.get("id", ""))
    registry["extensions"] = entries
    write_registry(home, registry)


# ----------------------------------------------------------------------
# OmniRoute key + config
# ----------------------------------------------------------------------

def find_omniroute_key():
    db = Path.home() / ".omniroute" / "storage.sqlite"
    if not db.is_file():
        return None
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
        rows = conn.execute(
            "SELECT name, key FROM api_keys "
            "WHERE revoked_at IS NULL AND is_active = 1").fetchall()
        conn.close()
    except sqlite3.Error:
        return None
    preferred = [k for name, k in rows if name == "SimpleRAG"]
    if preferred:
        return preferred[0]
    return rows[0][1] if rows else None


def mask_key(key):
    if not key:
        return "(none)"
    if len(key) <= 12:
        return "set (short)"
    return key[:8] + "…" + key[-4:]


def load_config():
    if CONFIG_PATH.is_file():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    return {}


def save_config(cfg):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def runtime_port():
    return int(load_config().get("port", DEFAULT_PORT))


# ----------------------------------------------------------------------
# Process helpers (Windows-friendly)
# ----------------------------------------------------------------------

def no_window_kwargs():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def port_open(port, host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def read_pid(path):
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def kill_pid(pid):
    if not pid:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       **no_window_kwargs())
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


def find_ngrok():
    candidates = [
        shutil.which("ngrok"),
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet"
            / "Links" / "ngrok.exe"),
        str(Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet"
            / "Links" / "ngrok.exe"),
    ]
    for cand in candidates:
        if cand and Path(cand).is_file():
            return str(Path(cand))
    return None


def find_cloudflared():
    exe = "cloudflared.exe" if os.name == "nt" else "cloudflared"
    cand = Path.home() / ".omniroute" / "cloudflared" / "bin" / exe
    return str(cand) if cand.is_file() else None


def find_gh():
    for cand in (shutil.which("gh"),
                 str(Path(os.environ.get("PROGRAMFILES", "")) / "GitHub CLI" / "gh.exe")):
        if cand and Path(cand).is_file():
            return str(Path(cand))
    return None


def resolve_interpreter():
    """Pick a stable Python for the relay. Never inherit a sandbox venv
    (e.g. Hermes' own) — a sandbox update would break the background relay."""
    exe = str(Path(sys.executable))
    if "hermes" in exe.lower() or exe.lower().endswith("venv\\scripts\\python.exe"):
        cand = shutil.which("python")
        if cand and Path(cand).is_file():
            return str(Path(cand))
    return exe


def resolve_pythonw():
    """Windowless pythonw beside the resolved interpreter, else the CLI python."""
    exe = resolve_interpreter()
    pythonw = Path(exe).with_name("pythonw.exe")
    return str(pythonw) if pythonw.is_file() else exe


def public_url_from_server(port=None):
    port = port or runtime_port()
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:%d/public-url" % port)
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        return (data.get("public_url") or "").strip() or None
    except Exception:
        return None


# ----------------------------------------------------------------------
# Relay server lifecycle
# ----------------------------------------------------------------------

def start_server():
    if port_open(runtime_port()):
        print("  relay already running on 127.0.0.1:%d" % runtime_port())
        return True
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    server_py = CONFIG_DIR / "server" / "reachd.py"
    if not server_py.is_file():
        raise SystemExit("error: installed server missing — re-run install")
    with open(LOG_PATH, "ab") as log:
        proc = subprocess.Popen(
            [resolve_interpreter(), str(server_py)],
            cwd=str(CONFIG_DIR), stdout=log, stderr=subprocess.STDOUT,
            **no_window_kwargs())
    PID_PATH.write_text(str(proc.pid), encoding="utf-8")
    for _ in range(30):
        if port_open(runtime_port()):
            print("  relay listening on http://127.0.0.1:%d/v1" % runtime_port())
            return True
        time.sleep(0.5)
    print("  warning: relay did not answer within 15s — see " + str(LOG_PATH))
    return False


def stop_server():
    pid = read_pid(PID_PATH)
    if pid:
        kill_pid(pid)
    PID_PATH.write_text("", encoding="utf-8")
    if port_open(runtime_port()):
        print("  warning: something still listens on port %d" % runtime_port())


# ----------------------------------------------------------------------
# Tunnel lifecycle (ngrok default, cloudflared fallback)
# ----------------------------------------------------------------------

def start_tunnel(kind, port):
    if public_url_from_server(port):
        print("  tunnel already exposing the relay (public URL discovered)")
        return True
    if kind == "none":
        print("  tunnel disabled (--tunnel none) — relay is localhost-only")
        return True
    if kind == "cloudflared":
        binary = find_cloudflared()
        if not binary:
            print("  cloudflared binary not found under ~/.omniroute/cloudflared — "
                  "falling back to ngrok")
            return start_tunnel("ngrok", port)
        with open(TUNNEL_LOG, "ab") as log:
            proc = subprocess.Popen(
                [binary, "tunnel", "--url", "http://127.0.0.1:%d" % port,
                 "--no-autoupdate"],
                stdout=log, stderr=subprocess.STDOUT, **no_window_kwargs())
        TUNNEL_PID_PATH.write_text(str(proc.pid), encoding="utf-8")
        url = wait_for_cloudflared_url(45)
        if url:
            post_public_url_override(port, url)
        return url is not None

    ngrok = find_ngrok()
    if not ngrok:
        print("  ngrok not found — run `winget install ngrok` or pass "
              "--tunnel cloudflared")
        return False
    with open(TUNNEL_LOG, "ab") as log:
        proc = subprocess.Popen(
            [ngrok, "http", str(port), "--log", "stdout"],
            stdout=log, stderr=subprocess.STDOUT, **no_window_kwargs())
    TUNNEL_PID_PATH.write_text(str(proc.pid), encoding="utf-8")
    for _ in range(45):
        if public_url_from_server(port):
            return True
        time.sleep(1)
    print("  warning: no public URL after 45s — check " + str(TUNNEL_LOG))
    return False


def wait_for_cloudflared_url(timeout_s):
    pattern = "https://"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if TUNNEL_LOG.is_file():
            try:
                for line in TUNNEL_LOG.read_text(encoding="utf-8",
                                                 errors="replace").splitlines():
                    if ".trycloudflare.com" in line:
                        start = line.find("https://")
                        if start >= 0:
                            return line[start:].split()[0].rstrip(".,")
            except OSError:
                pass
        time.sleep(1)
    return None


def post_public_url_override(port, url):
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:%d/_reach/public-url" % port,
            data=json.dumps({"public_url": url}).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
    except Exception:
        pass


def stop_tunnel():
    pid = read_pid(TUNNEL_PID_PATH)
    if pid:
        kill_pid(pid)
    TUNNEL_PID_PATH.write_text("", encoding="utf-8")


# ----------------------------------------------------------------------
# Endpoint pointer gist
# ----------------------------------------------------------------------

def publish(quiet=False):
    port = runtime_port()
    url = public_url_from_server(port)
    if not url:
        if not quiet:
            print("publish: no public URL available (is the tunnel up?)")
        return False
    gh = find_gh()
    if not gh:
        if not quiet:
            print("publish: gh CLI not found — cannot update the pointer gist")
        return False
    tmp = CONFIG_DIR / GIST_FILE
    tmp.write_text(url.strip(), encoding="utf-8")
    result = subprocess.run([gh, "gist", "edit", GIST_ID, str(tmp)],
                            capture_output=True, text=True, timeout=60,
                            **no_window_kwargs())
    if result.returncode != 0:
        if not quiet:
            print("publish: gh gist edit failed: %s"
                  % (result.stderr or "").strip()[:200])
        return False
    if not quiet:
        print("published public endpoint -> " + url)
    return True


# ----------------------------------------------------------------------
# Autostart (Windows logon task)
# ----------------------------------------------------------------------

def startup_folder():
    return (Path(os.environ.get("APPDATA", ""))
            / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup")


def register_autostart():
    if os.name != "nt":
        raise SystemExit("error: register-autostart is Windows-only "
                         "(schtasks). Start the relay from your own init "
                         "system instead.")
    port = runtime_port()
    pythonw = resolve_pythonw()
    ngrok = find_ngrok()
    gh = find_gh()
    lines = [
        "@echo off",
        "cd /d \"%s\"" % CONFIG_DIR,
        "start \"\" /min \"%s\" server\\reachd.py" % pythonw,
        "timeout /t 3 /nobreak >nul",
    ]
    if ngrok:
        lines.append("start \"\" /min \"%s\" http %d --log=stdout" % (ngrok, port))
        lines.append("timeout /t 12 /nobreak >nul")
        if gh:
            lines.append("\"%s\" tools\\reach.py publish --quiet" % resolve_interpreter())
    else:
        lines.append("echo ngrok not found - run: winget install ngrok")
    BAT_PATH.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
    result = subprocess.run(
        ["schtasks", "/Create", "/TN", "SimpleREACH", "/SC", "ONLOGON",
         "/TR", str(BAT_PATH), "/F", "/RL", "LIMITED"],
        capture_output=True, text=True, **no_window_kwargs())
    if result.returncode == 0:
        print("  autostart registered: SimpleREACH (logon task) -> "
              + str(BAT_PATH))
        return
    # schtasks /Create can require elevation; the per-user Startup folder
    # needs none and runs the same batch at every logon.
    startup = startup_folder()
    if startup.is_dir():
        target = startup / "SimpleREACH.bat"
        shutil.copy2(BAT_PATH, target)
        print("  schtasks denied (needs elevation) — using the Startup "
              "folder instead: " + str(target))
        return
    raise SystemExit("error: schtasks failed (%s) and no Startup folder "
                     "found" % (result.stderr or result.stdout or "").strip()[:300])


def remove_autostart():
    if os.name != "nt":
        return
    subprocess.run(["schtasks", "/Delete", "/TN", "SimpleREACH", "/F"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   **no_window_kwargs())
    startup = startup_folder() / "SimpleREACH.bat"
    if startup.is_file():
        try:
            startup.unlink()
        except OSError:
            pass


# ----------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------

def cmd_install(args):
    if not IS_FULL_REPO:
        raise SystemExit("error: 'install' must run from a full SimpleREACH "
                         "checkout (src/ missing)")
    print("SimpleREACH installer — REACH: RAG Endpoint & AI Chat Host")
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
    upsert_registry(home, version, manifest)
    print("  plugin page installed -> " + str(pkg))

    # 2. runtime copy + config
    (CONFIG_DIR / "server").mkdir(parents=True, exist_ok=True)
    (CONFIG_DIR / "tools").mkdir(parents=True, exist_ok=True)
    shutil.copy2(REPO_ROOT / "server" / "reachd.py",
                 CONFIG_DIR / "server" / "reachd.py")
    shutil.copy2(REPO_ROOT / "tools" / "reach.py",
                 CONFIG_DIR / "tools" / "reach.py")
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

    # 3. start + host + publish
    if not args.no_start:
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
    print("SimpleREACH status")
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


def main():
    parser = argparse.ArgumentParser(
        description="SimpleREACH installer + runtime manager",
        prog="reach.py")
    sub = parser.add_subparsers(dest="command")

    p_install = sub.add_parser("install", help="install plugin + runtime, "
                                               "start relay + tunnel")
    p_install.add_argument("--no-start", action="store_true",
                           help="install files only")
    p_install.add_argument("--tunnel", choices=["ngrok", "cloudflared", "none"],
                           default="ngrok")
    p_install.add_argument("--no-publish", action="store_true")
    p_install.add_argument("--extension-home", default=None)
    p_install.set_defaults(func=cmd_install)

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

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        raise SystemExit(1)
    args.func(args)


if __name__ == "__main__":
    main()
