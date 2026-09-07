"""Process helpers and relay server lifecycle (Windows-friendly)."""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from .config import (
    CONFIG_DIR,
    LOG_PATH,
    PID_PATH,
    TUNNEL_PID_PATH,
    runtime_port,
)
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
