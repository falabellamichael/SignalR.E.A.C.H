"""Push the relay's public URL to the pointer gist."""

import os
import subprocess
from pathlib import Path

from reachd.const import GIST_FILE, GIST_ID


def publish_url(state):
    """Push the current public URL to the pointer gist. Returns (ok, detail)."""
    if not state.cfg.get("publish", {}).get("enabled"):
        return False, "publishing is disabled in settings"
    url = state.public_url
    if not url:
        return False, "no public URL available"
    import shutil as _shutil
    gh = _shutil.which("gh")
    if not gh:
        gh = str(Path(os.environ.get("PROGRAMFILES", "")) / "GitHub CLI"
                 / "gh.exe")
        if not Path(gh).is_file():
            return False, "gh CLI not found"
    tmp = state.cfg_path.parent / GIST_FILE
    tmp.write_text(url.strip(), encoding="utf-8")
    try:
        result = subprocess.run([gh, "gist", "edit", GIST_ID, str(tmp)],
                                capture_output=True, text=True, timeout=60,
                                creationflags=(subprocess.CREATE_NO_WINDOW
                                               if os.name == "nt" else 0))
        if result.returncode != 0:
            return False, (result.stderr or "")[:300]
        import time as _time
        state.last_published_at = _time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
        return True, url
    except Exception as exc:
        return False, str(exc)[:300]


def revoke_url(state):
    """Blank out the pointer gist so remote clients stop discovering this
    relay (PRD: 'Admin can revoke or update published pointer URL with single
    click action'). Returns (ok, detail)."""
    import shutil as _shutil
    gh = _shutil.which("gh")
    if not gh:
        gh = str(Path(os.environ.get("PROGRAMFILES", "")) / "GitHub CLI"
                 / "gh.exe")
        if not Path(gh).is_file():
            return False, "gh CLI not found"
    tmp = state.cfg_path.parent / GIST_FILE
    tmp.write_text("", encoding="utf-8")
    try:
        result = subprocess.run([gh, "gist", "edit", GIST_ID, str(tmp)],
                                capture_output=True, text=True, timeout=60,
                                creationflags=(subprocess.CREATE_NO_WINDOW
                                               if os.name == "nt" else 0))
        if result.returncode != 0:
            return False, (result.stderr or "")[:300]
        state.last_published_at = None
        return True, "pointer revoked"
    except Exception as exc:
        return False, str(exc)[:300]
