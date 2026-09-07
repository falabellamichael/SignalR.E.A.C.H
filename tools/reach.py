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
SCRIPT_SOURCES = ["manifest.js", "reach-core.js", "reach-pages.js", "reach.js"]
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
    """Atomic write: peer installers (Blueprint, gradient-studio) rewrite this
    file concurrently, so a partial write must never be visible to the server."""
    home.mkdir(parents=True, exist_ok=True)
    path = home / "registry.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(registry, separators=(",", ":")),
                   encoding="utf-8")
    os.replace(str(tmp), str(path))


def verify_registry_entry(home, entry_id):
    """Re-read the registry from disk and confirm our entry is present."""
    registry = read_registry(home)
    return any(e.get("id") == entry_id for e in registry.get("extensions", []))


def registry_entry(plugin, assets, manifest_bytes):
    """Registry entry in the format the frontend server REQUIRES:
    {id, version, enabled: true, manifest_sha256}. The served response
    expands entries with scripts/styles, but discovery silently drops any
    entry lacking `enabled`/`manifest_sha256` — write the full old format."""
    return {
        "id": PLUGIN_ID,
        "version": plugin["version"],
        "enabled": True,
        "manifest_sha256": sha256_bytes(manifest_bytes),
    }


def upsert_registry(home, entry):
    """Insert/replace ONLY our entry; every other entry is preserved as-is.
    Peers can overwrite the file a moment later — the caller verifies and
    retries (see cmd_install)."""
    registry = read_registry(home)
    entries = [e for e in registry["extensions"] if e.get("id") != PLUGIN_ID]
    entries.append(entry)
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
    if "hermes" not in exe.lower() and "venv" not in exe.lower():
        return exe
    # py launcher: always resolves a real CPython outside any venv.
    launcher = shutil.which("py")
    if launcher:
        try:
            result = subprocess.run(
                [launcher, "-3", "-c",
                 "import sys;print(sys.executable)"],
                capture_output=True, text=True, timeout=15,
                **no_window_kwargs())
            candidate = (result.stdout or "").strip()
            if result.returncode == 0 and candidate \
                    and "hermes" not in candidate.lower() \
                    and Path(candidate).is_file():
                return candidate
        except Exception:
            pass
    for cand in (shutil.which("python3"), shutil.which("python")):
        if not cand:
            continue
        if "hermes" in str(cand).lower() or "windowsapps" in str(cand).lower():
            continue
        if Path(cand).is_file():
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
    lines.append("\"%s\" tools\\reach.py reassert" % resolve_interpreter())
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

STASH_DIR = CONFIG_DIR / "extension-stash"


def stash_extension(entry, assets, manifest_bytes):
    """Keep the built package beside the runtime so `reassert` can restore the
    registry entry WITHOUT the git checkout (peer installers clobber the
    shared registry.json; autostart reasserts on every logon)."""
    STASH_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in assets:
        (STASH_DIR / name).write_bytes(data)
    (STASH_DIR / "manifest.json").write_bytes(manifest_bytes)
    (STASH_DIR / "entry.json").write_text(json.dumps(entry), encoding="utf-8")


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


# ----------------------------------------------------------------------
# v2 admin commands (talk to the running relay's _reach API)
# ----------------------------------------------------------------------

def admin_request(path, method="GET", payload=None, port=None):
    url = "http://127.0.0.1:%d%s" % (port or runtime_port(), path)
    req = urllib.request.Request(url, method=method)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=10) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8", "replace"))


def require_relay():
    if not port_open(runtime_port()):
        raise SystemExit("error: relay not running — `python tools/reach.py start`")


def split_dotted(path):
    """Split a settings path. Model aliases may contain dots
    (e.g. models.claude-opus-4.6.description), so the models section gets
    special handling: everything between 'models.' and the LAST dot is the
    alias."""
    parts = path.split(".")
    if len(parts) >= 3 and parts[0] == "models":
        return "models", ".".join(parts[1:-1]), parts[-1]
    return None, None, None


def get_dotted(cfg, path):
    section, alias, key = split_dotted(path)
    if section:
        spec = (cfg.get("models") or {}).get(alias)
        return spec.get(key) if isinstance(spec, dict) else None
    node = cfg
    for part in path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return None
    return node


def set_dotted_patch(path, value):
    """Build a nested PUT patch from a dotted path, e.g. models.gpt-4o.rpm."""
    section, alias, key = split_dotted(path)
    if section:
        return {"models": {alias: {key: value}}}
    parts = path.split(".")
    patch = {}
    node = patch
    for part in parts[:-1]:
        node[part] = {}
        node = node[part]
    node[parts[-1]] = value
    return patch


def coerce_value(current, raw):
    """Coerce a CLI string to the type of the current value."""
    if isinstance(current, bool):
        if raw.lower() in ("true", "1", "yes", "on"):
            return True
        if raw.lower() in ("false", "0", "no", "off"):
            return False
        raise ValueError("expected true/false")
    if isinstance(current, int) and not isinstance(current, bool):
        if not raw.lstrip("-").isdigit():
            raise ValueError("expected an integer")
        return int(raw)
    if isinstance(current, float):
        try:
            return float(raw)
        except ValueError:
            raise ValueError("expected a number")
    if isinstance(current, list):
        return [item.strip() for item in raw.split(",") if item.strip()]
    if current is None:
        if raw.lower() in ("null", "none", "~"):
            return None
        if raw.lower() in ("true", "false"):
            return raw.lower() == "true"
        if raw.lstrip("-").isdigit():
            return int(raw)
        try:
            return float(raw)
        except ValueError:
            return raw
    return raw


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
    print("SimpleREACH stats (today)")
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
        raise SystemExit("error: 'update' must run from a SimpleREACH checkout")
    print("pulling latest from " + REPO_URL + " …")
    result = subprocess.run(["git", "pull", "--ff-only"], cwd=str(REPO_ROOT),
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit("git pull failed: " + (result.stderr or "").strip()[:300])
    print(result.stdout.strip() or "  already up to date")
    cmd_install(args)


def main():
    parser = argparse.ArgumentParser(
        description="SimpleREACH installer + runtime manager",
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


if __name__ == "__main__":
    main()
