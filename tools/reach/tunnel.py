"""Tunnel lifecycle: ngrok (default) and cloudflared (fallback)."""

import json
import os
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

from .config import TUNNEL_LOG, TUNNEL_PID_PATH
from .runtime import (
    kill_pid,
    no_window_kwargs,
    public_url_from_server,
    read_pid,
)
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
