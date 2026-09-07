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
    # one-time cleanup of the pre-rebrand autostart (SimpleREACH.bat + task),
    # otherwise BOTH relays would start at the next logon and fight for the port
    legacy_bat = startup_folder() / "SimpleREACH.bat"
    if legacy_bat.is_file():
        try:
            legacy_bat.unlink()
        except OSError:
            pass
    subprocess.run(["schtasks", "/Delete", "/TN", "SimpleREACH", "/F"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   **no_window_kwargs())
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

    # Copilot 365: shim (:21301) + Chrome/bridge (:9222/:21302). Appended only
    # when the scripts are present, so a machine without them is unaffected.
    hermes_scripts = (Path(os.environ.get("LOCALAPPDATA", ""))
                      / "hermes" / "scripts")
    shim_py = hermes_scripts / "copilot_shim.py"
    launch_ps1 = hermes_scripts / "copilot_bridge_launch.ps1"
    if shim_py.is_file():
        lines.append("rem --- Copilot 365 shim (:21301) ---")
        lines.append("start \"\" /min \"%s\" \"%s\""
                     % (resolve_pythonw(), shim_py))
    if launch_ps1.is_file():
        lines.append("rem --- Copilot 365 Chrome + bridge (:9222/:21302) ---")
        lines.append("powershell -NoProfile -ExecutionPolicy Bypass -File \"%s\""
                     % launch_ps1)

    BAT_PATH.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
    result = subprocess.run(
        ["schtasks", "/Create", "/TN", "SignalREACH", "/SC", "ONLOGON",
         "/TR", str(BAT_PATH), "/F", "/RL", "LIMITED"],
        capture_output=True, text=True, **no_window_kwargs())
    if result.returncode == 0:
        print("  autostart registered: SignalREACH (logon task) -> "
              + str(BAT_PATH))
        return
    # schtasks /Create can require elevation; the per-user Startup folder
    # needs none and runs the same batch at every logon.
    startup = startup_folder()
    if startup.is_dir():
        target = startup / "SignalREACH.bat"
        shutil.copy2(BAT_PATH, target)
        print("  schtasks denied (needs elevation) — using the Startup "
              "folder instead: " + str(target))
        return
    raise SystemExit("error: schtasks failed (%s) and no Startup folder "
                     "found" % (result.stderr or result.stdout or "").strip()[:300])


def remove_autostart():
    if os.name != "nt":
        return
    for tn in ("SignalREACH", "SimpleREACH"):
        subprocess.run(["schtasks", "/Delete", "/TN", tn, "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       **no_window_kwargs())
    for fn in ("SignalREACH.bat", "SimpleREACH.bat"):
        bat = startup_folder() / fn
        if bat.is_file():
            try:
                bat.unlink()
            except OSError:
                pass
