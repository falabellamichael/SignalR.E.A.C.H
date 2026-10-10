"""The ``signalreach`` command: start the relay the way the logon task does.

``signalreach``            bring the relay up in the background (supervisor,
                           plus the tray when it is installed); says so and
                           starts nothing when the relay already answers.
``signalreach cli|chat``   open the REACH CLI (tools/reach-cli.py).
``signalreach <command>``  any other reach.py runtime command, unchanged
                           (status, stop, restart, tray, ...).

The installer writes a small shim on PATH (``signalreach.cmd`` on Windows in
<config>/bin, ``~/.local/bin/signalreach`` elsewhere). Re-running it rewrites
the same file and never adds the PATH entry twice.
"""

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from .config import CONFIG_DIR, LOG_PATH, runtime_port
from .runtime import port_open, resolve_interpreter

SHIM_NAME = "signalreach"
TOOLS_DIR = Path(__file__).resolve().parent.parent  # .../tools
WAIT_SECONDS = 30


# ---- shim ------------------------------------------------------------------

def bin_dir():
    if os.name == "nt":
        return CONFIG_DIR / "bin"
    return Path.home() / ".local" / "bin"


def shim_path():
    return bin_dir() / (SHIM_NAME + (".cmd" if os.name == "nt" else ""))


def shim_text(python, target):
    if os.name == "nt":
        return '@echo off\r\n"%s" "%s" %%*\r\n' % (python, target)
    return '#!/bin/sh\n# SignalREACH command (written by the installer)\nexec "%s" "%s" "$@"\n' % (python, target)


def _copy_launchers(source_tools, dest_tools):
    """Put signalreach.py and the REACH CLI next to the runtime copy."""
    dest_tools.mkdir(parents=True, exist_ok=True)
    for name in ("signalreach.py", "reach-cli.py"):
        src = source_tools / name
        if src.is_file() and src.resolve() != (dest_tools / name).resolve():
            shutil.copy2(src, dest_tools / name)
    pkg = source_tools / "reach_cli"
    if pkg.is_dir() and pkg.resolve() != (dest_tools / "reach_cli").resolve():
        shutil.copytree(pkg, dest_tools / "reach_cli", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__"))


def install_shim(source_tools=None, quiet=False):
    """Write the shim (idempotent). Targets the installed runtime copy when
    one exists, else this checkout. Returns the shim path."""
    source_tools = Path(source_tools or TOOLS_DIR)
    runtime_tools = CONFIG_DIR / "tools"
    if (runtime_tools / "reach").is_dir():
        _copy_launchers(source_tools, runtime_tools)
        target = runtime_tools / "signalreach.py"
    else:
        target = source_tools / "signalreach.py"
    path = shim_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    text = shim_text(resolve_interpreter(), target)
    data = text.encode("utf-8")
    if not path.is_file() or path.read_bytes() != data:
        path.write_bytes(data)  # exact bytes: CRLF stays CRLF (Python 3.9 safe)
    if os.name != "nt":
        path.chmod(0o755)
    on_path = ensure_on_path(path.parent)
    if not quiet:
        print("  signalreach command -> %s" % path)
        if not on_path:
            print("  note: %s is not on PATH — add it to use `signalreach`"
                  % path.parent)
    return path


def _norm(entry):
    return os.path.normcase(os.path.normpath(os.path.expandvars(entry.strip())))


def path_contains(path_value, folder):
    want = _norm(str(folder))
    return any(_norm(p) == want for p in (path_value or "").split(os.pathsep) if p.strip())


def ensure_on_path(folder):
    """Windows: add ``folder`` to the user PATH once (HKCU\\Environment).
    Elsewhere: only report whether it is already on PATH."""
    if path_contains(os.environ.get("PATH", ""), folder):
        return True
    if os.name != "nt":
        return False
    import winreg  # noqa: PLC0415 (Windows only)
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0,
                         winreg.KEY_READ | winreg.KEY_SET_VALUE)
    try:
        try:
            current, kind = winreg.QueryValueEx(key, "Path")
        except FileNotFoundError:
            current, kind = "", winreg.REG_EXPAND_SZ
        if not path_contains(current, folder):
            new = (current.rstrip(";") + ";" if current else "") + str(folder)
            winreg.SetValueEx(key, "Path", 0, kind or winreg.REG_EXPAND_SZ, new)
            _broadcast_environment_change()
    finally:
        winreg.CloseKey(key)
    return True


def _broadcast_environment_change():
    """Tell Explorer the environment changed, so NEW terminals see the PATH."""
    try:
        import ctypes
        ctypes.windll.user32.SendMessageTimeoutW(
            0xFFFF, 0x001A, 0, "Environment", 0x0002, 5000, None)
    except Exception:
        pass


# ---- commands --------------------------------------------------------------

def up():
    """Bring the relay up like the logon task; never start a second copy."""
    from .supervisor import CONTROL_PORT, ensure_supervisor_running
    port = runtime_port()
    url = "http://127.0.0.1:%d/v1" % port
    if port_open(port):
        print("● SignalREACH relay already running on %s" % url)
        if ensure_supervisor_running():
            print("  supervisor started (it was not running)")
        return 0
    if not (CONFIG_DIR / "tools" / "reach.py").is_file():
        print("✗ SignalREACH runtime is not installed — run "
              "`python tools/reach.py install-runtime` from the checkout")
        return 1
    spawned = ensure_supervisor_running()
    if not spawned and not port_open(CONTROL_PORT):
        print("✗ could not start the SignalREACH supervisor — see %s" % LOG_PATH)
        return 1
    _start_tray_if_installed()
    print("  starting SignalREACH relay…")
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        if port_open(port):
            print("✓ SignalREACH relay listening on %s" % url)
            return 0
        time.sleep(0.5)
    print("! relay not answering yet — it keeps starting in the background; "
          "check `signalreach status` or %s" % LOG_PATH)
    return 0


def _start_tray_if_installed():
    """The logon task also starts the tray; do the same, without duplicates."""
    try:
        from .tray import _bridge_alive, electron_binary, start_tray, tray_dir
        directory = tray_dir()
        if (electron_binary(directory).is_file() and (directory / "main.js").is_file()
                and not _bridge_alive(timeout=1.0)):
            start_tray()
    except (Exception, SystemExit):
        pass  # the relay does not depend on the tray


def open_cli(args):
    script = Path(__file__).resolve().parent.parent / "reach-cli.py"
    if not script.is_file():
        print("✗ REACH CLI not found at %s — re-run the installer" % script)
        return 1
    # the child owns Ctrl-C (it stops an answer); the shim must not die first
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        return subprocess.call([sys.executable, str(script)] + list(args))
    finally:
        signal.signal(signal.SIGINT, previous)


def run_reach(args):
    from .cli import main as runtime_main
    original = sys.argv
    try:
        sys.argv = ["signalreach"] + list(args)
        result = runtime_main()
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    finally:
        sys.argv = original
    return result if isinstance(result, int) else 0


def main(argv=None):
    try:
        return _dispatch(list(sys.argv[1:] if argv is None else argv))
    except KeyboardInterrupt:
        print()
        return 130


def _dispatch(args):
    if not args:
        return up()
    if args[0] == "--install-shim":  # installer-internal
        install_shim()
        return 0
    if args[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    if args[0] == "cli":
        return open_cli(args[1:])
    if args[0] == "chat":
        return open_cli(args)
    return run_reach(args)
