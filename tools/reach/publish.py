"""Endpoint pointer gist: gh discovery and publish."""

import os
import shutil
import subprocess
from pathlib import Path

from . import GIST_FILE, GIST_ID
from .config import CONFIG_DIR
from .runtime import (
    no_window_kwargs,
    public_url_from_server,
    runtime_port,
)
def find_gh():
    for cand in (shutil.which("gh"),
                 str(Path(os.environ.get("PROGRAMFILES", "")) / "GitHub CLI" / "gh.exe")):
        if cand and Path(cand).is_file():
            return str(Path(cand))
    return None


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
