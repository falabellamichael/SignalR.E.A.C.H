"""Autostart: Windows logon task (schtasks) with Startup-folder fallback."""

import os
import shutil
import subprocess
from pathlib import Path

from .config import BAT_PATH, CONFIG_DIR
from .publish import find_gh
from .runtime import (
    no_window_kwargs,
    resolve_interpreter,
    resolve_pythonw,
    runtime_port,
)
from .tunnel import find_ngrok
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
