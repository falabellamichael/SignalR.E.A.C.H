"""Autostart: Windows logon task (schtasks) with Startup-folder fallback."""

import os
import shutil
import subprocess
from pathlib import Path

from .config import BAT_PATH, CONFIG_DIR
from .tray import electron_binary, tray_dir
from .runtime import (
    no_window_kwargs,
    resolve_interpreter,
    resolve_pythonw,
)
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
    pythonw = resolve_pythonw()
    lines = [
        "@echo off",
        "cd /d \"%s\"" % CONFIG_DIR,
        "start \"\" /min \"%s\" tools\\reach.py supervise" % pythonw,
    ]
    lines.append("\"%s\" tools\\reach.py reassert" % resolve_interpreter())

    # Copilot 365: shim (:21301) + the tray (supervises the invisible Electron
    # browser + in-process bridge :21302). Appended only when present.
    hermes_scripts = (Path(os.environ.get("LOCALAPPDATA", ""))
                      / "hermes" / "scripts")
    shim_py = hermes_scripts / "copilot_shim.py"
    if shim_py.is_file():
        lines.append("rem --- Copilot 365 shim (:21301) ---")
        lines.append("start \"\" /min \"%s\" \"%s\""
                     % (resolve_pythonw(), shim_py))
    tray_electron = electron_binary(tray_dir())
    tray_main = tray_dir() / "main.js"
    if tray_electron.is_file() and tray_main.is_file():
        lines.append("rem --- Copilot 365 tray (invisible browser + bridge :21302) ---")
        lines.append("start \"\" /min \"%s\" \"%s\""
                     % (tray_electron, tray_main.parent))
        # The tray holds the signed-in CodeGPT/ChatGPT browser sessions, so its
        # bridge is the host's browser-provider gateway: a watchdog keeps it
        # alive across silent process deaths (logon-started like everything
        # else here; no elevation needed).
        lines.append("rem --- tray watchdog (revives the bridge if the tray dies) ---")
        lines.append("start \"\" /min \"%s\" tools\\reach.py tray watch"
                     % resolve_pythonw())

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
